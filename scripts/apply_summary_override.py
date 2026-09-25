#!/usr/bin/env python3
"""直す段の「要約はこう変える」を roadmap_config.json の summary_override と roadmap.json の summary に写す。

    python3 scripts/apply_summary_override.py --data data/itc --term "ERP" --summary "会計や販売を 1 つにまとめる基幹システム"

term は roadmap.json の単位名（summary_override の鍵と同じ）。何度でも実行できる（同じ値なら変更なし）。
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--term", required=True, action="append")
    ap.add_argument("--summary", required=True, action="append")
    a = ap.parse_args()
    if len(a.term) != len(a.summary): print("--term と --summary の数が合わない"); return 1
    d = Path(a.data)
    cfgp = d / "roadmap_config.json"; cfg = json.loads(cfgp.read_text(encoding="utf-8"))
    rmp = d / "roadmap.json"; rm = json.loads(rmp.read_text(encoding="utf-8"))
    units = rm["units"] if isinstance(rm, dict) and "units" in rm else rm
    it = units.values() if isinstance(units, dict) else units
    by_term = {u["term"]: u for u in it}
    ov = cfg.setdefault("summary_override", {})
    # 名前を全部先に確かめる（途中で止まると、表示だけ出て何も書かれない事故が 2026-09-25 に起きた）
    missing = [t for t in a.term if t not in by_term]
    if missing: print("roadmap.json に無い単位（何も書いていない）:", *missing, sep="\n  "); return 1
    for t, s in zip(a.term, a.summary):
        old = by_term[t].get("summary", "")
        if old == s and ov.get(t) == s: print(f"{t}: 変更なし"); continue
        ov[t] = s; by_term[t]["summary"] = s
        print(f"{t}: 「{old}」→「{s}」")
    cfgp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rmp.write_text(json.dumps(rm, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0

if __name__ == "__main__":
    sys.exit(main())
