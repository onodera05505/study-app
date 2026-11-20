#!/usr/bin/env python3
"""資格対策の学びの教材の世代を教材の門にかける（契約 UC-018 の checkMaterials）。

    python3 scripts/check_materials.py --data data/ip [--dir data/ip/materials_v3 ...] [--public public] [--all]

教材は論点ごとに分担して書くため、担当ごとに流儀がずれる。1 件ずつ読んでも気づけないので、機械的に検出できるものはここで洗い出す。

- 門が読むファイル（教材の世代・論点・過去問・束の割り当て・登録簿・図）のパスは、作業ディレクトリが起点
  （登録簿は作業ディレクトリの src/shared/targets.json）
- 結果: 人が読む行（数の要約・警告・問題点）のあとに、標準出力の最後の行として機械向けの 1 行
  {"exitCode","topics","missingTopics","stops","warnings","limits"} を出す。止める理由と警告は件数で打ち切らずにすべて並べる。
  止める理由が 1 件以上なら終了の状態 1、無ければ 0。人が読む行は --all が無ければ上位 20 件で打ち切る
- 断るとき（引数の誤り・登録簿に無い学び・資格対策でない学び・学びの置き場の外の教材の世代の置き場・学びの置き場か指定した置き場が無い）は、
  何も確かめずに標準出力に共有の形の断り（ToolError）を 1 行出して終了の状態 2 で終える
- 情報の量（字数・文数・見出しの数・箇条書きや比較の項目の数）は止める理由にも警告にもしない（BR-042）
- 見る世代は既定で配る本文と同じ（materials と materials_v<番号> を番号の小さい順に。後勝ち）。同じ論点は並びの最も後ろの世代の教材だけを確かめる
- 「見出しを持つ教材」は詳しい解説が「### 」で始まる行を持つ教材。記法・表・図はこの教材だけで見る。
  「役割分担後の世代」は materials_v に続く番号が limits.roleSplitFrom 以上の世代（誤答のケアは問題解説の持ち場）
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from material_generations import GENERATION_DIR, generation_dirs  # noqa: E402
from tool_refusal import CODE, Refused, RefusingArgumentParser, tool_error_line  # noqa: E402

REGISTRY = Path("src/shared/targets.json")
# 門が使う閾値と表示の制約（契約の limits）
LIMITS = {
    "quoteLength": 30,
    "quoteStep": 10,
    "requiredExplanationLine": "**キーワード**",
    "tableColumns": {"min": 2, "max": 4},
    "tableRows": {"min": 2, "max": 8},
    "tableCellLength": 40,
    "roleSplitFrom": 3,
    "bundleGeneration": "materials_v2",
}

MARKDOWN = re.compile(r"(^#{1,6}\s|\*\*|^\s*[-*]\s|\[.+?\]\(.+?\))", re.M)
# 見出しを持つ教材で使ってはいけない記法。Markdown.tsx が解釈しないものをすべて挙げる。
# 表は通るようになったので外してある（代わりに構造を check_tables で見る）。
FORBIDDEN_V2 = [
    (re.compile(r"^#{1,2}\s", re.M), "見出し # / ##（画面の見出しと衝突する）"),
    (re.compile(r"^#{4,}\s", re.M), "見出し #### 以下（### だけ使う）"),
    (re.compile(r"\[[^\]]+\]\([^)]+\)", re.M), "リンク・画像"),
    (re.compile(r"^\s*```", re.M), "コードブロック"),
    (re.compile(r"^\s*>", re.M), "引用"),
    (re.compile(r"^\s*(---+|___+|\*\*\*+)\s*$", re.M), "水平線"),
    (re.compile(r"^\s*[*+]\s", re.M), "箇条書きの * / +（- を使う）"),
    (re.compile(r"\^"), "べき乗の ^（画面で記号のまま出る。「M の n 乗」と書く）"),
    (re.compile(r"~~"), "取り消し線 ~~"),
]
# 役割分担の戻り。誤答のケアは解説 note の持ち場
SOLVING_HINT = re.compile(r"ではありません|限定もありません|絞れません|絞れます|落とせます|見分けられます|仕分けてください|判断材料になりません|決め手になりません|引っかけは|選択肢")
POLITE_END = re.compile(r"(です|ます|ません|でしょう|ました|ください|でした)[。）)]*$")
TERM_BOLD = re.compile(r"\*\*([^*\[\]]{2,30})\*\*")
HEADING = re.compile(r"^###\s+(.*\S)\s*$", re.M)
LIST_ITEM = re.compile(r"^(?:-\s|\d+[.)]\s)")
# 選択肢の記号（ア・イ・ウ・エ）の直書き。問題を差し替えると誤りになる。
# 「正解はウィザード」のようなカタカナ語の先頭に当たらないよう、記号の直後にカタカナが続くものは除く。
CHOICE_SYMBOL = re.compile(
    r"((?:正解|正答|答え|解答|誤答)(?:は|が|の|に)?|選択肢)\s*[「『]?([アイウエ])(?![ァ-ヴー])[」』]?"
)
# 説明が計算に触れているか（「計算で問われる」「計算で求める」「算出」など）
CALC_CLAIM = re.compile(r"計算|算出|求めさせ")
# 式らしい記述か（記号でも日本語でも可）
FORMULA_LIKE = re.compile(r"[÷×]|＝|を[^。\n]{0,12}で割|から[^。\n]{0,12}を(引|差し引)|の積")

# --- 表 ---------------------------------------------------------------
# Markdown.tsx と同じ判定にしておくこと。ここで通したものが画面で崩れると、
# 検証を通ったのに表示が壊れる、という一番たちの悪い状態になる。
DELIM_CELL = re.compile(r"^:?-+:?$")


def _read_json(path: str):
    """JSON のファイルを読む。無ければ NOT_FOUND、JSON として読めなければ INVALID_INPUT の失敗を渡す。"""
    p = Path(path)
    if not p.is_file():
        raise Refused(CODE.NOT_FOUND, f"{path} が無い")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Refused(CODE.INVALID_INPUT, f"{path} が JSON として読めない")


# @operation UC-018#readLearningKind
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


# @operation UC-018#readTopics
def read_topics(*, path: str) -> dict:
    """論点の一覧（id・term）。無ければ NOT_FOUND、形として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    ts = doc.get("topics") if isinstance(doc, dict) else None
    if not isinstance(ts, list) or not all(isinstance(t, dict) and type(t.get("id")) is int and isinstance(t.get("term"), str) for t in ts):
        raise Refused(CODE.INVALID_INPUT, f"{path} が論点の一覧の形でない")
    return {"topics": ts}


