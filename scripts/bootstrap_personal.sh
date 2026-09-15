#!/usr/bin/env bash
# 個人アカウントに 3 つの試験の Pages プロジェクト・D1 のマイグレーション・secret を用意する（対話端末で人が回す）。
#
#   npx wrangler login            # 個人アカウント（scripts/pages_projects.json の account_id）を選ぶ
#   bash scripts/bootstrap_personal.sh [ip|ap|itc ...]   # 引数なしなら 3 つ全部
#
# 対話が要る操作だけをここに集めた（Pages 作成・migrations apply の確認・secret の入力）。
# 終わったら、デプロイと投入は `bash scripts/finish_remote.sh <試験>`（Claude 側でも回せる）。
# D1 そのものは先に `wrangler d1 create` 済み（ID は wrangler.jsonc）。
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=scripts/pages_projects.json
WANT=$(python3 -c "import json;print(json.load(open('$CFG'))['account_id'])")
HAVE=$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)
[ "$HAVE" = "$WANT" ] || { echo "ログイン中のアカウント（${HAVE:-不明}）が想定（${WANT}）と違う。npx wrangler login で個人アカウントを選び直す"; exit 1; }

for EXAM in "${@:-ip ap itc}"; do
  read -r PROJECT DB CODE < <(python3 -c "import json;c=json.load(open('$CFG'))['$EXAM'];print(c['project'],c['db'],c['signup_code'])")
  echo "▶ ${EXAM}: Pages ${PROJECT}"
  if npx wrangler pages project list 2>/dev/null | grep -q "│ ${PROJECT} "; then
    echo "  既にある"
  elif ! npx wrangler pages project create "$PROJECT" --production-branch main; then
    # 名前が世界で一意なので、社用側に残っている名前は取れない。-app を付けて pages_projects.json を書き換える
    PROJECT="${PROJECT}-app"
    echo "  名前が取れないので ${PROJECT} にする"
    npx wrangler pages project create "$PROJECT" --production-branch main
    python3 - "$EXAM" "$PROJECT" <<'PY'
import json, sys; p = "scripts/pages_projects.json"; c = json.load(open(p)); c[sys.argv[1]]["project"] = sys.argv[2]
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2); open(p, "a").write("\n")
PY
  fi
  echo "▶ ${EXAM}: マイグレーション（${DB} --remote）"
  npx wrangler d1 migrations apply "$DB" --env "$EXAM" --remote
  echo "▶ ${EXAM}: secret（JWT_SECRET は乱数・SIGNUP_CODE は pages_projects.json）"
  python3 -c "import secrets;print(secrets.token_hex(32))" | npx wrangler pages secret put JWT_SECRET --project-name "$PROJECT"
  printf '%s' "$CODE" | npx wrangler pages secret put SIGNUP_CODE --project-name "$PROJECT"
done
echo
echo "完了。次: bash scripts/finish_remote.sh ip / ap / itc（デプロイ → 投入 → 進捗の復元 → 突き合わせ）。pages_projects.json が変わっていたらコミット"
