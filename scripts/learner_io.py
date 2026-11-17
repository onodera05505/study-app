"""学習者役で測る道具（learner_eval.py とそれを使う入口）が共に使う、学びの置き場と登録簿の読み書きの部品。"""
from __future__ import annotations
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from targets import targets  # noqa: E402


# @operation UC-019#readRegistryLearning
def registry_learning(key: str) -> dict | None:
    """登録簿の 1 つの学び（契約の readRegistryLearning）。登録簿に無ければ None。"""
    t = targets().get(key)
    if t is None:
        return None
    res = {"roadmap": t.get("roadmap") is True, "entry": t}
    if res["roadmap"]:
        res["roadmapSpec"] = t.get("roadmapSpec") or {}
    return res


def read_json(p: Path):
    """UTF-8 の JSON のファイルを読む。読めないときは OSError か ValueError をそのまま出す。"""
    return json.loads(p.read_text(encoding="utf-8"))


def place_root(d: Path) -> Path:
    """学びの置き場 <根>/data/<key> の根。"""
    return d.parent.parent
