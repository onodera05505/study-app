#!/usr/bin/env python3
"""資格対策の学びの 1 単元を、利用者が画面で見るのと同じ並び・本文・用語・図の見え方の単元の読み物にする。

    python3 scripts/build_unit_reading.py --data data/ip --unit 21 --out ../unit_readings/ip_21

契約は docs/goals/GOAL-12-measure-with-learner-role/UC-028-read-cert-unit-with-learner-role/contract.yaml の
buildUnitReading。標準出力に結果の JSON を 1 つ出す（成功 0、errors に当たれば 1）。
出力先の中: reading.md（単元の読み物）・figures/（図の画像を PNG に描いた物。元の置き場のサブパスを保ち拡張子だけ .png）。
data・out はコマンドを呼んだ作業ディレクトリからのパス。置き場の根は data の 2 段上で、図の画像は根の public/ の下にある。
項目の番号ごとの論点の ID・名前・選んだ教材の世代は標準出力の items だけに出し、単元の読み物には出さない。
"""
from __future__ import annotations
import json
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from tool_refusal import CODE  # noqa: E402
from material_generations import is_rewritten, select_materials  # noqa: E402
from learning_parts import materials_of  # noqa: E402
from learner_io import place_root, read_json  # noqa: E402
from learner_eval import Refused, contract_args, remove_created_dirs, run  # noqa: E402
from build_learner_pack import (RENDER_TIMEOUT_SECONDS, check_out, delivered_bodies,  # noqa: E402
                                render_svgs, well_formed, _missing_ancestors)
from material_figure_line import figure_srcs, malformed_lines, map_figure_lines, png_target  # noqa: E402
from attach_material_figures import insert_after_heading, insert_at_section_end  # noqa: E402
from build_seed import TERM_REF, build_glossary, read_explanations  # noqa: E402
from check_unit_plans import LEARNING_FILES, Refused as GateRefused, gate_findings, read_syllabus_units  # noqa: E402
from targets import targets  # noqa: E402

# 契約の buildUnitReading の request の data・unit の形
DATA_ARG = re.compile(r"^(tests/fixtures/unit-reading/[a-z0-9-]+/)?data/[a-z]+$")
UNIT_ARG = re.compile(r"^[0-9]{2}$")
READING = "reading.md"
# 押すと説明が出る語の印（契約の writeUnitReading の body）
TERM_MARK = "※"
# 出題回数の印の段の境目の正本（BR-051）。値はこのファイルの FREQUENCY_TIER_FLOORS から読む
TIER_SOURCE = HERE.parent / "src" / "server" / "lib" / "frequency-tier.ts"

NOTES = [
    "## 読み方の注意",
    "",
    f"- 語の直後の {TERM_MARK} は、アプリの画面では押すとその語の短い説明が出る語の印です。この読み物では説明は出ません。",
    "- ★ は出題回数の印です。★ は 1 回、★★ は 2 回、★★★ は 3 回以上出題された項目です。",
    "- 「前提の論点」は、その項目より先に読んでおくとよい論点の名前です。",
    "- 図は、本文の中の画面と同じ位置に画像で置いてあります。画像のすぐ下の「図の説明:」の行が、その図の説明文です。",
]


def _is_pos(v) -> bool:
    return type(v) is int and v >= 1


def _text(v) -> bool:
    return isinstance(v, str) and v != ""


# @implements BR-051
def frequency_floors() -> list[int]:
    """BR-051 の段の境目（配列の i 番目が段 i+1 の出題頻度の下限）。"""
    mo = re.search(r"FREQUENCY_TIER_FLOORS\s*=\s*\[([0-9,\s]+)\]", TIER_SOURCE.read_text(encoding="utf-8"))
    return [int(x) for x in mo.group(1).split(",") if x.strip()]


# @implements REQ-495, BR-051
def frequency_line(count: int, floors: list[int]) -> str:
    """論点の頭に置く出題頻度と出題回数の印。出題頻度が 0 の論点は印を持たない。"""
    tier = sum(1 for f in floors if count >= f)
    return f"出題 {count} 回" + (f" {'★' * tier}" if tier else "")


