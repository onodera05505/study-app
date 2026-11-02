#!/usr/bin/env python3
"""ロードマップ型の仕様書テンプレート（scripts/prompts/roadmap_*.md）に対象の値を埋めて data/<対象>/prompts/ に書き出す。

    python3 scripts/render_prompts.py --data data/itc

値は src/shared/targets.json の <対象>.roadmapSpec。担当（教材・問題・学習者役）には書き出した方を読ませる。
埋まらない {{…}} が残ったら止まる（対象の登録が不足）。
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ("roadmap_materials.md", "roadmap_questions.md", "roadmap_learner.md", "roadmap_explain_grader.md")

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True, type=Path)
    a = ap.parse_args(); key = a.data.name
    sys.path.insert(0, str(ROOT / "scripts")); from targets import target
    spec = dict(target(key).get("roadmapSpec") or {})
    spec.setdefault("targetName", target(key)["brand"])
    spec.setdefault("key", key)  # 入力・出力の置き場 data/{{key}}/ を対象ごとに描く
    rj = a.data / "roadmap.json"; rm = json.loads(rj.read_text(encoding="utf-8")) if rj.exists() else {}
    spec.setdefault("days", rm.get("days", 14)); spec.setdefault("perDay", rm.get("per_day", 3))  # 期間は roadmap 設定から（学習者役の文言が「2 週間・面接」決め打ちだった 2026-09-15）
    for k in ("reader", "taboo"):
        if isinstance(spec.get(k), list): spec[k] = "\n".join(f"- {x}" for x in spec[k])
    out = a.data / "prompts"; out.mkdir(parents=True, exist_ok=True)
    for name in TEMPLATES:
        text = (ROOT / "scripts" / "prompts" / name).read_text(encoding="utf-8")
        text = re.sub(r"<!-- テンプレート。.*?-->\n\n", "", text, flags=re.S)
        text = re.sub(r"\{\{(\w+)\}\}", lambda m: str(spec[m.group(1)]) if m.group(1) in spec else m.group(0), text)
        left = sorted(set(re.findall(r"\{\{(\w+)\}\}", text)))
        if left: sys.exit(f"{name}: 埋まらない値 {left}（src/shared/targets.json の {key}.roadmapSpec に足す）")
        (out / name).write_text(text, encoding="utf-8")
    print(f"→ {out}/（{len(TEMPLATES)} 本）")
    return 0

if __name__ == "__main__":
    sys.exit(main())
