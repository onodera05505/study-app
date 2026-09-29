#!/usr/bin/env python3
"""まなびば（入口。認証と権限の正本。要件 §15）の API の検査。ローカルの wrangler dev に実際に HTTP で当てる。

    bash scripts/check_portal_api.sh                                  # ← 通常はこちらから呼ぶ（起動と停止までやる）
    python3 scripts/check_portal_api.py --base http://127.0.0.1:8791 --secret portalcheck-secret

## なぜ要るか

学び側の API は scripts/check_api.py が門になっているが、**まなびばには恒久の門が無かった**。
まなびばは 5 つの学びすべての認証と権限の正本で、ここが緩むと全部が緩む。
scripts/check_sso_flow.py は 2 つの wrangler dev を手で起こす受入用のリハーサルで、
scripts/check_sso_prod.sh は本番の死活だけ見る。**まなびば単独の経路を機械で毎回見るもの**がこれ。

## 見るもの（仕様は docs/spec.yaml。@verifies で紐づけてある）

- REQ-001 ログイン — 正しい認証情報で Cookie（HttpOnly・SameSite=Lax）、誤りは 401 で共通の文。
  **メールが在るか無いかで文言が変わらない**（変わると総当たりでメールの存在が分かる）
- REQ-002 /sso/start — 未ログインはログイン画面へ、権限の無い学びは denied へ、知らない学びは 400。
  外から渡した next は使わない（行き先はサーバが組む）
- REQ-003 /api/sso/exchange — 共有秘密が合わないと 403、コードは 1 回だけ、期限切れと権限なしは拒否
- REQ-007 管理 — 一般利用者は 403。管理者は一覧・作成（grants が入る）・更新（付け外し）・パスワード再設定・削除
- REQ-008 自分への保護 — 自分の管理者権限を外す更新と自分の削除が 400
- REQ-009 自分の設定 — /api/me/password は現在のパスワード違いが 401・長さ範囲外が 400、
  成功後は新しいパスワードで入れる。/api/logout の後は /api/me が 401
- REQ-035 セキュリティヘッダ — CSP・HSTS・X-Frame-Options・nosniff・Referrer-Policy が応答に載る

## 触るもの・触らないもの

- **ローカルの D1（portal/.wrangler）だけ。本番（--remote・Pages・本番 D1）には一切当てない**
- 検査用アカウント（`portalcheck-*@example.com`）の中だけで完結する。既存の行は読まない・書かない
- 検査で作った行（accounts・grants・sessions・sso_codes）は最後に消す
- 管理者は D1 に直に入れる（まなびばには最初の管理者を作る API が無い）。
  ハッシュは src/server/lib/auth.ts と同じ形（`<反復回数>:<salt hex>:<PBKDF2-SHA256 hex>`）
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTAL = ROOT / "portal"
DB_NAME = "manabiba-db"

ADMIN_EMAIL = "portalcheck-admin@example.com"
MEMBER_EMAIL = "portalcheck-member@example.com"
TEMP_EMAIL = "portalcheck-temp@example.com"
PASSWORD = "portalcheck-pass-1234"
PREFIX = "portalcheck-"

# src/server/lib/auth.ts の ITERATIONS（Cloudflare Workers の上限。不変条件 O5）
ITERATIONS = 100_000

JAPANESE = re.compile(r"[ぁ-んァ-ヶ一-龥]")


# --------------------------------------------------------------------------
# HTTP（Cookie を持つ。リダイレクトは追わない＝Location をそのまま見たい）
# --------------------------------------------------------------------------


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Client:
    """1 人の利用者。Cookie は自分の jar に溜める（別の人は別のインスタンス）。"""

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect()
        )

    def call(self, method: str, path: str, body=None):
        """(ステータス, JSON か None, 生の Set-Cookie の一覧, ヘッダ) を返す。"""
        url = self.base + urllib.parse.quote(path, safe="/?=&:,%")
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        # Cloudflare のボット対策は素の HTTP クライアントを 403 で弾く（ローカルでは効かないが同じ作法で）
        req.add_header("User-Agent", "Mozilla/5.0 (check_portal_api.py)")
        try:
            with self.opener.open(req, timeout=60) as res:
                text, status, headers = res.read().decode("utf-8", "replace"), res.status, res.headers
        except urllib.error.HTTPError as e:
            text, status, headers = e.read().decode("utf-8", "replace"), e.code, e.headers
        except Exception:
            return 0, None, [], {}
        cookies = headers.get_all("Set-Cookie") or []
        try:
            return status, (json.loads(text) if text.strip().startswith(("{", "[")) else text), cookies, headers
        except json.JSONDecodeError:
            return status, text, cookies, headers

    def session_id(self) -> str | None:
        """今持っているセッション Cookie の値（D1 の sessions.id）。"""
        return next((ck.value for ck in self.jar if ck.name == "mb_session"), None)

    def clear(self):
        self.jar.clear()


# --------------------------------------------------------------------------
# ローカル D1（portal/wrangler.jsonc を読ませるので cwd は portal）
# --------------------------------------------------------------------------


def d1(command: str) -> list[dict]:
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB_NAME, "--local", "--json", "--command", command],
        cwd=PORTAL,
        capture_output=True,
        text=True,
        timeout=300,
    )
    body = out.stdout[out.stdout.find("[") :] if "[" in out.stdout else ""
    if not body:
        raise RuntimeError(f"ローカル D1 に当てられなかった: {out.stdout[-400:]}{out.stderr[-400:]}")
    return json.loads(body)[0].get("results", [])


def q(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def password_hash(password: str) -> str:
    """src/server/lib/auth.ts の hashPassword と同じ形（PBKDF2-SHA256・32 バイト・hex）。"""
    salt = secrets.token_bytes(16)
    bits = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS, 32)
    return f"{ITERATIONS}:{salt.hex()}:{bits.hex()}"


# --------------------------------------------------------------------------
# 結果の積み方（check_api.py と同じ流儀）
# --------------------------------------------------------------------------


class Report:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.notes: list[str] = []

    def error(self, msg: str):
        self.errors.append(msg)

    def warn(self, msg: str):
        self.warnings.append(msg)

    def note(self, msg: str):
        self.notes.append(msg)

    def ok(self, label: str, cond: bool, detail: str = "") -> bool:
        if not cond:
            self.error(f"{label}: 期待どおりでない{('  ' + detail) if detail else ''}")
        return cond

    def status(self, label: str, got: int, want, body=None) -> bool:
        want_set = want if isinstance(want, (set, tuple, list)) else {want}
        if got in want_set:
            return True
        want_txt = "/".join(str(x) for x in sorted(want_set))
        extra = f" 本文 {json.dumps(body, ensure_ascii=False)[:120]}" if body is not None else ""
        self.error(f"{label}: {got} が返った（{want_txt} のはず）{extra}")
        return False

    def error_body(self, label: str, body):
        """失敗の本文が {error: 日本語} か。画面はこれをそのまま出す。"""
        if not isinstance(body, dict) or not isinstance(body.get("error"), str) or not body["error"]:
            self.error(f"{label}: 本文が {{error: 文字列}} でない（{json.dumps(body, ensure_ascii=False)[:120]}）")
            return None
        if not JAPANESE.search(body["error"]):
            self.warn(f"{label}: error が日本語でない（{body['error'][:60]}）")
        return body["error"]


# --------------------------------------------------------------------------
# 検査用アカウントの用意と片付け
# --------------------------------------------------------------------------


def learnings() -> list[dict]:
    return json.loads((PORTAL / "src" / "learnings.json").read_text(encoding="utf-8"))


def wipe():
    """検査用アカウントと、それに紐づく行を消す（外部キーは CASCADE だが明示で消す）。"""
    d1(f"DELETE FROM sso_codes WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE {q(PREFIX + '%')})")
    d1(f"DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE {q(PREFIX + '%')})")
    d1(f"DELETE FROM grants WHERE account_id IN (SELECT id FROM accounts WHERE email LIKE {q(PREFIX + '%')})")
    d1(f"DELETE FROM accounts WHERE email LIKE {q(PREFIX + '%')}")


def seed_admin(grant: str) -> str:
    """検査用の管理者を D1 に直に入れる（最初の管理者を作る API は無い）。id を返す。"""
    aid = str(uuid.uuid4())
    d1(
        f"INSERT INTO accounts (id, email, name, password_hash, role) VALUES "
        f"({q(aid)}, {q(ADMIN_EMAIL)}, {q('検査用管理者')}, {q(password_hash(PASSWORD))}, 'ADMIN')"
    )
    d1(f"INSERT INTO grants (account_id, learning, granted_by) VALUES ({q(aid)}, {q(grant)}, 'check_portal_api')")
    return aid


# --------------------------------------------------------------------------
# 検査
# --------------------------------------------------------------------------


# @verifies REQ-035
def check_security_headers(c: Client, r: Report):
    """全応答に secureHeaders が載るか（CSP・HSTS・X-Frame-Options DENY・nosniff・Referrer-Policy）。
    まなびばは app.use('*', secureHeaders(...)) で全経路に付けている。ローカルの http でも 5 つとも載る
    （Secure 属性のような https 依存は無い）。本番 URL 側は scripts/check_sso_prod.sh が見る。"""
    want = {
        "Content-Security-Policy": "default-src 'self'",
        "Strict-Transport-Security": "max-age=",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
    }
    for path in ("/api/health", "/api/me"):
        st, _, _, headers = c.call("GET", path)
        if st == 0:
            r.error(f"セキュリティヘッダ {path}: 応答が無い")
            continue
        for name, needle in want.items():
            got = headers.get(name)
            if not got:
                r.error(f"セキュリティヘッダ {path}: {name} が無い")
            elif needle not in got:
                r.error(f"セキュリティヘッダ {path}: {name} に「{needle}」が無い（{got[:80]}）")
    r.note(f"セキュリティヘッダ: {len(want)} 種 × 2 経路")


# @verifies REQ-001
def check_login(c: Client, r: Report):
    """/api/login。正しい認証情報で HttpOnly・SameSite=Lax の Cookie が出る（Secure は https のときだけ
    付ける実装なので、ローカルの http では無くて正しい）。失敗の文言はメールの有無を漏らさない。"""
    st, data, _, _ = c.call("POST", "/api/login", {})
    r.status("POST /api/login（空）", st, 400, data)
    r.error_body("POST /api/login（空）の本文", data)

    st, data, _, _ = c.call("POST", "/api/login", {"email": "not-an-email", "password": PASSWORD})
    r.status("POST /api/login（メールの形が違う）", st, 400, data)

    st, data, _, _ = c.call("POST", "/api/login", {"email": ADMIN_EMAIL, "password": "wrong-pass-9999"})
    r.status("POST /api/login（パスワード違い）", st, 401, data)
    msg_wrong_pw = r.error_body("POST /api/login（パスワード違い）の本文", data)

    st, data, _, _ = c.call("POST", "/api/login", {"email": f"{PREFIX}nobody@example.com", "password": PASSWORD})
    r.status("POST /api/login（居ないメール）", st, 401, data)
    msg_no_user = r.error_body("POST /api/login（居ないメール）の本文", data)
    if msg_wrong_pw and msg_no_user and msg_wrong_pw != msg_no_user:
        r.error(
            "POST /api/login: メールの有無で文言が変わる（メールの存在が分かってしまう）: "
            f"{msg_no_user!r} と {msg_wrong_pw!r}"
        )

    st, data, cookies, _ = c.call("POST", "/api/login", {"email": ADMIN_EMAIL, "password": PASSWORD})
    if not r.status("POST /api/login（正しい）", st, 200, data):
        return False
    if not cookies:
        r.error("POST /api/login: Set-Cookie が無い")
        return False
    raw = cookies[0]
    low = raw.lower()
    if "mb_session=" not in raw:
        r.error(f"POST /api/login: Set-Cookie が mb_session でない（{raw[:80]}）")
    if "httponly" not in low:
        r.error(f"POST /api/login: Cookie に HttpOnly が無い（{raw[:120]}）")
    if "samesite=lax" not in low:
        r.error(f"POST /api/login: Cookie に SameSite=Lax が無い（{raw[:120]}）")
    if "path=/" not in low:
        r.error(f"POST /api/login: Cookie に Path=/ が無い（{raw[:120]}）")
    if "secure" in low:
        r.warn(f"POST /api/login: http なのに Secure が付いている（ローカルでは Cookie が返らない）: {raw[:120]}")
    if not isinstance(data, dict) or data.get("account", {}).get("email") != ADMIN_EMAIL:
        r.error(f"POST /api/login: 本文に自分の account が無い（{json.dumps(data, ensure_ascii=False)[:120]}）")
    if not isinstance(data, dict) or not isinstance(data.get("grants"), list):
        r.error("POST /api/login: grants が配列でない（未取得と空の区別。不変条件 D11）")

    st, data, _, _ = c.call("GET", "/api/me")
    r.status("GET /api/me（Cookie でログイン中）", st, 200, data)
    r.note("ログイン: 誤りは 401 の共通文、正しいと HttpOnly・SameSite=Lax の Cookie")
    return True


# @verifies REQ-007
def check_admin_accounts(admin: Client, r: Report, base: str, learn: list[dict]) -> str | None:
    """管理（ADMIN だけ）。一覧・作成（grants が入る）・更新（付け外し）・パスワード再設定・削除。
    一般利用者は 403。作った検査用アカウント（member）の id を返す（以降の検査で使う）。"""
    keys = [l["key"] for l in learn]
    first, second = keys[0], (keys[1] if len(keys) > 1 else keys[0])

    # 作成（grants つき）
    st, data, _, _ = admin.call(
        "POST", "/api/admin/accounts",
        {"email": MEMBER_EMAIL, "name": "検査用利用者", "password": PASSWORD, "grants": [first]},
    )
    if not r.status("POST /api/admin/accounts（作成）", st, 201, data):
        return None
    member_id = data.get("id") if isinstance(data, dict) else None
    if not member_id:
        r.error("POST /api/admin/accounts: 本文に id が無い")
        return None
    if data.get("role") != "MEMBER":
        r.error(f"POST /api/admin/accounts: role の既定が MEMBER でない（{data.get('role')!r}）")

    # 一覧に grants が入っているか（作成の本文だけでなく DB を経た一覧で見る）
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    if not r.status("GET /api/admin/accounts（管理者）", st, 200, data):
        return member_id
    rows = data.get("accounts") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        r.error("GET /api/admin/accounts: accounts が配列でない")
        return member_id
    row = next((a for a in rows if a.get("email") == MEMBER_EMAIL), None)
    if not row:
        r.error("GET /api/admin/accounts: 作ったアカウントが一覧に無い")
    elif row.get("grants") != [first]:
        r.error(f"作成した grants が一覧に反映されていない: {row.get('grants')!r}（[{first!r}] のはず）")
    if any(not isinstance(a.get("grants"), list) for a in rows):
        r.error("GET /api/admin/accounts: grants が配列でない行がある（権限なしは [] のはず。不変条件 D11）")

    # 作成の入力検証
    for label, body, want in [
        ("メール重複", {"email": MEMBER_EMAIL, "name": "x", "password": PASSWORD, "grants": []}, 409),
        ("メールの形", {"email": "nope", "name": "x", "password": PASSWORD, "grants": []}, 400),
        ("短いパスワード", {"email": f"{PREFIX}x@example.com", "name": "x", "password": "short", "grants": []}, 400),
        ("知らない学び", {"email": f"{PREFIX}y@example.com", "name": "y", "password": PASSWORD, "grants": ["no-such-learning"]}, 400),
    ]:
        st, data, _, _ = admin.call("POST", "/api/admin/accounts", body)
        r.status(f"POST /api/admin/accounts（{label}）", st, want, data)
        r.error_body(f"POST /api/admin/accounts（{label}）の本文", data)

    # 一般利用者は 403（実際に別の人としてログインして確かめる）
    member = Client(base)
    st, data, _, _ = member.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": PASSWORD})
    if not r.status("POST /api/login（検査用利用者）", st, 200, data):
        return member_id
    for method, path, body in [
        ("GET", "/api/admin/accounts", None),
        ("POST", "/api/admin/accounts", {"email": f"{PREFIX}z@example.com", "name": "z", "password": PASSWORD, "grants": []}),
        ("PUT", f"/api/admin/accounts/{member_id}", {"role": "ADMIN"}),
        ("POST", f"/api/admin/accounts/{member_id}/password", {"password": PASSWORD}),
        ("DELETE", f"/api/admin/accounts/{member_id}", None),
    ]:
        st, data, _, _ = member.call(method, path, body)
        r.status(f"{method} {path}（一般利用者）", st, 403, data)
        r.error_body(f"{method} {path}（一般利用者）の本文", data)
    # 昇格していないこと（403 のはずが通っていたら役割が変わる）
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    row = next((a for a in (data or {}).get("accounts", []) if a.get("email") == MEMBER_EMAIL), None)
    if row and row.get("role") != "MEMBER":
        r.error(f"一般利用者が自分を ADMIN にできてしまった（role={row.get('role')!r}）")

    # 更新（権限の付け外しと名前）
    st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{member_id}", {"grants": [first, second], "name": "検査用利用者2"})
    r.status("PUT /api/admin/accounts/:id（権限を足す）", st, 200, data)
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    row = next((a for a in (data or {}).get("accounts", []) if a.get("email") == MEMBER_EMAIL), None)
    want = sorted({first, second})
    if not row or row.get("grants") != want:
        r.error(f"権限を足した結果が一覧に出ない: {row and row.get('grants')!r}（{want} のはず）")
    if row and row.get("name") != "検査用利用者2":
        r.error(f"名前の更新が反映されていない（{row.get('name')!r}）")

    st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{member_id}", {"grants": [first]})
    r.status("PUT /api/admin/accounts/:id（権限を外す）", st, 200, data)
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    row = next((a for a in (data or {}).get("accounts", []) if a.get("email") == MEMBER_EMAIL), None)
    if not row or row.get("grants") != [first]:
        r.error(f"権限を外した結果が一覧に出ない: {row and row.get('grants')!r}（[{first!r}] のはず）")

    st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{member_id}", {"grants": ["no-such-learning"]})
    r.status("PUT /api/admin/accounts/:id（知らない学び）", st, 400, data)
    st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{uuid.uuid4()}", {"name": "x"})
    r.status("PUT /api/admin/accounts/:id（居ないアカウント）", st, 404, data)

    # パスワード再設定（使い捨てのアカウントで。開いていたセッションが切れることも見る）
    st, data, _, _ = admin.call(
        "POST", "/api/admin/accounts",
        {"email": TEMP_EMAIL, "name": "検査用の使い捨て", "password": PASSWORD, "grants": [first]},
    )
    if not r.status("POST /api/admin/accounts（使い捨てを作成）", st, 201, data):
        return member_id
    temp_id = data["id"]
    temp = Client(base)
    st, _, _, _ = temp.call("POST", "/api/login", {"email": TEMP_EMAIL, "password": PASSWORD})
    r.status("POST /api/login（使い捨て）", st, 200)

    st, data, _, _ = admin.call("POST", f"/api/admin/accounts/{temp_id}/password", {"password": "short"})
    r.status("POST /api/admin/accounts/:id/password（短い）", st, 400, data)
    new_pw = PASSWORD + "-reset"
    st, data, _, _ = admin.call("POST", f"/api/admin/accounts/{temp_id}/password", {"password": new_pw})
    r.status("POST /api/admin/accounts/:id/password（再設定）", st, 200, data)
    st, data, _, _ = temp.call("GET", "/api/me")
    r.status("再設定したら開いていたセッションが切れる（/api/me）", st, 401, data)
    fresh = Client(base)
    st, data, _, _ = fresh.call("POST", "/api/login", {"email": TEMP_EMAIL, "password": new_pw})
    r.status("再設定後のパスワードでログイン", st, 200, data)
    st, data, _, _ = fresh.call("POST", "/api/login", {"email": TEMP_EMAIL, "password": PASSWORD})
    r.status("再設定前のパスワードは通らない", st, 401, data)
    st, data, _, _ = admin.call("POST", f"/api/admin/accounts/{uuid.uuid4()}/password", {"password": new_pw})
    r.status("POST /api/admin/accounts/:id/password（居ないアカウント）", st, 404, data)

    # 削除（使い捨てを消す）
    st, data, _, _ = admin.call("DELETE", f"/api/admin/accounts/{temp_id}")
    r.status("DELETE /api/admin/accounts/:id", st, 200, data)
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    if any(a.get("email") == TEMP_EMAIL for a in (data or {}).get("accounts", [])):
        r.error("DELETE /api/admin/accounts/:id: 200 が返ったのに一覧に残っている")
    if d1(f"SELECT 1 AS ok FROM grants WHERE account_id = {q(temp_id)}"):
        r.error("アカウントを消したのに grants が残っている（CASCADE が効いていない）")
    st, data, _, _ = admin.call("DELETE", f"/api/admin/accounts/{uuid.uuid4()}")
    r.status("DELETE /api/admin/accounts/:id（居ないアカウント）", st, 404, data)

    r.note("管理: 一般利用者は 5 経路すべて 403。管理者は 一覧・作成・更新・再設定・削除")
    return member_id


# @verifies REQ-008
def check_admin_self_guard(admin: Client, r: Report, admin_id: str):
    """管理者は自分の管理者権限を外せず、自分を削除できない（最後の管理者が消えると誰も直せない）。"""
    st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{admin_id}", {"role": "MEMBER"})
    r.status("PUT 自分の role を MEMBER に", st, 400, data)
    r.error_body("PUT 自分の role を MEMBER にした本文", data)
    st, data, _, _ = admin.call("DELETE", f"/api/admin/accounts/{admin_id}")
    r.status("DELETE 自分", st, 400, data)
    r.error_body("DELETE 自分の本文", data)
    # 本当に変わっていないこと
    rows = d1(f"SELECT role FROM accounts WHERE id = {q(admin_id)}")
    if not rows or rows[0].get("role") != "ADMIN":
        r.error(f"400 が返ったのに自分の役割が変わっている（{rows and rows[0]}）")
    # 自分以外の管理者化・降格は通る（自分だけの保護であることの確認）
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    other = next((a for a in (data or {}).get("accounts", []) if a.get("email") == MEMBER_EMAIL), None)
    if other:
        st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{other['id']}", {"role": "ADMIN"})
        r.status("PUT 他人を ADMIN に（通る）", st, 200, data)
        st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{other['id']}", {"role": "MEMBER"})
        r.status("PUT 他人を MEMBER に戻す（通る）", st, 200, data)
    r.note("自分への保護: 自分の降格と自分の削除が 400（他人は通る）")


# @verifies REQ-002
def check_sso_start(r: Report, base: str, learn: list[dict], admin_grant: str) -> str | None:
    """/sso/start。未ログインはログイン画面へ、権限が無ければ denied へ、知らない学びは 400。
    行き先はサーバが組む（外から渡した next は使わない）。発行した使い捨てコードを返す。"""
    keys = [l["key"] for l in learn]
    url_of = {l["key"]: l["url"].rstrip("/") for l in learn}

    # 未ログイン → ログイン画面（/?next=/sso/start?app=...）
    anon = Client(base)
    st, _, _, headers = anon.call("GET", f"/sso/start?app={admin_grant}")
    loc = headers.get("Location", "") if headers else ""
    r.status("GET /sso/start（未ログイン）", st, 302)
    if "/?next=" not in loc or "sso%2Fstart" not in loc:
        r.error(f"未ログインの行き先がログイン画面でない（Location={loc[:120]}）")

    # 知らない学び → 400
    st, _, _, _ = anon.call("GET", "/sso/start?app=no-such-learning")
    r.status("GET /sso/start（知らない学び）", st, 400, None)
    st, _, _, _ = anon.call("GET", "/sso/start")
    r.status("GET /sso/start（app 無し）", st, 400, None)

    # 外から next を渡してもサーバは使わない（外部 URL へ飛ばさない）
    for evil in ("https://evil.example.com/", "//evil.example.com/", "/api/admin/accounts"):
        st, _, _, headers = anon.call("GET", f"/sso/start?app={admin_grant}&next={urllib.parse.quote(evil, safe='')}")
        loc = headers.get("Location", "") if headers else ""
        if "evil.example.com" in loc or "/api/admin/accounts" in loc:
            r.error(f"/sso/start が外から渡した next を行き先に使っている（next={evil} → Location={loc[:120]}）")

    # 画面側（portal/static/app.js）も /sso/start 始まりの next だけ辿る。
    # ここは HTTP では踏めない（ブラウザの中）ので、門としては原文を見る。
    app_js = (PORTAL / "static" / "app.js").read_text(encoding="utf-8")
    if "next.startsWith('/sso/start')" not in app_js and 'next.startsWith("/sso/start")' not in app_js:
        r.error("portal/static/app.js が next を /sso/start 始まりに絞っていない（外部 URL へ飛ばせる）")

    # 権限のある学び → 学び側の /sso/callback へ（コードつき）
    admin = Client(base)
    st, data, _, _ = admin.call("POST", "/api/login", {"email": ADMIN_EMAIL, "password": PASSWORD})
    if not r.status("POST /api/login（/sso/start 用）", st, 200, data):
        return None
    st, _, _, headers = admin.call("GET", f"/sso/start?app={admin_grant}")
    loc = headers.get("Location", "") if headers else ""
    r.status(f"GET /sso/start?app={admin_grant}（権限あり）", st, 302)
    code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("code", [""])[0]
    if not loc.startswith(url_of[admin_grant] + "/sso/callback?code=") or not code:
        r.error(f"権限のある学びの行き先が <学びの URL>/sso/callback?code= でない（Location={loc[:160]}）")

    # 権限の無い学び → /?denied=<key>
    denied_key = next((k for k in keys if k != admin_grant), None)
    if denied_key is None:
        r.warn("学びが 1 つしか無いので denied の検査は成立しない（未検査）")
    else:
        st, _, _, headers = admin.call("GET", f"/sso/start?app={denied_key}")
        loc = headers.get("Location", "") if headers else ""
        r.status(f"GET /sso/start?app={denied_key}（権限なし）", st, 302)
        if f"denied={denied_key}" not in loc:
            r.error(f"権限の無い学びが denied へ行かない（Location={loc[:120]}）")
        if d1(f"SELECT 1 AS ok FROM sso_codes s JOIN accounts a ON a.id = s.account_id WHERE a.email = {q(ADMIN_EMAIL)} AND s.learning = {q(denied_key)}"):
            r.error(f"権限の無い学び（{denied_key}）にコードが発行されている")

    r.note("/sso/start: 未ログイン→ログイン画面 / 知らない学び→400 / 権限なし→denied / 外の next は使わない")
    return code


# @verifies REQ-003
def check_sso_exchange(admin: Client, r: Report, base: str, secret: str, code: str | None, admin_grant: str, learn: list[dict]):
    """/api/sso/exchange。共有秘密が合わないと 403、コードは 1 回だけ・120 秒だけ、権限は交換時にも見る。
    期限切れは待たずに、ローカル D1 の expires_at を過去に書き換えて確かめる。"""
    other_key = next((l["key"] for l in learn if l["key"] != admin_grant), None)
    anon = Client(base)

    if not code:
        r.error("/sso/start でコードが取れなかったので交換の検査ができない")
        return

    # 秘密が合わない → 403（コードの正しさより先に見ること。403 で止まれば DB も見ていない）
    for label, body in [
        ("秘密なし", {"code": code, "app": admin_grant}),
        ("秘密違い", {"code": code, "app": admin_grant, "secret": secret + "-wrong"}),
    ]:
        st, data, _, _ = anon.call("POST", "/api/sso/exchange", body)
        r.status(f"POST /api/sso/exchange（{label}）", st, 403, data)
        r.error_body(f"POST /api/sso/exchange（{label}）の本文", data)

    # 学びの指定違い・知らない学び
    if other_key:
        st, data, _, _ = anon.call("POST", "/api/sso/exchange", {"code": code, "app": other_key, "secret": secret})
        r.status("POST /api/sso/exchange（別の学びのコード）", st, 401, data)
    st, data, _, _ = anon.call("POST", "/api/sso/exchange", {"code": code, "app": "no-such-learning", "secret": secret})
    r.status("POST /api/sso/exchange（知らない学び）", st, 400, data)
    st, data, _, _ = anon.call("POST", "/api/sso/exchange", {"code": str(uuid.uuid4()), "app": admin_grant, "secret": secret})
    r.status("POST /api/sso/exchange（無いコード）", st, 401, data)

    # 正しい交換 → メールと名前
    st, data, _, _ = anon.call("POST", "/api/sso/exchange", {"code": code, "app": admin_grant, "secret": secret})
    if r.status("POST /api/sso/exchange（正しい）", st, 200, data):
        if not isinstance(data, dict) or data.get("email") != ADMIN_EMAIL or not data.get("name"):
            r.error(f"交換の本文が {{email, name}} でない（{json.dumps(data, ensure_ascii=False)[:120]}）")

    # 2 回目は使えない
    st, data, _, _ = anon.call("POST", "/api/sso/exchange", {"code": code, "app": admin_grant, "secret": secret})
    r.status("POST /api/sso/exchange（同じコードの 2 回目）", st, 401, data)

    # 期限切れ（120 秒待たずに、ローカル D1 の expires_at を過去にする）
    st, _, _, headers = admin.call("GET", f"/sso/start?app={admin_grant}")
    loc = headers.get("Location", "") if headers else ""
    expired = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("code", [""])[0]
    if not expired:
        r.error("期限切れの検査用のコードが取れなかった")
    else:
        rows = d1(f"SELECT expires_at FROM sso_codes WHERE code = {q(expired)}")
        d1(f"UPDATE sso_codes SET expires_at = 1 WHERE code = {q(expired)}")
        st, data, _, _ = anon.call("POST", "/api/sso/exchange", {"code": expired, "app": admin_grant, "secret": secret})
        r.status("POST /api/sso/exchange（期限切れ）", st, 401, data)
        if rows and not (0 < rows[0]["expires_at"] - int(time.time()) <= 120):
            r.error(f"コードの寿命が 120 秒を超えている（残り {rows[0]['expires_at'] - int(time.time())} 秒）")

    # 権限を外したあとのコードは 403（交換時にも権限を見る）
    st, _, _, headers = admin.call("GET", f"/sso/start?app={admin_grant}")
    loc = headers.get("Location", "") if headers else ""
    code2 = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("code", [""])[0]
    rows = d1(f"SELECT id FROM accounts WHERE email = {q(ADMIN_EMAIL)}")
    if code2 and rows:
        aid = rows[0]["id"]
        d1(f"DELETE FROM grants WHERE account_id = {q(aid)} AND learning = {q(admin_grant)}")
        st, data, _, _ = anon.call("POST", "/api/sso/exchange", {"code": code2, "app": admin_grant, "secret": secret})
        r.status("POST /api/sso/exchange（発行後に権限を外した）", st, 403, data)
        d1(f"INSERT OR IGNORE INTO grants (account_id, learning, granted_by) VALUES ({q(aid)}, {q(admin_grant)}, 'check_portal_api')")
    r.note("交換: 秘密違い 403 / 1 回だけ / 期限切れ（D1 を書き換えて確認）/ 権限を外すと 403")


# @verifies REQ-047
def check_health(c: Client, r: Report):
    """/api/health は認証なしで {ok: true}。同じ条件で /api/me は 401（死活確認だけが素通しであること）。"""
    st, data, _, _ = c.call("GET", "/api/health")
    r.status("GET /api/health（未認証）", st, 200, data)
    if data != {"ok": True}:
        r.error(f"GET /api/health: 本文が {{ok: true}} でない: {data!r}")
    st2, _, _, _ = c.call("GET", "/api/me")
    r.status("GET /api/me（未認証）", st2, 401)
    r.notes.append("死活確認: /api/health は未認証で 200、/api/me は 401")

# @verifies REQ-045
def check_learnings(c: Client, r: Report, learn: list[dict], secret: str):
    """/api/learnings は学びの一覧（key・brand・kind・desc・url）だけを返し、秘密を含まない。
    件数と key は登録簿（portal/src/learnings.json）と一致する。認証なしで読める（トップ画面の材料）。"""
    st, data, _, _ = c.call("GET", "/api/learnings")
    if not r.status("GET /api/learnings", st, 200, data):
        return
    rows = (data or {}).get("learnings") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        r.error("GET /api/learnings: 本文が {learnings: [...]} でない")
        return
    want = sorted(l["key"] for l in learn)
    got = sorted(str(x.get("key")) for x in rows)
    if got != want:
        r.error(f"GET /api/learnings: key が登録簿と違う（API {got} / 登録簿 {want}）")
    for x in rows:
        missing = [k for k in ("key", "brand", "kind", "desc") if not x.get(k)]
        if missing:
            r.error(f"GET /api/learnings: {x.get('key')} に {missing} が無い")
    raw = json.dumps(data, ensure_ascii=False)
    if secret and secret in raw:
        r.error("GET /api/learnings: 応答に共有秘密の値が含まれている")
    r.notes.append(f"学びの一覧 {len(rows)} 件（秘密なし）")


# @verifies REQ-009, REQ-046
def check_me_password_and_logout(r: Report, base: str):
    """/api/me/password と /api/logout。現在のパスワード違いは 401、8〜200 文字の外は 400。
    成功したら新しいパスワードで入れる。ログアウトの後は /api/me が 401。"""
    c = Client(base)
    st, data, _, _ = c.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": PASSWORD})
    if not r.status("POST /api/login（パスワード変更の検査用）", st, 200, data):
        return

    st, data, _, _ = c.call("POST", "/api/me/password", {})
    r.status("POST /api/me/password（空）", st, 400, data)
    st, data, _, _ = c.call("POST", "/api/me/password", {"current": PASSWORD, "next": "a" * 7})
    r.status("POST /api/me/password（7 文字）", st, 400, data)
    r.error_body("POST /api/me/password（7 文字）の本文", data)
    st, data, _, _ = c.call("POST", "/api/me/password", {"current": PASSWORD, "next": "a" * 201})
    r.status("POST /api/me/password（201 文字）", st, 400, data)
    st, data, _, _ = c.call("POST", "/api/me/password", {"current": "wrong-pass-9999", "next": "a" * 12})
    r.status("POST /api/me/password（現在のパスワード違い）", st, 401, data)
    r.error_body("POST /api/me/password（現在のパスワード違い）の本文", data)

    new_pw = PASSWORD + "-changed"
    st, data, _, _ = c.call("POST", "/api/me/password", {"current": PASSWORD, "next": new_pw})
    if r.status("POST /api/me/password（変更）", st, 200, data):
        fresh = Client(base)
        st, data, _, _ = fresh.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": new_pw})
        r.status("変更後のパスワードでログイン", st, 200, data)
        st, data, _, _ = fresh.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": PASSWORD})
        r.status("変更前のパスワードは通らない", st, 401, data)

    # 未ログインでは 401（ログインが要る経路であること）
    st, data, _, _ = Client(base).call("POST", "/api/me/password", {"current": new_pw, "next": PASSWORD})
    r.status("POST /api/me/password（未ログイン）", st, 401, data)
    st, data, _, _ = Client(base).call("GET", "/api/me")
    r.status("GET /api/me（未ログイン）", st, 401, data)

    # ログアウト → Cookie が失効 → /api/me が 401
    sid = c.session_id()
    st, data, _, _ = c.call("POST", "/api/logout")
    r.status("POST /api/logout", st, 200, data)
    st, data, _, _ = c.call("GET", "/api/me")
    r.status("GET /api/me（ログアウト後）", st, 401, data)
    # このセッションの行だけが消えること（他の端末のセッションは残る仕様）
    if not sid:
        r.error("ログアウト前のセッション ID が Cookie から取れなかった")
    elif d1(f"SELECT 1 AS ok FROM sessions WHERE id = {q(sid)}"):
        r.error("ログアウトしたのに sessions の行が残っている（Cookie を消しただけ）")
    r.note("自分の設定: 現在のパスワード違い 401・長さ 400・変更後は新パスワード・ログアウトで 401")


# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8791")
    ap.add_argument("--secret", default=os.environ.get("PORTAL_CHECK_SSO_SECRET", "portalcheck-secret"),
                    help="wrangler dev に渡した SSO_SECRET と同じ値")
    args = ap.parse_args()

    if "127.0.0.1" not in args.base and "localhost" not in args.base:
        print("この検査はローカルの wrangler dev 専用（本番には当てない）", file=sys.stderr)
        return 1

    c = Client(args.base)
    st, _, _, _ = c.call("GET", "/api/health")
    if st != 200:
        print(f"{args.base} に繋がらない。先に bash scripts/check_portal_api.sh から起動すること", file=sys.stderr)
        return 1

    learn = learnings()
    if not learn:
        print("portal/src/learnings.json が空（先に python3 scripts/build_portal.py）", file=sys.stderr)
        return 1

    r = Report()
    admin_grant = learn[0]["key"]
    wipe()
    admin_id = seed_admin(admin_grant)
    try:
        admin = Client(args.base)
        check_security_headers(Client(args.base), r)
        check_health(Client(args.base), r)
        check_learnings(Client(args.base), r, learn, args.secret)
        if not check_login(admin, r):
            print("検査用の管理者でログインできなかった", file=sys.stderr)
            for e in r.errors:
                print(f"  - {e}", file=sys.stderr)
            return 1
        check_admin_accounts(admin, r, args.base, learn)
        check_admin_self_guard(admin, r, admin_id)
        code = check_sso_start(r, args.base, learn, admin_grant)
        check_sso_exchange(admin, r, args.base, args.secret, code, admin_grant, learn)
        check_me_password_and_logout(r, args.base)
    finally:
        wipe()
        left = d1(f"SELECT COUNT(*) AS n FROM accounts WHERE email LIKE {q(PREFIX + '%')}")
        if left and left[0]["n"]:
            r.error(f"検査で作った行が残っている（accounts {left[0]['n']} 件）")

    print(f"{args.base}  まなびば  ローカル D1『{DB_NAME}』  学び {len(learn)} 件（{', '.join(l['key'] for l in learn)}）")
    for n in r.notes:
        print(f"  {n}")
    if r.warnings:
        print(f"\n警告 {len(r.warnings)} 件:")
        for w in r.warnings:
            print(f"  - {w}")
    if r.errors:
        print(f"\nエラー {len(r.errors)} 件:", file=sys.stderr)
        for e in r.errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("\n検査: 問題なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