# @implements REQ-497
def short_term(term: str) -> str:
    """末尾の括弧書きを落とした表記（src/client/components/TermPop.tsx の shortTerm と同じ読み方）。"""
    mo = re.match(r"^(.+?)\s*[（(].*[）)]$", term)
    return mo.group(1) if mo else term


# @implements REQ-497
def terms_keeping_paren(glossary: set[str]) -> set[str]:
    """括弧書きを落とすと用語集の他の語の用語か、他の語を短くした表記と同じになる語（TermPop.tsx の termsKeepingParen と同じ）。"""
    by_short: dict[str, list[str]] = {}
    for t in glossary:
        by_short.setdefault(short_term(t), []).append(t)
    return {t for group in by_short.values() if len(group) > 1 for t in group if short_term(t) != t}


# @implements REQ-497
def mark_terms(text: str, glossary: set[str], keep: set[str]) -> str:
    """用語の記法の語を、用語集にあれば表示名に印を添えて、無ければ書かれた文字のまま置く。"""
    def rep(mo: re.Match) -> str:
        term = mo.group(1)
        if term not in glossary:
            return term
        return (term if term in keep else short_term(term)) + TERM_MARK
    return TERM_REF.sub(rep, text)


# @implements REQ-501
def read_args():
    """引数を契約の request の形で読む。形の外の引数があれば、何も読み書きする前にその名前をすべて挙げて断る。"""
    return contract_args("build_unit_reading.py",
                         {"data": DATA_ARG.fullmatch, "unit": UNIT_ARG.fullmatch, "out": "text"}, ("data", "unit", "out"))


# @implements REQ-502, REQ-579
# @operation UC-028#readReadingRegistry
def read_reading_registry(*, key: str) -> dict:
    """登録簿の 1 つの学びがロードマップ型か（契約の readReadingRegistry）。登録簿に無ければ NOT_FOUND の失敗を渡す。"""
    t = targets().get(key)
    if t is None:
        raise Refused(CODE.NOT_FOUND, "登録簿に無い学び")
    return {"roadmap": t.get("roadmap") is True}


# @implements REQ-502, BR-004
def qualification_key(data: str) -> str:
    """登録簿にあり、ロードマップ型でない学びだけを通し、学びの key を返す。"""
    key = Path(data).name
    try:
        r = read_reading_registry(key=key)
    except Refused as e:
        if e.code != CODE.NOT_FOUND:
            raise
        raise Refused(CODE.INVALID_INPUT, "登録簿に無い学び")
    if r["roadmap"]:
        raise Refused(CODE.INVALID_INPUT, "ロードマップ型の学び")
    return key


# @implements REQ-510
def check_destination(out: Path, d: Path) -> None:
    """出力先が学びの置き場（置き場の根の data/ の下全体）の外で、無いか空の場所であることを確かめる。"""
    check_out(out, d)


def _plan_path(d: Path, unit: str) -> Path:
    return d / "unit_plans" / f"{unit}.json"


# @implements REQ-503
def check_unit(d: Path, unit: str) -> None:
    """単元が学びのシラバスにあり、単元の構成のファイルを持つことを確かめる。
    シラバスが無いか読めないときは、単元が学びにあるかを決められないので単元の構成のファイルの有無だけを見る
    （シラバスが読めないことは単元の構成の門が止める理由として挙げる）。"""
    sp = d / LEARNING_FILES[0]
    try:
        in_learning = int(unit) in {it["middle_no"] for it in read_syllabus_units(path=str(sp))["items"]}
    except GateRefused:
        in_learning = True
    if not in_learning or not _plan_path(d, unit).is_file():
        raise Refused(CODE.NOT_FOUND, "単元が無いか、単元の構成を持たない", unit=unit)


