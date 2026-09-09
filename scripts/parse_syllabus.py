#!/usr/bin/env python3
"""IPA のシラバス PDF を構造化して JSON に落とす。

過去問には分野タグが付いていないため、分類の受け皿を自前で用意する必要がある。
シラバスは 分野 → 大分類 → 中分類 → 項目 の階層を持っており、これをそのまま
アプリのテーマ分けに使う。

さらに各項目には**用語例**（IPA が「知識として習得すべき用語・キーワード例」
として明示している語）が列挙されている。これは論点マスタの出発点として使える。
論点を自分で発明するより、公式が挙げている用語に紐づけるほうが網羅性の根拠になる。

    python3 scripts/parse_syllabus.py

入力: data/syllabus_ip_ver6_5.pdf
出力: data/syllabus.json

シラバス PDF はテキストレイヤーを持つので、問題冊子と違って素直に読める。
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF が必要です:  pip install pymupdf")

FIELDS = ("ストラテジ系", "マネジメント系", "テクノロジ系")
EXPECTED_ITEMS = 63
EXPECTED_MIDDLE = 23

RE_CATEGORY = re.compile(r"^大分類(\d+)：(.+?)\s+中分類(\d+)：(.+)$")
RE_ITEM = re.compile(r"^(\d+)\.\s*(\S.*)$")
# 項目17・60 のように、番号だけが1行を占め項目名が次行に来るケースがある
RE_ITEM_NUMBER_ONLY = re.compile(r"^(\d+)\.$")
RE_TERMS_START = re.compile(r"^用語例\s*(.*)$")
RE_FOOTER = re.compile(r"^-\s*\d+\s*-$")
# 用語例ブロックの終わりを示す行
RE_BLOCK_END = re.compile(r"^(・|①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|\(\d+\)|【|活用例|大分類\d+：|\d+\.|Copyright)")


def split_terms(blob: str) -> list[str]:
    """全角カンマ区切りの用語列を分割する。括弧の中のカンマでは切らない。

    「MVV（ミッション，ビジョン，バリュー）」のように括弧内にカンマを含む
    用語があるため、単純な split では壊れる。
    """
    terms, depth, buf = [], 0, []
    for ch in blob:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if ch == "，" and depth == 0:
            terms.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    terms.append("".join(buf))

    cleaned = []
    for t in terms:
        t = re.sub(r"\s+", " ", t).strip()
        # PDF の行折り返しで日本語の途中に空白が入る
        # （「プロジェクトコミュニ ケーションマネジメント」）。
        # 日本語どうしの間の空白だけ詰め、英字の語間（"Corporate Social
        # Responsibility"）は残す。
        t = re.sub(r"(?<=[^\x00-\x7F])\s+(?=[^\x00-\x7F])", "", t)
        t = re.sub(r"\s+(?=[）)：])", "", t)
        t = re.sub(r"(?<=[（(])\s+", "", t)
        t = t.strip().strip("，、")
        if t:
            cleaned.append(t)
    return cleaned


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default="data/ip/syllabus_ip_ver6_5.pdf", type=Path)
    ap.add_argument("--out", default="data/ip/syllabus.json", type=Path)
    ap.add_argument("--start-page", type=int, default=8, help="本文の開始ページ（1始まり）")
    args = ap.parse_args()

    if not args.pdf.exists():
        sys.exit(f"{args.pdf} がありません")

    doc = fitz.open(args.pdf)
    lines: list[str] = []
    for i in range(args.start_page - 1, doc.page_count):
        lines.extend(ln.rstrip() for ln in doc[i].get_text().split("\n"))

    field = None
    category = None  # (大分類番号, 大分類名, 中分類番号, 中分類名)
    items: list[dict] = []
    collecting: list[str] | None = None  # 用語例を複数行にわたって集める

    def flush_terms():
        nonlocal collecting
        if collecting is not None and items:
            items[-1]["terms"].extend(split_terms(" ".join(collecting)))
        collecting = None

    def next_nonempty(start: int) -> str:
        for j in range(start, min(start + 5, len(lines))):
            s = lines[j].strip()
            if s and not RE_FOOTER.match(s) and not s.startswith("Copyright"):
                return s
        return ""

    skip_until = -1
    for idx, raw in enumerate(lines):
        if idx < skip_until:
            continue
        line = raw.strip()
        if not line or RE_FOOTER.match(line) or line.startswith("Copyright"):
            continue

        if line in FIELDS:
            flush_terms()
            field = line
            continue

        m = RE_CATEGORY.match(line)
        if m:
            flush_terms()
            category = (int(m.group(1)), m.group(2).strip(), int(m.group(3)), m.group(4).strip())
            continue

        m = RE_TERMS_START.match(line)
        if m:
            flush_terms()
            collecting = [m.group(1)]
            continue

        if collecting is not None:
            if RE_BLOCK_END.match(line):
                flush_terms()
            else:
                collecting.append(line)
                continue

        # 項目番号は 1..63 の通し番号。次に来るべき番号だけ受け入れることで、
        # 本文中の「1. 〜」や奥付の「2026.1」といった紛らわしい行を弾く。
        number = name = None
        m = RE_ITEM.match(line)
        if m:
            number, name = int(m.group(1)), m.group(2).strip()
        else:
            m = RE_ITEM_NUMBER_ONLY.match(line)
            if m:
                number, name = int(m.group(1)), next_nonempty(idx + 1)
                skip_until = idx + 2

        if number == len(items) + 1 and name and field and category:
            flush_terms()
            items.append({
                "number": number,
                "name": name,
                "field": field,
                "major_no": category[0],
                "major": category[1],
                "middle_no": category[2],
                "middle": category[3],
                "terms": [],
            })
    flush_terms()

    # 重複を除きつつ順序を保つ
    for it in items:
        it["terms"] = list(dict.fromkeys(it["terms"]))

    middles = {(it["field"], it["major_no"], it["major"], it["middle_no"], it["middle"]) for it in items}
    total_terms = sum(len(it["terms"]) for it in items)

    out = {
        "version": "Ver.6.5",
        "source": "https://www.ipa.go.jp/shiken/syllabus/omgdg50000005kn1-att/syllabus_ip_ver6_5.pdf",
        "item_count": len(items),
        "term_count": total_terms,
        "items": items,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"→ {args.out}")
    print(f"  分野   : {len({it['field'] for it in items})} / 3")
    print(f"  中分類 : {len(middles)} / {EXPECTED_MIDDLE}")
    print(f"  項目   : {len(items)} / {EXPECTED_ITEMS}")
    print(f"  用語例 : {total_terms} 語")

    # 用語例を持たない項目が実在する（要件定義・離散数学・OS・オフィスツール・
    # データ操作の5つ）。原文を確認済みで、パーサーの取りこぼしではない。
    empty = [it["number"] for it in items if not it["terms"]]
    if empty:
        print(f"  用語例なし: 項目 {empty}（シラバス原文にも記載がない）")

    problems = []
    if len(items) != EXPECTED_ITEMS:
        problems.append(f"項目数が {len(items)}（{EXPECTED_ITEMS} であるべき）")
    if len(middles) != EXPECTED_MIDDLE:
        problems.append(f"中分類数が {len(middles)}（{EXPECTED_MIDDLE} であるべき）")

    if problems:
        print("\n検証で問題あり:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print("\n検証: 問題なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
