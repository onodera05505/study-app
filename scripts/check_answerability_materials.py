#!/usr/bin/env python3
"""教材だけで過去問が解けるかの検証結果を、正解表と突き合わせる。

    python3 scripts/check_answerability_materials.py

入力: data/answerability_results/bundle_*.json（build_answerability_bundles.py で作った
      バンドルを担当に解かせた結果）
      data/answer_keys.json

`scripts/check_answerability.py` が「読み取ったテキストだけで解けるか」を測るのに対し、
こちらは「**書いた教材だけで解けるか**」を測る。教材が学習コンテンツとして
成立しているかの下限を押さえるためのもの。

見る指標は2つ。

- **不正解** — 教材が足りない可能性。ただし単純な読み違いも混ざるので確定ではない
- **insufficient の申告** — 「教材だけでは決まらない」という自己申告。
  一般知識で正解できてしまう問題でも欠落を拾えるので、こちらのほうが信号として強い

**両方に該当する問題が最優先の直し先。**
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    ap.add_argument("--results", default="data/answerability_results", type=Path)
    ap.add_argument("--top", type=int, default=30)
    args = ap.parse_args()

    keys = json.loads((args.data / "answer_keys.json").read_text(encoding="utf-8"))

    def correct_of(qid):
        exam, _, num = qid.rpartition("-q")
        return keys.get(exam, {}).get(num)

    rows = []
    for path in sorted(args.results.glob("*.json")):
        for a in json.loads(path.read_text(encoding="utf-8")).get("answers", []):
            rows.append(a)

    if not rows:
        print(f"{args.results} に結果がありません。")
        return 0

    wrong, insufficient, both = [], [], []
    by_topic: dict[int, list] = defaultdict(list)
    scored = 0
    for a in rows:
        key = correct_of(a["question_id"])
        if key is None:
            continue
        scored += 1
        is_wrong = (a.get("answer") or "").strip() != key
        is_insuf = a.get("sufficient") is False
        a["_correct"] = key
        a["_wrong"] = is_wrong
        by_topic[a.get("topic_id")].append(a)
        if is_wrong:
            wrong.append(a)
        if is_insuf:
            insufficient.append(a)
        if is_wrong and is_insuf:
            both.append(a)

    print(f"照合: {scored} 問")
    print(f"  正答          : {scored - len(wrong)} / {scored}（{(scored - len(wrong)) / scored:.0%}）")
    print(f"  教材不足の申告: {len(insufficient)} 問（{len(insufficient) / scored:.0%}）")
    print(f"  不正解かつ申告: {len(both)} 問 ← 最優先")

    def show(title: str, items: list) -> None:
        if not items:
            return
        print(f"\n■ {title} {len(items)} 件")
        for a in items[: args.top]:
            print(f"  - [{a['question_id']}] {a.get('term')}（id={a.get('topic_id')}）"
                  f" 解答 {a.get('answer')} / 正解 {a['_correct']}")
            if a.get("missing"):
                print(f"      不足: {a['missing'][:160]}")
        if len(items) > args.top:
            print(f"  … 他 {len(items) - args.top} 件")

    show("不正解かつ教材不足の申告あり", both)
    show("教材不足の申告のみ（一般知識で正解できてしまった）",
         [a for a in insufficient if not a["_wrong"]])
    show("不正解だが教材は足りているとの申告（読み違いの可能性）",
         [a for a in wrong if a.get("sufficient") is not False])

    bad_topics = sorted(
        ((tid, [a for a in v if a["_wrong"] or a.get("sufficient") is False], v) for tid, v in by_topic.items()),
        key=lambda x: -len(x[1]),
    )
    bad_topics = [(t, b, v) for t, b, v in bad_topics if b]
    if bad_topics:
        print(f"\n■ 問題を抱える論点 {len(bad_topics)} 件（要直し）")
        for tid, bad, all_ in bad_topics[: args.top]:
            print(f"  - id={tid} {bad[0].get('term')}: {len(bad)}/{len(all_)} 問")

    return 1 if both else 0


if __name__ == "__main__":
    sys.exit(main())