def _plan_ok(p) -> bool:
    if not (isinstance(p, dict) and _text(p.get("overview")) and isinstance(p.get("groups"), list) and p["groups"]):
        return False
    for g in p["groups"]:
        if not (isinstance(g, dict) and _text(g.get("name")) and _text(g.get("description"))
                and isinstance(g.get("topics"), list) and g["topics"] and all(_is_pos(t) for t in g["topics"])):
            return False
    pres = p.get("prerequisites", {})
    return isinstance(pres, dict) and all(isinstance(v, list) and all(_is_pos(x) for x in v) for v in pres.values())


def _topics_ok(raw) -> bool:
    ts = raw.get("topics") if isinstance(raw, dict) else None
    return isinstance(ts, list) and all(
        isinstance(t, dict) and _is_pos(t.get("id")) and _text(t.get("term"))
        and type(t.get("question_count")) is int and t["question_count"] >= 0 for t in ts)


def _spec_ok(raw) -> bool:
    figs = raw.get("figures") if isinstance(raw, dict) else None
    return isinstance(figs, list) and all(
        isinstance(f, dict) and _is_pos(f.get("id")) and _text(f.get("after")) and _text(f.get("caption")) for f in figs)


def _explanations_ok(raw) -> bool:
    es = raw.get("explanations", []) if isinstance(raw, dict) else None
    return isinstance(es, list) and all(
        isinstance(e, dict) and isinstance(e.get("choices", []), list) and all(isinstance(c, dict) for c in e.get("choices", []))
        for e in es)


def _read_checked(p: Path, ok, bad: list[str]):
    """p を JSON として読み、ok が形を認めれば中身を、認めなければ bad に p を足して None を返す。"""
    try:
        raw = read_json(p)
    except (OSError, ValueError):
        bad.append(p.as_posix())
        return None
    if not ok(raw):
        bad.append(p.as_posix())
        return None
    return raw


def _glossary_sources(d: Path) -> list[tuple[Path, object]]:
    """投入が用語集を組み立てるときに読む、論点の一覧と教材の世代以外のファイルと、その形の確かめ方。"""
    files = [(p, _explanations_ok) for p in sorted((d / "question_explanations").glob("*.json"))]
    for name in ("glossary_overrides.json", "topic_aliases.json"):
        if (d / name).exists():
            files.append((d / name, lambda raw: isinstance(raw, dict)))
    return files


def _unreadable_glossary_sources(d: Path) -> list[str]:
    """用語集の元（論点の一覧と教材の世代のほか）のうち、形として読めないファイル。"""
    bad: list[str] = []
    for p, ok in _glossary_sources(d):
        _read_checked(p, ok, bad)
    return bad


# @implements REQ-507, REQ-579
# @operation UC-028#readReadingUnitPlan
def read_reading_unit_plan(*, data: str, unit: str) -> dict:
    """1 単元の単元の構成（契約の readReadingUnitPlan。前提が無ければ空として持つ）。ファイルが無ければ NOT_FOUND、
    単元の構成として読めなければ INVALID_INPUT の失敗を渡す。失敗の unreadable はそのファイル。"""
    p = _plan_path(Path(data), unit)
    if not p.exists():
        raise Refused(CODE.NOT_FOUND, "単元の構成のファイルが無い", unreadable=[p.as_posix()])
    bad: list[str] = []
    plan = _read_checked(p, _plan_ok, bad)
    if plan is None:
        raise Refused(CODE.INVALID_INPUT, "単元の構成として読めない", unreadable=bad)
    return {**plan, "prerequisites": plan.get("prerequisites", {})}


# @implements REQ-507, REQ-579
# @operation UC-028#readReadingTopics
def read_reading_topics(*, data: str) -> dict:
    """論点の一覧（契約の readReadingTopics）。無いか論点の一覧として読めなければ INVALID_INPUT の失敗を渡す。"""
    bad: list[str] = []
    raw = _read_checked(Path(data) / "topics.json", _topics_ok, bad)
    if raw is None:
        raise Refused(CODE.INVALID_INPUT, "論点の一覧として読めない", unreadable=bad)
    return {"topics": raw["topics"]}


