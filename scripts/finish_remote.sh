#!/usr/bin/env bash
# 1 つの試験を個人アカウントの本番に出す後半（bootstrap_personal.sh の後）。
#
#   bash scripts/finish_remote.sh ip     # seed 生成 → migrations を当てる → 投入 → デプロイ → 進捗の復元（backups/restore_ip.sql があれば）→ 模試設定
#
# 対象の ID は登録簿（scripts/targets.py keys）にあるもの。既に出ている対象を出し直すときもこれを使う。
# 順番は「スキーマ → データ → 画面」: 新しい列を足す migrations を先に当て、その列を持つ seed を入れ、最後にその列を読む画面を出す。
#
# 進捗と受験履歴は旧本番のバックアップ（scripts/extract_user_data.py で抜いたもの）から戻す。無ければ復元は飛ばす。
set -euo pipefail
cd "$(dirname "$0")/.."
EXAM="${1:-}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
DB=$(python3 scripts/targets.py db "$EXAM")

echo "▶ 1/6 seed 生成と検査"
python3 scripts/build_seed.py --data "data/${EXAM}" >/dev/null
python3 scripts/check_seed.py --data "data/${EXAM}" | tail -1

echo "▶ 2/6 migrations を当てる（--remote。未適用があれば当てる前にバックアップ）"
bash scripts/d1_migrations.sh "$EXAM" apply

echo "▶ 3/6 投入（migrations の確認 → check_seed → backup → --remote 投入 → 突き合わせ）"
bash scripts/seed_remote.sh "$EXAM"

echo "▶ 4/6 デプロイ（migrations の確認 → 描画検査 → 文書の門 → ビルド → Pages）"
bash scripts/deploy-pages.sh "$EXAM"

RESTORE="backups/restore_${EXAM}.sql"
if [ -f "$RESTORE" ]; then
  echo "▶ 5/6 進捗・受験履歴の復元 ← ${RESTORE}"
  npx wrangler d1 execute "$DB" --env "$EXAM" --remote --file="$RESTORE" >/dev/null
  npx wrangler d1 execute "$DB" --env "$EXAM" --remote --json --command "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM progress) AS progress, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM session_questions) AS session_questions" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('  ', d[0]['results'][0] if isinstance(d,list) else d)"
else
  echo "▶ 5/6 復元するバックアップが無いので飛ばす（${RESTORE}）"
fi

echo "▶ 6/6 模試設定を試験に合わせる"
bash scripts/align_app_settings.sh "$EXAM"
echo
echo "完了: $(python3 scripts/targets.py url "$EXAM")"
