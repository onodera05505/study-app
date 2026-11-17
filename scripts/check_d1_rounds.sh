#!/usr/bin/env bash
# ロードマップ型の対象の D1 に、回（topics.round）を持つ seed が入っているかを見る。資格型は素通り。
#
#   bash scripts/check_d1_rounds.sh <対象>            # 本番（--remote）
#   bash scripts/check_d1_rounds.sh <対象> --local    # ローカル D1
#
# 画面は論点の回を topics.round から読む。migrations を当てただけで seed を入れ直していない D1 では
# 学ぶ順を持つ論点の round が NULL のままで、その画面を出すと全単位が順序なしに入り、回ごとの確認が始められない。
# だから deploy-pages.sh は配備の前にこれを回し、学ぶ順を持つのに round が NULL の論点が 1 つでもあれば止める。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-}"; WHERE="--remote"
[ "${2:-}" = "--local" ] && WHERE="--local"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
# 資格対策の学びは見る物が無いとして通し、ロードマップ型の学びは学ぶ順を持つ論点すべてに回があればその数を示して通す（末尾）
# @implements REQ-561
if [ "$(python3 -c "import sys;sys.path.insert(0,'scripts');from targets import target;print('yes' if target('$EXAM').get('roadmap') else 'no')")" != yes ]; then
  echo "  ${EXAM}: ロードマップ型ではないので回の確認は無い"; exit 0
fi
DB=$(python3 scripts/targets.py db "$EXAM")
HOW="bash scripts/finish_remote.sh ${EXAM}（migrations → 投入 → 配備の順に回す）"
[ "$WHERE" = --local ] && HOW="bash scripts/d1_migrations.sh ${EXAM} apply --local && bash scripts/seed_remote.sh ${EXAM} --local"

# 回を読めないか、学ぶ順を持つのに回の無い論点が 1 つでもあれば、読めないことか数と先に回す手続きを示して失敗で終える
# @implements REQ-562
UNREADABLE="✘ ${DB}（${WHERE}）の topics から回を読めない（round の列が無いなら migrations が未適用）。先に: ${HOW}"
OUT=$(npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --json \
      --command "SELECT COUNT(*) AS missing, (SELECT COUNT(*) FROM topics WHERE sort_order IS NOT NULL) AS ordered FROM topics WHERE sort_order IS NOT NULL AND round IS NULL" </dev/null 2>&1) || {
  echo "$OUT" | tail -5 >&2
  echo "$UNREADABLE" >&2
  exit 1
}
COUNTS=$(echo "$OUT" | python3 -c "
import json,sys
raw=sys.stdin.read(); d=json.loads(raw[raw.index('['):])
r=d[0]['results'][0]; print(int(r['missing']), int(r['ordered']))") || {
  echo "$OUT" | tail -5 >&2
  echo "$UNREADABLE" >&2
  exit 1
}
read -r MISSING ORDERED <<< "$COUNTS"
if [ "$MISSING" != 0 ]; then
  echo "✘ ${DB}（${WHERE}）: 学ぶ順を持つ論点 ${ORDERED} 件のうち ${MISSING} 件の回（round）が空。回を持つ seed が入っていない" >&2
  echo "    先に: ${HOW}" >&2
  exit 1
fi
echo "  ${DB}（${WHERE}）: 学ぶ順を持つ論点 ${ORDERED} 件すべてに回がある"
