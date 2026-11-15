"""学習者役のパックを作る入口（build_learner_pack.py）と採点の入口（grade_learner.py）が共に読む物。
契約は docs/goals/GOAL-12-measure-with-learner-role/UC-019-measure-with-learner-pack/contract.yaml。
data・out・answers・explain は、コマンドを呼んだ作業ディレクトリからのパスとして読む。
置き場の根は data の 2 段上（リポジトリなら作業ディレクトリ、検査用の作り物なら tests/fixtures/learner-pack/<名前>）で、
学びの置き場は根の data/<key>、図の置き場は根の public/。登録簿は targets.py（リポジトリの src/shared/targets.json）から読む。"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from targets import targets  # noqa: E402

CHOICES = ("ア", "イ", "ウ", "エ")
DATA_ARG = re.compile(r"^(tests/fixtures/learner-pack/[a-z0-9-]+/)?data/[a-z]+$")


class Refused(Exception):
    """契約の errors に当たって止まる。応答は契約の ToolError の形で、detail はその失敗が挙げる物の欄だけを持つ。"""

    def __init__(self, code: str, reason: str, **detail):
        super().__init__(reason)
        self.code, self.reason, self.detail = code, reason, detail


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=1))


def run(main) -> int:
    """入口を回し、成功なら結果の JSON と 0、errors に当たれば契約の ToolError の JSON と 1 を返す。"""
    try:
        emit(main())
        return 0
    except Refused as e:
        emit({"error": {"code": e.code, "reason": e.reason, **e.detail}})
        return 1


class _Parser(argparse.ArgumentParser):
    def error(self, message: str):
        raise Refused("INVALID_INPUT", "引数が契約の形の外", arguments=[])


def _shape_ok(kind, v: str) -> bool:
    if callable(kind):
        return bool(kind(v))
    if kind == "data":
        return bool(DATA_ARG.match(v))
    if kind == "cycle":
        return bool(re.fullmatch(r"[0-9]+", v)) and int(v) >= 1
    return v != ""


# @implements REQ-340
def contract_args(prog: str, shape: dict[str, str], required: tuple[str, ...]) -> argparse.Namespace:
    """引数を契約の request の形で読む。形の外の引数があれば、何も読み書きする前に、その名前をすべて挙げて断る。
    shape は引数の名前 → data（学びの置き場の形）・cycle（1 以上の整数）・text（空でない文字）、
    または値を受けて形に合うかを返す関数（入口ごとの契約の形）。"""
    # 契約の引数名の前の部分だけの名前（--dat など）は契約に無い引数として断るので、略した名前を契約の引数と読まない
    ap = _Parser(prog=prog, add_help=False, allow_abbrev=False)
    for name in shape:
        ap.add_argument(f"--{name}")
    a, unknown = ap.parse_known_args()
    bad = [name for name in shape if (getattr(a, name) is None and name in required)
           or (getattr(a, name) is not None and not _shape_ok(shape[name], getattr(a, name)))]
    bad += [u.split("=", 1)[0].lstrip("-") for u in unknown if u.startswith("-")]
    if bad or unknown:
        raise Refused("INVALID_INPUT", "引数が契約の形の外", arguments=bad or unknown)
    if getattr(a, "cycle", None) is not None:
        a.cycle = int(a.cycle)
    return a


def read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def place_root(d: Path) -> Path:
    """学びの置き場 <根>/data/<key> の根。"""
    return d.parent.parent


def registry_learning(key: str) -> dict | None:
    """登録簿の 1 つの学び（契約の readRegistryLearning）。登録簿に無ければ None。"""
    t = targets().get(key)
    if t is None:
        return None
    res = {"roadmap": t.get("roadmap") is True, "entry": t}
    if res["roadmap"]:
        res["roadmapSpec"] = t.get("roadmapSpec") or {}
    return res


# @implements REQ-318, REQ-410
def registered_roadmap(key: str) -> dict:
    """登録簿にあり、ロードマップを持つ学びだけを通し、その登録簿の項目を返す。"""
    r = registry_learning(key)
    if r is None:
        raise Refused("INVALID_INPUT", "登録簿に無い学び")
    if not r["roadmap"]:
        raise Refused("INVALID_INPUT", "ロードマップを持たない学び")
    return r


# @implements REQ-318
def roadmap_learning(data: str) -> tuple[Path, str, dict]:
    """登録簿にあり種類がロードマップ型で、ロードマップを持つ学びだけを通す。(置き場, key, 登録簿の項目) を返す。"""
    d = Path(data)
    key = d.name
    t = registered_roadmap(key)["entry"]
    rp = d / "roadmap.json"
    try:
        rm = read_json(rp)
        units = rm["units"]
        assert isinstance(units, list) and units
    except (OSError, ValueError, KeyError, TypeError, AssertionError):
        raise Refused("INVALID_INPUT", "ロードマップを持たない学び")
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


# @implements REQ-333
def current_questions(d: Path) -> list[dict]:
    """学びの今の確認問題（roadmap_questions/bundle_*.json をファイル名の順に、ファイルの中の順で）。"""
    files = sorted((d / "roadmap_questions").glob("bundle_*.json"))
    if not files:
        raise Refused("NOT_FOUND", "今の確認問題が無い")
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
        raise Refused("INVALID_INPUT", "今の確認問題が読めない", unreadable=bad)
    return qs


def snapshot_path(d: Path, cycle: int) -> Path:
    return d / "eval" / f"pack_cycle_{cycle}.json"


def result_path(d: Path, cycle: int) -> Path:
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


def remove_created_dirs(created: list[Path]) -> None:
    """コマンドが作ったディレクトリを深い順に、空のときだけ消す（同時に進む呼び出しが置いた物は消さない）。"""
    for c in created:
        try:
            c.rmdir()
        except OSError:
            pass
