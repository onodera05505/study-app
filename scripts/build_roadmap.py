#!/usr/bin/env python3
"""論点候補（名寄せ済み）からロードマップを組む。試作: IT コンサル就活（要件定義書 §13）。

    python3 scripts/build_roadmap.py --data data/itc [--max 40] [--per-day 3] [--out <出力先>]

入力 `roadmap_config.json`（値: max / per_day / min_per_goal / must_include / exclude / prereq_add / prereq_replace / group_by。無ければ引数の既定）と `topics_candidates.json`: {"candidates": [{"id", "term", "field", "middle", "summary", "source_count", "sources", "interview_count", "prereq": [term...], "goals": [1..到達基準の数]}]}
出力 `roadmap.json`（順序つき単位）と `material_bundles/bundle_NN.json`（8 論点ずつ）。`--out` を渡すとその下に書く（既定は --data）。

回の束ね方（`group_by`）:
- 既定 `"day"`: 学ぶ順を per_day ずつ割って日にする。各単位に `day`
- `"chapter"`: 候補の `chapter` で回（章）を作る。章の順は登録簿 fields の分野の順 → 候補ファイルでの章の初出の順、
  章の中は候補ファイルの順を骨格に前提を前に出し、印 1（★）の単位を章の末尾に置く。章の大きさは中身のまま。
  各単位に `round`（章の番号）・`chapter`（章の名前）・`tier`（印）。候補に chapter / tier が欠けていたら止める

優先信号（§13）: score = 一次資料の交差数（主）+ 0.5 × 面接で問われる頻度（副）。
順序: score 降順を骨格にし、前提（prereq）が後ろに来る場合は前提を前に出す。cluster に挙げた単位は先頭の位置に連続で並べる。到達基準（goals）に繋がらない候補は落とす。
到達基準 6（自己理解）に属する単位は最後に置く（練習として。§13）。各到達基準に最低 --min-per-goal 単位（既定 4）を確保し、選んだ単位の前提（prereq）は必ず含める。上限超過は前提として要らない低スコアから外す。
"""
from __future__ import annotations
import argparse, json, math, sys
from pathlib import Path

