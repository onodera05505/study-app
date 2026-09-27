#!/usr/bin/env python3
"""これまでの成果物をまとめて、D1 に流し込む SQL を生成する。

    python3 scripts/build_seed.py
    npx wrangler d1 execute study-app-db --local --file=data/seed.sql

入力: data/syllabus.json, data/topics.json, data/questions/*.json,
      data/answer_keys.json, data/exam_labels.json
出力: data/seed.sql

何度でも再実行できるよう UPSERT で入れる。DELETE してから INSERT すると、
学習の進捗（progress）や受験履歴（session_questions）が参照している行を消すことになり、
外部キー制約で失敗する。教材を入れ替えても進捗が飛ばないようにするため、消さずに更新する。

出典（citation）はここで組み立てて列に持たせる。IPA の利用条件で表示が必須なので、
画面側で組み立て忘れが起きないよう、データとして持っておく。
"""

import argparse
import binascii
import datetime
import hashlib
import json
import os
import re
import sys
from pathlib import Path

# 図として描かれているものの目印。表や擬似言語の書き起こしと区別する。
DIAGRAM_MARKER = re.compile(r"(箱|矢印|→|←|↑|↓|線が|分岐|合流|結合点|ノード|角丸|"
                            r"書類形|図形|ブロック図|構成図|アローダイアグラム|フロー)")

# 担当が書いた問題ごとの解説の置き場。1担当1ファイル。
EXPLANATION_DIR = "question_explanations"

PBKDF2_ITERATIONS = 100_000  # src/server/lib/auth.ts と揃える。
# Cloudflare Workers の PBKDF2 は 100,000 回が上限。超えると実行時エラーになる。

# 出典表示に入れる試験名と模試設定は対象の登録簿（src/shared/targets.json）から引く。
# 以前はここに辞書で持ち、対象を足すたびに書き足していた（足し忘れると seed 生成が止まる）。
sys.path.insert(0, str(Path(__file__).parent))
from targets import exam_names as _exam_names, exam_settings as _exam_settings  # noqa: E402
EXAM_NAMES = _exam_names()
EXAM_SETTINGS = _exam_settings()

# 原文を書き換えている箇所の目印。ここに当たれば `modified` を立て、
# 画面に「一部改変」を併記する（IPA の利用条件）。
#
# 何を「改変」とするかの線引き:
#
#   改変にする   … 原文の記号や構造を別の表記に置き換えたもの。
#                  数式（上付き・下付き・平方根・対数・オーバーライン）、
#                  横線の分数、空欄の記号、選択肢の組合せ表
#   改変にしない … 本文の文言が原文のままのもの。
#                  行の折り返しを繋いだ、ルビや下線を notes に移した
#
# 抽出仕様（scripts/prompts/extract_questions.md）が指示している変換と対応させてある。
# 仕様に変換を足したら、ここにも足すこと。
MODIFICATION_MARKS = (
    # 指数 2^10 / 添字 a_1 / 平方根 √(…) / 対数 log2 n / 否定 ¬A
    (re.compile(r"\^|(?<![A-Za-z])_(?=[0-9a-zA-Z])|√|log\d|¬"), "数式を平文の記法に置き換えた"),
    # 横線の分数を 1/216 の形にした
    (re.compile(r"\d/\d"), "分数を斜線の形にした"),
    # 空欄を ［ a ］ に統一した
    (re.compile(r"［\s*[0-9a-zA-Zａ-ｚＡ-Ｚ]\s*］"), "空欄の記号を統一した"),
    # 選択肢の組合せ表を a：… ，b：… に整形した
    (re.compile(r"[0-9a-zA-Zａ-ｚ]：[^，]+，\s*[0-9a-zA-Zａ-ｚ]："), "選択肢の組合せ表を文字列に整形した"),
)


