#!/usr/bin/env python3
"""ロードマップ型の対象（data/<対象>）を、既存の投入経路（build_seed.py → check_seed.py → seed_remote.sh）が読む形に変換する。
対象ごとの値（分野の並び・補足の分野名・回のラベル）は登録簿 src/shared/targets.json の roadmapSpec から読む。

    python3 scripts/build_target_dataset.py --data data/itc

入力: roadmap.json / materials/*.json / questions/bundle_*.json / topics_candidates.json
出力（すべて data/itc/ 直下。手で編集しない）:
  syllabus.json         自前の階層。分野（4）→ 中分類 を syllabus_items に写す（major は分野名と同じ）
  topics.json           単位＝論点。id は候補 id で固定（topic_ids.json にも書く）。sort_order がロードマップの順。
                        round（回の ID）・round_label（回のラベル）・tier（印。登録簿 roadmapSpec.tiers を持つ学びだけ値、他は null）・
                        subtitle（副題。roadmap.json の units[].subtitle をそのまま移す。持たない単位と補足の単位は null）
  exam_labels.json      回の ID → 回の見出し
  answer_keys.json      確認問題の正解
  questions/<回の ID>.json   回に属する単位 × 2 問を「回」として持つ（past_questions に入る。出典は自作の確認問題）

回の ID と見出しは roadmap.json の束ね方で決まる:
  日（既定）: <対象>-dNN。見出しと round_label は roadmapSpec.roundLabel を {day} で埋めた語（例「1 日目」）
  章（group_by: chapter）: <対象>-cNN。round_label は章の名前、見出し（exam_label）は roadmapSpec.roundLabel を
      {day}（章の番号）と {label}（章の名前）で埋めた語。roundLabel に {label} が無ければ末尾に空白と章の名前を足す
  補足の論点: 回は roadmapSpec.extraRoundId、見出しと round_label は extraRoundLabel
  question_explanations/roadmap.json  問題の reason を correct_reason に、choice_notes を選択肢ごとの note に
  materials_v3/roadmap.json           教材に「### 出典」を足した版（build_seed は後の世代を優先して読む）

資格版との違い: 出題頻度（question_count）は 2 で一定なので、並びは sort_order で決める（API 側が roadmap の試験だけ sort_order を見る）。
"""
from __future__ import annotations
import argparse, glob, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tool_refusal import CODE, tool_error_line  # noqa: E402

# @implements REQ-539
def check_units(units: list[dict], mats: dict[int, dict], qs: dict[int, list[dict]], levels: set | None) -> tuple[str, str] | None:
    """ロードマップの単位に教材があり確認問題が 1 単位あたりの数（2 問）であること、印を持つ学び（levels が None でない）では
    補足の論点を含む全単位の印が登録簿の段にあることを確かめる。当たらなければ (断りの種類の名前, その単位の名前を挙げた断りの文) を返し、
    すべて満たせば None を返す。確かめる順は 教材 → 確認問題の数 → 印。"""
    road = [u for u in units if not u.get("_extra")]
    missing = [u["term"] for u in road if u["topic_id"] not in mats]
    if missing: return CODE.NOT_FOUND, f"教材が無い単位（何も書き出していない）: {'、'.join(missing)}"
    bad = [u["term"] for u in road if len(qs.get(u["topic_id"], [])) != 2]
    if bad: return CODE.INVALID_INPUT, f"確認問題が 2 問でない単位（何も書き出していない）: {'、'.join(bad)}"
    if levels is not None:
        lack = [u["term"] for u in units if u.get("tier") not in levels]
        if lack: return CODE.INVALID_INPUT, f"印が登録簿 roadmapSpec.tiers の段に無い単位（何も書き出していない）: {'、'.join(lack[:5])}"
    return None


