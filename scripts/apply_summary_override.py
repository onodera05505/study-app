#!/usr/bin/env python3
"""直す段の「要約はこう変える」を roadmap_config.json の summary_override と roadmap.json の summary に写す。

    python3 scripts/apply_summary_override.py --data data/itc --id 12 --summary "会計や販売を 1 つにまとめる基幹システム"

--id は単位の論点の ID（roadmap.json の topic_id。summary_override の鍵はこの ID の文字列）。名前では当てない。
--id と --summary は組で何度でも渡せる。何度でも実行できる（同じ値なら変更なし）。
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path


# @implements REQ-435
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--id", required=True, action="append", type=int, dest="ids")
    ap.add_argument("--summary", required=True, action="append")
    a = ap.parse_args()
    if len(a.ids) != len(a.summary): print("--id と --summary の数が合わない"); return 1
    d = Path(a.data)
    cfgp = d / "roadmap_config.json"; cfg = json.loads(cfgp.read_text(encoding="utf-8"))
    rmp = d / "roadmap.json"; rm = json.loads(rmp.read_text(encoding="utf-8"))
    units = rm["units"] if isinstance(rm, dict) and "units" in rm else rm
    it = units.values() if isinstance(units, dict) else units
    by_id = {u["topic_id"]: u for u in it}
    ov = cfg.setdefault("summary_override", {})
    # 書く前に ID を全部確かめる。途中で止まると、表示だけ出て一部しか書かれない
    # @implements REQ-436
    missing = [i for i in a.ids if i not in by_id]
    if missing: print("roadmap.json に無い論点の ID（何も書いていない）:", *missing, sep="\n  "); return 1
    for i, s in zip(a.ids, a.summary):
        u = by_id[i]; old = u.get("summary", "")
        if old == s and ov.get(str(i)) == s: print(f"{i} {u['term']}: 変更なし"); continue
        ov[str(i)] = s; u["summary"] = s
        print(f"{i} {u['term']}: 「{old}」→「{s}」")
    cfgp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rmp.write_text(json.dumps(rm, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0

if __name__ == "__main__":
    sys.exit(main())
