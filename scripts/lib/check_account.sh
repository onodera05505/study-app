# 本番に触る道具が、ほかの何よりも先にログイン中の配備先のアカウントを決めたアカウントと照らす部品。
#
#   source scripts/lib/check_account.sh        # シェルの道具（リポジトリの根で source する）
#   bash scripts/lib/check_account.sh          # Python の道具（account_check.py）が子プロセスで回す
#
# 決めたアカウントは配備先の一覧のアカウント（scripts/targets.py account）、ログイン中のアカウントは wrangler whoami が答える並び。
# 並びに 2 つ以上のアカウントがあるときは、決めたアカウントが並びのどこかにあれば合うとする。
# 無いか、ログイン中のアカウントが分からなければ（ログインしていない）、理由を 1 行示して 1 で終える。
# source した側では exit がその道具ごと終えるので、照らす問い合わせのほかは何も起きない。
ACCOUNT_WANT="$(python3 "$(dirname "${BASH_SOURCE[0]}")/../targets.py" account)"
# 道具の出力は一度変数に受けてから読む（pipefail の下で読み手が先に抜けると、書き手が SIGPIPE で落ちる）
ACCOUNT_WHOAMI="$(npx wrangler whoami 2>/dev/null || true)"
# 並びの 32 桁を前から順に読む。決めたアカウントがあればそれを、無ければ最初の物を「ログイン中」として示す
ACCOUNT_RE='[0-9a-f]{32}'; ACCOUNT_HAVE=""; ACCOUNT_REST="$ACCOUNT_WHOAMI"
while [[ $ACCOUNT_REST =~ $ACCOUNT_RE ]]; do
  ACCOUNT_SEEN="${BASH_REMATCH[0]}"
  if [ -z "$ACCOUNT_HAVE" ] || [ "$ACCOUNT_SEEN" = "$ACCOUNT_WANT" ]; then ACCOUNT_HAVE="$ACCOUNT_SEEN"; fi
  if [ "$ACCOUNT_HAVE" = "$ACCOUNT_WANT" ]; then break; fi
  ACCOUNT_REST="${ACCOUNT_REST#*"$ACCOUNT_SEEN"}"
done
[ "$ACCOUNT_HAVE" = "$ACCOUNT_WANT" ] || { echo "ログイン中のアカウント（${ACCOUNT_HAVE:-不明}）が想定（${ACCOUNT_WANT}）と違う。npx wrangler login で個人アカウントを選び直す"; exit 1; }
