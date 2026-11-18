#!/usr/bin/env python3
"""周の番号を付けて学習者役のパックを作り、その周のパックの写しを学びの置き場の eval の下に残す。

    python3 scripts/build_learner_pack.py --data data/eng --cycle 8 --out ../learner_packs/eng_c8

契約は UC-019 の contract.yaml の buildLearnerPack。標準出力に結果の JSON を 1 つ出す（成功 0、errors に当たれば 1）。
パックの中: roadmap.md・units/NN_<単位の名前>.md・quiz.md・explain.md（語の一覧を持つ学びだけ）・figures/（図の PNG）。
本文は利用者に配る本文（投入と同じく教材の世代を後勝ちで選んだ物）で、正解・正解の根拠・選択肢ごとの説明は入れない。
図の SVG は XML として読めることを確かめてから、scripts/render_svg_png.mjs（Playwright の Chromium）で PNG に描く。
"""
from __future__ import annotations
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from xml.parsers import expat

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tool_refusal import CODE, Refused  # noqa: E402
from material_generations import generation_dirs  # noqa: E402
from material_figure_line import figure_line, malformed_lines, map_figure_lines, png_target  # noqa: E402
from learner_io import place_root, read_json  # noqa: E402
from learner_eval import (contract_args, current_questions, read_roadmap,  # noqa: E402
                          remove_created_dirs, result_path, roadmap_learning, run, snapshot_path, write_exclusive)

CHOICES = ("ア", "イ", "ウ", "エ")
# 1 つの図を描く待ち時間の上限（契約の writePackFigure の renderTimeoutSeconds）
RENDER_TIMEOUT_SECONDS = 30
# 描き手（node と Chromium）を起こすのに見込む時間
RENDER_LAUNCH_SECONDS = 60


# @implements REQ-331
def check_out(out: Path, d: Path) -> None:
    data_root = (place_root(d) / "data").resolve()
    o = out.resolve()
    if o == data_root or data_root in o.parents:
        raise Refused(CODE.INVALID_INPUT, "出力先が学びの置き場の中")
    if o.exists() and (not o.is_dir() or any(o.iterdir())):
        raise Refused(CODE.CONFLICT, "出力先に中身がある")


# @implements REQ-321
def check_cycle_free(d: Path, cycle: int) -> None:
    if snapshot_path(d, cycle).exists():
        raise Refused(CODE.CONFLICT, "その周の写しがある")
    if result_path(d, cycle).exists():
        raise Refused(CODE.CONFLICT, "その周の周の結果がある")


# 契約の readRoadmap の行の欄 → (型, 欠けてはならないか)
ROADMAP_FIELDS = {"order": ("pos", True), "topic_id": ("pos", True), "term": ("text", True), "field": ("text", True),
                  "middle": ("text", True), "summary": ("str", True),
                  "day": ("pos", False), "round": ("pos", False), "chapter": ("str", False)}


def _typed(kind: str, v) -> bool:
    if kind == "pos":
        return type(v) is int and v >= 1
    if kind == "text":
        return isinstance(v, str) and v != ""
    return isinstance(v, str)


# @implements REQ-338
def roadmap_units(d: Path) -> tuple[dict, list[dict]]:
    """ロードマップを読み、欠けてはならない欄が無いか型の違う欄（任意の欄は有るときだけ見る）を持つ行をすべて挙げて止める。"""
    rm = read_roadmap(data=str(d))
    bad = []
    for i, u in enumerate(rm["units"]):
        if not isinstance(u, dict):
            bad.append({"index": i, "fields": [k for k, (_, req) in ROADMAP_FIELDS.items() if req]})
            continue
        fields = [k for k, (kind, req) in ROADMAP_FIELDS.items()
                  if (k not in u and req) or (k in u and not _typed(kind, u[k]))]
        if fields:
            bad.append({"index": i, "fields": fields})
    if bad:
        raise Refused(CODE.INVALID_INPUT, "ロードマップに欠けてはならない欄が無いか型の違う行がある", roadmapRows=bad)
    return rm, sorted(rm["units"], key=lambda u: u["order"])


