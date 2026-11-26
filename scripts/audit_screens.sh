#!/usr/bin/env bash
# L5: 画面の検査 — 本物のブラウザで全画面 × 全状態のスクリーンショットと計測を機械採取する。
#
#   bash scripts/audit_screens.sh          # IT パスポート（既定）
#   bash scripts/audit_screens.sh ap       # 応用情報 午前（対象の ID は scripts/targets.py keys）
#   bash scripts/audit_screens.sh ip --out /path/to/dir
#
# 何を撮るかは docs/検査観点カタログ.md の「L5: 画面の検査 — 状態の行列」が仕様。
# 採取した結果は L6（使いやすさのレビュー）の入力になる。
#
# このスクリプトがやること:
#   1. フロントを試験ごとにビルド（vite build --mode <試験>）
#   2. wrangler dev を **8787** で起動（別の検査が 8788 を使うので固定する）
#   3. scripts/audit_fixtures.mjs で状態の違うテストアカウントを API 経由で作る
#      （手元の SSO の偽物が発行したコードを signInWithCode で換えて入る）
#   4. scripts/audit_screens.mjs で採取（PNG ＋ manifest.json）
#   5. 自分で起動した wrangler だけ止める
#
# すでに 8787 で同じ試験のアプリが動いていれば、ビルドも起動もせずそれを使う。
#
# **ローカル D1 の実データは壊さない。** 検査は API 経由でアカウントを足すだけで、
# DELETE は一切流さない。
set -uo pipefail
cd "$(dirname "$0")/.."

# 第 1 引数が選択肢（- で始まる）でなければ学びの key。登録簿（src/shared/targets.json）に無ければ、
# 組み立ても配備も起こさずに指定できる学びを示して止まる。省略すると ip
EXAM="ip"
if [[ -n "${1:-}" && "${1:-}" != -* ]]; then
  if [[ "$(python3 scripts/targets.py has "$1")" != "yes" ]]; then
    echo "!! 学び '$1' は登録簿（src/shared/targets.json）に無い。指定できる学び: $(python3 scripts/targets.py keys)"
    exit 1
  fi
  EXAM="$1"; shift
fi

PORT=8787
BASE="http://127.0.0.1:${PORT}"
# 8787 で別の対象が動いているのを見分ける印。画面の名（登録簿の title＝VITE_TITLE＝<title>）で突き合わせる
EXPECT_TITLE="$(python3 scripts/targets.py title "$EXAM")"
[ -n "$EXPECT_TITLE" ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }

echo "▶ 対象: ${EXAM}（${BASE}）"

STARTED_BY_US=0
DEV_PID=""
# この回の記録（wrangler dev のログ）は、回す環境の一時の置き場（TMPDIR）に作る。
# 成功で終えたら消し、失敗で終えたら残してその場所を示す。
# 後片付けの表示は標準エラーへ出す（標準出力の最後の行は、止まった道具が出す断りの形のまま残す）
TMP_ROOT="${TMPDIR:-/tmp}"
DEV_LOG="$(mktemp "${TMP_ROOT%/}/audit_wrangler.XXXXXX")"

# その回に起こした配備（npx とその子・孫。npx が shim なら npm exec・node wrangler・workerd が下に連なる）だけを止める。
# 道具が起こしていないプロセスは、配備に使う口を掴んでいても止めない。
# 起こした連なりは、起きた時刻と組にして起動を待つあいだから控えておく（先頭が先に終えて子が親を失っても控えから止められ、
# 番号が別のプロセスに使い回されていれば時刻が違うので止めない）。
# 片付けのできる止め方（SIGTERM）を送り、どれもいなくなるまで待つ（wrangler が手元の一時の置き場を片付けられる）。
# 待っても残る物だけを最後に SIGKILL で止める
STARTED=""
descendants_of() {
  local p
  for p in $(pgrep -P "$1" 2>/dev/null); do echo "$p"; descendants_of "$p"; done
}
started_at() {
  { ps -o lstart= -p "$1" 2>/dev/null || true; } | tr -s ' ' '_'
}
remember_started() {
  local p t
  for p in "$1" $(descendants_of "$1"); do
    case " $STARTED " in *" $p@"*) continue ;; esac
    t="$(started_at "$p")"
    if [ -n "$t" ]; then STARTED="$STARTED $p@$t"; fi
  done
}
stop_started() {
  local top="$1" tree="" entry p st alive=""
  remember_started "$top"
  for entry in $STARTED; do
    p="${entry%%@*}"
    if [ "$(started_at "$p")" = "${entry#*@}" ]; then tree="$tree $p"; fi
  done
  if [ -n "$tree" ]; then kill -TERM $tree 2>/dev/null || true; fi
  for _ in $(seq 1 150); do
    alive=""
    for p in $tree; do
      st="$(ps -o stat= -p "$p" 2>/dev/null || true)"
      if [ -n "$st" ] && [ "${st#Z}" = "$st" ]; then alive="$alive $p"; fi
    done
    [ -z "$alive" ] && break
    sleep 0.2
  done
  if [ -n "$alive" ]; then kill -KILL $alive 2>/dev/null || true; fi
  wait "$top" 2>/dev/null || true
}

