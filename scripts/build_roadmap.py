#!/usr/bin/env python3
"""論点候補（名寄せ済み）からロードマップを組む。試作: IT コンサル就活（要件定義書 §13）。

    python3 scripts/build_roadmap.py --data data/itc [--max 40] [--per-day 3]

入力 `topics_candidates.json`: {"candidates": [{"id", "term", "field", "middle", "summary", "source_count", "sources", "interview_count", "prereq": [term...], "goals": [1..6]}]}
出力 `roadmap.json`（順序つき単位）と `material_bundles/bundle_NN.json`（8 論点ずつ）

優先信号（§13）: score = 一次資料の交差数（主）+ 0.5 × 面接で問われる頻度（副）。
順序: score 降順を骨格にし、前提（prereq）が後ろに来る場合は前提を前に出す。到達基準（goals）に繋がらない候補は落とす。
到達基準 6（自己理解）に属する単位は最後に置く（練習として。§13）。各到達基準に最低 2 単位を確保する。
"""
from __future__ import annotations
import argparse, json, math, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--max", type=int, default=40); ap.add_argument("--per-day", type=int, default=3)
    a = ap.parse_args(); d = Path(a.data)
    cands = json.loads((d / "topics_candidates.json").read_text(encoding="utf-8"))["candidates"]
    for c in cands: c["score"] = c.get("source_count", 0) + 0.5 * c.get("interview_count", 0)
    linked = [c for c in cands if c.get("goals")]
    dropped = [c["term"] for c in cands if not c.get("goals")]
    linked.sort(key=lambda c: (-c["score"], c["term"]))
    chosen = linked[: a.max]
    # 各到達基準に最低 2 単位
    for g in range(1, 7):
        have = [c for c in chosen if g in c["goals"]]
        if len(have) < 2:
            for c in linked:
                if c not in chosen and g in c["goals"]:
                    chosen.append(c)
                    if len([x for x in chosen if g in x["goals"]]) >= 2: break
    by_term = {c["term"]: c for c in chosen}
    # 前提を前に出す（トポロジカル。前提が選外なら無視）
    ordered: list[dict] = []; seen: set[str] = set()
    def visit(c: dict, stack: tuple = ()):
        if c["term"] in seen: return
        if c["term"] in stack: return  # 循環は無視
        for p in c.get("prereq", []):
            if p in by_term: visit(by_term[p], stack + (c["term"],))
        seen.add(c["term"]); ordered.append(c)
    main_units = [c for c in chosen if 6 not in c["goals"] or len(c["goals"]) > 1]
    last_units = [c for c in chosen if c["goals"] == [6]]
    for c in main_units: visit(c)
    for c in last_units: visit(c)
    units = []
    for i, c in enumerate(ordered, 1):
        units.append({"order": i, "day": math.ceil(i / a.per_day), "topic_id": c["id"], "term": c["term"], "field": c["field"], "middle": c.get("middle", ""),
                      "summary": c.get("summary", ""), "score": c["score"], "source_count": c.get("source_count", 0), "interview_count": c.get("interview_count", 0),
                      "prereq": c.get("prereq", []), "goals": c["goals"], "sources": c.get("sources", [])})
    roadmap = {"target": "IT コンサルになる（就活の目線）", "per_day": a.per_day, "days": math.ceil(len(units) / a.per_day), "unit_count": len(units),
               "dropped_no_goal": dropped, "units": units}
    (d / "roadmap.json").write_text(json.dumps(roadmap, ensure_ascii=False, indent=2), encoding="utf-8")
    bdir = d / "material_bundles"; bdir.mkdir(exist_ok=True)
    for p in bdir.glob("bundle_*.json"): p.unlink()
    for n, i in enumerate(range(0, len(units), 8), 1):
        chunk = units[i:i + 8]
        (bdir / f"bundle_{n:02d}.json").write_text(json.dumps({"bundle": f"bundle_{n:02d}", "topics": [
            {k: u[k] for k in ("topic_id", "term", "field", "middle", "summary", "goals", "prereq", "sources", "source_count", "interview_count")} for u in chunk]},
            ensure_ascii=False, indent=2), encoding="utf-8")
    goals = {g: sum(1 for u in units if g in u["goals"]) for g in range(1, 7)}
    fields = {}
    for u in units: fields[u["field"]] = fields.get(u["field"], 0) + 1
    print(f"単位 {len(units)} 件 / {roadmap['days']} 日 / バンドル {math.ceil(len(units)/8)} 本 / 到達基準に繋がらず落とした {len(dropped)} 件")
    print("到達基準ごと:", goals); print("分野ごと:", fields)
    return 0

if __name__ == "__main__":
    sys.exit(main())
