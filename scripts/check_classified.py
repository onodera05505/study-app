#!/usr/bin/env python3
"""分類結果を機械で検証する。担当の自己申告は当てにしない。

    python3 scripts/check_classified.py --data data/ap --count 80

見るのは4点。

1. **網羅** — 1回ぶんの全問が分類されているか。抜けがあると出題頻度の集計が狂う。
   重複（2人が同じ問を分類した）も検出する
2. **分野の一致** — 応用情報は解答例 PDF に公式の分野がある。担当が選んだ
   シラバス項目の分野と食い違っていたら、項目の選択が間違っている
3. **項目番号の妥当性** — 存在しない番号を書いていないか
4. **`topic_is_new` の整合** — 「用語例にある」と申告した論点が、本当に
   その項目の `terms` にあるか。無いなら表記を変えてしまっている

67体で書き直したとき、担当していない論点番号を report してきた例が複数あった
（ファイルの中身は正しかった）。**報告文ではなく成果物を見る。**
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ap", type=Path)
    ap.add_argument("--count", type=int, default=80, help="1回あたりの問題数")
    args = ap.parse_args()
    d = args.data

    items = {i["number"]: i for i in json.loads((d / "syllabus.json").read_text(encoding="utf-8"))["items"]}
    fields_path = d / "question_fields.json"
    official = json.loads(fields_path.read_text(encoding="utf-8")) if fields_path.exists() else {}

    problems = 0
    total = 0
    for exam_dir in sorted((d / "classified").glob("*")):
        if not exam_dir.is_dir():
            continue
        exam = exam_dir.name
        seen: Counter[int] = Counter()
        rows: dict[int, dict] = {}
        for batch in sorted(exam_dir.glob("batch_*.json")):
            data = json.loads(batch.read_text(encoding="utf-8"))
            for c in data.get("classifications", []):
                seen[c["number"]] += 1
                rows[c["number"]] = {**c, "_file": batch.name}

        missing = [n for n in range(1, args.count + 1) if n not in seen]
        dup = [n for n, k in seen.items() if k > 1]
        extra = [n for n in seen if n < 1 or n > args.count]
        bad_item, bad_field, bad_new = [], [], []
        for n, c in sorted(rows.items()):
            it = items.get(c.get("syllabus_item"))
            if it is None:
                bad_item.append(f"問{n}: 項目{c.get('syllabus_item')} は存在しない")
                continue
            want = official.get(exam, {}).get(str(n))
            if want and it["field"] != want:
                bad_field.append(f"問{n}: 公式は{want} なのに 項目{it['number']}（{it['field']}）")
            term = (c.get("topic_term") or "").strip()
            if not c.get("topic_is_new") and term not in it["terms"]:
                bad_new.append(f"問{n}: 『{term}』は項目{it['number']}の用語例に無いのに topic_is_new=false")

        ok = not (missing or dup or extra or bad_item or bad_field)
        total += len(rows)
        print(f"{exam}: {len(rows)}/{args.count} 問  {'OK' if ok else '要確認'}")
        for label, xs in (
            ("分類されていない問", missing),
            ("重複して分類された問", dup),
            ("範囲外の問番号", extra),
            ("項目番号が不正", bad_item),
            ("公式の分野と食い違う", bad_field),
        ):
            if xs:
                problems += len(xs)
                print(f"  [誤り] {label} {len(xs)} 件: {xs[:10]}")
        if bad_new:
            # これは誤りとは限らない。他項目の用語例からコピーする運用を認めているため、
            # 数だけ出して中身は先頭数件にとどめる
            print(f"  [参考] 選んだ項目の用語例に無い論点 {len(bad_new)} 件（他項目からのコピーなら正常）")
            for x in bad_new[:3]:
                print(f"    {x}")

    print(f"\n合計 {total} 問。誤り {problems} 件。")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
