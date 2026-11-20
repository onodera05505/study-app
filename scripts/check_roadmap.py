#!/usr/bin/env python3
"""ロードマップ型の学び全体を教材の門にかける（契約 UC-021 の checkRoadmap。要件定義書 §13「検証の門」）。

    python3 scripts/check_roadmap.py --data data/itc [--solutions data/itc/eval/solve_*.json ...]

- 門が読むファイル（ロードマップ・教材・確認問題・集めた資料・登録簿・独立解答）のパスは、作業ディレクトリが起点
  （登録簿は作業ディレクトリの src/shared/targets.json）
- 結果: 人が読む行（独立解答の一致・警告・止める理由・数の要約）のあとに、標準出力の最後の行として機械向けの 1 行
  {"exitCode","topics","questions","stops","warnings","limits"} を出す。止める理由が 1 件以上なら終了の状態 1、無ければ 0
- 断るとき（引数の誤り・登録簿に無い学び・ロードマップ型でない学び・ロードマップが無いか読めない・添えた独立解答が無いか読めない）は、
  何も確かめずに標準出力に共有の形の断り（ToolError）を 1 行出して終了の状態 2 で終える
- 情報の量（字数・文数・見出しの数・箇条書きや比較の項目の数）は止める理由にも警告にもしない（BR-042）。表示の制約は表だけ（BR-043）
- ロードマップの外の補足の論点の教材と確認問題は、止める理由にも警告にもしない
"""
from __future__ import annotations

import ast
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
    "independentMismatchRate": 0.2,
    "questionsPerUnit": 2,
    "headingLevel": "###",
    "tableColumns": {"min": 2, "max": 4},
    "tableRows": {"min": 2, "max": 8},
    "tableCellLength": 40,
    "answerPositionShare": 0.45,
    "pairSameShare": 0.1,
    "answerLongestShare": 0.6,
    "answerTopTwoShare": 0.75,
    "answerCommasRatio": 2,
    "answerCommasFloor": 0.2,
    "absoluteWords": ["必ず", "すべて", "全部", "いっさい", "絶対", "だけ見れば", "見なくてよい", "しなくてよい", "放っておく", "そのまま信じ"],
    "absoluteMinChoices": 15,
    "absoluteWrongShare": 0.85,
    "bothLongestMinUnits": 3,
    "biasMinQuestions": 20,
    "styleMinUnits": 10,
    "styleMinorityShare": 0.25,
    "goalsWhenNone": 6,
}
# 登録簿が値を持たない学びの既定（前の門と同じ）
DEFAULT_KEYWORD_LABEL = "キーワード"
DEFAULT_USAGE_SECTION = "面接で話すなら"
NG_DEFAULT = ["激務", "ブラック(?!ボックス)", "年収", "万円", "最新", "近年"]
TALLY = re.compile(r"[^（]+の集計(?:（[a-z_]+）)?$")
NOT_A_SOURCE = "一般常識"
# 出典の where で読者に見せない書き方: 番号つきの項目名（第 7 週・第 3 章・14.01・GE-DIG3・丸数字・ローマ数字）と英語の文。
# 技術の略語・技術語（CPU・SQL・Web・Git・Cookie・TLS 1.3・SHA-256 など）は読者が本文でも出会う語なので認める
WHERE_CODE = re.compile(
    r"[①-⑳Ⅰ-Ⅹ]"
    r"|第\s*[0-9０-９]+\s*[章節条週]"
    r"|(?<![0-9A-Za-z/.v])(?<![A-Za-z] )[0-9]+[.．][0-9]+(?![0-9])"  # 技術語の後の版番号（TLS 1.3・HTTP/1.1）は除く
    r"|(?<![A-Za-z0-9])(?=[A-Za-z0-9-]*[0-9])[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*(?![A-Za-z0-9])"  # 記号つきの項目番号
    r"|[A-Za-z][a-z]+(?:[ ,]+[A-Za-z][a-z]+){2,}")  # 英語の文（3 語以上）
