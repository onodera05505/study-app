#!/usr/bin/env python3
"""ロードマップ型（出題回数が無い対象）で、図を付ける単位を選ぶ。kickoff.json の figure-priority の答え（学ぶ順・到達基準・本文が手順や対比か）を式にした。

    python3 scripts/plan_roadmap_figures.py --data data/itc --top 16 --out data/itc/figure_plan/plan.json

優先度 = 図の効き（本文の型: 手順・流れ 3 / 対比・2 軸 3 / 構成・階層 2 / 計算の分解 3 / それ以外 0）× (1 + 到達基準の数 × 0.3) × 学ぶ順の重み（前ほど高い）
効き 0 の単位は対象外。出力の形は資格版の plan.json と同じ（figures[].topic_id / term / template / idea / priority）。
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

def classify(text: str) -> tuple[int, str, str]:
    t = text
    if re.search(r"→.*→|\d+\.\s|手順|の流れ|順に|段階|→", t) and re.search(r"→|順", t): kind, tmpl, b = "手順・流れ", "sequence", 3
    elif re.search(r"違い|対比|一方|に対して|2 軸|×|縦軸|横軸|の 4 通り", t): kind, tmpl, b = "対比・2 軸", "matrix", 3
    elif re.search(r"客数×単価|×|分解|＝", t) and re.search(r"\d", t): kind, tmpl, b = "計算の分解", "blocks", 3
    elif re.search(r"構成|階層|層|全体像|の中に|部門|役割", t): kind, tmpl, b = "構成・階層", "blocks", 2
    else: kind, tmpl, b = "—", "none", 0
    return b, kind, tmpl

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", default="data/itc", type=Path); ap.add_argument("--top", type=int, default=16); ap.add_argument("--out", type=Path, default=None); ap.add_argument("--ids", default=None, help="人が選んだ topic_id をカンマ区切りで（型の自動判定を上書き。順序も維持）")
    a = ap.parse_args(); d = a.data
    # 読む物が欠けたら、例外の跡でなく、無い物を 1 行で名指して止める
    if not (d / "roadmap.json").is_file(): sys.exit(f"{d / 'roadmap.json'} がありません")
    rm = json.loads((d / "roadmap.json").read_text(encoding="utf-8")); n = rm["unit_count"]
    mats = {}
    for f in sorted((d / "materials").glob("*.json")):
        for m in json.loads(f.read_text(encoding="utf-8"))["materials"]: mats[m["topic_id"]] = m
    figs = []
    for u in rm["units"]:
        m = mats.get(u["topic_id"]);
        if not m: continue
        body = (m.get("explanation") or "") + "\n" + (m.get("detail") or "")
        b, kind, tmpl = classify(body)
        if b == 0: continue
        order_w = 1.0 + (n - u["order"]) / n  # 前ほど高い（1.0〜2.0）
        pr = round(b * (1 + 0.3 * len(u["goals"])) * order_w * 10)
        figs.append({"topic_id": u["topic_id"], "term": u["term"], "field": u["field"], "middle": u["middle"], "order": u["order"], "goals": u["goals"],
                     "kind": kind, "template": tmpl, "benefit": b, "priority": pr, "idea": ""})
    figs.sort(key=lambda x: (-x["priority"], x["order"]))
    if a.ids:
        want = [int(x) for x in a.ids.split(",")]
        by = {f["topic_id"]: f for f in figs}
        allu = {u["topic_id"]: u for u in rm["units"]}
        chosen = []
        for tid in want:
            f = by.get(tid)
            if not f:
                u = allu[tid]; f = {"topic_id": tid, "term": u["term"], "field": u["field"], "middle": u["middle"], "order": u["order"], "goals": u["goals"], "kind": "人が選択", "template": "blocks", "benefit": 3, "priority": 0, "idea": ""}
            f["picked_by"] = "本人・親の選択（kickoff figure-priority: 手順・対比・計算の単位）"; chosen.append(f)
    else:
        chosen = figs[: a.top] if a.top else figs
    for i, x in enumerate(chosen, 1): print(f"{i:>3}. [{x['priority']:>3}] 順{x['order']:>2} {x['template']:<8} {x['kind']:<6} {x['term']}")
    print(f"候補 {len(figs)} / 選んだ {len(chosen)}（上限 {a.top}）")
    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(json.dumps({"figures": chosen, "tables": [], "_note": "ロードマップ型の優先: plan_roadmap_figures.py。kickoff.json の figure-priority"}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0

if __name__ == "__main__":
    sys.exit(main())
