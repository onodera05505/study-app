#!/usr/bin/env python3
"""チャンクごとに抽出した問題 JSON を1つにまとめ、正規化と検証を行う。

ページ画像の読み取りはページ範囲ごとに分割して行うため、その結果
(chunk_*.json) を結合して 1 回分の問題データにする。

この工程が担うのは3つ:
  1. 結合 — chunk_*.json を問番号順に1本化する
  2. 正規化 — 表記の揺れを潰す（§正規化の方針）
  3. 検証 — 機械的に検出できる異常と、チャンク間のブレを洗い出す

    python3 scripts/merge_questions.py 2024r06
    python3 scripts/merge_questions.py 2024r06 --no-normalize   # 素の抽出結果を見たいとき

出力: data/questions/<exam>.json

## 正規化の方針

IPA の原文は読点に「，」、句点に「。」を使う（600dpi で拡大して確認済み）。
ところが読み取りを分担すると、担当範囲まるごと「．」で書かれるといった
チャンク単位の系統的なブレが起きる。実際 2024r06 では chunk_02（問12-28）
だけが句点を「．」にしていた。1回分なら手で直せるが、29回分では破綻する
ので、ここで機械的に正す。

小数点の「．」を壊さないよう、前後が数字の場合は置換しない。

## この工程で検証できないこと

構造と表記だけで、読み取り内容が原文に忠実かどうかは分からない。内容の
妥当性は check_answerability.py（抽出テキストだけで解かせて正解表と突合）
で別途測る。
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# 1回あたりの問題数は試験で違う（IT パスポート 100 / 応用情報 午前 80）。
# --count で切り替える。
QUESTIONS_PER_EXAM = 100
CHOICE_KEYS = ("ア", "イ", "ウ", "エ")

# 前後が数字でない全角ピリオドだけを句点に直す（小数点を壊さないため）
FULLWIDTH_PERIOD = re.compile(r"(?<![0-9０-９])．(?![0-9０-９])")

# 規格名の副題を区切るダッシュ。JIS の正式名称は「－」（全角ハイフンマイナス）を使うが、
# 読み取りでは長音記号「ー」に化けやすい（字形がほぼ同じ）。実際に
# 「情報セキュリティマネジメントシステムー用語」（誤）と
# 「リスクマネジメント－指針」（正）が回ごとに割れた。
#
# **位置では機械判定できない。** 長音記号は語中にごく普通に出るうえ、
# 「シンボルーアイコン」のように区切りダッシュの前後がどちらもカタカナになる例がある。
# 「前がカタカナなら長音」といった規則を当てると、直すべきものを取りこぼすか、
# 正しい長音を壊すかのどちらかになる。
#
# そこで**正式名称を確認できたものだけを明示的に直す**。表に無いものは触らない。
# 新しい規格名が出てきたら、正式名称を確認してからここに足すこと。
STANDARD_TITLES = {
    "情報セキュリティマネジメントシステムー用語": "情報セキュリティマネジメントシステム－用語",
    "ユーザシステムインタフェース及びシンボルーアイコン及び機能ーアイコン一般":
        "ユーザシステムインタフェース及びシンボル－アイコン及び機能－アイコン一般",
}


def fix_standard_dash(text: str) -> str:
    for wrong, right in STANDARD_TITLES.items():
        if wrong in text:
            text = text.replace(wrong, right)
    return text


def normalize(text: str) -> str:
    if not text:
        return text
    text = FULLWIDTH_PERIOD.sub("。", text)
    text = text.replace("、", "，")
    text = fix_standard_dash(text)
    return text


def normalize_question(q: dict) -> int:
    """問題を破壊的に正規化し、変更されたフィールド数を返す。"""
    changed = 0
    for key in ("text", "figure_description", "notes"):
        before = q.get(key)
        if isinstance(before, str):
            after = normalize(before)
            if after != before:
                q[key] = after
                changed += 1
    for key, before in (q.get("choices") or {}).items():
        if isinstance(before, str):
            after = normalize(before)
            if after != before:
                q["choices"][key] = after
                changed += 1
    return changed


def lint(questions: dict[int, dict], count: int) -> list[str]:
    """機械的に検出できる異常を列挙する。"""
    problems = []

    missing = [n for n in range(1, count + 1) if n not in questions]
    if missing:
        problems.append(f"欠番 {len(missing)} 問: {missing}")
    extra = sorted(n for n in questions if not 1 <= n <= count)
    if extra:
        problems.append(f"範囲外の問番号: {extra}")

    for n in sorted(questions):
        q = questions[n]
        if not (q.get("text") or "").strip():
            problems.append(f"問{n}: 問題文が空")
        ch = q.get("choices") or {}
        blank = [k for k in CHOICE_KEYS if not (ch.get(k) or "").strip()]
        if blank:
            problems.append(f"問{n}: 選択肢 {''.join(blank)} が空または欠落")
        if len(ch) != len(CHOICE_KEYS):
            problems.append(f"問{n}: 選択肢が {len(ch)} 個（4個であるべき）")
        if len(set(ch.values())) != len(ch):
            problems.append(f"問{n}: 選択肢に重複がある")
        if q.get("has_figure") and not (q.get("figure_description") or "").strip():
            problems.append(f"問{n}: has_figure=true だが figure_description が空")
        if not q.get("has_figure") and (q.get("figure_description") or "").strip():
            problems.append(f"問{n}: has_figure=false なのに figure_description がある")
    return problems


def drift_report(questions: dict[int, dict]) -> list[str]:
    """チャンク単位の系統的なブレを検出する（警告どまり）。

    読み取りを分担すると、担当範囲だけ表記の流儀が違うことが起きる。
    1問ごとに見ても気付けないので、チャンク単位で集計して比較する。
    """
    stats = defaultdict(lambda: {"n": 0, "period": 0, "nl": 0, "fig": 0, "nums": []})
    for n, q in questions.items():
        blob = (q.get("text") or "") + "".join((q.get("choices") or {}).values())
        s = stats[q.get("source_chunk", "?")]
        s["n"] += 1
        s["nums"].append(n)
        s["period"] += blob.count("．")
        s["nl"] += blob.count("\n")
        s["fig"] += 1 if q.get("has_figure") else 0

    warnings = []
    offenders = [c for c, s in stats.items() if s["period"]]
    if offenders:
        detail = ", ".join(f"{c}({stats[c]['period']}箇所)" for c in sorted(offenders))
        warnings.append(f"正規化後も全角ピリオドが残っている: {detail}（小数点なら正常）")

    # 箇条書きを改行で表すチャンクと、そうでないチャンクが混在していないか
    uses_nl = {c for c, s in stats.items() if s["nl"]}
    if uses_nl and len(uses_nl) != len(stats):
        rest = sorted(set(stats) - uses_nl)
        warnings.append(
            "箇条書きの区切りがチャンク間で不統一。"
            f"改行を使う: {sorted(uses_nl)} / 使わない: {rest}"
        )
    return warnings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exam")
    ap.add_argument("--extracted-dir", default="data/ip/extracted", type=Path)
    ap.add_argument("--out-dir", default="data/ip/questions", type=Path)
    ap.add_argument("--count", type=int, default=QUESTIONS_PER_EXAM,
                    help="1回あたりの問題数（IT パスポート 100 / 応用情報 午前 80）")
    ap.add_argument("--no-normalize", action="store_true", help="正規化せず素の抽出結果を出す")
    args = ap.parse_args()

    chunk_dir = args.extracted_dir / args.exam
    chunks = sorted(chunk_dir.glob("chunk_*.json"))
    if not chunks:
        sys.exit(f"{chunk_dir} に chunk_*.json がありません")

    questions: dict[int, dict] = {}
    duplicates: list[int] = []
    for path in chunks:
        data = json.loads(path.read_text(encoding="utf-8"))
        for q in data.get("questions", []):
            n = q.get("number")
            if n in questions:
                duplicates.append(n)
            q["source_chunk"] = path.name
            questions[n] = q

    normalized = 0
    if not args.no_normalize:
        normalized = sum(normalize_question(q) for q in questions.values())

    problems = lint(questions, args.count)
    if duplicates:
        problems.insert(0, f"重複した問番号: {sorted(set(duplicates))}")
    warnings = drift_report(questions)

    merged = {
        "exam": args.exam,
        "source": "IPA 公開問題（表示時の出典明記が必須。docs/要件定義書_draft.md §9 参照）",
        "normalized": not args.no_normalize,
        "question_count": len(questions),
        "questions": [questions[n] for n in sorted(questions)],
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"{args.exam}.json"
    out.write_text(json.dumps(merged, ensure_ascii=False, indent=1), encoding="utf-8")

    figures = [n for n in sorted(questions) if questions[n].get("has_figure")]
    low = [n for n in sorted(questions) if questions[n].get("confidence") not in (None, "high")]

    print(f"{len(chunks)} チャンクを結合 → {out}")
    print(f"  問題数            : {len(questions)} / {args.count}")
    print(f"  正規化した箇所    : {normalized}")
    print(f"  図表を含む問題    : {len(figures)} 問 {figures}")
    print(f"  要確認(confidence): {len(low)} 問 {low}")

    for w in warnings:
        print(f"  [警告] {w}")

    if problems:
        print(f"\n構造上の問題 {len(problems)} 件:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print("\n構造チェック: 問題なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
