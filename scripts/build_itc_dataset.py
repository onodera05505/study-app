#!/usr/bin/env python3
"""ロードマップ試作（data/itc）を、既存の投入経路（build_seed.py → check_seed.py → seed_remote.sh）が読む形に変換する。

    python3 scripts/build_itc_dataset.py --data data/itc

入力: roadmap.json / materials/*.json / questions/bundle_*.json / topics_candidates.json
出力（すべて data/itc/ 直下。手で編集しない）:
  syllabus.json         自前の階層。分野（4）→ 中分類 を syllabus_items に写す（major は分野名と同じ）
  topics.json           単位＝論点。id は候補 id で固定（topic_ids.json にも書く）。sort_order がロードマップの順
  exam_labels.json      「回」＝日。itc-d01 … itc-d14 → 「1 日目」…
  answer_keys.json      確認問題の正解
  questions/itc-dNN.json  1 日 3 単位 × 2 問 = 6 問を「回」として持つ（past_questions に入る。出典は自作の確認問題）
  question_explanations/roadmap.json  問題の reason を correct_reason に、choice_notes を選択肢ごとの note に
  materials_v3/roadmap.json           教材に「### 出典」を足した版（build_seed は後の世代を優先して読む）

資格版との違い: 出題頻度（question_count）は 2 で一定なので、並びは sort_order で決める（API 側が roadmap の試験だけ sort_order を見る）。
"""
from __future__ import annotations
import argparse, glob, json, re, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", default="data/itc", type=Path)
    a = ap.parse_args(); d = a.data
    rm = json.loads((d / "roadmap.json").read_text(encoding="utf-8")); units = rm["units"]
    cands = {c["id"]: c for c in json.loads((d / "topics_candidates.json").read_text(encoding="utf-8"))["candidates"]}
    mats: dict[int, dict] = {}
    for f in sorted(glob.glob(str(d / "materials" / "*.json"))):
        for m in json.loads(Path(f).read_text(encoding="utf-8"))["materials"]: mats[m["topic_id"]] = m
    qs: dict[int, list[dict]] = {}
    for f in sorted(glob.glob(str(d / "roadmap_questions" / "bundle_*.json"))):
        for q in json.loads(Path(f).read_text(encoding="utf-8"))["questions"]: qs.setdefault(q["topic_id"], []).append(q)
    unit_ids = {u["topic_id"] for u in units}
    missing = [u["term"] for u in units if u["topic_id"] not in mats]; assert not missing, f"教材が無い: {missing}"
    bad = [u["term"] for u in units if len(qs.get(u["topic_id"], [])) != 2]; assert not bad, f"問題が 2 問でない: {bad}"
    # 補足: ロードマップから外したが教材を残す単位（本人の決定 2026-09-15「別枠で残す」）。5 つ目の分野「補足（ロードマップ外）」に
    # sort_order 43〜 で並べ、確認問題は「回」itc-ex（ラベル「補足」）に入れる。問題が無い単位も載せる（question_count 0）
    extra_ids = sorted(set(mats) - unit_ids)
    day_ex = rm["days"] + 1
    for i, tid in enumerate(extra_ids, 1):
        m = mats[tid]
        units.append({"order": len(units) + 1, "day": day_ex, "topic_id": tid, "term": m["term"], "field": "補足（ロードマップ外）", "middle": "ロードマップ外",
                      "summary": "", "goals": [], "prereq": [], "sources": [], "_extra": True})

    # --- 階層: 分野 → 中分類 ---
    fields = ["業界と仕事", "ITと業務の基礎知識", "論理思考とケース", "選考と自己理解", "補足（ロードマップ外）"]
    items: list[dict] = []; item_no: dict[tuple[str, str], int] = {}
    for fi, fld in enumerate(fields, 1):
        mids = []
        for u in units:
            if u["field"] == fld and u["middle"] not in mids: mids.append(u["middle"])
        for mi, mid in enumerate(mids, 1):
            n = len(items) + 1; item_no[(fld, mid)] = n
            items.append({"number": n, "name": mid, "field": fld, "major_no": fi, "major": fld, "middle_no": n, "middle": mid,
                          "terms": [u["term"] for u in units if u["field"] == fld and u["middle"] == mid]})
    (d / "syllabus.json").write_text(json.dumps({"version": "roadmap-itc-2026-09-15", "source": "自前の階層（要件定義書 §13）", "item_count": len(items),
                                                 "term_count": len(units), "items": items}, ensure_ascii=False, indent=1), encoding="utf-8")

    # --- 回＝日。問題番号は日の中で 1..6 ---
    per_day = rm["per_day"]; labels: dict[str, str] = {}; keys: dict[str, dict] = {}; qfiles: dict[str, list] = {}
    qid_of: dict[str, str] = {}  # 元の qid → 新しい question_id
    for u in units:
        exam = "itc-ex" if u.get("_extra") else f"itc-d{u['day']:02d}"; labels[exam] = "補足（ロードマップ外）" if u.get("_extra") else f"{u['day']} 日目"
        for q in sorted(qs.get(u["topic_id"], []), key=lambda q: q["qid"]):
            lst = qfiles.setdefault(exam, []); n = len(lst) + 1
            lst.append({"number": n, "page": None, "text": q["stem"], "choices": q["choices"], "has_figure": False, "figure_description": None,
                        "confidence": "high", "notes": None, "source_qid": q["qid"], "tests_goal": q["tests_goal"], "topic_id": u["topic_id"]})
            keys.setdefault(exam, {})[str(n)] = q["answer"]; qid_of[q["qid"]] = f"{exam}-q{n}"
    (d / "questions").mkdir(exist_ok=True)
    for exam, lst in qfiles.items():
        (d / "questions" / f"{exam}.json").write_text(json.dumps({"exam": exam, "source": "roadmap 確認問題（自作）", "normalized": True,
                                                                  "question_count": len(lst), "questions": lst}, ensure_ascii=False, indent=1), encoding="utf-8")
    (d / "exam_labels.json").write_text(json.dumps(labels, ensure_ascii=False, indent=1), encoding="utf-8")
    (d / "answer_keys.json").write_text(json.dumps(keys, ensure_ascii=False, indent=1), encoding="utf-8")

    # --- 論点 ---
    topics = []
    for u in units:
        c = cands.get(u["topic_id"], {})
        topics.append({"id": u["topic_id"], "term": u["term"], "match_key": u["term"], "syllabus_item": item_no[(u["field"], u["middle"])],
                       "syllabus_item_name": u["middle"], "field": u["field"], "major": u["field"], "middle": u["middle"], "is_new": False,
                       "related_terms": [], "question_count": len(qs.get(u["topic_id"], [])), "sort_order": u["order"],
                       "questions": [{"exam": qid_of[q["qid"]].rsplit("-q", 1)[0], "number": int(qid_of[q["qid"]].rsplit("-q", 1)[1])} for q in qs.get(u["topic_id"], [])],
                       "aliases": c.get("aliases", [])})
    (d / "topics.json").write_text(json.dumps({"topic_count": len(topics), "question_count": sum(len(v) for v in qfiles.values()), "exams": sorted(qfiles),
                                               "topics": topics}, ensure_ascii=False, indent=1), encoding="utf-8")
    (d / "topic_ids.json").write_text(json.dumps({t["match_key"]: t["id"] for t in topics}, ensure_ascii=False, indent=1), encoding="utf-8")

    # --- 問題解説（reason → correct_reason。誤答の note は空）---
    sys.path.insert(0, str(Path(__file__).parent)); from build_seed import content_key_of  # 同じ鍵の作り方
    expl = []
    for exam, lst in qfiles.items():
        for qq in lst:
            src = next(q for q in qs[qq["topic_id"]] if q["qid"] == qq["source_qid"])
            expl.append({"question_id": f"{exam}-q{qq['number']}", "content_key": content_key_of(qq), "correct": src["answer"],
                         "correct_reason": src["reason"],
                         "choices": [{"label": k, "term": None, "note": (src.get("choice_notes") or {}).get(k) or ("正解。" if k == src["answer"] else "")} for k in ("ア", "イ", "ウ", "エ")]})
    (d / "question_explanations").mkdir(exist_ok=True)
    (d / "question_explanations" / "roadmap.json").write_text(json.dumps({"bundle": "roadmap", "explanations": expl}, ensure_ascii=False, indent=1), encoding="utf-8")

    # --- 教材 v3: 出典を末尾に ---
    v3 = []
    for u in units:
        m = dict(mats[u["topic_id"]]); srcs = m.pop("sources", [])
        if srcs:
            m["detail"] = m["detail"].rstrip() + "\n### 出典\n" + "\n".join(f"- {s['name']}（{s.get('where', '')}）" if s.get("where") and s["where"] != "—" else f"- {s['name']}" for s in srcs)
        v3.append(m)
    (d / "materials_v3").mkdir(exist_ok=True)
    (d / "materials_v3" / "roadmap.json").write_text(json.dumps({"bundle": "roadmap", "materials": v3}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"項目 {len(items)} / 論点 {len(topics)}（補足 {len(extra_ids)}）/ 回 {len(qfiles)}（日は各 {per_day * 2} 問）/ 問題 {sum(len(v) for v in qfiles.values())} / 解説 {len(expl)} / 教材 v3 {len(v3)}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
