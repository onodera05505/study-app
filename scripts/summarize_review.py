#!/usr/bin/env python3
"""セルフフィードバック「読む」段の指摘（data/<key>/review/*.json）を集計する。

    python3 scripts/summarize_review.py                # 全対象
    python3 scripts/summarize_review.py --key cnv      # 1 対象
    python3 scripts/summarize_review.py --kind 断り書き --severity 高   # 絞って一覧

出すもの: 対象 × 型 × 重さの件数、型ごとの代表例、patterns（決まりに落とす候補）の一覧。
指示書は scripts/prompts/self_review.md。ここは読むだけ（何も書き換えない）。
"""
from __future__ import annotations
import argparse, glob, json, sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEV = ("高", "中", "低")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key"); ap.add_argument("--kind"); ap.add_argument("--severity", choices=SEV)
    ap.add_argument("--examples", type=int, default=2, help="型ごとに見せる代表例の数")
    a = ap.parse_args()
    files = sorted(glob.glob(str(ROOT / "data" / (a.key or "*") / "review" / "*.json")))
    if not files: print("review の JSON が無い"); return 1
    by_key_kind: dict[str, Counter] = defaultdict(Counter)
    by_key_sev: dict[str, Counter] = defaultdict(Counter)
    examples: dict[str, list] = defaultdict(list)
    patterns: dict[str, list[str]] = defaultdict(list)
    bad = []
    n_files = 0
    for f in files:
        try: d = json.loads(Path(f).read_text(encoding="utf-8"))
        except Exception as e: bad.append(f"{f}: {e}"); continue
        n_files += 1
        key = d.get("key") or Path(f).parts[-3]
        for p in d.get("patterns", []): patterns[key].append(p)
        for x in d.get("findings", []):
            kind, sev = x.get("kind", "その他"), x.get("severity", "中")
            if a.kind and kind != a.kind: continue
            if a.severity and sev != a.severity: continue
            by_key_kind[key][kind] += 1; by_key_sev[key][sev] += 1
            if len(examples[kind]) < a.examples * 3:
                examples[kind].append((key, x.get("topic_id"), sev, x.get("where"), (x.get("quote") or "")[:40], (x.get("why") or "")[:60]))
    if bad: print("読めなかった JSON:", *bad, sep="\n  ")
    keys = sorted(by_key_kind)
    kinds = sorted({k for c in by_key_kind.values() for k in c}, key=lambda k: -sum(c[k] for c in by_key_kind.values()))
    print(f"review {n_files} 本 / 対象 {len(keys)} / 指摘 {sum(sum(c.values()) for c in by_key_sev.values())} 件")
    print()
    head = "型".ljust(8) + "".join(k.rjust(6) for k in keys) + "   計"
    print(head)
    for kd in kinds:
        row = [by_key_kind[k][kd] for k in keys]
        print(kd.ljust(8) + "".join(str(v).rjust(6) for v in row) + str(sum(row)).rjust(6))
    print("重さ".ljust(8) + "".join(("/".join(str(by_key_sev[k][s]) for s in SEV)).rjust(6) for k in keys) + "   （高/中/低）")
    print()
    print("== 型ごとの代表例（対象 topic 重さ 場所 | 引用 | なぜ）")
    for kd in kinds:
        print(f"[{kd}]")
        for key, tid, sev, where, q, why in examples[kd][: a.examples]:
            print(f"  {key} {tid} {sev} {where} | {q} | {why}")
    print()
    print("== patterns（決まり・門に落とす候補）")
    for key in sorted(patterns):
        for p in patterns[key]: print(f"  {key}: {p}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
