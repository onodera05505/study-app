#!/usr/bin/env bash
# L5: 画面の検査 — 本物のブラウザで全画面 × 全状態のスクリーンショットと計測を機械採取する。
#
#   bash scripts/audit_screens.sh          # IT パスポート（既定）
#   bash scripts/audit_screens.sh ap       # 応用情報 午前
#   bash scripts/audit_screens.sh ip --out /path/to/dir
#
# 何を撮るかは docs/検査観点カタログ.md の「L5: 画面の検査 — 状態の行列」が仕様。
# 採取した結果は L6（使いやすさのレビュー）の入力になる。
#
# このスクリプトがやること:
#   1. フロントを試験ごとにビルド（vite build --mode <試験>）
#   2. wrangler dev を **8787** で起動（別の検査が 8788 を使うので固定する）
#   3. scripts/audit_fixtures.mjs で状態の違うテストアカウントを API 経由で作る
#   4. scripts/audit_screens.mjs で採取（PNG ＋ manifest.json）
#   5. 自分で起動した wrangler だけ止める
#
# すでに 8787 で同じ試験のアプリが動いていれば、ビルドも起動もせずそれを使う。
#
# **ローカル D1 の実データは壊さない。** 検査は API 経由でアカウントを足すだけで、
# DELETE は一切流さない。
set -uo pipefail
cd "$(dirname "$0")/.."

EXAM="ip"
if [[ "${1:-}" == "ip" || "${1:-}" == "ap" ]]; then EXAM="$1"; shift; fi

PORT=8787
BASE="http://127.0.0.1:${PORT}"
case "$EXAM" in
  ip) EXPECT_TITLE="IT パスポート" ;;
  ap) EXPECT_TITLE="応用情報" ;;
  *)  echo "第1引数は ip か ap"; exit 1 ;;
esac

echo "▶ 対象: ${EXAM}（${BASE}）"

STARTED_BY_US=0
DEV_PID=""
DEV_LOG="$(mktemp -t audit_wrangler)"

cleanup() {
  if [[ "$STARTED_BY_US" == "1" ]]; then
    echo "▶ wrangler dev を止める (pid ${DEV_PID})"
    [[ -n "$DEV_PID" ]] && kill "$DEV_PID" 2>/dev/null
    # npx 越しに起動すると、wrangler の子（workerd）が親の SIGTERM で道連れにならず、
    # 8787 を掴んだまま残る。次回の実行が「起動済み」と誤認するので、
    # **自分で起こしたときだけ** ポートを掴んでいるものごと落とす。
    sleep 1
    STRAY="$(lsof -ti:"$PORT" 2>/dev/null)"
    [[ -n "$STRAY" ]] && kill $STRAY 2>/dev/null
    wait "$DEV_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

running_title() {
  curl -s -m 3 "${BASE}/" 2>/dev/null | tr -d '\n' | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p'
}

if curl -s -m 3 "${BASE}/api/health" >/dev/null 2>&1; then
  TITLE="$(running_title)"
  if [[ "$TITLE" == *"$EXPECT_TITLE"* ]]; then
    echo "▶ 8787 で ${EXAM} が起動済み。そのまま使う（title: ${TITLE}）"
  else
    echo "!! 8787 で別のものが動いている（title: ${TITLE:-不明}）。"
    echo "   ${EXAM} を撮るには止めてから実行するか、そちらを終了させること。"
    exit 1
  fi
else
  echo "▶ フロントをビルド（--mode ${EXAM}）"
  npx vite build --mode "$EXAM" >/dev/null || { echo "ビルドに失敗"; exit 1; }

  echo "▶ wrangler dev を起動（port ${PORT} / env ${EXAM}）"
  npx wrangler dev --env "$EXAM" --port "$PORT" --ip 127.0.0.1 >"$DEV_LOG" 2>&1 &
  DEV_PID=$!
  STARTED_BY_US=1

  # 起動には数十秒かかる。ヘルスチェックでポーリングする。
  for i in $(seq 1 90); do
    if curl -s -m 2 "${BASE}/api/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "!! wrangler dev が落ちた。ログ:"; tail -30 "$DEV_LOG"; exit 1
    fi
    sleep 1
  done
  if ! curl -s -m 2 "${BASE}/api/health" >/dev/null 2>&1; then
    echo "!! wrangler dev が 90 秒で起動しなかった。ログ:"; tail -30 "$DEV_LOG"; exit 1
  fi
  echo "   起動した（$(running_title)）"
fi

echo "▶ 検査用アカウントを用意する（API 経由。SQL は叩かない）"
node scripts/audit_fixtures.mjs --base "$BASE" || { echo "!! フィクスチャの作成に失敗"; exit 1; }

echo "▶ 採取"
node scripts/audit_screens.mjs --exam "$EXAM" --base "$BASE" "$@"
STATUS=$?

exit $STATUS
