#!/usr/bin/env python3
"""執筆された教材が仕様どおりかを検証する。

    python3 scripts/check_materials.py

教材は論点ごとに分担して書くため、担当ごとに流儀がずれる。1件ずつ読んでも
気づけないので、機械的に検出できるものはここで洗い出す。

検証する内容:

- **カバレッジ** — 全論点に教材があるか。抜けている論点番号を出す
- **論点との対応** — `topic_id` が指す論点の名前と `term` が一致するか。
  ずれていれば別の論点の解説が表示されることになる
- **分量** — explanation / detail が仕様のレンジに収まっているか
- **記法** — v2 で使ってよいのは見出し `###` / 箇条書き `- ` / 番号付き `1. ` /
  強調 `**…**` / 表 / 図の画像行だけ。表示側（Markdown.tsx）が他を解釈しないので、
  それ以外を書くと記号がそのまま画面に出る
- **表の構造** — ヘッダ行と `| --- |` の区切り行があるか、各行のセル数が揃っているか、
  行数・列数が収まっているか。崩れた表は画面でパイプがそのまま出る
- **図の画像行** — 画像は書き手が入れるものではなく、スクリプトが
  `/figures/materials/<試験>/…svg` を差し込む。その形以外の画像・リンクは禁止のまま。
  差し込んだ図のファイルが `public/` に実在するかも見る（無いと画面が空欄になる）
- **見出し構成** — detail が `###` で区切られていて、出題パターンに触れているか
- **句読点** — 教材は自分たちの文章なので通常の「、。」を使う。過去問データ側は
  IPA 原文に合わせて「，」を使っているので、そちらが紛れ込んでいないか見る
- **過去問の直接引用** — 引用すると出典表示の義務が生じる。問題文と長く一致する
  部分がないかを調べる
"""

import argparse
import json
import re
import sys
from pathlib import Path

# v1（プレーンテキスト）と v2（決まった記法で構造を付けた版）で基準が違う。
# 書き直しは頻度順に進めるので、途中は必ず混在する。v2 かどうかは detail の
# 見出しの有無で見分ける（v2 では detail を必ず ### で区切る）。
EXPLANATION_RANGE = (80, 260)
DETAIL_RANGE = (350, 1100)
EXPLANATION_RANGE_V2 = (120, 380)
DETAIL_RANGE_V2 = (500, 1500)
HEADING_RANGE_V2 = (2, 5)  # 目安は3〜4個。多いと開いた瞬間に見出しの一覧に見える

MARKDOWN = re.compile(r"(^#{1,6}\s|\*\*|^\s*[-*]\s|\[.+?\]\(.+?\))", re.M)
# v2 で使ってはいけない記法。Markdown.tsx が解釈しないものをすべて挙げる。
# 表は通るようになったので外してある（代わりに構造を check_tables で見る）。
FORBIDDEN_V2 = [
    (re.compile(r"^#{1,2}\s", re.M), "見出し # / ##（画面の見出しと衝突する）"),
    (re.compile(r"^#{4,}\s", re.M), "見出し #### 以下（### だけ使う）"),
    (re.compile(r"\[[^\]]+\]\([^)]+\)", re.M), "リンク・画像"),
    (re.compile(r"^\s*```", re.M), "コードブロック"),
    (re.compile(r"^\s*>", re.M), "引用"),
    (re.compile(r"^\s*(---+|___+|\*\*\*+)\s*$", re.M), "水平線"),
    (re.compile(r"^\s*[*+]\s", re.M), "箇条書きの * / +（- を使う）"),
]
HEADING = re.compile(r"^###\s+(.*\S)\s*$", re.M)
LIST_ITEM = re.compile(r"^(?:-\s|\d+[.)]\s)")

# --- 表 ---------------------------------------------------------------
# Markdown.tsx と同じ判定にしておくこと。ここで通したものが画面で崩れると、
# 検証を通ったのに表示が壊れる、という一番たちの悪い状態になる。
DELIM_CELL = re.compile(r"^:?-+:?$")
TABLE_ROWS = (2, 8)  # ヘッダを含む行数（区切り行は数えない）
TABLE_COLS = (2, 4)


def split_row(line: str) -> list[str]:
    """表の1行をセルに割る。行頭・行末のパイプは省略されていてもよい。"""
    s = line
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def is_row(line: str) -> bool:
    """表の行に見えるか。パイプを含んだ箇条書きを表と取り違えないようにする。"""
    if "|" not in line:
        return False
    if not line.startswith("|") and LIST_ITEM.match(line):
        return False
    return len(split_row(line)) >= 2


