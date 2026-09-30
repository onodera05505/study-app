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

- REQ-001・REQ-056 ログイン — 正しい認証情報で Cookie（HttpOnly・SameSite=Lax）、誤りは 401 で共通の文。
  **メールが在るか無いかで文言が変わらない**（変わると総当たりでメールの存在が分かる）
- REQ-002・REQ-057 /sso/start — 未ログインはログイン画面へ、権限の無い学びは denied へ、知らない学びは 400。
  外から渡した next は使わない（行き先はサーバが組む）
- REQ-003・REQ-059 /api/sso/exchange — 共有秘密が合わないと 403、コードは 1 回だけ、期限切れと権限なしは拒否
- REQ-045 /api/learnings — 学びの一覧が登録簿と一致し、秘密を含まない
- REQ-046 /api/me — ログイン中は account と grants、未ログインは 401
- REQ-007・REQ-071〜074・REQ-080〜082 管理 — 一般利用者は 403。管理者は一覧・作成（grants が入る）・
  更新（付け外し）・パスワード再設定・削除。居ない ID は 404
- REQ-070 一覧 — 件数が accounts と一致し、権限の無い行の grants が []
- REQ-075〜078 入力検証 — メールの形・名前の長さ・パスワードの長さ・知らない学びが 400（メール重複は 409）で、何も変わらない
- REQ-008・REQ-079 自分への保護 — 自分の管理者権限を外す更新と自分の削除が 400
- REQ-009・REQ-083〜085 自分の設定 — /api/me/password は現在のパスワード違いが 401・長さ範囲外が 400、
  成功後は新しいパスワードで入れる。/api/logout はこの端末のセッションだけを消し、以後 /api/me が 401
- REQ-088 Cookie の境界 — ログインが要る経路は Cookie 無しで 401、/api/health と /api/learnings は 200
- REQ-086 セキュリティヘッダ — CSP・HSTS・X-Frame-Options・nosniff・Referrer-Policy が応答に載る
- REQ-094 死活確認 — /api/health は認証なしで {ok: true}
- REQ-300 本文の検証 — login・sso/exchange・me/password・管理の作成・更新・再設定に、欠け・型違い・範囲外の
  本文を送ると 400。{error} はどの項目（メール・パスワード・名前）が悪いか分かる日本語で、
  スキーマの既定の英語の文言（Invalid・Required・Expected・received）を含まない
- REQ-302 知らない /api — 存在しない /api の経路は、未ログインでもログイン後でも 404 で {error} が日本語
- **UC の基本の流れの写し**（`check_scenario_uc0xx`。`docs/usecases/UC-xxx.md` の番号付きステップを順に
  1 本で通し、最後に事後条件を見る）— 正常系だけ。例外の流れと境目は上の検査が見る。
  画面の操作と描画は HTTP では踏めないので、画面が使う応答まで

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
SCHEMA_EMAIL = "portalcheck-schema@example.com"
SCENARIO_EMAIL = "portalcheck-scenario@example.com"
PASSWORD = "portalcheck-pass-1234"
PREFIX = "portalcheck-"

# src/server/lib/auth.ts の ITERATIONS（Cloudflare Workers の上限。不変条件 O5）
ITERATIONS = 100_000

JAPANESE = re.compile(r"[ぁ-んァ-ヶ一-龥]")

# スキーマ（zod）の既定の英語の文言。利用者に出す {error} に混ぜない（要件 §10 の入力検証）
SCHEMA_WORDS = re.compile(r"(?i)\b(invalid|required|expected|received)\b")

# 「どの項目が悪いか」を示す項目名の語（要件 §10。メール・パスワード・名前）
EMAIL_WORDS = ("メール",)
PASSWORD_WORDS = ("パスワード",)
NAME_WORDS = ("名前",)


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

    def field_error(self, label: str, body, words: tuple[str, ...] = ()):
        """検証で断った本文が {error: 日本語の 1 文} で、どの項目がどう悪いか分かり、
        スキーマの既定の英語の文言を含まないこと（words のどれか 1 つが入っていればよい）。"""
        if not isinstance(body, dict) or not isinstance(body.get("error"), str) or not body["error"]:
            self.error(f"{label}: 本文が {{error: 文字列}} でない（{json.dumps(body, ensure_ascii=False)[:120]}）")
            return
        msg = body["error"]
        if not JAPANESE.search(msg):
            self.error(f"{label}: error が日本語でない（{msg[:80]}）")
        hit = SCHEMA_WORDS.search(msg)
        if hit:
            self.error(f"{label}: error にスキーマの既定の英語の文言「{hit.group(0)}」が出ている（{msg[:80]}）")
        if words and not any(w in msg for w in words):
            self.error(
                f"{label}: error にどの項目が悪いか（{' か '.join(words)}）が書かれていない（{msg[:80]}）"
            )


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


