#!/usr/bin/env python3
"""分類の担当に渡すバンドルを作る。

    python3 scripts/build_classify_bundles.py 2024r06h --data data/ap --size 27

出力: data/<data>/classify_bundles/<exam>/batch_NN.json

## なぜバンドルを作るのか（担当に生ファイルを読ませない理由）

応用情報のシラバス索引は 96 項目・5,142 用語で 200KB ある。担当ごとに丸ごと
読ませると、それだけで文脈の大半を食い潰し、肝心の問題文を読む余力が減る。

**分野は公式に確定している**（解答例 PDF の3列目、`question_fields.json`）。
だから担当が選ぶべき項目は、はじめから 96 ではなく「その問題の分野に属する項目」だけ。
バンドルにはその範囲の項目だけを入れる。候補が減れば取り違えも減る。

分野をまたぐバッチでは両方の分野の項目を入れる（応用情報は問番号順に分野が
並ぶので、境目のバッチだけがそうなる）。
"""

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exam")
    ap.add_argument("--data", default="data/ap", type=Path)
    ap.add_argument("--size", type=int, default=27, help="1バンドルあたりの問題数")
    args = ap.parse_args()
    d = args.data

    qdata = json.loads((d / "questions" / f"{args.exam}.json").read_text(encoding="utf-8"))
    if not (d / "question_fields.json").is_file():
        sys.exit(f"{d}/question_fields.json がありません（回の公式の分野。extract_answer_keys_ap.py で作る）")
    fields = json.loads((d / "question_fields.json").read_text(encoding="utf-8")).get(args.exam)
    if not fields:
        sys.exit(f"{d}/question_fields.json に {args.exam} がありません")

    items = json.loads((d / "syllabus_index.json").read_text(encoding="utf-8"))["items"]
    by_field: dict[str, list] = {}
    for it in items:
        by_field.setdefault(it["field"], []).append(it)

    out_dir = d / "classify_bundles" / args.exam
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in out_dir.glob("*.json"):
        f.unlink()

    qs = sorted(qdata["questions"], key=lambda q: q["number"])
    n = 0
    for i in range(0, len(qs), args.size):
        n += 1
        chunk = qs[i : i + args.size]
        used = sorted({fields[str(q["number"])] for q in chunk})
        # その分野に属する項目だけを候補として渡す。範囲外を選べないようにする
        cand = [it for fld in used for it in by_field.get(fld, [])]
        (out_dir / f"batch_{n:02d}.json").write_text(
            json.dumps({
                "exam": args.exam,
                "range": f"{chunk[0]['number']}-{chunk[-1]['number']}",
                "fields_in_range": used,
                "syllabus_candidates": cand,
                "questions": [
                    {
                        "number": q["number"],
                        # 分野は公式。担当は判断せずそのまま使う
                        "field": fields[str(q["number"])],
                        "text": q["text"],
                        "choices": q["choices"],
                        "figure_description": q.get("figure_description"),
                    }
                    for q in chunk
                ],
            }, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"  batch_{n:02d}: 問{chunk[0]['number']}〜{chunk[-1]['number']}"
              f"（{len(chunk)}問 / 分野 {'+'.join(used)} / 候補 {len(cand)} 項目）")

    print(f"→ {out_dir}/batch_01.json 〜 batch_{n:02d}.json")
    print("\n仕様: scripts/prompts/classify_questions.md を担当に必ず最初に読ませること。")
    print(f"出力先: {d}/classified/{args.exam}/batch_NN.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
