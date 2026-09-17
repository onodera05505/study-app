#!/usr/bin/env python3
"""学習者ロールの答えを採点し、サイクルの結果を残す。

    python3 scripts/grade_learner.py --data data/itc --answers <learner_answers.json> --cycle N

出力: data/itc/eval/cycle_N.json（正答率 全体・分野別・到達基準別・単位別、理解度の自己申告、詰まった単位、前サイクルとの差）
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--answers", required=True); ap.add_argument("--cycle", type=int, required=True); ap.add_argument("--roadmap", help="学習者パックを作った時点の roadmap.json（順番→ID の写しに使う。作った後に並びが変わったとき。既定は data/<key>/roadmap.json）"); ap.add_argument("--explain", help="採点担当が書いた説明テストの採点 JSON（{\"grades\": {\"語\": 0|1|2, ...}}）")
    a = ap.parse_args(); d = Path(a.data)
    rm = json.loads(Path(a.roadmap or (d / "roadmap.json")).read_text(encoding="utf-8")); units = {u["topic_id"]: u for u in rm["units"]}
    qs = {}
    for qp in sorted((d / "roadmap_questions").glob("bundle_*.json")):
        for q in json.loads(qp.read_text(encoding="utf-8"))["questions"]: qs[q["qid"]] = q
    L = json.loads(Path(a.answers).read_text(encoding="utf-8")); ans = L.get("answers", {})
    if rm.get("answer_key"):  # パック時点の正解表があればそれで採点（学習者が見た問題と今の問題が違いうる）
        changed = [q for q, v in rm["answer_key"].items() if q in qs and qs[q]["answer"] != v]
        for q, v in rm["answer_key"].items():
            if q in qs: qs[q] = dict(qs[q], answer=v)
        if changed: print(f"注: パック作成後に正解が変わった問題 {len(changed)} 件はパック時点の正解で採点: {', '.join(changed)}")
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
    # 記録のずれの疑い: 連続する誤答の「選んだ答え」が、隣の問題の正解を 1 つずらした並びになっていないか。
    # 理解の失敗ではなく、学習者役が答えを書き写すときに 1 問ずらした記録の誤り（msg 2 周目: 最後の 4 問が
    # 正解イ・ウ・ア・エに対し エ・イ・ウ・ア と記録され、本人のメモは正しく理解していた 2026-09-17）。
    order_q = list(qs.keys())
    shift_suspect: list[str] = []
    for i in range(len(order_q) - 2):
        run = order_q[i:i + 3]
        if all(ans.get(x) != qs[x]["answer"] for x in run):
            picked = [ans.get(x) for x in run]; truth = [qs[x]["answer"] for x in run]
            if picked[1:] == truth[:-1] or picked[:-1] == truth[1:]:
                shift_suspect.extend(x for x in run if x not in shift_suspect)
    self_rep = {u["topic_id"]: u for u in L.get("units", [])}
    # 学習者パックは topic_id を見せず順番の番号だけを出すので、学習者は順番で報告してくる（mkt 1 周目: 42 件中 17 件しか一致せず
    # 理解度が 1.12 と出た 2026-09-15）。報告の番号が topic_id より順番に多く一致するなら順番→topic_id に写す
    order_to_tid = {u["order"]: tid for tid, u in units.items() if "order" in u}
    rep_ids = set(self_rep)
    if order_to_tid and len(rep_ids & set(order_to_tid)) > len(rep_ids & set(units)):
        print(f"注: 学習者の単位番号を順番として読む（topic_id 一致 {len(rep_ids & set(units))} / 順番一致 {len(rep_ids & set(order_to_tid))}）")
        self_rep = {order_to_tid[o]: u for o, u in self_rep.items() if o in order_to_tid}
        for lst in ("too_long", "too_short", "most_useful", "least_useful"):
            ov = L.get("overall", {}).get(lst)
            if isinstance(ov, list): L["overall"][lst] = [order_to_tid.get(o, o) for o in ov]
    for tid, pu in per_unit.items():
        s = self_rep.get(tid, {}); pu["understood"] = s.get("understood"); pu["confusing"] = s.get("confusing", ""); pu["unknown_terms"] = s.get("unknown_terms", []); pu["minutes"] = s.get("minutes")
    stuck = [tid for tid, pu in per_unit.items() if (pu["understood"] or 3) <= 1 or (pu["total"] and pu["correct"] == 0)]
    overconfident = [tid for tid, pu in per_unit.items() if (pu["understood"] or 0) == 3 and pu["total"] and pu["correct"] < pu["total"]]
    res = {"cycle": a.cycle, "score": f"{correct}/{total}", "rate": round(correct / max(1, total), 3),
           "by_goal": {g: f"{c}/{n}" for g, (c, n) in by_goal.items()}, "by_field": {f: f"{c}/{n}" for f, (c, n) in by_field.items()},
           "shift_suspect": shift_suspect,
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
    if shift_suspect:
        print(f"注: 記録のずれの疑い {len(shift_suspect)} 問（連続する誤答が隣の正解を 1 つずらした並び）: {', '.join(shift_suspect)}。理解の失敗として教材を直す前に、学習者のメモと突き合わせる")
    print(f"サイクル {a.cycle}: 正答 {res['score']}（{res['rate']:.0%}） 自己申告の理解度 平均 {res['avg_understood']} 詰まった単位 {len(stuck)} 過信 {len(overconfident)} 未説明の語 {len(res['unknown_terms'])}" + (f" 前回比 {res['delta_rate']:+.0%}" if "delta_rate" in res else ""))
    if "explain" in res:
        ex = res["explain"]; print(f"説明テスト: 説明できた {ex['can_explain']}/{ex['n']} 語（得点率 {ex['rate']:.0%}）")
    print("到達基準別:", res["by_goal"]); print("分野別:", res["by_field"])
    for w in wrong: print(f"   誤答 {w['qid']} {w['term']}: 選 {w['picked']} 正 {w['answer']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