# @verifies REQ-086
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
    # 静的ファイル（assets）の応答も 200 のままであること。
    # secureHeaders が assets の変更できないヘッダーに触ると、API は 200 でも画面が全部 500 になる
    for path in ("/", "/app.js", "/style.css"):
        st, _, _, _ = c.call("GET", path)
        r.status(f"GET {path}（静的ファイル）", st, 200)
    r.note(f"セキュリティヘッダ: {len(want)} 種 × 2 経路（静的ファイルは 200 のまま）")


# @verifies REQ-001, REQ-056
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


# @verifies REQ-007, REQ-071, REQ-072, REQ-073, REQ-074, REQ-080, REQ-081, REQ-082
def check_admin_accounts(admin: Client, r: Report, base: str, learn: list[dict]) -> str | None:
    """管理（ADMIN だけ）。一覧・作成（grants が入る）・更新（付け外し）・パスワード再設定・削除。
    一般利用者は 403。居ない ID は 404。入力検証は check_admin_validation が見る。
    作った検査用アカウント（member）の id を返す（以降の検査で使う）。"""
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
    # 201 の本文は画面がそのまま行に足せる形（id・メール・名前・役割・権限）
    if data.get("email") != MEMBER_EMAIL or data.get("name") != "検査用利用者":
        r.error(f"POST /api/admin/accounts: 本文のメール・名前が送った値でない（{json.dumps(data, ensure_ascii=False)[:120]}）")
    if data.get("grants") != [first]:
        r.error(f"POST /api/admin/accounts: 本文の grants が送った学びでない（{data.get('grants')!r}。[{first!r}] のはず）")

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


# @verifies REQ-070
def check_admin_list(admin: Client, r: Report):
    """一覧は全アカウントを返す（件数がローカル D1 の accounts と一致）。行は id・メール・名前・役割を持ち、
    権限の無い人の grants は [] で返る（null や欠落だと画面が「未取得」と区別できない。不変条件 D11）。"""
    email = f"{PREFIX}nogrant@example.com"
    st, data, _, _ = admin.call(
        "POST", "/api/admin/accounts",
        {"email": email, "name": "権限なしの人", "password": PASSWORD, "grants": []},
    )
    if not r.status("POST /api/admin/accounts（権限なしを作成）", st, 201, data):
        return
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    if not r.status("GET /api/admin/accounts（一覧）", st, 200, data):
        return
    rows = data.get("accounts") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        r.error("GET /api/admin/accounts: accounts が配列でない")
        return
    total = d1("SELECT COUNT(*) AS n FROM accounts")
    if total and len(rows) != total[0]["n"]:
        r.error(f"一覧の件数が accounts と合わない（API {len(rows)} 件 / D1 {total[0]['n']} 件）")
    row = next((a for a in rows if a.get("email") == email), None)
    if not row:
        r.error("GET /api/admin/accounts: 権限なしで作ったアカウントが一覧に無い")
    else:
        if row.get("grants") != []:
            r.error(f"権限の無い行の grants が [] でない（{row.get('grants')!r}。不変条件 D11）")
        for key in ("id", "email", "name", "role"):
            if not row.get(key):
                r.error(f"一覧の行に {key} が無い（{json.dumps(row, ensure_ascii=False)[:120]}）")
        if row.get("id"):
            admin.call("DELETE", f"/api/admin/accounts/{row['id']}")
    r.note(f"一覧: {len(rows)} 件が accounts と一致・権限なしは []")


