"""学習者役のパックを作る入口（build_learner_pack.py）・採点の入口（grade_learner.py）・指示を描き出す入口（render_prompts.py）と、
単元の読み物を作る入口（build_unit_reading.py）が共に読む物（引数の読み方・登録簿・断りの形）。
契約は docs/goals/GOAL-12-measure-with-learner-role/UC-019-measure-with-learner-pack/contract.yaml。
data・out・answers・explain は、コマンドを呼んだ作業ディレクトリからのパスとして読む。
置き場の根は data の 2 段上（リポジトリなら作業ディレクトリ、検査用の作り物なら tests/fixtures/learner-pack/<名前>）で、
学びの置き場は根の data/<key>、図の置き場は根の public/。登録簿は targets.py（リポジトリの src/shared/targets.json）から読む。"""
from __future__ import annotations
import json
import os
import re
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tool_refusal import CODE, Refused, tool_error  # noqa: E402
from learner_io import read_json, registry_learning  # noqa: E402

CHOICES = ("ア", "イ", "ウ", "エ")
DATA_ARG = re.compile(r"^(tests/fixtures/learner-pack/[a-z0-9-]+/)?data/[a-z]+$")


def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=1))


# @implements BR-061, REQ-527, REQ-528, REQ-571
def run(main) -> int:
    """入口を回し、成功なら結果の JSON と 0、errors に当たれば契約の ToolError の JSON と 1 を返す。"""
    try:
        _emit(main())
        return 0
    except Refused as e:
        _emit(tool_error(e.code, e.reason, **e.detail))
        return 1


def _shape_ok(kind, v: str) -> bool:
    if callable(kind):
        return bool(kind(v))
    if kind == "data":
        return DATA_ARG.fullmatch(v) is not None
    if kind == "cycle":
        return re.fullmatch(r"[0-9]+", v) is not None and int(v) >= 1
    return v != ""


def _arg_pairs(argv: list[str]) -> list[tuple[str | None, str | None, str]]:
    """コマンドの引数を (名前, 値, 語) の並びに読む。`--` で始まる語は常に名前で、`--名前=値` は = より後を値、
    = の無い `--名前` はすぐ後の語が `--` で始まらなければその語を値とし、そうでなければ値を持たない。
    どの名前の値でもない語は名前を None にして語のまま持つ。"""
    out: list[tuple[str | None, str | None, str]] = []
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok.startswith("--"):
            body = tok[2:]
            if "=" in body:
                name, value = body.split("=", 1)
            elif i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                name, value = body, argv[i + 1]
                i += 1
            else:
                name, value = body, None
            out.append((name, value, tok))
        else:
            out.append((None, None, tok))
        i += 1
    return out


# @implements REQ-340, BR-055
def contract_args(prog: str, shape: dict[str, str], required: tuple[str, ...], argv: list[str] | None = None) -> SimpleNamespace:
    """引数を契約の request の形で読む。形の外の引数があれば、何も読み書きする前に、当たった物を 1 回ずつ挙げて断る。
    shape は契約の request の欄を request に並ぶ順に、欄の名前 → data（学びの置き場の形）・cycle（1 以上の整数）・
    text（空でない文字）、または値を受けて形に合うかを返す関数（入口ごとの契約の形）。
    挙げる並びは、契約の欄を shape の順に、続けて契約に無い名前と語をコマンドに現れた順にする。"""
    pairs = _arg_pairs(sys.argv[1:] if argv is None else argv)
    seen: dict[str, list[str | None]] = {}
    extra: list[str] = []
    for name, value, tok in pairs:
        if name is not None and name in shape:
            seen.setdefault(name, []).append(value)
            continue
        # 名前の空の `--`・`--=値` は名前で挙げられないので、語のまま挙げる
        word = name if name else tok
        if word not in extra:
            extra.append(word)
    bad = []
    for name, kind in shape.items():
        vals = seen.get(name)
        if vals is None:
            if name in required:
                bad.append(name)
        elif len(vals) > 1 or vals[0] is None or not _shape_ok(kind, vals[0]):
            bad.append(name)
    if bad or extra:
        raise Refused(CODE.INVALID_INPUT, "引数が契約の形の外", arguments=bad + [w for w in extra if w not in bad])
    a = SimpleNamespace(**{name: (seen[name][0] if name in seen else None) for name in shape})
    for name, kind in shape.items():
        if kind == "cycle" and getattr(a, name) is not None:
            setattr(a, name, int(getattr(a, name)))
    return a


# @implements REQ-318, REQ-410
def registered_roadmap(key: str) -> dict:
    """登録簿にあり、ロードマップを持つ学びだけを通し、その登録簿の学び（read_registry_learning の形）を返す。"""
    r = registry_learning(key)
    if r is None:
        raise Refused(CODE.INVALID_INPUT, "登録簿に無い学び")
    if not r["roadmap"]:
        raise Refused(CODE.INVALID_INPUT, "ロードマップを持たない学び")
    return r


