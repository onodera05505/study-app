#!/usr/bin/env python3
"""論点の候補（名寄せ済み）からロードマップを組む。

    python3 scripts/build_roadmap.py --data data/itc [--max 40] [--per-day 3] [--out <出力先>]

入力 `topics_candidates.json`: {"candidates": [{"id", "term", "subtitle"?, "field", "middle", "summary", "source_count", "sources", "interview_count", "prereq": [論点の ID...], "goals": [1..到達基準の数]}]}
  `subtitle`（副題）は持つ候補だけが欄を書く。名前（term）とは分けて持ち、そのまま roadmap.json の単位へ移す。
入力 `roadmap_config.json`（ロードマップの設定。無ければ引数の既定）:
  値: max / per_day / min_per_goal / min_per_field / field_order / group_by
  単位を指す所はすべて論点の ID（候補の `id`）で書く。名前では当てない。
    must_include / exclude: [ID...]　cluster: [[ID...]...]
    prereq_add / prereq_replace: {"ID": [ID...]}　summary_override: {"ID": "要約"}
  （JSON の鍵は文字列なので、鍵は ID の数字を文字列にしたもの）
  設定が指す ID がどの候補にも当たらなければ、何も書き出さずに止めてその ID を示す。
出力 `roadmap.json`（順序つき単位）と `material_bundles/bundle_NN.json`（8 論点ずつ）。`--out` を渡すとその下に書く（既定は --data）。
  単位の `prereq` は前提の単位の名前（term）の一覧で書く（画面と門 check_roadmap が名前で読む）。

回の束ね方（`group_by`）:
- 既定 `"day"`: 学ぶ順を per_day ずつ割って日にする。各単位に `day`
- `"chapter"`: 候補の `chapter` で回（章）を作る。章の順は登録簿 fields の分野の順 → 候補ファイルでの章の初出の順、
  章の中は候補ファイルの順を骨格に前提を前に出し、印 1（★）の単位を章の末尾に置く。章の大きさは中身のまま。
  各単位に `round`（章の番号）・`chapter`（章の名前）・`tier`（印）。候補に chapter / tier が欠けていたら止める

優先信号: score = 一次資料の交差数（主）+ 0.5 × 副の信号（登録簿 roadmapSpec.secondarySignal）。
順序: score 降順を骨格にし、前提（prereq）が後ろに来る場合は前提を前に出す。cluster に挙げた単位は先頭の位置に連続で並べる。到達基準（goals）に繋がらない候補は落とす。
到達基準 6（自己理解）に属する単位は最後に置く（練習として）。各到達基準に最低 --min-per-goal 単位（既定 4）を確保し、選んだ単位の前提（prereq）は必ず含める。上限超過は前提として要らない低スコアから外す。
"""
from __future__ import annotations
import argparse, json, math, sys
from pathlib import Path