# @implements REQ-507, REQ-579
# @operation UC-028#readReadingFigureSpec
def read_reading_figure_spec(*, data: str, topic_id: int) -> dict:
    """1 論点の図の仕様の図（契約の readReadingFigureSpec）。図の仕様の無い論点は空。
    図の仕様として読めなければ INVALID_INPUT の失敗を渡す。失敗の unreadable はそのファイル。"""
    sp = Path(data) / "material_figures" / f"{topic_id}.json"
    if not sp.exists():
        return {"figures": []}
    bad: list[str] = []
    raw = _read_checked(sp, _spec_ok, bad)
    if raw is None:
        raise Refused(CODE.INVALID_INPUT, "図の仕様として読めない", unreadable=bad)
    return {"figures": raw["figures"]}


# @implements REQ-507
def read_sources(d: Path, unit: str) -> tuple[dict, list[dict]]:
    """教材の世代・単元の構成・論点の一覧・用語集の元・単元の論点の図の仕様を、契約の形として読めるか確かめて読む。
    読めないファイルが 1 つでもあれば、読めないファイルをすべて挙げて止める。返すのは (単元の構成, 論点の一覧)。"""
    data = str(d)
    bad: list[str] = []
    found: dict[str, dict] = {}
    reads = (("bodies", lambda: read_reading_delivered_body(data=data)),
             ("plan", lambda: read_reading_unit_plan(data=data, unit=unit)),
             ("topics", lambda: read_reading_topics(data=data)))
    for name, read in reads:
        try:
            found[name] = read()
        except Refused as e:
            bad.extend(e.detail.get("unreadable", []))
    bad.extend(_unreadable_glossary_sources(d))
    plan = found.get("plan")
    if plan is not None:
        for tid in [t for g in plan["groups"] for t in g["topics"]]:
            try:
                read_reading_figure_spec(data=data, topic_id=tid)
            except Refused as e:
                bad.extend(e.detail.get("unreadable", []))
    if bad:
        raise Refused(CODE.INVALID_INPUT, "読むファイルが契約の形として読めない", unreadable=bad)
    return plan, found["topics"]["topics"]


# @implements REQ-504, BR-048
def check_gate(d: Path, unit: str) -> None:
    """学びの全部の単元の構成と合わせて単元の構成の門にかけ、指定した単元の構成に関わる止める理由があれば挙げて止める。"""
    try:
        _, _, stops = gate_findings(d)
    except GateRefused as e:
        raise Refused(CODE.INVALID_INPUT, "単元の構成が門の止める理由に当たる", unit=unit, gateReasons=[e.reason])
    mine = [s["reason"] for s in stops if f"{unit}.json" in s.get("_files", [])]
    if mine:
        raise Refused(CODE.INVALID_INPUT, "単元の構成が門の止める理由に当たる", unit=unit, gateReasons=mine)


# @implements REQ-506, REQ-579
# @operation UC-028#readReadingDeliveredBody
def read_reading_delivered_body(*, data: str) -> dict:
    """配る本文（契約の readReadingDeliveredBody）。投入と同じ選び方で論点ごとに教材の世代から選んだ本文のうち、
    説明と詳しい解説の両方を持つ物を、選んだ世代と共に論点の番号の順に並べる。
    教材の世代のファイルが読めなければ INVALID_INPUT の失敗を渡す（unreadable は読めないファイルのすべて）。"""
    d = Path(data)
    bodies = delivered_bodies(d, [])
    chosen = select_materials(d)
    return {"materials": [{"topic_id": tid, "explanation": m["explanation"], "detail": m["detail"],
                           "generation": chosen[tid].generation} for tid, m in sorted(bodies.items())]}


