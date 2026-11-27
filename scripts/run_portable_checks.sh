#!/usr/bin/env bash
# 手元に依らない検査だけを回す（npm run test:ci。共有の置き場の検査が回す入口）。引数は無い。
#
#   bash scripts/run_portable_checks.sh
#
# 回す順:
#   1. 検査の振り分け（scripts/classify_checks.ts）。振り分けが落ちれば（名前と中身の食い違いがあるか、リポジトリが追跡する物を確かめられない）、
#      振り分けの道具が示した理由をそのまま示して、ほかの検査もテストも回さずに 1 で終える
#   2. 仕様と紐づきの検査（原本 harness の verify --level lint。設定の形・lint spec・lint refs・lint entry）
#   3. 入口の一覧（harness.config.json の commands.list_entries）と、その突き合わせ（原本 harness の lint entries --from）
#   4. 手元に依らない UC の契約の実例（原本 harness の run cases に、その UC を --uc で 1 つずつ渡す。UC を絞らない確かめは起こさない）
#   5. 型（commands.typecheck）
#   6. 静的な門（commands.lint）
#   7. 手元に依らないテストのファイル（単体テストの組 portable）
# 2 から 7 は、どれかが落ちても残りを回し、最後にまとめて成否を返す（落ちた物の名前を挙げる）。
# 手元だけのテストのファイル・手元だけの UC の契約の実例・実行の記録の門（lint coverage）は回さず、
# 最後に、手元の入口（npm test）が受け持つ物としてその名前を示す。
#
# コマンドは harness.config.json の commands から読む。作業の場所はこのファイルの 1 つ上の置き場（リポジトリの根）。
set -uo pipefail
cd "$(dirname "$0")/.."

HARNESS=(node .harness/bin/harness.mjs)
command_of() {
  node -e 'const c = JSON.parse(require("fs").readFileSync("harness.config.json", "utf8")).commands[process.argv[1]]; if (typeof c !== "string") process.exit(1); process.stdout.write(c)' "$1"
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/run_portable_checks.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. 振り分け
echo "== 検査の振り分け（scripts/classify_checks.ts）"
if ! npx tsx scripts/classify_checks.ts >"$TMP/classified"; then
  cat "$TMP/classified"
  echo "✘ 検査の振り分けが通らない（理由は上に示す）ので、ほかの検査もテストも回さずに終える" >&2
  exit 1
fi
cat "$TMP/classified"

# 振り分けの出力の組（見出しの行の頭で見分け、2 字下げの行を名前と読む）を、組ごとのファイルに分ける
awk -v dir="$TMP" '
  /^手元に依らないテストのファイル/ { out = dir "/portable_tests"; next }
  /^手元だけのテストのファイル/ { out = dir "/local_tests"; next }
  /^手元に依らない UC/ { out = dir "/portable_ucs"; next }
  /^手元だけの UC/ { out = dir "/local_ucs"; next }
  /^  [^ ]/ { if (out) { sub(/^  /, ""); print > out } }
' "$TMP/classified"
for g in portable_tests local_tests portable_ucs local_ucs; do touch "$TMP/$g"; done

FAILED=()
step() {
  local name="$1"
  shift
  echo "== $name"
  if ! "$@"; then
    FAILED+=("$name")
    echo "✘ $name が通らない" >&2
  fi
}

# 2. 仕様と紐づきの検査
step "仕様と紐づきの検査（harness verify --level lint）" "${HARNESS[@]}" verify --level lint

# 3. 入口の一覧と突き合わせ
entries() {
  local list
  list="$(command_of list_entries)" || { echo "harness.config.json に commands.list_entries が無い" >&2; return 1; }
  bash -c "$list" >"$TMP/entries.jsonl" || { echo "入口の一覧（$list）が通らない" >&2; return 1; }
  "${HARNESS[@]}" lint entries --from "$TMP/entries.jsonl"
}
step "入口の一覧の突き合わせ（commands.list_entries → harness lint entries）" entries

# 4. 手元に依らない UC の契約の実例
cases() {
  local args=()
  while IFS= read -r uc; do [ -n "$uc" ] && args+=(--uc "$uc"); done <"$TMP/portable_ucs"
  if [ "${#args[@]}" -eq 0 ]; then
    echo "手元に依らない UC が無いので、契約の実例は回さない"
    return 0
  fi
  "${HARNESS[@]}" run cases "${args[@]}"
}
step "手元に依らない UC の契約の実例（harness run cases --uc …）" cases

# 5・6. 型と静的な門
configured() {
  local c
  c="$(command_of "$1")" || { echo "harness.config.json に commands.$1 が無い" >&2; return 1; }
  bash -c "$c"
}
step "型（commands.typecheck）" configured typecheck
step "静的な門（commands.lint）" configured lint

# 7. 手元に依らないテストのファイル
step "手元に依らないテストのファイル（vitest の組 portable）" npx vitest run --project portable

echo
echo "== 手元の入口（npm test）が受け持つ物（ここでは回していない）"
echo "手元だけのテストのファイル:"
sed 's/^/  /' "$TMP/local_tests"
echo "手元だけの UC（契約の実例）:"
sed 's/^/  /' "$TMP/local_ucs"
echo "実行の記録の門: lint coverage"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "✘ 通らなかった検査 ${#FAILED[@]} 件:" >&2
  for f in "${FAILED[@]}"; do echo "  $f" >&2; done
  exit 1
fi
echo
echo "✓ 手元に依らない検査はすべて通った"
