#!/usr/bin/env python3
"""資格対策の学びの「問題ごとの解説」を教材の門にかける（契約 UC-022 の checkExplanations）。

    python3 scripts/check_explanations.py --data data/ip [--bundles <入力の束の置き場>] [--all]

解説は論点ごとに分担して書くため、担当ごとに流儀がずれる。教材と同じで、1 件ずつ読んでも気づけないので機械で洗い出す。
**担当の自己申告は当てにしない。**

- 門が読むファイル（入力の束・書き手の問題解説・過去問・正解表・論点・論点の別名・教材・用語の上書き・登録簿）のパスは、作業ディレクトリが起点
  （登録簿は作業ディレクトリの src/shared/targets.json）
- 結果: 人が読む行（数の要約・警告・問題点）のあとに、標準出力の最後の行として機械向けの 1 行
  {"exitCode","questions","stops","warnings","limits"} を出す。止める理由と警告は件数で打ち切らずにすべて並べる。
  止める理由が 1 件以上なら終了の状態 1、無ければ 0。人が読む行は --all が無ければ上位 20 件で打ち切る
- 断るとき（引数の誤り・登録簿に無い学び・資格対策でない学び・入力の束の置き場が無い・正解表が無いか読めない）は、何も確かめずに
  標準出力に共有の形の断り（ToolError）を 1 行出して終了の状態 2 で終える
- 正解の根拠と選択肢ごとの説明の量は見ない。用語の説明に使う選択肢の説明の字数だけを表示の制約として警告する
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from build_seed import TERM_REF, _strip_marks, content_key_of, exam_rank, note_brief  # noqa: E402  計算・派生の定義は1か所に持つ
from learning_parts import exam_of_question_id  # noqa: E402
from material_generations import generation_dirs  # noqa: E402
from tool_refusal import CODE, Refused, RefusingArgumentParser, tool_error_line  # noqa: E402

REGISTRY = Path("src/shared/targets.json")
LABELS = ["ア", "イ", "ウ", "エ"]
# 門が使う閾値と表示の制約（契約の limits）
LIMITS = {"quoteLength": 30, "choiceNoteLength": 90}
DEAD_END = re.compile(r"(には|は)なりません。?$|出ない値です。?$")
POLITE = re.compile(r"(です|ます|ません|でしょう|ました)[。）)]*$")


def _read_json(path: str):
    """JSON のファイルを読む。無ければ NOT_FOUND、JSON として読めなければ INVALID_INPUT の失敗を渡す。"""
    p = Path(path)
    if not p.is_file():
        raise Refused(CODE.NOT_FOUND, f"{path} が無い")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refused(CODE.INVALID_INPUT, f"{path} が JSON として読めない")


# @operation UC-022#readLearningKind
def read_learning_kind(*, learning: str) -> dict:
    """登録簿（src/shared/targets.json）のその学びの種類（exam が資格対策）。登録簿に無ければ NOT_FOUND。"""
    try:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except OSError:
        registry = {}
    entry = registry.get(learning) if isinstance(registry, dict) and not learning.startswith("_") else None
    if not isinstance(entry, dict):
        raise Refused(CODE.NOT_FOUND, f"登録簿に無い学び『{learning}』")
    return {"kind": "roadmap" if entry.get("kind") == "roadmap" or entry.get("roadmap") is True else "exam"}


# @operation UC-022#readExplanationBundle
def read_explanation_bundle(*, path: str) -> dict:
    """問題解説の入力の束 1 つ（topics[].questions[] の question_id と content_key）。形として読めなければ INVALID_INPUT。"""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refused(CODE.INVALID_INPUT, f"{path} が JSON として読めない")
    topics = doc.get("topics") if isinstance(doc, dict) else None
    ok = isinstance(topics, list) and all(
        isinstance(t, dict) and isinstance(t.get("questions"), list)
        and all(isinstance(q, dict) and isinstance(q.get("question_id"), str) and q["question_id"] and isinstance(q.get("content_key"), str) and q["content_key"]
                for q in t["questions"])
        for t in topics)
    if not ok:
        raise Refused(CODE.INVALID_INPUT, f"{path} が入力の束の形（topics[].questions[] の question_id・content_key）でない")
    return {"topics": topics}


# @operation UC-022#readExplanations
def read_explanations(*, path: str) -> dict:
    """書き手が書いた問題解説のファイル 1 つ。無ければ NOT_FOUND、問題解説の並び（explanations。行は object）として読めなければ
    INVALID_INPUT。行の欄の欠けと空は門が必須の要素として見る。"""
    doc = _read_json(path)
    xs = doc.get("explanations") if isinstance(doc, dict) else None
    if not isinstance(xs, list) or not all(isinstance(x, dict) for x in xs):
        raise Refused(CODE.INVALID_INPUT, f"{path} が問題解説の形（explanations の並び）でない")
    return {"explanations": xs}


# @operation UC-022#readAnswerKeys
def read_answer_keys(*, path: str) -> dict:
    """正解表（回 → 問番号（文字列）→ 正解）。無ければ NOT_FOUND、JSON として読めないか、回の値が object でないか、
    正解が文字列でなければ INVALID_INPUT。"""
    doc = _read_json(path)
    if not isinstance(doc, dict) or not all(isinstance(v, dict) and all(isinstance(a, str) for a in v.values())
                                            for k, v in doc.items() if not k.startswith("_")):
        raise Refused(CODE.INVALID_INPUT, f"{path} が正解表の形でない")
    return {k: v for k, v in doc.items() if not k.startswith("_")}


# @operation UC-022#readPastQuestions
def read_past_questions(*, path: str) -> dict:
    """1 回分の過去問（exam と questions[].number・text・choices）。無ければ NOT_FOUND、形として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    qs = doc.get("questions") if isinstance(doc, dict) else None
    if not isinstance(doc, dict) or not isinstance(doc.get("exam"), str) or not isinstance(qs, list) \
            or not all(isinstance(q, dict) and type(q.get("number")) is int for q in qs):
        raise Refused(CODE.INVALID_INPUT, f"{path} が過去問の形でない")
    return {"exam": doc["exam"], "questions": qs}