# @implements REQ-540
def supplementary_units(units: list[dict], mats: dict[int, dict], cands: dict[int, dict], field: str, middle: str) -> list[dict]:
    """ロードマップの単位に無い論点の教材を、補足の分野・中分類の単位にして論点の ID の順に返す。order は学ぶ順の末尾から続け、
    `_extra` の印で補足の回に入れる。問題が無い論点も載せる（question_count 0）。印は候補の印を移す。"""
    unit_ids = {u["topic_id"] for u in units}
    return [{"order": len(units) + i, "topic_id": tid, "term": mats[tid]["term"], "field": field, "middle": middle,
             "summary": "", "goals": [], "prereq": [], "sources": [], "tier": cands.get(tid, {}).get("tier"), "_extra": True}
            for i, tid in enumerate(sorted(set(mats) - unit_ids), 1)]


# @implements REQ-582
def dataset_refusal(d: Path, registered: set[str]) -> tuple[str, str] | None:
    """投入データを書き出す前に断る学び。学びの置き場の最後の段が登録簿に無ければ INVALID_INPUT、学びの置き場に
    ロードマップのデータ（roadmap.json）が無ければ NOT_FOUND の (断りの種類の名前, 断りの文)。どちらでもなければ None。
    確かめる順は 登録簿 → ロードマップのデータ。"""
    if d.name not in registered:
        return CODE.INVALID_INPUT, f"登録簿に無い学び『{d.name}』（何も書き出していない。scripts/new_target.py で登録する）"
    if not (d / "roadmap.json").is_file():
        return CODE.NOT_FOUND, f"学びの置き場にロードマップのデータが無い（何も書き出していない）: {d / 'roadmap.json'}"
    return None


