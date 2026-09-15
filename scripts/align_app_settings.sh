#!/usr/bin/env bash
# 本番 D1 の app_settings（模試の問題数・制限時間）を、その試験の設定（scripts/build_seed.py の EXAM_SETTINGS =
# src/shared/exam.ts の mockSize / mockMinutes）に合わせる。seed は既存の行を触らないので、古い DB はこれで揃える。
#
#   bash scripts/align_app_settings.sh ap          # 応用情報 午前: 80 問・150 分
#   bash scripts/align_app_settings.sh ap --local  # ローカル D1
#
# 背景: 列の既定値（100 問 / 7200 秒）が試験の設定を上書きしていた（brain/reports/23、2026-09-15）。
# 本番を書き換えるので許可リストに入れない。先に `npx wrangler whoami` が通ること。
set -euo pipefail
cd "$(dirname "$0")/.."
EXAM="${1:?第1引数: ip か ap か itc}"
case "$EXAM" in
  ip) DB=study-app-db ;; ap) DB=study-app-ap-db ;; itc) DB=study-app-itc-db ;;
  *) echo "第1引数は ip か ap か itc"; exit 1 ;;
esac
WHERE="--remote"; [ "${2:-}" = "--local" ] && WHERE="--local"
read -r SIZE SEC < <(python3 -c "import sys; sys.path.insert(0,'scripts'); from build_seed import EXAM_SETTINGS as E; print(*E['$EXAM'])")
echo "▶ ${DB} ${WHERE}: app_settings を mock_size=${SIZE} / mock_time_limit_sec=${SEC} に"
echo "  変更前:"; npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --json --command "SELECT mock_size, mock_time_limit_sec FROM app_settings WHERE id='default'" | python3 -c "import json,sys;print('   ', json.load(sys.stdin)[0]['results'])"
npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --command "UPDATE app_settings SET mock_size=${SIZE}, mock_time_limit_sec=${SEC}, updated_at=unixepoch() WHERE id='default'" >/dev/null
echo "  変更後:"; npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --json --command "SELECT mock_size, mock_time_limit_sec FROM app_settings WHERE id='default'" | python3 -c "import json,sys;r=json.load(sys.stdin)[0]['results'][0];print('   ', r);import sys as s; s.exit(0 if r['mock_size']==${SIZE} and r['mock_time_limit_sec']==${SEC} else 1)"
echo "✓ 揃った"
