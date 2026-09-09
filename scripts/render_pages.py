#!/usr/bin/env python3
"""問題冊子 PDF のページを PNG 画像に書き出す。

問題冊子はスキャン画像のみでテキストを持たないため、読み取りはページ画像を
ビジョンモデルに渡す形で行う。その前段としてページを画像化する。

    python3 scripts/render_pages.py 2024r06
    python3 scripts/render_pages.py 2024r06 --dpi 200 --out data/pages

埋め込み画像の実寸は 1432x2026px（≒175dpi 相当）なので、dpi を上げても
情報量は増えない。既定の 200dpi は元画像をわずかに上回る程度で、文字の
輪郭が潰れないようにするためのマージン。
"""

import argparse
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF が必要です:  pip install pymupdf")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exam", help="回の識別子。例: 2024r06, 2019h31h, 2025r07a")
    ap.add_argument("--pdf-dir", default="data/ip/pdfs", type=Path)
    ap.add_argument("--out", default="data/ip/pages", type=Path)
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()

    # 問題冊子のファイル名は試験ごとに違う。
    #   IT パスポート … 2024r06_ip_qs.pdf
    #   応用情報 午前 … 2025r07a_ap_am_qs.pdf
    candidates = [f"{args.exam}_ip_qs.pdf", f"{args.exam}_ap_am_qs.pdf"]
    pdf_path = next((args.pdf_dir / n for n in candidates if (args.pdf_dir / n).exists()), None)
    if pdf_path is None:
        sys.exit(
            f"{args.pdf_dir} に {' / '.join(candidates)} がありません。"
            "先に fetch_pdfs.py（または fetch_pdfs_ap.py）を実行してください"
        )

    out_dir = args.out / args.exam
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    for i, page in enumerate(doc, start=1):
        dest = out_dir / f"p{i:03d}.png"
        page.get_pixmap(dpi=args.dpi).save(dest)

    total = sum(f.stat().st_size for f in out_dir.glob("*.png"))
    print(f"{doc.page_count} 頁を {out_dir} に書き出しました ({total // 1024 // 1024} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