def chapter_order(chosen: list[dict], file_order: dict[str, int], fields: list[str]) -> tuple[list[dict], list[str]]:
    """章で束ねる並び。戻り値は (並べた単位, 注意)。単位には _round と _chapter を付ける。"""
    notes: list[str] = []
    fi = {f: i for i, f in enumerate(fields)}
    chap_field: dict[str, str] = {}; chap_first: dict[str, int] = {}
    for c in sorted(chosen, key=lambda c: file_order[c["term"]]):
        chap_field.setdefault(c["chapter"], c["field"]); chap_first.setdefault(c["chapter"], file_order[c["term"]])
        if chap_field[c["chapter"]] != c["field"]:
            notes.append(f"章『{c['chapter']}』が分野をまたぐ（{chap_field[c['chapter']]} と {c['field']}）。初出の分野に置く")
    chapters = sorted(chap_first, key=lambda ch: (fi.get(chap_field[ch], len(fi)), chap_first[ch]))
    ordered: list[dict] = []
    for n, ch in enumerate(chapters, 1):
        members = sorted((c for c in chosen if c["chapter"] == ch), key=lambda c: file_order[c["term"]])
        by_term = {c["term"]: c for c in members}
        seen: set[str] = set(); part: list[dict] = []
        def visit(c: dict, stack: tuple = ()):
            if c["term"] in seen or c["term"] in stack: return
            for p in c.get("prereq", []):
                if p in by_term: visit(by_term[p], stack + (c["term"],))
            seen.add(c["term"]); part.append(c)
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

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--max", type=int, default=40); ap.add_argument("--per-day", type=int, default=3); ap.add_argument("--min-per-goal", type=int, default=4)
    ap.add_argument("--out", default=None, help="roadmap.json と material_bundles/ の書き先（既定は --data）")
    sys.path.insert(0, str(Path(__file__).parent))
    from targets import target as _target
    a = ap.parse_args(); d = Path(a.data); out = Path(a.out) if a.out else d
    cands = json.loads((d / "topics_candidates.json").read_text(encoding="utf-8"))["candidates"]
    cfg = json.loads((d / "roadmap_config.json").read_text(encoding="utf-8")) if (d / "roadmap_config.json").exists() else {}
    a.max = cfg.get("max", a.max); a.per_day = cfg.get("per_day", a.per_day); a.min_per_goal = cfg.get("min_per_goal", a.min_per_goal)
    group_by = cfg.get("group_by", "day")
    if group_by not in ("day", "chapter"): print(f"group_by は day か chapter: {group_by}"); return 1
    if group_by == "chapter":
        lack = [c["term"] for c in cands if not c.get("chapter") or c.get("tier") is None]
        if lack: print(f"章で束ねるのに chapter か tier が無い候補 {len(lack)} 件: {lack[:5]}"); return 1
        levels = {t.get("level") for t in ((_target(d.name).get("roadmapSpec") or {}).get("tiers") or [])}
        off = [c["term"] for c in cands if c.get("tier") not in levels]
        if off: print(f"印が登録簿 roadmapSpec.tiers の段に無い候補 {len(off)} 件: {off[:5]}"); return 1
    file_order = {c["term"]: i for i, c in enumerate(cands)}
    # 分野ごとの最低数。分野が「部位」のように意味を持つ対象では、副の信号の偏りで分野が空になりうる。無ければ掛けない
    min_per_field = cfg.get("min_per_field", {})
    # 分野の読む順。分野が「安全 → 仕組み → 部位」のように順序そのものを表す対象で使う。
    # 設定すると前提を守ったまま分野の順に並べ、到達基準 6 を最後に回す規約は使わない
    field_order = cfg.get("field_order", [])
    excl = set(cfg.get("exclude", [])); must = set(cfg.get("must_include", []))
    for c in cands:
        if c["term"] in cfg.get("prereq_replace", {}): c["prereq"] = list(cfg["prereq_replace"][c["term"]])
        for pt in cfg.get("prereq_add", {}).get(c["term"], []):
            if pt not in c.setdefault("prereq", []): c["prereq"].append(pt)
    cands = [c for c in cands if c["term"] not in excl]
    missing_must = must - {c["term"] for c in cands}
    if missing_must: print("must_include が候補に無い:", missing_must); return 1
    # 副の信号のキー名は対象ごとに違う（interview_count / care_count など）ので登録簿から読む。読まないと 0 として黙って無視される
    sig = (_target(d.name).get("roadmapSpec") or {}).get("secondarySignal", "interview_count")
    if not any(sig in c for c in cands):
        print(f"警告: 副の信号 {sig} を持つ候補が無い（登録簿 roadmapSpec.secondarySignal を確かめる）")
    for c in cands: c["score"] = c.get("source_count", 0) + 0.5 * c.get(sig, 0)
    linked = [c for c in cands if c.get("goals")]
    # 到達基準の数は対象ごとに違うので、候補が持つ到達基準の最大の番号から読む
    n_goals = max((g for c in linked for g in c["goals"]), default=6)
    dropped = [c["term"] for c in cands if not c.get("goals")]
    linked.sort(key=lambda c: (-c["score"], c["term"]))
    chosen = [c for c in linked if c["term"] in must] + [c for c in linked if c["term"] not in must][: max(0, a.max - len(must))]
    all_by_term = {c["term"]: c for c in linked}
    def ensure_goals():
        for g in range(1, n_goals + 1):
            for c in linked:
                if len([x for x in chosen if g in x["goals"]]) >= a.min_per_goal: break
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
                for pt in c.get("prereq", []):
                    if pt in all_by_term and all_by_term[pt] not in chosen:
                        chosen.append(all_by_term[pt]); changed = True
    def needed_by_others(c):
        return any(c["term"] in x.get("prereq", []) for x in chosen if x is not c)
    def trim():
        # 上限に収める: 前提として要らず、到達基準の最低数を割らない単位を、score の低い順に外す
        while len(chosen) > a.max:
            removable = [c for c in sorted(chosen, key=lambda c: (c["score"], c["term"]))
                         if c["term"] not in must and not needed_by_others(c)
                         and all(len([x for x in chosen if g in x["goals"]]) - 1 >= a.min_per_goal for g in c["goals"])
                         and len([x for x in chosen if x["field"] == c["field"]]) - 1 >= min_per_field.get(c["field"], 0)]
            if not removable: break
            chosen.remove(removable[0])
    # trim の後に前提を補うと上限を超え直すので、変わらなくなるまで回す（min_per_field の合計は max より小さくしておく）
    ensure_goals(); ensure_fields(); ensure_prereqs()
    for _ in range(10):
        before = len(chosen); trim(); ensure_prereqs()
        if len(chosen) <= a.max or len(chosen) == before: break
    if len(chosen) > a.max:
        print(f"警告: 上限 {a.max} に収まらない（{len(chosen)} 件）。min_per_field の合計か must_include を見直す")
    chosen.sort(key=lambda c: (-c["score"], c["term"]))  # must_include を先頭に置いた並びを score 順に戻す（順序は前提とスコアだけで決める）
    by_term = {c["term"]: c for c in chosen}
    # 前提を前に出す（トポロジカル。前提が選外なら無視）
    ordered: list[dict] = []; seen: set[str] = set()
    def visit(c: dict, stack: tuple = ()):
        if c["term"] in seen: return
        if c["term"] in stack: return  # 循環は無視
        for p in c.get("prereq", []):
            if p in by_term: visit(by_term[p], stack + (c["term"],))
        seen.add(c["term"]); ordered.append(c)
    if group_by == "chapter":
        ordered, notes = chapter_order(chosen, file_order, list(_target(d.name)["fields"]))
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
        members = [by_term[t] for t in group if t in by_term]
        # 設定の列挙順を基本にし、クラスタ内の前提が後ろにある単位だけをその前提の直後へ送る（安定な並べ替え。
        # 全体を前提順に並べ替えると、設定で意図した順が崩れる）
        for _ in range(len(members)):
            moved = False
            for m in list(members):
                later = [members.index(by_term[p]) for p in m.get("prereq", []) if p in by_term and by_term[p] in members and members.index(by_term[p]) > members.index(m)]
                if later:
                    members.remove(m); members.insert(max(later), m); moved = True; break
            if not moved: break
        if len(members) < 2: continue
        rest = [m for m in ordered if m not in members]
        first = min(ordered.index(m) for m in members)
        # クラスタの外にある前提より後ろに置く（先頭の位置に寄せただけだと、後ろの単位の前提を飛び越える）
        pre_idx = [rest.index(by_term[p]) for m in members for p in m.get("prereq", []) if p in by_term and by_term[p] in rest]
        first_in_rest = len([x for x in ordered[:first] if x not in members])
        lo = max(first_in_rest, (max(pre_idx) + 1) if pre_idx else 0)
        # クラスタの外から**クラスタ内の単位を前提にしている**単位より前に置く（寄せた先で依存を追い越さない）
        mterms = {m["term"] for m in members}
        dep_idx = [i for i, x in enumerate(rest) if any(p in mterms for p in x.get("prereq", []))]
        hi = min(dep_idx) if dep_idx else len(rest)
        if lo > hi:
            print(f"注: クラスタ {group[0]}… は前提と依存に挟まれて動かせないので元の順のまま")
            continue
        ordered = rest[:lo] + members + rest[lo:]
    # 並べ終えたら前提が前にあるかを確かめる（門は check_roadmap にもある）
    pos_of = {c["term"]: i for i, c in enumerate(ordered)}
    bad = [(c["term"], p) for c in ordered for p in c.get("prereq", []) if p in pos_of and pos_of[p] > pos_of[c["term"]]]
    if bad: print(f"警告: 前提が後ろにある {len(bad)} 件: " + "; ".join(f"{t} ← {p}" for t, p in bad[:5]))
    for c in ordered:
        if c["term"] in cfg.get("summary_override", {}): c["summary"] = cfg["summary_override"][c["term"]]
    units = []
    for i, c in enumerate(ordered, 1):
        place = {"day": math.ceil(i / a.per_day)} if group_by == "day" else {"round": c["_round"], "chapter": c["_chapter"], "tier": c["tier"]}
        units.append({"order": i, **place, "topic_id": c["id"], "term": c["term"], "field": c["field"], "middle": c.get("middle", ""),
                      "summary": c.get("summary", ""), "score": c["score"], "source_count": c.get("source_count", 0), sig: c.get(sig, 0),
                      "prereq": c.get("prereq", []), "goals": c["goals"], "sources": c.get("sources", [])})
    tname = (_target(d.name).get("roadmapSpec") or {}).get("targetName", _target(d.name)["brand"])  # 対象名は登録簿から読む
    if group_by == "day":
        roadmap = {"target": tname, "per_day": a.per_day, "days": math.ceil(len(units) / a.per_day), "unit_count": len(units),
                   "dropped_no_goal": dropped, "units": units}
    else:
        roadmap = {"target": tname, "group_by": "chapter", "rounds": max((u["round"] for u in units), default=0), "unit_count": len(units),
                   "dropped_no_goal": dropped, "units": units}
    out.mkdir(parents=True, exist_ok=True)
    (out / "roadmap.json").write_text(json.dumps(roadmap, ensure_ascii=False, indent=2), encoding="utf-8")
    bdir = out / "material_bundles"; bdir.mkdir(exist_ok=True)
    if any((d / "materials").glob("bundle_*.json")):
        # 教材が書かれた後は割り当て（執筆用バンドル）を作り直さない。並びが変わると materials/bundle_NN と組がずれ、
        # 門 check_roadmap_bundle が落ちる。単位の追加は手で追加バンドルを作る
        print("注: materials/ が既にあるので material_bundles/ は作り直さない（順序の変更は roadmap.json だけに反映）")
    else:
      for p in bdir.glob("bundle_[0-9][0-9].json"): p.unlink()  # 連番のバンドルだけ作り直す。手で作った追加バンドル（bundle_c2_new_a 等）は消さない（担当が読んでいる入力を消さない）
      for n, i in enumerate(range(0, len(units), 8), 1):
        chunk = units[i:i + 8]
        (bdir / f"bundle_{n:02d}.json").write_text(json.dumps({"bundle": f"bundle_{n:02d}", "topics": [
            # 副の信号のキーは対象ごとに違う（interview_count / care_count / life_count / syllabus_weight）ので sig で写す
            {k: u[k] for k in ("topic_id", "term", "field", "middle", "summary", "goals", "prereq", "sources", "source_count", sig)} for u in chunk]},
            ensure_ascii=False, indent=2), encoding="utf-8")
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
