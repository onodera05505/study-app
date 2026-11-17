#!/usr/bin/env python3
"""資格対策の学びの書き直した世代の教材を様式の門にかける。

    python3 scripts/check_material_style.py --data data/ip --dir materials_v4

契約は UC-025 の contract.yaml の checkMaterialStyle。標準出力に結果の JSON を 1 つ出し、終了コードは exitCode
（0 は通した、1 は止める理由が 1 件以上）。断ったときは契約の ToolError を出して 2 で終わる。
--dir は書き直した世代のディレクトリの名前で、省略すると書き直した世代の始まり（material_generations.REWRITTEN_FROM）。
単元の構成の判定は単元の構成の門（check_unit_plans.gate_findings）に任せ、ここでは重ねて判定しない。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from check_unit_plans import PLAN_DIR, PLAN_NAME, Refused, gate_findings  # noqa: E402
from learning_parts import read_syllabus_units, read_topics, topic_units  # noqa: E402
from material_generations import REWRITTEN_FROM, generation_dirs, is_rewritten  # noqa: E402
from targets import targets  # noqa: E402

# 門が使った値（契約の Limits）。値を変えるときは契約と同時に変える。
LIMITS = {
    "explanationFiguresMax": 1,
    "sameTopicMatchLength": 20,
    "sameUnitMatchLength": 30,
    "examPhrases": ["試験では", "問われ", "出題され", "と覚え", "覚えると", "覚えておき", "定番の", "決め手です", "つまずきやすい", "差がつく"],
    "numberPattern": "[0-9０-９]+(?:[.．][0-9０-９]+)?",
    "numberMinDigits": 2,
}

DATA_ARG = re.compile(r"^data/[a-z]+$")
DIR_ARG = re.compile(r"^materials_v[0-9]+$")
BUNDLE_FILE = re.compile(r"^[0-9]{2}-[1-9][0-9]*\.json$")
BUNDLE_NAME = re.compile(r"^[0-9]{2}-[1-9][0-9]*$")
# 問われ方・覚え方の言い回しを書いてよい見出し（執筆の仕様書の「混同しやすい用語」）
CONFUSABLE_HEADING = "混同しやすい用語"
HEADING = re.compile(r"^###\s+(.*\S)\s*$")
# 図の行の説明文には角かっこ（「A[1]」など）が入ってよい。`](` だけは入らない（表示側 Markdown.tsx と同じ読み方）
FIGURE_ROW = re.compile(r"!\[(?:[^\]\n]|\](?!\())*\]\([^)\s]+\)")
TABLE_DELIM_ROW = re.compile(r"^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$")
LINE_MARK = re.compile(r"^(?:#{1,6}\s+|-\s+|[0-9]+[.)]\s+)")
INLINE_MARK = re.compile(r"\*\*|\[\[|\]\]|\|")
# [[ ]] で囲んだ用語（中の字ごと）
TERM_MARK = re.compile(r"\[\[[^\[\]\n]*\]\]")
NUMBER = re.compile(LIMITS["numberPattern"])
TO_HALF = str.maketrans("０１２３４５６７８９．", "0123456789.")


def _finding(kind: str, where: str, reason: str) -> dict:
    return {"kind": kind, "where": where, "reason": reason}


# @implements REQ-485
def read_file(path: Path):
    """門が読むファイルはすべてここから読む（読むだけで開いたファイルに書かない）。無ければ FileNotFoundError、JSON でなければ ValueError。"""
    return json.loads(path.read_text(encoding="utf-8"))


def _is_id(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 1


def _text(v) -> bool:
    return isinstance(v, str) and len(v) >= 1


def _args() -> argparse.Namespace:
    class _Parser(argparse.ArgumentParser):
        def error(self, message: str):
            raise Refused("INVALID_INPUT", "引数が契約の形の外")

    ap = _Parser(prog="check_material_style.py", add_help=False)
    ap.add_argument("--data")
    ap.add_argument("--dir")
    a, unknown = ap.parse_known_args()
    if unknown or a.data is None or not DATA_ARG.match(a.data):
        raise Refused("INVALID_INPUT", "引数が契約の形の外")
    return a


# @implements REQ-453, BR-004
def accepted_request(a: argparse.Namespace) -> tuple[Path, str, dict[int, int]]:
    """登録簿・学びの種類・書き直した世代の名前・シラバスと論点の一覧の順に確かめ、当たれば何も確かめずに断る。
    返すのは (学びの置き場, 書き直した世代の名前, 論点 ID → 単元の番号)。"""
    d = Path(a.data)
    entry = targets().get(d.name)
    if entry is None:
        raise Refused("INVALID_INPUT", f"登録簿に無い学び『{d.name}』")
    if entry.get("kind") != "exam":
        raise Refused("INVALID_INPUT", f"資格対策でない学び『{d.name}』")
    gen = a.dir if a.dir is not None else f"materials_v{REWRITTEN_FROM}"
    # 契約の形は値の全体に当てる（match の `$` は末尾の改行の手前でも当たるので fullmatch で照らす）
    if not DIR_ARG.fullmatch(gen) or not is_rewritten(gen):
        raise Refused("INVALID_INPUT", f"書き直した世代の名前でない『{gen}』（materials_v{REWRITTEN_FROM} 以降）")
    for name in ("syllabus.json", "topics.json"):
        if not (d / name).is_file():
            raise Refused("NOT_FOUND", f"{d / name} が無い")
    syllabus = read_syllabus_units(d)
    try:
        items = read_file(d / "syllabus.json")["items"]
    except (OSError, ValueError, KeyError, TypeError):
        items = None
    if not isinstance(items, list):
        raise Refused("INVALID_INPUT", f"{d / 'syllabus.json'} が形として読めない")
    return d, gen, topic_units(syllabus, read_topics(d))


def _material_ok(m) -> bool:
    return (isinstance(m, dict) and _is_id(m.get("topic_id")) and _text(m.get("term"))
            and _text(m.get("explanation")) and _text(m.get("detail")))


# @implements REQ-454
# @operation UC-025#readRewrittenMaterialFile
def read_rewritten_file(path: Path) -> list[dict] | None:
    """書き直した世代の 1 つの束の教材（契約の readRewrittenMaterialFile）。形として読めなければ None。"""
    try:
        obj = read_file(path)
    except (OSError, ValueError):
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("bundle"), str) or not BUNDLE_NAME.match(obj["bundle"]):
        return None
    ms = obj.get("materials")
    if not isinstance(ms, list) or not all(_material_ok(m) for m in ms):
        return None
    return ms


# @implements REQ-452
def rewritten_materials(d: Path, gen: str, stops: list[dict]) -> dict[int, dict]:
    """書き直した世代の置き場の教材だけを論点ごとに読む。置き場が無ければ空。JSON でないファイルは見ない。"""
    out: dict[int, dict] = {}
    place = d / gen
    if not place.is_dir():
        return out
    for path in sorted(place.glob("*.json")):
        ms = unreadable_output(gen, path, stops)
        for m in ms or []:
            out[m["topic_id"]] = {**m, "_where": f"{gen}/{path.name}"}
    return out


# @implements REQ-454
def unreadable_output(gen: str, path: Path, stops: list[dict]) -> list[dict] | None:
    """束の名前の形でないか契約の教材の形として読めない JSON のファイルを、そのファイルを挙げて止める理由にする。"""
    where = f"{gen}/{path.name}"
    if not BUNDLE_FILE.match(path.name):
        stops.append(_finding("unreadableOutput", where, "束の名前の形（単元の番号 2 桁-まとまりの順.json）でない"))
        return None
    ms = read_rewritten_file(path)
    if ms is None:
        stops.append(_finding("unreadableOutput", where, "契約の教材の形として読めない（書いている途中か壊れている）"))
    return ms


def _stop_units(stop: dict) -> set[int]:
    """単元の構成の門の止める理由が関する単元の番号（単元の構成のファイルの名前の番号）。
    前提の循環のように複数の単元の構成にまたがる物は、それに入るすべての単元の構成の単元を持つ。"""
    return {int(mo.group(1)) for name in stop.get("_files", []) if (mo := PLAN_NAME.match(name))}


# @implements REQ-490, BR-048
def plans_for(d: Path, units: set[int]) -> tuple[list[dict], dict[int, dict]]:
    """書き直した世代に論点がある単元ごとに、単元の構成が無い・読めない・単元の構成の門の止める理由に当たる単元を、
    その単元を挙げて止める理由にする。書き直した世代に論点の無い単元の構成は見ない。
    返すのは (止める理由, 使える単元の構成の 単元の番号 → 中身)。"""
    _, readable, gate_stops = gate_findings(d)
    by_unit: dict[int, list[dict]] = {}
    for s in gate_stops:
        for u in _stop_units(s) & units:
            by_unit.setdefault(u, []).append(s)
    stops: list[dict] = []
    usable: dict[int, dict] = {}
    for u in sorted(units):
        rel = f"{PLAN_DIR}/{u:02d}.json"
        if not (d / rel).is_file():
            stops.append(_finding("unitPlanStops", rel, f"単元 {u} の単元の構成が無い"))
        elif by_unit.get(u):
            why = "／".join(f"{s['kind']}（{s['where']}）: {s['reason']}" for s in by_unit[u])
            stops.append(_finding("unitPlanStops", rel, f"単元 {u} の単元の構成が単元の構成の門の止める理由に当たる: {why}"))
        elif u not in readable:
            stops.append(_finding("unitPlanStops", rel, f"単元 {u} の単元の構成が読めない"))
        else:
            usable[u] = readable[u]
    return stops, usable


# @implements REQ-491
def topics_not_in_plan(materials: dict[int, dict], unit_of: dict[int, int], usable: dict[int, dict], units: set[int]) -> list[dict]:
    """使える単元の構成のどのまとまりにも無い書き直した世代の論点を止める理由にする。単元の構成が使えない単元の論点は挙げない。"""
    out: list[dict] = []
    for tid, m in sorted(materials.items()):
        u = unit_of.get(tid, 0)
        if u in units and u not in usable:
            continue
        grouped = {t for g in usable[u]["groups"] for t in g["topics"]} if u in usable else set()
        if tid not in grouped:
            why = "論点の一覧に無いか単元が決まらない" if u == 0 else f"単元 {u} の単元の構成のどのまとまりにも無い"
            out.append(_finding("topicNotInPlan", f"{m['_where']} topic {tid}", why))
    return out


def _figure_ok(f) -> bool:
    return isinstance(f, dict) and _is_id(f.get("id")) and _text(f.get("after")) and _text(f.get("caption"))


# @implements REQ-455
# @operation UC-025#readFigureSpec
def read_figures(d: Path, tid: int) -> list[dict] | None:
    """1 論点の図の仕様の図（契約の readFigureSpec）。ファイルが無ければ空、形として読めなければ None。"""
    try:
        obj = read_file(d / "material_figures" / f"{tid}.json")
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return None
    if not isinstance(obj, dict) or not _is_id(obj.get("topic_id")):
        return None
    figs = obj.get("figures")
    if not isinstance(figs, list) or not all(_figure_ok(f) for f in figs):
        return None
    return figs


# @implements REQ-455
def figure_stops(tid: int, figures: list[dict] | None) -> list[dict]:
    """図の仕様のファイルが読めないか、短い説明の直後に置く図が上限を超える論点を、そのファイルと図を挙げて止める理由にする。"""
    where = f"material_figures/{tid}.json"
    if figures is None:
        return [_finding("unreadableFigureSpec", where, "図の仕様の形として読めない")]
    after_ex = [f for f in figures if f["after"] == "explanation"]
    if len(after_ex) <= LIMITS["explanationFiguresMax"]:
        return []
    ids = "・".join(str(f["id"]) for f in after_ex)
    return [_finding("explanationFigures", where,
                    f"短い説明の直後に置く図が {len(after_ex)} 枚（図 {ids}）で上限 {LIMITS['explanationFiguresMax']} を超える")]


def _drop_figure_rows(text: str) -> str:
    """図の行（![説明文](図のパス)）を本文から外す。"""
    return FIGURE_ROW.sub("", text)


def _plain(text: str, drop_terms: bool = False) -> str:
    """記法と空白を除いた本文。一致の長さはこの字数で数える。図の行と表の区切り行は本文に含めない。
    drop_terms のときは [[ ]] で囲んだ用語を中の字ごと除き、前後をつなぐ。"""
    text = _drop_figure_rows(text)
    if drop_terms:
        text = TERM_MARK.sub("", text)
    lines = []
    for line in text.split("\n"):
        s = line.strip()
        if TABLE_DELIM_ROW.match(s) and "-" in s:
            continue
        lines.append(INLINE_MARK.sub("", LINE_MARK.sub("", s)))
    return re.sub(r"\s", "", "".join(lines))


def _sections(m: dict) -> list[tuple[str, str, str]]:
    """教材を (箇所, 見出し, 文) に割る。explanation が 1 つ、detail は ### の見出しごと（最初の見出しの前は detail）。
    見出しのある箇所は、見出しの下の文が空でも残す。"""
    out = [("explanation", "", m["explanation"])]
    name, heading, buf = "detail", "", []
    for line in m["detail"].split("\n"):
        mo = HEADING.match(line.strip())
        if mo:
            out.append((name, heading, "\n".join(buf)))
            heading = mo.group(1)
            name, buf = f"detail ### {heading}", []
        else:
            buf.append(line)
    out.append((name, heading, "\n".join(buf)))
    return [s for s in out if s[1] or s[2].strip()]


# @implements REQ-457
def exam_phrases(tid: int, m: dict) -> list[dict]:
    """問われ方・覚え方の言い回しが、見出しの行の文そのものも含めて、混同しやすい用語の見出しの外にある箇所を警告にする。"""
    out: list[dict] = []
    for where, heading, text in _sections(m):
        if heading == CONFUSABLE_HEADING:
            continue
        parts = (_plain(heading), _plain(text))
        for phrase in LIMITS["examPhrases"]:
            if any(phrase in part for part in parts):
                out.append(_finding("examPhrase", f"{m['_where']} topic {tid} {where}",
                                   f"「{phrase}」が混同しやすい用語の見出しの外にある"))
    return out


def _common_run(a: str, b: str, n: int) -> str | None:
    """a と b に共通する n 字の連続があれば、その最初の 1 つを返す。区切りの \\0 をまたぐ連続は数えない。"""
    if n <= 0 or len(a) < n or len(b) < n:
        return None
    grams = {a[i:i + n] for i in range(len(a) - n + 1)}
    for i in range(len(b) - n + 1):
        g = b[i:i + n]
        if "\0" not in g and g in grams:
            return g
    return None


# @implements REQ-458
def same_topic_repeats(tid: int, m: dict, figures: list[dict]) -> list[dict]:
    """同じ論点の中で、図の説明文と本文、短い説明と詳しい解説が長く一致する 2 か所を警告にする。"""
    n = LIMITS["sameTopicMatchLength"]
    where = f"{m['_where']} topic {tid}"
    ex, det = _plain(m["explanation"]), _plain(m["detail"])
    out: list[dict] = []
    hit = _common_run(ex, det, n)
    if hit:
        out.append(_finding("sameTopicRepeat", where, f"explanation と detail が「{hit}」で {n} 字以上一致する"))
    for f in figures:
        cap = _plain(f["caption"])
        for place, body in (("explanation", ex), ("detail", det)):
            hit = _common_run(cap, body, n)
            if hit:
                out.append(_finding("sameTopicRepeat", where, f"図 {f['id']} の説明文と {place} が「{hit}」で {n} 字以上一致する"))
    return out


# @implements REQ-459
def same_unit_repeats(materials: dict[int, dict], usable: dict[int, dict]) -> list[dict]:
    """同じ単元の構成に入っている 2 つの論点の本文が長く一致する組を、受け持ちが決まっていればその論点と一緒に警告にする。
    一致の長さは [[ ]] で囲んだ用語の中の字を数えず、その前後の一致をつないで数える。"""
    n = LIMITS["sameUnitMatchLength"]
    out: list[dict] = []
    for _, plan in sorted(usable.items()):
        unit_topics: list[int] = []
        for g in plan["groups"]:
            unit_topics += [t for t in g["topics"] if t in materials and t not in unit_topics]
        bodies = {t: _plain(materials[t]["explanation"], drop_terms=True) + "\0" + _plain(materials[t]["detail"], drop_terms=True)
                  for t in unit_topics}
        for i, a in enumerate(unit_topics):
            for b in unit_topics[i + 1:]:
                hit = _common_run(bodies[a], bodies[b], n)
                if not hit:
                    continue
                owners = [o for o in plan.get("owners") or [] if {a, b} <= set(o["topics"])]
                reason = f"本文が「{hit}」で {n} 字以上一致する"
                if owners:
                    reason += "。受け持ち: " + "・".join(f"論点 {o['owner']}（{o['subject']}）" for o in owners)
                out.append(_finding("sameUnitRepeat", f"{materials[a]['_where']} topic {a} ⇔ {materials[b]['_where']} topic {b}", reason))
    return out


def _previous_materials(d: Path) -> dict[int, dict]:
    """前の世代の教材。配る本文の選び方（古い世代から重ねて後勝ち）で、書き直した世代を除いて論点ごとに最も新しい物。読めないファイルは飛ばす。"""
    out: dict[int, dict] = {}
    for g in generation_dirs(d):
        if is_rewritten(g.name):
            continue
        for path in sorted(g.glob("*.json")):
            try:
                ms = read_file(path).get("materials")
            except (OSError, ValueError, AttributeError):
                continue
            for m in ms if isinstance(ms, list) else []:
                if isinstance(m, dict) and _is_id(m.get("topic_id")):
                    out[m["topic_id"]] = m
    return out


def _numbers(text: str) -> set[str]:
    """数値を取り出す。全角は半角に寄せ、図の行の中は数えない。小数点を含まない数値は桁数の下限以上だけ。"""
    out: set[str] = set()
    for mo in NUMBER.finditer(_drop_figure_rows(text)):
        v = mo.group(0).translate(TO_HALF)
        if "." in v or len(v) >= LIMITS["numberMinDigits"]:
            out.add(v)
    return out


def _text_of(m: dict) -> str:
    return "\n".join(v for v in (m.get("explanation"), m.get("detail")) if isinstance(v, str))


# @implements REQ-460
def lost_numbers(tid: int, m: dict, prev: dict | None) -> list[dict]:
    """前の世代の教材にあって書き直した世代の教材に無い数値を警告にする。"""
    if prev is None:
        return []
    lost = _numbers(_text_of(prev)) - _numbers(_text_of(m))
    return [_finding("lostNumber", f"{m['_where']} topic {tid}", f"前の世代にある {v} が無い")
            for v in sorted(lost, key=lambda x: (float(x), x))]


# @implements REQ-473, BR-042
def style_warnings(d: Path, materials: dict[int, dict], figures: dict[int, list[dict]], usable: dict[int, dict]) -> list[dict]:
    """警告の全部。問われ方の文・同じ点の繰り返し・受け持ちの説明の繰り返し・消えた数値だけを見て、字数・文数・見出しや項目の数は見ない。"""
    prev = _previous_materials(d)
    out: list[dict] = []
    for tid, m in sorted(materials.items()):
        out += exam_phrases(tid, m)
        out += same_topic_repeats(tid, m, figures[tid])
    out += same_unit_repeats(materials, usable)
    for tid, m in sorted(materials.items()):
        out += lost_numbers(tid, m, prev.get(tid))
    return out


# @implements UC-025, REQ-451
def check_material_style() -> dict:
    """様式の門の入口。止める理由が無ければ警告の有無によらず通し、見た論点の数・警告・止める理由・使った値を返す。"""
    d, gen, unit_of = accepted_request(_args())
    stops: list[dict] = []
    materials = rewritten_materials(d, gen, stops)
    units = {unit_of[t] for t in materials if unit_of.get(t, 0)}
    usable: dict[int, dict] = {}
    if materials:
        plan_stops, usable = plans_for(d, units)
        stops += plan_stops
        stops += topics_not_in_plan(materials, unit_of, usable, units)
    figures: dict[int, list[dict]] = {}
    for tid in sorted(materials):
        figs = read_figures(d, tid)
        stops += figure_stops(tid, figs)
        figures[tid] = figs or []
    warnings = style_warnings(d, materials, figures, usable)
    return {"exitCode": 1 if stops else 0, "topics": len(materials), "stops": stops, "warnings": warnings, "limits": LIMITS}


# @implements REQ-451, REQ-453
# @operation UC-025#checkMaterialStyle
def main() -> int:
    try:
        res = check_material_style()
    except Refused as e:
        print(json.dumps({"error": {"code": e.code, "reason": e.reason}}, ensure_ascii=False, indent=1))
        return 2
    print(json.dumps(res, ensure_ascii=False, indent=1))
    return res["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