# @verifies REQ-075, REQ-076, REQ-077, REQ-078
def check_admin_validation(admin: Client, r: Report, base: str, member_id: str | None):
    """作成・更新・再設定の入力検証。メールの形・名前の長さ（空か 50 文字超）・パスワードの長さ
    （8 文字未満か 200 文字超）・知らない学びは 400、同じメールは 409。どれも値を変えない。"""
    before = d1("SELECT COUNT(*) AS n FROM accounts")[0]["n"]
    for label, body, want in [
        ("メール重複", {"email": MEMBER_EMAIL, "name": "x", "password": PASSWORD, "grants": []}, 409),
        ("メールの形", {"email": "nope", "name": "x", "password": PASSWORD, "grants": []}, 400),
        ("名前が空", {"email": f"{PREFIX}n0@example.com", "name": "", "password": PASSWORD, "grants": []}, 400),
        ("名前が 51 文字", {"email": f"{PREFIX}n1@example.com", "name": "あ" * 51, "password": PASSWORD, "grants": []}, 400),
        ("パスワードが 7 文字", {"email": f"{PREFIX}p0@example.com", "name": "x", "password": "a" * 7, "grants": []}, 400),
        ("パスワードが 201 文字", {"email": f"{PREFIX}p1@example.com", "name": "x", "password": "a" * 201, "grants": []}, 400),
        ("知らない学び", {"email": f"{PREFIX}g0@example.com", "name": "y", "password": PASSWORD, "grants": ["no-such-learning"]}, 400),
    ]:
        st, data, _, _ = admin.call("POST", "/api/admin/accounts", body)
        r.status(f"POST /api/admin/accounts（{label}）", st, want, data)
        r.error_body(f"POST /api/admin/accounts（{label}）の本文", data)
    after = d1("SELECT COUNT(*) AS n FROM accounts")[0]["n"]
    if after != before:
        r.error(f"断ったはずの作成でアカウントが増えている（{before} → {after} 件）")

    if not member_id:
        r.error("更新と再設定の入力検証ができない（検査用アカウントが作れていない）")
        return

    def member_row():
        _, data, _, _ = admin.call("GET", "/api/admin/accounts")
        return next((a for a in (data or {}).get("accounts", []) if a.get("email") == MEMBER_EMAIL), None) or {}

    kept = member_row()
    for label, body in [
        ("知らない学び", {"grants": ["no-such-learning"]}),
        ("名前が空", {"name": ""}),
        ("名前が 51 文字", {"name": "あ" * 51}),
    ]:
        st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{member_id}", body)
        r.status(f"PUT /api/admin/accounts/:id（{label}）", st, 400, data)
        r.error_body(f"PUT /api/admin/accounts/:id（{label}）の本文", data)
    now = member_row()
    if (now.get("grants"), now.get("name")) != (kept.get("grants"), kept.get("name")):
        r.error(
            "400 が返ったのに権限か名前が変わっている: "
            f"{(kept.get('grants'), kept.get('name'))!r} → {(now.get('grants'), now.get('name'))!r}"
        )

    for label, pw in [("7 文字", "a" * 7), ("201 文字", "a" * 201)]:
        st, data, _, _ = admin.call("POST", f"/api/admin/accounts/{member_id}/password", {"password": pw})
        r.status(f"POST /api/admin/accounts/:id/password（{label}）", st, 400, data)
        r.error_body(f"POST /api/admin/accounts/:id/password（{label}）の本文", data)
    probe = Client(base)
    st, data, _, _ = probe.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": PASSWORD})
    r.status("断った再設定の後も元のパスワードで入れる", st, 200, data)
    r.note("入力検証: 作成 7 通り（重複は 409）・更新 3 通り・再設定 2 通りで断り、値は変わらない")


# @verifies REQ-088
def check_portal_auth_boundary(r: Report, base: str):
    """ログインが要る経路（/api/me・/api/me/password・/api/logout・/api/admin/*）は、
    セッションの Cookie が無いと 401 の {error}。死活確認と学びの一覧は同じ条件で 200。"""
    anon = Client(base)
    other = str(uuid.uuid4())
    for method, path, body in [
        ("GET", "/api/me", None),
        ("POST", "/api/me/password", {"current": PASSWORD, "next": PASSWORD + "-x"}),
        ("POST", "/api/logout", None),
        ("GET", "/api/admin/accounts", None),
        ("POST", "/api/admin/accounts", {"email": f"{PREFIX}anon@example.com", "name": "x", "password": PASSWORD, "grants": []}),
        ("PUT", f"/api/admin/accounts/{other}", {"name": "x"}),
        ("POST", f"/api/admin/accounts/{other}/password", {"password": PASSWORD}),
        ("DELETE", f"/api/admin/accounts/{other}", None),
    ]:
        st, data, _, _ = anon.call(method, path, body)
        r.status(f"{method} {path}（Cookie なし）", st, 401, data)
        r.error_body(f"{method} {path}（Cookie なし）の本文", data)
    for path in ("/api/health", "/api/learnings"):
        st, data, _, _ = anon.call("GET", path)
        r.status(f"GET {path}（Cookie なし）", st, 200, data)
    # 断った呼び出しで行が増えていないこと（401 の前に処理が走っていない）
    left = d1(f"SELECT COUNT(*) AS n FROM accounts WHERE email = {q(PREFIX + 'anon@example.com')}")
    if left and left[0]["n"]:
        r.error("Cookie なしの作成が 401 のはずなのにアカウントができている")
    r.note("Cookie の境界: ログインが要る 8 経路が 401、/api/health と /api/learnings は 200")


# @verifies REQ-008, REQ-072, REQ-079
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


# @verifies REQ-002, REQ-057
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


# @verifies REQ-003, REQ-059
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


# @verifies REQ-094
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


