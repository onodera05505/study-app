#!/usr/bin/env python3
"""型判定の結果（figure_plan/types_batch_*.json）から、図を作る論点の優先度リストを出す。

優先度 = 出題回数 × 図の効き（benefit 0〜3） × (1 + 現状の弱さ weakness 0〜2)

「頻度＝重要度」の設計に合わせ、同じ効き目なら頻出論点を先に作る。
型 E（定義・法律）と template が none / table のものは図の対象から外す
（table は表への書き直し候補として別に一覧にする）。

使い方:
  python3 scripts/plan_material_figures.py --data data/ap            # 一覧を表示
  python3 scripts/plan_material_figures.py --data data/ap --top 20   # 上位だけ
  python3 scripts/plan_material_figures.py --data data/ap --out data/ap/figure_plan/plan.json
"""
import argparse
import glob
import json
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ap")
    ap.add_argument("--top", type=int, default=0)
    ap.add_argument("--out", default="")
    ap.add_argument("--min-count", type=int, default=2, help="出題回数の下限（既定 2）")
    args = ap.parse_args()
    d = Path(args.data)

    # 読む物が欠けたら、例外の跡でなく、無い物を 1 行で名指して止める
    for name in ("topics.json",):
        if not (d / name).is_file():
            sys.exit(f"{d / name} がありません")

    topics = {t["id"]: t for t in json.load(open(d / "topics.json", encoding="utf-8"))["topics"]}
    inputs = {}
    for f in sorted(glob.glob(str(d / "figure_plan" / "types_input_*.json"))):
        for t in json.load(open(f, encoding="utf-8"))["topics"]:
            inputs[t["topic_id"]] = t
    results = {}
    for f in sorted(glob.glob(str(d / "figure_plan" / "types_batch_*.json"))):
        for r in json.load(open(f, encoding="utf-8"))["results"]:
            results[r["topic_id"]] = r

    missing = sorted(set(inputs) - set(results))
    extra = sorted(set(results) - set(inputs))
    if missing or extra:
        print(f"[警告] 判定が無い論点 {len(missing)} 件 {missing[:10]} / 入力に無い判定 {len(extra)} 件 {extra[:10]}")

    figs, tables = [], []
    for tid, r in results.items():
        t = topics.get(tid)
        if not t:
            continue
        qc = t["question_count"]
        src = inputs.get(tid, {}).get("source_figures", 0)
        row = {
            "topic_id": tid, "term": t["term"], "field": t["field"], "middle": t["middle"],
            "question_count": qc, "source_figures": src,
            "type": r["type"], "template": r["template"], "benefit": r["benefit"],
            "weakness": r["weakness"], "idea": r["idea"], "confidence": r.get("confidence"),
        }
        if r["template"] == "table":
            tables.append(row)
            continue
        if r["type"] == "E" or r["template"] == "none" or r["benefit"] <= 0:
            continue
        # 出題1回でも出典に図があれば対象に残す（文章だけでは追えない構造の可能性）
        if qc < args.min_count and src == 0:
            continue
        row["priority"] = qc * r["benefit"] * (1 + r["weakness"])
        figs.append(row)

    figs.sort(key=lambda x: (-x["priority"], -x["question_count"], -x["weakness"], x["topic_id"]))
    tables.sort(key=lambda x: (-x["question_count"], x["topic_id"]))

    print(f"判定 {len(results)} 件 → 図の対象 {len(figs)} 件 / 表への書き直し候補 {len(tables)} 件")
    from collections import Counter
    print("  型の内訳:", dict(Counter(r["type"] for r in results.values())))
    print("  図の template:", dict(Counter(x["template"] for x in figs)))
    print("  出題回数の帯（図の対象）:", dict(sorted(Counter(min(x["question_count"], 6) for x in figs).items())))
    shown = figs[: args.top] if args.top else figs
    for i, x in enumerate(shown, 1):
        print(f"{i:>3}. [{x['priority']:>3}] {x['question_count']:>2}回 {x['template']:<8} "
              f"b{x['benefit']} w{x['weakness']}  {x['term']}  — {x['idea'][:50]}")
    if args.out:
        json.dump({"figures": figs, "tables": tables}, open(args.out, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print(f"→ {args.out}")


if __name__ == "__main__":
    main()