def check_tables(where: str, text: str) -> list[str]:
    """表の構造を見る。崩れていると画面にパイプがそのまま出る。"""
    out: list[str] = []
    blocks: list[list[str]] = []
    cur: list[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if is_row(s):
            cur.append(s)
        elif cur:
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)

    for block in blocks:
        head = split_row(block[0])
        label = block[0][:24]
        if len(block) < 2:
            # 表示側は1行だけの塊を表と見なさない（段落として出る）
            if block[0].startswith("|"):
                out.append(f"{where}: 表が1行しかない『{label}…』（区切り行 | --- | が要る）")
            continue
        if not (len(split_row(block[1])) >= 2 and all(DELIM_CELL.match(c) for c in split_row(block[1]))):
            out.append(f"{where}: 表の2行目が区切り行でない『{label}…』（| --- | --- | を置く）")
            continue
        body = [split_row(r) for r in block[2:]]
        rows = 1 + len(body)
        if not TABLE_ROWS[0] <= rows <= TABLE_ROWS[1]:
            out.append(f"{where}: 表が {rows} 行『{label}…』（ヘッダ込みで {TABLE_ROWS[0]}〜{TABLE_ROWS[1]} 行）")
        if not TABLE_COLS[0] <= len(head) <= TABLE_COLS[1]:
            out.append(f"{where}: 表が {len(head)} 列『{label}…』（{TABLE_COLS[0]}〜{TABLE_COLS[1]} 列）")
        for i, r in enumerate(body, start=3):
            if len(r) != len(head):
                out.append(
                    f"{where}: 表のセル数が揃っていない『{label}…』"
                    f"（{i}行目 {len(r)} 個 / ヘッダ {len(head)} 個）"
                )
    return out


# --- 図の画像行 -------------------------------------------------------
# 画像は書き手が入れるものではない。論点ごとの図をスクリプトが差し込む。
def image_pattern(exam: str) -> re.Pattern:
    return re.compile(rf"^!\[([^\]]*)\]\((/figures/materials/{re.escape(exam)}/[^)\s]+\.svg)\)$")


def take_images(text: str, pat: re.Pattern) -> tuple[str, list[tuple[str, str]]]:
    """許可された画像行を抜き出し、残りの本文（画像行を空行にしたもの）を返す。

    抜いておかないと「リンク・画像は禁止」の検査に自分で引っかかる。
    行構造は保つので、他の検査（行頭の記号を見るもの）はそのまま効く。"""
    found: list[tuple[str, str]] = []
    lines: list[str] = []
    for line in text.split("\n"):
        mo = pat.match(line.strip())
        if mo:
            found.append((mo.group(1), mo.group(2)))
            lines.append("")
        else:
            lines.append(line)
    return "\n".join(lines), found

# 選択肢の記号（ア・イ・ウ・エ）の直書き。問題を差し替えると誤りになる。
# 「正解はウィザード」のようなカタカナ語の先頭に当たらないよう、
# 記号の直後にカタカナが続くものは除く。
CHOICE_SYMBOL = re.compile(
    r"((?:正解|正答|答え|解答|誤答)(?:は|が|の|に)?|選択肢)\s*[「『]?([アイウエ])(?![ァ-ヴー])[」』]?"
)
# 「計算で問われる」と書いているか
CALC_CLAIM = re.compile(r"計算(で問われ|問題|させ|する)|算出|求めさせ")
# 式らしい記述か（記号でも日本語でも可）
FORMULA_LIKE = re.compile(r"[÷×]|＝|を[^。\n]{0,12}で割|から[^。\n]{0,12}を(引|差し引)|の積")
# 引用とみなす一致長。これ以上一致していれば原文をそのまま写している疑い
QUOTE_LEN = 30