# @implements REQ-358, REQ-579
# @operation UC-019#readDeliveredBody
def read_delivered_body(*, data: str) -> dict:
    """配る本文（契約の readDeliveredBody）。投入と同じく教材の世代を古い順（material_generations.generation_dirs）に、
    世代の中はファイル名の順に読み、論点ごとに後の物を選んで materials に並べる。契約の教材の世代の形（JSON で、どの行も
    整数の topic_id を持つ）として読めないファイルが 1 つでもあれば、選ばれるかに依らず、読めないファイルをすべて挙げて
    INVALID_INPUT の失敗を渡す。選べる行が 1 つも無ければ NOT_FOUND の失敗を渡す。"""
    d = Path(data)
    out: dict[int, dict] = {}
    bad: list[str] = []
    for g in generation_dirs(d):
        for f in sorted(g.glob("*.json")):
            try:
                rows = read_json(f).get("materials", [])
                assert isinstance(rows, list)
                for m in rows:
                    assert isinstance(m, dict) and type(m.get("topic_id")) is int
            except (OSError, ValueError, AttributeError, AssertionError):
                bad.append(f.as_posix())
                continue
            for m in rows:
                out[m["topic_id"]] = m
    if bad:
        raise Refused(CODE.INVALID_INPUT, "配る本文を選ぶ教材の世代のファイルが読めない", unreadable=bad)
    if not out:
        raise Refused(CODE.NOT_FOUND, "配る本文が無い")
    return {"materials": list(out.values())}


# @implements REQ-358
def read_generations(d: Path) -> dict[int, dict]:
    """論点 ID → 選んだ教材の行（read_delivered_body を通して読む）。選べる行が無ければ空。"""
    try:
        rows = read_delivered_body(data=str(d))["materials"]
    except Refused as e:
        if e.code != CODE.NOT_FOUND:
            raise
        return {}
    return {m["topic_id"]: m for m in rows}


# @implements REQ-319
def delivered_bodies(d: Path, units: list[dict]) -> dict[int, dict]:
    """教材の世代を後勝ちで重ねて選んだ論点ごとの配る本文。配る本文の無い単位があれば挙げて止める。"""
    bodies = {tid: m for tid, m in read_generations(d).items()
              if isinstance(m.get("explanation"), str) and m["explanation"] and isinstance(m.get("detail"), str) and m["detail"]}
    missing = [u["topic_id"] for u in units if u["topic_id"] not in bodies]
    if missing:
        raise Refused(CODE.NOT_FOUND, "配る本文の無い単位がある", units=missing)
    return bodies


# @implements REQ-513
def check_figure_lines(units: list[dict], bodies: dict[int, dict]) -> None:
    """配る本文に図の置き場を指すのに図の行の形に合わない行があれば、単位の学ぶ順に、その単位と書かれたままの行を挙げて止める。"""
    hit = [{"unit": u["topic_id"], "line": l} for u in units
           for l in malformed_lines(bodies[u["topic_id"]]["explanation"] + "\n" + bodies[u["topic_id"]]["detail"])]
    if hit:
        raise Refused(CODE.INVALID_INPUT, "図の置き場を指すのに図の行の形に合わない行がある", lines=hit)


# @implements REQ-320, REQ-579
# @operation UC-019#readFigure
def read_figure(*, src: str, root: str | None = None) -> dict:
    """配る本文の図の行が指す画像（契約の readFigure）。画像は置き場の根（root。無ければ作業ディレクトリ）の public の下の
    src と同じパスにあり、そのパスを file で返す。無ければ NOT_FOUND の失敗を渡す。"""
    f = Path(root if root is not None else ".") / "public" / src.lstrip("/")
    if not f.is_file():
        raise Refused(CODE.NOT_FOUND, "画像が置き場所に無い", figures=[{"ref": src}])
    return {"file": f.as_posix()}