# @operation UC-022#readTopics
def read_topics(*, path: str) -> dict:
    """論点の一覧（id・term・aliases）。無ければ NOT_FOUND、形として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    ts = doc.get("topics") if isinstance(doc, dict) else None
    if not isinstance(ts, list) or not all(isinstance(t, dict) and type(t.get("id")) is int and isinstance(t.get("term"), str) for t in ts):
        raise Refused(CODE.INVALID_INPUT, f"{path} が論点の一覧の形でない")
    return {"topics": ts}


# @operation UC-022#readTopicAliases
def read_topic_aliases(*, path: str) -> dict:
    """論点の別名の表（別名 → 論点の名前か別名。「_」で始まる鍵と、値が文字列でない行は使わない）。
    無ければ NOT_FOUND（別名を使わない）、形として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    if not isinstance(doc, dict):
        raise Refused(CODE.INVALID_INPUT, f"{path} が別名の表の形でない")
    return {k: v for k, v in doc.items() if not k.startswith("_") and isinstance(v, str)}


# @operation UC-022#readMaterialFile
def read_material_file(*, path: str) -> dict:
    """教材の世代の置き場の 1 つのファイルの教材。無ければ NOT_FOUND、JSON として読めないか論点の ID を持たない教材があれば INVALID_INPUT。"""
    doc = _read_json(path)
    ms = doc.get("materials", []) if isinstance(doc, dict) else None
    if not isinstance(ms, list) or not all(isinstance(m, dict) and type(m.get("topic_id")) is int for m in ms):
        raise Refused(CODE.INVALID_INPUT, f"{path} が教材の形（論点の ID を持つ materials の並び）でない")
    return {"materials": ms}


