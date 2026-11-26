# 配備の手続き（deploy-pages.sh・deploy_portal.sh）が source する。
# プロジェクトが固定した版の配備の道具（node_modules の wrangler。版の正本は package-lock.json）の絶対パスを WRANGLER に置き、
# それが入っているかを、道具を呼ばずに（入っている包みの版の記録 node_modules/wrangler/package.json を読んで）確かめる。
# 入っていないか版が固定と違えば、その理由を PINNED_WRANGLER_MISSING に置く（入っていれば空）。ここでは止まらない。
# 呼ぶ側はそれをアカウントの照らし（check_account.sh の ACCOUNT_WRANGLER_MISSING）に渡し、照らしが向け先のあとで止める。
# PATH や npx の別の版の道具には倒さない。
# 呼ぶ側はリポジトリの根で source する（設定を組む場所がリポジトリの外でも同じ道具を使えるよう絶対パスにする）。
WRANGLER="$PWD/node_modules/.bin/wrangler"
PINNED_WRANGLER_MISSING="$(python3 - <<'PY'
import json, os

pinned = json.load(open('package-lock.json'))['packages'].get('node_modules/wrangler', {}).get('version', '')
if not pinned:
    print('package-lock.json に wrangler の固定した版が無い')
    raise SystemExit
try:
    have = json.load(open('node_modules/wrangler/package.json')).get('version', '')
except (OSError, ValueError):
    have = None
if have is None or not os.access('node_modules/.bin/wrangler', os.X_OK):
    print(f'固定した版の wrangler（{pinned}）が node_modules に入っていない。npm ci で入れてから回す')
elif have != pinned:
    print(f'node_modules の wrangler（{have or "不明"}）が固定した版（{pinned}）と違う。npm ci で入れ直す')
PY
)"
