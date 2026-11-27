#!/usr/bin/env python3
"""IPA が公開している IT パスポート試験の過去問 PDF を一括ダウンロードする。

問題冊子 (_qs) と解答例 (_ans) を回ごとに取得する。既に存在するファイルは
スキップするので、新しい年度が公開されたら再実行するだけで差分が入る。

    python3 scripts/fetch_pdfs.py [--out data/pdfs] [--origin <スキーム://ホスト>]

取りに行く先は --origin で差し替えられる（既定は IPA の公開の配布の場所。一覧のページと PDF のパスはそのまま）。

出典: https://www3.jitec.ipa.go.jp/JitesCbt/html/openinfo/questions.html
過去問の利用に許諾・使用料は不要だが、表示時の出典明記が必須。詳細は
docs/rules/BR-027.md を参照。
"""

import argparse
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# 公開の配布の場所（--origin の既定）と、その下の一覧のページと PDF の置き場のパス
ORIGIN = "https://www3.jitec.ipa.go.jp"
INDEX_PATH = "/JitesCbt/html/openinfo/questions.html"
PDF_PATH = "/JitesCbt/html/openinfo/pdf/questions"


def list_exam_pdfs(origin: str) -> list[str]:
    """公開ページを読んで PDF のファイル名一覧を返す。"""
    with urllib.request.urlopen(origin + INDEX_PATH) as res:
        html = res.read().decode("utf-8", errors="replace")
    names = re.findall(r"\./pdf/questions/([^\"]+\.pdf)", html)
    # 出現順を保ったまま重複を除く
    return list(dict.fromkeys(names))


def download(name: str, out_dir: Path, origin: str) -> tuple[str, str]:
    dest = out_dir / name
    if dest.exists():
        return name, "skip"
    try:
        with urllib.request.urlopen(f"{origin}{PDF_PATH}/{name}") as res:
            body = res.read()
    except Exception as e:  # ネットワーク断は握りつぶさず表示する
        return name, f"error: {e}"
    dest.write_bytes(body)
    return name, f"{len(body) // 1024} KB"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/ip/pdfs", type=Path)
    ap.add_argument("--origin", default=ORIGIN, help="取りに行く先（スキーム://ホスト）。既定は IPA の公開の配布の場所")
    args = ap.parse_args()
    origin = args.origin.rstrip("/")
    args.out.mkdir(parents=True, exist_ok=True)

    names = list_exam_pdfs(origin)
    print(f"{len(names)} ファイル ({len(names) // 2} 回分) を {args.out} に取得します")

    failed = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for name, status in pool.map(lambda n: download(n, args.out, origin), names):
            print(f"  {name:<28} {status}")
            if status.startswith("error"):
                failed.append(name)

    if failed:
        print(f"\n{len(failed)} 件が失敗しました: {failed}", file=sys.stderr)
        return 1
    print("\n完了")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
