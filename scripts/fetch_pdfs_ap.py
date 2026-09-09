#!/usr/bin/env python3
"""応用情報技術者試験（午前）の過去問 PDF をダウンロードする。

    python3 scripts/fetch_pdfs_ap.py --recent 5
    python3 scripts/fetch_pdfs_ap.py --exams 2025r07a 2025r07h

IT パスポートとは配布場所も命名も違うので、`fetch_pdfs.py` とは別にしてある。

- IT パスポート … CBT の公開問題ページ。回ごとに固定の URL
- 応用情報      … 年度別ページの添付。添付ディレクトリ名が年度ごとに変わる
                  （例: nl10bi0000009lh8-att）ので、URL を組み立てられない。
                  **年度ページを読んでリンクを拾う**必要がある。

ファイル名は `<年度><期>_ap_am_<種別>.pdf`。期は h=春期 / a=秋期、
種別は qs=問題冊子 / ans=解答例。午後（pm）は対象外。

午前試験は高度試験の午前Iと共通問題なので、これを潰すと IT ストラテジスト
などの午前I対策も兼ねる。

出典表示が必要な点は IT パスポートと同じ。docs/要件定義書_draft.md §9 を参照。
"""

import argparse
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

INDEX_URL = "https://www.ipa.go.jp/shiken/mondai-kaiotu/index.html"
ORIGIN = "https://www.ipa.go.jp"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as res:
        return res.read().decode("utf-8", errors="replace")


def list_year_pages() -> list[str]:
    """年度別ページの URL を新しい順に返す。"""
    html = get(INDEX_URL)
    paths = re.findall(r'href="(/shiken/mondai-kaiotu/(\d{4}[hr]\d{2})\.html)"', html)
    seen: dict[str, str] = {}
    for path, year in paths:
        seen.setdefault(year, ORIGIN + path)
    # 2009h21 … 2025r07 の形。文字列の降順で新しい順になる
    return [seen[y] for y in sorted(seen, reverse=True)]


def list_am_pdfs(year_url: str) -> list[tuple[str, str]]:
    """年度ページから午前の PDF を拾う。戻り値は (試験ID, URL)。

    試験ID は `2025r07a` のような、期まで含んだ識別子。
    """
    html = get(year_url)
    found: dict[str, str] = {}
    for path in re.findall(r'"(/shiken/mondai-kaiotu/[^"]*?_ap_am_(?:qs|ans)\.pdf)"', html):
        name = path.rsplit("/", 1)[-1]
        found[name] = ORIGIN + path
    return sorted(found.items())


def exam_id(filename: str) -> str:
    """`2025r07a_ap_am_qs.pdf` → `2025r07a`"""
    return filename.split("_", 1)[0]


def download(item: tuple[str, str], out_dir: Path) -> tuple[str, str]:
    name, url = item
    dest = out_dir / name
    if dest.exists():
        return name, "skip"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req) as res:
            body = res.read()
    except Exception as e:  # ネットワーク断は握りつぶさず表示する
        return name, f"error: {e}"
    dest.write_bytes(body)
    return name, f"{len(body) // 1024} KB"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/ap/pdfs", type=Path)
    ap.add_argument("--recent", type=int, default=5, help="新しい方から何回ぶん取るか")
    ap.add_argument("--exams", nargs="*", help="試験ID を直接指定する（例: 2025r07a）")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    wanted: list[tuple[str, str]] = []
    exams: list[str] = []
    for year_url in list_year_pages():
        for name, url in list_am_pdfs(year_url):
            eid = exam_id(name)
            if args.exams and eid not in args.exams:
                continue
            if not args.exams and eid not in exams and len(exams) >= args.recent:
                continue
            if eid not in exams:
                exams.append(eid)
            wanted.append((name, url))
        if not args.exams and len(exams) >= args.recent:
            break

    if not wanted:
        print("対象の PDF が見つかりませんでした。")
        return 1

    print(f"{len(exams)} 回分 / {len(wanted)} ファイルを {args.out} に取得します")
    for e in exams:
        print(f"  - {e}")

    failed = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for name, status in pool.map(lambda i: download(i, args.out), wanted):
            print(f"  {name:<30} {status}")
            if status.startswith("error"):
                failed.append(name)

    if failed:
        print(f"\n{len(failed)} 件が失敗しました: {failed}", file=sys.stderr)
        return 1
    print("\n完了")
    return 0


if __name__ == "__main__":
    sys.exit(main())
