#!/usr/bin/env python3
"""学習者役の答えと自己申告を、その周のパックの写しで採点し、周の結果を学びの置き場の eval の下に残す。

    python3 scripts/grade_learner.py --data data/eng --cycle 8 --answers ../learner_packs/eng_c8/learner_answers.json [--explain <説明テストの採点>]

契約は UC-019 の contract.yaml の gradeLearnerAnswers。標準出力に周の結果の JSON を 1 つ出す（成功 0、errors に当たれば 1）。
"""
from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from learner_io import read_json  # noqa: E402
from learner_eval import (CHOICES, Refused, contract_args, current_questions, result_path,  # noqa: E402
                          roadmap_learning, run, snapshot_path, write_exclusive)

SHIFT_WINDOW = 3
# 自己申告の欄の別名 → 決めた名前（契約の LearnerAnswers）
ALIASES = {"understood": ("understanding", "understand"),
           "confusing": ("confusing_with",),
           "unknown_terms": ("unclear_terms", "unexplained_terms")}


# @implements REQ-322
# @operation UC-019#readPackSnapshot
def read_snapshot(d: Path, cycle: int) -> dict:
    p = snapshot_path(d, cycle)
    if not p.is_file():
        raise Refused("NOT_FOUND", "その周のパックの写しが無い")
    return readable_snapshot(p)


def _pos_int(v) -> bool:
    return type(v) is int and v >= 1


def _text(v) -> bool:
    return isinstance(v, str) and v != ""


# @implements REQ-334
def readable_snapshot(p: Path) -> dict:
    """写しを契約の PackSnapshot の形として読む。読めなければその写しを挙げて止める。"""
    try:
        s = read_json(p)
        assert isinstance(s, dict) and _pos_int(s.get("cycle"))
        assert isinstance(s.get("units"), list) and isinstance(s.get("questions"), list)
        for u in s["units"]:
            assert isinstance(u, dict) and _pos_int(u.get("order")) and _pos_int(u.get("topic_id"))
            assert _text(u.get("term")) and _text(u.get("field"))
        for q in s["questions"]:
            assert isinstance(q, dict) and _text(q.get("qid")) and _pos_int(q.get("topic_id")) and _pos_int(q.get("tests_goal"))
            assert _text(q.get("field")) and q.get("answer") in CHOICES
        units = {u["topic_id"] for u in s["units"]}
        assert all(q["topic_id"] in units for q in s["questions"])
    except (OSError, ValueError, AssertionError):
        raise Refused("INVALID_INPUT", "その周のパックの写しが読めない", unreadable=[p.as_posix()])
    return s


# @implements REQ-332
# @operation UC-019#readCycleResult
def check_result_free(d: Path, cycle: int) -> None:
    p = result_path(d, cycle)
    if p.exists():
        raise Refused("CONFLICT", "その周の結果が既にある")


