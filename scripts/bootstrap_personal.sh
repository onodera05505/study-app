#!/usr/bin/env bash
# 対象の Pages プロジェクト・D1 のマイグレーション・secret を個人アカウントに用意する（対話端末で人が回す）。
#
#   npx wrangler login            # 個人アカウント（scripts/pages_projects.json の account_id）を選ぶ
#   bash scripts/bootstrap_personal.sh fe [ap …]   # 対象の ID は scripts/targets.py keys
#
# JWT_SECRET は毎回新しい乱数を入れ直すので、**出し直す対象だけを明示して渡す**
# （既に動いている対象に回すと、その学びのログイン済みの端末が一斉に切れる）。
#
# 対話が要る操作だけをここに集めた（Pages 作成・migrations apply の確認・secret の入力）。
# 終わったら、デプロイと投入は `bash scripts/finish_remote.sh <試験>`（Claude 側でも回せる）。
# D1 そのものは先に `wrangler d1 create` 済み（ID は wrangler.jsonc）。
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=scripts/pages_projects.json
WANT=$(python3 -c "import json;print(json.load(open('$CFG'))['account_id'])")
# 道具の出力は一度変数に受けてから読む（pipefail の下で読み手が先に抜けると、書き手が SIGPIPE で落ちる）
WHOAMI=$(npx wrangler whoami 2>/dev/null || true)
ACCOUNT_RE='[0-9a-f]{32}'; HAVE=""
[[ $WHOAMI =~ $ACCOUNT_RE ]] && HAVE="${BASH_REMATCH[0]}"
[ "$HAVE" = "$WANT" ] || { echo "ログイン中のアカウント（${HAVE:-不明}）が想定（${WANT}）と違う。npx wrangler login で個人アカウントを選び直す"; exit 1; }

EXAMS=("$@")
[ $# -gt 0 ] || { echo "対象の ID を 1 つ以上渡す（$(python3 scripts/targets.py keys)）"; exit 1; }
for EXAM in "${EXAMS[@]}"; do
  [ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "登録簿に無い対象: ${EXAM}（$(python3 scripts/targets.py keys)。先に scripts/new_target.py）"; exit 1; }
done
for EXAM in "${EXAMS[@]}"; do
  read -r PROJECT DB < <(python3 -c "import json;c=json.load(open('$CFG'))['$EXAM'];print(c['project'],c['db'])")
  echo "▶ ${EXAM}: Pages ${PROJECT}"
  PROJECTS=$(npx wrangler pages project list 2>/dev/null || true)
  if grep -q "│ ${PROJECT} " <<< "$PROJECTS"; then
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
  echo "▶ ${EXAM}: secret（JWT_SECRET は乱数）"
  python3 -c "import secrets;print(secrets.token_hex(32))" | npx wrangler pages secret put JWT_SECRET --project-name "$PROJECT"
done
echo
echo "完了。次: bash scripts/finish_remote.sh ${EXAMS[*]}（デプロイ → 投入 → 進捗の復元 → 突き合わせ）。pages_projects.json が変わっていたらコミット"