# @verifies REQ-009, REQ-046, REQ-083, REQ-084, REQ-085
def check_me_password_and_logout(r: Report, base: str):
    """/api/me/password と /api/logout。現在のパスワード違いは 401、8〜200 文字の外は 400。
    成功したら新しいパスワードで入れて前のパスワードでは入れない。
    ログアウトはこの端末のセッションの行だけを消す（別の端末のセッションは残る）。"""
    c = Client(base)
    st, data, _, _ = c.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": PASSWORD})
    if not r.status("POST /api/login（パスワード変更の検査用）", st, 200, data):
        return

    # /api/me は本人の account と grants（権限なしは []）を返す。画面はこれで「開く」にする学びを決める
    st, data, _, _ = c.call("GET", "/api/me")
    if r.status("GET /api/me（ログイン中）", st, 200, data):
        me = data if isinstance(data, dict) else {}
        account = me.get("account") if isinstance(me.get("account"), dict) else {}
        if account.get("email") != MEMBER_EMAIL:
            r.error(f"GET /api/me: 本文に自分の account が無い（{json.dumps(data, ensure_ascii=False)[:120]}）")
        if not isinstance(me.get("grants"), list):
            r.error("GET /api/me: grants が配列でない（権限なしは []。不変条件 D11）")

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

    # ここまでの 400・401 でパスワードが変わっていれば、この変更（current が元のパスワード）が通らない
    new_pw = PASSWORD + "-changed"
    other: Client | None = None
    st, data, _, _ = c.call("POST", "/api/me/password", {"current": PASSWORD, "next": new_pw})
    if r.status("POST /api/me/password（変更）", st, 200, data):
        fresh = Client(base)
        st, data, _, _ = fresh.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": new_pw})
        if r.status("変更後のパスワードでログイン", st, 200, data):
            other = fresh  # 同じ人の 2 つ目のセッション（別の端末のつもり）
        st, data, _, _ = fresh.call("POST", "/api/login", {"email": MEMBER_EMAIL, "password": PASSWORD})
        r.status("変更前のパスワードは通らない", st, 401, data)

    # 未ログインでは 401（ログインが要る経路であること）
    st, data, _, _ = Client(base).call("POST", "/api/me/password", {"current": new_pw, "next": PASSWORD})
    r.status("POST /api/me/password（未ログイン）", st, 401, data)
    st, data, _, _ = Client(base).call("GET", "/api/me")
    r.status("GET /api/me（未ログイン）", st, 401, data)

    # ログアウト → Cookie が失効 → /api/me が 401
    sid = c.session_id()
    other_sid = other.session_id() if other else None
    st, data, _, _ = c.call("POST", "/api/logout")
    r.status("POST /api/logout", st, 200, data)
    st, data, _, _ = c.call("GET", "/api/me")
    r.status("GET /api/me（ログアウト後）", st, 401, data)
    # このセッションの行だけが消えること（他の端末のセッションは残る仕様）
    if not sid:
        r.error("ログアウト前のセッション ID が Cookie から取れなかった")
    elif d1(f"SELECT 1 AS ok FROM sessions WHERE id = {q(sid)}"):
        r.error("ログアウトしたのに sessions の行が残っている（Cookie を消しただけ）")
    if other and other_sid:
        if not d1(f"SELECT 1 AS ok FROM sessions WHERE id = {q(other_sid)}"):
            r.error("片方のログアウトで別の端末のセッションの行まで消えている")
        st, data, _, _ = other.call("GET", "/api/me")
        r.status("GET /api/me（別の端末。ログアウトしていない側）", st, 200, data)
    else:
        r.warn("別の端末のセッションが用意できず、ログアウトの範囲（この端末だけ）は未検査")
    r.note("自分の設定: 現在のパスワード違い 401・長さ 400・変更後は新パスワード・ログアウトはこの端末だけ")


