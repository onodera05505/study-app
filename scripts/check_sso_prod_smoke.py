# -*- coding: utf-8 -*-
"""本番の SSO を一時アカウントで 1 巡する。ハッシュはローカル mkt の apicheck（パスワード既知）から借り、終わったら消す。

    python3 scripts/check_sso_prod_smoke.py [対象の key]   # 既定 mkt。新しい対象を出したらその key で回す
"""
import json, subprocess, sys, urllib.request, urllib.error, urllib.parse, http.cookiejar
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent  # 道具を置いたリポジトリ（保存先の設定と配備の道具はここから）
KEY = sys.argv[1] if len(sys.argv) > 1 else "mkt"
sys.path.insert(0, str(ROOT / "scripts" / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from tool_refusal import CODE, tool_error_line  # noqa: E402
from account_check import account_mismatch  # noqa: E402
_cfg = json.load(open(ROOT / "scripts" / "pages_projects.json"))


def _refuse_missing(reason: str):
    """配備先の一覧に場所が無いときは、何もせずに名前つきの断りを出して終える。"""
    print(reason, file=sys.stderr)
    print(tool_error_line(CODE.NOT_FOUND, reason))
    sys.exit(1)


if not isinstance(_cfg.get("_portal"), dict) or not _cfg["_portal"].get("url"): _refuse_missing("pages_projects.json の _portal に url が無い（まなびばの本番の場所が分からない）")
if not isinstance(_cfg.get(KEY), dict) or not _cfg[KEY].get("url"): _refuse_missing(f"{KEY} は pages_projects.json に url が無い（まだ本番に出していない）")
# 手元を読む前・本番に書く前に、ログイン中のアカウントを決めたアカウントと照らす。違えば何もせずに FORBIDDEN で断る
_mismatch = account_mismatch(ROOT)
if _mismatch:
    print(_mismatch, file=sys.stderr)
    print(tool_error_line(CODE.FORBIDDEN, _mismatch))
    sys.exit(1)
PORTAL = _cfg["_portal"]["url"].rstrip("/"); APP = _cfg[KEY]["url"].rstrip("/"); APP_DB = _cfg[KEY]["db"]
EMAIL = "sso-smoke@example.com"; PW = "apicheck-pass-1234"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

def d1(args, cwd):
    out = subprocess.run(["npx", "wrangler", "d1", "execute", *args, "--json"], capture_output=True, text=True, cwd=cwd)
    if out.returncode != 0: sys.exit((out.stdout + out.stderr)[-600:])
    data = json.loads(out.stdout[out.stdout.find("["):]); return data[0].get("results", []) if data else []

rows = d1(["study-app-mkt-db", "--env", "mkt", "--local", "--command", "SELECT password_hash FROM users WHERE email='apicheck@example.com'"], ROOT)
if not rows: sys.exit("ローカル mkt に apicheck が無い")
h = rows[0]["password_hash"].replace("'", "''")
d1(["manabiba-db", "--remote", "--command", f"INSERT OR IGNORE INTO accounts (id,email,name,password_hash,role) VALUES ('smoke-0001','{EMAIL}','煙','{h}','MEMBER'); INSERT OR IGNORE INTO grants (account_id, learning, granted_by) VALUES ('smoke-0001','{KEY}','smoke')"], ROOT / "portal")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())
def call(method, url, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method); req.add_header("User-Agent", UA)
    if data is not None: req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", f"Bearer {token}")
    try:
        with opener.open(req, timeout=30) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t.startswith("{") else t), dict(r.headers)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t), dict(e.headers)
        except Exception: return e.code, t, dict(e.headers)

ok = True
def check(label, cond, detail=""):
    global ok; print(("✓ " if cond else "✘ ") + label + (f"  {detail}" if detail else "")); ok = ok and cond
try:
    st, d, h2 = call("POST", f"{PORTAL}/api/login", {"email": EMAIL, "password": PW}); check("まなびば ログイン（本番）", st == 200, str(d)[:80])
    sc = h2.get("Set-Cookie", ""); check("Cookie は HttpOnly・Secure・SameSite=Lax", "HttpOnly" in sc and "Secure" in sc and "SameSite=Lax" in sc, sc[:90])
    st, d, h2 = call("GET", f"{PORTAL}/sso/start?app={KEY}"); loc = h2.get("Location", ""); check(f"/sso/start → {KEY} の callback", st == 302 and loc.startswith(f"{APP}/sso/callback?code="), loc[:90])
    code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("code", [""])[0]
    st, d, _ = call("POST", f"{APP}/api/auth/sso", {"code": code}); check(f"{KEY} /api/auth/sso → token（本番）", st == 200 and "token" in d, str(d)[:70])
    token = d.get("token") if isinstance(d, dict) else None
    st, d, _ = call("GET", f"{APP}/api/me", token=token); check(f"{KEY} /api/me（本番）", st == 200 and "topics" in d)
    st, d, _ = call("POST", f"{APP}/api/auth/sso", {"code": code}); check("同じコードは 2 回目 401", st == 401)
    st, d, h2 = call("GET", f"{PORTAL}/sso/start?app=ip"); check("権限のない ip は denied", st == 302 and "denied=ip" in h2.get("Location", ""))
    st, d, _ = call("GET", f"{PORTAL}/api/admin/accounts"); check("利用者は管理 API 403", st == 403)
finally:
    d1(["manabiba-db", "--remote", "--command", "DELETE FROM accounts WHERE id='smoke-0001'"], ROOT / "portal")
    rows = d1([APP_DB, "--env", KEY, "--remote", "--command", f"SELECT id FROM users WHERE email='{EMAIL}'"], ROOT)
    if rows:
        d1([APP_DB, "--env", KEY, "--remote", "--command", f"DELETE FROM progress WHERE user_id='{rows[0]['id']}'; DELETE FROM daily_visits WHERE user_id='{rows[0]['id']}'; DELETE FROM users WHERE id='{rows[0]['id']}'"], ROOT)
    print(f"片付け: まなびばの一時アカウントと {KEY} の users 行を削除")
print("RESULT:", "ALL OK" if ok else "NG あり"); sys.exit(0 if ok else 1)