# @implements REQ-506
def unit_bodies(d: Path, order: list[int]) -> dict[int, dict]:
    """投入と同じ選び方で選んだ配る本文（論点 → 説明・詳しい解説・選んだ世代）。単元の論点のうちどの世代からも選べない
    論点があれば挙げて止める。"""
    bodies = {m["topic_id"]: m for m in read_reading_delivered_body(data=str(d))["materials"]}
    missing = [t for t in order if t not in bodies]
    if missing:
        raise Refused(CODE.NOT_FOUND, "配る本文の無い論点がある", topics=missing)
    return bodies


# @implements REQ-505
def unit_generations(bodies: dict[int, dict], order: list[int]) -> dict[int, str]:
    """論点 → 配る本文を選んだ教材の世代。書き直した世代から選ぶ論点と前の世代から選ぶ論点が混ざれば、
    書き直した世代から選ばれない論点を挙げて止める。"""
    gens = {t: bodies[t]["generation"] for t in order}
    rewritten = [t for t in order if is_rewritten(gens[t])]
    if rewritten and len(rewritten) < len(order):
        raise Refused(CODE.CONFLICT, "書き直した世代と前の世代が単元の中で混ざる",
                      topics=[t for t in order if not is_rewritten(gens[t])])
    return gens


# @implements REQ-512
def check_figure_lines(order: list[int], bodies: dict[int, dict]) -> None:
    """単元の論点の配る本文に図の置き場を指すのに図の行の形に合わない行があれば、学ぶ順に、その論点と書かれたままの行を挙げて止める。"""
    hit = [{"topic_id": t, "line": l} for t in order
           for l in malformed_lines(bodies[t]["explanation"] + "\n" + bodies[t]["detail"])]
    if hit:
        raise Refused(CODE.INVALID_INPUT, "図の置き場を指すのに図の行の形に合わない行がある", lines=hit)


# @implements REQ-498
def reading_figure(png: str, caption: str) -> str:
    """読み物の図。出力先の中の PNG を指す説明文の無い画像と、その直下に 1 回だけ置く図の説明文。"""
    return f"\n\n![]({png})\n\n図の説明: {caption}\n\n"


# @implements REQ-508, REQ-579
# @operation UC-028#readReadingFigure
def read_reading_figure(*, src: str, root: str | None = None) -> dict:
    """図の参照先 /figures/materials/<key>/<サブパス> が指す画像（契約の readReadingFigure）。画像は置き場の根（root。
    無ければ作業ディレクトリ）の public の下の src と同じパスにあり、そのパスを file で返す。無ければ NOT_FOUND の失敗を渡す。"""
    f = Path(root if root is not None else ".") / "public" / src.lstrip("/")
    if not f.is_file():
        raise Refused(CODE.NOT_FOUND, "画像が置き場所に無い")
    return {"file": f.as_posix()}


