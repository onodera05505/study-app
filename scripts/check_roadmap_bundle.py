#!/usr/bin/env python3
"""書き手から上がったロードマップ型の束 1 つを教材の門にかける（契約 UC-020 の checkRoadmapBundle）。

    python3 scripts/check_roadmap_bundle.py --data data/itc --bundle bundle_01

- 門が読むファイル（割り当て・書き手の教材と確認問題・ロードマップ・集めた資料・登録簿）のパスは、作業ディレクトリが起点
  （登録簿は作業ディレクトリの src/shared/targets.json）
- 結果: 人が読む行（警告・止める理由・数の要約）のあとに、標準出力の最後の行として機械向けの 1 行
  {"exitCode","topics","questions","stops","warnings","limits"} を出す。止める理由が 1 件以上なら終了の状態 1、無ければ 0
- 断るとき（引数の誤り・登録簿に無い学び・ロードマップ型でない学び・割り当ての無い束）は、何も確かめずに
  標準出力に共有の形の断り（ToolError）を 1 行出して終了の状態 2 で終える
- 情報の量（字数・文数・見出しの数・箇条書きの項目の数）は止める理由にも警告にもしない（BR-042）。表示の制約は表だけ（BR-043）
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from tool_refusal import CODE, Refused, RefusingArgumentParser, tool_error_line  # noqa: E402

REGISTRY = Path("src/shared/targets.json")
CHOICES = ("ア", "イ", "ウ", "エ")
# 門が使う閾値と表示の制約（契約の limits）
LIMITS = {
    "verbatimLength": 14,
    "headingLevel": "###",
    "tableColumns": {"min": 2, "max": 4},
    "tableRows": {"min": 2, "max": 8},
    "tableCellLength": 40,
}
# 登録簿が値を持たない学びの既定（前の門と同じ）
DEFAULT_KEYWORD_LABEL = "キーワード"
DEFAULT_USAGE_SECTION = "面接で話すなら"
NG_DEFAULT = ["激務", "ブラック(?!ボックス)", "年収", "万円", "最新", "近年"]
# 集計を出典名にした書き方: 「記事の集計（interview_frequency）」「シラバスの集計」など（括弧の中の鍵は任意）
TALLY = re.compile(r"[^（]+の集計(?:（[a-z_]+）)?$")
NOT_A_SOURCE = "一般常識"


def _read_json(path: str):
    """JSON のファイルを読む。無ければ NOT_FOUND、JSON として読めなければ INVALID_INPUT の失敗を渡す。"""
    p = Path(path)
    if not p.is_file():
        raise Refused(CODE.NOT_FOUND, f"{path} が無い")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refused(CODE.INVALID_INPUT, f"{path} が JSON として読めない")


def _object_list(item: dict, key: str) -> bool:
    """項目がその欄を持たないか、object の並びとして持つか。"""
    return key not in item or (isinstance(item[key], list) and all(isinstance(x, dict) for x in item[key]))


def _unit_in_shape(u) -> bool:
    """ロードマップの単位が論点の番号（整数）と論点名を持ち、到達基準を持つなら整数の並びか。"""
    return (isinstance(u, dict) and type(u.get("topic_id")) is int and _text(u.get("term"))
            and ("goals" not in u or (isinstance(u["goals"], list) and all(type(g) is int for g in u["goals"]))))


def _sources_in_shape(doc) -> bool:
    """集めた資料の形: object で、sources・topics・themes・weights と、その項目の sources・examples は持つなら並び。"""
    if not isinstance(doc, dict):
        return False
    for key in ("sources", "topics", "themes", "weights"):
        if key in doc and not isinstance(doc[key], list):
            return False
    for key in ("topics", "themes", "weights"):
        for item in doc.get(key) or []:
            if isinstance(item, dict) and any(k in item and not isinstance(item[k], list) for k in ("sources", "examples")):
                return False
    return True


# @operation UC-020#readBundleAssignment
def read_bundle_assignment(*, path: str) -> dict:
    """束の割り当て（書き手に渡した論点）。無ければ NOT_FOUND、JSON として読めないか、topics の並びが無いか、
    topics の項目が論点の番号（整数）を持つ object でなければ INVALID_INPUT。"""
    doc = _read_json(path)
    ts = doc.get("topics") if isinstance(doc, dict) else None
    if not isinstance(ts, list) or not all(isinstance(t, dict) and type(t.get("topic_id")) is int for t in ts):
        raise Refused(CODE.INVALID_INPUT, f"{path} が割り当ての形（論点の番号を持つ topics の並び）でない")
    return {"topics": doc["topics"]}


# @operation UC-020#readBundleMaterials
def read_bundle_materials(*, path: str) -> dict:
    """書き手が書いた束の教材。無ければ NOT_FOUND、教材の並び（materials。行はそれぞれ論点の番号（整数。真偽値は
    整数として扱わない）を持つ object で、出典 sources を持つなら object の並び）として読めなければ INVALID_INPUT。
    論点名・説明・詳しい解説の欄の欠けと空は門が必須の要素として見る（ここでは見ない）。"""
    doc = _read_json(path)
    ms = doc.get("materials") if isinstance(doc, dict) else None
    if not isinstance(ms, list) or not all(isinstance(m, dict) and type(m.get("topic_id")) is int
                                           and _object_list(m, "sources") for m in ms):
        raise Refused(CODE.INVALID_INPUT, f"{path} が教材の形（materials の並び。論点の番号は整数、出典は object の並び）でない")
    return {"materials": doc["materials"]}


# @operation UC-020#readBundleQuestions
def read_bundle_questions(*, path: str) -> dict:
    """書き手が書いた束の確認問題。無ければ NOT_FOUND、確認問題の並び（questions。行はそれぞれ object）として読めなければ INVALID_INPUT。
    行の形は門が確認問題の形として見る（ここでは見ない）。"""
    doc = _read_json(path)
    if not isinstance(doc, dict) or not isinstance(doc.get("questions"), list) or not all(isinstance(q, dict) for q in doc["questions"]):
        raise Refused(CODE.INVALID_INPUT, f"{path} が確認問題の形（questions の並び）でない")
    return {"questions": doc["questions"]}


# @operation UC-020#readRoadmap
def read_roadmap(*, path: str) -> dict:
    """ロードマップの論点名と到達基準。無ければ NOT_FOUND、JSON として読めないか、units の並びが無いか、units の項目が
    論点の番号と論点名を持たないか、到達基準（goals）が整数の並びでなければ INVALID_INPUT。"""
    doc = _read_json(path)
    us = doc.get("units") if isinstance(doc, dict) else None
    if not isinstance(us, list) or not all(_unit_in_shape(u) for u in us):
        raise Refused(CODE.INVALID_INPUT, f"{path} がロードマップの形（論点の番号・論点名・整数の到達基準を持つ units の並び）でない")
    return {"units": doc["units"]}


# @operation UC-020#readSources
def read_sources(*, path: str) -> dict:
    """集めた資料の 1 ファイルの資料の名前。sources の名前と、入れ子の資料（topics[].sources[]・themes[].examples[]・
    weights[].sources[]）の名前を拾う。JSON として読めないか、object でないか、sources・topics・themes・weights か
    その項目の sources・examples が並びでなければ INVALID_INPUT。"""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refused(CODE.INVALID_INPUT, f"{path} が JSON として読めない")
    if not _sources_in_shape(doc):
        raise Refused(CODE.INVALID_INPUT, f"{path} が集めた資料の形（sources・topics・themes・weights とその項目の sources・examples が並び）でない")
    names: list[str] = []

    def add(s) -> None:
        if isinstance(s, dict) and isinstance(s.get("name"), str) and s["name"] and s["name"] not in names:
            names.append(s["name"])

    for s in doc.get("sources") or []:
        add(s)
    for key in ("topics", "themes", "weights"):
        for item in doc.get(key) or []:
            if isinstance(item, dict):
                for s in item.get("sources") or item.get("examples") or []:
                    add(s)
    return {"names": names}


# @operation UC-020#readMaterialRequirements
def read_material_requirements(*, learning: str) -> dict:
    """登録簿（src/shared/targets.json）のその学びの種類と、ロードマップ型の値（見分けの語・使い方の見出し・避ける語・禁じた書き方）。
    見分けの語と使い方の見出しは、登録簿に無ければ前の門と同じ既定。登録簿に無い学びは NOT_FOUND。"""
    try:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except OSError:
        registry = {}
    entry = registry.get(learning) if isinstance(registry, dict) and not learning.startswith("_") else None
    if not isinstance(entry, dict):
        raise Refused(CODE.NOT_FOUND, f"登録簿に無い学び『{learning}』")
    kind = "roadmap" if entry.get("kind") == "roadmap" or entry.get("roadmap") is True else "exam"
    res: dict = {"kind": kind}
    if kind == "roadmap":
        spec = entry.get("roadmapSpec") or {}
        rs = {"keywordLabel": spec.get("keywordLabel") or DEFAULT_KEYWORD_LABEL,
              "usageSection": spec.get("usageSection") or DEFAULT_USAGE_SECTION}
        for k in ("ngWords", "bannedPatterns"):
            if k in spec:
                rs[k] = spec[k]
        res["roadmapSpec"] = rs
    return res


class Gate:
    """1 つの束を確かめる間の指摘を集める。"""

    def __init__(self) -> None:
        self.stops: list[dict] = []
        self.warnings: list[dict] = []

    def stop(self, kind: str, where: str, reason: str) -> None:
        self.stops.append({"kind": kind, "where": where, "reason": reason})

    def warn(self, kind: str, where: str, reason: str) -> None:
        self.warnings.append({"kind": kind, "where": where, "reason": reason})


def _topic(m: dict) -> str:
    """指摘の箇所に出す論点（番号と論点名）。"""
    tid = m.get("topic_id")
    term = m.get("term") if isinstance(m.get("term"), str) else ""
    return f"論点 {tid if tid is not None else '（番号なし）'} {term}".rstrip()


def _text(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _pos_int(v) -> bool:
    return type(v) is int and v >= 1


def _cells(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)]


SEPARATOR_CELL = re.compile(r"^:?-{3,}:?$")


def _tables(text: str) -> list[tuple[int, list[str]]]:
    """本文の表（| で始まる行の連なり）を (1 行目の行番号, 行の並び) で。コードの囲みの中は見ない。"""
    out: list[tuple[int, list[str]]] = []
    cur: list[str] = []
    start = 0
    fenced = False
    for n, line in enumerate(text.split("\n") + [""], 1):
        if line.startswith("```"):
            fenced = not fenced
        if not fenced and line.lstrip().startswith("|"):
            if not cur:
                start = n
            cur.append(line)
            continue
        if cur:
            out.append((start, cur))
            cur = []
    return out


def check_tables(g: Gate, m: dict, field: str, text: str) -> None:
    """崩れた表（区切りの行が無い・行ごとのセルの数がそろわない）は止め、表示の制約から外れる表は警告する（BR-043）。"""
    for start, rows in _tables(text):
        where = f"{_topic(m)} の {field} の {start} 行目の表"
        cells = [_cells(r) for r in rows]
        if len(cells) < 2 or not all(SEPARATOR_CELL.match(c) for c in cells[1]):
            g.stop("brokenTable", where, "表の 2 行目に区切りの行（| --- |）が無い")
            continue
        width = len(cells[0])
        if any(len(c) != width for c in cells):
            g.stop("brokenTable", where, f"行ごとのセルの数がそろわない（見出しの行は {width} 個）")
            continue
        body = [c for i, c in enumerate(cells) if i != 1]
        cols, rows_n = width, len(body)
        lim_c, lim_r, lim_cell = LIMITS["tableColumns"], LIMITS["tableRows"], LIMITS["tableCellLength"]
        if cols < lim_c["min"]:
            g.warn("tableTooNarrow", where, f"列が {cols} で、下限 {lim_c['min']} に満たない")
        if cols > lim_c["max"]:
            g.warn("tableTooWide", where, f"列が {cols} で、上限 {lim_c['max']} を超える")
        if rows_n < lim_r["min"]:
            g.warn("tableTooShort", where, f"行が見出しを含め {rows_n} で、下限 {lim_r['min']} に満たない")
        if rows_n > lim_r["max"]:
            g.warn("tableTooLong", where, f"行が見出しを含め {rows_n} で、上限 {lim_r['max']} を超える")
        long_cells = [c for row in body for c in row if len(c) > lim_cell]
        if long_cells:
            g.warn("tableCellLong", where, f"セルの字数が上限 {lim_cell} を超える: {long_cells[0][:20]}…（{len(long_cells[0])} 字）")


def verbatim(choice: str, text: str) -> bool:
    """正解の選択肢が本文と一致の閾値以上の字数で連続して一致するか（記号・空白は除いて比べる。閾値より短い選択肢は対象外）。"""
    n = LIMITS["verbatimLength"]
    norm = lambda t: re.sub(r"[\s、。・「」『』（）()\[\]*#\-|]", "", t)  # noqa: E731
    c, t = norm(choice), norm(text)
    if len(c) < n:
        return False
    return any(c[i:i + n] in t for i in range(0, len(c) - n + 1))


def check_material(g: Gate, m: dict, req: dict, terms: set[str], source_names: set[str], ng: re.Pattern | None,
                   banned: dict[str, str]) -> None:
    """教材 1 つの必須の要素・記法・出典・用語・禁じた書き方と、書き方の警告。情報の量は見ない。"""
    tag = _topic(m)
    for key in ("term", "explanation", "detail"):
        if key not in m:
            g.stop("missingElement", tag, f"{key} の欄が無い")
        elif not _text(m[key]):
            g.stop("missingElement", tag, f"{key} の欄が空")
    ex = m.get("explanation") if isinstance(m.get("explanation"), str) else ""
    de = m.get("detail") if isinstance(m.get("detail"), str) else ""
    label, usage = req["keywordLabel"], req["usageSection"]
    if ex and label not in ex:
        g.stop("missingElement", tag, f"説明に「{label}」の行が無い")
    if de and "### しくみ" not in de:
        g.stop("missingElement", tag, "詳しい解説に「### しくみ」の見出しが無い")
    if de and f"### {usage}" not in de:
        g.warn("usageSectionMissing", tag, f"詳しい解説に「### {usage}」の見出しが無い")
    for line in de.split("\n"):
        mo = re.match(r"^(#+)\s", line)
        if mo and mo.group(1) != LIMITS["headingLevel"]:
            g.stop("headingLevel", f"{tag} の detail", f"見出しは {LIMITS['headingLevel']} だけ: {line[:40]}")
    for field, text in (("explanation", ex), ("detail", de)):
        check_tables(g, m, field, text)
    for s in m.get("sources") or []:
        name = s.get("name") if isinstance(s, dict) else None
        if not _text(name) or name.strip() == NOT_A_SOURCE:
            g.stop("unknownSource", tag, f"出典の形に当たらない名前: {name}（出典が無い記述は sources に書かない）")
        elif name not in source_names and not TALLY.search(name):
            g.stop("unknownSource", tag, f"出典の名前が集めた資料（sources/*.json）にも集計の名前にも無い: {name}")
    body = ex + "\n" + de
    for t in re.findall(r"\[\[([^\]]+)\]\]", body):
        if t not in terms:
            g.stop("unresolvedTerm", tag, f"[[{t}]] はロードマップに無い論点名（`[[` を外す）")
    for pattern, why in banned.items():
        for mo in re.finditer(pattern, body):
            g.stop("bannedPattern", tag, f"禁じた書き方「{mo.group(0)}」: {why}")
    if ng is not None:
        for mo in ng.finditer(body):
            g.warn("avoidWord", tag, f"避ける語「{mo.group(0)}」")


def check_question(g: Gate, i: int, q: dict, goals: set[int], bodies: str, banned: dict[str, str]) -> None:
    """確認問題 1 問の形・到達基準・正解の側の禁じた書き方と、正解の選択肢と本文の一致の警告。"""
    tag = f"問題 {q['qid']}" if _text(q.get("qid")) else f"問題（{i + 1} 問目）"
    bad: list[str] = []
    if not _text(q.get("qid")):
        bad.append("qid")
    if not _pos_int(q.get("topic_id")):
        bad.append("topic_id")
    for key in ("term", "stem", "reason"):
        if not _text(q.get(key)):
            bad.append(key)
    choices = q.get("choices")
    if not (isinstance(choices, dict) and set(choices) == set(CHOICES) and all(_text(choices[k]) for k in CHOICES)):
        bad.append("choices（ア〜エの 4 つ）")
    answer = q.get("answer")
    if answer not in CHOICES:
        bad.append("answer（ア〜エのどれか）")
    notes = q.get("choice_notes")
    if not (isinstance(notes, dict) and all(_text(notes.get(k)) for k in CHOICES)):
        bad.append("choice_notes（ア〜エの説明）")
    elif answer in CHOICES:
        if not notes[answer].startswith("正解"):
            bad.append("choice_notes（正解の説明は「正解」で始める）")
        # 誤答で止めるのは「正解。」の印で始まるときだけ（「正解の〜」のように文として始まる説明は止めない）
        if any(notes[k].startswith("正解。") for k in CHOICES if k != answer):
            bad.append("choice_notes（誤答の説明は「正解。」の印で始めない）")
    if not _pos_int(q.get("tests_goal")):
        bad.append("tests_goal")
    if bad:
        g.stop("questionShape", tag, f"確認問題の形を満たさない欄: {'、'.join(bad)}")
    elif q["tests_goal"] not in goals:
        g.stop("unknownGoal", tag, f"測る到達基準 {q['tests_goal']} がその学びの到達基準 {sorted(goals)} に無い")
    if isinstance(choices, dict) and answer in CHOICES and isinstance(choices.get(answer), str):
        correct = choices[answer]
        correct_side = [("正解の選択肢", correct), ("正解の選択肢の説明", notes.get(answer) if isinstance(notes, dict) else None),
                        ("正解の根拠", q.get("reason"))]
        for place, text in correct_side:
            if not isinstance(text, str):
                continue
            for pattern, why in banned.items():
                for mo in re.finditer(pattern, text):
                    g.stop("bannedPattern", tag, f"{place}に禁じた書き方「{mo.group(0)}」: {why}")
        if verbatim(correct, bodies):
            g.warn("verbatimBody", tag, f"正解の選択肢が教材と {LIMITS['verbatimLength']} 字以上連続して一致する（言い換えるか場面適用にする）")


def refuse(code: str, reason: str) -> int:
    print(reason, file=sys.stderr)
    print(tool_error_line(code, reason))
    return 2


# @operation UC-020#checkRoadmapBundle
def main() -> int:
    ap = RefusingArgumentParser(allow_abbrev=False, description="ロードマップ型の束 1 つを教材の門にかける")
    ap.add_argument("--data", required=True)
    ap.add_argument("--bundle", required=True)
    a = ap.parse_args()
    d = a.data.rstrip("/")
    key = Path(d).name
    try:
        req = read_material_requirements(learning=key)
    except Refused:
        return refuse(CODE.INVALID_INPUT, f"登録簿に無い学び『{key}』")
    if req["kind"] != "roadmap":
        return refuse(CODE.INVALID_INPUT, f"ロードマップ型でない学び『{key}』")
    try:
        assignment = read_bundle_assignment(path=f"{d}/material_bundles/{a.bundle}.json")
    except Refused as e:
        if e.code == CODE.NOT_FOUND:
            return refuse(CODE.NOT_FOUND, f"束 {a.bundle} の割り当てが無い（{d}/material_bundles/{a.bundle}.json）")
        assignment = None

    g = Gate()
    spec = req["roadmapSpec"]
    if assignment is None:
        g.stop("unreadableOutput", f"{d}/material_bundles/{a.bundle}.json", "束の割り当てが割り当ての形として読めない")
    try:
        units = read_roadmap(path=f"{d}/roadmap.json")["units"]
    except Refused as e:
        units = []
        g.stop("unreadableOutput", f"{d}/roadmap.json", f"ロードマップが読めない（{e.reason}）")
    units = [u for u in units if isinstance(u, dict)]
    terms = {u.get("term") for u in units if isinstance(u.get("term"), str)}
    term_of = {u.get("topic_id"): u.get("term") for u in units}
    goals = {gl for u in units for gl in (u.get("goals") or []) if type(gl) is int}
    source_names: set[str] = set()
    for sf in sorted(Path(d, "sources").glob("*.json")):
        try:
            source_names.update(read_sources(path=sf.as_posix())["names"])
        except Refused as e:
            print(f"注: 集めた資料のファイルを読めないので名前を拾わない: {e.reason}")
    ng_words = spec.get("ngWords", NG_DEFAULT)
    ng = re.compile("|".join(ng_words)) if ng_words else None
    banned = spec.get("bannedPatterns") or {}

    mpath = f"{d}/materials/{a.bundle}.json"
    try:
        materials = read_bundle_materials(path=mpath)["materials"]
    except Refused as e:
        materials = []
        why = "束の教材のファイルが無い" if e.code == CODE.NOT_FOUND else "束の教材のファイルが教材の形として読めない（書いている途中か壊れているか、項目が形の外）"
        g.stop("unreadableOutput", f"{a.bundle}（{mpath}）", why)
    else:
        assigned = {t.get("topic_id"): t.get("term") for t in (assignment or {}).get("topics", []) if isinstance(t, dict)}
        written = [m.get("topic_id") for m in materials]
        if assignment is not None:
            for tid, term in assigned.items():
                if tid not in written:
                    g.stop("bundleMismatch", f"{a.bundle} の論点 {tid} {term or ''}".rstrip(), "割り当ての論点の教材が無い")
            for m in materials:
                if m.get("topic_id") not in assigned:
                    g.stop("bundleMismatch", f"{a.bundle} の{_topic(m)}", "割り当てに無い論点の教材がある")
        for m in materials:
            if _text(m.get("term")) and m.get("topic_id") in term_of and term_of[m.get("topic_id")] != m["term"]:
                g.stop("termMismatch", _topic(m), f"論点名がロードマップの論点名「{term_of[m.get('topic_id')]}」と違う")
            check_material(g, m, spec, terms, source_names, ng, banned)

    qpath = f"{d}/roadmap_questions/{a.bundle}.json"
    questions: list[dict] = []
    if Path(qpath).exists():
        try:
            questions = read_bundle_questions(path=qpath)["questions"]
        except Refused:
            g.stop("unreadableOutput", f"{a.bundle}（{qpath}）", "束の確認問題のファイルが確認問題の形として読めない（書いている途中か壊れている）")
    bodies = "\n".join(f"{m.get('explanation', '')}\n{m.get('detail', '')}" for m in materials)
    for i, q in enumerate(questions):
        check_question(g, i, q, goals, bodies, banned)

    for w in g.warnings:
        print(f"警告: {w['where']}: {w['reason']}")
    for s in g.stops:
        print(f"✘ {s['where']}: {s['reason']}")
    print(f"{a.bundle}: 論点 {len(materials)} / 警告 {len(g.warnings)} / 問題点 {len(g.stops)}")
    code = 1 if g.stops else 0
    print(json.dumps({"exitCode": code, "topics": len(materials), "questions": len(questions),
                      "stops": g.stops, "warnings": g.warnings, "limits": LIMITS}, ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main())
