"""資格対策の学びの置き場を読む道具（投入・単元の構成の門・書き直しの束・単元の読み物・教材の書き方の門・問題解説の門）が共に使う部品。
どれも引いた値をそのまま渡すだけで、断る・選ぶ・並べるといった判定は持たない（判定は呼ぶ側の道具が持つ）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 道具の置き場（scripts/。部品が読む道具の側のモジュール）
sys.path.insert(0, str(Path(__file__).resolve().parent))


def exam_of_question_id(qid: str) -> str:
    """"2024r06-q53" → "2024r06"。"""
    return qid.rsplit("-q", 1)[0]


def materials_of(chosen: dict) -> dict[int, dict]:
    """論点 ID → 選んだ教材（material_generations.select_materials の結果から教材の中身だけを取り出す）。"""
    return {tid: c.material for tid, c in chosen.items()}


def load_materials(d: Path) -> dict[int, dict]:
    """論点 ID → 配る本文の教材。選び方は scripts/material_generations.py の select_materials。"""
    from material_generations import select_materials
    return materials_of(select_materials(d))


def topic_units(syllabus: dict[int, dict], topics: list[dict]) -> dict[int, int]:
    """論点 ID → 論点の小項目が属する単元の番号（小項目がシラバスに無ければ 0）。"""
    item_unit = {n: u for u, s in syllabus.items() for n in s["items"]}
    return {t["id"]: item_unit.get(t["syllabus_item"], 0) for t in topics}


def read_syllabus_units(d: Path) -> dict[int, dict]:
    """シラバスの単元。読み方と断り方は scripts/check_unit_plans.py の learning_files。"""
    from check_unit_plans import learning_files
    return learning_files(d)[0]


def read_topics(d: Path) -> list[dict]:
    """論点の一覧。読み方と断り方は scripts/check_unit_plans.py の learning_files。"""
    from check_unit_plans import learning_files
    return learning_files(d)[1]
