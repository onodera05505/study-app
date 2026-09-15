#!/usr/bin/env bash
# ロードマップ試作（itc）を本番へ出す 1 本道。**先に `npx wrangler login` を対話端末で済ませておく**
# （2026-09-15 未明、OAuth トークンが失効していて自動では作れなかった）。
#
#   bash scripts/setup_itc_remote.sh <合言葉>
#
# やること（どれか落ちたら止まる。既に済んでいる段は飛ばす）:
#   1. D1 `study-app-itc-db` を作り、ID を wrangler.jsonc の env.itc に書く
#   2. マイグレーションを本番 D1 に当てる（0000〜0005。0005 は topics.sort_order）
#   3. Pages プロジェクト `itc-roadmap` を作る
#   4. secret: JWT_SECRET（乱数）と SIGNUP_CODE（引数の合言葉）
#   5. scripts/deploy-pages.sh itc（描画検査 → 文書の門 → ビルド → デプロイ）
#   6. scripts/seed_remote.sh itc（check_seed → backup → 投入 → 突き合わせ）
# 完了後の URL: https://itc-roadmap.pages.dev
set -euo pipefail
cd "$(dirname "$0")/.."
CODE="${1:?第1引数: 新規登録の合言葉（SIGNUP_CODE）}"
DB=study-app-itc-db; PROJECT=itc-roadmap

echo "▶ 0/6 ログイン状態"
npx wrangler whoami >/dev/null 2>&1 || { echo "wrangler にログインしていない。対話端末で npx wrangler login を実行してから再実行"; exit 1; }

# アカウントの取り違えを止める門（2026-09-15: 同じ Mac で別プロジェクトが別アカウントでログインし、
# study-app の D1 が「無い（7404）」と言われた）。study-app の本番 Pages が見えるアカウントでなければ進めない。
if ! npx wrangler pages project list 2>/dev/null | grep -q "itpass-study"; then
  echo "このログインのアカウントには study-app の本番（itpass-study）が無い。study-app と同じアカウントで npx wrangler login をやり直す（今のアカウント: $(npx wrangler whoami 2>/dev/null | grep -o '[^ ]*@[^ ]*' | head -1)）"
  exit 1
fi

echo "▶ 1/6 D1 ${DB}"
if grep -q "PLACEHOLDER-run-scripts/setup_itc_remote.sh" wrangler.jsonc; then
  ID=$(npx wrangler d1 list --json | python3 -c "import json,sys;print(next((d['uuid'] for d in json.load(sys.stdin) if d['name']=='$DB'),''))")
  if [ -z "$ID" ]; then
    npx wrangler d1 create "$DB" --location apac >/dev/null
    ID=$(npx wrangler d1 list --json | python3 -c "import json,sys;print(next(d['uuid'] for d in json.load(sys.stdin) if d['name']=='$DB'))")
    echo "  作成: $ID"
  else
    echo "  既にある: $ID"
  fi
  python3 - "$ID" <<'PY'
import sys, pathlib
p = pathlib.Path("wrangler.jsonc"); s = p.read_text(encoding="utf-8")
p.write_text(s.replace("PLACEHOLDER-run-scripts/setup_itc_remote.sh", sys.argv[1], 1), encoding="utf-8")
PY
  echo "  wrangler.jsonc に ID を書いた（コミットすること）"
else
  echo "  wrangler.jsonc に ID あり"
fi

echo "▶ 2/6 マイグレーション（本番）"
npx wrangler d1 migrations apply "$DB" --env itc --remote

echo "▶ 3/6 Pages プロジェクト ${PROJECT}"
if ! npx wrangler pages project list 2>/dev/null | grep -q "^│ ${PROJECT} "; then
  npx wrangler pages project create "$PROJECT" --production-branch main
else
  echo "  既にある"
fi

echo "▶ 4/6 secret（JWT_SECRET は乱数、SIGNUP_CODE は引数）"
python3 -c "import secrets;print(secrets.token_hex(32))" | npx wrangler pages secret put JWT_SECRET --project-name "$PROJECT"
printf '%s' "$CODE" | npx wrangler pages secret put SIGNUP_CODE --project-name "$PROJECT"

echo "▶ 5/6 デプロイ（secret は再デプロイで効く）"
bash scripts/deploy-pages.sh itc

echo "▶ 6/6 seed 投入"
python3 scripts/build_seed.py --data data/itc >/dev/null
bash scripts/seed_remote.sh itc

echo
echo "完了: https://${PROJECT}.pages.dev  合言葉: （引数のもの）。最初の利用者は新規登録から"
