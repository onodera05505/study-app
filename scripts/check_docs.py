#!/usr/bin/env python3
"""文書の索引と「不変条件と門」の対応表が現物とずれていないかを見る。デプロイの門。

    python3 scripts/check_docs.py              # このリポジトリ
    python3 scripts/check_docs.py --root DIR   # 変異テスト用（壊した複製を指す）

## なぜ要るか

文書は索引から辿れないと存在しないのと同じ（全部を読むと context rot になる）。
そして「不変条件と門」の表は、名指ししたスクリプトが消えた瞬間に嘘になる。
どちらも人が気づけないので機械で見る。社用側のプロトコル層（doc-layout ゲート）の
型を、CI ではなく deploy-pages.sh の前段に置く形で持ち帰ったもの（2026-09-10）。

## 見るもの

- **docs/ の索引網羅** — `docs/*.md` の全ファイル名が `CLAUDE.md` の表に載っているか
- **brain の索引網羅** — `brain/reports/*.md` の全ファイル名が `brain/INDEX.md` に載っているか
- **門の実在** — `docs/不変条件と門.md` がバッククォートで名指しするパス
  （scripts/ src/ .claude/ docs/ brain/ 配下）が実在するか。`<試験>` のような
  プレースホルダを含むものは見ない
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

INVARIANTS_DOC = "docs/不変条件と門.md"
PATH_IN_BACKTICKS = re.compile(r"`((?:scripts|src|\.claude|docs|brain|data|public)/[^`\s]+)`")


def check_index(root: Path, index_file: str, target_dir: str, errors: list[str]) -> int:
    index_path = root / index_file
    if not index_path.exists():
        errors.append(f"索引が無い: {index_file}")
        return 0
    index = index_path.read_text(encoding="utf-8")
    files = sorted((root / target_dir).glob("*.md")) if (root / target_dir).exists() else []
    for f in files:
        if f.name not in index:
            errors.append(f"索引漏れ: {target_dir}/{f.name} が {index_file} に載っていない")
    return len(files)


def check_gate_paths(root: Path, errors: list[str]) -> int:
    doc = root / INVARIANTS_DOC
    if not doc.exists():
        errors.append(f"対応表が無い: {INVARIANTS_DOC}")
        return 0
    text = doc.read_text(encoding="utf-8")
    seen: set[str] = set()
    for m in PATH_IN_BACKTICKS.finditer(text):
        p = m.group(1)
        if "<" in p or "*" in p or p in seen:
            continue
        seen.add(p)
        if not (root / p).exists():
            errors.append(f"門が無い: {INVARIANTS_DOC} が名指しする {p} が存在しない")
    return len(seen)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    args = ap.parse_args()
    root = Path(args.root).resolve()

    errors: list[str] = []
    n_docs = check_index(root, "CLAUDE.md", "docs", errors)
    n_brain = check_index(root, "brain/INDEX.md", "brain/reports", errors)
    n_gates = check_gate_paths(root, errors)

    for e in errors:
        print(f"✘ {e}")
    print(f"docs {n_docs} 件 / brain 報告書 {n_brain} 件 / 門の名指し {n_gates} 件を確認"
          f"{'' if not errors else f'、問題 {len(errors)} 件'}")
    if errors:
        return 1
    print("✓ 文書の索引と門の対応表は現物と一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
