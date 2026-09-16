#!/usr/bin/env bash
# 入口「まなびば」を作って Pages へ出す（要件 §14-A）。静的ページだけ。D1 も secret も無い。
#
#   bash scripts/deploy_portal.sh
#
# Pages プロジェクト名と URL は scripts/pages_projects.json の _portal。無ければ作る（名前が取れなければ -app を付ける）。
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT="$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['account_id'])")"
if ! npx wrangler whoami 2>/dev/null | grep -q "$ACCOUNT"; then
  echo "ログイン中の Cloudflare アカウントが登録簿（$ACCOUNT）と違う。npx wrangler login で個人アカウントに" >&2; exit 1
fi

PROJECT="$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json')).get('_portal',{}).get('project','manabiba'))")"
python3 scripts/build_portal.py

if ! npx wrangler pages project list 2>/dev/null | grep -q "│ ${PROJECT} "; then
  echo "▶ Pages ${PROJECT} を作る"
  if ! npx wrangler pages project create "$PROJECT" --production-branch main; then
    PROJECT="${PROJECT}-app"; echo "  名前が取れないので ${PROJECT} にする"
    npx wrangler pages project create "$PROJECT" --production-branch main
  fi
fi
# wrangler.jsonc（Worker 用）を読ませない: 一時ディレクトリから出す
TMP="$(mktemp -d)"; cp -R portal/dist "$TMP/dist"
( cd "$TMP" && npx wrangler pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true )
rm -rf "$TMP"
# 実際のドメインはプロジェクト名と違うことがある（manabiba.pages.dev は他人のもので、うちは manabiba-5oz。2026-09-16）
DOMAIN="$(npx wrangler pages project list 2>/dev/null | awk -F'│' -v p="$PROJECT" '{gsub(/ /,"",$2); if ($2==p) {gsub(/ /,"",$3); print $3}}' | head -1)"
URL="https://${DOMAIN:-${PROJECT}.pages.dev}"
python3 - "$PROJECT" "$URL" <<'PY'
import json, sys
p = "scripts/pages_projects.json"; c = json.load(open(p))
c.setdefault("_portal", {}); c["_portal"].update({"project": sys.argv[1], "url": sys.argv[2], "title": c["_portal"].get("title", "まなびば"), "subtitle": c["_portal"].get("subtitle", "特化した学びのロードマップ")})
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2); open(p, "a").write("\n")
PY
echo "完了: ${URL}"
