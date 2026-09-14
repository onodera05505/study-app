#!/usr/bin/env python3
"""論点候補（名寄せ済み）からロードマップを組む。試作: IT コンサル就活（要件定義書 §13）。

    python3 scripts/build_roadmap.py --data data/itc [--max 40] [--per-day 3]

入力 `roadmap_config.json`（値: max / per_day / min_per_goal / must_include / exclude / prereq_add / prereq_replace。無ければ引数の既定）と `topics_candidates.json`: {"candidates": [{"id", "term", "field", "middle", "summary", "source_count", "sources", "interview_count", "prereq": [term...], "goals": [1..6]}]}
出力 `roadmap.json`（順序つき単位）と `material_bundles/bundle_NN.json`（8 論点ずつ）

優先信号（§13）: score = 一次資料の交差数（主）+ 0.5 × 面接で問われる頻度（副）。
順序: score 降順を骨格にし、前提（prereq）が後ろに来る場合は前提を前に出す。cluster に挙げた単位は先頭の位置に連続で並べる。到達基準（goals）に繋がらない候補は落とす。
到達基準 6（自己理解）に属する単位は最後に置く（練習として。§13）。各到達基準に最低 --min-per-goal 単位（既定 4）を確保し、選んだ単位の前提（prereq）は必ず含める。上限超過は前提として要らない低スコアから外す。
"""
from __future__ import annotations
import argparse, json, math, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--max", type=int, default=40); ap.add_argument("--per-day", type=int, default=3); ap.add_argument("--min-per-goal", type=int, default=4)
    a = ap.parse_args(); d = Path(a.data)
    cands = json.loads((d / "topics_candidates.json").read_text(encoding="utf-8"))["candidates"]
    cfg = json.loads((d / "roadmap_config.json").read_text(encoding="utf-8")) if (d / "roadmap_config.json").exists() else {}
    a.max = cfg.get("max", a.max); a.per_day = cfg.get("per_day", a.per_day); a.min_per_goal = cfg.get("min_per_goal", a.min_per_goal)
    excl = set(cfg.get("exclude", [])); must = set(cfg.get("must_include", []))
    for c in cands:
        if c["term"] in cfg.get("prereq_replace", {}): c["prereq"] = list(cfg["prereq_replace"][c["term"]])
        for pt in cfg.get("prereq_add", {}).get(c["term"], []):
            if pt not in c.setdefault("prereq", []): c["prereq"].append(pt)
    cands = [c for c in cands if c["term"] not in excl]
    missing_must = must - {c["term"] for c in cands}
    if missing_must: print("must_include が候補に無い:", missing_must); return 1
    for c in cands: c["score"] = c.get("source_count", 0) + 0.5 * c.get("interview_count", 0)
    linked = [c for c in cands if c.get("goals")]
    dropped = [c["term"] for c in cands if not c.get("goals")]
    linked.sort(key=lambda c: (-c["score"], c["term"]))
    chosen = [c for c in linked if c["term"] in must] + [c for c in linked if c["term"] not in must][: max(0, a.max - len(must))]
    all_by_term = {c["term"]: c for c in linked}
    def ensure_goals():
        for g in range(1, 7):
            for c in linked:
                if len([x for x in chosen if g in x["goals"]]) >= a.min_per_goal: break
                if c not in chosen and g in c["goals"]: chosen.append(c)
    def ensure_prereqs():
        changed = True
        while changed:
            changed = False
            for c in list(chosen):
                for pt in c.get("prereq", []):
                    if pt in all_by_term and all_by_term[pt] not in chosen:
                        chosen.append(all_by_term[pt]); changed = True
    def needed_by_others(c):
        return any(c["term"] in x.get("prereq", []) for x in chosen if x is not c)
    def trim():
        # 上限に収める: 前提として要らず、到達基準の最低数を割らない単位を、score の低い順に外す
        while len(chosen) > a.max:
            removable = [c for c in sorted(chosen, key=lambda c: (c["score"], c["term"]))
                         if c["term"] not in must and not needed_by_others(c) and all(len([x for x in chosen if g in x["goals"]]) - 1 >= a.min_per_goal for g in c["goals"])]
            if not removable: break
            chosen.remove(removable[0])
    ensure_goals(); ensure_prereqs(); trim(); ensure_prereqs()
    chosen.sort(key=lambda c: (-c["score"], c["term"]))  # must_include を先頭に置いた並びを score 順に戻す（順序は前提とスコアだけで決める）
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
    # cluster: 先頭の単位の位置に、残りを順に並べて連続させる（学習者が「工程が 5〜12 日目に散った」と報告したため）
    for group in cfg.get("cluster", []):
        members = [by_term[t] for t in group if t in by_term]
        if len(members) < 2: continue
        first = min(ordered.index(m) for m in members)
        rest = [m for m in ordered if m not in members]
        ordered = rest[:first] + members + rest[first:]
    for c in ordered:
        if c["term"] in cfg.get("summary_override", {}): c["summary"] = cfg["summary_override"][c["term"]]
    units = []
    for i, c in enumerate(ordered, 1):
        units.append({"order": i, "day": math.ceil(i / a.per_day), "topic_id": c["id"], "term": c["term"], "field": c["field"], "middle": c.get("middle", ""),
                      "summary": c.get("summary", ""), "score": c["score"], "source_count": c.get("source_count", 0), "interview_count": c.get("interview_count", 0),
                      "prereq": c.get("prereq", []), "goals": c["goals"], "sources": c.get("sources", [])})
    roadmap = {"target": "IT コンサルになる（就活の目線）", "per_day": a.per_day, "days": math.ceil(len(units) / a.per_day), "unit_count": len(units),
               "dropped_no_goal": dropped, "units": units}
    (d / "roadmap.json").write_text(json.dumps(roadmap, ensure_ascii=False, indent=2), encoding="utf-8")
    bdir = d / "material_bundles"; bdir.mkdir(exist_ok=True)
    for p in bdir.glob("bundle_[0-9][0-9].json"): p.unlink()  # 連番のバンドルだけ作り直す。手で作った追加バンドル（bundle_c2_new_a 等）は消さない（担当が読んでいる入力を消した事故 2026-09-15）
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