# @verifies REQ-300
def check_body_schema(admin: Client, r: Report, base: str, secret: str, admin_grant: str, member_id: str | None):
    """本文の検証。login・sso/exchange・me/password・管理の作成・更新・再設定に、欠け・型違い・範囲外の
    本文を送ると 400 で、{error} は「どの項目がどう悪いか」分かる日本語（項目名の語はメール・パスワード・名前）。
    スキーマの既定の英語の文言（Invalid・Required・Expected・received）を出さない。
    断った呼び出しでアカウントが増えない・パスワードが変わらないことも見る。

    検査は使い捨てのアカウント（portalcheck-schema@example.com）の中で行う。
    交換は共有秘密を正しく渡した本文だけを見る（共有秘密の確認が本文の検証より先で、
    秘密が無い・違うときは 403。§15。そちらは REQ-003 の側が見ている）。"""
    before = d1("SELECT COUNT(*) AS n FROM accounts")[0]["n"]

    # --- POST /api/login（メールアドレスとパスワード）
    for label, body, words in [
        ("両方欠け", {}, EMAIL_WORDS + PASSWORD_WORDS),
        ("パスワード欠け", {"email": ADMIN_EMAIL}, PASSWORD_WORDS),
        ("メール欠け", {"password": PASSWORD}, EMAIL_WORDS),
        ("メールが数値", {"email": 12345, "password": PASSWORD}, EMAIL_WORDS),
        ("パスワードが数値", {"email": ADMIN_EMAIL, "password": 12345}, PASSWORD_WORDS),
        ("メールの形が違う", {"email": "not-an-email", "password": PASSWORD}, EMAIL_WORDS),
    ]:
        st, data, _, _ = Client(base).call("POST", "/api/login", body)
        r.status(f"POST /api/login（{label}）", st, 400, data)
        r.field_error(f"POST /api/login（{label}）の本文", data, words)

    # --- POST /api/admin/accounts（作成。欠け・型違い・範囲外）
    for label, body, words in [
        ("メール欠け", {"name": "検査用", "password": PASSWORD, "grants": []}, EMAIL_WORDS),
        ("お名前欠け", {"email": f"{PREFIX}s0@example.com", "password": PASSWORD, "grants": []}, NAME_WORDS),
        ("パスワード欠け", {"email": f"{PREFIX}s1@example.com", "name": "検査用", "grants": []}, PASSWORD_WORDS),
        ("メールが数値", {"email": 1, "name": "検査用", "password": PASSWORD, "grants": []}, EMAIL_WORDS),
        ("お名前が数値", {"email": f"{PREFIX}s2@example.com", "name": 5, "password": PASSWORD, "grants": []}, NAME_WORDS),
        ("パスワードが数値", {"email": f"{PREFIX}s3@example.com", "name": "検査用", "password": 12345678, "grants": []}, PASSWORD_WORDS),
        ("お名前が 51 文字", {"email": f"{PREFIX}s4@example.com", "name": "あ" * 51, "password": PASSWORD, "grants": []}, NAME_WORDS),
        ("パスワードが 7 文字", {"email": f"{PREFIX}s5@example.com", "name": "検査用", "password": "a" * 7, "grants": []}, PASSWORD_WORDS),
        ("パスワードが 201 文字", {"email": f"{PREFIX}s6@example.com", "name": "検査用", "password": "a" * 201, "grants": []}, PASSWORD_WORDS),
        ("grants が配列でない", {"email": f"{PREFIX}s7@example.com", "name": "検査用", "password": PASSWORD, "grants": admin_grant}, ()),
        ("role が知らない値", {"email": f"{PREFIX}s8@example.com", "name": "検査用", "password": PASSWORD, "role": "KING", "grants": []}, ()),
    ]:
        st, data, _, _ = admin.call("POST", "/api/admin/accounts", body)
        r.status(f"POST /api/admin/accounts（{label}）", st, 400, data)
        r.field_error(f"POST /api/admin/accounts（{label}）の本文", data, words)

    # --- 検査用の使い捨てアカウント（更新・再設定・自分のパスワードを、他の検査と切り離して見る）
    st, data, _, _ = admin.call(
        "POST", "/api/admin/accounts",
        {"email": SCHEMA_EMAIL, "name": "検査用の本文検証", "password": PASSWORD, "grants": [admin_grant]},
    )
    schema_id = data.get("id") if r.status("POST /api/admin/accounts（本文検証用を作成）", st, 201, data) and isinstance(data, dict) else None

    # --- PUT /api/admin/accounts/:id（更新）
    target_id = schema_id or member_id
    if not target_id:
        r.error("更新と再設定の本文の検証ができない（検査用アカウントが作れていない）")
    else:
        for label, body, words in [
            ("お名前が空", {"name": ""}, NAME_WORDS),
            ("お名前が 51 文字", {"name": "あ" * 51}, NAME_WORDS),
            ("お名前が数値", {"name": 5}, NAME_WORDS),
            ("role が知らない値", {"role": "KING"}, ()),
            ("grants が配列でない", {"grants": admin_grant}, ()),
        ]:
            st, data, _, _ = admin.call("PUT", f"/api/admin/accounts/{target_id}", body)
            r.status(f"PUT /api/admin/accounts/:id（{label}）", st, 400, data)
            r.field_error(f"PUT /api/admin/accounts/:id（{label}）の本文", data, words)

        # --- POST /api/admin/accounts/:id/password（再設定）
        for label, body in [
            ("パスワード欠け", {}),
            ("パスワードが数値", {"password": 12345678}),
            ("パスワードが 7 文字", {"password": "a" * 7}),
            ("パスワードが 201 文字", {"password": "a" * 201}),
        ]:
            st, data, _, _ = admin.call("POST", f"/api/admin/accounts/{target_id}/password", body)
            r.status(f"POST /api/admin/accounts/:id/password（{label}）", st, 400, data)
            r.field_error(f"POST /api/admin/accounts/:id/password（{label}）の本文", data, PASSWORD_WORDS)

    # --- POST /api/me/password（自分のパスワード。使い捨てのアカウントでログインして送る）
    if schema_id:
        me = Client(base)
        st, data, _, _ = me.call("POST", "/api/login", {"email": SCHEMA_EMAIL, "password": PASSWORD})
        if r.status("POST /api/login（本文検証用）", st, 200, data):
            for label, body in [
                ("両方欠け", {}),
                ("next 欠け", {"current": PASSWORD}),
                ("current 欠け", {"next": PASSWORD + "-x"}),
                ("current が数値", {"current": 12345678, "next": PASSWORD + "-x"}),
                ("next が数値", {"current": PASSWORD, "next": 12345678}),
                ("next が 7 文字", {"current": PASSWORD, "next": "a" * 7}),
                ("next が 201 文字", {"current": PASSWORD, "next": "a" * 201}),
            ]:
                st, data, _, _ = me.call("POST", "/api/me/password", body)
                r.status(f"POST /api/me/password（{label}）", st, 400, data)
                r.field_error(f"POST /api/me/password（{label}）の本文", data, PASSWORD_WORDS)
            # 断った呼び出しでパスワードが変わっていないこと
            st, data, _, _ = Client(base).call("POST", "/api/login", {"email": SCHEMA_EMAIL, "password": PASSWORD})
            r.status("断った本文の後も元のパスワードで入れる", st, 200, data)

    # --- POST /api/sso/exchange（共有秘密は正しく渡し、本文の形だけを崩す）
    for label, body in [
        ("code 欠け", {"app": admin_grant, "secret": secret}),
        ("code が数値", {"code": 12345, "app": admin_grant, "secret": secret}),
    ]:
        st, data, _, _ = Client(base).call("POST", "/api/sso/exchange", body)
        r.status(f"POST /api/sso/exchange（{label}）", st, 400, data)
        r.field_error(f"POST /api/sso/exchange（{label}）の本文", data)

    after = d1("SELECT COUNT(*) AS n FROM accounts")[0]["n"]
    want = before + (1 if schema_id else 0)
    if after != want:
        r.error(f"断ったはずの作成でアカウントが増えている（{before} → {after} 件。{want} 件のはず）")
    if schema_id:
        admin.call("DELETE", f"/api/admin/accounts/{schema_id}")
    r.note("本文の検証: login 6・作成 11・更新 5・再設定 4・自分のパスワード 7・交換 2 通りが 400 で項目の分かる日本語")


