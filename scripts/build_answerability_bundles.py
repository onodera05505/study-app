#!/usr/bin/env python3
"""「教材だけを読んで過去問が解けるか」を試すためのバンドルを作る。

    python3 scripts/build_answerability_bundles.py --size 20
    python3 scripts/build_answerability_bundles.py --calc-only   # 計算問題を含む論点だけ

出力: data/answerability_bundles/bundle_NN.json

教材が「その論点に紐づく過去問を解くのに足りているか」は、字面の検査では分からない。
「公式を暗記していなくても」と書いてありながら式が無い、といった欠落は、
書き手にも検証スクリプトにも見えない。**実際に解かせて突き合わせるしかない。**

そこで、**正解を伏せた**問題と教材だけを渡して解かせ、正解表と照合する。
`data/answer_keys.json` を読ませてはいけない（答えを見て解けてしまう）。

判定に使うのは2つ。

- **不正解** — 教材が足りない可能性がある。ただし単純な読み違いもあるので確定ではない
- **insufficient の申告** — 「教材だけでは決まらない」という自己申告。
  一般知識で答えられてしまう問題でも欠落を拾えるので、こちらのほうが信号として強い

注意: 担当は IT パスポートの知識を持っているので、教材が空でも正解できてしまう。
だから「教材のどこを根拠にしたか」を必ず書かせる。根拠が書けない＝教材に無い。
"""

import argparse
import json
import re
import sys
from pathlib import Path

CALC = re.compile(r"(何個|何円|何人|何日|何時間|何倍|いくら|求め|算出|百分率|パーセント|％|%|割合|平均|合計)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    ap.add_argument("--out", default="data/answerability_bundles", type=Path)
    ap.add_argument("--size", type=int, default=20, help="1バンドルあたりの論点数")
    ap.add_argument("--calc-only", action="store_true", help="計算問題を含む論点だけを対象にする")
    ap.add_argument("--only", type=int, nargs="*", help="指定した論点 ID だけを対象にする")
    ap.add_argument("--skip-done", action="store_true",
                    help="data/answerability_results に結果がある論点を除く")
    ap.add_argument("--strip-pattern", action="store_true",
                    help="教材から「出題パターン」節を落として渡す（原理から導けるかを測る）")
    args = ap.parse_args()
    d = args.data

    done: set[int] = set()
    if args.skip_done:
        for path in sorted(Path("data/answerability_results").glob("bundle_*.json")):
            for a in json.loads(path.read_text(encoding="utf-8")).get("answers", []):
                done.add(a.get("topic_id"))

    topics = json.loads((d / "topics.json").read_text(encoding="utf-8"))["topics"]

    materials: dict[int, dict] = {}
    for sub in ("materials", "materials_v2"):
        for path in sorted((d / sub).glob("*.json")):
            for m in json.loads(path.read_text(encoding="utf-8")).get("materials", []):
                materials[m["topic_id"]] = m

    questions: dict[str, dict] = {}
    for path in sorted((d / "questions").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for q in data["questions"]:
            questions[f"{data['exam']}-q{q['number']}"] = q

    labels = json.loads((d / "exam_labels.json").read_text(encoding="utf-8"))

    def strip(detail):
        """「出題パターン」節を落とす。

        この節には過去問の正解がほぼ名指しで書かれている。付けたまま解かせると
        教材の充足度ではなく「答えが書いてあるか」を測ることになってしまう。
        落として解かせると「原理から導けるか」が見える。
        """
        if not detail or not args.strip_pattern:
            return detail
        out, skipping = [], False
        for line in detail.split("\n"):
            if line.startswith("### "):
                skipping = "出題" in line
            if not skipping:
                out.append(line)
        return "\n".join(out).strip()

    targets = []
    for t in topics:
        m = materials.get(t["id"])
        if not m:
            continue
        qs = []
        for link in t["questions"]:
            qid = f"{link['exam']}-q{link['number']}"
            q = questions.get(qid)
            if not q:
                continue
            qs.append({
                "question_id": qid,
                "exam": labels.get(link["exam"], link["exam"]),
                "number": q["number"],
                "text": q["text"],
                "choices": q["choices"],
                # 正解は入れない。入れると教材を読まずに答えられてしまう
                "figure_description": q.get("figure_description"),
            })
        if not qs:
            continue
        if args.only and t["id"] not in args.only:
            continue
        if t["id"] in done:
            continue
        if args.calc_only and not any(CALC.search(q["text"]) and re.search(r"\d", q["text"]) for q in qs):
            continue
        targets.append({
            "topic_id": t["id"],
            "term": t["term"],
            "question_count": t["question_count"],
            "material": {"explanation": m.get("explanation"), "detail": strip(m.get("detail"))},
            "questions": qs,
        })

    targets.sort(key=lambda x: (-x["question_count"], x["topic_id"]))

    if args.out.exists():
        for f in args.out.glob("*.json"):
            f.unlink()
    args.out.mkdir(parents=True, exist_ok=True)

    n = 0
    for i in range(0, len(targets), args.size):
        n += 1
        chunk = targets[i : i + args.size]
        (args.out / f"bundle_{n:02d}.json").write_text(
            json.dumps({"bundle": n, "topics": chunk}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    total_q = sum(len(t["questions"]) for t in targets)
    print(f"→ {args.out}/bundle_01.json 〜 bundle_{n:02d}.json")
    print(f"  対象論点 : {len(targets)}")
    print(f"  対象問題 : {total_q}")
    print(f"  1バンドル: 最大 {args.size} 論点")
    return 0


if __name__ == "__main__":
    sys.exit(main())
