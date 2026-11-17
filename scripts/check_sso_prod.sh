#!/usr/bin/env bash
# 本番の SSO の門（O13）。学びとまなびばを外から叩き、SSO が有効であることと、
# 各 Pages プロジェクトの秘密（SSO_SECRET・学び側は JWT_SECRET）が設定されていることを見る。
#   bash scripts/check_sso_prod.sh
# 秘密の値は読まない・出さない。見るのは、秘密の一覧に名前があること、まなびばと各学びの health・画面・
# セキュリティヘッダ、各学びの SSO の設定と、学び側のパスワードでのログインと登録の経路が閉じていること。
# 状態を変える要求（決められた形を満たす本文）は投げない。デプロイ後に必ず 1 回。
set -euo pipefail
# 道具の出力は一度変数に受け、判定の grep にはヒアストリングで渡す（パイプで渡すと grep -q が一致の時点で抜け、
# 書き手が SIGPIPE で落ちて pipefail がパイプライン全体を失敗にし、有る項目を無いと報告する）
cd "$(dirname "$0")/.."
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
# @implements REQ-219
NG=0
# 見た項目（配備の表示名と契約の operation の名前の組）。結びで配備ごとに並べる
SEEN=""
# @implements REQ-216
seen() { SEEN="${SEEN}$1 $2"$'\n'; }
# 全応答に載るべきセキュリティヘッダ（CSP・HSTS・X-Frame-Options DENY・nosniff・Referrer-Policy）。
# 抜けても画面は動くので、本番の死活確認の応答を見て確かめる。届かなければどのヘッダも載っていない側に挙げる
# @implements REQ-523
# @operation UC-015#readDeploymentHealthHeaders
check_headers() {
  local url="$1" name="$2" h want
  h="$(curl -s -D - -o /dev/null -A "$UA" "$url/api/health" | tr -d '\r' | tr 'A-Z' 'a-z' || true)"
  for want in "content-security-policy:" "strict-transport-security:" "x-frame-options: deny" \
              "x-content-type-options: nosniff" "referrer-policy:"; do
    grep -q "^${want}" <<< "$h" || { echo "  ✘ ${name} の応答に ${want} が無い（secureHeaders）"; NG=1; }
  done
}
# 配備の死活確認を認証なしで叩き、生きている印でなければ（届かないときも）その配備を挙げる。
# show を渡すと、受けた本文を 1 行で出す
# @implements REQ-217
# @operation UC-015#checkDeploymentHealth
check_health() {
  local url="$1" name="$2" show="${3:-}" h
  seen "$name" checkDeploymentHealth
  h="$(curl -s -A "$UA" "$url/api/health" || true)"
  [ -z "$show" ] || printf '%-6s %s -> %s\n' "$name" "$url" "$h"
  [ "$h" = '{"ok":true}' ] || { echo "  ✘ ${name} の死活確認（/api/health）が生きている印を返さない"; NG=1; }
}
# 配備の入口の画面を成す経路を認証なしで外から開き、200 でなければ（届かないときも）その配備と経路を挙げる
# @implements REQ-218
# @operation UC-015#openDeploymentEntry
check_entry() {
  local url="$1" name="$2" path="$3" s
  seen "$name" openDeploymentEntry
  s="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$url$path" || true)"
  [ "$s" = 200 ] || { echo "  ✘ ${name} の ${path} が ${s:-000}（画面が開けない）"; NG=1; }
}
# 学び側のパスワードでのログインと登録の経路は学び側が受け持たない（受け持たない経路の断り＝404）。
# 本文は決められた形を満たさない {} だけにして、経路が開いていても状態を変えない
# @implements REQ-350
# @operation UC-015#probeRetiredPasswordRoute
probe_retired_password_route() {
  local url="$1" name="$2" route="$3" s
  seen "$name" probeRetiredPasswordRoute
  s="$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" -X POST -H 'Content-Type: application/json' -d '{}' "$url/api/auth/$route" || true)"
  [ "$s" = 404 ] || { echo "  ✘ ${name} の学び側のパスワードでの経路 /api/auth/${route} が受け持たない経路の断り（404）でなく ${s:-000}（probeRetiredPasswordRoute）"; NG=1; }
}
# 本番の Pages プロジェクトの秘密の一覧を機械で確かめる（O13）。共有秘密 SSO_SECRET は まなびばと各学び、
# トークンの署名の秘密 JWT_SECRET は各学び。名前が一覧にあることだけを見て、値は読まない・出さない。
# 配備ごとの表示名・Pages プロジェクト名・必要な秘密の名前を 1 行ずつ返す（必要な名前の定義はここだけ）
# @implements REQ-215
secret_targets() {
  local key
  printf '%s\t%s\t%s\n' まなびば "$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['_portal']['project'])")" "SSO_SECRET"
  for key in $(python3 scripts/targets.py keys); do
    printf '%s\t%s\t%s\n' "$key" "$(python3 scripts/targets.py project "$key")" "SSO_SECRET JWT_SECRET"
  done
}
# ログイン中のアカウントが分かり、そのどれも配備を持たないときだけアカウント違い（FORBIDDEN）として
# 一覧の取得より先に判定する。ログインしていない・アカウントが分からないときは取得を試み、失敗は取得の失敗に挙げる。
# @implements REQ-215, REQ-221, REQ-222, BR-009
# @operation UC-015#listDeploymentSecretNames
check_secrets() {
  local name project want s out have expect list
  expect="$(python3 scripts/targets.py account)"
  have="$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | sort -u | tr '\n' ' ' || true)"
  list="$(secret_targets)"
  if [ -n "${have// /}" ] && ! grep -qx "$expect" <<< "$(printf '%s\n' $have)"; then
    while IFS=$'\t' read -r name project want; do
      echo "  ✘ ${name}（${project}）の秘密の一覧を見られない: ログイン中の Cloudflare アカウント（${have% }）のどれも想定（${expect}）でない（npx wrangler login で個人アカウントを選び直す）"
    done <<< "$list"
    NG=1
    return
  fi
  while IFS=$'\t' read -r name project want; do
    seen "$name" listDeploymentSecretNames
    if ! out="$(npx wrangler pages secret list --project-name "$project" 2>&1 < /dev/null)"; then
      echo "  ✘ ${name}（${project}）の秘密の一覧が取れない: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
      NG=1
      continue
    fi
    # 一覧の各行（「  - 名前: Value Encrypted」）の名前の部分と完全一致で判定する（前後に文字を足した別名は数えない）
    for s in $want; do
      grep -qE "(^|[[:space:]-])${s}:" <<< "$out" \
        || { echo "  ✘ ${name}（${project}）に ${s} が設定されていない（SSO_SECRET は bash scripts/set_sso_secret.sh、JWT_SECRET は npx wrangler pages secret put JWT_SECRET --project-name ${project}。置いた後に deploy-pages.sh で出し直す）"; NG=1; }
    done
    printf '%-6s %-14s 秘密 %s を確認\n' "$name" "$project" "$(printf '%s' "$want" | tr ' ' '・')"
  done <<< "$list"
}
PORTAL="$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['_portal']['url'])")"
check_health "$PORTAL" まなびば show
check_headers "$PORTAL" まなびば
# health（API）だけでは静的ファイル側の 500 を見逃すので、入口の画面を成す経路も開く
for path in / /app.js /style.css; do
  check_entry "$PORTAL" まなびば "$path"