# @implements REQ-320
def figure_refs(root: Path, units: list[dict], bodies: dict[int, dict]) -> list[dict]:
    """本文の図の行を {unit, ref, src, target} で並べる。画像は置き場の根の public の下の同じパスにある。
    指す画像が置き場所に無ければ、その単位と図を挙げて止める。"""
    refs, missing = [], []
    for u in units:
        m = bodies[u["topic_id"]]
        for line in (m["explanation"] + "\n" + m["detail"]).split("\n"):
            f = figure_line(line)
            if f is None:
                continue
            ref = f.src
            try:
                src = Path(read_figure(src=ref, root=root.as_posix())["file"])
            except Refused as e:
                if e.code != CODE.NOT_FOUND:
                    raise
                missing.append({"unit": u["topic_id"], "ref": ref})
                continue
            refs.append({"unit": u["topic_id"], "ref": ref, "src": src, "target": png_target(ref)})
    if missing:
        raise Refused(CODE.NOT_FOUND, "配る本文が指す図の画像が無い", figures=missing)
    return refs


# @implements REQ-337
def figures_by_target(refs: list[dict]) -> dict[str, Path]:
    """パックの中の PNG のパス → 元の画像。別の画像が同じ PNG の名前になるときは、どれも上書きせず挙げて止める。"""
    srcs: dict[str, set[Path]] = {}
    for r in refs:
        srcs.setdefault(r["target"], set()).add(r["src"])
    clash = {t for t, s in srcs.items() if len(s) > 1}
    if clash:
        hit = [{"unit": r["unit"], "ref": r["ref"]} for r in refs if r["target"] in clash]
        raise Refused(CODE.INVALID_INPUT, "同じ PNG の名前になる図が 2 つ以上ある", figures=hit)
    return {t: next(iter(s)) for t, s in srcs.items()}


# @implements REQ-305, REQ-306
def to_pack_refs(text: str) -> str:
    """図の行の指す先だけを、単位のファイルから見たパックの中の PNG に変える。"""
    return map_figure_lines(text, lambda f: f"{f.head}{f.caption}{f.mid}../{png_target(f.src)}{f.tail}")


# @implements REQ-306, REQ-336
def draw_figures(out: Path, figures: dict[str, Path], timeout: int) -> tuple[set[str], set[str]]:
    """パックの中の PNG のパス → 元の画像を、サブパスを保ち拡張子を .png にした PNG にして out の下に置く。
    元が PNG の図は写し、SVG はブラウザの文字の描画で元の幅と高さのまま描く（1 つの図の待ち時間の上限は timeout 秒）。
    返すのは (XML として整わない図, PNG に描けなかった図) のパックの中のパス。整わない図が 1 つでもあれば SVG は 1 つも描かない。"""
    jobs = []
    for target, src in figures.items():
        (out / target).parent.mkdir(parents=True, exist_ok=True)
        if src.suffix == ".png":
            shutil.copyfile(src, out / target)
        else:
            jobs.append({"src": str(src.resolve()), "dst": str((out / target).resolve()), "target": target})
    broken = {j["target"] for j in jobs if not well_formed(Path(j["src"]))}
    if broken:
        return broken, set()
    return set(), (render_svgs(jobs, timeout) if jobs else set())


# @implements REQ-306, REQ-579
# @operation UC-019#writePackFigure
def write_pack_figure(*, out: str, file: str, target: str, renderTimeoutSeconds: int) -> dict:
    """図 1 つを PNG に描いてパックの中の target に置く（契約の writePackFigure。元が PNG ならそのまま写す）。
    図が XML として整わないか、待ち時間の上限のうちに描けなければ INTERNAL の失敗を渡す。"""
    broken, failed = draw_figures(Path(out), {target: Path(file)}, renderTimeoutSeconds)
    if broken:
        raise Refused(CODE.INTERNAL, "図が XML として整わない", figures=[{"file": file}])
    if failed:
        raise Refused(CODE.INTERNAL, "図を PNG に描けない", figures=[{"file": file}])
    return {"path": target, "mediaType": "image/png"}