KEIGO = re.compile(r"(?:です|ます|ません|ましょう|でした)(?:。|$)")
JOTAI = re.compile(r"(?:だ|である|ない|した|いる)(?:。|$)")
LINE_OF_SPEECH = re.compile(r"^(?:相手|自分|こちら)[:：]")


def _read_json(path: str):
    """JSON のファイルを読む。無ければ NOT_FOUND、JSON として読めなければ INVALID_INPUT の失敗を渡す。"""
    p = Path(path)
    if not p.is_file():
        raise Refused(CODE.NOT_FOUND, f"{path} が無い")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refused(CODE.INVALID_INPUT, f"{path} が JSON として読めない")


# @operation UC-021#readRoadmap
def read_roadmap(*, path: str) -> dict:
    """ロードマップ。無ければ NOT_FOUND、JSON として読めないか units の並びが無ければ INVALID_INPUT。"""
    doc = _read_json(path)
    if not isinstance(doc, dict) or not isinstance(doc.get("units"), list):
        raise Refused(CODE.INVALID_INPUT, f"{path} がロードマップの形（units の並び）でない")
    return doc


# @operation UC-021#readMaterialFile
def read_material_file(*, path: str) -> dict:
    """教材の置き場の 1 つのファイルの教材。無ければ NOT_FOUND、教材の並び（materials。行は論点の ID を持つ object）として
    読めなければ INVALID_INPUT。行の欄の欠けと空は門が必須の要素として見る。"""
    doc = _read_json(path)
    ms = doc.get("materials") if isinstance(doc, dict) else None
    if not isinstance(ms, list) or not all(isinstance(m, dict) and type(m.get("topic_id")) is int for m in ms):
        raise Refused(CODE.INVALID_INPUT, f"{path} が教材の形（論点の ID を持つ materials の並び）でない")
    return {"materials": ms}


# @operation UC-021#readRoadmapQuestions
def read_roadmap_questions(*, path: str) -> dict:
    """確認問題の置き場の 1 つのファイルの確認問題。無ければ NOT_FOUND、確認問題の並び（questions。行は object）として読めなければ
    INVALID_INPUT。行の形は門が確認問題の形として見る。"""
    doc = _read_json(path)
    qs = doc.get("questions") if isinstance(doc, dict) else None
    if not isinstance(qs, list) or not all(isinstance(q, dict) for q in qs):
        raise Refused(CODE.INVALID_INPUT, f"{path} が確認問題の形（questions の並び）でない")
    return {"questions": qs}


# @operation UC-021#readSources
def read_sources(*, path: str) -> dict:
    """集めた資料の 1 ファイルの資料の名前。sources の名前と、入れ子の資料（topics・themes・weights の項目の sources、
    無ければ examples）の名前を拾う。読めなければ INVALID_INPUT。"""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refused(CODE.INVALID_INPUT, f"{path} が JSON として読めない")
    names: list[str] = []

    def add(s) -> None:
        if isinstance(s, dict) and isinstance(s.get("name"), str) and s["name"] and s["name"] not in names:
            names.append(s["name"])

    if isinstance(doc, dict):
        for s in doc.get("sources") or []:
            add(s)
        for key in ("topics", "themes", "weights"):
            for item in doc.get(key) or []:
                if isinstance(item, dict):
                    for s in item.get("sources") or item.get("examples") or []:
                        add(s)
    return {"names": names}


# @operation UC-021#readMaterialRequirements
def read_material_requirements(*, learning: str) -> dict:
    """登録簿（src/shared/targets.json）のその学びの種類と、ロードマップ型の値（見分けの語・使い方の見出し・避ける語・禁じた書き方・印の段）。
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
        for k in ("ngWords", "bannedPatterns", "tiers"):
            if k in spec:
                rs[k] = spec[k]
        res["roadmapSpec"] = rs
    return res


# @operation UC-021#readIndependentAnswers
def read_independent_answers(*, path: str) -> dict:
    """独立解答。無ければ NOT_FOUND、answers（問題の識別子 → ア〜エ）として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    ans = doc.get("answers") if isinstance(doc, dict) else None
    if not isinstance(ans, dict) or not all(v in CHOICES for v in ans.values()):
        raise Refused(CODE.INVALID_INPUT, f"{path} が独立解答の形（answers の 問題の識別子 → ア〜エ）でない")
    return {"answers": ans}