# @implements REQ-496, REQ-508, BR-026
def place_figures(d: Path, root: Path, key: str, order: list[int], bodies: dict[int, dict],
                  gens: dict[int, str]) -> tuple[dict[int, tuple[str, str]], list[dict]]:
    """論点ごとに図を読み物の形で置いた (説明, 詳しい解説) と、読み物の順の図の {topic_id, ref, target}。
    配る本文が図の行を持つ論点はその行の位置のまま、持たない論点は図の仕様の図を図の仕様に並ぶ順に入れる。
    書き直した世代から選んだ論点は図の差し込みと同じ位置（after が explanation なら説明の末尾、
    見出しならその見出しの節の末尾＝次の見出しの行の直前、後に見出しが無ければ詳しい解説の末尾）、
    前の世代から選んだ論点は after が explanation なら説明の末尾、見出しならその見出しの行の直後。
    画像が置き場に無い図と、差し込み位置の見出しが本文に無い図を、すべて挙げて止める。"""
    placed: dict[int, tuple[str, str]] = {}
    refs: list[dict] = []
    missing: list[dict] = []
    for tid in order:
        ex, det = bodies[tid]["explanation"], bodies[tid]["detail"]
        into_heading = insert_at_section_end if is_rewritten(gens[tid]) else insert_after_heading
        lined = figure_srcs(ex + "\n" + det)
        mine = [{"topic_id": tid, "ref": ref, "target": png_target(ref)} for ref in lined]
        ex = map_figure_lines(ex, lambda f: reading_figure(png_target(f.src), f.caption))
        det = map_figure_lines(det, lambda f: reading_figure(png_target(f.src), f.caption))
        if not lined:
            for fig in read_reading_figure_spec(data=str(d), topic_id=tid)["figures"]:
                ref = f"/figures/materials/{key}/{tid}-{fig['id']}.svg"
                block = reading_figure(png_target(ref), fig["caption"])
                if fig["after"] == "explanation":
                    ex = ex.rstrip("\n") + block
                else:
                    try:
                        det = into_heading(det, fig["after"], block)
                    except KeyError:
                        missing.append({"topic_id": tid, "ref": ref, "cause": "headingMissing"})
                        continue
                mine.append({"topic_id": tid, "ref": ref, "target": png_target(ref)})
        # 図は読み物に現れる順に並べる（差し込んだ図と図の行のどちらも本文の中の位置で）
        text = ex + "\n" + det
        mine.sort(key=lambda r: text.find(f"![]({r['target']})"))
        for r in mine:
            try:
                read_reading_figure(src=r["ref"], root=root.as_posix())
            except Refused as e:
                if e.code != CODE.NOT_FOUND:
                    raise
                missing.append({"topic_id": tid, "ref": r["ref"], "cause": "imageMissing"})
        refs += mine
        placed[tid] = (ex, det)
    if missing:
        raise Refused(CODE.NOT_FOUND, "図の画像か差し込み位置の見出しが無い", figures=missing)
    return placed, refs


# @implements REQ-509
def figure_targets(refs: list[dict]) -> dict[str, str]:
    """出力先の中の PNG のパス → 図の参照先。別の図が同じ PNG の名前になるときは、どれも描かずに挙げて止める。"""
    by_target: dict[str, set[str]] = {}
    for r in refs:
        by_target.setdefault(r["target"], set()).add(r["ref"])
    clash = {t for t, s in by_target.items() if len(s) > 1}
    if clash:
        raise Refused(CODE.INVALID_INPUT, "同じ PNG の名前になる図が 2 つ以上ある",
                      figures=[{"topic_id": r["topic_id"], "ref": r["ref"]} for r in refs if r["target"] in clash])
    return {t: next(iter(s)) for t, s in by_target.items()}


# @implements REQ-498, REQ-500
def _draw(work: Path, files: dict[str, Path], timeout: int) -> set[str]:
    """出力先の中の PNG のパス → 図の画像を、work の下のそのパスに PNG で置き、描けなかった物の PNG のパスを返す。
    元が PNG の図は写し、SVG は図の中の script を走らせず図のファイルの外の資源を取りに行かない描き手
    （scripts/render_svg_png.mjs）で、描き手を 1 回だけ起こしてまとめて描く（1 つの図の待ち時間の上限は timeout 秒）。
    XML として整わない図は描き手に渡さず、描けなかった物に入れる。"""
    jobs = []
    for target, src in files.items():
        (work / target).parent.mkdir(parents=True, exist_ok=True)
        if src.suffix == ".png":
            shutil.copyfile(src, work / target)
        else:
            jobs.append({"src": str(src.resolve()), "dst": str((work / target).resolve()), "target": target})
    failed = {j["target"] for j in jobs if not well_formed(Path(j["src"]))}
    drawable = [j for j in jobs if j["target"] not in failed]
    if drawable:
        failed |= render_svgs(drawable, timeout)
    return failed


