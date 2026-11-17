#!/usr/bin/env bash
# 対象の D1 に migrations/ が全部当たっているかを見る・当てる。
#
#   bash scripts/d1_migrations.sh <対象> check [--local]   # 未適用が 1 件でもあれば止める（exit 1）
#   bash scripts/d1_migrations.sh <対象> apply [--local]   # 未適用を当てる（既定は --remote。本番は当てる前にバックアップ）
#
# seed は今のスキーマの列（例: topics.round）を INSERT し、画面の SQL も同じ列を読む。
# 未適用のまま投入すると INSERT が落ち、未適用のまま配備すると「no such column」で 500 になる。
# だから deploy-pages.sh と seed_remote.sh は先頭で check を回し、finish_remote.sh は apply → 投入 → 配備の順に回す。
#
# apply は wrangler の確かめ（continue?）が出る。標準入力を端末から外すと wrangler は確かめを「yes」で進める
# （非対話の扱い）。CI=1 は付けない（付けると OAuth のログインを使えない）。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-}"; MODE="${2:-}"; WHERE="--remote"
[ "${3:-}" = "--local" ] && WHERE="--local"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
case "$MODE" in check|apply) ;; *) echo "第2引数は check か apply"; exit 1;; esac
DB=$(python3 scripts/targets.py db "$EXAM")

# 未適用の migrations を数える。0＝全部当たっている、1＝未適用がある、2＝一覧が取れない・読めない（確かめられない）。
# check は 1 と 2 のどちらでも失敗で終え、seed_remote.sh はその前で止まるので控えも投入もしない。
# @implements REQ-553
pending () {
  local out
  out=$(npx wrangler d1 migrations list "$DB" --env "$EXAM" "$WHERE" </dev/null 2>&1) || { echo "$out" | tail -5 >&2; echo "  migrations の一覧が取れない（${DB} ${WHERE}）" >&2; return 2; }
  # 出力は変数から直に読ませる（pipefail の下で echo からパイプで渡すと、grep -q が先に抜けて echo が SIGPIPE で落ちる）
  if grep -q "No migrations to apply" <<< "$out"; then return 0; fi
  if grep -q "Migrations to be applied" <<< "$out"; then
    echo "$out" | grep -oE "[0-9]{4}_[A-Za-z0-9_]+\.sql" | sed 's/^/    未適用: /' >&2
    return 1
  fi
  echo "$out" | tail -5 >&2; echo "  migrations の一覧の出力が読めない（${DB} ${WHERE}）" >&2; return 2
}

if [ "$MODE" = check ]; then
  rc=0; pending || rc=$?
  if [ "$rc" = 0 ]; then echo "  migrations は全部当たっている（${DB} ${WHERE}）"; exit 0; fi
  [ "$rc" = 2 ] && exit 1
  echo "✘ ${DB}（${WHERE}）に未適用の migrations がある。" >&2
  if [ "$WHERE" = --local ]; then
    echo "    ローカルは: bash scripts/d1_migrations.sh ${EXAM} apply --local && bash scripts/seed_remote.sh ${EXAM} --local" >&2
  else
    echo "    通常は: bash scripts/finish_remote.sh ${EXAM}（migrations → 投入 → 配備の順に回す）" >&2
    echo "    apply だけ当てて配備しない。新しい列を持つ seed を入れるまで画面は回を読めない（配備の前に check_d1_rounds.sh が止める）" >&2
  fi
  exit 1
fi

# apply
rc=0; pending || rc=$?
[ "$rc" = 2 ] && exit 1
if [ "$rc" = 0 ]; then echo "  当てる migrations は無い（${DB} ${WHERE}）"; exit 0; fi
if [ "$WHERE" = --remote ]; then
  echo "  当てる前に本番 D1 をバックアップ"
  bash scripts/backup_d1.sh "$EXAM"
fi
echo "  migrations を当てる: ${DB} ${WHERE}"
npx wrangler d1 migrations apply "$DB" --env "$EXAM" "$WHERE" </dev/null
pending || { echo "✘ 当てた後も未適用が残る。手で確かめる: npx wrangler d1 migrations apply ${DB} --env ${EXAM} ${WHERE}" >&2; exit 1; }
echo "  migrations は全部当たった（${DB} ${WHERE}）"
