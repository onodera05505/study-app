#!/usr/bin/env python3
"""教材の担当が自分のバンドルだけを検証するための小さな門（check_roadmap.py の教材部分をバンドル単位に）。
    python3 scripts/check_roadmap_bundle.py --data data/itc --bundle bundle_01
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path
NG = re.compile(r"激務|ブラック(?!ボックス)|年収|万円|最新|近年")
def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--bundle", required=True)
    a = ap.parse_args(); d = Path(a.data)
    b = json.loads((d / "material_bundles" / f"{a.bundle}.json").read_text(encoding="utf-8"))
    mp = d / "materials" / f"{a.bundle}.json"
    if not mp.exists(): print(f"✘ 出力が無い: {mp}"); return 1
    m = json.loads(mp.read_text(encoding="utf-8"))
    terms = {u["term"] for u in json.loads((d / "roadmap.json").read_text(encoding="utf-8"))["units"]}
    names = set()
    for sf in (d / "sources").glob("*.json"):
        for s in json.loads(sf.read_text(encoding="utf-8")).get("sources", []): names.add(s["name"])
    names.add("一般常識"); names.add("選考解説記事の集計（interview_frequency）")
    errs, warns = [], []
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target
    USAGE = (target(d.name).get("roadmapSpec") or {}).get("usageSection", "面接で話すなら")
    bb = [(t["topic_id"], t["term"]) for t in b["topics"]]; mm = [(x["topic_id"], x["term"]) for x in m.get("materials", [])]
    if bb != mm: errs.append(f"担当バンドルと出力の論点が不一致\n  bundle={bb}\n  output={mm}")
    for x in m.get("materials", []):
        tag = f"{x['topic_id']} {x['term']}"; ex, de = x.get("explanation", ""), x.get("detail", "")
        if not x.get("sources"): errs.append(f"{tag}: 出典が無い")
        for s in x.get("sources", []):
            if s.get("name") not in names: errs.append(f"{tag}: 出典名が sources/*.json に無い: {s.get('name')}")
        if len(ex) < 120: errs.append(f"{tag}: explanation が短い {len(ex)}")
        if len(ex) > 420: warns.append(f"{tag}: explanation が長い {len(ex)}（目安 200〜300）")
        if len(de) < 150: errs.append(f"{tag}: detail が短い {len(de)}")
        if len(de) > 800: warns.append(f"{tag}: detail が長い {len(de)}（目安 300〜500）")
        if "見分けワード" not in ex: errs.append(f"{tag}: 見分けワードの行が無い")
        if "### しくみ" not in de: errs.append(f"{tag}: 「### しくみ」が無い")
        if f"### {USAGE}" not in de: warns.append(f"{tag}: 「### {USAGE}」が無い")
        for t in re.findall(r"\[\[([^\]]+)\]\]", ex + de):
            if t not in terms: errs.append(f"{tag}: [[{t}]] はロードマップに無い論点名（`[[` を外す）")
        for hit in NG.findall(ex + de): warns.append(f"{tag}: 避ける語「{hit}」")
        for line in (ex + "\n" + de).splitlines():
            if line.startswith("#") and not line.startswith("### "): errs.append(f"{tag}: 見出しは ### だけ: {line[:30]}")
    qp = d / "roadmap_questions" / f"{a.bundle}.json"
    if qp.exists():
        import importlib.util
        spec = importlib.util.spec_from_file_location("cr", Path(__file__).with_name("check_roadmap.py")); cr = importlib.util.module_from_spec(spec); spec.loader.exec_module(cr)
        mm_by = {x["topic_id"]: x for x in m.get("materials", [])}
        for q in json.loads(qp.read_text(encoding="utf-8")).get("questions", []):
            x = mm_by.get(q["topic_id"])
            if x and cr.verbatim(q["choices"][q["answer"]], x.get("explanation", "") + "\n" + x.get("detail", "")):
                warns.append(f"{q['qid']}: 正解の選択肢が教材と {cr.VERBATIM} 字以上連続一致（言い換えるか場面適用にする）")
    for w in warns: print(f"警告: {w}")
    for e in errs: print(f"✘ {e}")
    print(f"{a.bundle}: 論点 {len(mm)} / 警告 {len(warns)} / 問題点 {len(errs)}")
    return 1 if errs else 0
if __name__ == "__main__": sys.exit(main())
