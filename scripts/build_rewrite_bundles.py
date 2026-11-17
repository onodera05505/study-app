#!/usr/bin/env python3
"""資格対策の教材の書き直しに配る束を作る。

    python3 scripts/build_rewrite_bundles.py --unit-inputs --data data/ip --out data/ip/unit_inputs            # 単元の入力の束（全単元）
    python3 scripts/build_rewrite_bundles.py --unit-inputs --data data/ip --out data/ip/unit_inputs --units 21 23
    python3 scripts/build_rewrite_bundles.py --data data/ip --out data/ip/rewrite_bundles --units 21          # 書き直しの束

契約は docs/goals/GOAL-11-run-content-pipeline/UC-026-build-rewrite-bundles/contract.yaml（入口 buildUnitInputs・
buildRewriteBundles、束の形 writeUnitInput・writeRewriteBundle）。束の中身の使い方は scripts/prompts/unit_plan.md と
scripts/prompts/rewrite_materials_by_group.md。data と out はコマンドを呼んだ作業ディレクトリからのパスとして読む。

標準出力には成功なら契約の BuildResult の JSON（終了コード 0）、契約の errors に当たれば契約の ToolError
（{"error": {"code", "reason"}}、終了コード 2）を出す。断る順は契約の errors の順。束は全部を組み立ててから書き出し、途中で書き出せなければ書いた分を消して、1 つも残さない。
既にある束・単元の構成・教材の世代は書き換えない。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_seed import content_key_of, exam_rank, read_explanations  # noqa: E402
from material_generations import select_materials  # noqa: E402
from check_unit_plans import (  # noqa: E402
    Refused, gate_findings, learning_files, learning_order, qualification_learning, tool_error,
)
from learning_parts import topic_units  # noqa: E402

UNIT_INPUT_NAME = re.compile(r"^[0-9]{2}\.json$")
REWRITE_BUNDLE_NAME = re.compile(r"^[0-9]{2}-[1-9][0-9]*\.json$")


def _read(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


# @implements REQ-461, REQ-462
def latest_materials(d: Path) -> dict[int, tuple[str, dict]]:
    """論点 ID → (世代の名前, 教材)。選び方は配る本文と同じ material_generations.select_materials。"""
    return {tid: (c.generation, c.material) for tid, c in select_materials(d).items()}


# @implements REQ-461
def topical_units(syllabus: dict[int, dict], topics: list[dict]) -> list[int]:
    """論点が 1 つ以上あるシラバスの単元の番号。"""
    unit_of = topic_units(syllabus, topics)
    return sorted(u for u in syllabus if any(v == u for v in unit_of.values()))


# @implements REQ-465
def requested_units(units: list[int] | None, syllabus: dict[int, dict], topics: list[dict]) -> list[int]:
    """束を作る単元の番号。指定が無ければ論点のあるすべての単元。指定にシラバスに無い単元があれば断る。"""
    if not units:
        return topical_units(syllabus, topics)
    unknown = sorted({u for u in units if u not in syllabus})
    if unknown:
        raise Refused("INVALID_INPUT", f"指定した単元 {unknown} がシラバスに無い")
    return sorted(set(units))


# @implements REQ-464
def refuse_existing_output(out: Path, name: re.Pattern) -> None:
    """出力先に既に束のファイルがあれば、何も書き出さずに断る。"""
    if out.is_dir():
        found = sorted(p.name for p in out.iterdir() if name.match(p.name))
        if found:
            raise Refused("CONFLICT", f"出力先 {out} に既に束のファイルがある（{len(found)} 件）")


# @implements REQ-464
# @operation UC-026#writeUnitInput
# @operation UC-026#writeRewriteBundle
def write_all(out: Path, files: list[tuple[str, dict]]) -> list[str]:
    """組み立てた束をすべて新しいファイルとして書き出す。1 つでも書き出せなければ書いた分を消して断る。"""
    written: list[Path] = []
    created = not out.exists()

    def undo() -> None:
        for p in written:
            p.unlink(missing_ok=True)
        if created and out.is_dir() and not any(out.iterdir()):
            out.rmdir()

    try:
        out.mkdir(parents=True, exist_ok=True)
        for name, body in files:
            p = out / name
            with p.open("x", encoding="utf-8") as f:
                written.append(p)
                f.write(json.dumps(body, ensure_ascii=False, indent=2) + "\n")
    except FileExistsError:
        undo()
        raise Refused("CONFLICT", f"出力先 {out} に既に束のファイルがある")
    except OSError as e:
        undo()
        raise Refused("STORAGE_UNAVAILABLE", f"{out} に書き出せない（{e.strerror or e}）")
    return [str(out / name) for name, _ in files]


# @implements REQ-461
def unit_inputs(d: Path, units: list[int], syllabus: dict[int, dict], topics: list[dict]) -> list[tuple[str, dict]]:
    """論点のある単元ごとに 1 つ、その単元の全論点を小項目と論点 ID の順に並べ、最も新しい世代の教材を持つ単元の入力の束を組み立てる。
    論点の無い単元の束は組み立てない。"""
    unit_of = topic_units(syllabus, topics)
    materials = latest_materials(d)
    files: list[tuple[str, dict]] = []
    for u in units:
        s = syllabus[u]
        mine = sorted((t for t in topics if unit_of[t["id"]] == u), key=lambda t: (t["syllabus_item"], t["id"]))
        if not mine:
            continue
        items = []
        for t in mine:
            m = materials.get(t["id"], ("", {}))[1]
            items.append({
                "topic_id": t["id"],
                "term": t["term"],
                "syllabus_item": t["syllabus_item"],
                "syllabus_item_name": t.get("syllabus_item_name") or s["items"].get(t["syllabus_item"], ""),
                "question_count": t.get("question_count", 0),
                "related_terms": t.get("related_terms", []),
                "explanation": m.get("explanation") or "",
                "detail": m.get("detail") or "",
            })
        files.append((f"{u:02d}.json", {
            "unit_no": u, "unit": s["unit"], "field": s["field"], "major": s["major"], "topics": items,
        }))
    return files


def _figure_files(d: Path) -> dict[int, tuple[str, list]]:
    """論点 ID → (図の仕様のパス, figures)。図の仕様は material_figures/*.json の 1 ファイル＝1 論点。"""
    out: dict[int, tuple[str, list]] = {}
    src = d / "material_figures"
    for p in sorted(src.glob("*.json")) if src.is_dir() else []:
        if p.name.startswith("_"):
            continue
        try:
            spec = _read(p)
            out[int(spec["topic_id"])] = (str(p), spec.get("figures", []))
        except (OSError, ValueError, KeyError, TypeError):
            print(f"[警告] 図の仕様が読めない {p}（束では図が無い論点として扱う）", file=sys.stderr)
    return out


def _folded_questions(d: Path) -> dict[str, dict]:
    """問題 ID → 問題。正解表に正解の無い問題は answer を None で持つ。
    正解表のファイルが無ければ、どの問題にも正解が無いものとして持つ（束に入る過去問があれば refuse_missing_answers が断る）。"""
    keys_path = d / "answer_keys.json"
    keys = _read(keys_path) if keys_path.is_file() else {}
    labels = _read(d / "exam_labels.json") if (d / "exam_labels.json").exists() else {}
    out: dict[str, dict] = {}
    for path in sorted((d / "questions").glob("*.json")):
        data = _read(path)
        exam = data["exam"]
        for q in data["questions"]:
            answer = keys.get(exam, {}).get(str(q["number"])) or None
            out[f"{exam}-q{q['number']}"] = {
                "question_id": f"{exam}-q{q['number']}",
                "content_key": content_key_of(q),
                "exam_label": labels.get(exam, exam),
                "stem": q.get("text", ""),
                "choices": q.get("choices", {}),
                "answer": answer,
                "has_figure": bool(q.get("has_figure")),
                "figure_description": q.get("figure_description"),
                "_exam": exam,
            }
    return out


def _linked_questions(t: dict, questions: dict[str, dict]) -> list[dict]:
    """論点に紐づく過去問のうち、問題のファイルにある物。"""
    return [q for link in t.get("questions", []) if (q := questions.get(f"{link['exam']}-q{link['number']}"))]


# @implements REQ-492
def refuse_missing_answers(units: list[int], plans: dict[int, dict], questions: dict[str, dict], by_id: dict[int, dict]) -> None:
    """同一内容の組を 1 件に畳んだあとに束に入る代表の過去問に、正解表に正解の無い物があれば、束を 1 つも
    書き出さずに断る。畳まれて束に入らない過去問の正解が無いだけでは断らない。"""
    missing = sorted({q["question_id"] for u in units for g in plans[u]["groups"] for tid in g["topics"]
                      for q in topic_questions(by_id[tid], questions) if not q["answer"]})
    if missing:
        raise Refused("NOT_FOUND", f"束に入る過去問 {missing} の正解が正解表に無い")


# @implements BR-052
def explanation_index(d: Path, questions: dict[str, dict]) -> dict[str, dict]:
    """content_key → 問題解説。解説の content_key で結び、解説に鍵が無ければ解説を書いた過去問から同じ判定で作る。"""
    explanations, _ = read_explanations(d)
    for path in sorted((d / "question_explanations").glob("*.json")):
        for e in _read(path).get("explanations", []):
            q = questions.get(e.get("question_id", ""))
            if not e.get("content_key") and q:
                explanations.setdefault(q["content_key"], e)
    return explanations


# @implements REQ-462, REQ-492
def topic_questions(t: dict, questions: dict[str, dict]) -> list[dict]:
    """論点に紐づく過去問を同一内容（content_key）で 1 件に畳む。代表は最も新しい回の問題で、新しい順に並べる。"""
    best: dict[str, dict] = {}
    for q in _linked_questions(t, questions):
        if (q["content_key"] not in best or exam_rank(q["_exam"]) > exam_rank(best[q["content_key"]]["_exam"])):
            best[q["content_key"]] = q
    ordered = sorted(best.values(), key=lambda q: (exam_rank(q["_exam"]), q["question_id"]), reverse=True)
    return [{k: v for k, v in q.items() if k != "_exam"} for q in ordered]


# @implements REQ-462
def rewrite_bundles(d: Path, units: list[int], plans: dict[int, dict], topics: list[dict],
                    questions: dict[str, dict]) -> list[tuple[str, dict]]:
    """単元の構成のまとまりごとに 1 つ、学ぶ順の論点と各論点の教材・過去問・問題解説・図の仕様・前提、
    まとまりの論点が触れる受け持ちを持つ書き直しの束を組み立てる。"""
    by_id = {t["id"]: t for t in topics}
    ref = lambda tid: {"topic_id": tid, "term": by_id[tid]["term"]}  # noqa: E731
    materials = latest_materials(d)
    explanations = explanation_index(d, questions)
    figures = _figure_files(d)
    files: list[tuple[str, dict]] = []
    for u in units:
        plan = plans[u]
        groups_in_unit = [{"index": i, "name": g["name"], "topics": [ref(t) for t in g["topics"]]}
                          for i, g in enumerate(plan["groups"], start=1)]
        pres = plan.get("prerequisites", {})
        order = learning_order(plan)
        for i, g in enumerate(plan["groups"], start=1):
            mine = set(g["topics"])
            owners = [{"subject": o["subject"], "owner": ref(o["owner"]), "topics": o["topics"]}
                      for o in plan["owners"] if mine & set(o["topics"])]
            items = []
            for tid in sorted(mine, key=order.index):
                t = by_id[tid]
                gen, m = materials.get(tid, ("materials", {}))
                qs = topic_questions(t, questions)
                fig = figures.get(tid)
                items.append({
                    "topic_id": tid,
                    "term": t["term"],
                    "field": t.get("field", ""),
                    "major": t.get("major", ""),
                    "middle": t.get("middle", ""),
                    "syllabus_item_name": t.get("syllabus_item_name", ""),
                    "question_count": t.get("question_count", 0),
                    "related_terms": t.get("related_terms", []),
                    "prerequisites": [ref(p) for p in pres.get(str(tid), [])],
                    "current": {"generation": gen, "explanation": m.get("explanation") or "", "detail": m.get("detail") or ""},
                    "questions": qs,
                    "question_explanations": [
                        {"question_id": e.get("question_id") or q["question_id"], "content_key": q["content_key"],
                         "correct_reason": e.get("correct_reason", ""), "choices": e.get("choices", [])}
                        for q in qs if (e := explanations.get(q["content_key"]))
                    ],
                    "figure_file": fig[0] if fig else None,
                    "figures": fig[1] if fig else [],
                })
            bundle = f"{u:02d}-{i}"
            files.append((f"{bundle}.json", {
                "bundle": bundle, "unit_no": u, "unit": plan["unit"], "overview": plan["overview"],
                "group": {"index": i, "name": g["name"], "description": g["description"]},
                "groups_in_unit": groups_in_unit, "owners": owners, "topics": items,
            }))
    return files


# @implements REQ-463, BR-048
def gated_plans(d: Path, units: list[int]) -> dict[int, dict]:
    """求めた単元の単元の構成を返す。どれかが無ければ NOT_FOUND、学びの全部の単元の構成と合わせて判定した
    教材の門の止める理由のうち求めた単元の構成に関わる物があれば CONFLICT で断る。他の単元だけの止める理由では断らない。"""
    _, plans, stops = gate_findings(d)
    wanted = {f"{u:02d}.json" for u in units}
    missing = [u for u in units if not (d / "unit_plans" / f"{u:02d}.json").is_file()]
    if missing:
        raise Refused("NOT_FOUND", f"単元 {missing} の単元の構成が無い")
    mine = [f for f in stops if wanted & set(f["_files"])]
    if mine:
        lines = "；".join(f"[{f['kind']}] {f['where']}: {f['reason']}" for f in mine)
        raise Refused("CONFLICT", f"求めた単元の単元の構成に教材の門の止める理由が {len(mine)} 件ある（{lines}）")
    return plans


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="資格対策の教材の書き直しに配る束を作る")
    ap.add_argument("--data", required=True, help="学びの置き場（例 data/ip）")
    ap.add_argument("--out", required=True, type=Path, help="束を書き出す置き場")
    ap.add_argument("--units", nargs="+", type=int, help="束を作る単元の番号（省略すると論点のあるすべての単元）")
    ap.add_argument("--unit-inputs", action="store_true", help="単元の入力の束を作る（省略すると書き直しの束）")
    return ap.parse_args()


# @implements UC-026, REQ-461, REQ-462
# @operation UC-026#buildUnitInputs
# @operation UC-026#buildRewriteBundles
def main() -> int:
    args = _parse_args()
    try:
        d = qualification_learning(args.data)
        syllabus, topics = learning_files(d)
        units = requested_units(args.units, syllabus, topics)
        if args.unit_inputs:
            refuse_existing_output(args.out, UNIT_INPUT_NAME)
            files = unit_inputs(d, units, syllabus, topics)
        else:
            refuse_existing_output(args.out, REWRITE_BUNDLE_NAME)
            plans = gated_plans(d, units)
            questions = _folded_questions(d)
            refuse_missing_answers(units, plans, questions, {t["id"]: t for t in topics})
            files = rewrite_bundles(d, units, plans, topics, questions)
        written = write_all(args.out, files)
    except Refused as e:
        print(tool_error(e))
        print(e.reason, file=sys.stderr)
        return 2
    print(json.dumps({"exitCode": 0, "written": written}, ensure_ascii=False, indent=1))
    print(f"束 {len(written)} 件を {args.out} に書き出しました", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
