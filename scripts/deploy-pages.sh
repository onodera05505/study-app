#!/usr/bin/env bash
# 本番（Cloudflare Pages）へデプロイする。
#
#   scripts/deploy-pages.sh          # IT パスポート（既定）
#   scripts/deploy-pages.sh ap       # 応用情報 午前
#
# なぜ Workers ではなく Pages なのか:
#   workers.dev の URL は <worker名>.<アカウント共通サブドメイン>.workers.dev という形で、
#   アカウント共通サブドメインにアカウント名が入る。これを変えると同じアカウントの
#   他の Worker の URL も一斉に変わってしまう。
#   Pages の URL は <プロジェクト名>.pages.dev でアカウント名を含まないため、
#   他に影響を出さずに済む。
#
# Pages は wrangler の設定ファイルにカスタムパスを指定できないため、
# Workers 用の wrangler.jsonc を一時的に退避し、代わりに Pages 用の設定を置いてデプロイする。
#
# Pages 用の設定に D1 バインディングを書くのが要点:
#   設定ファイル無しでデプロイすると、そのデプロイには D1 が bind されない。
#   env.DB が undefined になり、ログインも登録も 500 で落ちる（2026-08-29 に応用情報側で発生）。
#   バインディングは wrangler.jsonc の env.<試験> から機械的に写すので、二重管理にはならない。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-ip}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
# プロジェクト名と DB は scripts/pages_projects.json が正本（2026-09-15 に個人アカウントへ移した際に 1 か所に集約）
read -r PROJECT DB < <(python3 -c "import json;c=json.load(open('scripts/pages_projects.json'))['$EXAM'];print(c['project'],c['db'])")
URL=$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['$EXAM'].get('url','https://${PROJECT}.pages.dev'))")

# アカウントの取り違えを止める門（同じ Mac で別アカウントのログインに差し替わることがある）
WANT=$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['account_id'])")
HAVE=$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)
[ "$HAVE" = "$WANT" ] || { echo "ログイン中のアカウント（${HAVE:-不明}）が想定（${WANT}）と違う。npx wrangler login で個人アカウントを選び直す"; exit 1; }

# macOS 標準の bash 3.2 は $VAR 直後の全角文字を変数名に巻き込むので ${VAR} で区切る
echo "▶ 対象: ${EXAM}（Pages: $PROJECT / D1: ${DB}）"

echo "▶ ソースの静的な門（PBKDF2 の反復回数の上限・一覧の空配列初期化。不変条件 O5 / D11）"
python3 scripts/check_source.py

echo "▶ 描画検査（実データ全件を jsdom で描いて見る。落ちたらデプロイしない）"
# データ側の検査が通っても画面だけ壊れることがある（2026-09-01 の用語ポップ）。
# 何を見ているかは scripts/check_render.tsx の先頭。
bash scripts/check_render.sh "$EXAM"

echo "▶ 文書の索引と「不変条件と門」の対応表が現物と合っているか"
# 索引に無い文書は無いのと同じ。表が名指しするスクリプトが消えていたら表が嘘になる。
python3 scripts/check_docs.py

echo "▶ フロントをビルド"
# 試験名とタイトルは .env / .env.ap から読ませる（--mode で切り替わる）
npx vite build --mode "$EXAM"

echo "▶ Worker を1ファイルにまとめる（Pages の advanced mode 用）"
# --env で wrangler.jsonc の env ブロックを選ぶ。試験ごとに D1 の bind 先が違う。
npx wrangler deploy --dry-run --outdir=".worker-build-$EXAM" --env "$EXAM" >/dev/null
cp ".worker-build-$EXAM/index.js" dist/_worker.js

echo "▶ Pages へデプロイ"
STASH=$(mktemp -d)/wrangler.jsonc
mv wrangler.jsonc "$STASH"
trap 'mv "$STASH" wrangler.jsonc' EXIT

# Workers 用設定の env.<試験> から D1 と vars を写して、Pages 用の設定を組む
python3 - "$STASH" "$EXAM" "$PROJECT" > wrangler.jsonc <<'PY'
import json, re, sys

src, exam, project = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(src, encoding='utf-8').read()
# JSONC のコメントを落とす（文字列中の // は残す）
raw = re.sub(r'(?m)^\s*//.*$', '', raw)
raw = re.sub(r'(?<!:)//(?![^\n"]*").*$', '', raw, flags=re.M)
cfg = json.loads(raw)
env = cfg['env'][exam]

print(json.dumps({
    'name': project,
    'compatibility_date': cfg['compatibility_date'],
    'compatibility_flags': cfg.get('compatibility_flags', []),
    'pages_build_output_dir': 'dist',
    # migrations_dir は Pages の設定では受け付けない
    'd1_databases': [{k: v for k, v in d.items() if k != 'migrations_dir'}
                     for d in env['d1_databases']],
    'vars': env['vars'],
}, indent=2, ensure_ascii=False))
PY

echo "  D1: $(python3 -c "import json,sys; print(json.load(open('wrangler.jsonc'))['d1_databases'][0]['database_name'])")"
npx wrangler pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true

echo
echo "完了: ${URL}"
echo "※ 描画検査だけ単独で回すなら: bash scripts/check_render.sh ${EXAM}"
echo "※ D1 のデータを更新した場合は、別途これも実行する:"
echo "   python3 scripts/build_seed.py --data data/${EXAM}"
echo "   bash scripts/seed_remote.sh ${EXAM}   # check_seed → backup → --remote 投入 → 投入後の突き合わせ"
