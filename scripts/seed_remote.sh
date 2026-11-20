#!/usr/bin/env bash
# seed を D1 に流す。投入の前後に門を置いた1本道。
#
#   bash scripts/seed_remote.sh ip            # 本番（--remote）
#   bash scripts/seed_remote.sh ap
#   bash scripts/seed_remote.sh ip --local    # ローカル D1 でのリハーサル（バックアップは省く）
#
# 順番:
#   0. d1_migrations.sh check 未適用の migrations があれば止める（当てるのは d1_migrations.sh apply か finish_remote.sh）
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

# 投入を流し、失敗したら 10 秒おいて 1 回だけやり直す。2 回目も落ちたら突き合わせに進まずに止める。
# --remote は Authentication error [code: 10000] で落ちることがあり、そのとき DB は元のまま（docs/応用情報を追加する.md の落とし穴）。
# wrangler は文ごとの結果 JSON を全部出す（1万行超）。ログに逃がして、失敗時だけ末尾を見せる。
# 引数: 保存先の名前・学び・流す先（--remote か --local）・投入のファイル・ログのファイル
# @implements REQ-556
run_seed() {
  local db="$1" exam="$2" where="$3" seed="$4" log="$5"
  if npx wrangler d1 execute "$db" --env "$exam" "$where" --file="$seed" >"$log" 2>&1; then return 0; fi
  tail -5 "$log" >&2
  echo "  投入が失敗。10秒おいて1回だけやり直す" >&2
  sleep 10
  if npx wrangler d1 execute "$db" --env "$exam" "$where" --file="$seed" >"$log" 2>&1; then return 0; fi
  tail -20 "$log" >&2
  echo "  投入が2回失敗。ログ: ${log}" >&2
  exit 1
}

# 断る: 人が読む文を出したあと、標準出力の最後の行に断りの形（契約の ToolError）を 1 行で出し、終了コード 1 で終える。
# 断りの種類の名前は scripts/lib/tool_refusal.py が src/shared/error-codes.json から引く（出所に無い名前は出せない）。
# 引数: 断りの種類の名前・人が読む文・断りの形に載せる理由
# @implements REQ-571
refuse() {
  echo "$2"
  python3 scripts/lib/tool_refusal.py "$1" "$3"
  exit 1
}

# 断るとき（第 2 引数の誤り・登録簿に無い学び・投入が無い）は、門も控えも回さず保存先に何も流さずに終了コード 1 で終える。
# 第 2 引数は学びより先に見る（契約 seedRemote の errors の順）。
# @operation UC-032#seedRemote
# @implements REQ-564, REQ-552
main() {
  local exam="${1:-}" where="--remote"
  case "${2:-}" in
    "") ;;
    --local) where="--local" ;;
    *) refuse INVALID_INPUT "第2引数は空か --local（渡された値: ${2}）" "第 2 引数が空でも --local でもない（${2}）" ;;
  esac
  [ "$(python3 scripts/targets.py has "$exam")" = yes ] ||
    refuse INVALID_INPUT "第1引数は対象の ID（$(python3 scripts/targets.py keys)）" "登録簿に無い学び『${exam}』"
  local db seed="data/${exam}/seed.sql"
  db=$(python3 scripts/targets.py db "$exam")
  [ -f "$seed" ] ||
    refuse NOT_FOUND "seed が無い: ${seed}（先に python3 scripts/build_seed.py --data data/${exam}）" "その学びの投入が書き出されていない: ${seed}"

  echo "▶ 0/4 D1 に migrations が全部当たっているか（未適用だと seed の新しい列の INSERT が落ちる）"
  bash scripts/d1_migrations.sh "$exam" check "$where"

  # @implements REQ-554, BR-032
  echo "▶ 1/4 seed の中身を検査"
  python3 scripts/check_seed.py --data "data/${exam}"

  # @implements REQ-555
  if [ "$where" = "--remote" ]; then
    echo "▶ 2/4 本番 D1 をバックアップ"
    bash scripts/backup_d1.sh "$exam"
  else
    echo "▶ 2/4 バックアップは省略（--local）"
  fi

  echo "▶ 3/4 投入: ${db} ${where} ← ${seed}"
  local log
  log=$(mktemp -t "seed_${exam}").log
  run_seed "$db" "$exam" "$where" "$seed" "$log"
  echo "  投入 OK（文の数 $(grep -c '"success": true' "$log" || true) / ログ: ${log}）"

  # @implements REQ-557
  echo "▶ 4/4 入った中身を seed と突き合わせ"
  if [ "$where" = "--local" ]; then
    python3 scripts/verify_seed_remote.py --data "data/${exam}" --exam "$exam" --local
  else
    python3 scripts/verify_seed_remote.py --data "data/${exam}" --exam "$exam"
  fi

  echo
  echo "完了: ${db}（${where}）"
}

main "$@"
