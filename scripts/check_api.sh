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
#
# 本番には当てない。ローカルの D1 だけを見る。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-ip}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }

PORT=8788
BASE="http://127.0.0.1:${PORT}"
# ログはプロジェクト直下に残さない（このディレクトリは git 管理外なので掃除されない）
LOG="$(mktemp -t "check_api_${EXAM}")"
PID=""

cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    # wrangler は workerd を孫プロセスで持つ。npx 経由なので kill だけでは
    # 取り残され、次回の起動がポートで詰まる。8788 はこの検査専用なので
    # 掴んでいるものを掃除してよい。
    sleep 1
    LEFT=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
    if [ -n "$LEFT" ]; then kill $LEFT 2>/dev/null || true; fi
  fi
}
trap cleanup EXIT

# 起動済みならそれを使う。ただし別の試験の dev が残っている可能性があるので、
# 中身の一致は check_api.py の「件数の整合」（API と ローカル D1 の突き合わせ）で
# 落ちる。ip の dev を ap の D1 と突き合わせれば件数が合わずエラーになる。
if curl -fsS --max-time 3 "${BASE}/api/health" >/dev/null 2>&1; then
  echo "▶ すでに ${PORT} で動いているのでそれを使う（試験の取り違えは件数の整合で落ちる）"
else
  # wrangler dev は dist を assets として bind する。無いとそもそも起動しない。
  if [ ! -f dist/index.html ]; then
    echo "▶ dist が無いのでビルド（--mode ${EXAM}）"
    npx vite build --mode "$EXAM"
  fi

  echo "▶ wrangler dev を起動（--env ${EXAM} / port ${PORT}）"
  # wrangler.jsonc の env は本番どおり SSO_PORTAL_URL を持つ（学び側のパスワード登録・ログインは 404）。
  # この検査はパスワードの経路で検査用アカウントを作るので、SSO を空で上書きして切る。
  # SSO が有効な経路は scripts/check_sso_flow.py（ローカル）と check_sso_prod.sh（本番）が見る（2026-09-17 msg で発覚）
  npx wrangler dev --env "$EXAM" --port "$PORT" --ip 127.0.0.1 --var "SSO_PORTAL_URL:" \
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
