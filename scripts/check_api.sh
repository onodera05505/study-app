#!/usr/bin/env bash
# API（L3）の検査。ローカルに wrangler dev を立てて実際に HTTP で当てる。
#
#   bash scripts/check_api.sh          # IT パスポート（既定）
#   bash scripts/check_api.sh ap       # 応用情報 午前
#
# 何を見ているかは scripts/check_api.py の先頭に書いてある（認証の境界・失敗時の形・
# 各 GET の形・件数の整合・セッションの一連の流れ・null と [] の区別）。
#
# ポートは 8788 に固定してある。開発用の wrangler dev（8787）と衝突させないため。
# 既に 8788 で動いていればそれを使い、無ければここで起動して、終わったら落とす。
# check_api.py が起こす手元の SSO の偽物（偽のまなびば）は 8792（番号の出所は check_api.py の SSO_FAKE_PORT）。
# 8791 は check_portal_api のまなびば、8790 は check_sso_flow のまなびばが使うので、同時に回してもぶつからない。
#
# 本番には当てない。ローカルの D1 だけを見る。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-ip}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }

PORT=8788
# 手元の SSO の偽物の口（check_api.py の SSO_FAKE_PORT から読む）
SSO_FAKE_PORT="$(sed -n 's/^SSO_FAKE_PORT = \([0-9][0-9]*\)$/\1/p' scripts/check_api.py)"
[ -n "$SSO_FAKE_PORT" ] || { echo "scripts/check_api.py に SSO_FAKE_PORT が無い"; exit 1; }
BASE="http://127.0.0.1:${PORT}"
# この回の記録（wrangler dev のログ）は、回す環境の一時の置き場（TMPDIR）に作る。プロジェクト直下には残さない。
# 成功で終えたら消し、失敗で終えたら残してその場所を標準エラーに示す
TMP_ROOT="${TMPDIR:-/tmp}"
LOG="$(mktemp "${TMP_ROOT%/}/check_api_${EXAM}.XXXXXX")"
PID=""

# その回に起こした配備（npx とその子・孫。npx が shim なら npm exec・node wrangler・workerd が下に連なる）を止める。
# 先に連なりを控えてから片付けのできる止め方（SIGTERM）を送り、どれもいなくなるまで待つ（wrangler が手元の一時の置き場を片付けられる）。
# 待っても残る物だけを最後に SIGKILL で止める
descendants_of() {
  local p
  for p in $(pgrep -P "$1" 2>/dev/null); do echo "$p"; descendants_of "$p"; done
}
stop_started() {
  local top="$1" tree p st alive=""
  tree="$top $(descendants_of "$top")"
  kill -TERM $tree 2>/dev/null || true
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
  if [ -n "$PID" ]; then
    stop_started "$PID"
    # 口はこの検査専用なので、止めたあとも掴んでいる物があれば掃除してよい。
    LEFT=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
    if [ -n "$LEFT" ]; then kill $LEFT 2>/dev/null || true; fi
  fi
  if [ "$status" -eq 0 ]; then rm -f "$LOG"; else echo "▶ この回の記録を残した: $LOG" >&2; fi
}
trap cleanup EXIT

# 起動済みならそれを使う。ただし別の試験の dev が残っている可能性があるので、
# 中身の一致は check_api.py の「件数の整合」（API と ローカル D1 の突き合わせ）で
# 落ちる。ip の dev を ap の D1 と突き合わせれば件数が合わずエラーになる。
if curl -fsS --max-time 3 "${BASE}/api/health" >/dev/null 2>&1; then
  echo "▶ すでに ${PORT} で動いているのでそれを使う（試験の取り違えは件数の整合で、まなびばの場所の違いは認証の形の検査で落ちる）"
else
  # wrangler dev は dist を assets として bind する。無いとそもそも起動しない。
  if [ ! -f dist/index.html ]; then
    echo "▶ dist が無いのでビルド（--mode ${EXAM}）"
    npx vite build --mode "$EXAM"
  fi

  echo "▶ wrangler dev を起動（--env ${EXAM} / port ${PORT}）"
  # まなびばの場所と共有秘密は、check_api.py が起こす手元の SSO の偽物（SSO_FAKE_PORT・SSO_FAKE_SECRET と同じ値）。
  # 検査の本人はその偽物が換えた使い捨てコードからだけ作る（学び側のパスワードの経路はどの配備にも無い）。
  # JWT_SECRET はローカルのこの検査専用の固定値（本番の値ではない）。渡さない配備ではトークンを発行も検証もしない。
  npx wrangler dev --env "$EXAM" --port "$PORT" --ip 127.0.0.1 \
    --var "SSO_PORTAL_URL:http://127.0.0.1:${SSO_FAKE_PORT}" \
    --var "SSO_SECRET:check-api-local-shared-not-a-secret" \
    --var "JWT_SECRET:check-api-local-only-not-a-secret" \
    --show-interactive-dev-session=false >"$LOG" 2>&1 &
  PID=$!

  for _ in $(seq 1 90); do
    if curl -fsS --max-time 2 "${BASE}/api/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "wrangler dev が起動せずに終了した。$LOG を見ること"; tail -20 "$LOG"; exit 1
    fi
    sleep 1
  done
  if ! curl -fsS --max-time 2 "${BASE}/api/health" >/dev/null 2>&1; then
    echo "90 秒待っても ${BASE} が応答しない。$LOG を見ること"; tail -20 "$LOG"; exit 1
  fi
fi

python3 scripts/check_api.py --exam "$EXAM" --base "$BASE"