def content_key_of(qq: dict) -> str:
    """同一内容の問題をまとめるキー。

    定義: 本文（text）と選択肢（choices をア・イ・ウ・エの順に連結）をつなげ、
    そこから空白文字（\\s）を全部除いた文字列の sha1 の先頭 16 桁。

    IPA は同じ問題を別の回で使い回す（応用情報で 119 組 258 問）。DB には出典と
    通し受験のため全問そのまま残すが、学習側（論点詳細・練習テスト・ランダム模試）
    では 1 問にまとめて出す。そのグループ分けに使う。

    空白を除くのは、読み取り時の折り返しや全角空白の入り方が回ごとに揺れるため。
    選択肢は並びまで一致するものだけを同一とみなす（順序が違えば別の問題として扱う）。
    """
    choices = qq.get("choices") or {}
    body = qq.get("text", "") + "".join(choices.get(k, "") for k in ("ア", "イ", "ウ", "エ"))
    return hashlib.sha1(re.sub(r"\s", "", body).encode("utf-8")).hexdigest()[:16]


# 回の新旧。src/server/lib/session-builder.ts の compareExam と同じ規則。
# 先頭4桁が西暦、末尾1文字が実施時期（h=春 < o=10月 < a=秋）。IT パスポートは
# 通年 CBT なので末尾が無い回がある（2024r06）ので、その場合は年内で最後に置く。
# **文字列の大小では比べられない**（2016h28a と 2016h28h は辞書順だと逆になる）。
SEASON_RANK = {"h": 0, "o": 1, "a": 2}

# 本文中の用語のポップ記法。`[[用語]]` と書かれた箇所だけ押せる文字になる。
TERM_REF = re.compile(r"\[\[([^\[\]\n]+)\]\]")


def exam_rank(exam: str) -> tuple[int, int]:
    """回の新旧。大きいほど新しい。"""
    head = exam[:4]
    return (int(head) if head.isdigit() else 0, SEASON_RANK.get(exam[-1:], 3))


def exam_of_question_id(qid: str) -> str:
    """"2024r06-q53" → "2024r06"。"""
    return qid.rsplit("-q", 1)[0]


# 教材の世代。後ろが勝つ。ディレクトリが無い世代は黙って飛ばす。
MATERIAL_DIRS = ("materials", "materials_v2", "materials_v3")


def load_materials(d: Path) -> dict[int, dict]:
    """教材を v1 → v2 → v3 の順に読み、後勝ちで上書きする。

    v2（Markdown で構造を付けた版）と v3（定義・見分け方・図・計算手順に絞った版）は
    それぞれ data/<試験>/materials_v2 / materials_v3 に置き、前の世代に上書きする形で
    読む。書き直しは出題頻度の高い論点から順に進めるので、全論点が揃うのを待たずに
    反映できる。表示側（Markdown.tsx）は v1 のプレーンテキストもそのまま描けるため、
    混在していても画面は崩れない。"""
    out: dict[int, dict] = {}
    for sub in MATERIAL_DIRS:
        if not (d / sub).is_dir():
            continue
        for path in sorted((d / sub).glob("*.json")):
            for m in json.loads(path.read_text(encoding="utf-8")).get("materials", []):
                out[m["topic_id"]] = m
    return out