# @implements REQ-526, REQ-579
# @operation UC-019#readRoadmap
def read_roadmap(*, data: str) -> dict:
    """学びのロードマップ（契約の readRoadmap。学びの置き場の roadmap.json の中身）。無ければ NOT_FOUND、
    JSON の object として読めなければ INVALID_INPUT の失敗を渡す。object として読めて units の並びを持たないときも
    INVALID_INPUT で、そのときは読めた object を失敗の roadmap に添える（単位に依らない値だけを使う呼び手が読む）。"""
    p = Path(data) / "roadmap.json"
    if not p.exists():
        raise Refused(CODE.NOT_FOUND, "ロードマップが無い", unreadable=[p.as_posix()])
    try:
        rm = read_json(p)
        assert isinstance(rm, dict)
    except (OSError, ValueError, AssertionError):
        raise Refused(CODE.INVALID_INPUT, "ロードマップが読めない", unreadable=[p.as_posix()])
    if not isinstance(rm.get("units"), list):
        raise Refused(CODE.INVALID_INPUT, "ロードマップが単位の並びを持たない", unreadable=[p.as_posix()], roadmap=rm)
    return rm


# @implements REQ-318
def roadmap_learning(data: str) -> tuple[Path, str, dict]:
    """登録簿にあり種類がロードマップ型で、ロードマップを持つ学びだけを通す。(置き場, key, 登録簿の学び) を返す
    （登録簿の学びは read_registry_learning の形。roadmap・brand・roadmapSpec）。
    ロードマップが無い・読めない・単位が 1 つも無い学びは、ロードマップを持たない学びとして断る。"""
    d = Path(data)
    key = d.name
    t = registered_roadmap(key)
    try:
        units = read_roadmap(data=data)["units"]
    except Refused:
        units = []
    if not units:
        raise Refused(CODE.INVALID_INPUT, "ロードマップを持たない学び")
    return d, key, t


def _question_ok(q) -> bool:
    if not isinstance(q, dict):
        return False
    s = lambda v, n=0: isinstance(v, str) and len(v) >= n  # noqa: E731
    i = lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= 1  # noqa: E731
    ch = q.get("choices")
    return (s(q.get("qid"), 1) and i(q.get("topic_id")) and s(q.get("term")) and s(q.get("stem"), 1)
            and isinstance(ch, dict) and all(s(ch.get(k)) for k in CHOICES) and all(s(v) for v in ch.values())
            and q.get("answer") in CHOICES and s(q.get("reason")) and isinstance(q.get("choice_notes"), dict)
            and i(q.get("tests_goal")))


# @implements REQ-333, REQ-579
# @operation UC-019#readRoadmapQuestions
def read_roadmap_questions(*, data: str) -> dict:
    """学びの今の確認問題（契約の readRoadmapQuestions。roadmap_questions/bundle_*.json をファイル名の順に、ファイルの中の順で）。
    束が 1 つも無ければ NOT_FOUND、形として読めない束があればそれをすべて挙げて INVALID_INPUT の失敗を渡す。"""
    d = Path(data)
    files = sorted((d / "roadmap_questions").glob("bundle_*.json"))
    if not files:
        raise Refused(CODE.NOT_FOUND, "今の確認問題が無い")
    qs: list[dict] = []
    bad: list[str] = []
    for f in files:
        try:
            lst = read_json(f)["questions"]
            assert isinstance(lst, list)
        except (OSError, ValueError, KeyError, TypeError, AssertionError):
            bad.append(f.as_posix())
            continue
        if all(_question_ok(q) for q in lst):
            qs.extend(lst)
        else:
            bad.append(f.as_posix())
    if bad:
        raise Refused(CODE.INVALID_INPUT, "今の確認問題が読めない", unreadable=bad)
    return {"questions": qs}


# @implements REQ-333
def current_questions(d: Path) -> list[dict]:
    """学びの今の確認問題の並び（read_roadmap_questions を通して読む）。"""
    return read_roadmap_questions(data=str(d))["questions"]


# @implements REQ-309
def snapshot_path(d: Path, cycle: int) -> Path:
    """その周のパックの写しの置き場（学びの置き場の eval/ の下。パックの外）。"""
    return d / "eval" / f"pack_cycle_{cycle}.json"


# @implements REQ-314
def result_path(d: Path, cycle: int) -> Path:
    """その周の結果の置き場（学びの置き場の eval/ の下）。"""
    return d / "eval" / f"cycle_{cycle}.json"


# @implements REQ-355, REQ-356
def write_exclusive(p: Path, obj) -> bool:
    """obj を p に、p がまだ無いときだけ書く（排他の作成）。同時に書く呼び出しがあっても、書けるのは 1 つだけ。
    中身を書き終えた一時のファイルを p に固定するので、p は書きかけの中身を見せない。p が既にあれば False。"""
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
        try:
            os.link(tmp, p)
        except FileExistsError:
            return False
        return True
    finally:
        tmp.unlink(missing_ok=True)


# @implements REQ-336, REQ-355
def remove_created_dirs(created: list[Path]) -> None:
    """コマンドが作ったディレクトリを深い順に、空のときだけ消す（同時に進む呼び出しが置いた物は消さない）。"""
    for c in created:
        try:
            c.rmdir()
        except OSError:
            pass