# @implements REQ-498, REQ-500, REQ-579
# @operation UC-028#writeReadingFigure
def write_reading_figure(*, out: str, src: str, renderTimeoutSeconds: int, root: str | None = None) -> dict:
    """図 1 つを PNG に描いて出力先の figures/ の下に置く（契約の writeReadingFigure）。置く先は src の学びの key の段より下の
    サブパスと名前を保ち拡張子だけ .png にしたパス。画像が無いか、XML として整わないか、待ち時間の上限のうちに描けなければ
    INTERNAL の失敗を渡す。"""
    target = png_target(src)
    try:
        file = Path(read_reading_figure(src=src, root=root)["file"])
    except Refused as e:
        if e.code != CODE.NOT_FOUND:
            raise
        raise Refused(CODE.INTERNAL, "図を PNG に描けない（画像が置き場所に無い）", figures=[{"ref": src}])
    if _draw(Path(out), {target: file}, renderTimeoutSeconds):
        raise Refused(CODE.INTERNAL, "図を PNG に描けない", figures=[{"ref": src}])
    return {"path": target}


# @implements REQ-498, REQ-500, REQ-509
def draw_figures(work: Path, root: Path, targets: dict[str, str], refs: list[dict]) -> None:
    """図を PNG にして work の下の出力先と同じパスに置く。図 1 つの書き出し（write_reading_figure）と同じ _draw で、
    描き手を 1 回だけ起こしてまとめて描く。描けない図があれば、その論点と図を挙げて止める。"""
    files = {target: Path(read_reading_figure(src=ref, root=root.as_posix())["file"]) for target, ref in targets.items()}
    failed = _draw(work, files, RENDER_TIMEOUT_SECONDS)
    if failed:
        raise Refused(CODE.INTERNAL, "図を PNG に描けない",
                      figures=[{"topic_id": r["topic_id"], "ref": r["ref"]} for r in _unique_refs(refs) if r["target"] in failed])