# @verifies REQ-302
def check_unknown_api_path(r: Report, base: str, admin: Client):
    """知らない /api の経路は、未ログインでもログイン後でも 404 で本文が {error} の日本語。
    静的ファイルに落ちて 200（index.html）になっていないこと（本文が JSON であることで見る）。
    権限が要る接頭辞（/api/admin/…）の下は先に 401・403 を返してよいので、ここでは見ない（§10）。"""
    anon = Client(base)
    for who, c in (("未ログイン", anon), ("ログイン後", admin)):
        for method, path, body in [
            ("GET", "/api/no-such-path", None),
            ("POST", "/api/no-such-path", {"x": 1}),
            ("PUT", "/api/no-such-path", {"x": 1}),
            ("DELETE", "/api/no-such-path", None),
            ("GET", "/api/no-such-path/deeper", None),
            ("GET", "/api/health/no-such-path", None),
        ]:
            st, data, _, _ = c.call(method, path, body)
            r.status(f"{method} {path}（{who}）", st, 404, data)
            r.field_error(f"{method} {path}（{who}）の本文", data)
    r.note("知らない /api: 6 通り × 未ログイン／ログイン後が 404 の {error}（日本語）")


# --------------------------------------------------------------------------
# UC の基本の流れの写し（scenario）
#
# 1 UC につき 1 本。docs/usecases/UC-xxx.md の「基本の流れ」の番号付きステップを順に
# 1 操作か 1 応答ずつ写し、最後に「事後条件」を見る。正常系だけを通す。
# --------------------------------------------------------------------------