# @operation UC-018#readPastQuestions
def read_past_questions(*, path: str) -> dict:
    """1 回分の過去問の本文。無ければ NOT_FOUND、形として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    qs = doc.get("questions") if isinstance(doc, dict) else None
    if not isinstance(qs, list) or not all(isinstance(q, dict) and isinstance(q.get("text"), str) for q in qs):
        raise Refused(CODE.INVALID_INPUT, f"{path} が過去問の形でない")
    return {"questions": qs}


# @operation UC-018#readMaterialFile
def read_material_file(*, path: str) -> dict:
    """教材の世代の置き場の 1 つのファイルの教材（materials の無いファイルは教材を持たない）。無ければ NOT_FOUND、
    JSON として読めないか論点の ID を持たない教材があれば INVALID_INPUT。"""
    doc = _read_json(path)
    ms = doc.get("materials", []) if isinstance(doc, dict) else None
    if not isinstance(ms, list) or not all(isinstance(m, dict) and type(m.get("topic_id")) is int for m in ms):
        raise Refused(CODE.INVALID_INPUT, f"{path} が教材の形（論点の ID を持つ materials の並び）でない")
    return {"materials": ms}


# @operation UC-018#readMaterialBundle
def read_material_bundle(*, path: str) -> dict:
    """束の割り当て（書き手に渡した論点）。無ければ NOT_FOUND（突き合わせない）、形として読めなければ INVALID_INPUT。"""
    doc = _read_json(path)
    ts = doc.get("topics") if isinstance(doc, dict) else None
    if not isinstance(ts, list) or not all(isinstance(t, dict) and type(t.get("topic_id")) is int for t in ts):
        raise Refused(CODE.INVALID_INPUT, f"{path} が束の割り当ての形（topics[].topic_id）でない")
    return {"topics": ts}


# @operation UC-018#readFigure
def read_figure(*, src: str, public: str = "public") -> dict:
    """図の行の参照先（/figures/materials/<学び>/…svg）の実体を配信の置き場の下で探す。無ければ NOT_FOUND。"""
    p = Path(public) / src.lstrip("/")
    if not p.is_file():
        raise Refused(CODE.NOT_FOUND, f"図の画像が置き場所に無い: {p.as_posix()}")
    return {"file": p.as_posix()}


def role_split(generation: str) -> bool:
    """世代の置き場の名前が役割分担後の世代か（materials_v<番号> の番号が limits.roleSplitFrom 以上）。"""
    mo = GENERATION_DIR.match(generation)
    return bool(mo and mo.group(1)) and int(mo.group(1)) >= LIMITS["roleSplitFrom"]


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


def check_tables(stop, where: str, text: str) -> None:
    """表の構造と表示の制約を見る。崩れていると画面にパイプがそのまま出る（止める）。"""
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
    lim_r, lim_c = LIMITS["tableRows"], LIMITS["tableColumns"]
    for block in blocks:
        head = split_row(block[0])
        label = block[0][:24]
        if len(block) < 2:
            # 表示側は1行だけの塊を表と見なさない（段落として出る）
            if block[0].startswith("|"):
                stop("brokenTable", where, f"表が1行しかない『{label}…』（区切り行 | --- | が要る）")
            continue
        if not (len(split_row(block[1])) >= 2 and all(DELIM_CELL.match(c) for c in split_row(block[1]))):
            stop("brokenTable", where, f"表の2行目が区切り行でない『{label}…』（| --- | --- | を置く）")
            continue
        body = [split_row(r) for r in block[2:]]
        uneven = [(i, len(r)) for i, r in enumerate(body, start=3) if len(r) != len(head)]
        if uneven:
            i, n = uneven[0]
            stop("brokenTable", where, f"表のセル数が揃っていない『{label}…』（{i}行目 {n} 個 / ヘッダ {len(head)} 個）")
        rows = 1 + len(body)
        if rows < lim_r["min"]:
            stop("tableTooShort", where, f"表が {rows} 行『{label}…』（ヘッダ込みで {lim_r['min']}〜{lim_r['max']} 行）")
        if rows > lim_r["max"]:
            stop("tableTooLong", where, f"表が {rows} 行『{label}…』（ヘッダ込みで {lim_r['min']}〜{lim_r['max']} 行）")
        if len(head) > lim_c["max"]:
            stop("tableTooWide", where, f"表が {len(head)} 列『{label}…』（{lim_c['min']}〜{lim_c['max']} 列）")


# --- 図の画像行 -------------------------------------------------------
# 画像は書き手が入れるものではない。論点ごとの図をスクリプトが差し込む。
def image_pattern(exam: str) -> re.Pattern:
    # 説明文には角かっこ（「A[1]」など）が入ってよい。`](` だけは入らない（表示側 Markdown.tsx と同じ読み方）。
    return re.compile(rf"^!\[((?:[^\]]|\](?!\())*)\]\((/figures/materials/{re.escape(exam)}/[^)\s]+\.svg)\)$")


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


def check_headed(stop, warn, where: str, generation: str, ex: str, det: str, pat: re.Pattern, public: str) -> int:
    """見出しを持つ教材の記法・表・図と、世代ごとの書き方を見る。図の枚数を返す。"""
    ex, ex_images = take_images(ex, pat)
    det, det_images = take_images(det, pat)
    images = ex_images + det_images
    for _caption, src in images:
        try:
            read_figure(src=src, public=public)
        except Refused:
            stop("figureMissing", where, f"図のファイルが無い『{src}』（画面が空欄になる）")

    for pattern, name in FORBIDDEN_V2:
        if pattern.search(ex) or pattern.search(det):
            warn("notationOutside", where, f"使えない記法 — {name}")
    check_tables(stop, where, ex)
    check_tables(stop, where, det)
    if (ex + det).count("**") % 2:
        warn("unclosedEmphasis", where, "閉じていない ** がある（そのまま画面に出る）")
    if HEADING.search(ex):
        warn("explanationHeading", where, "explanation に見出しがある（短いので使わない約束）")
    for mo in CHOICE_SYMBOL.finditer(ex + "\n" + det):
        warn("choiceSymbol", where, f"選択肢の記号を直書きしている『{mo.group(0)}』（内容で書く）")
    # 「計算で問われる」と言いながら、冒頭に式が無い。detail を開くまで式に辿り着けない
    if CALC_CLAIM.search(ex) and not FORMULA_LIKE.search(ex) and FORMULA_LIKE.search(det):
        warn("calcWithoutFormula", where, "explanation が計算に言及しているのに式が無い（detail にはある）")

    headings = HEADING.findall(det)
    if role_split(generation):
        # 出題パターンの見出しは置かず、explanation にキーワードの行を置く
        if any("出題" in h for h in headings):
            warn("patternHeadingLeft", where, "役割分担後の世代なのに出題パターンの見出しが残っている（問題解説側へ）")
        if LIMITS["requiredExplanationLine"] not in ex:
            warn("keywordLineMissing", where, f"explanation に {LIMITS['requiredExplanationLine']} の行が無い")
        body = ex + "\n" + det
        mo = SOLVING_HINT.search(body)
        if mo:
            warn("solvingHint", where, f"選択肢の消し方が教材に残っている『…{body[max(0, mo.start() - 12): mo.end()]}』（解説 note の持ち場）")
        first = ex.split("。")[0]
        if not first.lstrip().startswith("**"):
            warn("firstSentenceNotTerm", where, "explanation の 1 文目が **論点名** で始まっていない")
        for line in body.split("\n"):
            st = line.strip()
            if LIST_ITEM.match(st) and st.endswith("。") and not POLITE_END.search(st):
                warn("plainListEnding", where, f"箇条書きが常体で終わる『{st[:24]}…』（敬体で）")
                break
        # 詳しい解説で素の太字にした語のうち、本文の別の所で [[ ]] にも書いた語
        bare = set(TERM_BOLD.findall(det))
        popped = set(re.findall(r"\[\[([^\]]+)\]\]", ex + det))
        both = bare & popped
        if both:
            warn("termMarkupMixed", where, f"同じ語が [[ ]] と素の太字で混在『{sorted(both)[0]}』（一度ポップにした語は以後も [[ ]]）")
        for row in det.split("\n"):
            if is_row(row) and any(len(cell) > LIMITS["tableCellLength"] for cell in split_row(row)):
                warn("tableCellLong", where, f"表のセルが {LIMITS['tableCellLength']} 字超（スマホで横に伸びる）")
                break
    elif not any("出題" in h for h in headings):
        warn("patternHeadingMissing", where, "detail に出題パターンの見出しが無い")

    # リストの項目は1行で書く約束。折り返すと2行目が別の項目・段落として描画される
    indented = None
    for line in det.split("\n"):
        s = line.strip()
        if LIST_ITEM.match(s):
            if line.startswith((" ", "\t", "　")):
                indented = indented or f"字下げした項目がある『{s[:16]}…』（1行で書く）"
        elif s and line.startswith(("  ", "　")):
            indented = indented or f"字下げした行がある『{s[:16]}…』（折り返しは別段落になる）"
    if indented:
        warn("indentedLine", where, indented)
    return len(images)


def refuse(code: str, reason: str) -> int:
    print(reason, file=sys.stderr)
    print(tool_error_line(code, reason))
    return 2


# @operation UC-018#checkMaterials
def main() -> int:
    ap = RefusingArgumentParser(allow_abbrev=False)
    ap.add_argument("--data", default="data/ip")
    ap.add_argument("--dir", action="extend", nargs="+", help="検査するディレクトリの並び（既定は配る本文と同じ教材の世代の全部を古い順に。後勝ち）")
    # 教材に差し込んだ図の実体を確かめる先。/figures/… はこの下からの絶対パス。
    ap.add_argument("--public", default="public")
    ap.add_argument("--all", action="store_true", help="人が読む行の警告・問題を上位 20 件で打ち切らず全件出す（機械向けの 1 行はいつも全件）")
    args = ap.parse_args()
    d = Path(args.data.rstrip("/"))
    try:
        kind = read_learning_kind(learning=d.name)["kind"]
    except Refused:
        return refuse(CODE.INVALID_INPUT, f"登録簿に無い学び『{d.name}』")
    if kind != "exam":
        return refuse(CODE.INVALID_INPUT, f"資格対策でない学び『{d.name}』")
    if args.dir:
        dirs = [Path(x.rstrip("/")) for x in args.dir]
        # `--dir data/ap/materials_v2` だけ渡して `--data` を忘れると、応用情報の教材を IT パスポートの論点と突き合わせて
        # 「全件が論点名不一致」になる。学びの置き場の直下でない置き場は断る
        outside = [x for x in dirs if x.resolve().parent != d.resolve()]
        if outside:
            return refuse(CODE.INVALID_INPUT, f"{outside[0]} は --data（{d}）の直下の置き場でない。学びを切り替えるときは --data も一緒に渡す（例: --data data/ap）")
        if not d.is_dir():
            return refuse(CODE.NOT_FOUND, f"学びの置き場が無い: {d}")
        missing_dirs = [x for x in dirs if not x.is_dir()]
        if missing_dirs:
            return refuse(CODE.NOT_FOUND, f"指定した教材の世代の置き場が無い: {missing_dirs[0]}")
    else:
        if not d.is_dir():
            return refuse(CODE.NOT_FOUND, f"学びの置き場が無い: {d}")
        dirs = generation_dirs(d)

    stops: list[dict] = []
    warns: list[dict] = []
    stop = lambda k, w, r: stops.append({"kind": k, "where": w, "reason": r})  # noqa: E731
    warn = lambda k, w, r: warns.append({"kind": k, "where": w, "reason": r})  # noqa: E731

    try:
        topics = read_topics(path=(d / "topics.json").as_posix())["topics"]
    except Refused as e:
        print(f"注: {e.reason}（論点と照らさない）")
        topics = []
    by_id = {t["id"]: t for t in topics}
    texts: list[str] = []
    for path in sorted((d / "questions").glob("*.json")):
        try:
            texts += [q["text"] for q in read_past_questions(path=path.as_posix())["questions"]]
        except Refused as e:
            print(f"注: {e.reason}（この回の過去問と照らさない）")

    # 世代を並びの順に重ね、後の世代・後のファイル・ファイルの中の後の教材が勝つ。同じ世代の中の重なりは警告する
    materials: dict[int, tuple[str, str, dict]] = {}
    for sub in dirs:
        seen: dict[int, str] = {}
        for path in sorted(sub.glob("*.json")):
            try:
                ms = read_material_file(path=path.as_posix())["materials"]
            except Refused:
                stop("unreadableOutput", f"{sub.name}/{path.name}", "教材の形として読めない（書いている途中か壊れている。論点の ID を持たない教材を含む）")
                continue
            for m in ms:
                tid = m["topic_id"]
                if tid in seen:
                    warn("duplicate", f"{sub.name} id={tid} {m.get('term') or ''}".rstrip(),
                         f"同じ世代の中で論点の教材が重なる（{seen[tid]} と {path.name}。後の物を確かめる）")
                seen[tid] = path.name
                materials[tid] = (sub.name, path.name, m)

    image_pat = image_pattern(d.name)
    headed_count = figure_topics = figure_count = 0
    missing = sorted(t["id"] for t in topics if t["id"] not in materials)
    for tid, (gen, fname, m) in sorted(materials.items()):
        t = by_id.get(tid)
        where = f"{gen}/{fname} id={tid} {m.get('term') or (t or {}).get('term', '')}".rstrip()
        if not t:
            stop("orphanMaterial", where, "学びの論点に無い論点の教材")
        elif isinstance(m.get("term"), str) and m["term"] and m["term"] != t["term"]:
            stop("termMismatch", where, f"論点名が不一致『{m['term']}』⇔『{t['term']}』")
        ex = m.get("explanation") if isinstance(m.get("explanation"), str) else ""
        det = m.get("detail") if isinstance(m.get("detail"), str) else ""
        lacking = [k for k, v in (("explanation", ex), ("detail", det)) if not v.strip()]
        if lacking:
            stop("missingElement", where, f"{'・'.join(lacking)} が無いか空")
            continue
        ex, det = ex.strip(), det.strip()
        body = f"{ex}\n{det}"
        if HEADING.search(det):
            headed_count += 1
            n = check_headed(stop, warn, where, gen, ex, det, image_pat, args.public)
            if n:
                figure_topics += 1
                figure_count += n
        elif MARKDOWN.search(body):
            warn("markupInPlainText", where, "Markdown 記法が混入している（見出しを持たない教材はプレーンテキスト）")
        if "，" in body or "．" in body:
            warn("sourcePunctuation", where, "IPA 原文の句読点（，．）が混入している")
        # 過去問の原文をそのまま写していないか（本文から間隔おきの位置で取った部分がそのまま現れるか）
        n_q, step = LIMITS["quoteLength"], LIMITS["quoteStep"]
        hit = next((qt[i:i + n_q] for qt in texts for i in range(0, len(qt) - n_q + 1, step) if qt[i:i + n_q] in body), None)
        if hit:
            stop("pastQuestionQuote", where, f"過去問の原文と {n_q} 字以上一致『{hit[:20]}…』")

    # 担当バンドルと出力の突合。バンドル NN を渡した担当が、別の論点を書いて NN として出してくると、その論点が誰にも書かれないまま残る。
    # 担当の自己申告は当てにならない（実際に、担当外の論点番号を報告してきた例がある）。
    for path in sorted((d / LIMITS["bundleGeneration"]).glob("bundle_*.json")):
        try:
            want = {t["topic_id"] for t in read_material_bundle(path=(d / "material_bundles" / path.name).as_posix())["topics"]}
        except Refused as e:
            if e.code != CODE.NOT_FOUND:
                print(f"注: {e.reason}（この束は突き合わせない）")
            continue
        try:
            got = {m["topic_id"] for m in read_material_file(path=path.as_posix())["materials"]}
        except Refused:
            continue  # 読めない教材のファイルは unreadableOutput で挙げた（見る世代の外なら突き合わせない）
        if want != got:
            stop("bundleMismatch", f"{LIMITS['bundleGeneration']}/{path.name}",
                 f"担当バンドルと論点が違う（書かれていない {sorted(want - got)} / 担当外 {sorted(got - want)}）")

    print(f"教材: {len(materials)} / {len(topics)} 論点（うち見出しを持つ教材 {headed_count} 論点）")
    print(f"  図あり {figure_topics} 論点 / {figure_count} 枚")
    if missing:
        print(f"  未執筆 {len(missing)} 件: {missing[:20]}{' …' if len(missing) > 20 else ''}")
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
    elif not missing:
        print("\n検証: 問題なし")
    code = 1 if stops else 0
    print(json.dumps({"exitCode": code, "topics": len(materials), "missingTopics": missing, "stops": stops,
                      "warnings": warns, "limits": LIMITS}, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
