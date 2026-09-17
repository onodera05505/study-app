#!/usr/bin/env bash
# 本番の SSO の門（O13）。4 つの学びとまなびばを外から叩き、SSO が有効で共有秘密が載っていることを見る。
#   bash scripts/check_sso_prod.sh
# 秘密の値は見ない（見えない）。「載っているか」と、まなびばの health だけ。デプロイ後に必ず 1 回。
set -euo pipefail
cd "$(dirname "$0")/.."
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
NG=0
PORTAL="$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['_portal']['url'])")"
printf '%-6s %s -> ' まなびば "$PORTAL"; H="$(curl -s -A "$UA" "$PORTAL/api/health")"; echo "$H"; [ "$H" = '{"ok":true}' ] || NG=1
# health（API）だけでは静的ファイル側の 500 を見逃す（2026-09-17: secureHeaders が ASSETS の変更不可ヘッダーに触れて画面が全部 500、API は 200 のまま）
for path in / /app.js /style.css; do
  S="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$PORTAL$path")"
  [ "$S" = 200 ] || { echo "  ✘ まなびばの ${path} が ${S}（画面が開けない）"; NG=1; }
done
for k in $(python3 scripts/targets.py keys); do
  U="$(python3 scripts/targets.py url "$k")"
  R="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$U/")"
  [ "$R" = 200 ] || { echo "  ✘ ${k} の画面（/）が ${R}"; NG=1; }
  C="$(curl -s -A "$UA" "$U/api/auth/config")"
  printf '%-6s %s -> %s\n' "$k" "$U" "$C"
  echo "$C" | grep -q '"sso":true' || { echo "  ✘ sso が有効でない（SSO_PORTAL_URL が env に無い）"; NG=1; }
  echo "$C" | grep -q '"secretSet":true' || { echo "  ✘ SSO_SECRET が載っていない（bash scripts/set_sso_secret.sh → deploy-pages.sh）"; NG=1; }
  L="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" -X POST -H 'Content-Type: application/json' -d '{"email":"x@example.com","password":"xxxxxxxx"}' "$U/api/auth/login")"
  [ "$L" = 404 ] || { echo "  ✘ パスワードのログインが生きている（$L）。D17"; NG=1; }
done
[ "$NG" = 0 ] && echo "✓ SSO の門: まなびばと学び $(python3 scripts/targets.py keys | wc -w | tr -d " ") つすべて有効（画面も 200）" || { echo "✘ SSO の門に問題あり"; exit 1; }