# @implements REQ-329
# @operation UC-019#readLearnerAnswers
def read_answers(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        raise Refused("NOT_FOUND", "答えのファイルが無い", unreadable=[path])
    try:
        L = read_json(p)
        assert isinstance(L, dict) and isinstance(L.get("answers"), dict) and isinstance(L.get("units"), list)
    except (OSError, ValueError, AssertionError):
        raise Refused("INVALID_INPUT", "答えのファイルが読めない", unreadable=[path])
    outside = sorted(q for q, v in L["answers"].items() if v not in CHOICES)
    if outside:
        raise Refused("INVALID_INPUT", "選択肢の外の答えがある", qids=outside)
    return L


# @implements REQ-330
# @operation UC-019#readExplainGrades
def read_explain_grades(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        raise Refused("NOT_FOUND", "説明テストの採点のファイルが無い", unreadable=[path])
    try:
        g = read_json(p)["grades"]
        assert isinstance(g, dict) and all(type(v) is int and v in (0, 1, 2) for v in g.values())
    except (OSError, ValueError, KeyError, TypeError, AssertionError):
        raise Refused("INVALID_INPUT", "説明テストの採点のファイルが読めない", unreadable=[path])
    return g


def _in_range(name: str, v) -> bool:
    """契約の LearnerAnswers の欄の値の範囲。"""
    if name == "understood":
        return type(v) is int and v in (1, 2, 3)
    if name == "confusing":
        return isinstance(v, str)
    if name == "unknown_terms":
        return isinstance(v, list) and all(isinstance(w, str) for w in v)
    if name == "minutes":
        return type(v) in (int, float) and v >= 0
    return True


# @implements REQ-312
def unreadable_rows(rows: list, unit_ids: set[int]) -> list[dict]:
    """自己申告の読めない行を、当たった条件（契約の ToolError の conditions の語）とともにすべて挙げる。"""
    ids = [r.get("topic_id") if isinstance(r, dict) else None for r in rows]
    valid = lambda v: type(v) is int  # noqa: E731
    count: dict[int, int] = {}
    for v in ids:
        if valid(v):
            count[v] = count.get(v, 0) + 1
    hits = []
    for i, r in enumerate(rows):
        cond = []
        tid = r.get("topic_id") if isinstance(r, dict) else None
        if not isinstance(r, dict) or "topic_id" not in r:
            cond.append("missingId")
        elif not valid(tid):
            cond.append("idNotInteger")
        else:
            if tid not in unit_ids:
                cond.append("idNotInSnapshot")
            if count[tid] > 1:
                cond.append("duplicateId")
        if isinstance(r, dict):
            conflict = out_of_range = False
            for name, alts in (*ALIASES.items(), ("minutes", ())):
                keys = [k for k in (name, *alts) if k in r]
                if any(r[k] != r[keys[0]] for k in keys[1:]):
                    conflict = True
                if any(not _in_range(name, r[k]) for k in keys):
                    out_of_range = True
            cond += ["aliasConflict"] * conflict + ["valueOutOfRange"] * out_of_range
        if cond:
            hits.append({"index": i, "conditions": cond})
    return hits


# @implements REQ-311
def normalize_row(r: dict) -> dict:
    """別名を決めた名前に写す。"""
    v = dict(r)
    for name, alts in ALIASES.items():
        for a in alts:
            if a in v:
                x = v.pop(a)
                v.setdefault(name, x)
    return v


# @implements REQ-310
def grade_questions(snap: dict, answers: dict, current: list[dict]) -> tuple[list[dict], list[str]]:
    """写しの問題と正解で採点し、写しと今とで正解が変わった問題を挙げる。"""
    now = {q["qid"]: q["answer"] for q in current}
    graded = [dict(q, picked=answers.get(q["qid"]), ok=answers.get(q["qid"]) == q["answer"]) for q in snap["questions"]]
    changed = [q["qid"] for q in snap["questions"] if q["qid"] in now and now[q["qid"]] != q["answer"]]
    return graded, changed


# @implements REQ-313
def shift_suspects(graded: list[dict]) -> list[str]:
    out: list[str] = []
    for i in range(len(graded) - SHIFT_WINDOW + 1):
        win = graded[i:i + SHIFT_WINDOW]
        if any(q["ok"] for q in win):
            continue
        picked = [q["picked"] for q in win]
        truth = [q["answer"] for q in win]
        if picked[1:] == truth[:-1] or picked[:-1] == truth[1:]:
            out.extend(q["qid"] for q in win if q["qid"] not in out)
    return out


def _frac(c: int, n: int) -> str:
    return f"{c}/{n}"


# @implements REQ-339
# @operation UC-019#readCycleResult
def previous_result(d: Path, cycle: int) -> dict | None:
    """その周より小さい番号の周の結果のうち最も大きい番号の物。契約の readCycleResult の形として読めなければ挙げて止める。"""
    prev = []
    for p in (d / "eval").glob("cycle_*.json"):
        n = p.stem[len("cycle_"):]
        if n.isdigit() and int(n) < cycle:
            prev.append((int(n), p))
    if not prev:
        return None
    p = max(prev)[1]
    num = lambda v, hi: type(v) in (int, float) and 0 <= v <= hi  # noqa: E731
    try:
        r = read_json(p)
        assert isinstance(r, dict) and type(r.get("cycle")) is int and r["cycle"] >= 1
        assert num(r.get("rate"), 1) and num(r.get("avg_understood"), 3)
    except (OSError, ValueError, AssertionError):
        raise Refused("INVALID_INPUT", "差を取る前の周の結果が読めない", unreadable=[p.as_posix()])
    return r


# @implements REQ-314
def cycle_result(cycle: int, snap: dict, graded: list[dict], changed: list[str], rows: list[dict],
                 grades: dict | None, prev: dict | None) -> dict:
    per_unit: dict[str, dict] = {}
    for u in snap["units"]:
        per_unit[str(u["topic_id"])] = {"term": u["term"], "field": u["field"], "correct": 0, "total": 0, "understood": None}
    by_goal: dict[int, list[int]] = {}
    by_field: dict[str, list[int]] = {}
    for q in graded:
        pu = per_unit[str(q["topic_id"])]
        pu["total"] += 1
        pu["correct"] += q["ok"]
        for acc in (by_goal.setdefault(q["tests_goal"], [0, 0]), by_field.setdefault(q["field"], [0, 0])):
            acc[0] += q["ok"]
            acc[1] += 1
    for r in rows:
        pu = per_unit[str(r["topic_id"])]
        for k in ("understood", "confusing", "unknown_terms", "minutes"):
            if k in r:
                pu[k] = r[k]
    correct = sum(q["ok"] for q in graded)
    total = len(graded)
    reported = [pu["understood"] for pu in per_unit.values() if pu["understood"] is not None]

    def ref(tid: str) -> dict:
        x = {"topic_id": int(tid), "term": per_unit[tid]["term"]}
        if per_unit[tid].get("confusing"):
            x["confusing"] = per_unit[tid]["confusing"]
        return x

    res = {"cycle": cycle, "score": _frac(correct, total), "rate": round(correct / total, 3) if total else 0,
           "by_goal": {str(g): _frac(*by_goal[g]) for g in sorted(by_goal)},
           "by_field": {f: _frac(*v) for f, v in by_field.items()},
           "per_unit": per_unit,
           "reported_units": len(reported),
           "avg_understood": round(sum(reported) / len(reported), 2) if reported else 0,
           "stuck_units": [ref(t) for t, pu in per_unit.items()
                           if pu["understood"] == 1 or (pu["total"] and pu["correct"] == 0)],
           "overconfident_units": [ref(t) for t, pu in per_unit.items()
                                   if pu["understood"] == 3 and pu["correct"] < pu["total"]],
           "unknown_terms": sorted({w for pu in per_unit.values() for w in pu.get("unknown_terms", [])}),
           "shift_suspect": shift_suspects(graded),
           "shift_window": SHIFT_WINDOW,
           "wrong": [{"qid": q["qid"], "picked": q["picked"], "answer": q["answer"]} for q in graded if not q["ok"]],
           "changed_answers": changed}
    if grades is not None:
        res["explain"] = {"rate": round(sum(grades.values()) / (2 * len(grades)), 3) if grades else 0,
                          "can_explain": sum(1 for v in grades.values() if v == 2), "n": len(grades)}
    if prev is not None:
        res["delta_rate"] = round(res["rate"] - prev["rate"], 3)
        res["delta_understood"] = round(res["avg_understood"] - prev["avg_understood"], 2)
    return res


# @implements UC-019, REQ-340
# @operation UC-019#gradeLearnerAnswers
def main() -> dict:
    a = contract_args("grade_learner.py", {"data": "data", "cycle": "cycle", "answers": "text", "explain": "text"},
                      ("data", "cycle", "answers"))
    d, _, _ = roadmap_learning(a.data)
    current = current_questions(d)
    snap = read_snapshot(d, a.cycle)
    check_result_free(d, a.cycle)
    prev = previous_result(d, a.cycle)
    L = read_answers(a.answers)
    grades = read_explain_grades(a.explain) if a.explain is not None else None
    hits = unreadable_rows(L["units"], {u["topic_id"] for u in snap["units"]})
    if hits:
        raise Refused("INVALID_INPUT", "自己申告に読めない行がある", rows=hits)
    rows = [normalize_row(r) for r in L["units"]]
    graded, changed = grade_questions(snap, L["answers"], current)
    res = cycle_result(a.cycle, snap, graded, changed, rows, grades, prev)
    write_result(d, a.cycle, res)
    return res


# @implements REQ-356
# @operation UC-019#writeCycleResult
def write_result(d: Path, cycle: int, res: dict) -> None:
    """周の結果を排他の作成で書く。採点する間にほかの呼び出しが同じ周の結果を書いていれば、書き換えずに断る。"""
    if not write_exclusive(result_path(d, cycle), res):
        raise Refused("CONFLICT", "採点する間に同じ周の結果が書かれた")


if __name__ == "__main__":
    sys.exit(run(main))
