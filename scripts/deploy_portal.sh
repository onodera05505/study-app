#!/usr/bin/env bash
# 入口「まなびば」（認証と権限の正本。要件 §15）を Pages へ出す。
#
#   bash scripts/deploy_portal.sh            # 組み立て → Worker を束ねる → Pages へ
#   bash scripts/deploy_portal.sh --setup    # 初回: D1 を作って id を書き、マイグレーションを当て、SSO_SECRET を置く（対話あり）
#
# 学び側の deploy-pages.sh と同じ作法: portal/wrangler.jsonc（Workers 用）から Pages 用の設定を組んで渡す。
# 実ドメインは pages project list から読む（名前が取れてもドメインは別になる。中央 reports/127）。
set -euo pipefail
cd "$(dirname "$0")/.."

# 配備の道具はプロジェクトが固定した版だけを使う（無ければ別の版に倒さず止まる）。
# 設定を組む一時の場所でも同じ道具を使うよう、絶対パスの "$WRANGLER" で呼ぶ
# @implements REQ-351, REQ-352
source scripts/lib/pinned_wrangler.sh

# アカウントの取り違えを止める門。ほかの何よりも先に、ログイン中のアカウントと環境変数の向け先を決めたアカウントと照らし、
# 違うか確かめられなければ、食い違ったアカウントと決めたアカウントを示して、配信しないまま失敗で終える。
# 照らし方はほかの本番に触る道具と同じ部品（並びのどこかにあれば合う・環境変数の向け先が違えば止める）。照らすのは固定した版の道具
ACCOUNT_WRANGLER="$WRANGLER"
source scripts/lib/check_account.sh

PROJECT="$(python3 -c "import json;print(json.load(open('scripts/pages_projects.json')).get('_portal',{}).get('project','manabiba'))")"
DB="manabiba-db"

if [ "${1:-}" = "--setup" ]; then
  if grep -q PLACEHOLDER portal/wrangler.jsonc; then
    echo "▶ D1 ${DB} を作る"
    OUT="$("$WRANGLER" d1 create "$DB" 2>&1 | tee /dev/stderr)"
    ID_RE='"database_id": "([^"]*)"'; ID=""
    [[ $OUT =~ $ID_RE ]] && ID="${BASH_REMATCH[1]}"
    [ -n "$ID" ] || { echo "database_id が取れなかった" >&2; exit 1; }
    sed -i '' "s|PLACEHOLDER-run-scripts/deploy_portal.sh|$ID|" portal/wrangler.jsonc
    echo "  id=$ID を portal/wrangler.jsonc に書いた"
  fi
  echo "▶ マイグレーション（--remote）"
  ( cd portal && "$WRANGLER" d1 migrations apply "$DB" --remote )
  PROJECTS="$("$WRANGLER" pages project list 2>/dev/null || true)"
  if ! grep -q "│ ${PROJECT} " <<< "$PROJECTS"; then
    echo "▶ Pages ${PROJECT} を作る"; "$WRANGLER" pages project create "$PROJECT" --production-branch main
  fi
  echo "▶ SSO_SECRET（乱数。学び側 4 つにも同じ値を置く: scripts/set_sso_secret.sh）"
  SECRET="$(python3 -c "import secrets;print(secrets.token_hex(32))")"
  printf '%s' "$SECRET" > .sso_secret.local
  chmod 600 .sso_secret.local
  printf '%s' "$SECRET" | "$WRANGLER" pages secret put SSO_SECRET --project-name "$PROJECT"
  echo "  .sso_secret.local に控えた（git 管理外）。学び側へは bash scripts/set_sso_secret.sh"
fi

echo "▶ 組み立て（登録簿 → learnings.json、static → dist）"
python3 scripts/build_portal.py

echo "▶ Worker を 1 ファイルに束ねる"
( cd portal && "$WRANGLER" deploy --dry-run --outdir=".worker-build" >/dev/null )
cp portal/.worker-build/index.js portal/dist/_worker.js

echo "▶ Pages 用の設定を組む（D1 の bind）"
TMP="$(mktemp -d)"; cp -R portal/dist "$TMP/dist"
python3 - portal/wrangler.jsonc "$PROJECT" > "$TMP/wrangler.jsonc" <<'PY'
import json, re, sys
raw = open(sys.argv[1], encoding='utf-8').read()
raw = re.sub(r'(?m)^\s*//.*$', '', raw); raw = re.sub(r'(?<!:)//(?![^\n"]*").*$', '', raw, flags=re.M)
cfg = json.loads(raw)
print(json.dumps({'name': sys.argv[2], 'compatibility_date': cfg['compatibility_date'], 'compatibility_flags': cfg.get('compatibility_flags', []),
                  'pages_build_output_dir': 'dist',
                  'd1_databases': [{k: v for k, v in d.items() if k != 'migrations_dir'} for d in cfg['d1_databases']],
                  'vars': cfg.get('vars', {})}, indent=2, ensure_ascii=False))
PY
grep -q PLACEHOLDER "$TMP/wrangler.jsonc" && { echo "D1 の id が未設定。先に --setup" >&2; exit 1; }
( cd "$TMP" && "$WRANGLER" pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true )
rm -rf "$TMP"

# 一覧が取れなければ止まる（推した名前を実ドメインとして登録簿に書かない）
PROJECTS="$("$WRANGLER" pages project list 2>/dev/null)"
DOMAIN="$(awk -F'│' -v p="$PROJECT" '{gsub(/ /,"",$2); if ($2==p && !found) {gsub(/ /,"",$3); print $3; found=1}}' <<< "$PROJECTS")"
URL="https://${DOMAIN:-${PROJECT}.pages.dev}"
python3 - "$PROJECT" "$URL" <<'PY'
import json, sys
p = "scripts/pages_projects.json"; c = json.load(open(p))
c.setdefault("_portal", {}); c["_portal"].update({"project": sys.argv[1], "url": sys.argv[2], "db": "manabiba-db"})
c["_portal"].setdefault("title", "まなびば"); c["_portal"].setdefault("subtitle", "特化した学びのロードマップ")
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2); open(p, "a").write("\n")
PY
echo "完了: ${URL}"
