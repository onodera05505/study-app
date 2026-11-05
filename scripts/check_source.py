#!/usr/bin/env python3
"""ソースの静的な門（デプロイの前段）。`docs/不変条件と門.md` の O5 と D11 を機械で守る。

    python3 scripts/check_source.py                 # プロジェクト全体
    python3 scripts/check_source.py --auth <ts> --client <dir>   # 変異テスト用に対象を差し替える

## 見るもの

- **O5** `src/server/lib/auth.ts` の `const ITERATIONS = N` が 100,000 以下か。
  Cloudflare Workers の PBKDF2 はこれを超えると NotSupportedError になるが、ローカルの
  miniflare は上限を課さないので、本番でだけログインが 500 になる。定数が見つからない場合も落とす
  （改名されて検査が素通りするのを防ぐ）
- **D11** `src/client/**/*.tsx` で `useState(...)([])` のように**空配列で初期化している一覧**が無いか。
  取得前と「結果が空」が区別できず、読み込み中に「該当する論点がありません」と誤って出る
  （`null`＝未取得 / `[]`＝空 に分ける）。同じ行に `// 空で開始可` と書けば例外にする
  （サーバから取らない、純粋にローカルなリストのため）

落ちたら exit 1。deploy-pages.sh が描画検査の前に呼ぶ。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PBKDF2_MAX = 100_000
ITER_RE = re.compile(r"^\s*(?:export\s+)?const\s+ITERATIONS\s*=\s*([\d_]+)", re.M)
EMPTY_LIST_RE = re.compile(r"useState(?:<[^\n]*?>)?\(\s*\[\s*\]\s*\)")
ALLOW_MARK = "空で開始可"


# @implements BR-039
def check_iterations(auth: Path, errors: list[str]) -> None:
    if not auth.exists():
        errors.append(f"O5: {auth} が無い（改名したらこの検査も直す）")
        return
    m = ITER_RE.search(auth.read_text(encoding="utf-8"))
    if not m:
        errors.append(f"O5: {auth} に `const ITERATIONS = N` が見つからない")
        return
    n = int(m.group(1).replace("_", ""))
    if n > PBKDF2_MAX:
        errors.append(f"O5: PBKDF2 の反復回数 {n:,} が Workers の上限 {PBKDF2_MAX:,} を超えている（本番だけログインが 500 になる）")


def check_empty_lists(client: Path, errors: list[str]) -> int:
    n = 0
    for f in sorted(client.rglob("*.tsx")):
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if EMPTY_LIST_RE.search(line) and ALLOW_MARK not in line:
                errors.append(f"D11: {f}:{i} 一覧を空配列で初期化している（null＝未取得 / []＝空 に分ける。ローカルなリストなら同じ行に // {ALLOW_MARK}）")
            n += 1
    return n


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--auth", default=str(root / "src/server/lib/auth.ts"))
    ap.add_argument("--client", default=str(root / "src/client"))
    a = ap.parse_args()

    errors: list[str] = []
    check_iterations(Path(a.auth), errors)
    n_lines = check_empty_lists(Path(a.client), errors)
    for e in errors:
        print(f"✘ {e}")
    print(f"O5: PBKDF2 反復回数 / D11: クライアント {n_lines:,} 行を確認{'' if not errors else f'、問題 {len(errors)} 件'}")
    if errors:
        return 1
    print("✓ ソースの静的な門は通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