cleanup() {
  local status=$?
  if [[ "$STARTED_BY_US" == "1" ]]; then
    echo "▶ wrangler dev を止める (pid ${DEV_PID})" >&2
    [[ -n "$DEV_PID" ]] && stop_started "$DEV_PID"
    STARTED_BY_US=0
  fi
  if [[ "$status" -eq 0 ]]; then rm -f "$DEV_LOG"; else echo "▶ この回の記録を残した: ${DEV_LOG}" >&2; fi
}
trap cleanup EXIT INT TERM

running_title() {
  curl -s -m 3 "${BASE}/" 2>/dev/null | tr -d '\n' | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p'
}

if curl -s -m 3 "${BASE}/api/health" >/dev/null 2>&1; then
  TITLE="$(running_title)"
  if [[ "$TITLE" == *"$EXPECT_TITLE"* ]]; then
    echo "▶ 8787 で ${EXAM} が起動済み。そのまま使う（title: ${TITLE}。まなびばの場所が手元の SSO の偽物でなければ audit_fixtures.mjs が止まる）"
  else
    echo "!! 8787 で別のものが動いている（title: ${TITLE:-不明}）。"
    echo "   ${EXAM} を撮るには止めてから実行するか、そちらを終了させること。"
    exit 1
  fi
else
  echo "▶ フロントをビルド（--mode ${EXAM}）"
  npx vite build --mode "$EXAM" >/dev/null || { echo "ビルドに失敗"; exit 1; }

  echo "▶ wrangler dev を起動（port ${PORT} / env ${EXAM}）"
  # まなびばの場所と共有秘密は、audit_fixtures.mjs が起こす手元の SSO の偽物（SSO_FAKE_PORT・SSO_FAKE_SECRET と同じ値）。
  # 検査用アカウントはその偽物が換えた使い捨てコードからだけ作る（学び側のパスワードの経路はどの配備にも無い）。
  # JWT_SECRET はこの採取専用の固定値（本番の値ではない）。渡さない配備ではトークンを発行も
  # 検証もしないので、検査用アカウントの作成（audit_fixtures.mjs）が 503 で止まる。
  npx wrangler dev --env "$EXAM" --port "$PORT" --ip 127.0.0.1 \
    --var "SSO_PORTAL_URL:http://127.0.0.1:8793" \
    --var "SSO_SECRET:audit-screens-local-shared-not-a-secret" \
    --var "JWT_SECRET:audit-screens-local-only-not-a-secret" >"$DEV_LOG" 2>&1 &
  DEV_PID=$!
  STARTED_BY_US=1

  # 起動には数十秒かかる。ヘルスチェックでポーリングする。
  for i in $(seq 1 90); do
    remember_started "$DEV_PID"
    if curl -s -m 2 "${BASE}/api/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "!! wrangler dev が落ちた。ログ:"; tail -30 "$DEV_LOG"; exit 1
    fi
    sleep 1
  done
  if ! curl -s -m 2 "${BASE}/api/health" >/dev/null 2>&1; then
    echo "!! wrangler dev が 90 秒で起動しなかった。ログ:"; tail -30 "$DEV_LOG"; exit 1
  fi
  remember_started "$DEV_PID"
  echo "   起動した（$(running_title)）"
fi

echo "▶ 検査用アカウントを用意する（API 経由。SQL は叩かない）"
node scripts/audit_fixtures.mjs --base "$BASE" || { echo "!! フィクスチャの作成に失敗" >&2; exit 1; }

echo "▶ 採取"
node scripts/audit_screens.mjs --exam "$EXAM" --base "$BASE" "$@"
STATUS=$?

exit $STATUS