done
for k in $(python3 scripts/targets.py keys); do
  U="$(python3 scripts/targets.py url "$k")"
  check_health "$U" "$k"
  check_entry "$U" "$k" /
  check_headers "$U" "$k"
  # config は sso・portal・app を返す
  seen "$k" getAuthConfig
  C="$(curl -s -A "$UA" "$U/api/auth/config" || true)"
  printf '%-6s %s -> %s\n' "$k" "$U" "$C"
  grep -q '"sso":true' <<< "$C" || { echo "  ✘ ${k} の sso が有効でない（SSO_PORTAL_URL が env に無い）"; NG=1; }
  for route in login register; do
    probe_retired_password_route "$U" "$k" "$route"
  done
done
echo "▶ 本番の秘密の一覧（名前だけを見る。値は読まない）"
check_secrets
# 見た配備ごとに、見た項目を契約の operation の名前で並べる
echo "▶ 見た項目"
for name in まなびば $(python3 scripts/targets.py keys); do
  ops="$(printf '%s' "$SEEN" | awk -v n="$name" '$1 == n && !s[$2]++ { printf "%s ", $2 }')"
  echo "${name} 見た項目: ${ops% }"
done
# @implements REQ-216, REQ-220
[ "$NG" = 0 ] && echo "✓ SSO の門: まなびばと学び $(python3 scripts/targets.py keys | wc -w | tr -d " ") つすべて有効（画面も 200・秘密も設定済み）" || { echo "✘ SSO の門に問題あり"; exit 1; }
