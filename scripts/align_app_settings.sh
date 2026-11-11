#!/usr/bin/env bash
# 本番 D1 の app_settings（模試の問題数・制限時間）を、その試験の設定（scripts/build_seed.py の EXAM_SETTINGS =
# src/shared/exam.ts の mockSize / mockMinutes）に合わせる。seed は既存の行を触らないので、古い DB はこれで揃える。
#
#   bash scripts/align_app_settings.sh ap          # 応用情報 午前: 80 問・150 分
#   bash scripts/align_app_settings.sh ap --local  # ローカル D1
#
# 列の既定値（100 問 / 7200 秒）は試験の設定を上書きするので、古い DB はここで揃える（brain/reports/23）。
# 本番を書き換えるので許可リストに入れない。先に `npx wrangler whoami` が通ること。
set -euo pipefail
cd "$(dirname "$0")/.."
EXAM="${1:-}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
DB=$(python3 scripts/targets.py db "$EXAM")
WHERE="--remote"; [ "${2:-}" = "--local" ] && WHERE="--local"
if [ "$WHERE" = "--remote" ]; then
  WANT=$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['account_id'])")
  # 道具の出力は一度変数に受けてから読む（pipefail の下で読み手が先に抜けると、書き手が SIGPIPE で落ちる）
  WHOAMI=$(npx wrangler whoami 2>/dev/null || true)
  ACCOUNT_RE='[0-9a-f]{32}'; HAVE=""
  [[ $WHOAMI =~ $ACCOUNT_RE ]] && HAVE="${BASH_REMATCH[0]}"
  [ "$HAVE" = "$WANT" ] || { echo "ログイン中のアカウント（${HAVE:-不明}）が想定（${WANT}）と違う。npx wrangler login で個人アカウントを選び直す"; exit 1; }
fi
read -r SIZE SEC < <(python3 -c "import sys; sys.path.insert(0,'scripts'); from targets import exam_settings as E; print(*E()['$EXAM'])")
echo "▶ ${DB} ${WHERE}: app_settings を mock_size=${SIZE} / mock_time_limit_sec=${SEC} に"
echo "  変更前:"; npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --json --command "SELECT mock_size, mock_time_limit_sec FROM app_settings WHERE id='default'" | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit('   D1 エラー: '+json.dumps(d['error'],ensure_ascii=False)[:300]) if isinstance(d,dict) else print('   ', d[0]['results'])"
npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --command "UPDATE app_settings SET mock_size=${SIZE}, mock_time_limit_sec=${SEC}, updated_at=unixepoch() WHERE id='default'" >/dev/null
echo "  変更後:"; npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --json --command "SELECT mock_size, mock_time_limit_sec FROM app_settings WHERE id='default'" | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit('   D1 エラー: '+json.dumps(d['error'],ensure_ascii=False)[:300]) if isinstance(d,dict) else None;r=d[0]['results'][0];print('   ', r);sys.exit(0 if r['mock_size']==${SIZE} and r['mock_time_limit_sec']==${SEC} else 1)"
echo "✓ 揃った"
