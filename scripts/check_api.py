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
7. **並びと絞り込み** — /topics の既定の並び（資格版は出題頻度の降順 / ロードマップ型は
   学ぶ順）、sortOrder の出し方（資格版は sort_order を参照しないので null）、
   分野での絞り込み、ホームのおすすめ（/me の nextTopics）の並び
8. **模試の設定** — app_settings の問題数・制限時間が登録簿（src/shared/targets.json）と
   一致し、実際に作った模試がその問題数と制限時間で返るか
9. **セキュリティヘッダ** — 全応答に CSP・HSTS・X-Frame-Options DENY・nosniff・
   Referrer-Policy が載っているか
10. **出題の範囲と畳み込み** — 論点別の出題がその論点に紐づく過去問だけで、1回の出題に
    同じ内容の問題が2度出ないか。出題できる過去問が無い範囲は 400 で、セッションを作らないか
11. **公開回の通し受験** — その回の過去問の件数のまま（同一内容を畳まない）で、
    問番号の昇順に出るか
12. **完了していない結果と破棄** — 進行中のセッションの結果が 404 か（未回答の正解と解説が
    読めてしまう）、破棄で進行中とその回答が残らないか
13. **回ごとの受験回数** — /exams の受験回数・最高正答数が、他人の受験も進行中のセッションも
    数えていないか
14. **制限時間の境目** — 残り秒が開始時刻と制限時間から出るか、制限時間を過ぎたら問題を返さず
    回答も採点しないか、時間切れで締めた回の結果が時間切れになるか
15. **論点の詳細に添わるもの** — 「次に学ぶ論点」がいま開いている論点自身でも理解にした論点でも
    ないか、学ぶ順の前後の単位がロードマップ型だけに添えられ、端では該当側が null か
16. **UC の基本の流れの写し**（`check_scenario_uc0xx`。`docs/usecases/UC-xxx.md` の番号付きステップを
    順に 1 本で通し、最後に事後条件を見る）— 正常系だけ。失敗系・境界は 1〜15 が見る。
    画面の描画は `scripts/check_render.tsx` の担当なので、画面が使う応答までを確かめる

## 触るもの・触らないもの

- 検査用アカウント（`apicheck@example.com` / `apicheck-other@example.com`）の中だけで完結する。
  既存データの UPDATE / DELETE はしない。理解度の記録（progress）も書かない
- 消すのは検査用アカウント自身の「進行中セッション」だけ（残っていると 409 で
  次回の検査が始められないため）。終わったセッションは残す
- 書き換えるのは検査用アカウント自身が作った模試の開始時刻だけ（制限時間切れは
  時間の経過を待てないので、その 1 行を epoch に戻して作る）
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


def compare_shape(value, spec, path, errors, warnings):
    """value が spec の形をしているか。壊れた場所を path 付きで積む。"""
    if spec is None:
        if value is not None:
            errors.append(f"{path}: null のはずが {type(value).__name__}")
        return

    if isinstance(spec, tuple) and spec and spec[0] == "|":
        for alt in spec[1:]:
            sub_e, sub_w = [], []
            compare_shape(value, alt, path, sub_e, sub_w)
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
            compare_shape(item, spec[0], f"{path}[]", e, w)
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
            compare_shape(value[key], sub, f"{path}.{key}", errors, warnings)
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
            "*sortOrder": "int?",
        }
    ]
}

# 論点の詳細に添わるもの。次に学ぶ論点は候補が尽きたら null、
# 前後の単位はロードマップ型だけで、端では該当側が null（資格版は neighbors そのものが null）。
NEXT_TOPIC = ("|", None, {"*id": "int", "*term": "str", "*questionCount": "int"})
NEIGHBOR = ("|", None, {"*id": "int", "*term": "str"})
NEIGHBORS = ("|", None, {"*prev": NEIGHBOR, "*next": NEIGHBOR})

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
    "*nextTopic": NEXT_TOPIC,
    "*neighbors": NEIGHBORS,
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
    ("POST", "/feedback"),
]


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.token: str | None = None
        # 直前の応答のヘッダ（小文字のキー）。セキュリティヘッダの検査で見る
        self.last_headers: dict[str, str] = {}

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
                self.last_headers = {k.lower(): v for k, v in res.headers.items()}
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            status = e.code
            self.last_headers = {k.lower(): v for k, v in e.headers.items()}
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
        compare_shape(value, spec, label, e, w)
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


# @verifies REQ-033, REQ-047
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
    # SSO の設定（公開。要件 §15）。ローカルは未設定なので sso=false（パスワードの経路がそのまま検査できる）
    st, data, _ = c.call("GET", "/auth/config", token=None)
    r.status("GET /auth/config（公開）", st, 200)
    r.shape("GET /auth/config", data, {"*sso": "bool", "*portal": "str?", "*app": "str"})
    if isinstance(data, dict) and data.get("sso"):
        r.warn("この環境は SSO が有効（SSO_PORTAL_URL / SSO_SECRET あり）。パスワードの登録・ログインは 404 になるので、以降の検査は成立しない")
    # SSO 未設定の環境では /auth/sso は 404（有効な環境の一巡は scripts/check_sso_flow.py を受入で回す）
    st, data, _ = c.call("POST", "/auth/sso", {"code": "x"}, token=None)
    r.status("POST /auth/sso（未設定の環境では 404）", st, 404, data)


# @verifies REQ-013, REQ-034
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
        ("存在しない論点の progress", "PUT", "/topics/99999999/progress", {"status": 2}, 404),
        ("セッション作成が空ボディ", "POST", "/sessions", {}, 400),
        ("フィードバックが空ボディ", "POST", "/feedback", {}, 400),
        ("フィードバックが空文", "POST", "/feedback", {"body": "   "}, 400),
        ("フィードバックが長すぎ", "POST", "/feedback", {"body": "あ" * 2001}, 400),
        ("フィードバックの kind が不正", "POST", "/feedback", {"body": "x", "kind": "nope"}, 400),
        ("フィードバックの topicId が文字列", "POST", "/feedback", {"body": "x", "topicId": "1"}, 400),
    ]:
        st, data, _ = c.call(method, path, body)
        if r.status(label, st, want, data):
            r.error_body(f"{label} の本文", data)


# @verifies REQ-010, REQ-120, REQ-011, REQ-012, REQ-137
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


# @verifies REQ-010, REQ-120, REQ-011, REQ-137, REQ-041
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
    # 並び: ロードマップ型は 1 日目が先（学ぶ順）、資格版は新しい回が先。本人の指摘（2026-09-16、mkt で 14 日目が先頭に出た）
    if exams:
        sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
        first = exams[0]["exam"]; want_first = min(e["exam"] for e in exams) if _target(exam).get("roadmap") else max(e["exam"] for e in exams)
        if first != want_first:
            r.error(f"/exams の並び: 先頭が {first}（{'学ぶ順なら 1 日目' if _target(exam).get('roadmap') else '新しい回'} {want_first} のはず）")
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


# @verifies REQ-011, REQ-120, REQ-014
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


# @verifies REQ-025, REQ-026, REQ-193, REQ-196, REQ-199, REQ-202, REQ-203, REQ-205, REQ-207, REQ-218, REQ-232
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


# @verifies REQ-011, REQ-014, REQ-037
def check_ordering(c: Client, r: Report, got: dict, exam: str):
    """並びと絞り込み。/topics の既定の並び（資格版は出題頻度の降順 / ロードマップ型は学ぶ順）、
    sortOrder の出し方（資格版は sort_order を参照しないので null）、分野での絞り込み、
    ホームのおすすめ（/me の nextTopics）の並び。理解度で変わる部分は progress を書かないので見ない。"""
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    roadmap = bool(_target(exam).get("roadmap"))
    topics = (got.get("/topics?limit=500") or {}).get("topics") or []
    if not topics:
        r.error("並びの検査: /topics が空で確かめられない")
        return

    def rises(xs):  # 降順のはずが増えた位置
        return [i for i in range(1, len(xs)) if xs[i] > xs[i - 1]]

    def falls(xs):  # 昇順のはずが戻った位置
        return [i for i in range(1, len(xs)) if xs[i] < xs[i - 1]]

    if roadmap:
        no_order = [t["id"] for t in topics if t["sortOrder"] is None]
        if no_order:
            r.error(f"ロードマップ型なのに sortOrder が null の論点 {len(no_order)} 件: {no_order[:3]}")
        bad = falls([t["sortOrder"] for t in topics if t["sortOrder"] is not None])
        if bad:
            r.error(f"/topics の既定の並びが学ぶ順（sort_order の昇順）でない（{bad[:3]} 件目で戻る）")
    else:
        stray = [t["id"] for t in topics if t["sortOrder"] is not None]
        if stray:
            r.error(
                f"資格版の /topics が sortOrder を返している {len(stray)} 件: {stray[:3]}"
                "（資格版は sort_order 列を参照しない）"
            )
        bad = rises([t["questionCount"] for t in topics])
        if bad:
            r.error(f"/topics の既定の並びが出題頻度の降順でない（{bad[:3]} 件目で増える）")

    # 分野で絞れる（絞った結果に別の分野が混じらない・件数が /fields と合う）
    fields = (got.get("/fields") or {}).get("fields") or []
    if fields:
        f = fields[0]
        label = f"GET /topics?field={f['field']}"
        st, data, _ = c.call("GET", f"/topics?field={f['field']}&limit=500")
        if r.status(label, st, 200):
            rows = data.get("topics") or []
            other = sorted({t["field"] for t in rows} - {f["field"]})
            if other:
                r.error(f"{label}: 別の分野が混じる {other[:3]}")
            if len(rows) != min(500, f["topics"]):
                r.error(f"{label}: {len(rows)} 件（/fields の論点数 {f['topics']} と違う）")

    # ホームのおすすめ（/me の nextTopics）。資格版は出題頻度の降順
    nxt = (got.get("/me") or {}).get("nextTopics") or []
    if not nxt:
        r.warn("GET /me の nextTopics が空（おすすめの並びを確かめられない）")
    else:
        if any(t["questionCount"] <= 0 for t in nxt):
            r.error("おすすめ（/me の nextTopics）に出題が無い論点が入っている")
        if not roadmap:
            bad = rises([t["questionCount"] for t in nxt])
            if bad:
                r.error(f"おすすめの並びが出題頻度の降順でない（{bad[:3]} 件目で増える）")
    r.notes.append(
        f"並び: /topics {len(topics)} 件が{'学ぶ順' if roadmap else '出題頻度の降順'}"
        f"・おすすめ {len(nxt)} 件を確認"
    )


