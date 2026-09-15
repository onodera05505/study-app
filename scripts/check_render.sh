#!/usr/bin/env bash
# 表示側（React コンポーネント）の描画検査。デプロイの門。
#
#   bash scripts/check_render.sh          # IT パスポート（既定）
#   bash scripts/check_render.sh ap       # 応用情報 午前
#
# jsdom で実データ全件（教材・問題解説）を本物のコンポーネントで描いて DOM を見る。
# 何を見ているかは scripts/check_render.tsx の先頭に書いてある。
#
# データ側の検査（check_materials / check_explanations / check_seed）が全部通っていても
# 画面だけ壊れていることがある（2026-09-01 の用語ポップがそれ）。そこを埋める。
#
# scripts/deploy-pages.sh がビルドの前にこれを呼ぶので、落ちればデプロイは走らない。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-ip}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }

npx tsx scripts/check_render.tsx --data "data/${EXAM}"