# @implements REQ-306
def write_figures(out: Path, figures: dict[str, Path], refs: list[dict]) -> list[str]:
    """配る本文の図をすべて figures/ の下に PNG で置く（本文の参照先は to_pack_refs が合わせる）。描き手を 1 回だけ起こして
    全部を描くので、図 1 つの書き出し（write_pack_figure）と同じ draw_figures でまとめて描く。"""
    broken, failed = draw_figures(out, figures, RENDER_TIMEOUT_SECONDS)
    if broken:
        hit = [{"unit": r["unit"], "ref": r["ref"]} for r in refs if r["target"] in broken]
        raise Refused(CODE.INTERNAL, "図が XML として整わない", figures=hit)
    if failed:
        hit = [{"unit": r["unit"], "ref": r["ref"]} for r in refs if r["target"] in failed]
        raise Refused(CODE.INTERNAL, "図を PNG に描けない", figures=hit)
    return sorted(figures)


# @implements REQ-336
def well_formed(svg: Path) -> bool:
    """図のファイルが XML として整っているか（途中で切れた・要素が閉じない・XML で決まっていない実体参照・引用符が閉じない物は整わない）。"""
    try:
        expat.ParserCreate().Parse(svg.read_bytes(), True)
    except (OSError, expat.ExpatError):
        return False
    return True


# @implements REQ-336
def render_svgs(jobs: list[dict], timeout: int = RENDER_TIMEOUT_SECONDS) -> set[str]:
    """SVG を描き、描けなかった物のパックの中のパスを返す（node か Chromium が無いとき、描き手が待ち時間の上限のうちに返らないときは全部）。
    1 つの図の待ち時間の上限は描き手が守り、ここでは図の数だけの上限と起動の見込みを足した長さで描き手そのものを打ち切る。"""
    try:
        p = subprocess.run(["node", str(HERE / "render_svg_png.mjs"), str(timeout)],
                           input=json.dumps([{"src": j["src"], "dst": j["dst"]} for j in jobs]),
                           capture_output=True, text=True, cwd=str(HERE.parent),
                           timeout=timeout * len(jobs) + RENDER_LAUNCH_SECONDS)
        bad_src = {f["src"] for f in json.loads(p.stdout or "{}").get("failed", [])}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {j["target"] for j in jobs}
    return {j["target"] for j in jobs if j["src"] in bad_src or not Path(j["dst"]).is_file()}


# @implements REQ-305, REQ-579
# @operation UC-019#writePackUnit
def write_pack_unit(*, out: str, file: str, topic_id: int, term: str, field: str, middle: str,
                    explanation: str, detail: str) -> dict:
    """単位のファイル（契約の writePackUnit）を out の下の file に書く。explanation と detail は図の行がパックの中を指す本文。
    書くファイルの親の置き場（出力先とその下）が無ければ作る。"""
    text = [f"# {term}", "", f"単位の ID: {topic_id} ／ 分野: {field} ／ 単元: {middle}", "",
            explanation, "", detail, ""]
    _write_text(Path(out) / file, "\n".join(text))
    return {"path": file}


# @implements REQ-305
def write_unit(out: Path, u: dict, body: dict) -> str:
    """単位のファイルを、配る本文の図の行をパックの中の PNG に向けて書く（write_pack_unit を通して書く）。"""
    return write_pack_unit(out=str(out), file=_unit_file(u), topic_id=u["topic_id"], term=u["term"], field=u["field"],
                           middle=u["middle"], explanation=to_pack_refs(body["explanation"]),
                           detail=to_pack_refs(body["detail"]))["path"]


def _write_text(p: Path, text: str) -> None:
    """パックのファイルを書く。親の置き場（出力先とその下）が無ければ作る。"""
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _unit_file(u: dict) -> str:
    safe = re.sub(r"[/\\ ]", "_", u["term"])
    return f"units/{u['order']:02d}_{safe}.md"