class Gate:
    """学び全体を確かめる間の指摘を集める。"""

    def __init__(self) -> None:
        self.stops: list[dict] = []
        self.warnings: list[dict] = []

    def stop(self, kind: str, where: str, reason: str) -> None:
        self.stops.append({"kind": kind, "where": where, "reason": reason})

    def warn(self, kind: str, where: str, reason: str) -> None:
        self.warnings.append({"kind": kind, "where": where, "reason": reason})


def _text(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _pos_int(v) -> bool:
    return type(v) is int and v >= 1


def _unit(u: dict) -> str:
    return f"単位 {u.get('topic_id')} {u.get('term', '')}".rstrip()


def _material(m: dict) -> str:
    term = m.get("term") if isinstance(m.get("term"), str) else ""
    return f"教材 {m.get('topic_id')} {term}".rstrip()


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


def check_tables(g: Gate, tag: str, field: str, text: str) -> None:
    """崩れた表は止め、表示の制約から外れる表は警告する（BR-043）。"""
    for start, rows in _tables(text):
        where = f"{tag} の {field} の {start} 行目の表"
        cells = [_cells(r) for r in rows]
        if len(cells) < 2 or not all(SEPARATOR_CELL.match(c) for c in cells[1]):
            g.stop("brokenTable", where, "表の 2 行目に区切りの行（| --- |）が無い")
            continue
        width = len(cells[0])
        if any(len(c) != width for c in cells):
            g.stop("brokenTable", where, f"行ごとのセルの数がそろわない（見出しの行は {width} 個）")
            continue
        body = [c for i, c in enumerate(cells) if i != 1]
        rows_n = len(body)
        lim_c, lim_r, lim_cell = LIMITS["tableColumns"], LIMITS["tableRows"], LIMITS["tableCellLength"]
        if width < lim_c["min"]:
            g.warn("tableTooNarrow", where, f"列が {width} で、下限 {lim_c['min']} に満たない")
        if width > lim_c["max"]:
            g.warn("tableTooWide", where, f"列が {width} で、上限 {lim_c['max']} を超える")
        if rows_n < lim_r["min"]:
            g.warn("tableTooShort", where, f"行が見出しを含め {rows_n} で、下限 {lim_r['min']} に満たない")
        if rows_n > lim_r["max"]:
            g.warn("tableTooLong", where, f"行が見出しを含め {rows_n} で、上限 {lim_r['max']} を超える")
        long_cells = [c for row in body for c in row if len(c) > lim_cell]
        if long_cells:
            g.warn("tableCellLong", where, f"セルの字数が上限 {lim_cell} を超える（{len(long_cells[0])} 字）")


def verbatim(choice: str, text: str) -> bool:
    """正解の選択肢が本文と一致の閾値以上の字数で連続して一致するか（記号・空白は除いて比べる。閾値より短い選択肢は対象外）。"""
    n = LIMITS["verbatimLength"]
    norm = lambda t: re.sub(r"[\s、。・「」『』（）()\[\]*#\-|]", "", t)  # noqa: E731
    c, t = norm(choice), norm(text)
    if len(c) < n:
        return False
    return any(c[i:i + n] in t for i in range(0, len(c) - n + 1))


def _banned_hits(banned: list[tuple[re.Pattern, str]], text: str):
    for rx, why in banned:
        for mo in rx.finditer(text):
            yield mo.group(0), why


def check_roadmap_units(g: Gate, units: list[dict], spec: dict, chapter: bool, ng: re.Pattern | None,
                        banned: list[tuple[re.Pattern, str]]) -> None:
    """ロードマップの単位: 前提の位置・要約・章・印と、要約の禁じた書き方・避ける語・前提の名前・最も低い段の並び。"""
    order_of = {u.get("term"): u.get("order") for u in units}
    levels = [t.get("level") for t in (spec.get("tiers") or []) if isinstance(t, dict)]
    for u in units:
        tag = _unit(u)
        for pt in u.get("prereq") or []:
            if pt in order_of:
                if isinstance(order_of[pt], int) and isinstance(u.get("order"), int) and order_of[pt] > u["order"]:
                    g.stop("prereqAfter", tag, f"前提『{pt}』が学ぶ順で後ろ（{order_of[pt]} 番目）にある")
            else:
                g.warn("prereqUnknown", tag, f"前提『{pt}』という単位がロードマップに無い（名寄せの後の古い名前か）")
        sm = u.get("summary")
        if not _text(sm):
            g.stop("summaryMissing", tag, "要約が無いか空")
        else:
            for hit, why in _banned_hits(banned, sm):
                g.stop("bannedPattern", f"{tag} の要約", f"禁じた書き方「{hit}」: {why}")
            if ng is not None:
                for mo in ng.finditer(sm):
                    g.warn("avoidWord", f"{tag} の要約", f"避ける語「{mo.group(0)}」")
        if chapter and (not _pos_int(u.get("round")) or not _text(u.get("chapter"))):
            g.stop("chapterMissing", tag, "章で束ねる学びなのに章の番号か章の名前が無い")
        if levels and u.get("tier") not in levels:
            g.stop("tierMissing", tag, f"印 {u.get('tier')} が登録簿の印の段 {levels} に無い")
    if levels and chapter:
        low = min(levels)
        for n in sorted({u.get("round") for u in units if _pos_int(u.get("round"))}):
            members = [u for u in units if u.get("round") == n]
            ts = [u.get("tier") for u in members]
            if low in ts and any(t != low for t in ts[ts.index(low):]):
                name = members[0].get("chapter") or ""
                g.warn("lowestTierNotLast", f"第 {n} 章 {name}".rstrip(),
                       f"最も低い段（{low}）の単位が章の末尾にそろっていない: {' / '.join(_unit(u) for u in members if u.get('tier') == low)}")


def check_material(g: Gate, m: dict, spec: dict, terms: set, source_names: set, ng: re.Pattern | None,
                   banned: list[tuple[re.Pattern, str]]) -> None:
    """教材 1 つ（ロードマップの単位の分）: 必須の要素・表・見出しの階層・出典・用語・禁じた書き方と、書き方の警告。"""
    tag = _material(m)
    for key in ("term", "explanation", "detail"):
        if key not in m:
            g.stop("missingElement", tag, f"{key} の欄が無い")
        elif not _text(m[key]):
            g.stop("missingElement", tag, f"{key} の欄が空")
    ex = m.get("explanation") if isinstance(m.get("explanation"), str) else ""
    de = m.get("detail") if isinstance(m.get("detail"), str) else ""
    label, usage = spec["keywordLabel"], spec["usageSection"]
    if _text(ex) and label not in ex:
        g.stop("missingElement", tag, f"説明に「{label}」の行が無い")
    if _text(de) and "### しくみ" not in de:
        g.stop("missingElement", tag, "詳しい解説に「### しくみ」の見出しが無い")
    if _text(de) and f"### {usage}" not in de:
        g.warn("usageSectionMissing", tag, f"詳しい解説に「### {usage}」の見出しが無い")
    for line in de.split("\n"):
        mo = re.match(r"^(#+)\s", line)
        if mo and mo.group(1) != LIMITS["headingLevel"]:
            g.stop("headingLevel", f"{tag} の detail", f"見出しは {LIMITS['headingLevel']} だけ: {line[:40]}")
    for field, text in (("explanation", ex), ("detail", de)):
        check_tables(g, tag, field, text)
        if text.count("**") % 2 == 1:
            g.warn("unclosedEmphasis", f"{tag} の {field}", "強調の記号（**）が閉じていない")
    srcs = m.get("sources")
    if isinstance(srcs, str) and srcs.startswith("["):
        try:
            srcs = ast.literal_eval(srcs)
        except (ValueError, SyntaxError):
            srcs = []
    srcs = srcs if isinstance(srcs, list) else []
    for s in srcs:
        name = s.get("name") if isinstance(s, dict) else None
        if not _text(name) or name.strip() == NOT_A_SOURCE:
            g.stop("unknownSource", tag, f"出典の形に当たらない名前: {name}（出典が無い記述は sources に書かない）")
        elif name not in source_names and not TALLY.search(name):
            g.stop("unknownSource", tag, f"出典の名前が集めた資料（sources/*.json）にも集計の名前にも無い: {name}")
    for s in srcs:
        w = (s.get("where") or "") if isinstance(s, dict) else ""
        hit = WHERE_CODE.search(w) if isinstance(w, str) else None
        if hit:
            g.warn("sourceWhereCode", tag, f"出典の where に番号つきの項目名か英語の文「{hit.group(0)}」（{w[:30]}）")
            break
    body = ex + "\n" + de
    for t in re.findall(r"\[\[([^\]]+)\]\]", body):
        if t not in terms:
            g.stop("unresolvedTerm", tag, f"[[{t}]] はロードマップに無い論点名")
    for hit, why in _banned_hits(banned, body):
        g.stop("bannedPattern", tag, f"禁じた書き方「{hit}」: {why}")
    if ng is not None:
        for mo in ng.finditer(body):
            g.warn("avoidWord", tag, f"避ける語「{mo.group(0)}」")


def check_style(g: Gate, mats: dict[int, dict]) -> None:
    """文体のずれ: 教材が一定数以上の学びで、多数と違う文体（敬体・常体）の単位が少数のときだけ、その単位を挙げる。"""
    style: dict[int, tuple[int, int]] = {}
    for tid, m in mats.items():
        text = f"{m.get('explanation', '') or ''}\n{m.get('detail', '') or ''}"
        body = "\n".join(l for l in text.splitlines() if not LINE_OF_SPEECH.match(l.strip().lstrip("-* ")))
        style[tid] = (len(KEIGO.findall(body)), len(JOTAI.findall(body)))
    if len(style) < LIMITS["styleMinUnits"]:
        return
    keigo_units = [t for t, (k, j) in style.items() if k >= j]
    major_keigo = len(keigo_units) * 2 >= len(style)
    odd = [t for t, (k, j) in style.items() if (k < j) is major_keigo and (k != j or not major_keigo)]
    if odd and len(odd) < LIMITS["styleMinorityShare"] * len(style):
        for t in odd:
            g.warn("styleMinority", _material(mats[t]),
                   f"文体が多数（{'敬体（です・ます）' if major_keigo else '常体（だ・である）'}）と違う")


def question_shape(q: dict) -> list[str]:
    """確認問題の形を満たさない欄（空なら形を満たす）。"""
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
    if not (isinstance(notes, dict) and set(notes) == set(CHOICES) and all(_text(notes.get(k)) for k in CHOICES)):
        bad.append("choice_notes（ア〜エの説明）")
    elif answer in CHOICES:
        if not notes[answer].startswith("正解"):
            bad.append("choice_notes（正解の説明は「正解」で始める）")
        # 誤答で止めるのは「正解。」の印で始まるときだけ（「正解の〜」のように文として始まる説明は止めない）
        if any(notes[k].startswith("正解。") for k in CHOICES if k != answer):
            bad.append("choice_notes（誤答の説明は「正解。」の印で始めない）")
    if not _pos_int(q.get("tests_goal")):
        bad.append("tests_goal")
    return bad


def check_question_clues(g: Gate, qs: list[dict], units: dict[int, dict], mats: dict[int, dict]) -> None:
    """読まずに当てられる形の手がかり（偏り・一致・合図）を警告する。qs は形を満たすロードマップの単位の問題。"""
    n = len(qs)
    for q in qs:
        correct = q["choices"][q["answer"]]
        m = mats.get(q["topic_id"])
        if m and verbatim(correct, f"{m.get('explanation', '') or ''}\n{m.get('detail', '') or ''}"):
            g.warn("verbatimBody", f"問題 {q['qid']}", f"正解の選択肢が教材と {LIMITS['verbatimLength']} 字以上連続して一致する（読んだ文の再認で当たる）")
        u = units.get(q["topic_id"])
        if u and isinstance(u.get("summary"), str) and verbatim(correct, u["summary"]):
            g.warn("verbatimSummary", f"問題 {q['qid']}", f"正解の選択肢が要約と {LIMITS['verbatimLength']} 字以上連続して一致する")
    if n >= LIMITS["biasMinQuestions"]:
        pos: dict[str, int] = {}
        for q in qs:
            pos[q["answer"]] = pos.get(q["answer"], 0) + 1
        top = max(pos.values()) / n
        if top > LIMITS["answerPositionShare"]:
            g.warn("answerPositionBias", "確認問題の全体", f"正解の位置が偏っている: {pos}")
        by_topic: dict[int, list[str]] = {}
        for q in qs:
            by_topic.setdefault(q["topic_id"], []).append(q["answer"])
        pairs = [v for v in by_topic.values() if len(v) == 2]
        if pairs:
            same = sum(1 for v in pairs if v[0] == v[1])
            if same / len(pairs) < LIMITS["pairSameShare"]:
                g.warn("pairAnswerNeverSame", "確認問題の全体",
                       f"同じ単位の 2 問で正解の記号が重なるのが {same}/{len(pairs)} 件。1 問目から 2 問目を絞れる")
        longer = top2 = 0
        for q in qs:
            ok = len(q["choices"][q["answer"]])
            other = sorted((len(v) for k, v in q["choices"].items() if k != q["answer"]), reverse=True)
            if other and ok > other[0]:
                longer += 1
            if len(other) >= 2 and ok > other[1]:
                top2 += 1
        if longer / n > LIMITS["answerLongestShare"]:
            g.warn("answerLongest", "確認問題の全体", f"正解がいちばん長い選択肢の問題が {longer}/{n} 問。長さで当てられる")
        if top2 / n > LIMITS["answerTopTwoShare"]:
            g.warn("answerTopTwoLength", "確認問題の全体", f"正解が長い方の 2 つに入る問題が {top2}/{n} 問。短い枝を捨てるだけで 2 択になる")
        ok_c = [q["choices"][q["answer"]].count("、") for q in qs]
        ng_c = [v.count("、") for q in qs for k, v in q["choices"].items() if k != q["answer"]]
        if ng_c and sum(ok_c) / len(ok_c) > LIMITS["answerCommasRatio"] * max(LIMITS["answerCommasFloor"], sum(ng_c) / len(ng_c)):
            g.warn("answerCommas", "確認問題の全体",
                   f"正解の読点が誤答より多い（正解 平均 {sum(ok_c) / len(ok_c):.1f} 対 誤答 {sum(ng_c) / len(ng_c):.1f}）")
    hit = [(q["qid"], k == q["answer"]) for q in qs for k, v in q["choices"].items() if any(w in v for w in LIMITS["absoluteWords"])]
    if len(hit) >= LIMITS["absoluteMinChoices"]:
        wrong = sum(1 for _, is_ok in hit if not is_ok)
        if wrong / len(hit) > LIMITS["absoluteWrongShare"]:
            g.warn("absoluteWordsWrong", "確認問題の全体", f"言い切る語を含む選択肢 {len(hit)} 件のうち {wrong} 件が誤答。語だけで消去できる")
    quote1 = [q["qid"] for q in qs if sum(1 for v in q["choices"].values() if "「" in v) == 1 and "「" in q["choices"][q["answer"]]]
    if quote1:
        g.warn("quoteOnlyInAnswer", "問題 " + "・".join(quote1), "かぎ括弧を含む選択肢が正解の 1 つだけ（4 本そろえる）")
    kyozai = [q["qid"] for q in qs if "教材" in q["stem"]]
    if kyozai:
        g.warn("stemSaysMaterial", "問題 " + "・".join(kyozai), "問題文に「教材」が出る（再認の合図）")
    both_longest: dict[int, int] = {}
    for q in qs:
        ok = len(q["choices"][q["answer"]])
        if all(ok > len(v) for k, v in q["choices"].items() if k != q["answer"]):
            both_longest[q["topic_id"]] = both_longest.get(q["topic_id"], 0) + 1
    bl = [t for t, c in both_longest.items() if c >= 2]
    if len(bl) >= LIMITS["bothLongestMinUnits"]:
        g.warn("bothLongestInUnit", "単位 " + "・".join(f"{t} {units[t].get('term', '')}" for t in bl if t in units),
               "同じ単位の 2 問とも正解が最も長い")


def refuse(code: str, reason: str) -> int:
    print(reason, file=sys.stderr)
    print(tool_error_line(code, reason))
    return 2


# @operation UC-021#checkRoadmap
def main() -> int:
    ap = RefusingArgumentParser(allow_abbrev=False, description="ロードマップ型の学び全体を教材の門にかける")
    ap.add_argument("--data", required=True)
    ap.add_argument("--solutions", nargs="*", default=[])
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
        rm = read_roadmap(path=f"{d}/roadmap.json")
    except Refused as e:
        if e.code == CODE.NOT_FOUND:
            return refuse(CODE.NOT_FOUND, f"ロードマップが無い（{d}/roadmap.json）")
        return refuse(CODE.INVALID_INPUT, f"ロードマップが読めない（{e.reason}）")
    missing = [s for s in a.solutions if not Path(s).is_file()]
    if missing:
        return refuse(CODE.NOT_FOUND, f"添えた独立解答のファイルが無い: {', '.join(missing)}")
    solutions: list[tuple[str, dict]] = []
    for s in a.solutions:
        try:
            solutions.append((s, read_independent_answers(path=s)["answers"]))
        except Refused as e:
            return refuse(CODE.INVALID_INPUT, f"添えた独立解答が読めない（{e.reason}）")

    g = Gate()
    spec = req["roadmapSpec"]
    chapter = rm.get("group_by") == "chapter"
    all_units = [u for u in rm["units"] if isinstance(u, dict)]
    units = {u["topic_id"]: u for u in all_units if type(u.get("topic_id")) is int}
    terms = {u.get("term") for u in all_units if isinstance(u.get("term"), str)}
    goals_max = max((gl for u in all_units for gl in (u.get("goals") or []) if type(gl) is int), default=LIMITS["goalsWhenNone"])
    ng_words = spec.get("ngWords", NG_DEFAULT)
    ng = re.compile("|".join(ng_words)) if ng_words else None
    banned = [(re.compile(rx), why) for rx, why in (spec.get("bannedPatterns") or {}).items()]
    check_roadmap_units(g, all_units, spec, chapter, ng, banned)

    source_names: set[str] = set()
    for sf in sorted(Path(d, "sources").glob("*.json")):
        try:
            source_names.update(read_sources(path=sf.as_posix())["names"])
        except Refused as e:
            print(f"注: 集めた資料のファイルを読めないので名前を拾わない: {e.reason}")

    # 教材（ロードマップの外の補足の論点の教材は見ない）
    mats: dict[int, dict] = {}
    for mp in sorted(Path(d, "materials").glob("*.json")):
        try:
            ms = read_material_file(path=mp.as_posix())["materials"]
        except Refused:
            g.stop("unreadableOutput", f"教材のファイル {mp.stem}（{mp.as_posix()}）", "教材の形として読めない（書いている途中か壊れている）")
            continue
        for m in ms:
            tid = m["topic_id"]
            if tid not in units:
                continue
            if tid in mats:
                g.stop("duplicate", f"{_material(m)}（{mp.stem}）", "同じ論点の教材がほかのファイルにもある")
                continue
            mats[tid] = m
            if _text(m.get("term")) and units[tid].get("term") != m["term"]:
                g.stop("termMismatch", _material(m), f"論点名がロードマップの論点名「{units[tid].get('term')}」と違う")
            check_material(g, m, spec, terms, source_names, ng, banned)
    for tid, u in units.items():
        if tid not in mats:
            g.stop("missingMaterial", _unit(u), "教材が無い単位")
    check_style(g, mats)

    # 確認問題（ロードマップの外の補足の論点の問題は見ない）
    qfiles = sorted(Path(d, "roadmap_questions").glob("bundle_*.json"))
    qs_all: list[dict] = []
    for qp in qfiles:
        try:
            qs_all += read_roadmap_questions(path=qp.as_posix())["questions"]
        except Refused:
            g.stop("unreadableOutput", f"確認問題のファイル {qp.stem}（{qp.as_posix()}）", "確認問題の形として読めない（書いている途中か壊れている）")
    seen: set[str] = set()
    per_topic: dict[int, int] = {}
    shaped: list[dict] = []
    roadmap_qs: list[dict] = []
    for i, q in enumerate(qs_all):
        if type(q.get("topic_id")) is int and q["topic_id"] not in units:
            continue
        roadmap_qs.append(q)
        tag = f"問題 {q['qid']}" if _text(q.get("qid")) else f"問題（{i + 1} 問目）"
        if _text(q.get("qid")):
            if q["qid"] in seen:
                g.stop("duplicateQid", tag, "問題の識別子が重なる")
            seen.add(q["qid"])
        if type(q.get("topic_id")) is int:
            per_topic[q["topic_id"]] = per_topic.get(q["topic_id"], 0) + 1
        bad = question_shape(q)
        if bad:
            g.stop("questionShape", tag, f"確認問題の形を満たさない欄: {'、'.join(bad)}")
            continue
        if not 1 <= q["tests_goal"] <= goals_max:
            g.stop("unknownGoal", tag, f"測る到達基準 {q['tests_goal']} がその学びの到達基準（1〜{goals_max}）に無い")
        correct_side = f"{q['choices'][q['answer']]}\n{q['choice_notes'][q['answer']]}\n{q['reason']}"
        for hit, why in _banned_hits(banned, correct_side):
            g.stop("bannedPattern", tag, f"正解の側に禁じた書き方「{hit}」: {why}")
        shaped.append(q)
    if qfiles:
        for tid, u in units.items():
            if per_topic.get(tid, 0) != LIMITS["questionsPerUnit"]:
                g.stop("questionCount", _unit(u), f"確認問題が {per_topic.get(tid, 0)} 問（{LIMITS['questionsPerUnit']} 問のはず）")
    check_question_clues(g, shaped, units, mats)

    # 独立解答（1 本ずつ、ロードマップの単位の問題だけを数える）
    counted = [q for q in roadmap_qs if _text(q.get("qid"))]
    for path, ans in solutions:
        bad = []
        for q in counted:
            if q["qid"] not in ans:
                bad.append((q["qid"], "未回答"))
            elif ans[q["qid"]] != q.get("answer"):
                bad.append((q["qid"], f"{ans[q['qid']]}≠{q.get('answer')}"))
        n_in = len(counted)
        rate = len(bad) / max(1, n_in)
        print(f"独立解答 {Path(path).name}: {n_in - len(bad)}/{n_in} 一致（不一致 {rate:.0%}）")
        for qid, why in bad:
            print(f"   不一致 {qid}: {why}")
        if rate > LIMITS["independentMismatchRate"]:
            g.stop("independentMismatch", f"独立解答 {Path(path).stem}（{path}）",
                   f"食い違いが {len(bad)}/{n_in} 問（{rate:.0%}）で閾値 {LIMITS['independentMismatchRate']:.0%} を超える: "
                   + "・".join(f"{qid}（{why}）" for qid, why in bad))

    for w in g.warnings:
        print(f"警告: {w['where']}: {w['reason']}")
    for s in g.stops:
        print(f"✘ {s['where']}: {s['reason']}")
    print(f"単位 {len(units)} / 教材 {len(mats)} / 問題 {len(roadmap_qs)} / 警告 {len(g.warnings)} / 問題点 {len(g.stops)}")
    if not g.stops:
        print("✓ ロードマップ試作の門を通過")
    code = 1 if g.stops else 0
    print(json.dumps({"exitCode": code, "topics": len(units), "questions": len(roadmap_qs),
                      "stops": g.stops, "warnings": g.warnings, "limits": LIMITS}, ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main())
