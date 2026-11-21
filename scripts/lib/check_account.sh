# 本番に触る道具が、ほかの何よりも先にログイン中の配備先のアカウントを決めたアカウントと照らす部品。
#
#   source scripts/lib/check_account.sh        # シェルの道具（リポジトリの根で source する）
#   bash scripts/lib/check_account.sh          # Python の道具（account_check.py）が子プロセスで回す
#
# 決めたアカウントは配備先の一覧のアカウント（scripts/targets.py account）、ログイン中のアカウントは wrangler whoami が答える並び。
# 並びに 2 つ以上のアカウントがあるときは、決めたアカウントが並びのどこかにあれば合うとする。
# 無いか、ログイン中のアカウントが分からなければ（ログインしていない）、理由を 1 行示して 1 で終える。
# 環境変数で与えた向け先のアカウント（CLOUDFLARE_ACCOUNT_ID）が決めたアカウントと違えば、並びを問わず、
# ログイン中の並びを問い合わせる前に理由を 1 行示して 1 で終える（無いか同じなら、並びだけで照らす）。
# source した側では exit がその道具ごと終えるので、照らす問い合わせのほかは何も起きない。
# 固定した版の配備の道具で照らす道具は、source の前に ACCOUNT_WRANGLER にその道具のパスを置く（無ければ npx wrangler）。
ACCOUNT_WANT="$(python3 "$(dirname "${BASH_SOURCE[0]}")/../targets.py" account)"
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ "$CLOUDFLARE_ACCOUNT_ID" != "$ACCOUNT_WANT" ]; then
  echo "環境変数 CLOUDFLARE_ACCOUNT_ID の向け先のアカウント（${CLOUDFLARE_ACCOUNT_ID}）が想定（${ACCOUNT_WANT}）と違う。環境変数を外すか、想定のアカウントにしてから回す"
  exit 1
fi
# 道具の出力は一度変数に受けてから読む（pipefail の下で読み手が先に抜けると、書き手が SIGPIPE で落ちる）
if [ -n "${ACCOUNT_WRANGLER:-}" ]; then
  ACCOUNT_WHOAMI="$("$ACCOUNT_WRANGLER" whoami 2>/dev/null || true)"
else
  ACCOUNT_WHOAMI="$(npx wrangler whoami 2>/dev/null || true)"
fi
# 並びの 32 桁を前から順に読む。決めたアカウントがあればそれを、無ければ最初の物を「ログイン中」として示す
ACCOUNT_RE='[0-9a-f]{32}'; ACCOUNT_HAVE=""; ACCOUNT_REST="$ACCOUNT_WHOAMI"
while [[ $ACCOUNT_REST =~ $ACCOUNT_RE ]]; do
  ACCOUNT_SEEN="${BASH_REMATCH[0]}"
  if [ -z "$ACCOUNT_HAVE" ] || [ "$ACCOUNT_SEEN" = "$ACCOUNT_WANT" ]; then ACCOUNT_HAVE="$ACCOUNT_SEEN"; fi
  if [ "$ACCOUNT_HAVE" = "$ACCOUNT_WANT" ]; then break; fi
  ACCOUNT_REST="${ACCOUNT_REST#*"$ACCOUNT_SEEN"}"
done
[ "$ACCOUNT_HAVE" = "$ACCOUNT_WANT" ] || { echo "ログイン中のアカウント（${ACCOUNT_HAVE:-不明}）が想定（${ACCOUNT_WANT}）と違う。npx wrangler login で個人アカウントを選び直す"; exit 1; }
