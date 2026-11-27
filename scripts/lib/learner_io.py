"""学習者役で測る道具（learner_eval.py とそれを使う入口）が共に使う、学びの置き場と登録簿の読み書きの部品。"""
from __future__ import annotations
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 道具の置き場（scripts/。部品が読む道具の側のモジュール）
sys.path.insert(0, str(Path(__file__).resolve().parent))
from targets import targets  # noqa: E402
from tool_refusal import CODE, Refused  # noqa: E402


# @implements REQ-579
# @operation UC-019#readRegistryLearning
def read_registry_learning(*, key: str) -> dict:
    """登録簿の 1 つの学び（契約の readRegistryLearning）。roadmap と、登録簿の学びの名前 brand（登録簿が持つときだけ）と、
    ロードマップを持つ学びだけ roadmapSpec を持つ。登録簿に無ければ NOT_FOUND の失敗を渡す。"""
    t = targets().get(key)
    if t is None:
        raise Refused(CODE.NOT_FOUND, f"登録簿に無い学び『{key}』")
    res = {"roadmap": t.get("roadmap") is True}
    if isinstance(t.get("brand"), str) and t["brand"]:
        res["brand"] = t["brand"]
    if res["roadmap"]:
        res["roadmapSpec"] = t.get("roadmapSpec") or {}
    return res


def registry_learning(key: str) -> dict | None:
    """登録簿の 1 つの学び（read_registry_learning を通して読む）。登録簿に無ければ None。"""
    try:
        return read_registry_learning(key=key)
    except Refused as e:
        if e.code != CODE.NOT_FOUND:
            raise
        return None


def read_json(p: Path):
    """UTF-8 の JSON のファイルを読む。読めないときは OSError か ValueError をそのまま出す。"""
    return json.loads(p.read_text(encoding="utf-8"))


def place_root(d: Path) -> Path:
    """学びの置き場 <根>/data/<key> の根。"""
    return d.parent.parent