# @implements REQ-304
def round_label(u: dict, by_chapter: bool, spec: dict) -> str:
    """回の見出しの語。章で束ねる学びは roundLabel を章の番号と名前で、日で束ねる学びは日で埋める。
    ロードマップの任意の欄（round・chapter・day）が無い行は、ある欄だけで見出しを作る。"""
    rl = spec.get("roundLabel", "{day} 日目")
    if by_chapter:
        if "round" not in u:
            return u.get("chapter") or "回の指定なし"
        name = u.get("chapter", "")
        if "{label}" in rl:
            return rl.format(day=u["round"], label=name)
        return f"{rl.format(day=u['round'])} {name}".strip()
    return rl.format(day=u["day"]) if "day" in u else "回の指定なし"


ANSWER_FORMAT = {"answers": {}, "units": [{"topic_id": 1, "minutes": 5, "understood": 3, "confusing": "", "unknown_terms": []}]}


# @implements REQ-304, REQ-579
# @operation UC-019#writePackRoadmap
def write_pack_roadmap(*, out: str, units: list[dict], target: str | None = None) -> dict:
    """パックの一覧 roadmap.md（契約の writePackRoadmap）を書く。units は学ぶ順で、各行が回の見出しの語 round と単位のファイル file を持つ。
    target は一覧の題に添える学びの名前（ロードマップの target）で、省略すると題に名前を添えない。出力先が無ければ作る。"""
    title = "# 学習ロードマップ" if target is None else f"# 学習ロードマップ: {target}"
    lines = [title, "",
             f"全 {len(units)} 単位。上から順番に読む。各行の「ID」が単位の ID で、自己申告にはこの ID を書く。", ""]
    head = None
    for u in units:
        r = u["round"]
        if r != head:
            head = r
            lines += ["", f"## {r}"]
        lines.append(f"- {u['order']}. [{u['term']}]({u['file']})（ID {u['topic_id']}・{r}）— {u['summary']}")
    _write_text(Path(out) / "roadmap.md", "\n".join(lines) + "\n")
    return {"path": "roadmap.md"}


# @implements REQ-304, REQ-579
# @operation UC-019#writePackQuiz
def write_pack_quiz(*, out: str, answerFormat: dict, questions: list[dict]) -> dict:
    """確認問題のファイル quiz.md（契約の writePackQuiz）を、答えと自己申告の書き方 answerFormat を先頭に添えて書く。出力先が無ければ作る。"""
    q = ["# 確認問題（各単位を読んだ直後に答える）", "",
         "答えと自己申告は `learner_answers.json` に、次の形で書く。`units` の各行の `topic_id`（ロードマップの単位の ID）は必須。",
         "`answers` は問題の識別子 → 選んだ答え（ア・イ・ウ・エ のどれか）。", "",
         "```json", json.dumps(answerFormat, ensure_ascii=False, indent=1), "```", "",
         "- `minutes`: 読んだ分数",
         "- `understood`: 理解の段。3＝人に説明できる / 2＝分かった気がする / 1＝分からなかった",
         "- `confusing`: どの単位と混ざったか（無ければ空）",
         "- `unknown_terms`: 説明が無くて分からなかった語", ""]
    for x in questions:
        q += [f"## {x['qid']}（単位 {x['order']}・ID {x['topic_id']}: {x['term']}）", x["stem"], ""]
        q += [f"- {k}. {x['choices'][k]}" for k in CHOICES] + [""]
    _write_text(Path(out) / "quiz.md", "\n".join(q) + "\n")
    return {"path": "quiz.md"}


# @implements REQ-304, REQ-579
# @operation UC-019#writePackExplain
def write_pack_explain(*, out: str, terms: list[str]) -> dict:
    """説明テストのファイル explain.md（契約の writePackExplain）を書く。出力先が無ければ作る。"""
    e = ["# 説明テスト（全部読み終えた後、教材を読み返さずに書く）", "",
         "次の語を、この分野に詳しくない友人に向けて 1〜2 文で説明する。分からなければ「分からない」と正直に書く。",
         "答えは `explain_answers.json` に `{\"answers\": {\"語\": \"説明\"}}` の形で書く。", ""] + [f"- {t}" for t in terms]
    _write_text(Path(out) / "explain.md", "\n".join(e) + "\n")
    return {"path": "explain.md"}


