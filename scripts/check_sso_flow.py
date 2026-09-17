# -*- coding: utf-8 -*-
"""SSO の一巡（受入・リハーサル用）。まなびば(8790) と学び(8788) をローカルに起こし、ログイン → /sso/start → コード → 学び側 /api/auth/sso → /api/me と逆経路を見る（要件 §15）。

    cd portal && npx wrangler dev --port 8790 --var SSO_SECRET:testsecret
    npx wrangler dev --env mkt --port 8788 --var SSO_PORTAL_URL:http://127.0.0.1:8790 --var SSO_SECRET:testsecret
    python3 scripts/portal_migrate_accounts.py --admin apicheck@example.com --local
    python3 scripts/check_sso_flow.py
import json, sys, urllib.request, urllib.error, urllib.parse, http.cookiejar

PORTAL = "http://127.0.0.1:8790"; APP = "http://127.0.0.1:8788"
EMAIL = "apicheck@example.com"; PW = "apicheck-pass-1234"
UA = "Mozilla/5.0 (sso_flow.py)"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())

def call(method, url, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    if data is not None: req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", f"Bearer {token}")
    try:
        with opener.open(req, timeout=30) as r:
            txt = r.read().decode(); return r.status, (json.loads(txt) if txt.startswith("{") else txt), dict(r.headers)
    except urllib.error.HTTPError as e:
        txt = e.read().decode();
        try: return e.code, json.loads(txt), dict(e.headers)
        except Exception: return e.code, txt, dict(e.headers)

ok = True
def check(label, cond, detail=""):
    global ok
    print(("✓ " if cond else "✘ ") + label + (f"  {detail}" if detail else ""))
    ok = ok and cond

st, d, _ = call("GET", f"{PORTAL}/api/health"); check("まなびば health", st == 200, str(d))
st, d, _ = call("GET", f"{APP}/api/auth/config"); check("mkt config sso=true", st == 200 and d.get("sso") is True, str(d))
st, d, _ = call("POST", f"{APP}/api/auth/login", {"email": EMAIL, "password": PW}); check("mkt のパスワードログインは 404", st == 404, str(d)[:80])
st, d, _ = call("POST", f"{APP}/api/auth/register", {"email": "x@example.com", "password": PW, "name": "x"}); check("mkt の登録は 404", st == 404, str(d)[:80])

st, d, _ = call("POST", f"{PORTAL}/api/login", {"email": EMAIL, "password": "wrong-pass-999"}); check("まなびば 誤パスワード 401", st == 401, str(d)[:80])
st, d, _ = call("POST", f"{PORTAL}/api/login", {"email": EMAIL, "password": PW}); check("まなびば ログイン 200", st == 200, str(d)[:120])
grants = d.get("grants", []) if isinstance(d, dict) else []
check("mkt の権限あり", "mkt" in grants, str(grants))
st, d, _ = call("GET", f"{PORTAL}/api/me"); check("まなびば /api/me（Cookie）", st == 200 and d.get("account", {}).get("email") == EMAIL)

st, d, h = call("GET", f"{PORTAL}/sso/start?app=mkt"); loc = h.get("Location", "")
check("/sso/start → 302 to callback", st == 302 and "/sso/callback?code=" in loc, loc[:100])
code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("code", [""])[0]
st, d, h = call("GET", f"{PORTAL}/sso/start?app=nope"); check("知らない学び 400", st == 400)

st, d, _ = call("POST", f"{PORTAL}/api/sso/exchange", {"code": code, "app": "mkt", "secret": "bad"}); check("交換 誤秘密 403", st == 403)
st, d, _ = call("POST", f"{PORTAL}/api/sso/exchange", {"code": code, "app": "ip", "secret": "testsecret"}); check("交換 別の学び 401", st == 401, str(d)[:80])
st, d, _ = call("POST", f"{APP}/api/auth/sso", {"code": code}); check("mkt /api/auth/sso → token", st == 200 and "token" in d, str(d)[:80])
token = d.get("token") if isinstance(d, dict) else None
st, d, _ = call("POST", f"{APP}/api/auth/sso", {"code": code}); check("同じコードは 2 回使えない", st in (401, 403), str(d)[:80])
st, d, _ = call("GET", f"{APP}/api/me", token=token); check("mkt /api/me with token", st == 200 and "topics" in d)
st, d, _ = call("POST", f"{APP}/api/auth/sso", {"code": "no-such-code"}); check("無いコード 401", st == 401)

# 権限を外すと止まる（管理者 API）
st, d, _ = call("GET", f"{PORTAL}/api/admin/accounts"); check("管理 一覧", st == 200 and isinstance(d.get("accounts"), list), f"{len(d.get('accounts', [])) if isinstance(d, dict) else d} 件")
me_id = next((a["id"] for a in d["accounts"] if a["email"] == EMAIL), None)
other = next((a for a in d["accounts"] if a["email"] != EMAIL), None)
if other:
    st2, d2, _ = call("PUT", f"{PORTAL}/api/admin/accounts/{other['id']}", {"grants": []}); check("他人の権限を全部外す", st2 == 200)
    st2, d2, _ = call("PUT", f"{PORTAL}/api/admin/accounts/{other['id']}", {"grants": other["grants"]}); check("戻す", st2 == 200)
st, d, _ = call("PUT", f"{PORTAL}/api/admin/accounts/{me_id}", {"role": "MEMBER"}); check("自分の管理者は外せない 400", st == 400)
st, d, _ = call("POST", f"{PORTAL}/api/admin/accounts", {"email": "newbie@example.com", "name": "新人", "password": "newbie-pass-1", "grants": ["itc"]}); check("アカウント作成 201", st == 201, str(d)[:80])
nid = d.get("id") if isinstance(d, dict) else None
# 新人でログインして mkt は権限なし
jar.clear()
st, d, _ = call("POST", f"{PORTAL}/api/login", {"email": "newbie@example.com", "password": "newbie-pass-1"}); check("新人 ログイン", st == 200)
st, d, h = call("GET", f"{PORTAL}/sso/start?app=mkt"); check("権限のない学び → denied へ", st == 302 and "denied=mkt" in h.get("Location", ""), h.get("Location", ""))
st, d, h = call("GET", f"{PORTAL}/sso/start?app=itc"); check("権限のある学び → callback", st == 302 and "/sso/callback" in h.get("Location", ""))
st, d, _ = call("POST", f"{PORTAL}/api/me/password", {"current": "newbie-pass-1", "next": "newbie-pass-2"}); check("自分のパスワード変更", st == 200)
st, d, _ = call("GET", f"{PORTAL}/api/admin/accounts"); check("利用者は管理 API を使えない 403", st == 403)
st, d, _ = call("POST", f"{PORTAL}/api/logout"); check("ログアウト", st == 200)
st, d, _ = call("GET", f"{PORTAL}/api/me"); check("ログアウト後は 401", st == 401)
# 片付け: 管理者で新人を削除
jar.clear(); call("POST", f"{PORTAL}/api/login", {"email": EMAIL, "password": PW})
if nid:
    st, d, _ = call("DELETE", f"{PORTAL}/api/admin/accounts/{nid}"); check("新人を削除", st == 200)
print("\nRESULT:", "ALL OK" if ok else "NG あり")
sys.exit(0 if ok else 1)
