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
# Pages 用の設定と配信物を一時の場所に組み、そこを今いる場所にして wrangler を呼ぶ。
# 作業ツリーの wrangler.jsonc（Workers 用）は動かさない（同じ作業ツリーで並行する検査が読む）。
#
# Pages 用の設定に D1 バインディングを書くのが要点:
#   設定ファイル無しでデプロイすると、そのデプロイには D1 が bind されない。
#   env.DB が undefined になり、ログインも登録も 500 で落ちる。
#   バインディングは wrangler.jsonc の env.<試験> から機械的に写すので、二重管理にはならない。
set -euo pipefail
cd "$(dirname "$0")/.."

EXAM="${1:-ip}"
[ "$(python3 scripts/targets.py has "$EXAM")" = yes ] || { echo "第1引数は対象の ID（$(python3 scripts/targets.py keys)）"; exit 1; }
# プロジェクト名と DB は scripts/pages_projects.json が正本
read -r PROJECT DB < <(python3 -c "import json;c=json.load(open('scripts/pages_projects.json'))['$EXAM'];print(c['project'],c['db'])")
URL=$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['$EXAM'].get('url','https://${PROJECT}.pages.dev'))")

# 配備の道具はプロジェクトが固定した版だけを使う（無ければ別の版に倒さず止まる）
# @implements REQ-351, REQ-352
source scripts/pinned_wrangler.sh

# アカウントの取り違えを止める門（同じ Mac で別アカウントのログインに差し替わることがある）
WANT=$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json'))['account_id'])")
# 道具の出力は一度変数に受けてから読む（pipefail の下で読み手が先に抜けると、書き手が SIGPIPE で落ちる）
WHOAMI=$("$WRANGLER" whoami 2>/dev/null || true)
ACCOUNT_RE='[0-9a-f]{32}'; HAVE=""
[[ $WHOAMI =~ $ACCOUNT_RE ]] && HAVE="${BASH_REMATCH[0]}"
[ "$HAVE" = "$WANT" ] || { echo "ログイン中のアカウント（${HAVE:-不明}）が想定（${WANT}）と違う。npx wrangler login で個人アカウントを選び直す"; exit 1; }

echo "▶ D1 に migrations が全部当たっているか（未適用のまま出すと、新しい列を読む SQL が 500 になる）"
bash scripts/d1_migrations.sh "$EXAM" check

echo "▶ ロードマップ型なら、D1 の論点が回を持っているか（migrations だけ当てて seed が古いまま出さない。資格型は素通り）"
bash scripts/check_d1_rounds.sh "$EXAM"

# macOS 標準の bash 3.2 は $VAR 直後の全角文字を変数名に巻き込むので ${VAR} で区切る
echo "▶ 対象: ${EXAM}（Pages: $PROJECT / D1: ${DB}）"

echo "▶ ソースの静的な門（PBKDF2 の反復回数の上限・一覧の空配列初期化。不変条件 O5 / D11）"
python3 scripts/check_source.py

echo "▶ ロードマップ型の回の語・印の語が登録簿に揃っているか（BR-037。資格型は素通り）"
# @implements BR-037
python3 scripts/check_roadmap_registry.py "$EXAM"

echo "▶ 文書の索引と「不変条件と門」の対応表が現物と合っているか"
# 索引に無い文書は無いのと同じ。表が名指しするスクリプトが消えていたら表が嘘になる。
python3 scripts/check_docs.py

echo "▶ フロントをビルド"
# 試験名とタイトルは .env / .env.ap から読ませる（--mode で切り替わる）
npx vite build --mode "$EXAM"
# 版の印。画面が一定の間隔で見比べ、違えば新しい版の知らせを出す。
# 書き出しは配信より前で、失敗すれば set -e で止まり配信しない（保証点。ADR-0007）
# @implements REQ-224, REQ-225, REQ-226
printf '{"build": "%s", "at": "%s"}\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist/version.json

echo "▶ 描画検査（実データ全件を jsdom で描いて見る。配信する dist の版の印も見る。落ちたらデプロイしない）"
# データ側の検査が通っても画面だけ壊れることがある。版の印の項目は配信する dist を見るので、
# 版の印を書いた後・配信の前に回す。何を見ているかは scripts/check_render.tsx の先頭。
bash scripts/check_render.sh "$EXAM"

echo "▶ Worker を1ファイルにまとめる（Pages の advanced mode 用）"
# --env で wrangler.jsonc の env ブロックを選ぶ。試験ごとに D1 の bind 先が違う。
"$WRANGLER" deploy --dry-run --outdir=".worker-build-$EXAM" --env "$EXAM" >/dev/null
cp ".worker-build-$EXAM/index.js" dist/_worker.js

echo "▶ Pages へデプロイ"
# Pages 用の設定と配信物を一時の場所に組む。作業ツリーの wrangler.jsonc は読むだけで動かさない
PAGES_DIR=$(mktemp -d)
trap 'rm -rf "$PAGES_DIR"' EXIT
cp -R dist "$PAGES_DIR/dist"

# Workers 用設定の env.<試験> から D1 と vars を写して、Pages 用の設定を組む
# @implements BR-033
python3 - wrangler.jsonc "$EXAM" "$PROJECT" > "$PAGES_DIR/wrangler.jsonc" <<'PY'
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

echo "  D1: $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['d1_databases'][0]['database_name'])" "$PAGES_DIR/wrangler.jsonc")"
# 一時の場所は git の外なので、配信に添える版の値（コミット）は作業ツリーで読んで渡す。読めなければ添えない
COMMIT_ARGS=()
COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null || true)
if [ -n "$COMMIT_HASH" ]; then
  COMMIT_ARGS=(--commit-hash "$COMMIT_HASH" --commit-message "$(git log -1 --format=%s 2>/dev/null || true)")
fi
( cd "$PAGES_DIR" && "$WRANGLER" pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true ${COMMIT_ARGS[@]+"${COMMIT_ARGS[@]}"} )

echo
echo "完了: ${URL}"
echo "※ 描画検査だけ単独で回すなら: bash scripts/check_render.sh ${EXAM}"
echo "※ D1 のデータを更新した場合は、別途これも実行する:"
echo "   python3 scripts/build_seed.py --data data/${EXAM}"
echo "   bash scripts/seed_remote.sh ${EXAM}   # check_seed → backup → --remote 投入 → 投入後の突き合わせ"
