#!/usr/bin/env python3
"""ロードマップ型の学びの仕様書テンプレート（scripts/prompts/roadmap_*.md）に学びの値を埋めて <学びの置き場>/prompts/ に書き出す。

    python3 scripts/render_prompts.py --data data/itc

学習者役への指示（roadmap_learner.md）の描き出しは UC-019 の contract.yaml の renderLearnerInstructions。
標準出力に結果の JSON を 1 つ出す（成功 0 で {"path": <学習者役への指示>}、errors に当たれば契約の ToolError で 1）。
値は登録簿 src/shared/targets.json の <学び>.roadmapSpec とロードマップ（days・per_day・到達基準の数）。
担当（教材・問題・学習者役）には書き出した方を読ませる。どれかのテンプレートに埋まらない差し込みが残れば、何も書かずに断る。
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from learner_io import read_json  # noqa: E402
from learner_eval import Refused, contract_args, registered_roadmap, run  # noqa: E402

PROMPTS = ROOT / "scripts" / "prompts"
LEARNER = "roadmap_learner.md"
TEMPLATES = ("roadmap_materials.md", "roadmap_questions.md", LEARNER, "roadmap_explain_grader.md")
PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")
# 日で束ねる学びだけの塊。行の中に置き、入れ子にしない（改行をまたがない）
BY_DAY = re.compile(r"\{\{#byDay\}\}(.*?)\{\{/byDay\}\}")
BY_DAY_MARK = re.compile(r"\{\{[#/]byDay\}\}")
HISTORY = "## 改訂履歴"


# @implements REQ-359
# @operation UC-019#readLearnerTemplate
def read_learner_template() -> dict:
    """学習者役への指示の雛形（契約の readLearnerTemplate）。本文と、節の見出し・差し込みの名前・日で束ねる学びだけの塊の中の差し込みの名前。"""
    text = (PROMPTS / LEARNER).read_text(encoding="utf-8")
    headings = [ln for ln in _outside_fences(text) if re.match(r"^#{1,6} ", ln)]
    by_day = [n for body in BY_DAY.findall(text) for n in PLACEHOLDER.findall(body)]
    return {
        "text": text,
        "headings": headings,
        "placeholders": list(dict.fromkeys(PLACEHOLDER.findall(text))),
        "byDayPlaceholders": list(dict.fromkeys(by_day)),
    }


def _is_chapter(rm: dict) -> bool:
    """章で束ねる学びか（ロードマップの group_by が chapter）。無ければ日で束ねる学び。"""
    return rm.get("group_by") == "chapter"


# @implements REQ-359
def by_day_blocks(text: str, chapter: bool) -> str:
    """日で束ねる学びだけの塊を、日で束ねる学びでは印を除いて中身を残し、章で束ねる学びでは印ごと外す。
    対にならない印が残るのは雛形の誤りとして止める。"""
    out = BY_DAY.sub("" if chapter else (lambda m: m.group(1)), text)
    if BY_DAY_MARK.search(out):
        raise RuntimeError("雛形の日で束ねる学びだけの塊の印が対になっていない（行の中で {{#byDay}} と {{/byDay}} を対にする）")
    return out


def _outside_fences(text: str) -> list[str]:
    """コードの囲みの外の行。"""
    out, fenced = [], False
    for ln in text.split("\n"):
        if ln.startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            out.append(ln)
    return out


# @implements REQ-359
def without_history(text: str) -> str:
    """雛形の改訂履歴の節（見出しから、同じか上の段の次の見出しの前まで）を外す。"""
    lines = text.split("\n")
    if HISTORY not in lines:
        return text
    at = lines.index(HISTORY)
    end = next((i for i in range(at + 1, len(lines)) if re.match(r"^#{1,2} ", lines[i])), len(lines))
    return "\n".join(lines[:at] + lines[end:]).rstrip("\n") + "\n"


def _answer_format(text: str) -> dict:
    """指示の囲みのうち answers と units を持つ JSON（契約の writeLearnerInstructions の answerFormat）。
    雛形がこの書き方を持たないか、単位の行が単位の ID を持たないときは雛形の誤りとして止める。"""
    for block in re.findall(r"```[a-z]*\n(.*?)```", text, flags=re.S):
        try:
            j = json.loads(block)
        except ValueError:
            continue
        if isinstance(j, dict) and "answers" in j and "units" in j:
            rows = j["units"]
            if not (isinstance(rows, list) and rows and all(isinstance(r, dict) and type(r.get("topic_id")) is int and r["topic_id"] >= 1 for r in rows)):
                raise RuntimeError(f"{LEARNER}: 答えの書き方の units の行に単位の ID が無い")
            return j
    raise RuntimeError(f"{LEARNER}: 答えと自己申告の書き方（answers と units を持つ JSON の囲み）が無い")


# @implements REQ-526
# @operation UC-019#readRoadmap
def read_roadmap(d: Path) -> dict:
    """学びのロードマップ（契約の readRoadmap）。登録簿がロードマップを持つ学びとし、置き場に無いか読めないときは空。"""
    try:
        rm = read_json(d / "roadmap.json")
    except (OSError, ValueError):
        return {}
    return rm if isinstance(rm, dict) else {}


# @implements REQ-412
def values(key: str, entry: dict, spec: dict, rm: dict) -> dict:
    """差し込みの値。days は日で束ねる学びのロードマップの days だけが埋め、章で束ねる学びでは埋めない。"""
    v = dict(spec)
    v.setdefault("targetName", entry.get("brand"))
    v.setdefault("key", key)
    if not _is_chapter(rm) and type(rm.get("days")) is int and rm["days"] >= 1:
        v["days"] = rm["days"]
    else:
        v.pop("days", None)
    if "per_day" in rm:
        v.setdefault("perDay", rm["per_day"])
    v.setdefault("perDay", 3)
    # 到達基準の数（確認問題の tests_goal の上限）はロードマップの単位の goals の最大の番号
    units = rm.get("units") if isinstance(rm.get("units"), list) else []
    v.setdefault("goalCount", max((g for u in units if isinstance(u, dict) for g in u.get("goals", []) if type(g) is int), default=6))
    for k in ("reader", "taboo"):
        if isinstance(v.get(k), list):
            v[k] = "\n".join(f"- {x}" for x in v[k])
    return {k: x for k, x in v.items() if x is not None}


# @implements REQ-412
def fill(text: str, v: dict) -> tuple[str, list[str]]:
    """差し込みを埋め、埋まらなかった差し込みの名前を雛形に現れる順に返す。"""
    out = PLACEHOLDER.sub(lambda m: str(v[m.group(1)]) if m.group(1) in v else m.group(0), text)
    return out, list(dict.fromkeys(PLACEHOLDER.findall(out)))


# @implements REQ-412
def render_all(key: str, entry: dict, spec: dict, rm: dict) -> dict[str, str]:
    """全テンプレートを描き出した本文（テンプレートの名前 → 本文）。埋まらない差し込みが残れば、その名前を挙げて断る。"""
    v = values(key, entry, spec, rm)
    chapter = _is_chapter(rm)
    texts: dict[str, str] = {}
    left: list[str] = []
    for name in TEMPLATES:
        if name == LEARNER:
            text = without_history(read_learner_template()["text"])
        else:
            text = re.sub(r"<!-- テンプレート。.*?-->\n\n", "", (PROMPTS / name).read_text(encoding="utf-8"), flags=re.S)
        texts[name], miss = fill(by_day_blocks(text, chapter), v)
        left += [m for m in miss if m not in left]
    if left:
        raise Refused("INVALID_INPUT", "雛形の差し込みに埋まらない物が残る", placeholders=left)
    return texts


# @implements UC-019, REQ-411
# @operation UC-019#renderLearnerInstructions
def main() -> dict:
    a = contract_args("render_prompts.py", {"data": "data"}, ("data",))
    d = Path(a.data)
    key = d.name
    r = registered_roadmap(key)
    texts = render_all(key, r["entry"], r["roadmapSpec"], read_roadmap(d))
    return write_instructions(d, texts)


# @implements REQ-360
# @operation UC-019#writeLearnerInstructions
def write_instructions(d: Path, texts: dict[str, str]) -> dict:
    """描き出した全テンプレートを <学びの置き場>/prompts/ に書く。学習者役への指示が答えと自己申告の書き方を
    持たないときは、何も書かずに雛形の誤りとして止める。"""
    _answer_format(texts[LEARNER])
    out = d / "prompts"
    out.mkdir(parents=True, exist_ok=True)
    for name, text in texts.items():
        (out / name).write_text(text, encoding="utf-8")
    return {"path": (out / LEARNER).as_posix()}


if __name__ == "__main__":
    sys.exit(run(main))