# @verifies REQ-133, REQ-150
def check_topic_detail_extras(c: Client, r: Report, got: dict, exam: str):
    """論点の詳細に添わる「次に学ぶ論点」と「学ぶ順の前後の単位」。

    次に学ぶ論点は、いま開いている論点自身でも「理解」にした論点でもなく、候補の先頭
    （資格版は出題頻度が最も高い候補 / ロードマップ型は学ぶ順の先頭）であること。
    前後の単位はロードマップ型だけに添わり、学ぶ順の隣で、端では該当側が null。
    資格版は neighbors そのものが null（sort_order の列を参照しない）。"""
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    roadmap = bool(_target(exam).get("roadmap"))
    detail = got.get("topic_detail")
    topics = (got.get("/topics?limit=500") or {}).get("topics") or []
    if not detail or not topics:
        r.error("論点の詳細の添え物: /topics か論点の詳細が取れなかったので確かめられない")
        return
    by_id = {t["id"]: t for t in topics}
    me_id = detail["topic"]["id"]

    # --- 次に学ぶ論点 -----------------------------------------------------
    for key in ("nextTopic", "neighbors"):
        if key not in detail:
            r.error(f"GET /topics/:id: キー {key} が無い（クライアントが参照している）")
    r.shape("GET /topics/:id の nextTopic", detail.get("nextTopic"), NEXT_TOPIC)
    # 候補: 自分以外・理解（3）でない・出題がある論点。/topics の並びが候補の順
    cands = [
        t for t in topics
        if t["id"] != me_id and t["status"] != 3 and t["questionCount"] > 0
    ]
    nxt = detail.get("nextTopic")
    if nxt is None:
        if cands:
            r.error(
                f"nextTopic が null（まだ理解していない論点が {len(cands)} 件あるのに添えられていない）"
            )
    elif isinstance(nxt, dict):
        if nxt.get("id") == me_id:
            r.error(f"nextTopic がいま開いている論点自身（{me_id}）")
        row = by_id.get(nxt.get("id"))
        if row is None:
            r.error(f"nextTopic の論点 {nxt.get('id')} が /topics に無い")
        else:
            if row["status"] == 3:
                r.error(f"nextTopic が理解にした論点（{row['id']} {row['term']}）")
            if nxt.get("term") != row["term"]:
                r.error(f"nextTopic の名前が /topics と違う（{nxt.get('term')} / {row['term']}）")
            if nxt.get("questionCount") != row["questionCount"]:
                r.error(
                    f"nextTopic の出題回数が /topics と違う"
                    f"（{nxt.get('questionCount')} / {row['questionCount']}）"
                )
            if cands:
                if roadmap:
                    if row["id"] != cands[0]["id"]:
                        r.error(
                            f"nextTopic が学ぶ順の先頭の候補でない"
                            f"（{row['id']} / 学ぶ順の先頭は {cands[0]['id']} {cands[0]['term']}）"
                        )
                else:
                    top = max(t["questionCount"] for t in cands)
                    if row["questionCount"] != top:
                        r.error(
                            f"nextTopic の出題回数が {row['questionCount']}"
                            f"（頻出でまだ理解していない先頭は {top} 回）"
                        )

    # --- 学ぶ順の前後の単位 -----------------------------------------------
    if not roadmap:
        if detail.get("neighbors") is not None:
            r.error(
                f"資格版なのに neighbors が返っている（{detail['neighbors']}）"
                "。資格版は sort_order の列を参照しない"
            )
        r.notes.append("論点の詳細の添え物: nextTopic を確認（資格版は neighbors が null）")
        return

    ordered = [t for t in topics if t["sortOrder"] is not None]
    if len(ordered) < 2:
        r.error("前後の単位の検査: 学ぶ順の単位が 2 件未満で確かめられない")
        return
    # 先頭・末尾・真ん中の 3 か所で見る（端は該当側が null になるはず）
    picks = {0: "先頭", len(ordered) - 1: "末尾", len(ordered) // 2: "真ん中"}
    for i, label in picks.items():
        unit = ordered[i]
        st, data, text = c.call("GET", f"/topics/{unit['id']}")
        if not r.status(
            f"GET /topics/{unit['id']}（{label}の単位）", st, 200, None if st == 200 else text[:200]
        ):
            continue
        if not isinstance(data, dict):
            r.error(f"GET /topics/{unit['id']}（{label}の単位）: 本文が JSON のオブジェクトでない")
            continue
        r.shape(f"GET /topics/{unit['id']} の neighbors", data.get("neighbors"), NEIGHBORS)
        nb = data.get("neighbors")
        if not isinstance(nb, dict):
            r.error(f"{label}の単位 {unit['id']}: neighbors が無い（ロードマップ型は前後を添える）")
            continue
        for side, j in (("prev", i - 1), ("next", i + 1)):
            want = ordered[j] if 0 <= j < len(ordered) else None
            side_got = nb.get(side)
            if want is None:
                if side_got is not None:
                    r.error(f"{label}の単位 {unit['id']}: {side} が {side_got}（端なので null のはず）")
            elif not isinstance(side_got, dict):
                r.error(
                    f"{label}の単位 {unit['id']}: {side} が null"
                    f"（学ぶ順の隣 {want['id']} {want['term']} のはず）"
                )
            elif side_got.get("id") != want["id"] or side_got.get("term") != want["term"]:
                r.error(
                    f"{label}の単位 {unit['id']}: {side} が {side_got.get('id')} {side_got.get('term')}"
                    f"（学ぶ順の隣は {want['id']} {want['term']}）"
                )
    r.notes.append(
        f"論点の詳細の添え物: nextTopic と、学ぶ順 {len(ordered)} 単位の前後（先頭・末尾・真ん中）を確認"
    )


# @verifies REQ-023
def check_mock_settings(c: Client, r: Report, exam: str, db_name: str):
    """模試の問題数と制限時間。app_settings の値が登録簿（src/shared/targets.json）と一致し、
    実際に作った模試がその問題数・制限時間で返るか。作った模試はその場で破棄する。"""
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    t = _target(exam)
    want_size, want_sec = t["mockSize"], t["mockMinutes"] * 60
    rows = d1(
        exam, db_name,
        "SELECT mock_size, mock_time_limit_sec FROM app_settings WHERE id = 'default'",
    )
    if not rows:
        r.error("app_settings に id='default' の行が無い（模試の設定が既定値に落ちる）")
    else:
        if rows[0]["mock_size"] != want_size:
            r.error(f"app_settings.mock_size が {rows[0]['mock_size']}（登録簿は {want_size}）")
        if rows[0]["mock_time_limit_sec"] != want_sec:
            r.error(
                f"app_settings.mock_time_limit_sec が {rows[0]['mock_time_limit_sec']}"
                f"（登録簿は {want_sec}）"
            )
    if t.get("roadmap"):
        r.notes.append(f"模試の設定: app_settings が {want_size} 問 / {want_sec} 秒（確認テストは日ごとなので出題は見ない）")
        return

    c.call("DELETE", "/sessions/current")
    st, created, text = c.call("POST", "/sessions", {"kind": "mock"})
    if not r.status("POST /sessions（模試）", st, 201, None if st == 201 else text[:200]):
        return
    r.shape("POST /sessions（模試）", created, SESSION_CREATED)
    if created.get("questionCount") != want_size:
        r.error(f"模試の問題数が {created.get('questionCount')}（{want_size} 問のはず）")
    if created.get("timeLimitSec") != want_sec:
        r.error(f"模試の制限時間が {created.get('timeLimitSec')} 秒（{want_sec} 秒のはず）")
    st, cur, _ = c.call("GET", "/sessions/current")
    if r.status("GET /sessions/current（模試）", st, 200):
        if (cur.get("session") or {}).get("id") != created["id"]:
            r.error("GET /sessions/current が作った模試を返さない")
    c.call("DELETE", "/sessions/current")
    r.notes.append(f"模試: {want_size} 問 / 制限 {want_sec} 秒で作成できることを確認（破棄済み）")


def squeeze(s: str) -> str:
    """空白を落とした本文（同じ問題かどうかを字面で突き合わせるため）。"""
    return re.sub(r"\s+", "", s or "")


# @verifies REQ-019, REQ-021, REQ-204
def check_session_scope(c: Client, r: Report, got: dict):
    """出題の範囲（論点別はその論点に紐づく過去問だけ）と畳み込み（1回の出題に同じ内容を2度出さない）、
    出題できる過去問が無い範囲の 400。作ったセッションはその場で破棄する。"""
    detail = got.get("topic_detail")
    if not detail:
        r.error("出題の範囲の検査: 出題できる論点が取れなかったので検査できない")
        return
    topic_id = detail["topic"]["id"]
    allowed = {squeeze(q["text"]) for q in detail["questions"]}

    c.call("DELETE", "/sessions/current")
    size = min(3, len(detail["questions"]))
    st, created, text = c.call("POST", "/sessions", {"kind": "drill", "topicId": topic_id, "size": size})
    if not r.status("POST /sessions（範囲の検査）", st, 201, None if st == 201 else text[:200]):
        return
    sid = created["id"]
    if created["questionCount"] > size:
        r.error(f"出題が指定した問題数を超えている: {created['questionCount']} 問（{size} 問以下のはず）")

    seen: list[str] = []
    for i in range(created["questionCount"]):
        st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
        if st != 200 or not (cur or {}).get("question"):
            r.error(f"出題の範囲の検査: {i + 1} 問目が取れない（status {st}）")
            break
        q = cur["question"]
        if squeeze(q["text"]) not in allowed:
            r.error(
                f"論点別の出題に範囲外の過去問が入っている（論点 {topic_id} に紐づかない）: {q['text'][:40]}…"
            )
        seen.append(squeeze(q["text"]))
        st, _, _ = c.call("POST", f"/sessions/{sid}/answer", {"idx": q["idx"], "answer": "ア"})
        if st != 200:
            r.error(f"出題の範囲の検査: {i + 1} 問目の回答が {st}")
            break
    dupes = [t for t in set(seen) if seen.count(t) > 1]
    if dupes:
        r.error(f"1回の出題に同じ内容の問題が2度出ている {len(dupes)} 件: {dupes[0][:40]}…")
    c.call("DELETE", "/sessions/current")

    # 出題できる過去問が1問も無い範囲は 400 で、セッションを作らない
    st, data, _ = c.call("POST", "/sessions", {"kind": "field", "field": "そんな分野は無い"})
    if r.status("POST /sessions（出題できる過去問が無い範囲）", st, 400, data):
        r.error_body("出題できる過去問が無い範囲の本文", data)
    st, cur, _ = c.call("GET", "/sessions/current")
    if r.status("GET /sessions/current（作られていないこと）", st, 200) and (cur or {}).get("session"):
        r.error("出題できない範囲を指定したのにセッションが作られている")
        c.call("DELETE", "/sessions/current")
    r.notes.append(
        f"出題の範囲: 論点 {topic_id} の {len(seen)} 問がその論点の過去問だけ・同じ内容の重複なしを確認"
    )


# @verifies REQ-212, REQ-240
def check_mock_by_exam(c: Client, r: Report, got: dict, exam: str):
    """公開回の通し受験。その回の過去問だけを問番号の昇順で、同一内容も畳まずに出す。"""
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    if _target(exam).get("roadmap"):
        r.notes.append("通し受験の検査: ロードマップ型には公開回の通し受験が無いので見ない")
        return
    exams = (got.get("/exams") or {}).get("exams") or []
    if not exams:
        r.error("通し受験の検査: /exams が空で確かめられない")
        return
    e = exams[0]

    c.call("DELETE", "/sessions/current")
    st, created, text = c.call("POST", "/sessions", {"kind": "mock", "exam": e["exam"]})
    if not r.status(f"POST /sessions（{e['exam']} の通し受験）", st, 201, None if st == 201 else text[:200]):
        return
    sid = created["id"]
    # 畳まないので、その回の過去問の件数がそのまま出る
    if created.get("questionCount") != e["questions"]:
        r.error(
            f"通し受験の問題数が {created.get('questionCount')}（{e['exam']} の過去問 {e['questions']} 問のはず。"
            "同一内容を畳んでいる）"
        )
    numbers: list[int] = []
    for i in range(2):
        st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
        if st != 200 or not (cur or {}).get("question"):
            r.error(f"通し受験の {i + 1} 問目が取れない（status {st}）")
            break
        q = cur["question"]
        if e["examLabel"] not in q["citation"]:
            r.error(f"通し受験に別の回の過去問が入っている: {q['citation']}")
        if (cur.get("session") or {}).get("sourceExam") != e["exam"]:
            r.error("通し受験のセッションが sourceExam にその回を返さない（画面が原本どおりと判別できない）")
        m = re.search(r"問(\d+)", q["citation"])
        if m:
            numbers.append(int(m.group(1)))
        c.call("POST", f"/sessions/{sid}/answer", {"idx": q["idx"], "answer": "ア"})
    if len(numbers) == 2 and numbers[0] >= numbers[1]:
        r.error(f"通し受験が問番号の昇順でない: 問{numbers[0]} → 問{numbers[1]}")
    c.call("DELETE", "/sessions/current")
    r.notes.append(
        f"通し受験: {e['exam']} を {created.get('questionCount')} 問・問番号の昇順で作成（破棄済み）"
    )


# @verifies REQ-226, REQ-231
def check_discard(c: Client, r: Report, got: dict, exam: str, db_name: str):
    """完了していないセッションの結果は 404（未回答の正解と解説が読めてしまう）。
    破棄すると進行中もその回答も残らず履歴にも出ない。進行中が無くても破棄は成功する。"""
    detail = got.get("topic_detail")
    if not detail:
        r.error("破棄の検査: 出題できる論点が取れなかったので検査できない")
        return
    topic_id = detail["topic"]["id"]

    c.call("DELETE", "/sessions/current")
    st, created, text = c.call("POST", "/sessions", {"kind": "drill", "topicId": topic_id, "size": 2})
    if not r.status("POST /sessions（破棄の検査）", st, 201, None if st == 201 else text[:200]):
        return
    sid = created["id"]
    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if st == 200 and (cur or {}).get("question"):
        c.call("POST", f"/sessions/{sid}/answer", {"idx": cur["question"]["idx"], "answer": "ア"})

    # 完了していない結果は 404（本文に正解も解説も出さない）
    st, data, text = c.call("GET", f"/sessions/{sid}")
    if r.status("GET /sessions/:id（完了していない結果）", st, 404, data):
        r.error_body("完了していない結果の本文", data)
    if '"answer"' in text or '"explanation"' in text:
        r.error("完了していないセッションの結果の本文に正解か解説が入っている")

    # 破棄
    st, _, _ = c.call("DELETE", "/sessions/current")
    r.status("DELETE /sessions/current", st, 200)
    st, cur, _ = c.call("GET", "/sessions/current")
    if r.status("GET /sessions/current（破棄後）", st, 200) and (cur or {}).get("session"):
        r.error("破棄したのに進行中のセッションが残っている")
    st, hist, _ = c.call("GET", "/sessions")
    if st == 200 and any(s["id"] == sid for s in (hist.get("sessions") or [])):
        r.error("破棄したセッションが履歴 /sessions に出ている")
    try:
        rows = d1(exam, db_name, f"SELECT COUNT(*) AS n FROM session_questions WHERE session_id = '{sid}'")
        if rows and rows[0]["n"]:
            r.error(f"破棄したセッションの回答が {rows[0]['n']} 件残っている（セッションと一緒に消すこと）")
    except Exception as ex:  # 列名が変わった等。破棄そのものは上で見ている
        r.warn(f"破棄したセッションの回答を D1 で数えられなかった: {str(ex)[:80]}")

    # 進行中が無くても成功する
    st, _, _ = c.call("DELETE", "/sessions/current")
    r.status("DELETE /sessions/current（進行中なし）", st, 200)
    r.notes.append("完了していない結果は 404・破棄で回答ごと消える・進行中が無くても破棄は 200 を確認")


# @verifies REQ-214, REQ-223, REQ-224
def check_time_limit(c: Client, r: Report, exam: str, db_name: str):
    """制限時間の境目。検査用アカウント自身が作った模試の開始時刻を epoch（0）に書き換えて、
    残り秒・時間切れの回答 409・結果の時間切れを見る。書き換えるのはこのセッションの行だけ。"""
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    if _target(exam).get("roadmap"):
        r.notes.append("制限時間の検査: ロードマップ型の確認テストに制限時間が無いので見ない")
        return

    c.call("DELETE", "/sessions/current")
    st, created, text = c.call("POST", "/sessions", {"kind": "mock"})
    if not r.status("POST /sessions（制限時間の検査）", st, 201, None if st == 201 else text[:200]):
        return
    sid = created["id"]
    limit = created.get("timeLimitSec")
    if not limit:
        r.error("模試に制限時間が付いていないので制限時間の検査ができない")
        c.call("DELETE", "/sessions/current")
        return

    # 制限時間内: 残り秒は 0 より大きく、制限時間以下
    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if r.status("GET /sessions/:id/current（制限時間内）", st, 200):
        left = (cur or {}).get("remainingSec")
        if not isinstance(left, int) or not 0 < left <= limit:
            r.error(f"制限時間内の残り秒が {left}（0 より大きく {limit} 以下のはず）")

    try:
        d1(exam, db_name, f"UPDATE sessions SET started_at = 0 WHERE id = '{sid}'")
    except Exception as ex:  # 列名が変わった等
        r.warn(f"制限時間の検査: 開始時刻を書き換えられず時間切れを見られなかった: {str(ex)[:80]}")
        c.call("DELETE", "/sessions/current")
        return

    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if r.status("GET /sessions/:id/current（制限時間切れ）", st, 200):
        if (cur or {}).get("question") is not None:
            r.error("制限時間を過ぎても問題を返している（未回答の問題が読めてしまう）")
        if not (cur or {}).get("finished") or not (cur or {}).get("expired"):
            r.error(
                "制限時間を過ぎたのに終了・時間切れが立たない: "
                + json.dumps(cur, ensure_ascii=False)[:120]
            )
        if (cur or {}).get("remainingSec") not in (0, None):
            r.error(f"制限時間を過ぎた残り秒が {(cur or {}).get('remainingSec')}（0 のはず）")

    st, data, _ = c.call("POST", f"/sessions/{sid}/answer", {"idx": 0, "answer": "ア"})
    if r.status("時間切れのセッションへの回答", st, 409, data):
        r.error_body("時間切れの回答の本文", data)
        if not (data or {}).get("expired"):
            r.warn("時間切れの 409 に expired が無い（画面が時間切れと判別できない）")

    st, _, _ = c.call("POST", f"/sessions/{sid}/finish")
    r.status("POST /sessions/:id/finish（時間切れ）", st, 200)
    st, res, _ = c.call("GET", f"/sessions/{sid}")
    if r.status("GET /sessions/:id（時間切れの結果）", st, 200):
        if not (res or {}).get("expired"):
            r.error("制限時間を過ぎて締めた回の結果が時間切れになっていない")
    r.notes.append("制限時間: 残り秒・時間切れの回答 409・結果の時間切れを確認")


# @verifies REQ-041
def check_exam_attempts(c: Client, r: Report, got: dict, exam: str, other_token: str):
    """/exams の受験回数・最高正答数は、自分の完了したセッションだけを数える
    （他人の受験も、進行中のセッションも数えない）。"""
    exams = (got.get("/exams") or {}).get("exams") or []
    if not exams:
        r.error("受験回数の検査: /exams が空で確かめられない")
        return

    st, other, _ = c.call("GET", "/exams", token=other_token)
    if r.status("GET /exams（まだ受験していないアカウント）", st, 200):
        bad = [
            x["exam"] for x in (other.get("exams") or []) if x["attempts"] or x["bestScore"] is not None
        ]
        if bad:
            r.error(
                f"受験していないアカウントに受験回数・最高正答数が出ている {len(bad)} 回: {bad[:3]}"
                "（他人の受験を数えている）"
            )

    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    if _target(exam).get("roadmap"):
        return
    e = exams[0]
    c.call("DELETE", "/sessions/current")
    st, created, _ = c.call("POST", "/sessions", {"kind": "mock", "exam": e["exam"]})
    if st == 201:
        st, data, _ = c.call("GET", "/exams")
        if r.status("GET /exams（進行中の模試あり）", st, 200):
            now = next((x["attempts"] for x in (data.get("exams") or []) if x["exam"] == e["exam"]), None)
            if now != e["attempts"]:
                r.error(
                    f"/exams の受験回数が進行中のセッションを数えている（{e['exam']}: {e['attempts']} → {now}）"
                )
        c.call("DELETE", "/sessions/current")
    r.notes.append("/exams の受験回数: 他人の分と進行中を数えないことを確認")


# @verifies REQ-035
def check_security_headers(c: Client, r: Report):
    """全応答に secureHeaders が載っているか（CSP・HSTS・X-Frame-Options DENY・nosniff・Referrer-Policy）。"""
    want = {
        "content-security-policy": None,
        "strict-transport-security": None,
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": None,
    }
    for label, path, token in [("GET /health", "/health", None), ("GET /fields", "/fields", "self")]:
        st, _, _ = c.call("GET", path, token=token)
        if st == 0:
            r.error(f"{label}: 応答が無くヘッダを見られない")
            continue
        headers = c.last_headers
        for name, value in want.items():
            if name not in headers:
                r.error(f"{label}: ヘッダ {name} が無い（secureHeaders が外れている）")
            elif value is not None and headers[name] != value:
                r.error(f"{label}: ヘッダ {name} が {headers[name]!r}（{value!r} のはず）")
    r.notes.append("セキュリティヘッダ: CSP・HSTS・X-Frame-Options DENY・nosniff・Referrer-Policy を確認")


# @verifies REQ-030, REQ-274, REQ-275
def check_feedback(c: Client, r: Report, exam: str, db_name: str):
    """フィードバック（要件 §5.5-4）。送信が保存されること、開発側の読み口（feedback 表）に届くこと、
    拒んだ送信と上限を超えた送信が保存されないこと。
    利用者向けの一覧 API は無いので、保存の確認はローカル D1 を直接読む。検査で入れた行は消す。"""
    # 前の検査が途中で落ちていると日次の上限を食っているので、検査用の行を先に片付ける
    d1(exam, db_name, "DELETE FROM feedback WHERE body LIKE 'apicheck %'")

    marker = f"apicheck {uuid.uuid4()}"
    st, data, text = c.call("POST", "/feedback", {"body": marker, "page": "/topics/1", "topicId": 1})
    if not r.status("POST /feedback", st, 201, None if st == 201 else text[:200]):
        return
    fid = (data or {}).get("id")
    if not isinstance(fid, str) or not fid:
        r.error("POST /feedback: 本文に id（文字列）が無い")
        return
    rows = d1(exam, db_name, f"SELECT body, status, page, topic_id FROM feedback WHERE id = '{fid}'")
    if not rows:
        r.error("POST /feedback: 201 が返ったのに feedback 表に行が無い")
    else:
        row = rows[0]
        if row.get("body") != marker: r.error(f"feedback.body が送った本文と違う: {row.get('body')!r}")
        if row.get("status") != "new": r.error(f"feedback.status の初期値が new でない: {row.get('status')!r}")
        if row.get("topic_id") != 1 or row.get("page") != "/topics/1": r.error("feedback の page / topic_id が送った値と違う")
        r.notes.append("フィードバック: 送信 → feedback 表に保存（status=new）を確認")
    d1(exam, db_name, f"DELETE FROM feedback WHERE id = '{fid}'")

    # 拒んだ送信は保存されない（本文が空・2,000 字超）
    def count_rows(where: str) -> int:
        return d1(exam, db_name, f"SELECT COUNT(*) AS n FROM feedback WHERE {where}")[0]["n"]

    before = count_rows("1 = 1")
    for label, payload in [("本文が空", {"body": "   "}), ("2,001 字", {"body": "あ" * 2001})]:
        st, data, _ = c.call("POST", "/feedback", payload)
        if r.status(f"POST /feedback（{label}）", st, 400, data):
            r.error_body(f"POST /feedback（{label}）の本文", data)
    after = count_rows("1 = 1")
    if after != before:
        r.error(f"POST /feedback: 400 で拒んだのに行が {after - before} 件増えた")

    # 日次の上限（20 件）を超えた送信は 429 で、保存されない
    limit = 20
    statuses = []
    for i in range(limit + 1):
        st, _, _ = c.call("POST", "/feedback", {"body": f"apicheck limit {i}"})
        statuses.append(st)
    if statuses[:limit] != [201] * limit:
        r.error(f"POST /feedback: 上限までの {limit} 件が通らない（返った status: {statuses[:limit]}）")
    if statuses[limit] != 429:
        r.error(f"POST /feedback: {limit + 1} 件目が {statuses[limit]} を返した（429 のはず）")
    n_saved = count_rows("body LIKE 'apicheck limit %'")
    if n_saved != limit:
        r.error(f"日次上限: 保存された行が {n_saved} 件（{limit} 件のはず。429 の分は保存しないこと）")
    else:
        r.notes.append(f"フィードバック: 入力の 400 と日次上限 {limit} 件の 429（どちらも保存なし）を確認")
    d1(exam, db_name, "DELETE FROM feedback WHERE body LIKE 'apicheck %'")


# --------------------------------------------------------------------------
# UC の基本の流れの写し（scenario）
#
# 1 UC につき 1 本。docs/usecases/UC-xxx.md の「基本の流れ」の番号付きステップを順に
# 1 操作か 1 応答ずつ写し、最後に「事後条件」を見る。正常系だけを通す（例外の流れ・境目は
# 上の check_* が見る）。画面の操作と描画は API では踏めないので、画面が使う応答まで。
# --------------------------------------------------------------------------


def first_choice(question: dict) -> str:
    """選択肢の記号を 1 つ選ぶ（正解は分からないので記号の順で先頭を選ぶ）。"""
    return sorted(question["choices"])[0]


# @scenario UC-004
def check_scenario_uc007(c: Client, r: Report, got: dict):
    """練習テストの画面を開く → 範囲を選んで開始 → 出題 → 回答して解説 → 次の問題 → 締め → 結果。"""
    L = "UC-007"
    detail = got.get("topic_detail")
    if not detail:
        r.error(f"{L}: 出題できる論点が取れなかったので基本の流れを通せない")
        return
    topic_id = detail["topic"]["id"]

    # 1. 練習テストの画面を開く（演習の範囲＝分野と、分野を選んだあとの単元、進行中の有無）
    st, fields, _ = c.call("GET", "/fields")
    if not r.status(f"{L} 1 分野の一覧", st, 200):
        return
    rows = (fields or {}).get("fields")
    if not isinstance(rows, list) or not rows:
        r.error(f"{L} 1: 分野の一覧が空で範囲を選べない")
        return
    field = rows[0]["field"]
    st, cats, _ = c.call("GET", f"/categories?field={field}")
    if r.status(f"{L} 1 分野『{field}』の単元の一覧", st, 200):
        if not isinstance((cats or {}).get("categories"), list):
            r.error(f"{L} 1: 単元（カテゴリ）の一覧が配列で返らない")
    c.call("DELETE", "/sessions/current")  # 前の検査が残した進行中を片付ける
    st, cur, _ = c.call("GET", "/sessions/current")
    if r.status(f"{L} 1 進行中のテストの有無", st, 200) and "session" not in (cur or {}):
        r.error(f"{L} 1: 進行中の有無（session）が返らない")

    # 2. 範囲（論点別）を選んで開始する
    size = min(3, len(detail["questions"]))
    if size < 2:
        r.error(f"{L}: 出題できる過去問が 1 問しかない論点なので、次の問題まで通せない")
        return
    st, created, text = c.call(
        "POST", "/sessions", {"kind": "drill", "topicId": topic_id, "size": size}
    )
    if not r.status(f"{L} 2 論点別の演習を開始", st, 201, None if st == 201 else text[:200]):
        return

    # 3. セッションを作って ID・範囲の名前・問題数を返す
    sid, total = (created or {}).get("id"), (created or {}).get("questionCount")
    if not sid or not isinstance(total, int) or not 0 < total <= size:
        r.error(f"{L} 3: ID と問題数が返らない（{json.dumps(created, ensure_ascii=False)[:120]}）")
        return
    if not (created or {}).get("scopeLabel"):
        r.error(f"{L} 3: 範囲の名前（scopeLabel）が返らない")

    # 4. 未回答の最小 index の問題を、出題時の内容（正解と解説を除く）で返す
    st, cur, text = c.call("GET", f"/sessions/{sid}/current")
    if not r.status(f"{L} 4 現在の問題", st, 200, None if st == 200 else text[:200]):
        return
    q = (cur or {}).get("question") or {}
    if q.get("idx") != 0:
        r.error(f"{L} 4: 現在の問題の index が {q.get('idx')}（未回答の最小は 0）")
    if '"answer"' in text or '"explanation"' in text:
        r.error(f"{L} 4: 出題中の応答に正解か解説が入っている（回答したあとに渡すこと）")

    # 5. 画面が出す材料（問題文・選択肢・進捗）が応答にある
    if not q.get("text") or not isinstance(q.get("choices"), dict) or not q.get("choices"):
        r.error(f"{L} 5: 問題文か選択肢が無い")
        return
    if cur.get("answered") != 0 or (cur.get("session") or {}).get("questionCount") != total:
        r.error(
            f"{L} 5: 進捗が合わない（回答済み {cur.get('answered')} / "
            f"全体 {(cur.get('session') or {}).get('questionCount')}。0 / {total} のはず）"
        )

    # 6. 選択肢を 1 つ選び、表示中の位置を添えて回答を送る
    picked = first_choice(q)
    st, ans, text = c.call("POST", f"/sessions/{sid}/answer", {"idx": q["idx"], "answer": picked})
    if not r.status(f"{L} 6 回答を送る", st, 200, None if st == 200 else text[:200]):
        return

    # 7. 出題時の正解と比べた正誤と、問題ごとの解説を返す
    ans = ans if isinstance(ans, dict) else {}
    if not isinstance(ans.get("correct"), bool) or not ans.get("correctAnswer"):
        r.error(f"{L} 7: 正誤か正解の記号が返らない")
    elif ans["correct"] != (picked == ans["correctAnswer"]):
        r.error(
            f"{L} 7: 正誤が正解との突き合わせと合わない"
            f"（選んだ {picked} / 正解 {ans['correctAnswer']} / correct {ans['correct']}）"
        )
    if "explanation" not in (ans or {}):
        r.error(f"{L} 7: 問題ごとの解説（explanation）が応答に無い")
    if ans.get("remaining") != total - 1:
        r.error(f"{L} 7: 残りの問数が {ans.get('remaining')}（{total - 1} のはず）")

    # 8.「次の問題へ」で 4 に戻る（次の未回答の最小 index）
    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if r.status(f"{L} 8 次の問題", st, 200):
        if ((cur or {}).get("question") or {}).get("idx") != 1:
            r.error(f"{L} 8: 次の問題の index が {((cur or {}).get('question') or {}).get('idx')}（1 のはず）")

    # 9. 未回答が無くなると締めが呼ばれ、正答数を集計してセッションを完了にする
    for _ in range(total + 1):
        st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
        if st != 200:
            r.error(f"{L} 9: 現在の問題が取れない（status {st}）")
            return
        q = (cur or {}).get("question")
        if not q:
            break
        st, ans, text = c.call(
            "POST", f"/sessions/{sid}/answer", {"idx": q["idx"], "answer": first_choice(q)}
        )
        if not r.status(f"{L} 9 残りの回答", st, 200, None if st == 200 else text[:200]):
            return
    st, fin, text = c.call("POST", f"/sessions/{sid}/finish")
    if not r.status(f"{L} 9 締める", st, 200, None if st == 200 else text[:200]):
        return
    fin = fin if isinstance(fin, dict) else {}
    if fin.get("total") != total:
        r.error(f"{L} 9: 締めの total が {fin.get('total')}（{total} のはず）")

    # 事後条件: セッションが完了になり、正答数と 1 問ごとの正誤・選んだ選択肢が残る
    st, res, text = c.call("GET", f"/sessions/{sid}")
    if not r.status(f"{L} 事後条件 結果", st, 200, None if st == 200 else text[:200]):
        return
    if not isinstance(res, dict):
        r.error(f"{L} 事後条件: 結果の本文が JSON のオブジェクトでない")
        return
    if (res.get("overall") or {}).get("total") != total:
        r.error(f"{L} 事後条件: 結果の総数が {(res.get('overall') or {}).get('total')}（{total} のはず）")
    if (res.get("overall") or {}).get("correct") != fin.get("correct"):
        r.error(
            f"{L} 事後条件: 結果の正答数 {(res.get('overall') or {}).get('correct')} と"
            f"締めの正答数 {fin.get('correct')} が違う"
        )
    items = res.get("items") or []
    if len(items) != total:
        r.error(f"{L} 事後条件: 1 問ごとの記録が {len(items)} 件（{total} 件のはず）")
    lost = [x.get("idx") for x in items if x.get("userAnswer") is None or x.get("result") is None]
    if lost:
        r.error(f"{L} 事後条件: 選んだ選択肢か正誤が残っていない問題がある（idx {lost[:3]}）")
    r.notes.append(f"{L} の基本の流れ: 範囲の一覧 → 開始 → 出題 → 回答と解説 → 次の問題 → 締め → 結果（{total} 問）")


# @scenario UC-008
def check_scenario_uc008(c: Client, r: Report, got: dict, exam: str, db_name: str):
    """模擬試験の画面を開く → 公開回を選んで開始 → 出題 → 残り 0 で締め → 合否の目安と分野別の結果。"""
    L = "UC-008"
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    if _target(exam).get("roadmap"):
        r.notes.append(f"{L}: ロードマップ型には公開回の模擬試験が無いので基本の流れは見ない（未検査）")
        return

    # 1. 利用者が模擬試験の画面を開く。サーバは回ごとの問題数・自分の受験回数・最高正答数を返す
    st, data, _ = c.call("GET", "/exams")
    if not r.status(f"{L} 1 回ごとの一覧", st, 200):
        return
    exams = (data or {}).get("exams") or []
    if not exams:
        r.error(f"{L} 1: 回の一覧が空で受験できない")
        return
    before = exams[0]
    for key in ("questions", "attempts"):
        if not isinstance(before.get(key), int):
            r.error(f"{L} 1: 回の行に {key} が無い")
    if "bestScore" not in before:
        r.error(f"{L} 1: 回の行に最高正答数（bestScore）が無い")

    # 2. 画面は公開回の一覧とランダム構成の入口を出す（画面）
    # 3. 利用者が受験を開始する。画面は制限時間が始まることを確認する（画面）
    # 4. サーバは、その試験の設定値の問題数と制限時間でセッションを作る
    c.call("DELETE", "/sessions/current")
    st, created, text = c.call("POST", "/sessions", {"kind": "mock", "exam": before["exam"]})
    if not r.status(f"{L} 4 {before['exam']} の受験を開始", st, 201, None if st == 201 else text[:200]):
        return
    sid = (created or {}).get("id")
    limit = (created or {}).get("timeLimitSec")
    if not sid or not isinstance(limit, int) or limit <= 0:
        r.error(f"{L} 4: 制限時間つきのセッションになっていない（{json.dumps(created, ensure_ascii=False)[:120]}）")
        c.call("DELETE", "/sessions/current")
        return
    if created.get("questionCount") != before["questions"]:
        r.error(
            f"{L} 4: 出題が {created.get('questionCount')} 問"
            f"（{before['exam']} の過去問 {before['questions']} 問のはず）"
        )

    # 5. 利用者が公開回を選んだとき、サーバはその回の過去問だけを問番号の昇順で出題する
    # 6. ランダム構成（分野比率に寄せた設定値の問題数・並びを毎回同じにしない）は REQ の検査が見る
    # 7. 画面は残り時間を数えながら出題し、1 問ごとの正誤と解説は出さずに次の問題へ送る
    numbers: list[int] = []
    for i in range(2):
        st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
        if st != 200 or not (cur or {}).get("question"):
            r.error(f"{L} 7: {i + 1} 問目が取れない（status {st}）")
            c.call("DELETE", "/sessions/current")
            return
        left = cur.get("remainingSec")
        if not isinstance(left, int) or not 0 < left <= limit:
            r.error(f"{L} 7: 残り秒が {left}（0 より大きく {limit} 以下のはず）")
        q = cur["question"]
        if before["examLabel"] not in q["citation"]:
            r.error(f"{L} 5: 別の回の過去問が出ている（{q['citation']}）")
        m = re.search(r"問(\d+)", q["citation"])
        if m:
            numbers.append(int(m.group(1)))
        st, _, _ = c.call("POST", f"/sessions/{sid}/answer", {"idx": q["idx"], "answer": first_choice(q)})
        if st != 200:
            r.error(f"{L} 7: {i + 1} 問目の回答が {st}")
            c.call("DELETE", "/sessions/current")
            return
    if len(numbers) == 2 and numbers[0] >= numbers[1]:
        r.error(f"{L} 5: 公開回が問番号の昇順でない（問{numbers[0]} → 問{numbers[1]}）")

    # 8. 残り時間が 0 になると、画面は自動で締める（時間の経過は待てないので開始時刻を epoch に戻す）
    try:
        d1(exam, db_name, f"UPDATE sessions SET started_at = 0 WHERE id = '{sid}'")
    except Exception as ex:
        r.warn(f"{L} 8: 開始時刻を書き換えられず、残り 0 の締めを見られなかった: {str(ex)[:80]}")
        c.call("DELETE", "/sessions/current")
        return
    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if r.status(f"{L} 8 残り時間が 0", st, 200):
        if (cur or {}).get("remainingSec") not in (0, None):
            r.error(f"{L} 8: 残り秒が {(cur or {}).get('remainingSec')}（0 のはず）")
        if not (cur or {}).get("finished"):
            r.error(f"{L} 8: 残り 0 なのに終了として返らない")
    st, _, text = c.call("POST", f"/sessions/{sid}/finish")
    if not r.status(f"{L} 8 締める", st, 200, None if st == 200 else text[:200]):
        return

    # 9. サーバは総合と分野別の正答率を集計し、合否の目安と、公式スコアと一致しない旨を返す
    st, res, text = c.call("GET", f"/sessions/{sid}", None)
    if not r.status(f"{L} 9 結果", st, 200, None if st == 200 else text[:200]):
        return
    if not isinstance(res, dict):
        r.error(f"{L} 9: 結果の本文が JSON のオブジェクトでない")
        return
    r.shape(f"{L} 9 結果", res, RESULT)
    overall = res.get("overall") or {}
    fields = res.get("fields") or []
    by_field = sum((f.get("correct") or 0) for f in fields)
    if by_field != overall.get("correct"):
        r.error(
            f"{L} 9: 分野別の正答数の合計 {by_field} が総合の正答数 {overall.get('correct')} と合わない"
        )
    if not isinstance(res.get("passed"), bool):
        r.error(f"{L} 9: 合否の目安（passed）が真偽値で返らない")
    if not (res.get("criteria") or {}).get("overallPct"):
        r.error(f"{L} 9: 合格の目安の基準（criteria）が返らない")
    if not res.get("approximation"):
        r.error(f"{L} 9: 公式スコアと一致しない旨（approximation）が返らない")

    # 10. 画面は合否の目安・分野別の正答率・断り書きを出す（9 の応答で描く。描画は check_render.tsx）
    # 11. 画面は間違えた問題を一覧し、問題ごとの解説とその論点への導線を出す（その材料）
    items = res.get("items") or []
    if len(items) != created["questionCount"]:
        r.error(f"{L} 11: 1 問ごとの記録が {len(items)} 件（{created['questionCount']} 件のはず）")
    for key in ("result", "userAnswer", "answer", "explanation", "topicId"):
        if items and key not in items[0]:
            r.error(f"{L} 11: 1 問ごとの記録に {key} が無い（誤答の一覧と論点への導線が出せない）")

    # 事後条件: 履歴と結果から見返せる。回ごとの受験回数と最高正答数が一覧に反映される
    st, hist, _ = c.call("GET", "/sessions")
    if r.status(f"{L} 事後条件 履歴", st, 200):
        if not any(s["id"] == sid for s in ((hist or {}).get("sessions") or [])):
            r.error(f"{L} 事後条件: 受験したセッションが履歴に出てこない")
    st, data, _ = c.call("GET", "/exams")
    if r.status(f"{L} 事後条件 回ごとの一覧", st, 200):
        after = next((x for x in (data or {}).get("exams") or [] if x["exam"] == before["exam"]), None)
        if not after:
            r.error(f"{L} 事後条件: {before['exam']} が回の一覧から消えた")
        else:
            if after.get("attempts") != (before.get("attempts") or 0) + 1:
                r.error(
                    f"{L} 事後条件: 受験回数が {before.get('attempts')} → {after.get('attempts')}"
                    f"（1 増えるはず）"
                )
            if after.get("bestScore") is None:
                r.error(f"{L} 事後条件: 受験したのに最高正答数が空のまま")
    r.notes.append(
        f"{L} の基本の流れ: 回の一覧 → {before['exam']} を {created['questionCount']} 問で開始 → "
        "出題（残り時間つき） → 残り 0 で締め → 合否の目安と分野別の結果 → 履歴と受験回数"
    )


# @scenario UC-006
# @scenario UC-007
def check_scenario_uc009(c: Client, r: Report, got: dict, exam: str, db_name: str):
    """中断 → ホームの案内と進行中の知らせ → 再開 → 破棄 → 履歴の一覧と結果。"""
    L = "UC-009"
    detail = got.get("topic_detail")
    if not detail:
        r.error(f"{L}: 出題できる論点が取れなかったので基本の流れを通せない")
        return
    topic_id = detail["topic"]["id"]

    # 前提: 進行中のテストを 1 つ作り、1 問だけ答えて回答の途中にする
    c.call("DELETE", "/sessions/current")
    size = min(3, len(detail["questions"]))
    if size < 2:
        r.error(f"{L}: 出題できる過去問が 1 問しかない論点なので、再開の続きを見られない")
        return
    st, created, text = c.call(
        "POST", "/sessions", {"kind": "drill", "topicId": topic_id, "size": size}
    )
    if not r.status(f"{L} の前提 演習を開始", st, 201, None if st == 201 else text[:200]):
        return
    sid = created["id"]
    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if st != 200 or not (cur or {}).get("question"):
        r.error(f"{L} の前提: 1 問目が取れない（status {st}）")
        return
    st, _, _ = c.call(
        "POST", f"/sessions/{sid}/answer",
        {"idx": cur["question"]["idx"], "answer": first_choice(cur["question"])},
    )
    if not r.status(f"{L} の前提 1 問だけ答える", st, 200):
        return

    # 1. 利用者が回答の途中で「中断してホームへ」を押す。画面はそこまでの回答を残したまま出題を離れる
    #    （画面の操作。API は呼ばず、そこまでの回答は残る）
    # 2. 利用者がホームを開く。画面は進行中のテストがあればその案内を出し、再開の画面へ進める
    # 3. 利用者が練習テストの画面を開く。サーバは進行中のセッションと回答済みの問数を返す
    #    （2 の案内も 3 と同じ進行中の有無から出るので、ここで両方の材料を見る）
    st, data, _ = c.call("GET", "/sessions/current")
    if not r.status(f"{L} 2・3 進行中のセッション", st, 200):
        return
    session = (data or {}).get("session") or {}
    if session.get("id") != sid:
        r.error(f"{L} 3: 進行中のセッションが中断したものでない（{session.get('id')}）")
    if session.get("answered") != 1:
        r.error(f"{L} 1・3: 回答済みの問数が {session.get('answered')}（中断しても残るので 1 のはず）")

    # 4. 画面は進行中のテストと回答済みの問数を知らせ、「再開する」で出題の画面へ戻す
    #    （続きは未回答の最小 index から出る）
    st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
    if r.status(f"{L} 4 再開", st, 200):
        if ((cur or {}).get("question") or {}).get("idx") != 1:
            r.error(
                f"{L} 4: 再開後の index が {((cur or {}).get('question') or {}).get('idx')}"
                "（未回答の最小の 1 のはず）"
            )

    # 5. 利用者が「破棄する」を押す。画面は回答済みの問数を示して確認する（画面）
    # 6. サーバは進行中のセッションを消す（そのセッションの回答も一緒に消える）
    st, _, _ = c.call("DELETE", "/sessions/current")
    r.status(f"{L} 6 破棄", st, 200)
    st, cur, _ = c.call("GET", "/sessions/current")
    if r.status(f"{L} 6 破棄後の進行中", st, 200) and (cur or {}).get("session"):
        r.error(f"{L} 6: 破棄したのに進行中のセッションが残っている")
    try:
        rows = d1(exam, db_name, f"SELECT COUNT(*) AS n FROM session_questions WHERE session_id = '{sid}'")
        if rows and rows[0]["n"]:
            r.error(f"{L} 6: 破棄したセッションの回答が {rows[0]['n']} 件残っている")
    except Exception as ex:
        r.warn(f"{L} 6: 破棄したセッションの回答を D1 で数えられなかった: {str(ex)[:80]}")

    # 7. 利用者が履歴の画面を開く。サーバは自分の完了したセッションだけを新しい順に返す
    st, hist, _ = c.call("GET", "/sessions")
    if not r.status(f"{L} 7 履歴", st, 200):
        return
    rows = (hist or {}).get("sessions")
    if not isinstance(rows, list):
        r.error(f"{L} 7: 履歴が配列で返らない")
        return
    if any(s["id"] == sid for s in rows):
        r.error(f"{L} 7: 破棄したセッションが履歴に出ている")
    unfinished = [s["id"] for s in rows if s.get("finishedAt") is None]
    if unfinished:
        r.error(f"{L} 7: 完了していないセッションが履歴に出ている {unfinished[:3]}")
    times = [s["finishedAt"] for s in rows if s.get("finishedAt") is not None]
    back = [i for i in range(1, len(times)) if times[i] > times[i - 1]]
    if back:
        r.error(f"{L} 7: 履歴が新しい順でない（{back[:3]} 件目で新しくなる）")

    # 8. 画面は種別・範囲・正答率・日時を一覧し、結果の画面へ進める
    if not rows:
        r.error(f"{L} 8: 完了したセッションが 1 件も無く、一覧と結果への導線を確かめられない")
    else:
        row = rows[0]
        for key in ("kind", "scopeLabel", "questionCount", "correctCount", "finishedAt"):
            if key not in row:
                r.error(f"{L} 8: 履歴の行に {key} が無い（種別・範囲・正答率・日時が出せない）")
        st, _, text = c.call("GET", f"/sessions/{row['id']}")
        r.status(f"{L} 8 履歴から結果へ", st, 200, None if st == 200 else text[:200])

    # 事後条件: 破棄したセッションは進行中として残らず、履歴にも出ない（6・7）。
    #           再開は未回答の最小 index から（4）
    st, cur, _ = c.call("GET", "/sessions/current")
    if r.status(f"{L} 事後条件 破棄後の進行中の有無", st, 200):
        if "session" not in (cur or {}):
            r.error(f"{L} 事後条件: 進行中の有無（session）が返らない")
        elif cur["session"] is not None:
            r.error(f"{L} 事後条件: 破棄したのに進行中のテストがある（案内が出てしまう）")
    r.notes.append(
        f"{L} の基本の流れ: 中断 → ホームの案内と進行中の知らせ → 再開 → 破棄 → 履歴と結果"
    )


# 横断の決まり（BR-028 同一内容）の検査。UC のシナリオではないので @scenario は付けない
def check_scenario_uc011(c: Client, r: Report, got: dict, exam: str, db_name: str):
    """同一内容の過去問を全問残したまま、学習側の出題では 1 問にまとめ、公開回の通し受験では畳まない。"""
    L = "UC-011"
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target
    roadmap = bool(_target(exam).get("roadmap"))

    # 1. 投入の前の門（同一内容で正解が割れていないか）は scripts/check_seed.py の担当
    # 2. 投入は同一内容を 1 問も畳まずに入れる
    rows = d1(
        exam, db_name,
        "SELECT COUNT(*) AS all_q,"
        " COUNT(DISTINCT CASE WHEN content_key IS NULL OR content_key = '' THEN NULL ELSE content_key END) AS uniq_keys,"
        " SUM(CASE WHEN content_key IS NULL OR content_key = '' THEN 1 ELSE 0 END) AS no_key"
        " FROM past_questions",
    )[0]
    folded_total = (rows["uniq_keys"] or 0) + (rows["no_key"] or 0)
    dup = d1(
        exam, db_name,
        "SELECT content_key AS k, COUNT(*) AS n FROM past_questions"
        " WHERE content_key IS NOT NULL AND content_key <> ''"
        " GROUP BY content_key HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 1",
    )
    if not dup:
        r.warn(f"{L}: この対象には同一内容の過去問の組が無いので、まとめる側（3・4）は成立しない（未検査）")
    elif rows["all_q"] <= folded_total:
        r.error(
            f"{L} 2: 過去問が {rows['all_q']} 件で、畳んだ件数 {folded_total} を上回らない"
            "（同一内容の組があるのに全問残っていない）"
        )

    # 3. 範囲を絞った演習では同一内容を 1 問にまとめる（代表に同一内容の件数が付く）
    topics = (got.get("/topics?limit=500") or {}).get("topics") or []
    detail = got.get("topic_detail")
    pick = detail if detail and any(q["timesAsked"] > 1 for q in (detail.get("questions") or [])) else None
    if pick is None:
        for t in [x for x in topics if x["questionCount"] > 1][:12]:
            st, data, _ = c.call("GET", f"/topics/{t['id']}")
            if st == 200 and isinstance(data, dict) and any(
                q["timesAsked"] > 1 for q in (data.get("questions") or [])
            ):
                pick = data
                break
    if dup and pick is None:
        r.warn(f"{L}: 見た論点の中に同一内容の代表が無く、まとめる側（3・4）は未検査")
    if pick:
        topic_id = pick["topic"]["id"]
        questions = pick["questions"]
        folded = [q for q in questions if q["timesAsked"] > 1]
        c.call("DELETE", "/sessions/current")
        st, created, text = c.call(
            "POST", "/sessions", {"kind": "drill", "topicId": topic_id, "size": min(len(questions), 100)}
        )
        if not r.status(f"{L} 3 論点 {topic_id} の演習を開始", st, 201, None if st == 201 else text[:200]):
            return
        if not isinstance(created, dict) or not created.get("id"):
            r.error(f"{L} 3: 作成の本文に id が無い")
            return
        sid = created["id"]
        seen: list[str] = []
        marks: dict[str, tuple[int, list]] = {}
        for i in range(created["questionCount"]):
            st, cur, _ = c.call("GET", f"/sessions/{sid}/current")
            if st != 200 or not (cur or {}).get("question"):
                r.error(f"{L} 3: {i + 1} 問目が取れない（status {st}）")
                break
            q = cur["question"]
            key = squeeze(q["text"])
            seen.append(key)
            marks[key] = (q["timesAsked"], q["otherCitations"])
            st, _, _ = c.call("POST", f"/sessions/{sid}/answer", {"idx": q["idx"], "answer": first_choice(q)})
            if st != 200:
                r.error(f"{L} 3: {i + 1} 問目の回答が {st}")
                break
        dupes = [t for t in set(seen) if seen.count(t) > 1]
        if dupes:
            r.error(f"{L} 3: 1 回の出題に同じ内容の問題が 2 度出ている {len(dupes)} 件: {dupes[0][:40]}…")

        # 4. 同じ内容が何回出題されたかと、代表以外の出典が問題に付く
        hit = next((squeeze(q["text"]) for q in folded if squeeze(q["text"]) in marks), None)
        if hit is None:
            r.warn(f"{L} 4: 同一内容の代表が今回の出題に入らず未検査")
        else:
            times, others = marks[hit]
            if times < 2:
                r.error(f"{L} 4: 代表の出題回数が {times}（同一内容の組なので 2 以上のはず）")
            elif len(others) != times - 1:
                r.error(
                    f"{L} 4: 代表以外の出典が {len(others)} 件"
                    f"（同じ内容が {times} 回なら {times - 1} 件のはず）"
                )
        c.call("DELETE", "/sessions/current")

    # 5. 公開回の通し受験は同一内容をまとめず、原本どおりに出す
    exams = (got.get("/exams") or {}).get("exams") or []
    if roadmap or not exams:
        r.warn(f"{L} 5: 公開回の通し受験が無い対象なので未検査")
    else:
        e = exams[0]
        c.call("DELETE", "/sessions/current")
        st, created, text = c.call("POST", "/sessions", {"kind": "mock", "exam": e["exam"]})
        if r.status(f"{L} 5 {e['exam']} の通し受験", st, 201, None if st == 201 else text[:200]):
            if (created or {}).get("questionCount") != e["questions"]:
                r.error(
                    f"{L} 5: 通し受験が {(created or {}).get('questionCount')} 問"
                    f"（原本どおりなら {e['questions']} 問）"
                )
        c.call("DELETE", "/sessions/current")

    r.notes.append(
        f"{L} の基本の流れ: 過去問 {rows['all_q']} 件（畳むと {folded_total} 件）を残したまま、"
        "演習は 1 問にまとめ・通し受験は原本どおり"
    )


# @scenario UC-010
def check_scenario_uc012(c: Client, r: Report, exam: str, db_name: str):
    """本文と直前に開いていた画面を送ると、未処理で保存され、受け付けた印だけが返る。"""
    L = "UC-012"
    # 1〜3. 直前に開いていた画面を端末に覚えるのと上部メニューは画面側（check_render.tsx）
    d1(exam, db_name, "DELETE FROM feedback WHERE body LIKE 'apicheck scenario %'")
    marker = f"apicheck scenario {uuid.uuid4()}"

    # 4. 本文（2,000 字以内）と、直前に開いていた画面（パス・論点 ID）を送信する
    st, data, text = c.call("POST", "/feedback", {"body": marker, "page": "/topics/1", "topicId": 1})
    if not r.status(f"{L} 4 フィードバックを送る", st, 201, None if st == 201 else text[:200]):
        return

    # 5. 本文と画面の情報を利用者に紐づけて保存し、受け付けた印を返す（その場で応答しない）
    fid = (data or {}).get("id")
    if not isinstance(fid, str) or not fid:
        r.error(f"{L} 5: 受け付けた印（id）が返らない")
        return
    said = [v for v in (data or {}).values() if isinstance(v, str) and JAPANESE.search(v)]
    if said:
        r.error(f"{L} 5: 応答に日本語の文が入っている（その場で応答しない。受付文は画面が出す）: {said[0][:40]}")
    rows = d1(exam, db_name, f"SELECT body, status, page, topic_id FROM feedback WHERE id = '{fid}'")
    if not rows:
        r.error(f"{L} 5: 201 が返ったのに feedback 表に行が無い")
    else:
        row = rows[0]
        if row.get("body") != marker:
            r.error(f"{L} 5: 保存された本文が送った本文と違う（{str(row.get('body'))[:40]}）")
        if row.get("page") != "/topics/1" or row.get("topic_id") != 1:
            r.error(f"{L} 5: 保存された画面（パス・論点 ID）が送った値と違う")
        # 事後条件: 未処理の状態で溜まり、開発側が取り出して改善に回せる
        if row.get("status") != "new":
            r.error(f"{L} 事後条件: 状態が未処理（new）でない（{row.get('status')!r}）")
    # 6. 受付文だけを出すのは画面（check_render.tsx）
    d1(exam, db_name, f"DELETE FROM feedback WHERE id = '{fid}'")
    r.notes.append(f"{L} の基本の流れ: 本文と直前の画面を送信 → 未処理で保存 → 受け付けた印だけが返る")


# 横断の決まり（BR-001・BR-002 認証と失敗の応答）の検査。UC のシナリオではないので @scenario は付けない
def check_scenario_uc014(c: Client, r: Report, got: dict, exam: str, db_name: str):
    """セキュリティヘッダ → Bearer トークンで本人を確定 → 本文の検証 → パスワードはハッシュで保存し照合。"""
    L = "UC-014"
    want = {
        "content-security-policy": None,
        "strict-transport-security": None,
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": None,
    }

    def headers_on(label: str):
        for name, value in want.items():
            got_value = c.last_headers.get(name)
            if got_value is None:
                r.error(f"{L}: {label} にヘッダ {name} が無い")
            elif value is not None and got_value != value:
                r.error(f"{L}: {label} のヘッダ {name} が {got_value!r}（{value!r} のはず）")

    # 1. 学び側の全応答にセキュリティヘッダが載る
    st, _, _ = c.call("GET", "/health", token=None)
    if r.status(f"{L} 1 公開の経路", st, 200):
        headers_on("公開の経路の応答")

    # 2. まなびばの応答は scripts/check_portal_api.py の担当（別のサーバ）
    # 3. 保護された API を Bearer トークン付きで呼ぶ → 本人を確定してから処理に進む
    st, me, _ = c.call("GET", "/me")
    if r.status(f"{L} 3 トークン付きの呼び出し", st, 200):
        if not ((me or {}).get("user") or {}).get("id"):
            r.error(f"{L} 3: 本人（user）が応答に無い（本人を確定していない）")
        headers_on("認証の要る経路の応答")

    # 4. まなびばの Cookie の経路は scripts/check_portal_api.py の担当
    # 5. POST の本文をスキーマで検証し、通った値だけを使う
    detail = got.get("topic_detail")
    if not detail:
        r.error(f"{L} 5: 出題できる論点が取れなかったので本文の検証を通せない")
    else:
        c.call("DELETE", "/sessions/current")
        st, created, text = c.call(
            "POST", "/sessions", {"kind": "drill", "topicId": detail["topic"]["id"], "size": 2}
        )
        if r.status(f"{L} 5 正しい本文の POST", st, 201, None if st == 201 else text[:200]):
            if not 0 < ((created or {}).get("questionCount") or 0) <= 2:
                r.error(f"{L} 5: 送った問題数が使われていない（{(created or {}).get('questionCount')}）")
        c.call("DELETE", "/sessions/current")

    # 6. パスワードを含む本文は、平文で持たずハッシュにして保存し、照合もハッシュで行う
    st, data, _ = c.call("POST", "/auth/login", {"email": EMAIL, "password": PASSWORD}, token=None)
    if st == 404:
        r.warn(f"{L} 6: この環境は SSO でパスワードの経路が無いので、保存と照合は未検査")
    else:
        if r.status(f"{L} 6 パスワードの照合", st, 200, data):
            if not (data or {}).get("token"):
                r.error(f"{L} 6: 照合が通ったのにトークンが返らない")
        try:
            rows = d1(exam, db_name, f"SELECT password_hash AS h FROM users WHERE email = '{EMAIL}'")
        except Exception as ex:
            r.warn(f"{L} 6: 保存されたパスワードの形を D1 で確かめられなかった: {str(ex)[:80]}")
        else:
            stored = (rows[0]["h"] if rows else None) or ""
            if stored == PASSWORD:
                r.error(f"{L} 6: パスワードが平文で保存されている")
            m = re.match(r"^(\d+):[0-9a-f]+:[0-9a-f]+$", stored)
            if not m:
                r.error(f"{L} 6: 保存された値が <反復回数>:<ソルト>:<ハッシュ> の形でない（{stored[:40]}）")
            elif int(m.group(1)) > 100_000:
                r.error(f"{L} 6: 反復回数が {m.group(1)}（Cloudflare Workers の上限 100,000 以下のはず）")

    # 事後条件: 本人として呼ばれたときだけ処理され、失敗はステータスと日本語の {error} で返る
    st, data, _ = c.call("GET", "/me", token=None)
    if r.status(f"{L} 事後条件 本人でない呼び出し", st, 401, data):
        r.error_body(f"{L} 事後条件 401 の本文", data)
        headers_on("401 の応答")
    r.notes.append(f"{L} の基本の流れ: ヘッダ 5 種 → トークンで本人を確定 → 本文の検証 → パスワードはハッシュ")


# @scenario UC-015
def check_scenario_uc017(c: Client, r: Report, exam: str, db_name: str):
    """死活確認 → 学びごとの D1 → 対象の設定は登録簿の 1 か所から。"""
    L = "UC-017"
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target as _target

    # 1. 学び側の死活確認を認証なしで叩く
    st, data, _ = c.call("GET", "/health", token=None)
    if r.status(f"{L} 1 学び側の死活確認", st, 200) and data != {"ok": True}:
        r.error(f"{L} 1: 本文が {{ok: true}} でない（{json.dumps(data, ensure_ascii=False)[:60]}）")

    # 2. まなびばの死活確認は scripts/check_portal_api.py の担当
    # 3. 本番のトークンの秘密は scripts/check_sso_prod.sh の担当（ローカルは開発用の既定値）
    # 4. データの保存先（学びごとの D1）をスキーマの表として読み書きする
    for table in ("users", "topics", "past_questions", "sessions", "feedback"):
        try:
            d1(exam, db_name, f"SELECT COUNT(*) AS n FROM {table}")
        except Exception as ex:
            r.error(f"{L} 4: 学びごとの D1 の {table} を引けない: {str(ex)[:80]}")

    # 5. 対象の名前と設定は登録簿の 1 か所から解決する
    t = _target(exam)
    want_size, want_sec = t.get("mockSize"), (t.get("mockMinutes") or 0) * 60
    if not want_size or not want_sec:
        r.error(f"{L} 5: 登録簿から対象『{exam}』の問題数・制限時間が解決できない")
    else:
        rows = d1(exam, db_name, "SELECT mock_size, mock_time_limit_sec FROM app_settings WHERE id = 'default'")
        if not rows:
            r.error(f"{L} 5: app_settings に id='default' の行が無い（設定が既定値に落ちる）")
        elif (rows[0]["mock_size"], rows[0]["mock_time_limit_sec"]) != (want_size, want_sec):
            r.error(
                f"{L} 5: 保存された設定 {rows[0]['mock_size']} 問 / {rows[0]['mock_time_limit_sec']} 秒が"
                f"登録簿の {want_size} 問 / {want_sec} 秒と違う"
            )

    # 6. seed の門（回ごとの問題数）は scripts/check_seed.py の担当
    # 7. 本番の秘密の一覧は scripts/check_sso_prod.sh の担当（本番には当てない）
    # 事後条件: 死活確認は認証なしで通り、他の API は同じ条件で 401
    st, data, _ = c.call("GET", "/me", token=None)
    r.status(f"{L} 事後条件 死活確認以外は認証なしで 401", st, 401, data)
    r.notes.append(f"{L} の基本の流れ: 死活確認 → 学びごとの D1 の 5 表 → 対象の設定は登録簿と一致")


def main() -> int:
    ap = argparse.ArgumentParser()
    sys.path.insert(0, str(Path(__file__).parent)); from targets import keys as _keys, deploy as _deploy
    ap.add_argument("--exam", default="ip", choices=_keys())
    ap.add_argument("--base", default="http://127.0.0.1:8788")
    ap.add_argument("--db", default=None, help="ローカル D1 の名前（既定は試験から決める）")
    args = ap.parse_args()
    db_name = args.db or _deploy(args.exam)["db"]

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
    check_ordering(c, r, got, args.exam)
    check_topic_detail_extras(c, r, got, args.exam)
    check_mock_settings(c, r, args.exam, db_name)
    check_session_scope(c, r, got)
    check_mock_by_exam(c, r, got, args.exam)
    check_discard(c, r, got, args.exam, db_name)
    check_time_limit(c, r, args.exam, db_name)
    check_exam_attempts(c, r, got, args.exam, other)
    check_security_headers(c, r)
    check_feedback(c, r, args.exam, db_name)
    # UC の基本の流れの写し。ここまでの検査が作った進行中のセッションと feedback の行を
    # 片付けたあと（＝素の状態）に回すので、最後に置く。
    check_scenario_uc007(c, r, got)
    check_scenario_uc008(c, r, got, args.exam, db_name)
    check_scenario_uc009(c, r, got, args.exam, db_name)
    check_scenario_uc011(c, r, got, args.exam, db_name)
    check_scenario_uc012(c, r, args.exam, db_name)
    check_scenario_uc014(c, r, got, args.exam, db_name)
    check_scenario_uc017(c, r, args.exam, db_name)

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
