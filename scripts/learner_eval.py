"""学習者役のパックを作る入口（build_learner_pack.py）と採点の入口（grade_learner.py）が共に読む物。
契約は docs/goals/GOAL-12-measure-with-learner-role/UC-019-measure-with-learner-pack/contract.yaml。
data・out・answers・explain と図の置き場 public/ は、コマンドを呼んだ作業ディレクトリからのパスとして読む。
登録簿は targets.py（リポジトリの src/shared/targets.json）から読む。"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from targets import targets  # noqa: E402

CHOICES = ("ア", "イ", "ウ", "エ")
DATA_ARG = re.compile(r"^data/[a-z]+$")


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


def _shape_ok(kind: str, v: str) -> bool:
    if kind == "data":
        return bool(DATA_ARG.match(v))
    if kind == "cycle":
        return bool(re.fullmatch(r"[0-9]+", v)) and int(v) >= 1
    return v != ""


# @implements REQ-340
def contract_args(prog: str, shape: dict[str, str], required: tuple[str, ...]) -> argparse.Namespace:
    """引数を契約の request の形で読む。形の外の引数があれば、何も読み書きする前に、その名前をすべて挙げて断る。
    shape は引数の名前 → data（学びの置き場の形）・cycle（1 以上の整数）・text（空でない文字）。"""
    ap = _Parser(prog=prog, add_help=False)
    for name in shape:
        ap.add_argument(f"--{name}")
    a, unknown = ap.parse_known_args()
    bad = [name for name in shape if (getattr(a, name) is None and name in required)
           or (getattr(a, name) is not None and not _shape_ok(shape[name], getattr(a, name)))]
    bad += [u.split("=", 1)[0].lstrip("-") for u in unknown if u.startswith("-")]
    if bad or unknown:
        raise Refused("INVALID_INPUT", "引数が契約の形の外", arguments=bad or unknown)
    if a.cycle is not None:
        a.cycle = int(a.cycle)
    return a


def read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


# @implements REQ-318
def roadmap_learning(data: str) -> tuple[Path, str, dict]:
    """登録簿にあり種類がロードマップ型で、ロードマップを持つ学びだけを通す。(置き場, key, 登録簿の項目) を返す。"""
    d = Path(data)
    key = d.name
    t = targets().get(key)
    if t is None:
        raise Refused("INVALID_INPUT", "登録簿に無い学び")
    if t.get("kind", "roadmap") != "roadmap":
        raise Refused("INVALID_INPUT", "ロードマップを持たない学び")
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
