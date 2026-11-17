#!/usr/bin/env python3
"""資格対策の学びの単元の構成を教材の門にかける。

    python3 scripts/check_unit_plans.py --data data/ip

契約は docs/goals/GOAL-10-verify-content-before-delivery/UC-024-check-unit-plans-at-gate/contract.yaml。
単元の構成の形と上限・下限の値の正本はその契約（schemas.UnitPlan と checkUnitPlans の limits）。書き方は
scripts/prompts/unit_plan.md。data はコマンドを呼んだ作業ディレクトリからのパスとして読み、末尾が登録簿の学びの key。
登録簿は targets.py（リポジトリの src/shared/targets.json）から読む。

標準出力には契約の response の形の JSON を出し、終了コードは exitCode（0 は通した、1 は止める理由が 1 件以上）。
学びを断ったときは契約の ToolError（{"error": {"code", "reason"}}）を出して 2 で終わる。標準エラーには人が読む要約を出す。
止める理由と警告の箇所は「unit_plans/<番号>.json」に、まとまりは「まとまり n」（学ぶ順の 1 始まり）、論点は「論点 n」、
受け持ちは「受け持ち n『説明の名前』」、前提は「論点 n の前提」を続けて言う。
書き直しの束を作る道具（build_rewrite_bundles.py）と投入（build_seed.py）も、この門の gate() を呼んで判定する。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from targets import targets  # noqa: E402
from learning_parts import topic_units  # noqa: E402

# 契約 checkUnitPlans の response.limits の値。門と書き直しの束を作る道具はここだけから引く。
LIMITS = {"groupTopicsMax": 8, "groupTopicsMinWarn": 3, "prerequisitesMax": 2}

PLAN_DIR = "unit_plans"
PLAN_NAME = re.compile(r"^([0-9]{2})\.json$")
PLAN_KEYS = {"unit_no", "unit", "overview", "groups", "owners", "prerequisites"}
GROUP_KEYS = {"name", "description", "topics"}
OWNER_KEYS = {"subject", "owner", "topics"}
TOPIC_KEY = re.compile(r"^[1-9][0-9]*$")
# これが欠けたファイルは、門が見た論点の数にも、他の道具へ渡す形の読めた単元の構成にも入れない欄。
STRUCTURAL_KEYS = ("unit_no", "groups")
LEARNING_FILES = ("syllabus.json", "topics.json")


class Refused(Exception):
    """契約の errors に当たって止まる。code は契約の error の code。detail は応答に添える欄。"""

    def __init__(self, code: str, reason: str, **detail):
        super().__init__(reason)
        self.code, self.reason, self.detail = code, reason, detail


# @implements REQ-486
def _read_text(p: Path) -> str:
    """門が読むファイルを読み取り専用で開いて読む。門はどのファイルも書き換えない。"""
    with p.open("r", encoding="utf-8") as f:
        return f.read()


def _read_json(p: Path):
    return json.loads(_read_text(p))


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 1


def _parse_syllabus(p: Path, raw) -> dict[int, dict]:
    try:
        units: dict[int, dict] = {}
        for it in raw["items"]:
            assert _is_int(it["number"]) and _is_int(it["middle_no"]) and isinstance(it["middle"], str) and it["middle"]
            u = units.setdefault(it["middle_no"], {"unit": it["middle"], "field": it.get("field", ""),
                                                   "major": it.get("major", ""), "items": {}})
            u["items"][it["number"]] = it.get("name", "")
        return units
    except (KeyError, TypeError, AssertionError):
        raise Refused("INVALID_INPUT", f"{p} が形として読めない")


def _parse_topics(p: Path, raw) -> list[dict]:
    try:
        topics = raw["topics"]
        assert isinstance(topics, list)
        for t in topics:
            assert _is_int(t["id"]) and isinstance(t["term"], str) and t["term"] and _is_int(t["syllabus_item"])
        return topics
    except (KeyError, TypeError, AssertionError):
        raise Refused("INVALID_INPUT", f"{p} が形として読めない")


# @implements REQ-443, REQ-466
# @operation UC-024#readSyllabusUnits
# @operation UC-024#readTopicUnits
def learning_files(d: Path) -> tuple[dict[int, dict], list[dict]]:
    """(シラバスの単元, 論点の一覧)。どちらかが無ければ NOT_FOUND、無いものが無くて読めなければ INVALID_INPUT。
    シラバスの単元は middle_no → {unit, field, major, items}（items は小項目の番号 → 小項目の名前）。"""
    missing = [name for name in LEARNING_FILES if not (d / name).is_file()]
    if missing:
        raise Refused("NOT_FOUND", f"学びの置き場 {d} に {'・'.join(missing)} が無い")
    parsed = []
    for name in LEARNING_FILES:
        try:
            parsed.append(_read_json(d / name))
        except (OSError, ValueError):
            raise Refused("INVALID_INPUT", f"{d / name} が JSON として読めない")
    return _parse_syllabus(d / LEARNING_FILES[0], parsed[0]), _parse_topics(d / LEARNING_FILES[1], parsed[1])


# @implements REQ-443, REQ-466
def qualification_learning(data: str) -> Path:
    """登録簿にあり種類が資格対策で、シラバスと論点の一覧が読める学びだけを通し、学びの置き場を返す。
    断る順は契約の errors の順（登録簿に無い → 資格対策でない → ファイルが無い → 読めない）。"""
    d = Path(data)
    entry = targets().get(d.name)
    if entry is None:
        raise Refused("INVALID_INPUT", f"登録簿に無い学び『{d.name}』")
    if entry.get("kind", "roadmap") != "exam":
        raise Refused("INVALID_INPUT", f"資格対策でない学び『{d.name}』")
    learning_files(d)
    return d


def _f(kind: str, where: str, reason: str) -> dict:
    return {"kind": kind, "where": where, "reason": reason}


def _blocking(f: dict) -> dict:
    """形として読めない（JSON でないか、欄の型か欄の名前が契約と合わない）止める理由の印。
    印のあるファイルは中身を他に確かめない。印は blocks_reading() が見て、結果に出す前に外す。"""
    return {**f, "_blocks": True}


def _incomplete(f: dict) -> dict:
    """単元の番号・まとまり・まとまりの論点の並びが欠ける止める理由の印。印のあるファイルも他の確かめは続けるが、
    門が見た論点の数と、読めた単元の構成には入れない。印は incomplete() が見て、結果に出す前に外す。"""
    return {**f, "_incomplete": True}


def _unplaced(f: dict) -> dict:
    """どの単元の構成として読むかが決まらない止める理由の印（単元の番号がファイル名と食い違うか、シラバスに無い単元を指す）。
    印のあるファイルは、単元によらない検査（まとまりの論点の数）だけを続ける。印は unplaced() が見て、結果に出す前に外す。"""
    return {**f, "_unplaced": True}


# @implements REQ-444
def blocks_reading(findings: list[dict]) -> bool:
    return any(f.get("_blocks") for f in findings)


# @implements REQ-444
def unplaced(findings: list[dict]) -> bool:
    return any(f.get("_unplaced") for f in findings)


# @implements REQ-442, REQ-444
def incomplete(findings: list[dict]) -> bool:
    return any(f.get("_incomplete") for f in findings)


def _public(findings: list[dict]) -> list[dict]:
    return [{k: v for k, v in f.items() if not k.startswith("_")} for f in findings]


def _text(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _ints(v) -> bool:
    return isinstance(v, list) and all(_is_int(x) for x in v)


def _where(name: str) -> str:
    return f"{PLAN_DIR}/{name}"


def _group(name: str, i: int) -> str:
    return f"{_where(name)} まとまり {i + 1}"


def _owner(name: str, i: int, o: dict) -> str:
    return f"{_where(name)} 受け持ち {i + 1}『{o.get('subject', '')}』"


def _missing(v, kind: type) -> bool:
    """欄が欠けている（無いか、契約の型のまま空）。型の違う値は欠けとせず、形として読めない側にする。"""
    if v is None:
        return True
    if kind is str:
        return isinstance(v, str) and not v.strip()
    if kind is list:
        return isinstance(v, list) and not v
    return False


# @implements REQ-444, BR-058
def check_plan_shape(name: str, plan, syllabus: dict[int, dict]) -> list[dict]:
    """1 つの単元の構成の形・必須の要素・単元の番号・指す単元・まとまりの名前の重なりを見る。返すのは止める理由。
    欄の型か欄の名前が契約の形と合わなければ、読めない理由だけを返し、中身を他に確かめない。"""
    where = _where(name)
    if not isinstance(plan, dict):
        return [_blocking(_f("unreadablePlan", where, "単元の構成が JSON のオブジェクトでない"))]
    stops: list[dict] = []
    extra = sorted(set(plan) - PLAN_KEYS)
    if extra:
        stops.append(_blocking(_f("unreadablePlan", where, f"契約に無い欄 {extra}")))
    for key, kind in (("unit_no", int), ("unit", str), ("overview", str), ("groups", list)):
        if _missing(plan.get(key), kind):
            f = _f("missingElement", where, f"{key} が欠けている")
            stops.append(_incomplete(f) if key in STRUCTURAL_KEYS else f)
    if plan.get("owners") is None:
        stops.append(_f("missingElement", where, "owners が欠けている"))
    if plan.get("unit_no") is not None and not _is_int(plan["unit_no"]):
        stops.append(_blocking(_f("unreadablePlan", where, "unit_no が 1 以上の整数でない")))
    for key in ("unit", "overview"):
        if plan.get(key) is not None and not isinstance(plan[key], str):
            stops.append(_blocking(_f("unreadablePlan", where, f"{key} が文字列でない")))
    groups = plan.get("groups")
    if groups is not None and not isinstance(groups, list):
        stops.append(_blocking(_f("unreadablePlan", where, "groups が配列でない")))
    for i, g in enumerate(groups if isinstance(groups, list) else []):
        gw = _group(name, i)
        if not isinstance(g, dict):
            stops.append(_blocking(_f("unreadablePlan", gw, "まとまりがオブジェクトでない")))
            continue
        extra = sorted(set(g) - GROUP_KEYS)
        if extra:
            stops.append(_blocking(_f("unreadablePlan", gw, f"契約に無い欄 {extra}")))
        for key in ("name", "description"):
            if _missing(g.get(key), str):
                stops.append(_f("missingElement", gw, f"{key} が欠けている"))
            elif not isinstance(g[key], str):
                stops.append(_blocking(_f("unreadablePlan", gw, f"{key} が文字列でない")))
        tp = g.get("topics")
        if _missing(tp, list):
            stops.append(_incomplete(_f("missingElement", gw, "topics が欠けている")))
        elif not _ints(tp):
            stops.append(_blocking(_f("unreadablePlan", gw, "topics が論点 ID（1 以上の整数）の配列でない")))
    owners = plan.get("owners")
    if owners is not None and not isinstance(owners, list):
        stops.append(_blocking(_f("unreadablePlan", where, "owners が配列でない")))
    for i, o in enumerate(owners if isinstance(owners, list) else []):
        if not (isinstance(o, dict) and not set(o) - OWNER_KEYS and _text(o.get("subject"))
                and _is_int(o.get("owner")) and _ints(o.get("topics"))):
            stops.append(_blocking(_f("unreadablePlan", _owner(name, i, o if isinstance(o, dict) else {}),
                                      "受け持ちが subject・owner・topics（論点 ID の配列）の形でない")))
    pre = plan.get("prerequisites", {})
    if not isinstance(pre, dict) or not all(TOPIC_KEY.match(k) and _ints(v) for k, v in pre.items()):
        stops.append(_blocking(_f("unreadablePlan", where, "prerequisites が論点 ID の文字列 → 論点 ID の配列の形でない")))
    unreadable = [f for f in stops if f["kind"] == "unreadablePlan"]
    if unreadable:
        return unreadable

    unit_no = plan.get("unit_no")
    m = PLAN_NAME.match(name)
    if not m:
        stops.append(_unplaced(_f("unitNoMismatch", where, "ファイル名が単元の番号 2 桁（例 21.json）でない")))
    elif unit_no is not None and int(m.group(1)) != unit_no:
        stops.append(_unplaced(_f("unitNoMismatch", where, f"ファイル名の番号 {m.group(1)} と単元の番号 {plan['unit_no']} が違う")))
    s = syllabus.get(unit_no) if unit_no is not None else None
    if unit_no is not None and s is None:
        stops.append(_unplaced(_f("unknownUnit", where, f"単元 {plan['unit_no']} がシラバスに無い")))
    elif s is not None and _text(plan.get("unit")) and s["unit"] != plan["unit"]:
        stops.append(_f("unitNameMismatch", where, f"単元の名前『{plan['unit']}』がシラバスの『{s['unit']}』と違う"))
    seen: dict[str, int] = {}
    for i, g in enumerate(plan.get("groups") or []):
        if not _text(g.get("name")):
            continue
        if g["name"] in seen:
            stops.append(_f("duplicateGroupName", _group(name, i),
                            f"まとまりの名前『{g['name']}』がまとまり {seen[g['name']] + 1} と重なる"))
        else:
            seen[g["name"]] = i
    return stops


def _readable_view(plan: dict) -> dict:
    """形として読めた単元の構成を、欠けた要素を空として確かめに使える形にそろえる（まとまり・論点の並び・受け持ち・前提）。
    論点の並びが欠けたまとまりは、_missing_topics を付けて残す（まとまりの番号を保つため）。"""
    groups = [{**g, "topics": g.get("topics") or [], "_missing_topics": not g.get("topics")}
              for g in plan.get("groups") or []]
    return {**plan, "groups": groups, "owners": plan.get("owners") or [], "prerequisites": plan.get("prerequisites") or {}}


# @implements BR-057
def learning_order(plan: dict) -> list[int]:
    """単元の学ぶ順（まとまりの順に、まとまりの中の並びをつないだ論点 ID。重なりは最初の位置）。"""
    order: list[int] = []
    for g in plan["groups"]:
        for t in g["topics"]:
            if t not in order:
                order.append(t)
    return order


# @implements REQ-445
def check_partition(name: str, plan: dict, unit_of: dict[int, int]) -> list[dict]:
    """単元の論点がまとまりの並びにちょうど 1 回だけ現れ、まとまりに他の単元の論点も学びに無い論点も無いことを見る。"""
    unit = plan["unit_no"]
    stops: list[dict] = []
    groups_of: dict[int, list[int]] = {}
    for i, g in enumerate(plan["groups"]):
        repeated: set[int] = set()
        for t in g["topics"]:
            if t not in unit_of:
                stops.append(_f("unknownTopic", _group(name, i), f"論点 {t} が学びに無い"))
            elif unit_of[t] != unit:
                stops.append(_f("foreignTopic", _group(name, i), f"論点 {t} は単元 {unit_of[t]} の論点"))
            elif i in groups_of.setdefault(t, []):
                if t not in repeated:
                    repeated.add(t)
                    stops.append(_f("topicRepeatedInGroup", f"{_group(name, i)} 論点 {t}",
                                    f"論点 {t} がまとまり {i + 1} に {g['topics'].count(t)} 回並ぶ"))
            else:
                groups_of[t].append(i)
    for t in sorted(t for t, u in unit_of.items() if u == unit):
        gs = groups_of.get(t, [])
        if not gs:
            stops.append(_f("topicNotGrouped", f"{_where(name)} 論点 {t}", f"論点 {t} がどのまとまりにも入っていない"))
        elif len(gs) > 1:
            stops.append(_f("topicInManyGroups", f"{_where(name)} 論点 {t}",
                            f"論点 {t} が {len(gs)} つのまとまり（{', '.join(f'まとまり {i + 1}' for i in gs)}）に入る"))
    return stops


# @implements REQ-446
def check_group_max(name: str, plan: dict) -> list[dict]:
    """まとまりの論点の数が上限を超えれば止める理由にする。"""
    mx = LIMITS["groupTopicsMax"]
    return [_f("groupTooLarge", _group(name, i), f"まとまりの論点が {len(g['topics'])} で上限 {mx} を超える")
            for i, g in enumerate(plan["groups"]) if not g.get("_missing_topics") and len(g["topics"]) > mx]


# @implements REQ-449
def check_group_min(name: str, plan: dict) -> list[dict]:
    """まとまりの論点の数が下限に届かなければ警告にする（止める理由にはしない）。
    論点の並びが欠けたまとまりは、要素の欠けとして止める理由の側に挙がるので、ここでは数えない。"""
    mn = LIMITS["groupTopicsMinWarn"]
    return [_f("groupTooSmall", _group(name, i), f"まとまりの論点が {len(g['topics'])} で {mn} に届かない")
            for i, g in enumerate(plan["groups"]) if not g.get("_missing_topics") and len(g["topics"]) < mn]


def _prerequisites_in_plan(name: str, plan: dict, unit_of: dict[int, int]) -> list[dict]:
    """1 つの単元の構成の前提の、持つ側と先に読む側の実在・自分自身・同じ論点の重なり・本数・同じ単元の学ぶ順との食い違いを見る。
    同じ論点が 2 回以上並ぶ前提は、重なりの止める理由を 1 件にし、他の判定は 1 回だけ数える。
    単元の番号が欠けた単元の構成は、単元に依る判定（持つ側が単元の外・学ぶ順で後ろ）をせず、単元に依らない判定だけをする。"""
    unit = plan.get("unit_no")
    pos = {t: i for i, t in enumerate(learning_order(plan))}
    mx = LIMITS["prerequisitesMax"]
    stops: list[dict] = []
    for key, pres in plan.get("prerequisites", {}).items():
        t = int(key)
        pw = f"{_where(name)} 論点 {t} の前提"
        if t not in unit_of:
            stops.append(_f("prerequisiteKeyUnknown", pw, f"前提を持つ論点 {t} が学びに無い"))
        elif unit is not None and unit_of[t] != unit:
            stops.append(_f("prerequisiteKeyForeign", pw, f"前提を持つ論点 {t} は単元 {unit_of[t]} の論点"))
        for p in sorted({p for p in pres if pres.count(p) > 1}, key=pres.index):
            stops.append(_f("prerequisiteDuplicate", f"{_where(name)} 論点 {t}", f"前提に論点 {p} が {pres.count(p)} 回並ぶ"))
        if len(pres) > mx:
            stops.append(_f("prerequisiteTooMany", pw, f"論点 {t} の前提が {len(pres)} 本で上限 {mx} を超える"))
        for p in dict.fromkeys(pres):
            if p == t:
                stops.append(_f("prerequisiteSelf", pw, f"論点 {t} が自分自身を前提にしている"))
            elif p not in unit_of:
                stops.append(_f("prerequisiteUnknown", pw, f"論点 {t} の前提の論点 {p} が学びに無い"))
            elif unit is not None and unit_of[p] == unit and p in pos and t in pos and pos[p] > pos[t]:
                stops.append(_f("prerequisiteAfter", pw, f"論点 {t} の前提の論点 {p} が学ぶ順で後ろにある"))
    return stops


def _prerequisite_cycles(plans: dict[str, dict]) -> list[dict]:
    """学びの全部の単元の構成の前提をつないでたどり、元の論点に戻る並びを挙げる（自分自身を指す前提は除く）。
    挙げた物の _files には、循環に入る前提を持つ単元の構成のファイルをすべて持つ。"""
    edges: dict[int, list[int]] = {}
    file_of: dict[int, str] = {}
    for name, plan in sorted(plans.items()):
        for key, pres in plan.get("prerequisites", {}).items():
            t = int(key)
            file_of.setdefault(t, name)
            edges.setdefault(t, []).extend(p for p in pres if p != t)
    stops: list[dict] = []
    reported: set[frozenset] = set()
    state: dict[int, int] = {}

    def visit(start: int) -> None:
        stack: list[tuple[int, int]] = [(start, 0)]
        path: list[int] = []
        while stack:
            node, i = stack.pop()
            if i == 0:
                state[node] = 1
                path.append(node)
            nexts = edges.get(node, [])
            if i < len(nexts):
                stack.append((node, i + 1))
                nx = nexts[i]
                if state.get(nx) == 1:
                    cyc = path[path.index(nx):]
                    if frozenset(cyc) not in reported:
                        reported.add(frozenset(cyc))
                        chain = " → ".join(str(x) for x in cyc + [nx])
                        f = _f("prerequisiteCycle", f"{_where(file_of[nx])} 論点 {nx} の前提",
                               f"前提をたどると元の論点に戻る（{chain}）")
                        stops.append({**f, "_files": sorted({file_of[x] for x in cyc})})
                elif nx not in state:
                    stack.append((nx, 0))
            else:
                state[node] = 2
                path.pop()

    for t in sorted(edges):
        if t not in state:
            visit(t)
    return stops


# @implements REQ-447, BR-058
def check_prerequisites(plans: dict[str, dict], unit_of: dict[int, int]) -> list[dict]:
    """形の読めた単元の構成すべての前提を見る。単元をまたぐ循環は全部の単元の構成を合わせて判定する。"""
    stops: list[dict] = []
    for name, plan in sorted(plans.items()):
        stops.extend(_prerequisites_in_plan(name, plan, unit_of))
    return stops + _prerequisite_cycles(plans)


# @implements REQ-448
def check_owners(name: str, plan: dict, unit_of: dict[int, int]) -> list[dict]:
    """受け持ちの触れる論点が 2 つ以上で、受け持ちの論点がその中にあって学ぶ順で最初で、触れる論点がどれもこの単元にあることを見る。"""
    unit = plan["unit_no"]
    pos = {t: i for i, t in enumerate(learning_order(plan))}
    stops: list[dict] = []
    for i, o in enumerate(plan.get("owners") or []):
        ow = _owner(name, i, o)
        if len(set(o["topics"])) < 2:
            stops.append(_f("ownerTooFewTopics", ow, f"『{o['subject']}』に触れる論点が {len(set(o['topics']))} つだけ"))
        outside = [t for t in o["topics"] if unit_of.get(t) != unit]
        for t in outside:
            why = "学びに無い" if t not in unit_of else f"単元 {unit_of[t]} の論点"
            stops.append(_f("ownerTopicOutside", ow, f"『{o['subject']}』に触れる論点 {t} が単元の外（{why}）"))
        if o["owner"] not in o["topics"]:
            stops.append(_f("ownerNotInTopics", ow, f"受け持ちの論点 {o['owner']} が『{o['subject']}』に触れる論点に無い"))
        else:
            ordered = sorted((t for t in o["topics"] if t in pos), key=pos.get)
            if ordered and ordered[0] != o["owner"]:
                stops.append(_f("ownerNotFirst", ow,
                                f"受け持ちの論点 {o['owner']} が学ぶ順で最初でない（最初は論点 {ordered[0]}）"))
    return stops


def _plan_files(d: Path) -> list[Path]:
    plan_dir = d / PLAN_DIR
    return sorted(plan_dir.glob("*.json")) if plan_dir.is_dir() else []


# @implements BR-048
# @operation UC-024#readUnitPlan
def gate_findings(d: Path) -> tuple[dict, dict[int, dict], list[dict]]:
    """gate() と同じ判定をし、止める理由ごとに関わる単元の構成のファイルの名前（_files）を添えた物も返す。"""
    syllabus, topics = learning_files(d)
    unit_of = topic_units(syllabus, topics)
    files = _plan_files(d)
    stops: list[dict] = []
    warnings: list[dict] = []
    readable: dict[str, dict] = {}
    placed: dict[str, dict] = {}
    seen_topics: set[int] = set()
    for p in files:
        mark = lambda fs: [{**f, "_files": [p.name]} for f in fs]  # noqa: E731
        try:
            plan = _read_json(p)
        except (OSError, ValueError):
            stops.extend(mark([_f("unreadablePlan", _where(p.name), "JSON として読めない（書いている途中か壊れている）")]))
            continue
        shape = check_plan_shape(p.name, plan, syllabus)
        stops.extend(mark(shape))
        if blocks_reading(shape):
            continue
        view = _readable_view(plan)
        stops.extend(mark(check_group_max(p.name, view)))
        warnings.extend(check_group_min(p.name, view))
        if unplaced(shape):
            continue
        placed[p.name] = view
        if plan.get("unit_no") is None:
            # 単元の番号が欠けたファイルは読める側なので、前提の単元に依らない判定と循環にだけ渡す
            continue
        if not incomplete(shape):
            readable[p.name] = plan
            for g in plan["groups"]:
                seen_topics.update(g["topics"])
        stops.extend(mark(check_partition(p.name, view, unit_of)))
        stops.extend(mark(check_owners(p.name, view, unit_of)))
    pres = check_prerequisites(placed, unit_of)
    stops.extend(f if "_files" in f else {**f, "_files": [f["where"].split(" ")[0].split("/")[-1]]} for f in pres)
    result = {
        "exitCode": 1 if stops else 0,
        "units": len(files),
        "topics": len(seen_topics),
        "stops": _public(stops),
        "warnings": _public(warnings),
        "limits": dict(LIMITS),
    }
    return result, {plan["unit_no"]: plan for plan in readable.values()}, stops


# @implements REQ-442, REQ-450
def gate(d: Path) -> tuple[dict, dict[int, dict]]:
    """学びの置き場の単元の構成をすべて門にかける。単元の構成が無い単元（論点の無い単元を含む）は見ない。
    返すのは (契約 checkUnitPlans の response, 形の読めた単元の構成の 単元の番号 → 中身)。"""
    result, plans, _ = gate_findings(d)
    return result, plans


def _summary(result: dict) -> str:
    """人が読む要約。"""
    lines = [f"単元の構成 {result['units']} 単元・論点 {result['topics']}"]
    for label, key in (("止める理由", "stops"), ("警告", "warnings")):
        if result[key]:
            lines.append(f"{label} {len(result[key])} 件:")
            lines.extend(f"  - [{f['kind']}] {f['where']}: {f['reason']}" for f in result[key])
    lines.append("止める理由あり（通さない）" if result["stops"] else "止める理由なし（通す）")
    return "\n".join(lines)


# @implements REQ-443, REQ-466
def tool_error(e: Refused) -> str:
    """契約の ToolError の JSON。"""
    return json.dumps({"error": {"code": e.code, "reason": e.reason}}, ensure_ascii=False, indent=1)


# @implements UC-024, REQ-442, REQ-443
# @operation UC-024#checkUnitPlans
def main() -> int:
    ap = argparse.ArgumentParser(description="資格対策の学びの単元の構成を教材の門にかける")
    ap.add_argument("--data", required=True, help="学びの置き場（例 data/ip）")
    args = ap.parse_args()
    try:
        result, _ = gate(qualification_learning(args.data))
    except Refused as e:
        print(tool_error(e))
        print(e.reason, file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=1))
    print(_summary(result), file=sys.stderr)
    return result["exitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
