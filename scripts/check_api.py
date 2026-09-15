#!/usr/bin/env python3
"""API（L3）の検査。ローカルの wrangler dev に実際に HTTP で当てて、形と挙動を見る。

    bash scripts/check_api.sh ip      # ← 通常はこちらから呼ぶ（起動と停止までやる）
    python3 scripts/check_api.py --exam ip --base http://127.0.0.1:8788

## なぜ要るか

`docs/検査観点カタログ.md` の層で言うと L3。ここだけ恒久の門が無く、個別の curl で
その場を確認するだけだった。データ側（L1/L2）と描画側（L4）は全件検査があるのに、
**その間をつなぐ API の形は誰も見ていない**。

API の形は静かに壊れる。SELECT の別名を1つ変えれば画面の値が undefined になるが、
サーバは 200 を返すのでログにも出ない。認証も同じで、ミドルウェアの除外条件を
1行いじると保護が外れる（`/api/auth/` 前方一致で通す実装なので、経路を足したときに
うっかり通ることがありうる）。落ちてから気づくのではなく、投入前に機械で止める。

## 見るもの

1. **認証の境界** — 保護された全経路に未認証・壊れたトークンで当てて 401 か。
   200 なら保護が外れている。500 ならトークン検証で落ちている。どちらも問題
2. **失敗時の形** — 入力エラー 400 / 重複登録 409 / ログイン失敗 401 / 未知の経路 404。
   本文が `{error: string}` で日本語か（クライアントは `data?.error` をそのまま
   画面に出すので、この形が崩れると「通信に失敗しました」しか出せなくなる）
3. **各 GET の形** — `src/server/routes/*.ts` の実装から書き起こした期待形と突き合わせる。
   配列は**全要素**を見る（1件目だけ見ても、NULL になる列は拾えない）。
   期待形のキーには「クライアントが参照しているか」の印を付けてあり、
   **クライアントが使うキーが欠けたらエラー**、それ以外は警告にする
4. **件数の整合** — /fields /glossary /exams の件数が、ローカル D1 の SELECT と一致するか。
   「API が 200 を返した」と「中身が全部入っている」は別（出典が全880問おかしいまま
   数か月気づかなかった事故と同じ構図）
5. **セッションの一連の流れ** — 作成 → 1問回答 → 中断 → 再開 → 全問回答 → finish → 結果。
   二重回答（位置ずれ）と、他人のセッション ID へのアクセスも見る。
   後者は**別アカウントを実際に作って**確認する（存在しない UUID で 404 が出ても、
   それは「持ち主で絞れている」証明にならない）
6. **null と [] の区別** — 一覧が空のとき `[]` が返るか（`null` や キー欠落だと、
   画面が「未取得」と区別できず読み込み中に「ありません」と誤って出る。
   CLAUDE.md の落とし穴に入っている実際のバグ）

## 触るもの・触らないもの

- 検査用アカウント（`apicheck@example.com` / `apicheck-other@example.com`）の中だけで完結する。
  既存データの UPDATE / DELETE はしない。理解度の記録（progress）も書かない
- 消すのは検査用アカウント自身の「進行中セッション」だけ（残っていると 409 で
  次回の検査が始められないため）。終わったセッションは残す
- **ローカルの D1 だけ。本番 URL には当てない**
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

EMAIL = "apicheck@example.com"
EMAIL_OTHER = "apicheck-other@example.com"
PASSWORD = "apicheck-pass-1234"

# 日本語が1文字も無いエラーメッセージは、たいてい内部の例外がそのまま出ている
JAPANESE = re.compile(r"[ぁ-んァ-ヶ一-龥]")


# --------------------------------------------------------------------------
# 期待形の書き方
#
#   "str" "int" "num" "bool" "any" "strmap"(str->str の辞書) "strlist"
#   末尾の "?" で null を許す（"str?" など）
#   dict          … オブジェクト。キー名の頭の "*" は「クライアントが参照している」印
#   [spec]        … 配列（全要素を見る）
#   ("|", a, b)   … どちらかの形
# --------------------------------------------------------------------------

SCALARS = {
    "str": lambda v: isinstance(v, str),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "num": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "any": lambda v: True,
    "strmap": lambda v: isinstance(v, dict)
    and all(isinstance(k, str) and isinstance(x, str) for k, x in v.items()),
    "strlist": lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v),
}

# 問題ごとの解説。まだ全問には無いので null を許す。
EXPLANATION = (
    "|",
    None,
    {"*correctReason": "str", "*choices": [{"*label": "str", "*term": "str?", "*note": "str"}]},
)


def check_shape(value, spec, path, errors, warnings):
    """value が spec の形をしているか。壊れた場所を path 付きで積む。"""
    if spec is None:
        if value is not None:
            errors.append(f"{path}: null のはずが {type(value).__name__}")
        return

    if isinstance(spec, tuple) and spec and spec[0] == "|":
        for alt in spec[1:]:
            sub_e, sub_w = [], []
            check_shape(value, alt, path, sub_e, sub_w)
            if not sub_e:
                warnings.extend(sub_w)
                return
        errors.append(f"{path}: どの形にも当てはまらない（{json.dumps(value, ensure_ascii=False)[:80]}）")
        return

    if isinstance(spec, str):
        nullable = spec.endswith("?")
        base = spec[:-1] if nullable else spec
        if value is None:
            if not nullable:
                errors.append(f"{path}: null（{base} のはず）")
            return
        if not SCALARS[base](value):
            errors.append(f"{path}: {base} のはずが {type(value).__name__}")
        return

    if isinstance(spec, list):
        if not isinstance(value, list):
            errors.append(f"{path}: 配列のはずが {type(value).__name__}（null なら [] を返すこと）")
            return
        # 全要素を見る。同じ壊れ方は1行にまとめる。
        seen = set()
        for i, item in enumerate(value):
            e, w = [], []
            check_shape(item, spec[0], f"{path}[]", e, w)
            for m in e:
                if m not in seen:
                    seen.add(m)
                    errors.append(f"{m}（{i} 番目ほか）" if i else m)
            for m in w:
                if m not in seen:
                    seen.add(m)
                    warnings.append(m)
        return

    if isinstance(spec, dict):
        if not isinstance(value, dict):
            errors.append(f"{path}: オブジェクトのはずが {type(value).__name__}")
            return
        for raw_key, sub in spec.items():
            used_by_client = raw_key.startswith("*")
            key = raw_key[1:] if used_by_client else raw_key
            if key not in value:
                msg = f"{path}.{key}: キーが無い"
                if used_by_client:
                    errors.append(msg + "（クライアントが参照している）")
                else:
                    warnings.append(msg)
                continue
            check_shape(value[key], sub, f"{path}.{key}", errors, warnings)
        return

    raise AssertionError(f"期待形の書き方が不正: {spec!r}")


# --------------------------------------------------------------------------
# 期待形（src/server/routes/*.ts から書き起こし。* はクライアントが参照するキー）
# --------------------------------------------------------------------------

ME = {
    "*user": {"*id": "str", "*name": "str", "*role": "str"},
    "topics": {"total": "int", "understood": "int", "partly": "int"},
    "*recentSessions": [
        {
            "*id": "str",
            "*kind": "str",
            "*scopeLabel": "str",
            "*questionCount": "int",
            "*correctCount": "int?",
            "finishedAt": "int?",
        }
    ],
    "nextTopics": [{"id": "int", "term": "str", "questionCount": "int", "field": "str"}],
    "*visits": {"*today": "str", "*streak": "int", "*longest": "int", "*total": "int"},
}

FIELDS = {
    "*fields": [
        {
            "*field": "str",
            "*topics": "int",
            "*questions": "int",
            "*understood": "int",
            "*partly": "int",
            "*untouched": "int",
        }
    ]
}

CATEGORIES = {
    "*categories": [
        {
            "*middleNo": "int",
            "*middle": "str",
            "*major": "str",
            "*field": "str",
            "*topics": "int",
            "*questions": "int",
            "*understood": "int",
        }
    ]
}

TOPICS = {
    "*topics": [
        {
            "*id": "int",
            "*term": "str",
            "*questionCount": "int",
            "*status": "int?",
            "*field": "str",
            "*middle": "str",
            "*itemName": "str",
            "*isNew": "int",
        }
    ]
}

TOPIC_DETAIL = {
    "*topic": {
        "*id": "int",
        "*term": "str",
        "*explanation": "str?",
        "*detail": "str?",
        "*questionCount": "int",
        "isNew": "int",
        "*status": "int?",
        "*field": "str",
        "*major": "str",
        "*middle": "str",
        "*middleNo": "int",
        "*itemName": "str",
        "syllabusItemId": "int",
    },
    "*questions": [
        {
            "*id": "str",
            "*number": "int",
            "*examLabel": "str",
            "*text": "str",
            "*choices": "strmap",
            "*answer": "str",
            "*hasFigure": "int",
            "*figureDescription": "str?",
            "*figureImage": "str?",
            "*citation": "str",
            "*modified": "int",
            "*timesAsked": "int",
            "*otherCitations": "strlist",
            "*explanation": EXPLANATION,
            "contentKey": "str?",
            "exam": "str",
        }
    ],
    "*siblings": [{"*id": "int", "*term": "str", "*questionCount": "int"}],
}

GLOSSARY = {"*glossary": [{"*term": "str", "*brief": "str", "*topicId": "int?"}]}

EXAMS = {
    "*exams": [
        {
            "*exam": "str",
            "*examLabel": "str",
            "*questions": "int",
            "*attempts": "int",
            "*bestScore": "int?",
        }
    ]
}

HISTORY = {
    "*sessions": [
        {
            "*id": "str",
            "*kind": "str",
            "*scopeLabel": "str",
            "*questionCount": "int",
            "*correctCount": "int?",
            "startedAt": "int",
            "*finishedAt": "int?",
            "sourceExam": "str?",
        }
    ]
}

SESSION_CURRENT_NONE = {"*session": None}
SESSION_CURRENT_SOME = {
    "*session": {
        "*id": "str",
        "*kind": "str",
        "*scopeLabel": "str",
        "*questionCount": "int",
        "*answered": "int",
        "status": "str",
    }
}

SESSION_QUESTION = {
    "*session": {
        "*id": "str",
        "*kind": "str",
        "*scopeLabel": "str",
        "*questionCount": "int",
        "*sourceExam": "str?",
    },
    "*question": {
        "*idx": "int",
        "*text": "str",
        "*choices": "strmap",
        "*citation": "str",
        "*modified": "bool",
        "*hasFigure": "bool",
        "*figureDescription": "str?",
        "*figureImage": "str?",
        "*timesAsked": "int",
        "*otherCitations": "strlist",
    },
    "*answered": "int",
    "*remainingSec": "int?",
    "*finished": "bool",
}

SESSION_FINISHED = {
    "session": "any",
    "*question": None,
    "*finished": "bool",
    "*expired": "bool",
    "*answered": "int",
    "*remainingSec": "int?",
}

SESSION_CREATED = {
    "*id": "str",
    "kind": "str",
    "scopeLabel": "str",
    "questionCount": "int",
    "timeLimitSec": "int?",
}

ANSWER = {
    "*correct": "bool",
    "*correctAnswer": "str",
    "*explanation": EXPLANATION,
    "*remaining": "int",
    "*finished": "bool",
}

RESULT = {
    "*session": {
        "*kind": "str",
        "*scopeLabel": "str",
        "*questionCount": "int",
        # 通し受験（原本どおり）かランダム構成かの判別。重複バッジの出し分けに使う
        "*sourceExam": "str?",
    },
    "*overall": {"*total": "int", "*correct": "int", "*pct": "int"},
    "*fields": [{"*field": "str", "*total": "int", "*correct": "int", "*pct": "int"}],
    "*passed": "bool",
    # 制限時間切れで締められたか（結果画面でその旨を出す）
    "*expired": "bool",
    "*criteria": {"*overallPct": "int", "*fieldPct": "int"},
    "*approximation": "str",
    "*items": [
        {
            "*idx": "int",
            "*text": "str",
            "*choices": "strmap",
            "*answer": "str",
            "*userAnswer": "str?",
            "*result": "int",
            "*citation": "str",
            "*modified": "bool",
            "*hasFigure": "bool",
            "*figureDescription": "str?",
            "*figureImage": "str?",
            "*timesAsked": "int",
            "*otherCitations": "strlist",
            "*topicId": "int?",
            "*topicTerm": "str?",
            "*explanation": EXPLANATION,
        }
    ],
}

ERROR_BODY = {"*error": "str"}

# 認証が要る経路の一覧。ここに載っていない経路を足したら、この表にも足すこと。
# （`/api/auth/*` と `/api/health` だけが公開。前方一致で通す実装なので、
#   経路を足したときに保護が外れていないかを毎回ここで見る）
PROTECTED = [
    ("GET", "/me"),
    ("GET", "/fields"),
    ("GET", "/categories"),
    ("GET", "/topics"),
    ("GET", "/topics/1"),
    ("PUT", "/topics/1/progress"),
    ("GET", "/glossary"),
    ("GET", "/exams"),
    ("GET", "/sessions"),
    ("POST", "/sessions"),
    ("GET", "/sessions/current"),
    ("DELETE", "/sessions/current"),
    ("GET", "/sessions/00000000-0000-4000-8000-000000000000"),
    ("GET", "/sessions/00000000-0000-4000-8000-000000000000/current"),
    ("POST", "/sessions/00000000-0000-4000-8000-000000000000/answer"),
    ("POST", "/sessions/00000000-0000-4000-8000-000000000000/finish"),
]


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.token: str | None = None

    def call(self, method: str, path: str, body=None, token: str | None = "self"):
        # 分野名など日本語のクエリをそのまま渡すと urllib が送れない
        url = f"{self.base}/api" + urllib.parse.quote(path, safe="/?=&:,")
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        tok = self.token if token == "self" else token
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        # Cloudflare のボット対策は素の HTTP クライアントを弾く。ローカルでは
        # 効かないが、同じ関数を本番の確認に流用されたときのために付けておく。
        req.add_header("User-Agent", "Mozilla/5.0 (check_api.py)")
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                text = res.read().decode("utf-8", "replace")
                status = res.status
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            status = e.code
        except Exception as e:  # 接続できない等
            return 0, None, str(e)
        try:
            return status, (json.loads(text) if text else None), text
        except json.JSONDecodeError:
            return status, None, text


# --------------------------------------------------------------------------
# ローカル D1
# --------------------------------------------------------------------------


def d1(exam: str, db_name: str, command: str):
    out = subprocess.run(
        [
            "npx", "wrangler", "d1", "execute", db_name,
            "--local", "--env", exam, "--json", "--command", command,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    # wrangler は起動メッセージを stdout に混ぜることがあるので JSON 部分だけ拾う
    body = out.stdout[out.stdout.find("[") :] if "[" in out.stdout else ""
    if not body:
        raise RuntimeError(f"D1 の SELECT に失敗: {out.stdout[-400:]}{out.stderr[-400:]}")
    return json.loads(body)[0]["results"]


# --------------------------------------------------------------------------
# 検査本体
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

    def shape(self, label: str, value, spec):
        e, w = [], []
        check_shape(value, spec, label, e, w)
        self.errors.extend(e)
        self.warnings.extend(w)
        return not e

    def status(self, label: str, got: int, want, body=None):
        want_set = want if isinstance(want, (set, tuple, list)) else {want}
        if got in want_set:
            return True
        want_txt = "/".join(str(x) for x in sorted(want_set))
        extra = f" 本文 {json.dumps(body, ensure_ascii=False)[:100]}" if body is not None else ""
        self.error(f"{label}: {got} が返った（{want_txt} のはず）{extra}")
        return False

    def error_body(self, label: str, body):
        """失敗の本文が {error: 日本語の文字列} か。クライアントはこれを画面に出す。"""
        if not self.shape(label, body, ERROR_BODY):
            return
        if not JAPANESE.search(body["error"]):
            self.warn(f"{label}: error が日本語でない（{body['error'][:60]}）")


def signup_code(exam: str) -> str | None:
    """.dev.vars か wrangler.jsonc の vars から合言葉を読む。未設定なら None。"""
    dev = ROOT / ".dev.vars"
    if dev.exists():
        for line in dev.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("SIGNUP_CODE="):
                return line.split("=", 1)[1].strip().strip("'\"")
    raw = (ROOT / "wrangler.jsonc").read_text(encoding="utf-8")
    raw = re.sub(r"(?m)^\s*//.*$", "", raw)
    cfg = json.loads(raw)
    for vars_ in (cfg.get("env", {}).get(exam, {}).get("vars", {}), cfg.get("vars", {})):
        if vars_.get("SIGNUP_CODE"):
            return vars_["SIGNUP_CODE"]
    return None


def account(c: Client, r: Report, email: str, name: str, code: str | None) -> str | None:
    """検査用アカウントを用意してトークンを返す。あれば login、無ければ register。"""
    body = {"email": email, "password": PASSWORD, "name": name}
    if code:
        body["signupCode"] = code
    st, data, _ = c.call("POST", "/auth/register", body, token=None)
    if st == 201:
        return data["token"]
    if st != 409:
        r.error(f"検査用アカウントの登録: {st} が返った（201 か 409 のはず）: {str(data)[:120]}")
        if st != 409:
            return None
    st, data, _ = c.call(
        "POST", "/auth/login", {"email": email, "password": PASSWORD}, token=None
    )
    if st != 200:
        r.error(f"検査用アカウントのログイン: {st} が返った（200 のはず）: {str(data)[:120]}")
        return None
    return data["token"]


def check_auth_boundary(c: Client, r: Report):
    """未認証・壊れたトークンで保護経路に当てる。200 なら保護が外れ、500 なら検証で落ちている。"""
    broken = [
        (None, "トークン無し"),
        ("not-a-token", "形になっていないトークン"),
        ("aaa.bbb.ccc", "署名の合わないトークン"),
    ]
    for method, path in PROTECTED:
        for tok, label in broken:
            body = {} if method in ("POST", "PUT") else None
            st, data, _ = c.call(method, path, body, token=tok)
            if st != 401:
                r.error(f"認証の境界 {method} {path}（{label}）: {st} が返った（401 のはず）")
            elif tok is None:
                r.error_body(f"認証の境界 {method} {path} の本文", data)
    # 公開経路は逆に通ること
    st, data, _ = c.call("GET", "/health", token=None)
    r.status("GET /health（公開）", st, 200)
    r.shape("GET /health", data, {"*ok": "bool"})


def check_failure_shapes(c: Client, r: Report, code: str | None):
    """失敗したときのステータスと本文。クライアントは data?.error をそのまま画面に出す。"""
    cases = [
        ("register 空ボディ", "POST", "/auth/register", {}, 400),
        (
            "register 短いパスワード",
            "POST",
            "/auth/register",
            {"email": "x@example.com", "password": "short", "name": "x"},
            400,
        ),
        (
            "register 不正なメール",
            "POST",
            "/auth/register",
            {"email": "not-an-email", "password": PASSWORD, "name": "x"},
            400,
        ),
        ("login 空ボディ", "POST", "/auth/login", {}, 400),
        (
            "login パスワード違い",
            "POST",
            "/auth/login",
            {"email": EMAIL, "password": "wrong-password-9999"},
            401,
        ),
        (
            "login 未登録のメール",
            "POST",
            "/auth/login",
            {"email": "nobody-here@example.com", "password": PASSWORD},
            401,
        ),
    ]
    dup = {"email": EMAIL, "password": PASSWORD, "name": "apicheck"}
    if code:
        dup["signupCode"] = code
    cases.append(("register 重複", "POST", "/auth/register", dup, 409))

    for label, method, path, body, want in cases:
        st, data, _ = c.call(method, path, body, token=None)
        if r.status(label, st, want, data):
            r.error_body(f"{label} の本文", data)

    # 認証後の失敗経路
    for label, method, path, body, want in [
        ("未知の API 経路", "GET", "/no-such-endpoint", None, 404),
        ("topics/:id が数字でない", "GET", "/topics/abc", None, 400),
        ("存在しない論点", "GET", "/topics/99999999", None, 404),
        ("topics?limit が上限超え", "GET", "/topics?limit=9999", None, 400),
        ("topics?sort が範囲外", "GET", "/topics?sort=nonsense", None, 400),
        ("存在しないセッション", "GET", "/sessions/" + str(uuid.uuid4()), None, 404),
        ("progress に範囲外の status", "PUT", "/topics/1/progress", {"status": 9}, 400),
        ("セッション作成が空ボディ", "POST", "/sessions", {}, 400),
    ]:
        st, data, _ = c.call(method, path, body)
        if r.status(label, st, want, data):
            r.error_body(f"{label} の本文", data)


def check_get_shapes(c: Client, r: Report) -> dict:
    """各 GET の形。返ってきた本文は件数の検査でも使うので返す。"""
    got = {}
    for label, path, spec in [
        ("GET /me", "/me", ME),
        ("GET /fields", "/fields", FIELDS),
        ("GET /categories", "/categories", CATEGORIES),
        ("GET /topics", "/topics?limit=500", TOPICS),
        ("GET /glossary", "/glossary", GLOSSARY),
        ("GET /exams", "/exams", EXAMS),
        ("GET /sessions（履歴）", "/sessions", HISTORY),
    ]:
        st, data, text = c.call("GET", path)
        if not r.status(label, st, 200, None if st == 200 else text[:200]):
            continue
        r.shape(label, data, spec)
        got[path] = data

    # 論点の詳細は「過去問が紐づいている論点」で見る（頻度順の先頭）
    topics = got.get("/topics?limit=500", {}).get("topics") or []
    with_q = next((t for t in topics if t["questionCount"] > 0), None)
    if with_q:
        st, data, text = c.call("GET", f"/topics/{with_q['id']}")
        if r.status(f"GET /topics/{with_q['id']}", st, 200, None if st == 200 else text[:200]):
            r.shape("GET /topics/:id", data, TOPIC_DETAIL)
            got["topic_detail"] = data
    else:
        r.error("過去問が紐づいた論点が1件も無い（/topics の questionCount が全部 0）")
    return got


def check_counts(c: Client, r: Report, got: dict, exam: str, db_name: str):
    """API の件数がローカル D1 の SELECT と一致するか。200 と「全部入っている」は別。"""
    rows = d1(
        exam,
        db_name,
        "SELECT (SELECT COUNT(*) FROM topics t JOIN syllabus_items s ON s.id = t.syllabus_item_id)"
        " AS topics,"
        " (SELECT COALESCE(SUM(t.question_count),0) FROM topics t"
        "   JOIN syllabus_items s ON s.id = t.syllabus_item_id) AS topic_questions,"
        " (SELECT COUNT(*) FROM glossary) AS glossary,"
        " (SELECT COUNT(DISTINCT exam) FROM past_questions) AS exams,"
        " (SELECT COUNT(*) FROM past_questions) AS questions",
    )[0]
    per_exam = {x["exam"]: x["n"] for x in d1(
        exam, db_name, "SELECT exam AS exam, COUNT(*) AS n FROM past_questions GROUP BY exam"
    )}

    def same(label, api_n, db_n):
        if api_n != db_n:
            r.error(f"件数の不一致 {label}: API {api_n} / D1 {db_n}")

    fields = (got.get("/fields") or {}).get("fields") or []
    same("/fields の論点数の合計", sum(f["topics"] for f in fields), rows["topics"])
    same("/fields の出題数の合計", sum(f["questions"] for f in fields), rows["topic_questions"])

    cats = (got.get("/categories") or {}).get("categories") or []
    same("/categories の論点数の合計", sum(x["topics"] for x in cats), rows["topics"])

    gloss = (got.get("/glossary") or {}).get("glossary") or []
    same("/glossary の語数", len(gloss), rows["glossary"])

    exams = (got.get("/exams") or {}).get("exams") or []
    same("/exams の回数", len(exams), rows["exams"])
    same("/exams の問題数の合計", sum(x["questions"] for x in exams), rows["questions"])
    for e in exams:
        same(f"/exams {e['exam']} の問題数", e["questions"], per_exam.get(e["exam"]))

    # /topics は limit で切れる。切れていないことと、上限が効いていることの両方を見る。
    topics = (got.get("/topics?limit=500") or {}).get("topics") or []
    same("/topics?limit=500 の件数", len(topics), min(500, rows["topics"]))
    st, data, _ = c.call("GET", "/topics?limit=5")
    if r.status("GET /topics?limit=5", st, 200):
        same("/topics?limit=5 の件数", len(data["topics"]), min(5, rows["topics"]))

    r.notes.append(
        f"論点 {rows['topics']} / 用語 {rows['glossary']} / 過去問 {rows['questions']} 問 "
        f"{rows['exams']} 回（API と D1 で一致）"
    )
    return rows


def check_empty_lists(c: Client, r: Report, other_token: str):
    """空になりうる一覧が [] で返るか。null や キー欠落だと画面が未取得と区別できない。

    まだ何もしていないアカウント（apicheck-other）で見るのが要点。自分のアカウントは
    セッションを作ってしまうので「空」の状態を作れない。"""
    cases = [
        ("GET /sessions（履歴が空）", "/sessions", "sessions", other_token),
        ("GET /me の recentSessions（空）", "/me", "recentSessions", other_token),
        ("GET /me の nextTopics", "/me", "nextTopics", other_token),
        ("GET /topics（該当なし）", "/topics?field=そんな分野は無い", "topics", None),
        ("GET /categories（該当なし）", "/categories?field=そんな分野は無い", "categories", None),
    ]
    for label, path, key, tok in cases:
        st, data, _ = c.call("GET", path, token=tok if tok else "self")
        if not r.status(label, st, 200):
            continue
        if key not in (data or {}):
            r.error(f"{label}: キー {key} が無い（空でも [] を返すこと）")
        elif data[key] is None:
            r.error(f"{label}: {key} が null（空なら [] を返すこと。未取得と区別できなくなる）")
        elif not isinstance(data[key], list):
            r.error(f"{label}: {key} が配列でない")

    # 進行中セッションが無いときは {session: null}。ここは意図的に null（一覧ではない）。
    st, data, _ = c.call("GET", "/sessions/current", token=other_token)
    if r.status("GET /sessions/current（進行中なし）", st, 200):
        if "session" not in (data or {}):
            r.error("GET /sessions/current: キー session が無い（無いときも null を返すこと）")
        elif data["session"] is not None:
            r.warn("GET /sessions/current: 検査用アカウントに進行中セッションが残っている")


def check_session_flow(c: Client, r: Report, got: dict, other_token: str):
    """作成 → 1問回答 → 中断 → 再開 → 全問回答 → finish → 結果。二重回答と他人のセッションも見る。"""
    detail = got.get("topic_detail")
    if not detail:
        r.error("セッションの流れ: 出題できる論点が取れなかったので検査できない")
        return
    topic_id = detail["topic"]["id"]

    # 前回の検査で残った進行中セッションを片付ける（自分のアカウントの中だけ）
    c.call("DELETE", "/sessions/current")

    size = 3
    st, created, text = c.call(
        "POST", "/sessions", {"kind": "drill", "topicId": topic_id, "size": size}
    )
    if not r.status("POST /sessions", st, 201, None if st == 201 else text[:200]):
        return
    r.shape("POST /sessions", created, SESSION_CREATED)
    sid = created["id"]
    total = created["questionCount"]

    # 進行中がもう1つ作れないこと（409 ＋ inProgress を返す仕様）
    st, data, _ = c.call("POST", "/sessions", {"kind": "drill", "topicId": topic_id, "size": size})
    if r.status("POST /sessions（進行中が既にある）", st, 409, data):
        r.error_body("進行中が既にある場合の本文", data)
        if "inProgress" not in (data or {}):
            r.warn("POST /sessions の 409 に inProgress が無い（画面が続きを出せない）")

    # 1問目
    st, cur, text = c.call("GET", f"/sessions/{sid}/current")
    if not r.status("GET /sessions/:id/current", st, 200, None if st == 200 else text[:200]):
        return
    r.shape("GET /sessions/:id/current", cur, SESSION_QUESTION)
    if cur["question"]["idx"] != 0:
        r.error(f"GET /sessions/:id/current: 最初の idx が {cur['question']['idx']}（0 のはず）")
    if cur["answered"] != 0:
        r.error(f"GET /sessions/:id/current: answered が {cur['answered']}（0 のはず）")

    st, ans, text = c.call("POST", f"/sessions/{sid}/answer", {"idx": 0, "answer": "ア"})
    if not r.status("POST /sessions/:id/answer", st, 200, None if st == 200 else text[:200]):
        return
    r.shape("POST /sessions/:id/answer", ans, ANSWER)
    if ans["remaining"] != total - 1:
        r.error(f"1問回答後の remaining が {ans['remaining']}（{total - 1} のはず）")

    # 二重回答。同じ idx をもう一度送ると位置がずれているので採点させない。
    st, data, _ = c.call("POST", f"/sessions/{sid}/answer", {"idx": 0, "answer": "イ"})
    if r.status("二重回答（同じ idx を再送）", st, 409, data):
        r.error_body("二重回答の本文", data)
        if not (data or {}).get("staleQuestion"):
            r.warn("二重回答の 409 に staleQuestion が無い（画面が取り直しに入れない）")

    # 不正な選択肢
    st, data, _ = c.call("POST", f"/sessions/{sid}/answer", {"idx": 1, "answer": "オ"})
    if r.status("範囲外の選択肢", st, 400, data):
        r.error_body("範囲外の選択肢の本文", data)

    # 中断 →（別の画面を挟んで）再開
    st, data, _ = c.call("GET", "/sessions/current")
    if r.status("GET /sessions/current（中断中）", st, 200):
        r.shape("GET /sessions/current（中断中）", data, SESSION_CURRENT_SOME)
        if (data.get("session") or {}).get("id") != sid:
            r.error("GET /sessions/current が別のセッションを返した")
        elif data["session"]["answered"] != 1:
            r.error(f"中断中の answered が {data['session']['answered']}（1 のはず）")

    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if r.status("GET /sessions/:id/current（再開）", st, 200):
        r.shape("GET /sessions/:id/current（再開）", cur, SESSION_QUESTION)
        if cur["question"]["idx"] != 1:
            r.error(f"再開後の idx が {cur['question']['idx']}（1 のはず）")

    # 他人のセッションが引けないこと（別アカウントを実際に作って確かめる）
    for label, path in [
        (f"他人のセッション GET /sessions/{{id}}", f"/sessions/{sid}"),
        ("他人のセッション GET /sessions/{id}/current", f"/sessions/{sid}/current"),
    ]:
        st, data, _ = c.call("GET", path, token=other_token)
        if r.status(label, st, (403, 404), data):
            r.error_body(f"{label} の本文", data)
    st, data, _ = c.call(
        "POST", f"/sessions/{sid}/answer", {"idx": 1, "answer": "ア"}, token=other_token
    )
    r.status("他人のセッションへの回答", st, (403, 404), data)
    st, data, _ = c.call("POST", f"/sessions/{sid}/finish", None, token=other_token)
    r.status("他人のセッションの finish", st, (403, 404), data)

    # 残りを回答して終わらせる
    for i in range(1, total):
        st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
        if st != 200 or not cur.get("question"):
            r.error(f"{i} 問目が取れない（status {st}）")
            return
        st, ans, text = c.call(
            "POST", f"/sessions/{sid}/answer", {"idx": cur["question"]["idx"], "answer": "ア"}
        )
        if not r.status(f"{i + 1} 問目の回答", st, 200, None if st == 200 else text[:200]):
            return
    if not ans["finished"]:
        r.error("全問回答したのに finished が false")

    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if r.status("GET /sessions/:id/current（全問回答後）", st, 200):
        r.shape("GET /sessions/:id/current（全問回答後）", cur, SESSION_FINISHED)

    st, fin, text = c.call("POST", f"/sessions/{sid}/finish")
    if r.status("POST /sessions/:id/finish", st, 200, None if st == 200 else text[:200]):
        r.shape("POST /sessions/:id/finish", fin, {"*ok": "bool", "*correct": "int", "*total": "int"})
        if fin.get("total") != total:
            r.error(f"finish の total が {fin.get('total')}（{total} のはず）")

    # 終わったセッションには回答できない
    st, data, _ = c.call("POST", f"/sessions/{sid}/answer", {"idx": 0, "answer": "ア"})
    if r.status("終了後の回答", st, 409, data):
        r.error_body("終了後の回答の本文", data)

    # 結果
    st, res, text = c.call("GET", f"/sessions/{sid}")
    if r.status("GET /sessions/:id（結果）", st, 200, None if st == 200 else text[:200]):
        r.shape("GET /sessions/:id（結果）", res, RESULT)
        if res["overall"]["total"] != total:
            r.error(f"結果の overall.total が {res['overall']['total']}（{total} のはず）")
        if len(res["items"]) != total:
            r.error(f"結果の items が {len(res['items'])} 件（{total} 件のはず）")

    # 履歴に載ること
    st, hist, _ = c.call("GET", "/sessions")
    if r.status("GET /sessions（履歴・終了後）", st, 200):
        if not any(s["id"] == sid for s in hist.get("sessions") or []):
            r.error("終了したセッションが履歴 /sessions に出てこない")

    r.notes.append(f"セッションの流れ: {total} 問を作成 → 回答 → 中断 → 再開 → finish → 結果 まで通過")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exam", default="ip", choices=["ip", "ap", "itc"])
    ap.add_argument("--base", default="http://127.0.0.1:8788")
    ap.add_argument("--db", default=None, help="ローカル D1 の名前（既定は試験から決める）")
    args = ap.parse_args()
    db_name = args.db or {"ip": "study-app-db", "ap": "study-app-ap-db", "itc": "study-app-itc-db"}[args.exam]

    c = Client(args.base)
    r = Report()

    st, _, text = c.call("GET", "/health", token=None)
    if st != 200:
        print(f"{args.base} に繋がらない（{text[:200]}）。先に wrangler dev を起動すること",
              file=sys.stderr)
        return 1

    code = signup_code(args.exam)
    c.token = account(c, r, EMAIL, "apicheck", code)
    other = account(c, r, EMAIL_OTHER, "apicheck-other", code)
    if not c.token or not other:
        print("検査用アカウントを用意できなかった", file=sys.stderr)
        for e in r.errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    check_auth_boundary(c, r)
    check_failure_shapes(c, r, code)
    got = check_get_shapes(c, r)
    check_counts(c, r, got, args.exam, db_name)
    check_empty_lists(c, r, other)
    check_session_flow(c, r, got, other)

    # --- 結果 -------------------------------------------------------------
    print(f"{args.base}  試験『{args.exam}』  D1『{db_name}』")
    print(f"  保護経路 {len(PROTECTED)} 本 × 未認証3通り = {len(PROTECTED) * 3} 回の認証境界")
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
