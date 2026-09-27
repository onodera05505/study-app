#!/usr/bin/env python3
"""執筆された「問題ごとの解説」が仕様どおりかを検証する。

    python3 scripts/check_explanations.py --data data/ip

解説は論点ごとに分担して書くため、担当ごとに流儀がずれる。教材と同じで、
1件ずつ読んでも気づけないので機械で洗い出す。**担当の自己申告は当てにしない。**

検証する内容:

- **選択肢の構造** — ア〜エの4件が揃っていて、label の重複が無いか
- **正解** — `correct` が data/<試験>/answer_keys.json の正解と一致するか。
  ここがずれると「誤答の説明」が正解の説明になり、逆を覚えさせる
- **content_key** — 実在するか。`question_id` から計算した鍵と一致するか。
  ずれていると誰にも表示されない解説になる（キーが一致した問題にだけ出る）
- **誤答の用語** — 誤答3件は「何の用語の説明か」を書くのが基本形。
  計算問題や正誤判定型は用語に落ちないので term なしを許すが、note は必ず要る
- **空** — correct_reason と note が空でないか
- **過去問の直接引用** — 引用すると出典表示の義務が生じる。問題文・選択肢と
  30字以上そのまま一致する部分がないかを調べる（check_materials.py と同じ基準）
- **用語のポップ** — 本文中の `[[用語]]` が用語集で解決できるか。解決できないと
  画面では色が付かず素の文字になる（壊れはしないが、書いた意図が消える）
- **担当バンドルとの突合** — 入力バンドルにある問題が全部書かれているか、
  担当外のものが混じっていないか
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_seed import (  # 計算・派生の定義は1か所に持つ
    EXPLANATION_DIR,
    TERM_REF,
    build_glossary,
    content_key_of,
    exam_of_question_id,
    exam_rank,
    load_materials,
    read_explanations,
)

LABELS = ["ア", "イ", "ウ", "エ"]
# 引用とみなす一致長。check_materials.py と揃える。
QUOTE_LEN = 30
# note は1行。長い解説は教材（論点側）の仕事なので、はみ出したら警告する。
NOTE_MAX = 90
REASON_RANGE = (20, 300)


def shingles(text: str, n: int = QUOTE_LEN):
    """空白を除いた本文の n 文字窓。折り返しの違いを無視して一致を見る。"""
    s = re.sub(r"\s", "", text or "")
    for i in range(len(s) - n + 1):
        yield s[i : i + n]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    # 入力バンドルの置き場。build_explanation_bundles.py に --out を渡して
    # 別名で作り直したときは、ここにも同じディレクトリを渡す。
    ap.add_argument("--bundles", default=None, type=Path,
                    help="入力バンドルの置き場。既定は <data>/explanation_bundles")
    ap.add_argument("--all", action="store_true", help="警告・問題を上位 20 件で打ち切らず全件出す（並行担当が自分のバンドル分を grep するとき）")
    args = ap.parse_args()
    d = args.data
    bundles = args.bundles or (d / "explanation_bundles")

    topics = json.loads((d / "topics.json").read_text(encoding="utf-8"))["topics"]
    keys = json.loads((d / "answer_keys.json").read_text(encoding="utf-8"))
    materials = load_materials(d)

    # --- 過去問 ---------------------------------------------------------
    questions: dict[str, dict] = {}
    by_key: dict[str, list[str]] = {}
    corpus: list[str] = []
    for path in sorted((d / "questions").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for qq in data["questions"]:
            qid = f"{data['exam']}-q{qq['number']}"
            qq["_exam"] = data["exam"]
            qq["_key"] = content_key_of(qq)
            questions[qid] = qq
            by_key.setdefault(qq["_key"], []).append(qid)
            corpus.append(qq["text"] + "".join((qq.get("choices") or {}).values()))
    # 原文の窓をハッシュで持つ。文字列のまま持つと数百 MB になる
    corpus_grams = {hash(g) for text in corpus for g in shingles(text)}

    explanations, duplicated = read_explanations(d)
    if not explanations:
        print(f"{d}/{EXPLANATION_DIR} に解説がありません。")
        return 0

    glossary, unresolved = build_glossary(d, explanations, materials, topics)

    problems: list[str] = []
    warnings: list[str] = []
    no_term_wrong = 0
    # 2026-09-25 の読み直しで出た型: 同じ term に別の note（用語集で 1 つに畳まれる）、
    # 「この値にはなりません」で終わる計算の note（どの誤りでその値になるかが無い）、文末の型の混在
    notes_by_term: dict[str, set[str]] = {}
    DEAD_END = re.compile(r"(には|は)なりません。?$|出ない値です。?$")
    POLITE = re.compile(r"(です|ます|ません|でしょう|ました)[。）)]*$")

    for ck in sorted(explanations):
        e = explanations[ck]
        qid = e.get("question_id") or "?"
        where = f"{e.get('_file')} {qid}"

        # --- content_key -------------------------------------------------
        q = questions.get(qid)
        if not q:
            problems.append(f"{where}: question_id が実在しない")
        elif q["_key"] != ck:
            problems.append(
                f"{where}: content_key が問題と一致しない"
                f"（書かれた {ck} / 実際 {q['_key']}）— 誰にも表示されない解説になる"
            )
        elif ck not in by_key:
            problems.append(f"{where}: content_key {ck} が過去問に無い")
        if q and by_key.get(ck):
            newest = max(by_key[ck], key=lambda i: exam_rank(questions[i]["_exam"]))
            if newest != qid:
                warnings.append(f"{where}: 代表は最新の回の {newest}（表示には影響しない）")

        # --- 正解 ---------------------------------------------------------
        want = keys.get(exam_of_question_id(qid), {}).get(str((q or {}).get("number"))) if q else None
        if want and e.get("correct") != want:
            problems.append(
                f"{where}: correct が『{e.get('correct')}』（正解表は『{want}』）"
                "— 誤答の説明と正解が入れ替わっている"
            )

        # --- 選択肢の構造 ---------------------------------------------------
        choices = e.get("choices") or []
        labels = [c.get("label") for c in choices]
        if labels != LABELS:
            if sorted(filter(None, labels)) != sorted(LABELS):
                problems.append(f"{where}: 選択肢が ア〜エ の4件でない（{labels}）")
            else:
                warnings.append(f"{where}: 選択肢の並びが ア〜エ の順でない（{labels}）")
        if len(set(labels)) != len(labels):
            problems.append(f"{where}: label が重複している（{labels}）")

        reason = (e.get("correct_reason") or "").strip()
        if not reason:
            problems.append(f"{where}: correct_reason が空")
        elif not REASON_RANGE[0] <= len(reason) <= REASON_RANGE[1]:
            warnings.append(f"{where}: correct_reason が {len(reason)}字"
                            f"（目安 {REASON_RANGE[0]}〜{REASON_RANGE[1]}）")

        # note の文末は敬体で統一（2026-09-25 の決定）。問題の中で全部常体だと「混在」には当たらず素通りしたので、常体を 1 件でも数える
        plain = [c.get("label") for c in choices if c.get("label") != e.get("correct") and (c.get("note") or "").strip() and not POLITE.search((c.get("note") or "").strip())]
        if plain:
            warnings.append(f"{where} {'・'.join(map(str, plain))}: 誤答の note の文末が常体（敬体で統一。体言止めにしない）")
        for c in choices:
            lab = c.get("label")
            note = (c.get("note") or "").strip()
            term = (c.get("term") or "").strip()
            if not note:
                problems.append(f"{where} {lab}: note が空")
                continue
            if term and lab != e.get("correct"):
                # 用語集に入るのは 1 文目だけ（build_seed.note_brief と同じ切り方）なので、割れも 1 文目で見る
                first = re.search(r"^(.+?[。．])", note)
                notes_by_term.setdefault(term, set()).add((first.group(1) if first else note).strip())
            if lab != e.get("correct") and DEAD_END.search(note):
                warnings.append(f"{where} {lab}: note が「この値にはなりません」型で終わる（どの誤りでその値になるかを 1 つ書く）")
            if len(note) > NOTE_MAX:
                warnings.append(f"{where} {lab}: note が {len(note)}字（1行に収める。目安 {NOTE_MAX} 字）")
            if lab == e.get("correct"):
                # 正解の行は term なしでよい。note は「正解。〜」の形を推奨
                if not note.startswith("正解"):
                    warnings.append(f"{where} {lab}: 正解の note が「正解。」で始まっていない")
            else:
                if note.startswith("正解"):
                    problems.append(f"{where} {lab}: 誤答の note が「正解」で始まっている")
                if not term:
                    # 「○○の説明」型でない誤答（計算問題・正誤判定型）は term なしを許す
                    no_term_wrong += 1

        # --- 引用 -----------------------------------------------------------
        body = reason + "\n" + "\n".join((c.get("note") or "") for c in choices)
        for g in shingles(body):
            if hash(g) in corpus_grams:
                problems.append(f"{where}: 過去問の原文と {QUOTE_LEN} 字以上一致『{g[:20]}…』")
                break

        # --- 用語のポップ ------------------------------------------------------
        for term in TERM_REF.findall(body):
            if term not in glossary:
                # 並行して書いている他の担当の誤答 term で後から解決することが多いので警告止まり。
                # 最終的に残ったものは glossary_overrides.json で埋める（画面では素の文字になるだけ）
                warnings.append(
                    f"{where}: [[{term}]] が用語集で解決できない"
                    "（他の担当の term で解決するか、glossary_overrides.json に書く）"
                )

    # --- 担当バンドルとの突合 ------------------------------------------------
    # 担当バンドル NN を渡した担当が別の問題を書いて NN として出してくると、
    # その問題が誰にも書かれないまま残る（教材で実際に起きている）。
    covered_files = 0
    for path in sorted((d / EXPLANATION_DIR).glob("*.json")):
        src = bundles / path.name
        if not src.exists():
            continue
        covered_files += 1
        want_keys = {
            q["content_key"]: q["question_id"]
            for t in json.loads(src.read_text(encoding="utf-8"))["topics"]
            for q in t["questions"]
        }
        got = {
            e.get("content_key"): e.get("question_id")
            for e in json.loads(path.read_text(encoding="utf-8")).get("explanations", [])
        }
        missing = [want_keys[k] for k in want_keys if k not in got]
        extra = [got[k] for k in got if k not in want_keys]
        if missing or extra:
            problems.append(
                f"{path.name}: 担当バンドルと問題が違う"
                f"（書かれていない {sorted(missing)[:5]} / 担当外 {sorted(extra)[:5]}）"
            )

    multi = {t: n for t, n in notes_by_term.items() if len(n) > 1}
    if multi:
        warnings.append(f"同じ term に別の note（1 文目）が {len(multi)} 語（用語集では最新の回の 1 文目だけを採る）: {sorted(multi)[:5]}")
    print(f"解説 {len(explanations)} 本 / 用語集 {len(glossary)} 語")
    print(f"  担当バンドルと突合できたファイル: {covered_files}")
    if no_term_wrong:
        print(f"  term を持たない誤答 {no_term_wrong} 件（計算問題・正誤判定型なら正常）")
    if duplicated:
        warnings.append(f"複数ファイルに重複した解説 {len(set(duplicated))} 件: {sorted(set(duplicated))[:5]}（後勝ち）")
    if unresolved:
        problems.append(
            f"用語集で解決できない [[用語]] {len(unresolved)} 件: {unresolved[:5]}"
            "（誤答の term に足すか glossary_overrides.json に書く）"
        )

    limit = None if args.all else 20
    if warnings:
        print(f"\n警告 {len(warnings)} 件:")
        for w in warnings[:limit]:
            print(f"  - {w}")
        if limit and len(warnings) > limit:
            print(f"  … 他 {len(warnings) - limit} 件（--all で全件）")

    if problems:
        print(f"\n問題 {len(problems)} 件:", file=sys.stderr)
        for p in problems[:limit]:
            print(f"  - {p}", file=sys.stderr)
        if limit and len(problems) > limit:
            print(f"  … 他 {len(problems) - limit} 件", file=sys.stderr)
        return 1

    print("\n検証: 問題なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
