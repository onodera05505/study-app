#!/usr/bin/env bash
# まなびば（入口。認証と権限の正本。要件 §15）の API の検査。
# ローカルに wrangler dev を立てて実際に HTTP で当てる。学び側の check_api.sh と同じ作り。
#
#   bash scripts/check_portal_api.sh
#
# 何を見ているかは scripts/check_portal_api.py の先頭に書いてある
# （ログインと Cookie・/sso/start・コードの交換・管理・自分への保護・自分の設定・セキュリティヘッダ）。
#
# ポートは 8791 に固定してある。開発用（8787）・学び側の check_api（8788）と、その偽のまなびば（8792）・
# check_sso_flow のまなびば（8790）と衝突させないため。
#
# 本番には当てない。ローカルの D1（portal/.wrangler）だけを見る。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8791
BASE="http://127.0.0.1:${PORT}"
# 共有秘密は検査の中だけの値。本番の SSO_SECRET は読まない（読む必要がない）
SECRET="portalcheck-secret"
# この回の記録（wrangler dev のログ）は、回す環境の一時の置き場（TMPDIR）に作る。
# 成功で終えたら消し、失敗で終えたら残してその場所を標準エラーに示す
TMP_ROOT="${TMPDIR:-/tmp}"
LOG="$(mktemp "${TMP_ROOT%/}/check_portal_api.XXXXXX")"
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

# 静的ファイル（dist）は assets として bind される。無いと wrangler dev がそもそも起動しない。
if [ ! -f portal/dist/index.html ]; then
  echo "▶ portal/dist が無いので組み立て"
  python3 scripts/build_portal.py
fi

echo "▶ ローカル D1（${PWD}/portal/.wrangler）にマイグレーション"
( cd portal && npx wrangler d1 migrations apply manabiba-db --local )

if curl -fsS --max-time 3 "${BASE}/api/health" >/dev/null 2>&1; then
  echo "▶ すでに ${PORT} で動いているのでそれを使う（SSO_SECRET が違うと交換の検査で落ちる）"
else
  echo "▶ wrangler dev を起動（port ${PORT}）"
  ( cd portal && exec npx wrangler dev --port "$PORT" --ip 127.0.0.1 --var "SSO_SECRET:${SECRET}" \
      --show-interactive-dev-session=false ) >"$LOG" 2>&1 &
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

python3 scripts/check_portal_api.py --base "$BASE" --secret "$SECRET"
