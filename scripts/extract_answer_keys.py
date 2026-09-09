#!/usr/bin/env python3
"""解答例 PDF から「問番号 → 正解記号」の対応を抽出して JSON に落とす。

問題冊子 PDF は全ページがスキャン画像でテキストを持たないが、解答例 PDF には
テキストレイヤーがあるため機械抽出できる。ここで得た正解表は、問題冊子を
OCR / ビジョンモデルで読み取った結果の突合検証に使う。

    python3 scripts/extract_answer_keys.py [--pdf-dir data/pdfs] [--out data/answer_keys.json]

出力形式:
    {"2024r06": {"1": "エ", "2": "イ", ...}, ...}

年度によって PDF 内のトークン分割が異なる（"問1" が 1 トークンの回と、
"問" + "1" に割れる回がある）ため、単語単位ではなく行を再構成してから
正規表現を当てている。全 29 回で 2900/2900 の抽出を確認済み。
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF が必要です:  pip install pymupdf")

QUESTIONS_PER_EXAM = 100
ROW_TOLERANCE = 4.0  # 同じ行とみなす y 座標の許容差 (pt)
PAIR_RE = re.compile(r"問\s*(\d{1,3})\s*([アイウエ])")


def extract_one(pdf_path: Path) -> dict[int, str]:
    """1 つの解答例 PDF から {問番号: 正解記号} を返す。"""
    doc = fitz.open(pdf_path)
    pairs: dict[int, str] = {}

    for page in doc:
        rows: dict[float, list[tuple[float, str]]] = defaultdict(list)
        for x0, y0, _x1, _y1, word, *_ in page.get_text("words"):
            for key in rows:
                if abs(key - y0) <= ROW_TOLERANCE:
                    rows[key].append((x0, word))
                    break
            else:
                rows[y0].append((x0, word))

        for y in sorted(rows):
            line = "".join(word for _, word in sorted(rows[y]))
            for m in PAIR_RE.finditer(line):
                pairs[int(m.group(1))] = m.group(2)

    return pairs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", default="data/ip/pdfs", type=Path)
    ap.add_argument("--out", default="data/ip/answer_keys.json", type=Path)
    args = ap.parse_args()

    files = sorted(args.pdf_dir.glob("*_ans.pdf"))
    if not files:
        sys.exit(f"{args.pdf_dir} に解答例 PDF がありません。先に fetch_pdfs.py を実行してください")

    keys: dict[str, dict[int, str]] = {}
    incomplete: list[tuple[str, list[int]]] = []

    for path in files:
        exam = path.name.replace("_ip_ans.pdf", "")
        pairs = extract_one(path)
        keys[exam] = dict(sorted(pairs.items()))
        missing = [n for n in range(1, QUESTIONS_PER_EXAM + 1) if n not in pairs]
        if missing:
            incomplete.append((exam, missing))
        print(f"  {exam:<18} {len(pairs):>3}/{QUESTIONS_PER_EXAM} {'OK' if not missing else '欠番: ' + str(missing)}")

    total = sum(len(v) for v in keys.values())
    expected = len(files) * QUESTIONS_PER_EXAM
    print(f"\n合計 {total} / {expected} 問")
    print("正解分布:", dict(Counter(a for v in keys.values() for a in v.values())))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(keys, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {args.out}")

    if incomplete:
        print(f"\n{len(incomplete)} 回で欠番があります。PDF のレイアウトが想定と違う可能性があります",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
