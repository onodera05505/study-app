#!/usr/bin/env bash
# git のフックを .githooks/ に向ける（クローンごとに一度）。
#
#   bash scripts/install_githooks.sh
#
# 入るもの: commit-msg（Conventional Commits の形式検査。依存なし）
set -euo pipefail
cd "$(dirname "$0")/.."

chmod +x .githooks/*
git config core.hooksPath .githooks
echo "✓ core.hooksPath = $(git config core.hooksPath)"
echo "  試す: echo 'ダメな件名' > /tmp/msg && sh .githooks/commit-msg /tmp/msg  # exit 1 になれば効いている"