# @scenario UC-002
def check_scenario_uc002(admin: Client, r: Report, base: str, learn: list[dict], admin_id: str):
    """管理の API を呼ぶ → 一覧 → 作成 → 更新（権限の置き換え）→ パスワード再設定 → 削除。"""
    L = "UC-002"
    keys = [l["key"] for l in learn]
    first, second = keys[0], (keys[1] if len(keys) > 1 else keys[0])

    def row_of(account_id: str) -> dict:
        _, data, _, _ = admin.call("GET", "/api/admin/accounts")
        rows = (data or {}).get("accounts") if isinstance(data, dict) else []
        return next((a for a in (rows or []) if a.get("id") == account_id), {})

    # 1. 管理の画面を開き、管理の API を呼ぶ（役割が ADMIN の呼び出しは通る）
    st, data, _, _ = admin.call("GET", "/api/admin/accounts")
    if not r.status(f"{L} 1 管理者が管理の API を呼ぶ", st, 200, data):
        return

    # 2. アカウントの一覧（名前・メール・役割と、その人に付いている学びの権限）
    rows = (data or {}).get("accounts") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not rows:
        r.error(f"{L} 2: 一覧が accounts の配列で返らない")
        return
    me_row = next((a for a in rows if a.get("id") == admin_id), None)
    if not me_row:
        r.error(f"{L} 2: 一覧に管理者自身の行が無い（全アカウントを返すこと）")
    else:
        for key in ("email", "name", "role"):
            if not me_row.get(key):
                r.error(f"{L} 2: 一覧の行に {key} が無い")
        if not isinstance(me_row.get("grants"), list):
            r.error(f"{L} 2: 行の学びの権限（grants）が配列でない（権限なしは []）")

    # 3. メール・名前・初期パスワード・開ける学びを入れて作成する（役割の既定は利用者）
    st, data, _, _ = admin.call(
        "POST", "/api/admin/accounts",
        {"email": SCENARIO_EMAIL, "name": "シナリオの利用者", "password": PASSWORD, "grants": [first]},
    )
    if not r.status(f"{L} 3 アカウントを作成", st, 201, data):
        return
    target_id = data.get("id") if isinstance(data, dict) else None
    if not target_id:
        r.error(f"{L} 3: 作成の本文に id が無い")
        return
    if data.get("role") != "MEMBER":
        r.error(f"{L} 3: 役割の既定が利用者（MEMBER）でない（{data.get('role')!r}）")
    if not d1(f"SELECT 1 AS ok FROM grants WHERE account_id = {q(target_id)} AND learning = {q(first)}"):
        r.error(f"{L} 3: 権限の行（{first}）が作られていない")

    # 4. 名前・役割・開ける学びを送って更新する（権限は送られた一覧に置き換わる）
    want = [second]
    st, data, _, _ = admin.call(
        "PUT", f"/api/admin/accounts/{target_id}",
        {"name": "シナリオの利用者2", "role": "MEMBER", "grants": want},
    )
    r.status(f"{L} 4 名前・役割・開ける学びを更新", st, 200, data)
    row = row_of(target_id)
    if sorted(row.get("grants") or []) != sorted(want):
        r.error(f"{L} 4: 権限が送った一覧に置き換わっていない（{row.get('grants')!r} / {want}）")
    if row.get("name") != "シナリオの利用者2":
        r.error(f"{L} 4: 名前の更新が反映されていない（{row.get('name')!r}）")
    if row.get("role") != "MEMBER":
        r.error(f"{L} 4: 役割が送った値でない（{row.get('role')!r}）")
    if second == first:
        r.warn(f"{L} 4: 学びが 1 つしか無いので、前の権限が外れることは未検査")

    # 5. ある人のパスワードを再設定する（ハッシュを入れ替え、その人のセッションを全部切る）
    target = Client(base)
    st, _, _, _ = target.call("POST", "/api/login", {"email": SCENARIO_EMAIL, "password": PASSWORD})
    if not r.status(f"{L} 5 の前提 その人がログインしている", st, 200):
        return
    new_pw = PASSWORD + "-scenario"
    st, data, _, _ = admin.call("POST", f"/api/admin/accounts/{target_id}/password", {"password": new_pw})
    r.status(f"{L} 5 パスワードを再設定", st, 200, data)
    st, data, _, _ = target.call("GET", "/api/me")
    r.status(f"{L} 5 開いていたセッションが切れる", st, 401, data)
    st, data, _, _ = Client(base).call("POST", "/api/login", {"email": SCENARIO_EMAIL, "password": new_pw})
    r.status(f"{L} 5 再設定したパスワードで入れる", st, 200, data)

    # 6. アカウントを削除する（アカウントとその権限を消す）
    st, data, _, _ = admin.call("DELETE", f"/api/admin/accounts/{target_id}")
    r.status(f"{L} 6 アカウントを削除", st, 200, data)

    # 事後条件: accounts と grants が操作どおりになっている
    if row_of(target_id):
        r.error(f"{L} 事後条件: 削除したアカウントが一覧に残っている")
    if d1(f"SELECT 1 AS ok FROM accounts WHERE email = {q(SCENARIO_EMAIL)}"):
        r.error(f"{L} 事後条件: 削除したアカウントの行が accounts に残っている")
    if d1(f"SELECT 1 AS ok FROM grants WHERE account_id = {q(target_id)}"):
        r.error(f"{L} 事後条件: 削除したアカウントの権限が grants に残っている")
    # 事後条件: 管理者自身の管理者権限とアカウントは残っている
    rows = d1(f"SELECT role FROM accounts WHERE id = {q(admin_id)}")
    if not rows or rows[0].get("role") != "ADMIN":
        r.error(f"{L} 事後条件: 管理者自身のアカウントか管理者権限が残っていない（{rows and rows[0]}）")
    st, data, _, _ = admin.call("GET", "/api/me")
    r.status(f"{L} 事後条件 管理者はログインしたまま", st, 200, data)
    r.note(f"{L} の基本の流れ: 管理の API → 一覧 → 作成 → 更新（権限の置き換え）→ 再設定 → 削除")