# @implements REQ-304
def write_roadmap_quiz_explain(out: Path, rm: dict, units: list[dict], spec: dict, files: list[str],
                               questions: list[dict], terms: list[str] | None) -> None:
    """一覧・確認問題・説明テスト（語の一覧を持つ学びだけ）のファイルを、それぞれの書き出しの関数を通して書く。"""
    by_chapter = rm.get("group_by") == "chapter"
    rows = [{"order": u["order"], "topic_id": u["topic_id"], "term": u["term"], "round": round_label(u, by_chapter, spec),
             "summary": u["summary"], "file": fn} for u, fn in zip(units, files)]
    write_pack_roadmap(out=str(out), units=rows, target=rm.get("target", ""))
    write_pack_quiz(out=str(out), answerFormat=ANSWER_FORMAT, questions=questions)
    if terms:
        write_pack_explain(out=str(out), terms=terms)


# @implements REQ-335, REQ-579
# @operation UC-019#readExplainTerms
def read_explain_terms(*, data: str) -> dict:
    """説明テストの語の一覧（契約の readExplainTerms。学びの置き場の explain_terms.json の terms）。無ければ NOT_FOUND、
    JSON として読めないか語の行の形を満たさなければ INVALID_INPUT の失敗を渡す。"""
    p = Path(data) / "explain_terms.json"
    if not p.exists():
        raise Refused(CODE.NOT_FOUND, "説明テストの語の一覧が無い", unreadable=[p.as_posix()])
    try:
        terms = read_json(p)["terms"]
        assert isinstance(terms, list)
        for t in terms:
            assert isinstance(t, dict) and isinstance(t.get("term"), str) and t["term"]
            g = t.get("goal")
            assert g is None or (type(g) is int and g >= 1)
    except (OSError, ValueError, KeyError, TypeError, AssertionError):
        raise Refused(CODE.INVALID_INPUT, "説明テストの語の一覧が読めない", unreadable=[p.as_posix()])
    return {"terms": terms}


# @implements REQ-335
def explain_terms(d: Path) -> list[str] | None:
    """説明テストの語（read_explain_terms を通して読む）。一覧の無い学びと語が 1 つも無い学びは None（説明テストを出さない）。"""
    try:
        terms = read_explain_terms(data=str(d))["terms"]
    except Refused as e:
        if e.code != CODE.NOT_FOUND:
            raise
        return None
    return [t["term"] for t in terms] or None


# @implements REQ-308
def roadmap_questions(units: list[dict], current: list[dict]) -> list[dict]:
    """その時点のロードマップの単位の問題だけを、単位の学ぶ順に（同じ単位の中は今の確認問題の順で）並べる。"""
    order = {u["topic_id"]: u["order"] for u in units}
    return sorted((q for q in current if q["topic_id"] in order), key=lambda q: order[q["topic_id"]])


# @implements REQ-307
def quiz_items(units: list[dict], questions: list[dict]) -> list[dict]:
    """パックの確認問題に出す欄だけを取り出す。正解・正解の根拠・選択肢ごとの説明・測る到達基準は持たない。"""
    order = {u["topic_id"]: u["order"] for u in units}
    return [{"qid": q["qid"], "topic_id": q["topic_id"], "order": order[q["topic_id"]], "term": q["term"], "stem": q["stem"],
             "choices": {k: q["choices"][k] for k in CHOICES}} for q in questions]


# @implements REQ-309
def make_snapshot(cycle: int, units: list[dict], questions: list[dict]) -> dict:
    field = {u["topic_id"]: u["field"] for u in units}
    return {"cycle": cycle,
            "units": [{"order": u["order"], "topic_id": u["topic_id"], "term": u["term"], "field": u["field"]} for u in units],
            "questions": [{"qid": q["qid"], "topic_id": q["topic_id"], "tests_goal": q["tests_goal"], "field": field[q["topic_id"]],
                           "answer": q["answer"]} for q in questions]}


