#!/usr/bin/env python3
"""抽出した問題文だけを見て解いた結果を、正解表と突合して精度を測る。

読み取りが原文に忠実かどうかは、構造チェックでは分からない。そこで
「抽出テキストだけを渡して解かせ、正解率を見る」ことで内容の妥当性を
間接的に測る。正解率が低い問題は読み取りが壊れている可能性が高い。

    python3 scripts/check_answerability.py 2024r06

前提: data/answers/<exam>/batch_*.json に解答結果が入っていること。
      形式は {"answers": {"1": "エ", ...}, "unanswerable": [{"number": 8, "reason": "..."}]}

注意: 不正解の原因は「読み取りミス」と「単に解けなかった」の両方があり得る。
      この指標は読み取り品質の下限を示すものであって、上限ではない。
      特に unanswerable の申告は、図表の欠落を直接示す強い信号なので重視する。
"""

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exam")
    ap.add_argument("--answers-dir", default="data/ip/answers", type=Path)
    ap.add_argument("--questions-dir", default="data/ip/questions", type=Path)
    ap.add_argument("--key", default="data/ip/answer_keys.json", type=Path)
    args = ap.parse_args()

    keys = json.loads(args.key.read_text(encoding="utf-8")).get(args.exam)
    if not keys:
        sys.exit(f"{args.key} に {args.exam} の正解表がありません")

    qdata = json.loads((args.questions_dir / f"{args.exam}.json").read_text(encoding="utf-8"))
    meta = {q["number"]: q for q in qdata["questions"]}

    answers_dir = args.answers_dir / args.exam
    if not answers_dir.is_dir():
        sys.exit(f"{answers_dir} が無く、{args.exam} の解いた結果がありません")
    batches = sorted(answers_dir.glob("batch_*.json"))
    if not batches:
        sys.exit(f"{answers_dir} に batch_*.json が無く、{args.exam} の解いた結果がありません")

    given: dict[int, str] = {}
    unanswerable: dict[int, str] = {}
    for path in batches:
        data = json.loads(path.read_text(encoding="utf-8"))
        for k, v in data.get("answers", {}).items():
            given[int(k)] = v
        for item in data.get("unanswerable", []):
            unanswerable[int(item["number"])] = item.get("reason", "")

    wrong: list[int] = []
    for n in sorted(keys, key=int):
        num = int(n)
        if given.get(num) != keys[n]:
            wrong.append(num)

    total = len(keys)
    correct = total - len(wrong)
    fig_wrong = [n for n in wrong if meta.get(n, {}).get("has_figure")]

    print(f"{args.exam}: 正答 {correct}/{total} ({correct / total:.0%})")
    print(f"  未解答・解答欠落: {[n for n in range(1, total + 1) if n not in given]}")
    print(f"  不正解: {wrong}")
    print(f"    うち図表を含む問題: {fig_wrong}")
    if unanswerable:
        print(f"  テキストだけでは解けないと申告された問題 {len(unanswerable)} 件:")
        for n in sorted(unanswerable):
            flag = "図表あり" if meta.get(n, {}).get("has_figure") else "図表なし"
            print(f"    問{n} ({flag}): {unanswerable[n]}")

    print("\n要確認リスト（不正解 ∪ 解答不能の申告）:", sorted(set(wrong) | set(unanswerable)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
