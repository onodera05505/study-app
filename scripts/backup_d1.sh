#!/usr/bin/env bash
# 本番 D1 の中身を丸ごと吸い出して backups/ に置く。
#
#   scripts/backup_d1.sh          # 両方
#   scripts/backup_d1.sh ip       # IT パスポートだけ
#
# ## なぜ要るか
#
# 学習の進捗（progress）と受験履歴（sessions）は**本番 D1 にしか無い**。
# 問題・論点・教材は data/ から作り直せるが、進捗は作り直せない。
#
# しかも seed の投入は `DELETE FROM topics WHERE id NOT IN (…)` を含む。
# progress は ON DELETE CASCADE なので、**中身のおかしい seed を流すと理解度が消える**。
# 実際 `data/ip/seed.sql` の中身が応用情報になっていた事故がある（2026-08-28）。
# `check_seed.py` が投入前に止めるようになったが、通り抜けたときの備えが要る。
#
# Cloudflare の Time Travel でも直近30日なら戻せる。これはその手前の、
# **手元に現物を置いておく**ための手段。
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP=$(date +%Y-%m-%d_%H%M)
OUT=backups
mkdir -p "$OUT"

backup_one () {
  local exam=$1 db=$2
  local file="$OUT/${db}_${STAMP}.sql"
  echo "▶ ${exam}: ${db} → ${file}"
  npx wrangler d1 export "$db" --env "$exam" --remote --output "$file"
  # 中身が空でないことだけは確かめる（エクスポートが成功しても0バイトなら意味がない）
  local n
  n=$(grep -c "INSERT INTO" "$file" || true)
  echo "  INSERT 文 ${n} 行 / $(du -h "$file" | cut -f1)"
  if [ "$n" -lt 100 ]; then
    echo "  [警告] 行数が少なすぎます。エクスポートを確認してください" >&2
  fi
}

case "${1:-all}" in
  ip)  backup_one ip study-app-db ;;
  ap)  backup_one ap study-app-ap-db ;;
  itc) backup_one itc study-app-itc-db ;;
  all) backup_one ip study-app-db; backup_one ap study-app-ap-db ;;
  *)   echo "第1引数は ip か ap（省略で両方）"; exit 1 ;;
esac

echo
echo "完了。${OUT}/ は .gitignore 済み（git 管理外）。"
echo "戻すときは、対象の DB を空にしてから流す。進捗も一緒に戻る点に注意:"
echo "  npx wrangler d1 execute <DB> --env <試験> --remote --file=${OUT}/<ファイル>"
