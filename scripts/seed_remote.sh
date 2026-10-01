#!/usr/bin/env bash
# seed を D1 に流す。投入の前後に門を置いた1本道。
#
#   bash scripts/seed_remote.sh ip            # 本番（--remote）
#   bash scripts/seed_remote.sh ap
#   bash scripts/seed_remote.sh ip --local    # ローカル D1 でのリハーサル（バックアップは省く）
#
# 順番:
#   1. check_seed.py          seed の中身（出典・ラベル・件数・図・UPSERT の列漏れ・正解の矛盾）
#   2. backup_d1.sh           本番の丸ごとバックアップ（進捗と受験履歴は本番にしか無い）
#   3. wrangler d1 execute    --remote を機械的に付ける（付け忘れでローカルだけ変わる事故を潰す）
#   4. verify_seed_remote.py  入った中身が seed と一致するか（件数・代表値・ラベルの素通し）
#
# どれか1つでも落ちたら止まる。seed.sql の生成（build_seed.py）はここに含めない。
# 生成と投入は別の判断なので、流す前に `python3 scripts/build_seed.py --data data/<試験>` を済ませておく。
#
# 本番を書き換えるので、このスクリプトは意図的に権限の許可リストに入れていない（毎回確認が正しい）。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
DB=$(python3 scripts/targets.py db "$EXAM")
WHERE="--remote"
if [ "${2:-}" = "--local" ]; then WHERE="--local"; fi
SEED="data/${EXAM}/seed.sql"
[ -f "$SEED" ] || { echo "seed が無い: ${SEED}（先に python3 scripts/build_seed.py --data data/${EXAM}）"; exit 1; }

# @implements BR-032
echo "▶ 1/4 seed の中身を検査"
python3 scripts/check_seed.py --data "data/${EXAM}"

if [ "$WHERE" = "--remote" ]; then
  echo "▶ 2/4 本番 D1 をバックアップ"
  bash scripts/backup_d1.sh "$EXAM"
else
  echo "▶ 2/4 バックアップは省略（--local）"
fi

echo "▶ 3/4 投入: ${DB} ${WHERE} ← ${SEED}"
# wrangler は文ごとの結果 JSON を全部出す（1万行超）。ログに逃がして、失敗時だけ末尾を見せる。
LOG=$(mktemp -t seed_${EXAM}).log
run_seed () { npx wrangler d1 execute "$DB" --env "$EXAM" "$WHERE" --file="$SEED" >"$LOG" 2>&1; }
# --remote は Authentication error [code: 10000] で落ちることがある。DB は元のままなので1回だけやり直す
# （docs/応用情報を追加する.md の落とし穴）。
if ! run_seed; then
  tail -5 "$LOG" >&2
  echo "  投入が失敗。10秒おいて1回だけやり直す" >&2
  sleep 10
  run_seed || { tail -20 "$LOG" >&2; echo "  投入が2回失敗。ログ: ${LOG}" >&2; exit 1; }
fi
echo "  投入 OK（文の数 $(grep -c '"success": true' "$LOG" || true) / ログ: ${LOG}）"

echo "▶ 4/4 入った中身を seed と突き合わせ"
if [ "$WHERE" = "--local" ]; then
  python3 scripts/verify_seed_remote.py --data "data/${EXAM}" --exam "$EXAM" --local
else
  python3 scripts/verify_seed_remote.py --data "data/${EXAM}" --exam "$EXAM"
fi

echo
echo "完了: ${DB}（${WHERE}）"
