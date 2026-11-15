#!/usr/bin/env bash
# 表示側（React コンポーネント）の描画検査。デプロイの門。
#
#   bash scripts/check_render.sh          # IT パスポート（既定）
#   bash scripts/check_render.sh ap       # 応用情報 午前
#
# jsdom で実データ全件（教材・問題解説）を本物のコンポーネントで描いて DOM を見る。
# 教材は配る本文と同じ選び方（scripts/material_generations.py）で論点ごとに世代を選ぶ。
# 何を見ているかは scripts/check_render.tsx の先頭に書いてある。
#
# データ側の検査（check_materials / check_explanations / check_seed）が全部通っていても
# 画面だけ壊れていることがある。そこを埋める。
#
# 学びの置き場は、呼んだ作業ディレクトリの data/<対象>。標準出力は契約 UC-027 の checkRender の結果の JSON 1 つ、
# 人が読む報告は標準エラー。
#
# scripts/deploy-pages.sh が、ビルドして版の印を書いた後・配信の前にこれを呼ぶので、落ちればデプロイは走らない。
# 単独で回すと、版の印の項目は手元の dist/ を見る（dist/ が無ければ警告、時刻の無い印はエラー）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

EXAM="${1:-ip}"
python3 "$ROOT/scripts/material_generations.py" --data "data/${EXAM//\//_}" --registered --refusal-only || exit 1

# 学びの置き場は呼んだ作業ディレクトリから決め、tsx はリポジトリの根で回す（根の tsconfig が JSX の変換を決める）
DATA="$(pwd)/data/${EXAM}"
cd "$ROOT"
npx tsx scripts/check_render.tsx --data "$DATA"