def _is_id(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _key_id(k):
    """設定の鍵（JSON では文字列）を論点の ID に読む。数字だけの文字列でなければ None。"""
    return int(k) if isinstance(k, str) and k.isdigit() else None


# @implements REQ-430, REQ-434
def config_refs(cfg: dict) -> list[tuple[str, object]]:
    """ロードマップの設定が単位を指す所を (場所, 値) で平らに並べる。鍵は ID に読み直した値を返す（読めなければ元の鍵）。"""
    refs: list[tuple[str, object]] = []
    for name in ("must_include", "exclude"):
        for v in cfg.get(name, []):
            refs.append((name, v))
    for i, group in enumerate(cfg.get("cluster", [])):
        for v in group:
            refs.append((f"cluster[{i}]", v))
    for name in ("prereq_add", "prereq_replace"):
        for k, vs in cfg.get(name, {}).items():
            kid = _key_id(k)
            refs.append((f"{name} の鍵", kid if kid is not None else k))
            for v in vs:
                refs.append((f"{name}[{k}]", v))
    for k in cfg.get("summary_override", {}):
        kid = _key_id(k)
        refs.append(("summary_override の鍵", kid if kid is not None else k))
    return refs


# @implements REQ-434
def unmatched_config_ids(cfg: dict, cand_ids: set[int]) -> list[str]:
    """設定が指す値のうち、論点の ID としてどの候補にも当たらない物を「場所: 値」で返す。"""
    return [f"{where}: {v!r}" for where, v in config_refs(cfg) if not (_is_id(v) and v in cand_ids)]


# @implements REQ-437
def duplicate_terms(cands: list[dict]) -> list[str]:
    """候補の中で 2 つ以上の単位が持つ名前（term）を、候補ファイルでの初出の順に返す。"""
    count: dict[str, int] = {}
    for c in cands:
        count[c["term"]] = count.get(c["term"], 0) + 1
    return [t for t, n in count.items() if n >= 2]


# @implements REQ-430
def apply_config_to_candidates(cands: list[dict], cfg: dict) -> None:
    """前提を足す・置き換える設定と要約の差し替えを、候補の論点の ID で当てる。"""
    replace = {int(k): list(v) for k, v in cfg.get("prereq_replace", {}).items()}
    add = {int(k): list(v) for k, v in cfg.get("prereq_add", {}).items()}
    summary = {int(k): v for k, v in cfg.get("summary_override", {}).items()}
    for c in cands:
        if c["id"] in replace: c["prereq"] = list(replace[c["id"]])
        for pid in add.get(c["id"], []):
            if pid not in c.setdefault("prereq", []): c["prereq"].append(pid)
        if c["id"] in summary: c["summary"] = summary[c["id"]]


def _chapter_order(chosen: list[dict], file_order: dict[int, int], fields: list[str]) -> tuple[list[dict], list[str]]:
    """章で束ねる並び。戻り値は (並べた単位, 注意)。単位には _round と _chapter を付ける。"""
    notes: list[str] = []
    fi = {f: i for i, f in enumerate(fields)}
    chap_field: dict[str, str] = {}; chap_first: dict[str, int] = {}
    for c in sorted(chosen, key=lambda c: file_order[c["id"]]):
        chap_field.setdefault(c["chapter"], c["field"]); chap_first.setdefault(c["chapter"], file_order[c["id"]])
        if chap_field[c["chapter"]] != c["field"]:
            notes.append(f"章『{c['chapter']}』が分野をまたぐ（{chap_field[c['chapter']]} と {c['field']}）。初出の分野に置く")
    chapters = sorted(chap_first, key=lambda ch: (fi.get(chap_field[ch], len(fi)), chap_first[ch]))
    ordered: list[dict] = []
    for n, ch in enumerate(chapters, 1):
        members = sorted((c for c in chosen if c["chapter"] == ch), key=lambda c: file_order[c["id"]])
        by_id = {c["id"]: c for c in members}
        seen: set[int] = set(); part: list[dict] = []
        def visit(c: dict, stack: tuple = ()):
            if c["id"] in seen or c["id"] in stack: return
            for p in c.get("prereq", []):
                if p in by_id: visit(by_id[p], stack + (c["id"],))
            seen.add(c["id"]); part.append(c)
        # ★（印 1）は章の末尾。ただし同じ章の上位の単位の前提になっている ★ は前提として前に出る
        for c in members:
            if c.get("tier") != 1: visit(c)
        pulled = [c["term"] for c in part if c.get("tier") == 1]
        if pulled: notes.append(f"章『{ch}』: ★ の単位 {pulled} が同じ章の単位の前提なので末尾より前に置いた")
        for c in members:
            if c.get("tier") == 1: visit(c)
        for c in part: c["_round"] = n; c["_chapter"] = ch
        ordered += part
    return ordered, notes


# @implements REQ-429
def unit_of(c: dict, i: int, place: dict, sig: str, term_of: dict[int, str]) -> dict:
    """候補 1 件をロードマップの単位にする。名前と副題は分けたまま移し、副題を持たない候補には副題の欄を作らない。"""
    u = {"order": i, **place, "topic_id": c["id"], "term": c["term"]}
    if "subtitle" in c: u["subtitle"] = c["subtitle"]
    u.update({"field": c["field"], "middle": c.get("middle", ""), "summary": c.get("summary", ""), "score": c["score"],
              "source_count": c.get("source_count", 0), sig: c.get(sig, 0),
              "prereq": [term_of[p] for p in c.get("prereq", []) if p in term_of], "goals": c["goals"], "sources": c.get("sources", [])})
    return u


# @implements REQ-563
def settings_of(cfg: dict, max_units: int, per_day: int, min_per_goal: int) -> tuple[int, int, int, object]:
    """(単位の数の上限, 日で束ねる 1 回の論点数, 到達基準ごとに確保する単位の数, 回の束ね方)。ロードマップの設定に値があればその値、
    無ければ渡した引数の値（引数の既定は argparse が持つ）。回の束ね方は設定に無ければ日。設定が無い学びは cfg を空で渡す。"""
    return cfg.get("max", max_units), cfg.get("per_day", per_day), cfg.get("min_per_goal", min_per_goal), cfg.get("group_by", "day")


# @implements REQ-532
def grouping_refusal(group_by) -> str | None:
    """回の束ね方が日でも章でもなければ、その束ね方を示す断りの文。"""
    return None if group_by in ("day", "chapter") else f"group_by は day か chapter: {group_by}"


# @implements REQ-533
def chapter_refusal(cands: list[dict], levels_of) -> str | None:
    """章で束ねるときの候補の断りの文。章の名前か印を欠く候補を先に、次に登録簿の印の段に無い印の候補を、名前で示す。
    levels_of は登録簿の印の段を返す関数で、章の名前と印がそろっているときだけ登録簿を読む。"""
    lack = [c["term"] for c in cands if not c.get("chapter") or c.get("tier") is None]
    if lack: return f"章で束ねるのに chapter か tier が無い候補 {len(lack)} 件: {lack[:5]}"
    levels = levels_of()
    off = [c["term"] for c in cands if c.get("tier") not in levels]
    if off: return f"印が登録簿 roadmapSpec.tiers の段に無い候補 {len(off)} 件: {off[:5]}"
    return None


# @implements REQ-534
def included_and_excluded(cfg: dict) -> list:
    """含める一覧（must_include）と除く一覧（exclude）の両方にある論点の ID を昇順で。"""
    return sorted(set(cfg.get("must_include", [])) & set(cfg.get("exclude", [])))


# @implements REQ-535
def split_by_goals(cands: list[dict]) -> tuple[list[dict], list[str]]:
    """(到達基準を持つ候補, 到達基準を 1 つも持たず落とす候補の名前)。単位は前者からだけ選ぶので、含める一覧にあっても後者は単位にならない。"""
    return [c for c in cands if c.get("goals")], [c["term"] for c in cands if not c.get("goals")]


# @implements REQ-536
def select_units(linked: list[dict], must: set, max_units: int, min_per_goal: int, min_per_field: dict, n_goals: int) -> list[dict]:
    """到達基準を持つ候補（score の降順に並べた linked）から単位を選ぶ。含める一覧を先に、残りを上限まで score 順に取り、
    到達基準ごと・分野ごとの最低数を補い、選んだ単位の前提の候補を上限を超えても含める。上限を超えた分は、前提として要らず
    最低数を割らない単位を score の低い順に外す。"""
    chosen = [c for c in linked if c["id"] in must] + [c for c in linked if c["id"] not in must][: max(0, max_units - len(must))]
    all_by_id = {c["id"]: c for c in linked}
    def ensure_goals():
        for g in range(1, n_goals + 1):
            for c in linked:
                if len([x for x in chosen if g in x["goals"]]) >= min_per_goal: break
                if c not in chosen and g in c["goals"]: chosen.append(c)
    def ensure_fields():
        for f, n in min_per_field.items():
            for c in linked:
                if len([x for x in chosen if x["field"] == f]) >= n: break
                if c not in chosen and c["field"] == f: chosen.append(c)
    def ensure_prereqs():
        changed = True
        while changed:
            changed = False
            for c in list(chosen):
                for p in c.get("prereq", []):
                    if p in all_by_id and all_by_id[p] not in chosen:
                        chosen.append(all_by_id[p]); changed = True
    def needed_by_others(c):
        return any(c["id"] in x.get("prereq", []) for x in chosen if x is not c)
    def trim():
        while len(chosen) > max_units:
            removable = [c for c in sorted(chosen, key=lambda c: (c["score"], c["term"]))
                         if c["id"] not in must and not needed_by_others(c)
                         and all(len([x for x in chosen if g in x["goals"]]) - 1 >= min_per_goal for g in c["goals"])
                         and len([x for x in chosen if x["field"] == c["field"]]) - 1 >= min_per_field.get(c["field"], 0)]
            if not removable: break
            chosen.remove(removable[0])
    # trim の後に前提を補うと上限を超え直すので、変わらなくなるまで回す（min_per_field の合計は max より小さくしておく）
    ensure_goals(); ensure_fields(); ensure_prereqs()
    for _ in range(10):
        before = len(chosen); trim(); ensure_prereqs()
        if len(chosen) <= max_units or len(chosen) == before: break
    return chosen


# @implements REQ-537
def prereqs_behind(ordered: list[dict], by_id: dict[int, dict]) -> list[tuple[str, str]]:
    """並べ終えた学ぶ順で、前提の単位が自分より後ろにある (単位の名前, 前提の単位の名前)。"""
    pos_of = {c["id"]: i for i, c in enumerate(ordered)}
    return [(c["term"], by_id[p]["term"]) for c in ordered for p in c.get("prereq", []) if p in pos_of and pos_of[p] > pos_of[c["id"]]]


# @implements REQ-538
def write_bundles(d: Path, out: Path, units: list[dict], sig: str) -> None:
    """書き手への束の割り当て（out/material_bundles/bundle_NN.json、8 論点ずつ）を書く。学びの置き場に書き手の教材の束
    （materials/bundle_*.json）があるあいだは作り直さない。並びが変わると教材の束と組がずれ、門 check_roadmap_bundle が落ちる。"""
    bdir = out / "material_bundles"; bdir.mkdir(exist_ok=True)
    if any((d / "materials").glob("bundle_*.json")):
        print("注: materials/ が既にあるので material_bundles/ は作り直さない（順序の変更は roadmap.json だけに反映）")
        return
    for p in bdir.glob("bundle_[0-9][0-9].json"): p.unlink()  # 連番の束だけ作り直す。手で作った追加の束（bundle_c2_new_a 等）は担当が読んでいる入力なので消さない
    for n, i in enumerate(range(0, len(units), 8), 1):
        chunk = units[i:i + 8]
        (bdir / f"bundle_{n:02d}.json").write_text(json.dumps({"bundle": f"bundle_{n:02d}", "topics": [
            # 副の信号のキーは対象ごとに違う（interview_count / care_count / life_count / syllabus_weight）ので sig で写す
            {k: u[k] for k in ("topic_id", "term", "field", "middle", "summary", "goals", "prereq", "sources", "source_count", sig)} for u in chunk]},
            ensure_ascii=False, indent=2), encoding="utf-8")


# @implements REQ-430, REQ-434, REQ-437
# @operation UC-030#buildRoadmap
def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--max", type=int, default=40); ap.add_argument("--per-day", type=int, default=3); ap.add_argument("--min-per-goal", type=int, default=4)
    ap.add_argument("--out", default=None, help="roadmap.json と material_bundles/ の書き先（既定は --data）")
    sys.path.insert(0, str(Path(__file__).parent))
    from targets import target as _target
    a = ap.parse_args(); d = Path(a.data); out = Path(a.out) if a.out else d
    cands = json.loads((d / "topics_candidates.json").read_text(encoding="utf-8"))["candidates"]
    cfg = json.loads((d / "roadmap_config.json").read_text(encoding="utf-8")) if (d / "roadmap_config.json").exists() else {}
    cand_ids = {c["id"] for c in cands}
    unmatched = unmatched_config_ids(cfg, cand_ids)
    if unmatched:
        print(f"ロードマップの設定が指す論点の ID のうち、どの候補にも当たらない物 {len(unmatched)} 件（何も書き出していない）:", *unmatched, sep="\n  ")
        return 1
    # 単位の前提は名前で書き出すので、名前が同じ単位があると前提が取り違えられる
    dups = duplicate_terms(cands)
    if dups:
        print(f"候補の中で名前が同じ単位 {len(dups)} 件（何も書き出していない）:", *dups, sep="\n  ")
        return 1
    # 候補の前提は論点の ID。どの候補にも当たらない前提は並べるときに使われないので知らせる
    stray = [(c["id"], p) for c in cands for p in c.get("prereq", []) if not (_is_id(p) and p in cand_ids)]
    if stray: print(f"警告: 候補の前提のうち、どの候補の ID にも当たらない物 {len(stray)} 件: " + "; ".join(f"{t} ← {p!r}" for t, p in stray[:5]))
    a.max, a.per_day, a.min_per_goal, group_by = settings_of(cfg, a.max, a.per_day, a.min_per_goal)
    refusal = grouping_refusal(group_by)
    if refusal: print(refusal); return 1
    if group_by == "chapter":
        refusal = chapter_refusal(cands, lambda: {t.get("level") for t in ((_target(d.name).get("roadmapSpec") or {}).get("tiers") or [])})
        if refusal: print(refusal); return 1
    file_order = {c["id"]: i for i, c in enumerate(cands)}
    # 分野ごとの最低数。分野が「部位」のように意味を持つ対象では、副の信号の偏りで分野が空になりうる。無ければ掛けない
    min_per_field = cfg.get("min_per_field", {})
    # 分野の読む順。分野が「安全 → 仕組み → 部位」のように順序そのものを表す対象で使う。
    # 設定すると前提を守ったまま分野の順に並べ、到達基準 6 を最後に回す規約は使わない
    field_order = cfg.get("field_order", [])
    excl = set(cfg.get("exclude", [])); must = set(cfg.get("must_include", []))
    both = included_and_excluded(cfg)
    if both: print("must_include が exclude でも除かれている:", both); return 1
    apply_config_to_candidates(cands, cfg)
    cands = [c for c in cands if c["id"] not in excl]
    # 副の信号のキー名は対象ごとに違う（interview_count / care_count など）ので登録簿から読む。読まないと 0 として黙って無視される
    sig = (_target(d.name).get("roadmapSpec") or {}).get("secondarySignal", "interview_count")
    if not any(sig in c for c in cands):
        print(f"警告: 副の信号 {sig} を持つ候補が無い（登録簿 roadmapSpec.secondarySignal を確かめる）")
    for c in cands: c["score"] = c.get("source_count", 0) + 0.5 * c.get(sig, 0)
    linked, dropped = split_by_goals(cands)
    # 到達基準の数は対象ごとに違うので、候補が持つ到達基準の最大の番号から読む
    n_goals = max((g for c in linked for g in c["goals"]), default=6)
    linked.sort(key=lambda c: (-c["score"], c["term"]))
    chosen = select_units(linked, must, a.max, a.min_per_goal, min_per_field, n_goals)
    if len(chosen) > a.max:
        print(f"警告: 上限 {a.max} に収まらない（{len(chosen)} 件）。min_per_field の合計か must_include を見直す")
    chosen.sort(key=lambda c: (-c["score"], c["term"]))  # must_include を先頭に置いた並びを score 順に戻す（順序は前提とスコアだけで決める）
    by_id = {c["id"]: c for c in chosen}
    # 前提を前に出す（トポロジカル。前提が選外なら無視）
    ordered: list[dict] = []; seen: set[int] = set()
    def visit(c: dict, stack: tuple = ()):
        if c["id"] in seen: return
        if c["id"] in stack: return  # 循環は無視
        for p in c.get("prereq", []):
            if p in by_id: visit(by_id[p], stack + (c["id"],))
        seen.add(c["id"]); ordered.append(c)
    if group_by == "chapter":
        ordered, notes = _chapter_order(chosen, file_order, list(_target(d.name)["fields"]))
        for n in notes: print("注:", n)
    elif field_order:
        fi = {f: i for i, f in enumerate(field_order)}
        for c in sorted(chosen, key=lambda c: (fi.get(c["field"], len(fi)), -c["score"], c["term"])): visit(c)
    else:
        main_units = [c for c in chosen if 6 not in c["goals"] or len(c["goals"]) > 1]
        last_units = [c for c in chosen if c["goals"] == [6]]
        for c in main_units: visit(c)
        for c in last_units: visit(c)
    # cluster: 先頭の単位の位置に、残りを順に並べて連続させる
    for group in (cfg.get("cluster", []) if group_by == "day" else []):
        members = [by_id[t] for t in group if t in by_id]
        # 設定の列挙順を基本にし、クラスタ内の前提が後ろにある単位だけをその前提の直後へ送る（安定な並べ替え。
        # 全体を前提順に並べ替えると、設定で意図した順が崩れる）
        for _ in range(len(members)):
            moved = False
            for m in list(members):
                later = [members.index(by_id[p]) for p in m.get("prereq", []) if p in by_id and by_id[p] in members and members.index(by_id[p]) > members.index(m)]
                if later:
                    members.remove(m); members.insert(max(later), m); moved = True; break
            if not moved: break
        if len(members) < 2: continue
        rest = [m for m in ordered if m not in members]
        first = min(ordered.index(m) for m in members)
        # クラスタの外にある前提より後ろに置く（先頭の位置に寄せただけだと、後ろの単位の前提を飛び越える）
        pre_idx = [rest.index(by_id[p]) for m in members for p in m.get("prereq", []) if p in by_id and by_id[p] in rest]
        first_in_rest = len([x for x in ordered[:first] if x not in members])
        lo = max(first_in_rest, (max(pre_idx) + 1) if pre_idx else 0)
        # クラスタの外から**クラスタ内の単位を前提にしている**単位より前に置く（寄せた先で依存を追い越さない）
        mids = {m["id"] for m in members}
        dep_idx = [i for i, x in enumerate(rest) if any(p in mids for p in x.get("prereq", []))]
        hi = min(dep_idx) if dep_idx else len(rest)
        if lo > hi:
            print(f"注: クラスタ {members[0]['term']}… は前提と依存に挟まれて動かせないので元の順のまま")
            continue
        ordered = rest[:lo] + members + rest[lo:]
    # 並べ終えたら前提が前にあるかを確かめる（門は check_roadmap にもある）
    bad = prereqs_behind(ordered, by_id)
    if bad: print(f"警告: 前提が後ろにある {len(bad)} 件: " + "; ".join(f"{t} ← {p}" for t, p in bad[:5]))
    term_of = {c["id"]: c["term"] for c in ordered}
    units = []
    for i, c in enumerate(ordered, 1):
        place = {"day": math.ceil(i / a.per_day)} if group_by == "day" else {"round": c["_round"], "chapter": c["_chapter"], "tier": c["tier"]}
        units.append(unit_of(c, i, place, sig, term_of))
    tname = (_target(d.name).get("roadmapSpec") or {}).get("targetName", _target(d.name)["brand"])  # 対象名は登録簿から読む
    if group_by == "day":
        roadmap = {"target": tname, "per_day": a.per_day, "days": math.ceil(len(units) / a.per_day), "unit_count": len(units),
                   "dropped_no_goal": dropped, "units": units}
    else:
        roadmap = {"target": tname, "group_by": "chapter", "rounds": max((u["round"] for u in units), default=0), "unit_count": len(units),
                   "dropped_no_goal": dropped, "units": units}
    out.mkdir(parents=True, exist_ok=True)
    (out / "roadmap.json").write_text(json.dumps(roadmap, ensure_ascii=False, indent=2), encoding="utf-8")
    write_bundles(d, out, units, sig)
    goals = {g: sum(1 for u in units if g in u["goals"]) for g in range(1, n_goals + 1)}
    fields = {}
    for u in units: fields[u["field"]] = fields.get(u["field"], 0) + 1
    span = f"{roadmap['days']} 日" if group_by == "day" else f"{roadmap['rounds']} 章"
    if group_by == "chapter":
        for n in range(1, roadmap["rounds"] + 1):
            us = [u for u in units if u["round"] == n]
            tiers = {t: sum(1 for u in us if u["tier"] == t) for t in sorted({u["tier"] for u in us}, reverse=True)}
            print(f"  第 {n} 章 {us[0]['chapter']}（{us[0]['field']}）: {len(us)} 単位 印 {tiers}")
    print(f"単位 {len(units)} 件 / {span} / バンドル {math.ceil(len(units)/8)} 本 / 到達基準に繋がらず落とした {len(dropped)} 件")
    print("到達基準ごと:", goals); print("分野ごと:", fields)
    return 0

if __name__ == "__main__":
    sys.exit(main())
