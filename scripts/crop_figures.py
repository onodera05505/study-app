#!/usr/bin/env python3
"""図を含む問題について、ページ画像から図の領域だけを切り出す。

    python3 scripts/crop_figures.py

入力: data/figures/boxes.json
      {"2024r06-q67": {"page": 30, "x0": 0.30, "y0": 0.60, "x1": 0.75, "y1": 0.76}}
      座標はページに対する比率（0〜1）。左上が (0,0)。
出力: public/figures/<exam>-q<N>.png

## なぜ画像が要るか

図表は `figure_description` に文章として書き起こしてある。実際、抽出の品質検証では
図表つき64問すべてが「文章だけで解答可能」と判定された。

ただし**解けることと、学習しやすいことは別**。ブロック図やアローダイアグラムは、
文章で「左から線が入り分岐して2つの箱が並列に…」と読むより、図を見たほうが速い。
本番の試験でも図で出るのだから、図で慣れておくほうが実戦的でもある。

そこで、**表や擬似言語は文章のまま**（そのほうが読みやすい）、**図として描かれている
ものだけ画像を添える**という切り分けにした。対象は13問（400問中）。

`public/` に置くのは、Vite のビルドで `dist/` にコピーされ、Workers Assets から
そのまま配信されるため。
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF が必要です:  pip install pymupdf")

# 切り出しの余白（ページ幅・高さに対する比率）。図の縁が切れるのを防ぐ。
MARGIN = 0.01


def load_boxes(path: Path) -> dict:
    """切り出し範囲を読む。ディレクトリを渡すと `boxes*.json` を全部まとめる。

    回ごとに `boxes_2020r02o.json` を作って、あとで統合ファイルへ写す運用だった。
    写し忘れると**統合ファイルにだけ載っていない回**ができ、再生成したときに
    その回の画像が黙って消える（実際に応用情報で 40枚中27枚がこの状態になった）。
    ディレクトリを渡せば写し忘れが起きない。
    """
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))

    merged: dict = {}
    source: dict[str, str] = {}
    for f in sorted(path.glob("boxes*.json")):
        for qid, box in json.loads(f.read_text(encoding="utf-8")).items():
            if qid.startswith("_"):
                continue
            if qid in merged and merged[qid] != box:
                print(f"  [警告] {qid} の範囲が {source[qid]} と {f.name} で違う。{f.name} を使う")
            merged[qid] = box
            source[qid] = f.name
    if not merged:
        sys.exit(f"{path} に boxes*.json がありません")
    return merged


def main() -> int:
    ap = argparse.ArgumentParser()
    # ファイルでもディレクトリでもよい。ディレクトリなら boxes*.json を全部読む。
    ap.add_argument("--boxes", default="data/figures/boxes.json", type=Path)
    ap.add_argument("--pdf-dir", default="data/ip/pdfs", type=Path)
    ap.add_argument("--out", default="public/figures", type=Path)
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()

    if not args.boxes.exists():
        sys.exit(f"{args.boxes} がありません")
    boxes = load_boxes(args.boxes)
    args.out.mkdir(parents=True, exist_ok=True)

    docs: dict[str, fitz.Document] = {}
    written = []
    problems = []

    for qid, box in sorted(boxes.items()):
        if qid.startswith("_"):  # コメント用のキー
            continue
        exam = qid.split("-q")[0]
        if exam not in docs:
            # 試験ごとにファイル名が違う（ip は `_ip_qs`、応用情報と基本情報は `_<試験>_am_qs`）。
            # 試験コードは PDF 置き場の親（データ置き場）の名前から取る
            code = args.pdf_dir.parent.name
            for name in (f"{exam}_{code}_qs.pdf", f"{exam}_{code}_am_qs.pdf"):
                path = args.pdf_dir / name
                if path.exists():
                    break
            if not path.exists():
                problems.append(f"{qid}: {path} がありません")
                continue
            docs[exam] = fitz.open(path)
        doc = docs[exam]

        pno = box["page"] - 1
        if not 0 <= pno < doc.page_count:
            problems.append(f"{qid}: ページ {box['page']} は範囲外")
            continue
        page = doc[pno]
        r = page.rect

        x0 = max(0.0, box["x0"] - MARGIN)
        y0 = max(0.0, box["y0"] - MARGIN)
        x1 = min(1.0, box["x1"] + MARGIN)
        y1 = min(1.0, box["y1"] + MARGIN)
        if x1 <= x0 or y1 <= y0:
            problems.append(f"{qid}: 座標が不正 {box}")
            continue

        clip = fitz.Rect(r.width * x0, r.height * y0, r.width * x1, r.height * y1)
        dest = args.out / f"{qid}.png"
        page.get_pixmap(clip=clip, dpi=args.dpi).save(dest)
        written.append((qid, dest.stat().st_size // 1024))

    for qid, kb in written:
        print(f"  {qid:<18} {kb:>4} KB")
    print(f"\n{len(written)} 件を {args.out} に書き出しました")

    if problems:
        print(f"\n問題 {len(problems)} 件:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