def _missing_ancestors(p: Path) -> list[Path]:
    """p とその親のうち、今は無い物（作るとコマンドが作った物になる）を、深い順に並べる。"""
    out = []
    p = p.resolve()
    while not p.exists():
        out.append(p)
        p = p.parent
    return out


# @implements REQ-336, REQ-355
def discard_pack(out: Path, created: list[Path]) -> None:
    """作りかけのパックを消す。コマンドが作った出力先はディレクトリごと、前からあった出力先は中身だけを消し、
    コマンドが作った親のディレクトリは空のときだけ消す。"""
    if created:
        shutil.rmtree(created[0], ignore_errors=True)
        remove_created_dirs(created[1:])
    else:
        for c in list(out.iterdir()):
            shutil.rmtree(c, ignore_errors=True) if c.is_dir() else c.unlink(missing_ok=True)


# @implements REQ-355, REQ-579
# @operation UC-019#writePackSnapshot
def write_pack_snapshot(*, data: str, snapshot: dict) -> dict:
    """その周の写し（契約の writePackSnapshot）を排他の作成で書く。その周の写しが既にあれば（作る間にほかの呼び出しが
    書いた物を含む）、写しを書き換えずに CONFLICT の失敗を渡す。"""
    sp = snapshot_path(Path(data), snapshot["cycle"])
    if not write_exclusive(sp, snapshot):
        raise Refused(CODE.CONFLICT, "作る間に同じ周の写しが書かれた")
    return {"path": sp.as_posix()}


# @implements REQ-355
def keep_snapshot(d: Path, snapshot: dict) -> Path:
    """その周の写しを書く（write_pack_snapshot を通して書く）。"""
    return Path(write_pack_snapshot(data=str(d), snapshot=snapshot)["path"])


# @implements UC-019, REQ-340
# @operation UC-019#buildLearnerPack
def main() -> dict:
    a = contract_args("build_learner_pack.py", {"data": "data", "cycle": "cycle", "out": "text"}, ("data", "cycle", "out"))
    d, key, t = roadmap_learning(a.data)
    out = Path(a.out)
    check_out(out, d)
    check_cycle_free(d, a.cycle)
    current = current_questions(d)
    terms = explain_terms(d)
    rm, units = roadmap_units(d)
    bodies = delivered_bodies(d, units)
    check_figure_lines(units, bodies)
    refs = figure_refs(place_root(d), units, bodies)
    figures = figures_by_target(refs)
    questions = roadmap_questions(units, current)
    snapshot = make_snapshot(a.cycle, units, questions)

    created = _missing_ancestors(out)
    created_eval = _missing_ancestors(snapshot_path(d, a.cycle).parent)
    try:
        (out / "units").mkdir(parents=True, exist_ok=True)
        figs = write_figures(out, figures, refs)
        files = [write_unit(out, u, bodies[u["topic_id"]]) for u in units]
        write_roadmap_quiz_explain(out, rm, units, t.get("roadmapSpec") or {}, files, quiz_items(units, questions), terms)
        sp = keep_snapshot(d, snapshot)
    except BaseException:
        # 失敗したときはパックも、コマンドが作った出力先とその親のディレクトリも残さない。
        # 写しは最後に排他の作成で書くので、ここに来たときこの呼び出しの写しは無い（あるのはほかの呼び出しの写し）
        discard_pack(out, created)
        remove_created_dirs(created_eval)
        raise
    res_files = {"roadmap": "roadmap.md", "units": files, "quiz": "quiz.md", "figures": figs}
    if terms:
        res_files["explain"] = "explain.md"
    return {"snapshotPath": sp.as_posix(), "snapshot": snapshot, "files": res_files}


if __name__ == "__main__":
    sys.exit(run(main))
