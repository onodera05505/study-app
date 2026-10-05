#!/usr/bin/env bash
# 1 つの試験を個人アカウントの本番に出す後半（bootstrap_personal.sh の後）。
#
#   bash scripts/finish_remote.sh ip     # seed 生成 → デプロイ → 投入 → 進捗の復元（backups/restore_ip.sql があれば）→ 突き合わせ
#
# 対象の ID は登録簿（scripts/targets.py keys）にあるもの。
#
# 進捗と受験履歴は旧本番のバックアップ（scripts/extract_user_data.py で抜いたもの）から戻す。無ければ復元は飛ばす。
set -euo pipefail
cd "$(dirname "$0")/.."
EXAM="${1:-}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
DB=$(python3 scripts/targets.py db "$EXAM")

echo "▶ 1/5 seed 生成と検査"
python3 scripts/build_seed.py --data "data/${EXAM}" >/dev/null
python3 scripts/check_seed.py --data "data/${EXAM}" | tail -1

echo "▶ 2/5 デプロイ（描画検査 → 文書の門 → ビルド → Pages）"
bash scripts/deploy-pages.sh "$EXAM"

echo "▶ 3/5 投入（check_seed → backup → --remote 投入 → 突き合わせ）"
bash scripts/seed_remote.sh "$EXAM"

RESTORE="backups/restore_${EXAM}.sql"
if [ -f "$RESTORE" ]; then
  echo "▶ 4/5 進捗・受験履歴の復元 ← ${RESTORE}"
  npx wrangler d1 execute "$DB" --env "$EXAM" --remote --file="$RESTORE" >/dev/null
  npx wrangler d1 execute "$DB" --env "$EXAM" --remote --json --command "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM progress) AS progress, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM session_questions) AS session_questions" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('  ', d[0]['results'][0] if isinstance(d,list) else d)"
else
  echo "▶ 4/5 復元するバックアップが無いので飛ばす（${RESTORE}）"
fi

echo "▶ 5/5 模試設定を試験に合わせる"
bash scripts/align_app_settings.sh "$EXAM"
echo
echo "完了: $(python3 scripts/targets.py url "$EXAM")"