# @operation UC-022#readGlossaryOverrides
def read_glossary_overrides(*, path: str) -> dict:
    """用語の上書き（用語 → 説明。「_」で始まる鍵は使わない）。無ければ NOT_FOUND（上書きを使わない）、形として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    if not isinstance(doc, dict):
        raise Refused(CODE.INVALID_INPUT, f"{path} が用語の上書きの形でない")
    return {k: v for k, v in doc.items() if not k.startswith("_")}


def shingles(text: str, n: int = LIMITS["quoteLength"]):
    """空白を除いた本文の n 文字窓。折り返しの違いを無視して一致を見る。"""
    s = re.sub(r"\s", "", text or "")
    for i in range(len(s) - n + 1):
        yield s[i: i + n]


def _text(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _optional(read, note: str, empty):
    """門の止め方を要件が決めていない読み物（論点・別名・教材・上書き）。無いか読めなければ注を 1 行出して空で続ける。"""
    try:
        return read()
    except Refused as e:
        if e.code != CODE.NOT_FOUND or note:
            print(f"注: {e.reason}{note}")
        return empty


def refuse(code: str, reason: str) -> int:
    print(reason, file=sys.stderr)
    print(tool_error_line(code, reason))
    return 2


# @operation UC-022#checkExplanations
def main() -> int:
    ap = RefusingArgumentParser(allow_abbrev=False)
    ap.add_argument("--data", default="data/ip")
    # 入力バンドルの置き場。build_explanation_bundles.py に --out を渡して別名で作り直したときは、ここにも同じ置き場を渡す。
    ap.add_argument("--bundles", default=None, help="入力バンドルの置き場。既定は <data>/explanation_bundles")
    ap.add_argument("--all", action="store_true", help="人が読む行の警告・問題を上位 20 件で打ち切らず全件出す（機械向けの 1 行はいつも全件）")
    args = ap.parse_args()
    d = Path(args.data.rstrip("/"))
    try:
        kind = read_learning_kind(learning=d.name)["kind"]
    except Refused:
        return refuse(CODE.INVALID_INPUT, f"登録簿に無い学び『{d.name}』")
    if kind != "exam":
        return refuse(CODE.INVALID_INPUT, f"資格対策でない学び『{d.name}』")
    bundles = Path(args.bundles) if args.bundles else d / "explanation_bundles"
    if not bundles.is_dir():
        return refuse(CODE.NOT_FOUND, f"入力の束の置き場が無い: {bundles}")
    try:
        keys = read_answer_keys(path=(d / "answer_keys.json").as_posix())
    except Refused as e:
        return refuse(e.code, f"学びの正解表を読めない: {e.reason}")

    stops: list[dict] = []
    warns: list[dict] = []
    stop = lambda k, w, r: stops.append({"kind": k, "where": w, "reason": r})  # noqa: E731
    warn = lambda k, w, r: warns.append({"kind": k, "where": w, "reason": r})  # noqa: E731

    # --- 読み物 -----------------------------------------------------------
    topics = _optional(lambda: read_topics(path=(d / "topics.json").as_posix())["topics"], "（論点の名前で用語を解決しない）", [])
    aliases = _optional(lambda: read_topic_aliases(path=(d / "topic_aliases.json").as_posix()), "", {})
    overrides = _optional(lambda: read_glossary_overrides(path=(d / "glossary_overrides.json").as_posix()), "", {})
    questions: dict[str, dict] = {}
    by_key: dict[str, list[str]] = {}
    corpus: list[str] = []
    for path in sorted((d / "questions").glob("*.json")):
        try:
            doc = read_past_questions(path=path.as_posix())
        except Refused:
            # 読めないファイルの問題は照らさない（その問題を指す問題解説は「指す過去問が無い」側に数える）
            stop("unreadableOutput", f"過去問のファイル {path.stem}（{path.as_posix()}）", "過去問の形として読めない")
            continue
        for qq in doc["questions"]:
            qid = f"{doc['exam']}-q{qq['number']}"
            qq = dict(qq, _exam=doc["exam"], _key=content_key_of(qq))
            questions[qid] = qq
            by_key.setdefault(qq["_key"], []).append(qid)
            # 本文と選択肢の文は 1 つずつ照らす（文をまたぐ一致は数えない）
            corpus.append(str(qq.get("text") or ""))
            corpus += [str(v) for v in (qq.get("choices") or {}).values()]
    # 原文の窓をハッシュで持つ。文字列のまま持つと数百 MB になる
    corpus_grams = {hash(g) for text in corpus for g in shingles(text)}
    # 配る教材: 論点ごとに後の世代・後のファイルの教材
    materials: dict[int, dict] = {}
    for g in generation_dirs(d):
        for path in sorted(g.glob("*.json")):
            ms = _optional(lambda: read_material_file(path=path.as_posix())["materials"], "（このファイルの教材を見ない）", [])
            for m in ms:
                materials[m["topic_id"]] = m

    # --- 問題解説と入力の束 ---------------------------------------------------
    files: dict[str, list[dict]] = {}
    for path in sorted((d / "question_explanations").glob("*.json")):
        try:
            files[path.stem] = read_explanations(path=path.as_posix())["explanations"]
        except Refused:
            stop("unreadableOutput", f"問題解説のファイル {path.stem}（{path.as_posix()}）", "問題解説の形として読めない（書いている途中か壊れている）")
    entries = [(name, x) for name, xs in files.items() for x in xs]
    seen_in: dict[str, list[str]] = {}
    for name, x in entries:
        qid = x.get("question_id")
        if _text(qid) and name not in seen_in.setdefault(qid, []):
            seen_in[qid].append(name)
    for qid, names in sorted(seen_in.items()):
        if len(names) >= 2:
            stop("duplicate", f"問題 {qid}", f"同じ問題の問題解説が 2 つ以上のファイルにある: {'・'.join(names)}")
    covered_files = 0
    # 入力の束は束を作る道具（build_explanation_bundles.py）が書く expl_NN.json。同じ置き場の index.json（束の一覧）は束でない
    for bp in sorted(bundles.glob("expl_*.json")):
        try:
            btopics = read_explanation_bundle(path=bp.as_posix())["topics"]
        except Refused:
            stop("unreadableOutput", f"入力の束のファイル {bp.stem}（{bp.as_posix()}）", "入力の束の形として読めない（書いている途中か壊れている）")
            continue
        want = [q["question_id"] for t in btopics for q in t["questions"]]
        if bp.stem not in files:
            if (d / "question_explanations" / bp.name).exists():
                continue  # 読めない問題解説のファイルは unreadableOutput で挙げた
            for qid in want:
                stop("missingExplanation", f"問題 {qid}（{bp.stem}）", "入力の束にある問題の問題解説が無い（同じ名前の問題解説のファイルが無い）")
            continue
        covered_files += 1
        got = {x.get("question_id") for x in files[bp.stem]}
        for qid in want:
            if qid not in got:
                stop("missingExplanation", f"問題 {qid}（{bp.stem}）", "入力の束にある問題の問題解説が無い")
        for x in files[bp.stem]:
            if x.get("question_id") not in want:
                stop("bundleMismatch", f"問題 {x.get('question_id')}（{bp.stem}）", "同じ名前の入力の束に無い問題の問題解説")

    # --- 用語集で解決できる語（選択肢の用語・用語の上書き・教材のある論点の名前と別名） ----------------
    resolvable: set[str] = set()
    for _, x in entries:
        for c in x.get("choices") or []:
            if not isinstance(c, dict):
                continue
            term = (c.get("term") or "").strip() if isinstance(c.get("term"), str) else ""
            brief = note_brief(re.sub(r"^正解[。．，、]?\s*", "", _strip_marks(c.get("note") or "") if isinstance(c.get("note"), str) else "").strip())
            if term and brief:
                resolvable.add(term)
    for term, v in overrides.items():
        if isinstance(v, str) or (isinstance(v, dict) and (v.get("brief") or "topic_id" in v)):
            resolvable.add(term)
    to_topic: dict[str, int] = {}
    for t in topics:
        to_topic.setdefault(t["term"], t["id"])
        for a in t.get("aliases") or []:
            to_topic.setdefault(a, t["id"])
    for src, dst in aliases.items():
        if dst in to_topic:
            to_topic.setdefault(src, to_topic[dst])
    has_material = {tid for tid, m in materials.items() if _text(m.get("explanation"))}

    def resolved(term: str) -> bool:
        return term in resolvable or to_topic.get(term) in has_material

    # --- 問題解説ごと ---------------------------------------------------------
    notes_by_term: dict[str, set[str]] = {}
    for name, e in entries:
        qid = e.get("question_id") if _text(e.get("question_id")) else "?"
        where = f"問題 {qid}（{name}）"
        lacking = [k for k in ("content_key", "correct", "correct_reason", "choices") if k not in e]
        lacking += [f"{k}（空）" for k in ("content_key", "correct", "correct_reason") if k in e and not _text(e.get(k))]
        choices = e.get("choices") if isinstance(e.get("choices"), list) else []
        if "choices" in e and not choices:
            lacking.append("choices（空）")
        labels = [c.get("label") if isinstance(c, dict) else None for c in choices]
        if choices and (len(choices) != 4 or sorted(map(str, labels)) != sorted(LABELS)):
            lacking.append(f"choices（ア〜エの 4 つでない・記号が重なる: {labels}）")
        for c in choices:
            if not isinstance(c, dict) or not _text(c.get("note")):
                lacking.append(f"choices[{c.get('label') if isinstance(c, dict) else '?'}].note")
        if lacking:
            stop("missingElement", where, f"必須の要素が無いか空: {'、'.join(lacking)}")
        elif labels != LABELS:
            warn("labelOrder", where, f"選択肢の説明がア〜エの順に並ばない（{labels}）")

        ck = e.get("content_key")
        q = questions.get(qid)
        if not q:
            stop("questionMissing", where, "指す過去問が無い")
        if _text(ck):
            if ck not in by_key:
                stop("contentKeyMismatch", where, f"同一内容の鍵 {ck} が過去問に無い")
            elif q and q["_key"] != ck:
                stop("contentKeyMismatch", where, f"同一内容の鍵が指す過去問から作った鍵と違う（書かれた {ck} / 実際 {q['_key']}）— 誰にも表示されない解説になる")
            if q and by_key.get(ck) and q["_key"] == ck:
                newest = max(by_key[ck], key=lambda i: exam_rank(questions[i]["_exam"]))
                if newest != qid:
                    warn("representativeNotNewest", where, f"同一内容の組の代表は最新の回の {newest}（表示には影響しない）")
        want = keys.get(exam_of_question_id(qid), {}).get(str(q.get("number"))) if q else None
        if want and _text(e.get("correct")) and e.get("correct") != want:
            stop("answerKeyMismatch", where, f"正解が『{e.get('correct')}』（正解表は『{want}』）— 誤答の説明と正解が入れ替わっている")

        correct = e.get("correct")
        marks = []
        for c in choices:
            if not isinstance(c, dict) or not _text(c.get("note")):
                continue
            lab, note = c.get("label"), c["note"].strip()
            term = c.get("term").strip() if isinstance(c.get("term"), str) else ""
            # 用語の説明に使う説明の字数は、正解の選択肢でも「正解。」を含めて数える
            if term and len(note) > LIMITS["choiceNoteLength"]:
                warn("choiceNoteLong", f"{where} {lab}", f"用語の説明に使う選択肢の説明が {len(note)} 字（上限 {LIMITS['choiceNoteLength']} 字）")
            if lab == correct:
                if not note.startswith("正解"):
                    marks.append(f"{lab}（正解の説明が「正解」で始まらない）")
                continue
            if note.startswith("正解"):
                marks.append(f"{lab}（誤答の説明が「正解」で始まる）")
            if not POLITE.search(note):
                warn("plainNote", f"{where} {lab}", "誤答の選択肢の説明の文末が敬体でない（体言止め・常体にしない）")
            if DEAD_END.search(note):
                warn("noteValueOnly", f"{where} {lab}", "「この値にはなりません」型で終わる（どの誤りでその値になるかを 1 つ書く）")
            if term:
                # 用語集に入るのは 1 文目だけ（build_seed.note_brief と同じ切り方）なので、割れも 1 文目で見る
                notes_by_term.setdefault(term, set()).add(note_brief(note))
        if marks:
            stop("correctMarkMismatch", where, f"正解の印が正解と食い違う: {'・'.join(marks)}")

        reason = e.get("correct_reason") if isinstance(e.get("correct_reason"), str) else ""
        body = reason + "\n" + "\n".join((c.get("note") or "") for c in choices if isinstance(c, dict) and isinstance(c.get("note"), str))
        for g in shingles(body):
            if hash(g) in corpus_grams:
                stop("pastQuestionQuote", where, f"過去問の原文と {LIMITS['quoteLength']} 字以上一致『{g[:20]}…』")
                break
        for term in TERM_REF.findall(body):
            if not resolved(term):
                stop("unresolvedTerm", where, f"[[{term}]] が用語集で解決できない（誤答の term に足すか glossary_overrides.json に書く）")
    for tid, m in sorted(materials.items()):
        body = f"{m.get('explanation') or ''}\n{m.get('detail') or ''}"
        for term in TERM_REF.findall(body):
            if not resolved(term):
                name = next((t["term"] for t in topics if t["id"] == tid), "")
                stop("unresolvedTerm", f"教材 {tid} {name}".rstrip(), f"[[{term}]] が用語集で解決できない（誤答の term に足すか glossary_overrides.json に書く）")
    for term, notes in sorted(notes_by_term.items()):
        if len(notes) > 1:
            warn("termNotesDiffer", term, f"同じ用語の誤答の説明の 1 文目が {len(notes)} 通りある（用語集では最新の回の 1 文目だけを採る）")

    # --- 人が読む行 -----------------------------------------------------------
    print(f"解説 {len(entries)} 本")
    print(f"  担当バンドルと突合できたファイル: {covered_files}")
    limit = None if args.all else 20
    if warns:
        print(f"\n警告 {len(warns)} 件:")
        for w in warns[:limit]:
            print(f"  - {w['where']}: {w['reason']}")
        if limit and len(warns) > limit:
            print(f"  … 他 {len(warns) - limit} 件（--all で全件）")
    if stops:
        print(f"\n問題 {len(stops)} 件:", file=sys.stderr)
        for s in stops[:limit]:
            print(f"  - {s['where']}: {s['reason']}", file=sys.stderr)
        if limit and len(stops) > limit:
            print(f"  … 他 {len(stops) - limit} 件", file=sys.stderr)
    else:
        print("\n検証: 問題なし")
    code = 1 if stops else 0
    print(json.dumps({"exitCode": code, "questions": len(entries), "stops": stops, "warnings": warns, "limits": LIMITS}, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