def check_notation_v2(
    where: str, ex: str, det: str, pat: re.Pattern, public: Path
) -> tuple[list[str], list[str], int]:
    """v2 の記法と見出し構成を見る。表示側が解釈できない書き方を洗い出す。

    返すのは (問題, 警告, 図の枚数)。表の崩れと図の欠落は画面が壊れるので**問題**、
    分量や体裁のずれは警告にとどめる。"""
    problems: list[str] = []
    out: list[str] = []

    # 許可された画像行は先に抜く（「リンク・画像は禁止」に自分で引っかかるため）
    ex, ex_images = take_images(ex, pat)
    det, det_images = take_images(det, pat)
    images = ex_images + det_images
    for _caption, src in images:
        if not (public / src.lstrip("/")).exists():
            problems.append(f"{where}: 図のファイルが無い『{src}』（画面が空欄になる）")

    for pattern, name in FORBIDDEN_V2:
        if pattern.search(ex) or pattern.search(det):
            out.append(f"{where}: 使えない記法 — {name}")
    problems.extend(check_tables(where, ex))
    problems.extend(check_tables(where, det))
    if (ex + det).count("**") % 2:
        out.append(f"{where}: 閉じていない ** がある（そのまま画面に出る）")
    if HEADING.search(ex):
        out.append(f"{where}: explanation に見出しがある（短いので使わない約束）")

    for mo in CHOICE_SYMBOL.finditer(ex + "\n" + det):
        out.append(f"{where}: 選択肢の記号を直書きしている『{mo.group(0)}』（内容で書く）")

    # 「計算で問われる」と言いながら、冒頭に式が無い。detail を開くまで式に辿り着けない
    if CALC_CLAIM.search(ex) and not FORMULA_LIKE.search(ex) and FORMULA_LIKE.search(det):
        out.append(f"{where}: explanation が計算に言及しているのに式が無い（detail にはある）")

    headings = HEADING.findall(det)
    if "materials_v3" in where:
        # v3（2026-09-01）: 出題パターンの見出しは廃止。代わりに explanation に見分けワードの行を置く
        if len(headings) > HEADING_RANGE_V2[1]:
            out.append(f"{where}: detail の見出しが {len(headings)} 個（v3 は 1〜3 個が目安）")
        if any("出題" in h for h in headings):
            out.append(f"{where}: v3 なのに出題パターンの見出しが残っている（問題解説側へ）")
        if "見分けワード" not in ex:
            out.append(f"{where}: explanation に見分けワードの行が無い")
    else:
        if not HEADING_RANGE_V2[0] <= len(headings) <= HEADING_RANGE_V2[1]:
            out.append(f"{where}: detail の見出しが {len(headings)} 個（目安 3〜4）")
        if not any("出題" in h for h in headings):
            out.append(f"{where}: detail に出題パターンの見出しが無い")

    # リストの項目は1行で書く約束。折り返すと2行目が別の項目・段落として描画される
    run = 0
    for line in det.split("\n"):
        s = line.strip()
        if LIST_ITEM.match(s):
            run += 1
            if line.startswith((" ", "\t", "　")):
                out.append(f"{where}: 字下げした項目がある『{s[:16]}…』（1行で書く）")
        else:
            if run > 6:
                out.append(f"{where}: 1つの箇条書きが {run} 項目（見出しで分ける）")
            run = 0
            if s and line.startswith(("  ", "　")):
                out.append(f"{where}: 字下げした行がある『{s[:16]}…』（折り返しは別段落になる）")
    if run > 6:
        out.append(f"{where}: 1つの箇条書きが {run} 項目（見出しで分ける）")
    return problems, out, len(images)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    ap.add_argument("--dir", action="append", help="検査するディレクトリ（既定は materials・materials_v2・materials_v3。後勝ち）")
    # 教材に差し込んだ図の実体を確かめる先。/figures/… はこの下からの絶対パス。
    ap.add_argument("--public", default="public", type=Path)
    args = ap.parse_args()
    d = args.data
    dirs = [Path(x) for x in args.dir] if args.dir else [d / "materials", d / "materials_v2", d / "materials_v3"]
    dirs = [x for x in dirs if x.exists()]

    # `--dir data/ap/materials_v2` だけ渡して `--data` を忘れると、応用情報の教材を
    # IT パスポートの論点マスタと突き合わせて「全件が論点名不一致」になる。
    # 実際に何度か起きているので、噛み合っていない組合せは先に止める。
    for sub in dirs:
        if d not in sub.parents and sub.parent != d:
            sys.exit(
                f"{sub} は --data（{d}）の外にあります。"
                f"試験を切り替えるときは --data も一緒に渡してください（例: --data data/ap）"
            )

    topics = json.loads((d / "topics.json").read_text(encoding="utf-8"))["topics"]
    by_id = {t["id"]: t for t in topics}

    questions: list[str] = []
    for path in (d / "questions").glob("*.json"):
        for q in json.loads(path.read_text(encoding="utf-8"))["questions"]:
            questions.append(q["text"])

    # 同じディレクトリの中で重複していれば事故（担当範囲がずれている）だが、
    # v1 と v2 に同じ論点があるのは正常な状態。v2 を採用する。
    materials: dict[int, dict] = {}
    duplicates: list[int] = []
    for sub in dirs:
        seen: set[int] = set()
        for path in sorted(sub.glob("*.json")):
            for m in json.loads(path.read_text(encoding="utf-8")).get("materials", []):
                if m["topic_id"] in seen:
                    duplicates.append(m["topic_id"])
                seen.add(m["topic_id"])
                m["_file"] = f"{sub.name}/{path.name}"
                materials[m["topic_id"]] = m

    problems: list[str] = []
    warnings: list[str] = []
    v2_count = 0
    image_pat = image_pattern(d.name)
    figure_topics = 0
    figure_count = 0

    missing = sorted(t["id"] for t in topics if t["id"] not in materials)
    orphan = sorted(i for i in materials if i not in by_id)

    for tid, m in sorted(materials.items()):
        t = by_id.get(tid)
        where = f"{m['_file']} id={tid}"
        if t and m.get("term") and m["term"] != t["term"]:
            problems.append(f"{where}: 論点名が不一致『{m['term']}』⇔『{t['term']}』")

        ex = (m.get("explanation") or "").strip()
        det = (m.get("detail") or "").strip()
        if not ex or not det:
            problems.append(f"{where}: explanation か detail が空")
            continue
        is_v2 = bool(HEADING.search(det))
        is_v3 = "materials_v3" in str(m["_file"])
        ex_range = EXPLANATION_RANGE_V2 if is_v2 else EXPLANATION_RANGE
        det_range = DETAIL_RANGE_V2 if is_v2 else DETAIL_RANGE
        if is_v3:
            # 2026-09-01 の再構成版。誤答のケアを問題解説に移したので短くてよい。
            # 字数は目安であって上限ではない（わかりやすさと必要な情報を優先する方針）ので、
            # 極端に短い／長いときだけ警告する
            ex_range, det_range = (60, 450), (40, 1600)
        if not ex_range[0] <= len(ex) <= ex_range[1]:
            warnings.append(f"{where}: explanation が {len(ex)}字（目安 {ex_range[0]}〜{ex_range[1]}）")
        if not det_range[0] <= len(det) <= det_range[1]:
            warnings.append(f"{where}: detail が {len(det)}字（目安 {det_range[0]}〜{det_range[1]}）")

        body = f"{ex}\n{det}"
        if is_v2:
            v2_count += 1
            p, w, n = check_notation_v2(where, ex, det, image_pat, args.public)
            problems.extend(p)
            warnings.extend(w)
            if n:
                figure_topics += 1
                figure_count += n
        elif MARKDOWN.search(body):
            warnings.append(f"{where}: Markdown 記法が混入している（v1 はプレーンテキスト）")
        if "，" in body or "．" in body:
            warnings.append(f"{where}: IPA 原文の句読点（，．）が混入している")

        # 過去問の原文をそのまま写していないか
        for qt in questions:
            for i in range(0, max(0, len(qt) - QUOTE_LEN), 10):
                frag = qt[i : i + QUOTE_LEN]
                if frag and frag in body:
                    problems.append(f"{where}: 過去問の原文と {QUOTE_LEN} 字以上一致『{frag[:20]}…』")
                    break
            else:
                continue
            break

    # 担当バンドルと出力の突合。バンドル NN を渡した担当が、別の論点を書いて
    # NN として出してくると、その論点が誰にも書かれないまま残る。
    # 担当の自己申告は当てにならない（実際に、担当外の論点番号を報告してきた例がある）。
    for path in sorted((d / "materials_v2").glob("bundle_*.json")):
        src = d / "material_bundles" / path.name
        if not src.exists():
            continue
        want = {t["topic_id"] for t in json.loads(src.read_text(encoding="utf-8"))["topics"]}
        got = {m["topic_id"] for m in json.loads(path.read_text(encoding="utf-8")).get("materials", [])}
        if want != got:
            problems.append(
                f"{path.name}: 担当バンドルと論点が違う"
                f"（書かれていない {sorted(want - got)} / 担当外 {sorted(got - want)}）"
            )

    print(f"教材: {len(materials)} / {len(topics)} 論点（うち v2 {v2_count} 論点）")
    print(f"  図あり {figure_topics} 論点 / {figure_count} 枚")
    if missing:
        print(f"  未執筆 {len(missing)} 件: {missing[:20]}{' …' if len(missing) > 20 else ''}")
    if orphan:
        problems.append(f"存在しない論点を指す教材: {orphan}")
    if duplicates:
        warnings.append(f"複数ファイルに重複している論点: {sorted(set(duplicates))[:10]}（後勝ちで採用）")

    if warnings:
        print(f"\n警告 {len(warnings)} 件:")
        for w in warnings[:20]:
            print(f"  - {w}")
        if len(warnings) > 20:
            print(f"  … 他 {len(warnings) - 20} 件")

    if problems:
        print(f"\n問題 {len(problems)} 件:", file=sys.stderr)
        for p in problems[:20]:
            print(f"  - {p}", file=sys.stderr)
        return 1

    if not missing:
        print("\n検証: 問題なし")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
