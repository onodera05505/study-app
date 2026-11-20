# 実行の記録の足場（ADR-0015）: bash が起動のたびに読むファイル（BASH_ENV）。
# 命令を実行する直前に「起動時の作業ディレクトリ・ファイル・行・関数の名前」をタブ区切りで記録のファイルへ書き足す。
# 標準出力・標準エラーには何も足さない（書けないときも黙る）。記録のファイルは TEST_RECORD_SH（run.mjs が worker の中で渡す）。
# 記録を取る間だけ、bash の特殊変数 $_ の値が変わる。自分で DEBUG の trap を張る道具は記録できない。
if [ -n "${TEST_RECORD_SH:-}" ]; then
  __test_record_start="$PWD"
  set -o functrace
  trap '{ printf "%s\t%s\t%s\t%s\n" "$__test_record_start" "${BASH_SOURCE[0]:-}" "$LINENO" "${FUNCNAME[0]:-}" >> "$TEST_RECORD_SH"; } 2>/dev/null' DEBUG
fi
