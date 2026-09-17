#!/usr/bin/env bash
# 共有秘密 SSO_SECRET を学び側 4 つの Pages に置く（まなびばと同じ値。要件 §15 O13）。
#
#   bash scripts/set_sso_secret.sh            # .sso_secret.local（deploy_portal.sh --setup が書く）の値を 4 つに
#
# secret は置いただけでは反映されない（稼働中のデプロイは古い値）。置いた後に各学びを deploy-pages.sh で出し直す。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -s .sso_secret.local ] || { echo ".sso_secret.local が無い。先に bash scripts/deploy_portal.sh --setup" >&2; exit 1; }
for k in $(python3 scripts/targets.py keys); do
  P="$(python3 scripts/targets.py project "$k")"
  echo "▶ ${k}（Pages ${P}）"
  npx wrangler pages secret put SSO_SECRET --project-name "$P" < .sso_secret.local
done
echo "完了。次: 各学びを bash scripts/deploy-pages.sh <key> で出し直す"
