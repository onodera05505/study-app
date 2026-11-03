#!/usr/bin/env bash
# 本番の SSO の門（O13）。学びとまなびばを外から叩き、SSO が有効であることと、
# 各 Pages プロジェクトの秘密（SSO_SECRET・学び側は JWT_SECRET）が設定されていることを見る。
#   bash scripts/check_sso_prod.sh
# 秘密の値は読まない・出さない。見るのは、秘密の一覧に名前があること、まなびばと各学びの health・画面・
# セキュリティヘッダ、各学びの SSO の設定とパスワードのログインが閉じていること。状態を変える要求（登録）は投げない。
# デプロイ後に必ず 1 回。
set -euo pipefail
cd "$(dirname "$0")/.."
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
# @implements REQ-219
NG=0
# 全応答に載るべきセキュリティヘッダ（CSP・HSTS・X-Frame-Options DENY・nosniff・Referrer-Policy）。
# 抜けても画面は動くので、本番の応答を見て確かめる。
check_headers() {
  local url="$1" name="$2" h want
  h="$(curl -s -D - -o /dev/null -A "$UA" "$url/api/health" | tr -d '\r' | tr 'A-Z' 'a-z' || true)"
  for want in "content-security-policy:" "strict-transport-security:" "x-frame-options: deny" \
              "x-content-type-options: nosniff" "referrer-policy:"; do
    printf '%s\n' "$h" | grep -q "^${want}" || { echo "  ✘ ${name} の応答に ${want} が無い（secureHeaders）"; NG=1; }
  done
}
# 本番の Pages プロジェクトの秘密の一覧を機械で確かめる（O13）。共有秘密 SSO_SECRET は まなびばと各学び、
# トークンの署名の秘密 JWT_SECRET は各学び。名前が一覧にあることだけを見て、値は読まない・出さない。
# 配備ごとの表示名・Pages プロジェクト名・必要な秘密の名前を 1 行ずつ返す（必要な名前の定義はここだけ）
secret_targets() {
  local key
  printf '%s\t%s\t%s\n' まなびば "$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['_portal']['project'])")" "SSO_SECRET"
  for key in $(python3 scripts/targets.py keys); do
    printf '%s\t%s\t%s\n' "$key" "$(python3 scripts/targets.py project "$key")" "SSO_SECRET JWT_SECRET"
  done
}
# @implements REQ-215, REQ-221, REQ-222, BR-009
check_secrets() {
  local name project want s out have expect list
  expect="$(python3 scripts/targets.py account)"
  have="$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  list="$(secret_targets)"
  # アカウント違い（FORBIDDEN）は一覧の取得より先に判定し、該当する配備をすべて名指しする
  if [ "$have" != "$expect" ]; then
    while IFS=$'\t' read -r name project want; do
      echo "  ✘ ${name}（${project}）の秘密の一覧を見られない: ログイン中の Cloudflare アカウント（${have:-不明}）が想定（${expect}）と違う（npx wrangler login で個人アカウントを選び直す）"
    done <<< "$list"
    NG=1
    return
  fi
  while IFS=$'\t' read -r name project want; do
    if ! out="$(npx wrangler pages secret list --project-name "$project" 2>&1 < /dev/null)"; then
      echo "  ✘ ${name}（${project}）の秘密の一覧が取れない: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
      NG=1
      continue
    fi
    # 一覧の各行（「  - 名前: Value Encrypted」）の名前の部分と完全一致で判定する（前後に文字を足した別名は数えない）
    for s in $want; do
      printf '%s\n' "$out" | grep -qE "(^|[[:space:]-])${s}:" \
        || { echo "  ✘ ${name}（${project}）に ${s} が設定されていない（SSO_SECRET は bash scripts/set_sso_secret.sh、JWT_SECRET は npx wrangler pages secret put JWT_SECRET --project-name ${project}。置いた後に deploy-pages.sh で出し直す）"; NG=1; }
    done
    printf '%-6s %-14s 秘密 %s を確認\n' "$name" "$project" "$(printf '%s' "$want" | tr ' ' '・')"
  done <<< "$list"
}
PORTAL="$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['_portal']['url'])")"
# @implements REQ-213, REQ-217
printf '%-6s %s -> ' まなびば "$PORTAL"; H="$(curl -s -A "$UA" "$PORTAL/api/health" || true)"; echo "$H"
[ "$H" = '{"ok":true}' ] || { echo "  ✘ まなびばの死活確認（/api/health）が生きている印を返さない"; NG=1; }
check_headers "$PORTAL" まなびば
# health（API）だけでは静的ファイル側の 500 を見逃すので、入口の画面を成す経路も開く
# @implements REQ-214, REQ-218
for path in / /app.js /style.css; do
  S="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$PORTAL$path" || true)"
  [ "$S" = 200 ] || { echo "  ✘ まなびばの ${path} が ${S:-000}（画面が開けない）"; NG=1; }
done
# @implements REQ-214, REQ-218
for k in $(python3 scripts/targets.py keys); do
  U="$(python3 scripts/targets.py url "$k")"
  # @implements REQ-213, REQ-217
  H="$(curl -s -A "$UA" "$U/api/health" || true)"
  [ "$H" = '{"ok":true}' ] || { echo "  ✘ ${k} の死活確認（/api/health）が生きている印を返さない"; NG=1; }
  R="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$U/" || true)"
  [ "$R" = 200 ] || { echo "  ✘ ${k} の画面（/）が ${R:-000}"; NG=1; }
  check_headers "$U" "$k"
  # SSO が有効な学びではパスワードのログインが閉じている（D17）。config は sso・portal・app を返す。
  # 検査は本番の状態を変えないので、成功すれば状態を変える要求（登録）は投げない
  C="$(curl -s -A "$UA" "$U/api/auth/config" || true)"
  printf '%-6s %s -> %s\n' "$k" "$U" "$C"
  echo "$C" | grep -q '"sso":true' || { echo "  ✘ ${k} の sso が有効でない（SSO_PORTAL_URL が env に無い）"; NG=1; }
  L="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" -X POST -H 'Content-Type: application/json' -d '{"email":"x@example.com","password":"xxxxxxxx"}' "$U/api/auth/login" || true)"
  [ "$L" = 404 ] || { echo "  ✘ ${k} のパスワードのログインが生きている（${L:-000}）。D17"; NG=1; }
done
echo "▶ 本番の秘密の一覧（名前だけを見る。値は読まない）"
check_secrets
# @implements REQ-216, REQ-220
[ "$NG" = 0 ] && echo "✓ SSO の門: まなびばと学び $(python3 scripts/targets.py keys | wc -w | tr -d " ") つすべて有効（画面も 200・秘密も設定済み）" || { echo "✘ SSO の門に問題あり"; exit 1; }