def read_explanations(d: Path) -> tuple[dict[str, dict], list[str]]:
    """問題ごとの解説を読む。戻り値は (content_key → 解説, 複数ファイルに重複した鍵)。

    置き場は data/<試験>/question_explanations/<バンドル名>.json。担当ごとに
    1ファイル。同じ content_key が2ファイルにあれば担当範囲がずれているので拾う。"""
    out: dict[str, dict] = {}
    duplicated: list[str] = []
    for path in sorted((d / EXPLANATION_DIR).glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for e in data.get("explanations", []):
            ck = e.get("content_key")
            if not ck:
                continue
            if ck in out:
                duplicated.append(ck)
            e["_file"] = path.name
            out[ck] = e
    return out, duplicated


def strip_marks(text: str) -> str:
    """用語集の brief に載せるために記法を落とす。ポップの中でポップは開けない。"""
    body = TERM_REF.sub(r"\1", text or "")
    body = re.sub(r"\*\*(.+?)\*\*", r"\1", body)
    return body.strip()


def note_brief(note: str) -> str:
    """誤答 note のうち用語集（ポップ）に使う部分＝1 文目。「〜です。〜ではありません」の 2 文目は
    その問題の正解との対比で、他の問題のポップに出ると浮くので落とす（2026-09-27）。"""
    body = note.strip()
    mo = re.search(r"^(.+?[。．])", body)
    return (mo.group(1) if mo else body).strip()


def first_sentence(text: str) -> str:
    """教材の explanation の第1文。用語集の穴埋めに使う。"""
    body = strip_marks(text).split("\n")[0].strip()
    mo = re.search(r"^(.+?[。．])", body)
    return (mo.group(1) if mo else body)[:140]


def term_index(d: Path, topics: list[dict]) -> dict[str, int]:
    """論点名・別名 → 論点 ID。用語がドンピシャの論点を指すかの判定に使う。

    **完全一致だけ**を採る。部分一致で寄せると「DNS」と「DNS キャッシュポイズニング」
    のような別物が同じ論点に飛ぶ（topic_aliases.json の注記と同じ理由）。"""
    idx: dict[str, int] = {}
    for t in topics:
        idx.setdefault(t["term"], t["id"])
        for a in t.get("aliases") or []:
            idx.setdefault(a, t["id"])
    path = d / "topic_aliases.json"
    if path.exists():
        for src, dst in json.loads(path.read_text(encoding="utf-8")).items():
            if src.startswith("_") or not isinstance(dst, str):
                continue
            if dst in idx:
                idx.setdefault(src, idx[dst])
    return idx


def build_glossary(
    d: Path, explanations: dict[str, dict], materials: dict[int, dict], topics: list[dict]
) -> tuple[dict[str, dict], list[str]]:
    """用語集を解説から派生させる。戻り値は (用語 → {brief, topic_id}, 解決できなかった用語)。

    種は解説の choices[].term。同じ用語が複数の問題に出てきたら、**最も新しい問題**の
    note を代表にする（新しい回の言い回しに寄せる）。data/<試験>/glossary_overrides.json
    があればそれで上書きできる。

    topic_id は論点名・別名と**完全一致**したときだけ入れる。入っていればポップの中に
    「この論点を学ぶ →」が出る。一致しなければ説明だけを出す。

    本文中の `[[用語]]` で拾えなかったものは、その用語が指す論点の explanation の
    第1文で補う。補えなければ解決できなかった用語として返す（check_explanations.py が
    これを問題として止める。glossary に無い用語は画面で色が付かないので、
    ポップのつもりで書いた箇所が黙って素の文字になる）。"""
    to_topic = term_index(d, topics)
    gl: dict[str, dict] = {}

    for e in explanations.values():
        rank = exam_rank(exam_of_question_id(e.get("question_id", "")))
        for c in e.get("choices", []):
            term = (c.get("term") or "").strip()
            note = strip_marks(c.get("note") or "")
            # 正解の行は「正解。〜」で始まる約束。用語の説明としては要らない
            note = re.sub(r"^正解[。．，、]?\s*", "", note).strip()
            # ポップの説明は note の 1 文目だけ（2026-09-27 本人の決定）。2 文目は「正解と違う点」で
            # その問題の文脈に寄るため、用語集に持ち込まない
            note = note_brief(note)
            if not term or not note:
                continue
            cur = gl.get(term)
            if cur and cur["_rank"] >= rank:
                continue
            gl[term] = {"brief": note, "topic_id": to_topic.get(term), "_rank": rank}

    # 手で直したいものはここで上書きする。派生元の note を書き換えると、
    # その問題の解説の文としては不自然になることがあるので口を分けてある。
    ov_path = d / "glossary_overrides.json"
    if ov_path.exists():
        for term, v in json.loads(ov_path.read_text(encoding="utf-8")).items():
            if term.startswith("_"):
                continue
            v = {"brief": v} if isinstance(v, str) else dict(v)
            cur = gl.setdefault(term, {"brief": "", "topic_id": to_topic.get(term), "_rank": (0, 0)})
            if v.get("brief"):
                cur["brief"] = strip_marks(v["brief"])
            if "topic_id" in v:
                cur["topic_id"] = v["topic_id"]

    # 本文中の `[[用語]]` の穴埋め
    refs: set[str] = set()
    for m in materials.values():
        refs |= set(TERM_REF.findall((m.get("explanation") or "") + "\n" + (m.get("detail") or "")))
    for e in explanations.values():
        refs |= set(TERM_REF.findall(e.get("correct_reason") or ""))
        for c in e.get("choices", []):
            refs |= set(TERM_REF.findall(c.get("note") or ""))

    unresolved: list[str] = []
    for term in sorted(refs):
        if term in gl and gl[term]["brief"]:
            continue
        tid = to_topic.get(term)
        ex = (materials.get(tid) or {}).get("explanation") if tid else None
        if tid and ex:
            gl[term] = {"brief": first_sentence(ex), "topic_id": tid, "_rank": (0, 0)}
        else:
            unresolved.append(term)

    return {k: v for k, v in gl.items() if v["brief"]}, unresolved


def is_modified(qq: dict) -> bool:
    """原文を書き換えているか。立っていれば画面に「一部改変」を併記する。"""
    body = qq.get("text", "") + " " + " ".join((qq.get("choices") or {}).values())
    return any(pat.search(body) for pat, _ in MODIFICATION_MARKS)


def q(v) -> str:
    """SQL リテラルに変換する。"""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def hash_password(password: str) -> str:
    """auth.ts の verifyPassword が読める形式 "iterations:saltHex:hashHex"。"""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS, dklen=32)
    return f"{PBKDF2_ITERATIONS}:{binascii.hexlify(salt).decode()}:{binascii.hexlify(dk).decode()}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    # 既定は <data>/seed.sql。固定値にしていたら、--data data/ap を指定したのに
    # data/ip/seed.sql を上書きする事故が起きた（2026-08-28）。IT パスポートの seed が
    # 応用情報の中身になり、そのまま流していたら本番に異物が入っていた。
    ap.add_argument("--out", default=None, type=Path)
    ap.add_argument("--exam-name", default=None,
                    help="出典表示に入れる試験名。既定は --data から決まるので普段は不要")
    # 既定は public/figures/<試験>。試験ごとに分けないとファイル名がぶつかる（下の注記）。
    ap.add_argument("--figures", default=None, type=Path)
    ap.add_argument("--admin-email", default="admin@example.com")
    # 既定値を持たせない。渡したときだけ管理ユーザを作る（作らなくてもアプリは動く。
    # 新規登録から普通のユーザを作ればよい）。理由は下の「管理ユーザ」の注記を見ること。
    ap.add_argument("--admin-password", default=None,
                    help="渡したときだけ管理ユーザ（ADMIN）を作る・更新する")
    args = ap.parse_args()
    d = args.data
    out = args.out or (d / "seed.sql")
    args.figures = args.figures or Path("public/figures") / d.name

    # 出典表示は IPA の利用条件で必須。試験名を引数任せにしていたら、渡し忘れて
    # 応用情報の全880問が「ITパスポート試験」と名乗る事故が起きた（2026-08-29）。
    # 手順書に注意書きを足すだけでは同じことが起きるので、--data から決める。
    exam_name = args.exam_name or EXAM_NAMES.get(d.name)
    if not exam_name:
        sys.exit(
            f"{d} の試験名が分かりません。EXAM_NAMES に足すか --exam-name で明示してください"
        )

    syllabus = json.loads((d / "syllabus.json").read_text(encoding="utf-8"))
    topics = json.loads((d / "topics.json").read_text(encoding="utf-8"))
    labels = json.loads((d / "exam_labels.json").read_text(encoding="utf-8"))
    keys = json.loads((d / "answer_keys.json").read_text(encoding="utf-8"))

    question_files = sorted((d / "questions").glob("*.json"))
    if not question_files:
        sys.exit(f"{d}/questions に問題データがありません")

    # 再実行できるよう UPSERT で入れる。DELETE してから INSERT すると、
    # 学習の進捗（progress）や受験履歴（session_questions）が参照している
    # 行を消すことになり、外部キー制約で失敗する。教材を入れ替えても
    # 進捗が飛ばないようにするため、消さずに更新する。
    lines: list[str] = [
        "-- study-app 初期データ。scripts/build_seed.py が生成。手で編集しない。",
        "DELETE FROM topic_questions;  -- 紐付けは毎回作り直す（参照されていない）",
    ]

    # --- シラバス項目 ---------------------------------------------------
    for it in syllabus["items"]:
        lines.append(
            "INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES ("
            + ", ".join(q(x) for x in (
                it["number"], it["name"], it["field"],
                it["major_no"], it["major"], it["middle_no"], it["middle"],
            ))
            + ") ON CONFLICT(id) DO UPDATE SET name=excluded.name, field=excluded.field,"
            " major_no=excluded.major_no, major=excluded.major,"
            " middle_no=excluded.middle_no, middle=excluded.middle;"
        )

    # --- 過去問 ---------------------------------------------------------
    question_ids: set[str] = set()
    # content_key → その内容の問題 ID（新しい回が先）。解説は content_key ごとに1本。
    content_keys: dict[str, list[str]] = {}
    missing_answer: list[str] = []
    missing_figure_image: list[str] = []
    for path in question_files:
        data = json.loads(path.read_text(encoding="utf-8"))
        exam = data["exam"]
        label = labels.get(exam, exam)
        key = keys.get(exam, {})
        for qq in data["questions"]:
            n = qq["number"]
            answer = key.get(str(n))
            if not answer:
                missing_answer.append(f"{exam}-q{n}")
                continue
            qid = f"{exam}-q{n}"
            question_ids.add(qid)
            content_keys.setdefault(content_key_of(qq), []).append(qid)
            citation = f"出典：{label} {exam_name} 問{n}"
            # 図として描かれている問題だけ、切り出した画像がある（scripts/crop_figures.py）
            # 画像は試験ごとのディレクトリに置く。IT パスポートと応用情報には
            # **同じ試験 ID が存在する**（令和2年度10月＝2020r02o）ので、平置きにすると
            # 同じ問番号でファイル名がぶつかる。実際 2020r02o-q55 がぶつかり、
            # IT パスポートの画面に応用情報の図が出ていた（2026-08-31 に修正）。
            fig = args.figures / f"{qid}.png"
            figure_image = f"/figures/{d.name}/{qid}.png" if fig.exists() else None
            # 図として描かれているのに画像を切り出していないものを拾う。
            # 表や擬似言語は文章のままで読みやすいので対象外。
            fd = qq.get("figure_description") or ""
            if not figure_image and DIAGRAM_MARKER.search(fd) and fd.count("|") <= 4:
                missing_figure_image.append(qid)
            lines.append(
                "INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer,"
                " has_figure, figure_description, figure_image, citation, modified,"
                " content_key) VALUES ("
                + ", ".join(q(x) for x in (
                    qid, exam, label, n, qq["text"],
                    json.dumps(qq["choices"], ensure_ascii=False),
                    answer,
                    bool(qq.get("has_figure")),
                    qq.get("figure_description"),
                    figure_image,
                    citation,
                    is_modified(qq),
                    content_key_of(qq),
                ))
                # exam_label も更新する。ここから漏らすと、exam_labels.json を直しても
                # 既存行のラベルが古いまま残る（内部コードが画面に出続けた）
                + ") ON CONFLICT(id) DO UPDATE SET text=excluded.text, choices=excluded.choices,"
                " answer=excluded.answer, exam_label=excluded.exam_label,"
                " has_figure=excluded.has_figure,"
                " figure_description=excluded.figure_description,"
                " figure_image=excluded.figure_image, citation=excluded.citation,"
                " modified=excluded.modified, content_key=excluded.content_key;"
            )

    # --- 教材（解説・周辺知識）-------------------------------------------
    # data/materials/batch_*.json は topic_id で論点を指す。ID は
    # data/topic_ids.json で固定されており、回を追加して並び順が変わっても
    # ずれない。念のため term も突き合わせて食い違いを検出する。
    #
    # v2（Markdown で構造を付けた版）は data/materials_v2/ に置き、v1 に上書きする形で
    # 読む。書き直しは出題頻度の高い論点から順に進めるので、全論点が揃うのを待たずに
    # 反映できる。表示側（Markdown.tsx）は v1 のプレーンテキストもそのまま描けるため、
    # 混在していても画面は崩れない。
    materials = load_materials(d)
    material_mismatch: list[str] = []

    # --- 論点と紐付け ---------------------------------------------------
    linked = 0
    orphan_links: list[str] = []
    for t in topics["topics"]:
        tid = t["id"]
        valid = [f"{qq['exam']}-q{qq['number']}" for qq in t["questions"]]
        valid = [v for v in valid if v in question_ids]
        orphan_links.extend(
            f"{qq['exam']}-q{qq['number']}" for qq in t["questions"]
            if f"{qq['exam']}-q{qq['number']}" not in question_ids
        )
        m = materials.get(tid)
        if m and m.get("term") and m["term"] != t["term"]:
            material_mismatch.append(f"id={tid} 教材『{m['term']}』 ⇔ 論点『{t['term']}』")
            m = None
        # sort_order はロードマップ型（data/itc）だけが持つ。資格版の topics.json に無いときは列そのものを出さない
        # （資格版の D1 に列が無くても投入できる。列は migrations/0005 で足す）。
        has_order = any("sort_order" in x for x in topics["topics"])
        cols = "id, term, syllabus_item_id, is_new, explanation, detail, question_count" + (", sort_order" if has_order else "")
        vals = [tid, t["term"], t["syllabus_item"], bool(t["is_new"]), (m or {}).get("explanation"), (m or {}).get("detail"), len(valid)]
        if has_order: vals.append(t.get("sort_order"))
        lines.append(
            f"INSERT INTO topics ({cols}) VALUES ("
            + ", ".join(q(x) for x in vals)
            + ") ON CONFLICT(id) DO UPDATE SET term=excluded.term,"
            " syllabus_item_id=excluded.syllabus_item_id, is_new=excluded.is_new,"
            " explanation=excluded.explanation, detail=excluded.detail,"
            " question_count=excluded.question_count," + (" sort_order=excluded.sort_order," if has_order else "") + " updated_at=(unixepoch());"
        )
        for qid in valid:
            lines.append(
                f"INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES ({tid}, {q(qid)}, 1);"
            )
            linked += 1

    # --- 消えた論点の掃除 -------------------------------------------------
    # 表記揺れを統合すると、統合された側の論点 ID は topics.json から消える。
    # UPSERT は消さないので、放っておくと「1回出題」と表示されるのに紐づく
    # 過去問が0件という幽霊論点が残る。ここで消す。
    # progress は ON DELETE CASCADE なので、その論点に付けた理解度も一緒に消える。
    # 統合先に引き継ぐのが理想だが、統合はまれなので単純に消す方を選んだ。
    kept = ", ".join(str(t["id"]) for t in topics["topics"])
    lines.append(f"DELETE FROM topics WHERE id NOT IN ({kept});")

    # --- 問題ごとの解説 ---------------------------------------------------
    # 論点の教材が「定義・見分け方・計算手順」に絞られたぶん、誤答選択肢のケアは
    # 問題側に持たせる。キーは問題 ID ではなく content_key なので、同じ問題が
    # 別の回で使い回されていても解説は1本で足りる。
    explanations, expl_dup = read_explanations(d)
    expl_unknown: list[str] = []
    expl_written = 0
    for ck in sorted(explanations):
        e = explanations[ck]
        if ck not in content_keys:
            expl_unknown.append(f"{e.get('_file')}: {e.get('question_id')}（{ck}）")
            continue
        choices = [
            {"label": c.get("label"), "term": c.get("term") or None, "note": c.get("note")}
            for c in e.get("choices", [])
        ]
        lines.append(
            "INSERT INTO question_explanations (content_key, correct_reason, choices_json,"
            " updated_at) VALUES ("
            + ", ".join(q(x) for x in (
                ck,
                e.get("correct_reason"),
                json.dumps(choices, ensure_ascii=False),
                datetime.date.today().isoformat(),
            ))
            + ") ON CONFLICT(content_key) DO UPDATE SET correct_reason=excluded.correct_reason,"
            " choices_json=excluded.choices_json, updated_at=excluded.updated_at;"
        )
        expl_written += 1

    # --- 用語集 -----------------------------------------------------------
    # 解説から派生させる（人が別に書くものではない）。派生なので毎回作り直す。
    # 参照している側が無い（FK を張っていない）ので DELETE しても壊れるものは無い。
    glossary, unresolved_terms = build_glossary(d, explanations, materials, topics["topics"])
    lines.append("DELETE FROM glossary;  -- 解説から毎回派生させる（誰も参照していない）")
    for term in sorted(glossary):
        g = glossary[term]
        lines.append(
            "INSERT INTO glossary (term, brief, topic_id) VALUES ("
            + ", ".join(q(x) for x in (term, g["brief"], g.get("topic_id")))
            + ") ON CONFLICT(term) DO UPDATE SET brief=excluded.brief, topic_id=excluded.topic_id;"
        )

    # --- 設定と管理ユーザ -----------------------------------------------
    # 模試の問題数と制限時間は試験ごとに違うが、app_settings の列の既定値は 100 問 / 7200 秒（IT パスポート）。
    # 新しい D1 に最初に流すとき、その試験の値で行を作る（既にある行は触らない。運用で変えた値を上書きしない）。
    # 2026-09-15: itc（42 問 / 40 分）で 84 問になっていたのを受入で検出して追加。
    mock_size, mock_sec = EXAM_SETTINGS[d.name]
    lines.append(
        f"INSERT INTO app_settings (id, mock_size, mock_time_limit_sec) VALUES ('default', {mock_size}, {mock_sec})"
        " ON CONFLICT(id) DO NOTHING;"
    )

    # 管理ユーザは --admin-password を渡したときだけ作る。
    #
    # 以前は既定のパスワードで**必ず**この文を出していた。すると:
    #   1. 初期データを入れるたびに、公開中のサイトに既知のパスワードの口ができる
    #   2. UPSERT が password_hash を更新するので、DB 側で変えても再投入で元に戻る
    # 実際、本番2サイトとも既定のままログインできる状態が続いていた（2026-08-31 に交換）。
    # 回を追加したときの再投入で users に触らせないほうが安全なので、既定では出さない。
    if args.admin_password:
        lines.append(
            "INSERT INTO users (id, email, name, password_hash, role) VALUES ("
            + ", ".join(q(x) for x in (
                "admin", args.admin_email, "管理者", hash_password(args.admin_password), "ADMIN",
            ))
            + ") ON CONFLICT(id) DO UPDATE SET email=excluded.email,"
            " password_hash=excluded.password_hash, role=excluded.role;"
        )

    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"→ {out}（{len(lines)} 文）")
    print(f"  シラバス項目 : {len(syllabus['items'])}")
    print(f"  過去問       : {len(question_ids)}")
    print(f"  論点         : {len(topics['topics'])}")
    print(f"  論点⇔過去問  : {linked} 件")
    written = sum(1 for t in topics["topics"] if materials.get(t["id"]))
    print(f"  教材あり     : {written} / {len(topics['topics'])} 論点")
    v2 = sum(1 for m in materials.values() if "###" in (m.get("detail") or ""))
    print(f"  うち v2 済み : {v2} 論点")
    print(f"  図の画像あり : {len(list(args.figures.glob('*.png')))} 問")
    print(f"  問題解説     : {expl_written} 本 / 用語集 {len(glossary)} 語")
    if missing_figure_image:
        print(f"\n[警告] 図として描かれているのに画像が無い問題 {len(missing_figure_image)} 件。")
        print("        scripts/crop_figures.py で切り出すと学習しやすくなります:")
        for x in missing_figure_image[:10]:
            print(f"          {x}")
    if args.admin_password:
        print(f"  管理ユーザ   : {args.admin_email} / {args.admin_password}（作成・更新する）")
    else:
        print("  管理ユーザ   : 作らない（--admin-password を渡したときだけ作る）")
    if expl_unknown:
        print(f"\n[警告] 実在しない content_key を指す解説 {len(expl_unknown)} 件（投入しません）:")
        for x in expl_unknown[:5]:
            print(f"  {x}")
    if expl_dup:
        print(f"[警告] 複数ファイルに重複した解説 {len(set(expl_dup))} 件（後勝ち）: {sorted(set(expl_dup))[:5]}")
    if unresolved_terms:
        print(f"[警告] 用語集で解決できない [[用語]] {len(unresolved_terms)} 件"
              f"（画面では色が付かず素の文字になる）: {unresolved_terms[:5]}")
    if material_mismatch:
        print(f"\n[警告] 教材と論点の対応がずれています {len(material_mismatch)} 件（該当分は投入しません）:")
        for x in material_mismatch[:5]:
            print(f"  {x}")
    if missing_answer:
        print(f"\n[警告] 正解表に無く投入しなかった問題 {len(missing_answer)} 件: {missing_answer[:5]}")
    if orphan_links:
        print(f"[警告] 未投入の問題を指す紐付け {len(orphan_links)} 件（無視した）: {sorted(set(orphan_links))[:5]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