# @scenario UC-003
def check_scenario_uc003(admin: Client, r: Report, base: str, learn: list[dict]):
    """自分のパスワードを変える → ログアウトする。"""
    L = "UC-003"
    email = f"{PREFIX}scenario-me@example.com"

    # 前提条件: 本人のアカウントがあり、その人でログイン中（Cookie のセッションがある）
    st, data, _, _ = admin.call(
        "POST", "/api/admin/accounts",
        {"email": email, "name": "シナリオの本人", "password": PASSWORD, "grants": [learn[0]["key"]]},
    )
    if not r.status(f"{L} の前提 本人のアカウントを用意", st, 201, data):
        return
    me = Client(base)
    st, data, _, _ = me.call("POST", "/api/login", {"email": email, "password": PASSWORD})
    if not r.status(f"{L} の前提 本人でログイン", st, 200, data):
        return
    session_id = me.session_id()

    # 1. 現在のパスワードと新しいパスワードを送る（照合して新しいハッシュに入れ替える）
    new_pw = PASSWORD + "-mine"
    st, data, _, _ = me.call("POST", "/api/me/password", {"current": PASSWORD, "next": new_pw})
    r.status(f"{L} 1 自分のパスワードを変える", st, 200, data)

    # 2. ログアウトする（この端末のセッションを消し、Cookie を失効させる）
    st, data, _, _ = me.call("POST", "/api/logout", None)
    r.status(f"{L} 2 ログアウト", st, 200, data)

    # 事後条件: 新しいパスワードでログインでき、前のパスワードでは入れない
    st, data, _, _ = Client(base).call("POST", "/api/login", {"email": email, "password": new_pw})
    r.status(f"{L} 事後条件 新しいパスワードで入れる", st, 200, data)
    st, data, _, _ = Client(base).call("POST", "/api/login", {"email": email, "password": PASSWORD})
    r.status(f"{L} 事後条件 前のパスワードでは入れない", st, 401, data)
    # 事後条件: ログアウトした端末の Cookie は使えない
    st, data, _, _ = me.call("GET", "/api/me")
    r.status(f"{L} 事後条件 ログアウトした Cookie は使えない", st, 401, data)
    if not session_id:
        r.error(f"{L} 事後条件: ログアウト前のセッション ID が Cookie から取れなかった")
    elif d1(f"SELECT 1 AS ok FROM sessions WHERE id = {q(session_id)}"):
        r.error(f"{L} 事後条件: ログアウトしたのに sessions の行が残っている")
    r.note(f"{L} の基本の流れ: パスワードの変更 → ログアウト（新旧のパスワードと Cookie の失効まで）")


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
        check_portal_auth_boundary(r, args.base)
        check_learnings(Client(args.base), r, learn, args.secret)
        if not check_login(admin, r):
            print("検査用の管理者でログインできなかった", file=sys.stderr)
            for e in r.errors:
                print(f"  - {e}", file=sys.stderr)
            return 1
        member_id = check_admin_accounts(admin, r, args.base, learn)
        check_admin_list(admin, r)
        check_admin_validation(admin, r, args.base, member_id)
        check_admin_self_guard(admin, r, admin_id)
        check_unknown_api_path(r, args.base, admin)
        check_body_schema(admin, r, args.base, args.secret, admin_grant, member_id)
        code = check_sso_start(r, args.base, learn, admin_grant)
        check_sso_exchange(admin, r, args.base, args.secret, code, admin_grant, learn)
        check_me_password_and_logout(r, args.base)
        # UC の基本の流れの写し。自分の検査用アカウントを作って消すところまでで完結するので最後に置く。
        check_scenario_uc002(admin, r, args.base, learn, admin_id)
        check_scenario_uc003(admin, r, args.base, learn)
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
