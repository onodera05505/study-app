#!/usr/bin/env python3
"""応用情報（午前）と基本情報（科目A）の解答例 PDF から、正解記号と分野を抽出する。

    python3 scripts/extract_answer_keys_ap.py                 # 応用情報（data/ap）
    python3 scripts/extract_answer_keys_ap.py --data data/fe   # 基本情報 科目A

出力（`--data` の下）:
    data/ap/answer_keys.json     {"2025r07a": {"1": "エ", ...}}
    data/ap/question_fields.json {"2025r07a": {"1": "テクノロジ系", ...}}

読む PDF は `<data>/pdfs/*_<試験>_am_ans.pdf`。`<試験>` は `--data` の末尾の名前（ap / fe）
を使う。データ置き場の名前＝対象のキー＝解答例のファイル名の試験コード、で揃えてある。

**IT パスポートとの決定的な違いは、分野が公式に付いていること。**
IP の公開問題には分野タグが無いので自前で分類していたが、応用情報と基本情報の解答例には
「問番号 / 正解 / 分野」の3列があり、分野は Ｔ（テクノロジ系）Ｍ（マネジメント系）
Ｓ（ストラテジ系）の全角カタカナで入っている。合否は分野ごとの基準にも左右されるので、
ここが公式に取れる意味は大きい。

解答例 PDF にはテキストレイヤーがあるので機械抽出できる。問題冊子のほうは
画像なので、そちらは別途ページ画像にして読み取る（IP と同じ流れ）。

**ただし全回ではない。** 応用情報の令和4年度春期の解答例だけはスキャン画像で、
テキストレイヤーが無い（抽出すると 0 問になる）。この回はページ画像を人が読んで
`<data>/answer_keys_manual.json` に書いてある。ここでマージするので、
再実行しても消えない。同じ回が他にもあれば、同じファイルに足せばよい。
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

try:
    import pypdf
except ImportError:
    sys.exit("pypdf が必要です:  pip install pypdf")

QUESTIONS_PER_EXAM = 80

FIELD = {
    "Ｔ": "テクノロジ系",
    "Ｍ": "マネジメント系",
    "Ｓ": "ストラテジ系",
    "T": "テクノロジ系",
    "M": "マネジメント系",
    "S": "ストラテジ系",
}

# 「問 12 イ Ｔ」。問番号と正解の間、正解と分野の間に空白が入ることがある。
# 最終行だけ分野が欠ける回があるので、分野は任意にしておく。
ROW = re.compile(r"問\s*(\d{1,3})\s*([アイウエ])\s*([ＴＭＳTMS])?")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ap", type=Path, help="対象のデータ置き場。基本情報は data/fe")
    ap.add_argument("--pdf-dir", default=None, type=Path, help="既定は <data>/pdfs")
    ap.add_argument("--out", default=None, type=Path, help="既定は <data>/answer_keys.json")
    ap.add_argument("--fields-out", default=None, type=Path, help="既定は <data>/question_fields.json")
    ap.add_argument("--manual", default=None, type=Path,
                    help="テキストレイヤーが無い回の、人が読んだ正解表。既定は <data>/answer_keys_manual.json")
    args = ap.parse_args()
    exam_code = args.data.name
    args.pdf_dir = args.pdf_dir or args.data / "pdfs"
    args.out = args.out or args.data / "answer_keys.json"
    args.fields_out = args.fields_out or args.data / "question_fields.json"
    args.manual = args.manual or args.data / "answer_keys_manual.json"

    # 自動抽出が空になる回の受け皿。{"2022r04h": {"1": ["ア", "T"], …}}
    manual: dict[str, dict[str, list[str]]] = {}
    if args.manual.exists():
        manual = {
            k: v for k, v in json.loads(args.manual.read_text(encoding="utf-8")).items()
            if not k.startswith("_")
        }

    keys: dict[str, dict[str, str]] = {}
    fields: dict[str, dict[str, str]] = {}
    problems: list[str] = []

    pdfs = sorted(args.pdf_dir.glob(f"*_{exam_code}_am_ans.pdf"))
    if not pdfs:
        sys.exit(f"{args.pdf_dir} に解答例の PDF（*_{exam_code}_am_ans.pdf）がありません")
    for pdf in pdfs:
        exam = pdf.name.split("_", 1)[0]
        text = "\n".join(page.extract_text() or "" for page in pypdf.PdfReader(pdf).pages)

        answers: dict[str, str] = {}
        by_field: dict[str, str] = {}
        for num, mark, f in ROW.findall(text):
            answers[num] = mark
            if f and f in FIELD:
                by_field[num] = FIELD[f]

        # 人が読んだぶんを上書きする（テキストレイヤーが無い回はこちらが唯一の情報源）
        for num, (mark, f) in manual.get(exam, {}).items():
            answers[num] = mark
            if f in FIELD:
                by_field[num] = FIELD[f]

        keys[exam] = answers
        fields[exam] = by_field

        missing = [n for n in range(1, QUESTIONS_PER_EXAM + 1) if str(n) not in answers]
        no_field = [n for n in range(1, QUESTIONS_PER_EXAM + 1) if str(n) not in by_field]
        status = f"{len(answers)}/{QUESTIONS_PER_EXAM}"
        print(f"{exam}: 正解 {status}  分野 {len(by_field)}/{QUESTIONS_PER_EXAM}")
        if missing:
            problems.append(f"{exam}: 正解が取れなかった問 {missing}")
        if no_field:
            print(f"  分野が取れなかった問: {no_field}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")
    args.fields_out.write_text(json.dumps(fields, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum(len(v) for v in keys.values())
    print(f"\n→ {args.out}（{len(keys)} 回 / {total} 問）")
    print(f"→ {args.fields_out}")

    dist = Counter(f for v in fields.values() for f in v.values())
    for name, n in dist.most_common():
        print(f"  {name}: {n} 問")

    if problems:
        print("\n[警告]", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
