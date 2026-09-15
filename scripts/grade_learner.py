#!/usr/bin/env python3
"""学習者ロールの答えを採点し、サイクルの結果を残す。

    python3 scripts/grade_learner.py --data data/itc --answers <learner_answers.json> --cycle N

出力: data/itc/eval/cycle_N.json（正答率 全体・分野別・到達基準別・単位別、理解度の自己申告、詰まった単位、前サイクルとの差）
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--answers", required=True); ap.add_argument("--cycle", type=int, required=True); ap.add_argument("--explain", help="採点担当が書いた説明テストの採点 JSON（{\"grades\": {\"語\": 0|1|2, ...}}）")
    a = ap.parse_args(); d = Path(a.data)
    rm = json.loads((d / "roadmap.json").read_text(encoding="utf-8")); units = {u["topic_id"]: u for u in rm["units"]}
    qs = {}
    for qp in sorted((d / "roadmap_questions").glob("bundle_*.json")):
        for q in json.loads(qp.read_text(encoding="utf-8"))["questions"]: qs[q["qid"]] = q
    L = json.loads(Path(a.answers).read_text(encoding="utf-8")); ans = L.get("answers", {})
    per_unit = {tid: {"term": u["term"], "field": u["field"], "correct": 0, "total": 0} for tid, u in units.items()}
    by_goal = {g: [0, 0] for g in range(1, 7)}; by_field = {}
    wrong = []
    qs = {k: q for k, q in qs.items() if q["topic_id"] in units}  # ロードマップ外（除外済み）の問題は採点しない
    for qid, q in qs.items():
        ok = ans.get(qid) == q["answer"]; pu = per_unit[q["topic_id"]]; pu["total"] += 1; pu["correct"] += ok
        g = by_goal[q["tests_goal"]]; g[1] += 1; g[0] += ok
        f = by_field.setdefault(units[q["topic_id"]]["field"], [0, 0]); f[1] += 1; f[0] += ok
        if not ok: wrong.append({"qid": qid, "term": q["term"], "picked": ans.get(qid), "answer": q["answer"]})
    total = len(qs); correct = sum(1 for qid, q in qs.items() if ans.get(qid) == q["answer"])
    self_rep = {u["topic_id"]: u for u in L.get("units", [])}
    for tid, pu in per_unit.items():
        s = self_rep.get(tid, {}); pu["understood"] = s.get("understood"); pu["confusing"] = s.get("confusing", ""); pu["unknown_terms"] = s.get("unknown_terms", []); pu["minutes"] = s.get("minutes")
    stuck = [tid for tid, pu in per_unit.items() if (pu["understood"] or 3) <= 1 or (pu["total"] and pu["correct"] == 0)]
    overconfident = [tid for tid, pu in per_unit.items() if (pu["understood"] or 0) == 3 and pu["total"] and pu["correct"] < pu["total"]]
    res = {"cycle": a.cycle, "score": f"{correct}/{total}", "rate": round(correct / max(1, total), 3),
           "by_goal": {g: f"{c}/{n}" for g, (c, n) in by_goal.items()}, "by_field": {f: f"{c}/{n}" for f, (c, n) in by_field.items()},
           "avg_understood": round(sum((pu["understood"] or 0) for pu in per_unit.values()) / max(1, len(per_unit)), 2),
           "stuck_units": [{"topic_id": t, "term": per_unit[t]["term"], "confusing": per_unit[t]["confusing"]} for t in stuck],
           "overconfident_units": [per_unit[t]["term"] for t in overconfident],
           "unknown_terms": sorted({w for pu in per_unit.values() for w in (pu["unknown_terms"] or [])}),
           "wrong": wrong, "overall": L.get("overall", {}), "per_unit": per_unit}
    if a.explain:
        gr = json.loads(Path(a.explain).read_text(encoding="utf-8")).get("grades", {})
        res["explain"] = {"grades": gr, "rate": round(sum(gr.values()) / max(1, 2 * len(gr)), 3), "can_explain": sum(1 for v in gr.values() if v == 2), "n": len(gr)}
    prev = d / "eval" / f"cycle_{a.cycle - 1}.json"
    if prev.exists():
        p = json.loads(prev.read_text(encoding="utf-8")); res["delta_rate"] = round(res["rate"] - p["rate"], 3); res["delta_understood"] = round(res["avg_understood"] - p["avg_understood"], 2)
    (d / "eval").mkdir(exist_ok=True); (d / "eval" / f"cycle_{a.cycle}.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"サイクル {a.cycle}: 正答 {res['score']}（{res['rate']:.0%}） 自己申告の理解度 平均 {res['avg_understood']} 詰まった単位 {len(stuck)} 過信 {len(overconfident)} 未説明の語 {len(res['unknown_terms'])}" + (f" 前回比 {res['delta_rate']:+.0%}" if "delta_rate" in res else ""))
    if "explain" in res:
        ex = res["explain"]; print(f"説明テスト: 説明できた {ex['can_explain']}/{ex['n']} 語（得点率 {ex['rate']:.0%}）")
    print("到達基準別:", res["by_goal"]); print("分野別:", res["by_field"])
    for w in wrong: print(f"   誤答 {w['qid']} {w['term']}: 選 {w['picked']} 正 {w['answer']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