# @implements REQ-414, REQ-422, REQ-571
# @operation UC-030#buildTargetDataset
def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", default="data/itc", type=Path)
    a = ap.parse_args(); d = a.data; key = d.name
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target, targets
    refusal = dataset_refusal(d, set(targets()))
    if refusal:
        code, reason = refusal
        print(reason)
        print(tool_error_line(code, reason))
        return 1
    spec = target(key).get("roadmapSpec") or {}
    EXTRA_FIELD, EXTRA_MIDDLE = spec.get("extraField", "補足（ロードマップ外）"), spec.get("extraMiddle", "ロードマップ外")
    EXTRA_ROUND, EXTRA_LABEL, ROUND_LABEL = spec.get("extraRoundId", f"{key}-ex"), spec.get("extraRoundLabel", "補足（ロードマップ外）"), spec.get("roundLabel", "{day} 日目")
    rm = json.loads((d / "roadmap.json").read_text(encoding="utf-8")); units = rm["units"]
    by_chapter = rm.get("group_by") == "chapter"
    has_tiers = bool(spec.get("tiers"))
    def round_of(u: dict) -> tuple[str, str, str]:
        """(回の ID, round_label, 回の見出し)。"""
        if u.get("_extra"): return EXTRA_ROUND, EXTRA_LABEL, EXTRA_LABEL
        if by_chapter:
            n, name = u["round"], u["chapter"]
            head = ROUND_LABEL.format(day=n, label=name) if "{label}" in ROUND_LABEL else f"{ROUND_LABEL.format(day=n)} {name}"
            return f"{key}-c{n:02d}", name, head
        label = ROUND_LABEL.format(day=u["day"])
        return f"{key}-d{u['day']:02d}", label, label
    cands = {c["id"]: c for c in json.loads((d / "topics_candidates.json").read_text(encoding="utf-8"))["candidates"]}
    mats: dict[int, dict] = {}
    for f in sorted(glob.glob(str(d / "materials" / "*.json"))):
        for m in json.loads(Path(f).read_text(encoding="utf-8"))["materials"]: mats[m["topic_id"]] = m
    qs: dict[int, list[dict]] = {}
    for f in sorted(glob.glob(str(d / "roadmap_questions" / "bundle_*.json"))):
        for q in json.loads(Path(f).read_text(encoding="utf-8"))["questions"]: qs.setdefault(q["topic_id"], []).append(q)
    extra = supplementary_units(units, mats, cands, EXTRA_FIELD, EXTRA_MIDDLE)
    units.extend(extra)
    refusal = check_units(units, mats, qs, {t.get("level") for t in spec["tiers"]} if has_tiers else None)
    if refusal:
        code, reason = refusal
        print(reason)
        print(tool_error_line(code, reason))
        return 1
    # 副題は名前とは別の欄で受け取り、名前から切り出さない。欄が無い単位は副題なし。空の文字列や文字列でない値は投入しない
    bad_sub = [u["term"] for u in units if "subtitle" in u and u["subtitle"] is not None and (not isinstance(u["subtitle"], str) or not u["subtitle"].strip())]
    if bad_sub:
        reason = f"副題が空か文字列でない単位（何も書き出していない。副題が無いなら subtitle の欄を書かない）: {'、'.join(bad_sub[:5])}"
        print(reason)
        print(tool_error_line(CODE.INVALID_INPUT, reason))
        return 1

    # --- 階層: 分野 → 中分類 ---
    fields = list(target(key)["fields"])  # 登録簿の並び（補足の分野を含む）
    items: list[dict] = []; item_no: dict[tuple[str, str], int] = {}
    for fi, fld in enumerate(fields, 1):
        mids = []
        for u in units:
            if u["field"] == fld and u["middle"] not in mids: mids.append(u["middle"])
        for mi, mid in enumerate(mids, 1):
            n = len(items) + 1; item_no[(fld, mid)] = n
            items.append({"number": n, "name": mid, "field": fld, "major_no": fi, "major": fld, "middle_no": n, "middle": mid,
                          "terms": [u["term"] for u in units if u["field"] == fld and u["middle"] == mid]})
    (d / "syllabus.json").write_text(json.dumps({"version": f"roadmap-{key}-2026-09-15", "source": "自前の階層（要件定義書 §13）", "item_count": len(items),
                                                 "term_count": len(units), "items": items}, ensure_ascii=False, indent=1), encoding="utf-8")

    # --- 回。問題番号は回の中で 1.. ---
    labels: dict[str, str] = {}; keys: dict[str, dict] = {}; qfiles: dict[str, list] = {}
    qid_of: dict[str, str] = {}  # 元の qid → 新しい question_id
    for u in units:
        exam, _, labels_head = round_of(u); labels[exam] = labels_head
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
        topics.append({"id": u["topic_id"], "term": u["term"], "subtitle": u.get("subtitle"), "match_key": u["term"], "syllabus_item": item_no[(u["field"], u["middle"])],
                       "syllabus_item_name": u["middle"], "field": u["field"], "major": u["field"], "middle": u["middle"], "is_new": False,
                       "related_terms": [], "question_count": len(qs.get(u["topic_id"], [])), "sort_order": u["order"],
                       "questions": [{"exam": qid_of[q["qid"]].rsplit("-q", 1)[0], "number": int(qid_of[q["qid"]].rsplit("-q", 1)[1])} for q in qs.get(u["topic_id"], [])],
                       "aliases": c.get("aliases", []), "round": round_of(u)[0], "round_label": round_of(u)[1],
                       "tier": u.get("tier") if has_tiers else None})
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
    # 図があれば教材 v3 に画像行を差し込む（attach は materials_v2/v3 を編集する。source の materials/ は触らない）
    if any((d / "material_figures").glob("*.json")):
        import subprocess
        subprocess.run([sys.executable, str(Path(__file__).with_name("attach_material_figures.py")), "--data", str(d)], check=True)
    print(f"項目 {len(items)} / 論点 {len(topics)}（補足 {len(extra)}）/ 回 {len(qfiles)}（{'章' if by_chapter else '日'}で束ねる）/ 問題 {sum(len(v) for v in qfiles.values())} / 解説 {len(expl)} / 教材 v3 {len(v3)}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
