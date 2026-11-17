#!/usr/bin/env python3
"""教材の世代の選び方の 1 か所。配る本文を組み立てる道具も、図の差し込み・図の仕様の検査・描画の検査も、ここから選ぶ。

世代は学びの置き場の直下の `materials`・`materials_v<番号>` のディレクトリ。`materials` を 1 番目とし、
番号の小さい順に重ねる。同じ論点が複数の世代にあれば、最も新しい世代の物を選ぶ。同じ世代の中では
ファイル名の順に読み、後のファイルの物を選ぶ。

    python3 scripts/material_generations.py --data data/ip [--registered]

は、選んだ教材を論点ごとに世代の名前とファイルを添えて標準出力に JSON で出す（TypeScript の道具が読む）。
`--registered` を渡すと登録簿に無い学びを断り、`--refusal-only` を足すと断るかどうかだけを見る（通れば何も出さない）。

UC-027 の道具が学びを断るときの判定（learning_refusal）と出し方（emit_refusal）もここに置く。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from targets import targets  # noqa: E402

GENERATION_DIR = re.compile(r"^materials(?:_v([0-9]+))?$")

# 書き直した世代の始まりの番号。`materials_v<この番号>` 以降の世代が書き直した世代
REWRITTEN_FROM = 4


@dataclass
class Chosen:
    """論点ごとに選んだ教材。generation は世代のディレクトリの名前、path はその教材があったファイル。"""
    generation: str
    path: Path
    material: dict


# @implements REQ-471
def generation_dirs(d: Path) -> list[Path]:
    """学びの置き場にある教材の世代のディレクトリを、古い順に返す。"""
    if not d.is_dir():
        return []
    found = []
    for p in d.iterdir():
        mo = GENERATION_DIR.match(p.name)
        if mo and p.is_dir():
            found.append((int(mo.group(1) or 1), p.name, p))
    return [p for _, _, p in sorted(found)]


# @implements REQ-467
def select_materials(d: Path) -> dict[int, Chosen]:
    """論点 ID → 選んだ教材。世代を古い順に重ね、後の世代・後のファイルの物で上書きする。"""
    out: dict[int, Chosen] = {}
    for g in generation_dirs(d):
        for path in sorted(g.glob("*.json")):
            for m in json.loads(path.read_text(encoding="utf-8")).get("materials", []):
                out[m["topic_id"]] = Chosen(g.name, path, m)
    return out


def is_rewritten(generation: str) -> bool:
    """世代のディレクトリの名前が書き直した世代か。"""
    mo = GENERATION_DIR.match(generation)
    return bool(mo and mo.group(1)) and int(mo.group(1)) >= REWRITTEN_FROM


# @implements REQ-487
def learning_refusal(d: Path, *, registered: bool) -> dict | None:
    """学びを断るときの ToolError、断らなければ None。
    registered なら登録簿に無い学び（末尾の名前が登録簿の key でない）を INVALID_INPUT で、そうでなければ
    学びの置き場が無い学びを NOT_FOUND で断る。"""
    if registered and d.name not in targets():
        return {"error": {"code": "INVALID_INPUT", "reason": f"登録簿に無い学び『{d.name}』"}}
    if not registered and not d.is_dir():
        return {"error": {"code": "NOT_FOUND", "reason": f"学びの置き場が無い: {d}"}}
    return None


# @implements REQ-487
def emit_refusal(refusal: dict) -> int:
    """断りを標準出力に 1 つ出し、人が読む理由を標準エラーに出して、終了コード 1 を返す。"""
    print(refusal["error"]["reason"], file=sys.stderr)
    print(json.dumps(refusal, ensure_ascii=False))
    return 1


def materials_of(chosen: dict[int, Chosen]) -> dict[int, dict]:
    return {tid: c.material for tid, c in chosen.items()}


# @implements REQ-471
def generation_counts(chosen: dict[int, Chosen]) -> dict[str, int]:
    """世代の名前 → その世代から選んだ論点の数（古い世代から順に、1 つも選ばなかった世代は出さない）。"""
    counts: dict[str, int] = {}
    for c in chosen.values():
        counts[c.generation] = counts.get(c.generation, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: (_number(kv[0]), kv[0])))


def _number(name: str) -> int:
    mo = GENERATION_DIR.match(name)
    return int(mo.group(1) or 1) if mo else 0


# @implements REQ-471, REQ-487
def main() -> int:
    ap = argparse.ArgumentParser(description="論点ごとに選んだ教材の世代と中身を JSON で出す")
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--registered", action="store_true", help="登録簿に無い学びを断る")
    ap.add_argument("--refusal-only", action="store_true", help="断るかどうかだけを見る")
    args = ap.parse_args()
    if args.registered:
        refusal = learning_refusal(args.data, registered=True)
        if refusal:
            return emit_refusal(refusal)
    if args.refusal_only:
        return 0
    chosen = select_materials(args.data)
    json.dump({
        "topicsByGeneration": generation_counts(chosen),
        "materials": [
            {**c.material, "topic_id": tid, "_generation": c.generation, "_file": c.path.name}
            for tid, c in sorted(chosen.items())
        ],
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
