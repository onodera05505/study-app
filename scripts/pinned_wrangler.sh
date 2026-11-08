# 配備の手続き（deploy-pages.sh・deploy_portal.sh）が source する。
# プロジェクトが固定した版の配備の道具（node_modules の wrangler。版の正本は package-lock.json）を
# 絶対パスで WRANGLER に置く。入っていないか版が固定と違えば、PATH や npx の別の版に倒さず失敗で終わる。
# 呼ぶ側はリポジトリの根で source する（設定を組む場所がリポジトリの外でも同じ道具を使えるよう絶対パスにする）。
# @implements REQ-351, REQ-352
WRANGLER="$PWD/node_modules/.bin/wrangler"
PINNED_WRANGLER_VERSION="$(python3 -c "import json;print(json.load(open('package-lock.json'))['packages'].get('node_modules/wrangler',{}).get('version',''))")"
[ -n "$PINNED_WRANGLER_VERSION" ] || { echo "✘ package-lock.json に wrangler の固定した版が無い。配信しない" >&2; exit 1; }
[ -x "$WRANGLER" ] || { echo "✘ 固定した版の wrangler（${PINNED_WRANGLER_VERSION}）が node_modules に入っていない。npm ci で入れてから回す。配信しない" >&2; exit 1; }
HAVE_WRANGLER_VERSION="$("$WRANGLER" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*' | head -1 || true)"
[ "$HAVE_WRANGLER_VERSION" = "$PINNED_WRANGLER_VERSION" ] || { echo "✘ node_modules の wrangler（${HAVE_WRANGLER_VERSION:-不明}）が固定した版（${PINNED_WRANGLER_VERSION}）と違う。npm ci で入れ直す。配信しない" >&2; exit 1; }