def _unique_refs(refs: list[dict]) -> list[dict]:
    """同じ論点の同じ図を 1 つにした、読み物の順の図。"""
    seen, out = set(), []
    for r in refs:
        k = (r["topic_id"], r["ref"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


# @implements REQ-498
def tidy(text: str) -> str:
    """図を置いた本文の、図の前後に重なった空行を 1 つにまとめる。"""
    return re.sub(r"\n{3,}", "\n\n", text).strip("\n")


# @implements REQ-494, REQ-495, REQ-496, REQ-499
def compose(plan: dict, topics: dict[int, dict], placed: dict[int, tuple[str, str]], glossary: set[str]) -> str:
    """単元の読み物の全文。冒頭に読み方の注意と全体像を 1 回ずつ、まとまりごとに名前と説明を 1 回ずつ置いてから
    その論点を項目の番号つきで置く。論点の ID・教材の世代・過去問・正解・問題解説は置かない。"""
    floors = frequency_floors()
    keep = terms_keeping_paren(glossary)
    pres = plan.get("prerequisites") or {}
    n = sum(len(g["topics"]) for g in plan["groups"])
    lines = [f"# {plan.get('unit', '')}（{n} 項目）", "", *NOTES, "", "## 単元の全体像", "", plan["overview"], ""]
    no = 0
    for gi, g in enumerate(plan["groups"], start=1):
        lines += [f"# まとまり {gi}: {g['name']}", "", g["description"], ""]
        for tid in g["topics"]:
            no += 1
            t = topics[tid]
            lines += [f"## {no}. {t['term']}", "", frequency_line(t["question_count"], floors), ""]
            before = [topics[p]["term"] for p in pres.get(str(tid), []) if p in topics]
            if before:
                lines += ["前提の論点: " + "、".join(before), ""]
            ex, det = placed[tid]
            lines += [mark_terms(tidy(ex), glossary, keep), "",
                      mark_terms(tidy(det), glossary, keep), ""]
    return "\n".join(lines).rstrip("\n") + "\n"


# @implements REQ-497, REQ-579
# @operation UC-028#readReadingGlossary
def read_reading_glossary(*, data: str) -> dict:
    """投入が組み立てるのと同じ用語集の正式な表記（契約の readReadingGlossary）。用語集の元（問題解説・表記の上書き・
    別名・論点の一覧・教材の世代）のファイルが読めなければ INVALID_INPUT の失敗を渡す。"""
    d = Path(data)
    bad = _unreadable_glossary_sources(d)
    if bad:
        raise Refused(CODE.INVALID_INPUT, "用語集の元のファイルが読めない", unreadable=bad)
    topics = read_reading_topics(data=data)["topics"]
    try:
        chosen = select_materials(d)
    except (OSError, ValueError, AttributeError, KeyError, TypeError):
        raise Refused(CODE.INVALID_INPUT, "用語集の元の教材の世代のファイルが読めない")
    explanations, _ = read_explanations(d)
    gl, _ = build_glossary(d, explanations, materials_of(chosen), topics)
    return {"terms": sorted(gl)}


def _natural(s: str) -> list:
    return [int(x) if x.isdigit() else x for x in re.split(r"([0-9]+)", s)]


# @implements REQ-498
def figure_list(order: list[int], refs: list[dict]) -> list[str]:
    """作り手に返す図の PNG。項目の番号の順に、同じ項目の中は PNG の名前の順（数は数として比べる）に 1 回ずつ並べる。"""
    pos = {t: i for i, t in enumerate(order)}
    first: dict[str, int] = {}
    for r in refs:
        first.setdefault(r["target"], pos[r["topic_id"]])
    return sorted(first, key=lambda t: (first[t], _natural(t)))


# @implements REQ-494, REQ-579
# @operation UC-028#writeUnitReading
def write_unit_reading(*, out: str, body: str) -> dict:
    """単元の読み物の全文を出力先の reading.md に書く（契約の writeUnitReading。出力先が無ければ作る）。"""
    o = Path(out)
    o.mkdir(parents=True, exist_ok=True)
    (o / READING).write_text(body, encoding="utf-8")
    return {"path": READING}


# @implements REQ-511
def publish(work: Path, out: Path, body: str) -> None:
    """単元の読み物を図を描き終えた一時の場所に書き、その場所を出力先に付け替える。付け替えは出力先が無いか空のときだけ通るので、
    同じ出力先に同時に作る呼び出しのうち書けるのは 1 つだけで、ほかの呼び出しは書かれた物を書き換えない。"""
    write_unit_reading(out=str(work), body=body)
    try:
        os.rename(work, out)
    except OSError:
        raise Refused(CODE.CONFLICT, "作る間に同じ出力先に書かれた")


# @implements UC-028, REQ-509, REQ-511
# @operation UC-028#buildUnitReading
def main() -> dict:
    a = read_args()
    key = qualification_key(a.data)
    d = Path(a.data)
    out = Path(a.out)
    check_destination(out, d)
    check_unit(d, a.unit)
    plan, topic_rows = read_sources(d, a.unit)
    check_gate(d, a.unit)
    order = [t for g in plan["groups"] for t in g["topics"]]
    bodies = unit_bodies(d, order)
    gens = unit_generations(bodies, order)
    check_figure_lines(order, bodies)
    root = place_root(d)
    placed, refs = place_figures(d, root, key, order, bodies, gens)
    targets = figure_targets(refs)
    topics = {t["id"]: t for t in topic_rows}
    body = compose(plan, topics, placed, set(read_reading_glossary(data=a.data)["terms"]))

    created = _missing_ancestors(out.parent)
    work = None
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        work = out.parent / f".{out.name}.{os.getpid()}.tmp"
        work.mkdir()
        draw_figures(work, root, targets, refs)
        publish(work, out, body)
    except BaseException:
        # 失敗したときは作りかけの物も、コマンドが作った出力先の親のディレクトリも残さない
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)
        remove_created_dirs(created)
        raise
    items = [{"no": i, "topic_id": t, "term": topics[t]["term"], "generation": gens[t]} for i, t in enumerate(order, start=1)]
    return {"reading": READING, "figures": figure_list(order, refs), "items": items}


if __name__ == "__main__":
    sys.exit(run(main))
