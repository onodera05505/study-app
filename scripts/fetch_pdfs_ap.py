#!/usr/bin/env python3
"""応用情報（午前）と基本情報（科目A＝旧午前）の過去問 PDF をダウンロードする。

    python3 scripts/fetch_pdfs_ap.py --recent 5
    python3 scripts/fetch_pdfs_ap.py --exams 2025r07a 2025r07h
    python3 scripts/fetch_pdfs_ap.py --exam fe --exams 2019r01a 2019h31h
    python3 scripts/fetch_pdfs_ap.py --recent 1 --origin http://127.0.0.1:8795   # 取りに行く先を差し替える（既定は IPA の公開の場所）

IT パスポートとは配布場所も命名も違うので、`fetch_pdfs.py` とは別にしてある。

- IT パスポート … CBT の公開問題ページ。回ごとに固定の URL
- 応用情報・基本情報 … 年度別ページの添付。添付ディレクトリ名が年度ごとに変わる
                  （例: nl10bi0000009lh8-att）ので、URL を組み立てられない。
                  **年度ページを読んでリンクを拾う**必要がある。

ファイル名は `<年度><期>_<試験>_am_<種別>.pdf`。`<試験>` は `--exam` の値（ap / fe）、
期は h=春期 / a=秋期、種別は qs=問題冊子 / ans=解答例。午後（pm）と科目B は対象外。

応用情報の午前は高度試験の午前Iと共通問題なので、これを潰すと IT ストラテジスト
などの午前I対策も兼ねる。基本情報の科目A は令和元年度秋期までが公開で、
令和2年度以降は CBT のため非公開（docs/基本情報を追加する.md）。

出典表示が必要な点は IT パスポートと同じ。docs/rules/BR-027.md を参照。
"""

import argparse
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# 公開の場所（--origin の既定）と、その下の過去問の一覧のページのパス。年度ページと PDF のパスは一覧のページから拾う
ORIGIN = "https://www.ipa.go.jp"
INDEX_PATH = "/shiken/mondai-kaiotu/index.html"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as res:
        return res.read().decode("utf-8", errors="replace")


def list_year_pages(origin: str) -> list[str]:
    """年度別ページの URL を新しい順に返す。"""
    html = get(origin + INDEX_PATH)
    paths = re.findall(r'href="(/shiken/mondai-kaiotu/(\d{4}[hr]\d{2})\.html)"', html)
    seen: dict[str, str] = {}
    for path, year in paths:
        seen.setdefault(year, origin + path)
    # 2009h21 … 2025r07 の形。文字列の降順で新しい順になる
    return [seen[y] for y in sorted(seen, reverse=True)]


def list_am_pdfs(year_url: str, exam: str, origin: str) -> list[tuple[str, str]]:
    """年度ページから、その試験の午前（科目A）の PDF を拾う。戻り値は (ファイル名, URL)。

    ファイル名の頭が `2025r07a` のような、期まで含んだ試験ID。
    """
    html = get(year_url)
    found: dict[str, str] = {}
    pattern = r'"(/shiken/mondai-kaiotu/[^"]*?_%s_am_(?:qs|ans)\.pdf)"' % re.escape(exam)
    for path in re.findall(pattern, html):
        name = path.rsplit("/", 1)[-1]
        found[name] = origin + path
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
    ap.add_argument("--exam", default="ap", help="試験コード。ap=応用情報 午前 / fe=基本情報 科目A")
    ap.add_argument("--out", type=Path, default=None, help="既定は data/<試験コード>/pdfs")
    ap.add_argument("--recent", type=int, default=5, help="新しい方から何回ぶん取るか")
    ap.add_argument("--exams", nargs="*", help="試験ID を直接指定する（例: 2025r07a）")
    ap.add_argument("--origin", default=ORIGIN, help="取りに行く先（スキーム://ホスト）。既定は IPA の公開の場所")
    args = ap.parse_args()
    origin = args.origin.rstrip("/")
    if not re.fullmatch(r"[a-z]{2,8}", args.exam):
        print(f"--exam は英小文字の試験コード（ap / fe）: {args.exam}", file=sys.stderr)
        return 1
    if args.out is None:
        args.out = Path(f"data/{args.exam}/pdfs")
    args.out.mkdir(parents=True, exist_ok=True)

    wanted: list[tuple[str, str]] = []
    exams: list[str] = []
    for year_url in list_year_pages(origin):
        for name, url in list_am_pdfs(year_url, args.exam, origin):
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
