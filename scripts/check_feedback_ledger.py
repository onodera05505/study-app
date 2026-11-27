#!/usr/bin/env python3
"""審議台帳（brain/feedback/審議台帳.md）の各行が名指しする規則 ID が判断基準（brain/feedback/判断基準.md）に実在するかを見る。
案と決定がずれた行は数えて出す（規則の穴の候補）。check_docs.py から呼ばれる。"""
from __future__ import annotations
import re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent

def main() -> int:
    rules_md = (ROOT / "brain/feedback/判断基準.md").read_text(encoding="utf-8")
    rules = set(re.findall(r"^\| (R\d+) \|", rules_md, flags=re.M))
    rows = [l for l in (ROOT / "brain/feedback/審議台帳.md").read_text(encoding="utf-8").splitlines() if l.startswith("| ") and not l.startswith("| 日付") and not l.startswith("| ---")]
    bad = []; overridden = 0
    for l in rows:
        cells = [c.strip() for c in l.strip().strip("|").split("|")]
        if len(cells) < 12: bad.append(f"列が足りない: {l[:60]}"); continue
        ids = [x.strip() for x in cells[10].split(",") if x.strip()]
        for i in ids:
            if i not in rules: bad.append(f"規則 {i} が判断基準に無い: {cells[1]} {cells[2][:30]}")
        if not ids: bad.append(f"規則 ID が無い: {cells[1]} {cells[2][:30]}")
        if cells[9] and cells[8] and not cells[9].startswith("（") and cells[8].split("（")[0] not in cells[9]: overridden += 1
    print(f"審議台帳 {len(rows)} 行 / 規則 {len(rules)} 本 / 案と決定がずれた行 {overridden} / 問題 {len(bad)} 件")
    for b in bad: print("  ✘ " + b)
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
