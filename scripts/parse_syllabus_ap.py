#!/usr/bin/env python3
"""応用情報・基本情報のシラバス PDF を構造化して JSON に落とす。

    python3 scripts/parse_syllabus_ap.py                 # 応用情報（data/ap）
    python3 scripts/parse_syllabus_ap.py --data data/fe   # 基本情報 科目A

入力: `<data>/syllabus_*.pdf`（例 data/ap/syllabus_ap_ver7_2.pdf、data/fe/syllabus_fe_ver9_2.pdf）
出力: `<data>/syllabus.json`

IT パスポートの `parse_syllabus.py` と出力の形は揃えてあるが、**階層の深さが違う**
ので別スクリプトにしている。

    IT パスポート      … 分野 → 大分類 → 中分類 → 項目（全63）。用語例は項目に付く
    応用情報・基本情報 … 分野 → 大分類 → 中分類 → 小分類 →（n）→ ①。用語例は最深部に付く

アプリ側で「単元」として見せるのは中分類、論点を紐づける受け皿は小分類にする。
そこで**小分類より深い階層（（n）と①）の用語例は、すべてその小分類にまとめる**。
分類の粒度をこれ以上細かくしても、1問を1つに割り当てるのが難しくなるだけで、
学習の役には立たない。

小分類の番号は中分類ごとに 1 から振り直されるので、アプリで使う項目番号は
出現順の通し番号をこちらで採番する。
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import pypdf
except ImportError:
    sys.exit("pypdf が必要です:  pip install pypdf")

# 版はファイル名から読む（`syllabus_fe_ver9_2.pdf` → `FE Ver.9.2`）
RE_PDF_VERSION = re.compile(r"syllabus_([a-z]+)_ver(\d+)_(\d+)", re.I)
RE_HEADER = re.compile(r"大分類\s*(\d+)\s*[：:]\s*(\S+)\s+中分類\s*(\d+)\s*[：:]\s*(\S+)")
RE_FIELD = re.compile(r"◆(ストラテジ系|マネジメント系|テクノロジ系)◆")
# 「3. プログラミング」。行頭の番号＋ドット＋名前
RE_SMALL = re.compile(r"^(\d{1,2})\s*[.．]\s*(\S.*)$")
RE_TERMS = re.compile(r"^用語例\s*(.*)$")
RE_FOOTER = re.compile(r"^[-－]\s*\d+\s*[-－]$|^Copyright|^\s*$")
# 用語例ブロックの終わり
RE_BLOCK_END = re.compile(r"^(【目標】|（\d+）|\(\d+\)|（[a-zａ-ｚ]）|\([a-z]\)|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]|\d{1,2}\s*[.．]|大分類|中分類|◆)")

# 中分類がどの分野に属するかは、大分類の番号で決まる（共通キャリア・スキルフレームワーク）
FIELD_BY_MAJOR = {
    1: "テクノロジ系", 2: "テクノロジ系", 3: "テクノロジ系", 4: "テクノロジ系",
    5: "マネジメント系", 6: "マネジメント系",
    7: "ストラテジ系", 8: "ストラテジ系", 9: "ストラテジ系",
}


# 英語スペルの語間の空白が落ちる問題への対処。
#
# シラバス PDF は「Time DivisionMultiplexing」「ResilientFile System」のように、
# 英単語の切れ目に空白の文字が入っていない箇所がある（103 件）。pypdf でも
# PyMuPDF でも同じ結果なので、**PDF 側に空白が無い**（字送りだけで空けている）。
# PyMuPDF に替えると今度は「リアルタイム OS」→「リアルタイムOS」のように
# 別の箇所が壊れたので、抽出器は pypdf のまま、ここで補う。
#
# 用語例はそのまま論点名としてコピーされる。ここが崩れると論点名が崩れ、
# 同じ論点が2通りの綴りに割れて出題頻度が分散する。
#
# 小文字の直後の大文字を語の切れ目とみなすが、**本当に大文字が語中にある名前**が
# あるので、それは除外する。判定は語単位で行い、部分一致では消さない。
CAMEL_OK = {
    "JavaScript", "TypeScript", "DisplayPort", "ActiveX", "OpenStack", "TensorFlow",
    "SonarQube", "QuickTime", "OpenFlow", "PostgreSQL", "MySQL", "NoSQL", "PowerShell",
    "GitHub", "GitLab", "DevOps", "DevSecOps", "OpenSSF", "OpenSSL", "OpenAPI",
    "OpenID", "WebAssembly", "WebSocket", "WebRTC", "IPsec", "MobileIP", "eXtreme",
    "SuperVisor",  # SVC の展開。シラバスの原文が SuperVisor Call
}
RE_CAMEL = re.compile(r"[A-Za-z]+")

# 抽出の崩れを直す表。左が PDF から出てくる形、右が正しい形。
#
# 1. ルビ: シラバスは表外漢字にルビを振っており、抽出すると読みが本文の中に入る
#    （「歪度」のルビ「わい」が「歪わい度」になる）。
# 2. 落ちた空白: fix_lost_spaces の「小文字3つ+大文字+小文字2つ」の規則では割れない
#    英語の語境目（小文字どうしの連結）。
#
# 用語例はそのまま論点名としてコピーされるので、崩れたままだと論点名が崩れる。
# 部分一致で置くため、**語の一部だけを指す短い鍵は置かない**（「歪わい」のように読みまで含める）。
TEXT_FIXES = {
    "楕だ円": "楕円",
    "虹こう彩": "虹彩",
    "歪わい度": "歪度",
    "尖せん度": "尖度",
    "伝播ぱ": "伝播",
    "脆ぜい弱": "脆弱",
    "危殆たい": "危殆",
    "秘匿とく": "秘匿",
    "decisioncoverage": "decision coverage",
    "Systemsof": "Systems of",
}


def fix_known(text: str) -> str:
    """TEXT_FIXES の表で、ルビの混入と落ちた空白を直す。"""
    for wrong, right in TEXT_FIXES.items():
        text = text.replace(wrong, right)
    return text


def fix_lost_spaces(text: str) -> str:
    """英単語の間で落ちた空白を補う。CAMEL_OK に載る語の内側は割らない。

    「SuperVisorCall」のように、正しい CamelCase 語（SuperVisor）と
    落ちた空白（Visor|Call）が1語に混ざっている例がある。語全体で
    ホワイトリストを引くと守れないので、**語の内側に現れた位置**を守る。
    """
    def sub(m: re.Match) -> str:
        w = m.group(0)
        if len(w) <= 3:
            return w
        # 割ってはいけない位置（CAMEL_OK の語の内部）を集める
        protected: set[int] = set()
        for ok in CAMEL_OK:
            start = w.find(ok)
            while start >= 0:
                protected.update(range(start + 1, start + len(ok)))
                start = w.find(ok, start + 1)
        # 「小文字3つ以上 + 大文字 + 小文字2つ以上」の境目だけを割る。
        # RDBMS や BCD のような全大文字の頭字語は対象にならない
        out = []
        for i, ch in enumerate(w):
            if (
                i not in protected
                and i >= 3
                and ch.isupper()
                and w[i - 3 : i].islower()
                and w[i + 1 : i + 3].islower()
                and len(w[i + 1 : i + 3]) == 2
            ):
                out.append(" ")
            out.append(ch)
        return "".join(out)

    return RE_CAMEL.sub(sub, text)


def split_terms(blob: str) -> list[str]:
    """用語例の本文を語に割る。全角カンマ区切りだが、括弧の中にもカンマが入る。"""
    out, buf, depth = [], "", 0
    for ch in blob:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if ch in "，,、" and depth == 0:
            if buf.strip():
                out.append(buf.strip())
            buf = ""
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    # 行末で割れた語をつないだ結果の空白を詰めてから、落ちた空白を補う
    return [fix_known(fix_lost_spaces(re.sub(r"\s+", " ", t).strip())) for t in out if t.strip()]


def find_pdf(data: Path) -> Path:
    """データ置き場のシラバス PDF を 1 つ選ぶ。版が複数あるときは名前の降順で新しい方。"""
    found = sorted(data.glob("syllabus_*.pdf"), reverse=True)
    if not found:
        sys.exit(f"{data} に syllabus_*.pdf がありません（IPA のシラバス PDF を置く）")
    return found[0]


def version_label(pdf: Path) -> str:
    """`syllabus_fe_ver9_2.pdf` → `FE Ver.9.2`。読めなければファイル名をそのまま使う。"""
    m = RE_PDF_VERSION.search(pdf.name)
    return f"{m.group(1).upper()} Ver.{m.group(2)}.{m.group(3)}" if m else pdf.stem


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ap", type=Path, help="対象のデータ置き場。基本情報は data/fe")
    ap.add_argument("--pdf", default=None, type=Path, help="既定は <data>/syllabus_*.pdf")
    ap.add_argument("--out", default=None, type=Path, help="既定は <data>/syllabus.json")
    ap.add_argument("--version", default=None, help="出力に載せる版。既定は PDF の名前から組む")
    args = ap.parse_args()
    args.pdf = args.pdf or find_pdf(args.data)
    args.out = args.out or args.data / "syllabus.json"

    reader = pypdf.PdfReader(args.pdf)
    # 目次を読み飛ばす。本文は最初の「大分類 N：… 中分類 N：…」ヘッダから始まる
    lines: list[str] = []
    started = False
    for page in reader.pages:
        text = page.extract_text() or ""
        if not started and not RE_HEADER.search(text):
            continue
        started = True
        for raw in text.split("\n"):
            line = raw.strip()
            if RE_FOOTER.match(line):
                continue
            lines.append(line)

    items: list[dict] = []
    field = major_no = major = middle_no = middle = None
    current: dict | None = None
    terms_buf: str | None = None

    def flush_terms() -> None:
        nonlocal terms_buf
        if current is not None and terms_buf:
            current["terms"].extend(split_terms(terms_buf))
        terms_buf = None

    for line in lines:
        mf = RE_FIELD.search(line)
        if mf:
            field = mf.group(1)

        mh = RE_HEADER.search(line)
        if mh:
            flush_terms()
            major_no, major = int(mh.group(1)), mh.group(2)
            middle_no, middle = int(mh.group(3)), mh.group(4)
            field = FIELD_BY_MAJOR.get(major_no, field)
            continue

        # 用語例の続き
        if terms_buf is not None:
            if RE_BLOCK_END.match(line):
                flush_terms()
            else:
                terms_buf += line
                continue

        mt = RE_TERMS.match(line)
        if mt:
            terms_buf = mt.group(1)
            continue

        ms = RE_SMALL.match(line)
        if ms and middle_no is not None:
            # 「1. 」で始まっていても用語例の途中や本文の場合がある。
            # 小分類名は短く、句点で終わらない。
            name = ms.group(2).strip()
            if len(name) > 30 or name.endswith("。"):
                continue
            flush_terms()
            current = {
                "number": len(items) + 1,
                "small_no": int(ms.group(1)),
                "name": name,
                "field": field,
                "major_no": major_no,
                "major": major,
                "middle_no": middle_no,
                "middle": middle,
                "terms": [],
            }
            items.append(current)

    flush_terms()

    # 語の重複を項目内で除く
    for it in items:
        it["terms"] = list(dict.fromkeys(it["terms"]))

    out = {
        "version": args.version or version_label(args.pdf),
        "source": str(args.pdf),
        "item_count": len(items),
        "term_count": sum(len(i["terms"]) for i in items),
        "items": items,
    }
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    middles = {(i["major_no"], i["middle_no"], i["middle"]) for i in items}
    print(f"→ {args.out}")
    print(f"  分野     : {len({i['field'] for i in items})}")
    print(f"  大分類   : {len({i['major_no'] for i in items})}")
    print(f"  中分類   : {len(middles)}")
    print(f"  小分類   : {out['item_count']}")
    print(f"  用語例   : {out['term_count']}")

    empty = [i for i in items if not i["terms"]]
    if empty:
        print(f"\n[確認] 用語例が取れなかった小分類 {len(empty)} 件:")
        for i in empty[:10]:
            print(f"  中分類{i['middle_no']} {i['middle']} / {i['small_no']}. {i['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
