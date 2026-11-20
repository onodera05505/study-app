#!/usr/bin/env python3
"""生成した seed.sql の中身を検証する。投入する前に流す。

    python3 scripts/check_seed.py --data data/ap
    python3 scripts/check_seed.py --data data/ap --sql data/ap/seed.sql

## なぜ要るか

読み取り・分類・教材には検証がある（`check_*.py`）。どれも **AI が作ったもの**が
対象で、「担当の自己申告は当てにしない」という実際の失敗から組まれている。

だが `build_seed.py` が組み立てるデータは誰も疑っていなかった。結果、応用情報の
全880問が「出典：… ITパスポート試験 問1」と名乗る状態が数か月続いた
（`docs/作業ログ_2026-08-29_出典表示の修正.md`）。出典表示は IPA の利用条件で必須。

**投入が成功したことと、入った中身が正しいことは別。** `Executed N queries` は
SQL が通ったとしか言っていない。ここでその差を埋める。

## 見るもの

- **出典の試験名** — `--data` が指す試験と一致しているか。応用情報のデータなのに
  「ITパスポート試験」と名乗っていたら止める
- **年度ラベル** — `2022r04h` のような内部コードがそのまま出ていないか。
  `exam_labels.json` に無い回はフォールバックでこうなる。出典とセッション名に出る
- **UPSERT の更新列漏れ** — INSERT する列が ON CONFLICT の UPDATE 句にあるか。
  漏れると「データを直したのに本番が変わらない」。実際 `exam_label` で起きた
- **回ごとの問題数** — IT パスポート100問 / 応用情報80問。欠けていれば分類も狂う。
  ロードマップ型は `check_roadmap_registry.py` が見る（日なら登録簿の 1 回の問題数、章なら単位数 × 2）
- **ロードマップ型の回の語・回・印** — 登録簿に回の見出し・回の数・回ごとの確認の語と印の語があり、
  各論点が回（日なら学ぶ順 ÷ 1 日の論点数と一致）・回のラベル（章なら章の名前）・登録簿にある段の印を持つ
- **図の画像** — `figure_image` が指すファイルが実在するか。無いと画面で画像が出ないが、
  エラーにはならないので気づけない
- **教材に差し込んだ図** — `topics` の explanation / detail に入る画像行
  `![…](/figures/materials/<試験>/…svg)` が、試験ごとのディレクトリを指していて、
  実体が `public/` にあるか。ここも無言で空欄になるだけなので機械で見る
- **同一内容なのに正解が違う組** — `content_key` が同じなら本文も選択肢も並びまで
  同じはずなので、正解が割れていたらどちらかの読み取りが間違っている。学習側は
  同一内容を1問にまとめて出すため、片方の誤りが「まとめた側」に化けて出る。
  DB 上の矛盾は許さない方針なので、警告ではなく**問題**として止める
- **解説の宛先** — `question_explanations.content_key` が `past_questions` に実在するか。
  鍵が違うとどの問題にも表示されないが、投入は通るので気づけない
- **用語集の行き先** — `glossary.topic_id` が実在する論点か。消えた論点を指していると
  ポップの「この論点を学ぶ →」が行き先を失う
- **同一内容の組の数**（参考情報）— IPA は同じ問題を別の回で使い回す。何組あるか、
  重複ぶんが何問かを毎回表示して、まとめ方が急に変わったら気づけるようにする

どれも数行で書ける検査ばかりだが、これで防げたはずのバグが実際に出ている。
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# 内部コードの形。exam_labels.json に無い回はこれがそのまま画面に出る。
EXAM_CODE = re.compile(r"^\d{4}[hr]\d{2}[hao]?$")

# 1回あたりの問題数。ここから外れたら読み取りか分類の取りこぼし。
sys.path.insert(0, str(Path(__file__).parent))
from targets import targets as _targets  # 対象ごとの値は登録簿（src/shared/targets.json）から
QUESTIONS_PER_EXAM = {k: v["questionsPerRound"] for k, v in _targets().items() if v.get("questionsPerRound")}
# 回ごとの問題数の例外（回 ID → 何問でもよい）。ロードマップ型の「補足」は単位数が固定でない
QUESTIONS_EXEMPT = {r for v in _targets().values() for r in v.get("exemptRounds", [])}

INSERT_UPSERT = re.compile(
    r"INSERT INTO (\w+) \(([^)]*)\)[^;]*?ON CONFLICT\(([^)]*)\) DO UPDATE SET (.*?);", re.S
)
# INSERT INTO past_questions (...) VALUES ('2024r06a-q1', '2024r06a', '令和6年度 秋期', 1, …
QUESTION_ROW = re.compile(
    r"INSERT INTO past_questions \([^)]*\) VALUES \('([^']+)', '([^']+)', '((?:[^']|'')*)', (\d+),"
)
CITATION = re.compile(r"'出典：((?:[^']|'')*)'")
# 教材（topics.explanation / detail）に差し込まれた図の画像行。
# 書き手は書かない。scripts が論点ごとの SVG を差し込む。
# 説明文には角かっこ（「A[1]」など）が入ってよい。`](` だけは入らない（表示側 Markdown.tsx と同じ読み方）。
MATERIAL_IMAGE = re.compile(r"!\[(?:[^\]\n]|\](?!\())*\]\(([^)\s]+)\)")


def _unquote(s: str) -> str:
    return s.replace("''", "'")


def _insert_rows(sql: str, table: str) -> list[dict]:
    """指定したテーブルの INSERT を列名つきで読み出す。

    本文や選択肢に `)` も `'`（SQL では `''`）も改行も入るので、正規表現では
    値を切り出せない。VALUES ( … ) の中を1文字ずつ舐めて、文字列リテラルの中か
    どうかを見ながらカンマで割る。
    """
    rows: list[dict] = []
    head = re.compile(rf"INSERT INTO {re.escape(table)} \(([^)]*)\) VALUES \(")
    for m in head.finditer(sql):
        cols = [c.strip() for c in m.group(1).split(",")]
        i = m.end()
        values: list[str] = []
        buf: list[str] = []
        in_str = False
        while i < len(sql):
            ch = sql[i]
            if in_str:
                if ch == "'":
                    if sql[i + 1 : i + 2] == "'":  # '' は文字としての '
                        buf.append("''")
                        i += 2
                        continue
                    in_str = False
                buf.append(ch)
            elif ch == "'":
                in_str = True
                buf.append(ch)
            elif ch == ",":
                values.append("".join(buf).strip())
                buf = []
            elif ch == ")":
                values.append("".join(buf).strip())
                break
            else:
                buf.append(ch)
            i += 1
        if len(values) == len(cols):
            rows.append({
                c: (_unquote(v[1:-1]) if v.startswith("'") else None if v == "NULL" else v)
                for c, v in zip(cols, values)
            })
    return rows


def _question_values(sql: str) -> list[dict]:
    """past_questions の INSERT を列名つきで読み出す。"""
    return _insert_rows(sql, "past_questions")


# @operation UC-027#checkSeed
# @implements REQ-531, REQ-487, BR-032
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    ap.add_argument("--sql", type=Path, help="既定は <data>/seed.sql")
    # 既定は public/figures/<試験>（build_seed.py と同じ）
    ap.add_argument("--figures", default=None, type=Path)
    # 教材に差し込んだ図の実体を確かめる先。/figures/… はこの下からの絶対パス。
    ap.add_argument("--public", default="public", type=Path)
    args = ap.parse_args()
    d = args.data
    sql_path = args.sql or (d / "seed.sql")
    args.figures = args.figures or Path("public/figures") / d.name
    sys.path.insert(0, str(Path(__file__).parent))
    sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
    from material_generations import emit_refusal, learning_refusal
    from tool_refusal import CODE, tool_error
    from targets import target

    # 断る順は契約 checkSeed の errors の順（検査する投入が無い → 登録簿に無い学び）
    # 検査する投入が無ければ、中身を検査せずに断る
    # @implements REQ-565
    if not sql_path.exists():
        return emit_refusal(tool_error(CODE.NOT_FOUND, f"{sql_path} がありません。先に build_seed.py を実行してください"))
    refusal = learning_refusal(d, registered=True)
    if refusal:
        return emit_refusal(refusal)

    from build_seed import EXAM_NAMES  # 試験名の対応表は1か所に持つ

    want_name = EXAM_NAMES[d.name]

    sql = sql_path.read_text(encoding="utf-8")
    problems: list[str] = []
    warnings: list[str] = []

    # --- 出典と年度ラベル -------------------------------------------------
    # 出典は「出典：<年度ラベル> <試験名> 問N」。試験名の取り違えと内部コードの素通しを止める
    # @implements BR-027
    per_exam: dict[str, int] = defaultdict(int)
    labels: dict[str, set[str]] = defaultdict(set)
    wrong_name: list[str] = []
    code_label: set[str] = set()

    rows = QUESTION_ROW.findall(sql)
    for qid, exam, label, _number in rows:
        label = _unquote(label)
        per_exam[exam] += 1
        labels[exam].add(label)
        if EXAM_CODE.match(label):
            code_label.add(exam)

    # 出典は「出典：<ラベル> <試験名> 問N」。試験名が違えば IPA の表示義務を満たさない
    other_names = {v for k, v in EXAM_NAMES.items() if v != want_name}
    for cit in {_unquote(m) for m in CITATION.findall(sql)}:
        if want_name not in cit:
            wrong_name.append(cit)
        elif any(o in cit for o in other_names):
            wrong_name.append(cit)

    # 出典の年度ラベルは、その過去問の回の年度ラベル（同じ行の exam_label）と同じでなければならない。
    # 違えば別の回を名乗る出典になる
    wrong_year = [
        (q["id"], q["citation"]) for q in _question_values(sql)
        if q.get("citation") is not None and not q["citation"].startswith(f"出典：{q.get('exam_label')} ")
    ]
    if wrong_year:
        problems.append(
            f"出典の年度ラベルがその回の年度ラベルと違う過去問 {len(wrong_year)} 問: "
            + " / ".join(f"{qid}『{cit}』" for qid, cit in wrong_year[:3])
        )
    if wrong_name:
        problems.append(
            f"出典の試験名が『{want_name}』でないものが {len(wrong_name)} 種類: "
            + " / ".join(sorted(wrong_name)[:3])
        )
    if code_label:
        problems.append(
            f"年度ラベルが内部コードのままの回 {len(code_label)} 件: {sorted(code_label)}"
            f"（{d}/exam_labels.json に足す）"
        )
    for exam, ls in sorted(labels.items()):
        if len(ls) > 1:
            problems.append(f"{exam}: 年度ラベルが複数ある {sorted(ls)}")

    # --- 回ごとの問題数 ---------------------------------------------------
    # ロードマップ型は回の語・回・印と合わせて check_roadmap_registry が見る
    from check_roadmap_registry import registry_problems, seed_problems
    want_n = QUESTIONS_PER_EXAM.get(d.name)
    if target(d.name).get("roadmap"):
        problems.extend(registry_problems(d.name, d))
        problems.extend(seed_problems(d.name, _insert_rows(sql, "topics"), per_exam, labels, d,
                                      links=_insert_rows(sql, "topic_questions"),
                                      exam_of={r["id"]: r["exam"] for r in _question_values(sql)}))
    elif want_n:
        for exam, n in sorted(per_exam.items()):
            if exam in QUESTIONS_EXEMPT: continue
            if n != want_n:
                problems.append(f"{exam}: {n} 問（{want_n} 問のはず。取りこぼしがある）")

    # --- UPSERT の更新列漏れ ----------------------------------------------
    # 漏れると「データを直したのに本番が変わらない」。挿入は正しいので気づきにくい。
    seen: set[str] = set()
    for m in INSERT_UPSERT.finditer(sql):
        table, cols, key, upd = m.groups()
        if table in seen:
            continue
        seen.add(table)
        inserted = [c.strip() for c in cols.split(",")]
        updated = set(re.findall(r"(\w+)=excluded\.", upd))
        keys = {k.strip() for k in key.split(",")}
        # id から決まる列は更新しなくてよい（id が同じなら値も同じ）
        derived = {"exam", "number"} if table == "past_questions" else set()
        missing = [c for c in inserted if c not in updated and c not in keys and c not in derived]
        if missing:
            warnings.append(f"{table}: UPSERT で更新されない列 {missing}")

    # --- 図の画像 ---------------------------------------------------------
    # @implements BR-026
    missing_fig = [
        p for p in {m for m in re.findall(r"'(/figures/[^']+)'", sql)}
        if not (args.figures / Path(p).name).exists()
    ]
    if missing_fig:
        problems.append(f"seed が指す画像が実在しない {len(missing_fig)} 件: {sorted(missing_fig)[:3]}")

    # --- 画像の URL が試験ごとに分かれているか ------------------------------
    # IT パスポートと応用情報には**同じ試験 ID がある**（令和2年度10月＝2020r02o）。
    # 平置きにすると同じ問番号でファイル名がぶつかり、後から切り出したほうで
    # 上書きされる。実際 2020r02o-q55 で起き、IT パスポートの画面に応用情報の
    # 課金グラフが出ていた（2026-08-31 に `/figures/<試験>/…` へ分けて修正）。
    stray = sorted({p for p in re.findall(r"'(/figures/[^']+)'", sql)
                    if not p.startswith(f"/figures/{d.name}/")})
    if stray:
        problems.append(
            f"画像の URL が /figures/{d.name}/ 以下でないもの {len(stray)} 件: {stray[:3]}"
            "（試験をまたいでファイル名がぶつかる）"
        )

    # --- 教材に差し込んだ図 -------------------------------------------------
    # figure_image と同じで、無くてもエラーにはならず画面が空欄になるだけ。
    # 置き場所は試験ごとに分ける（同じ論点 ID が試験をまたいでぶつかるため）。
    # @implements BR-026
    material_images = sorted(set(MATERIAL_IMAGE.findall(sql)))
    want_prefix = f"/figures/materials/{d.name}/"
    stray_mat = [p for p in material_images if not p.startswith(want_prefix)]
    missing_mat = [
        p for p in material_images
        if p.startswith(want_prefix) and not (args.public / p.lstrip("/")).exists()
    ]
    if stray_mat:
        problems.append(
            f"教材の図が {want_prefix} 以下でないもの {len(stray_mat)} 件: {stray_mat[:3]}"
            "（表示側が通さないので画面に記法がそのまま出る）"
        )
    if missing_mat:
        problems.append(
            f"教材が指す図が実在しない {len(missing_mat)} 件: {missing_mat[:3]}"
            f"（{args.public} 配下に無い）"
        )

    # --- 同一内容の問題 ----------------------------------------------------
    # IPA は同じ問題を別の回で使い回す。DB には全問そのまま持つが、学習側では
    # content_key で1問にまとめて出す。まとめる以上、グループの中で正解が
    # 割れていてはいけない（どちらかの読み取りが間違っている）。
    dup_groups: dict[str, list[dict]] = defaultdict(list)
    rows_full = _question_values(sql)
    for row in rows_full:
        if row.get("content_key"):
            dup_groups[row["content_key"]].append(row)
    same_content = {k: v for k, v in dup_groups.items() if len(v) > 1}
    conflicting = {
        k: v for k, v in same_content.items() if len({r.get("answer") for r in v}) > 1
    }
    if conflicting:
        problems.append(
            f"同一内容なのに正解が違う組 {len(conflicting)} 件（読み取りのどちらかが誤り）: "
            + " / ".join(
                f"{'・'.join(r['id'] for r in v)} → {'・'.join(str(r.get('answer')) for r in v)}"
                for v in list(conflicting.values())[:3]
            )
        )

    # --- 出題頻度は同一内容の重複を数えたまま --------------------------------
    # 論点の question_count は、その論点に紐づく過去問の件数（同一内容の重複を含む）。
    # 畳んだ数を入れると出題頻度＝重要度の並びが変わり、頻出論点から潰す最短経路が崩れる。
    key_of = {q["id"]: q.get("content_key") for q in rows_full}
    linked: dict[int, list[str]] = defaultdict(list)
    for link in _insert_rows(sql, "topic_questions"):
        if str(link.get("topic_id") or "").isdigit():
            linked[int(link["topic_id"])].append(str(link.get("question_id")))
    count_mismatch: list[str] = []
    folded: list[int] = []
    for t in _insert_rows(sql, "topics"):
        if not str(t.get("id") or "").isdigit():
            continue
        tid = int(t["id"])
        qs = linked.get(tid, [])
        got_n = int(t["question_count"]) if str(t.get("question_count") or "").isdigit() else None
        if got_n != len(qs):
            count_mismatch.append(f"論点 {tid}: question_count {got_n} / 紐づく過去問 {len(qs)} 件")
            # 重複を畳んだ数になっていないか（同一内容を1問と数えた形）
            if got_n == len({key_of.get(q) or q for q in qs}):
                folded.append(tid)
    if count_mismatch:
        problems.append(
            f"出題頻度が紐づく過去問の件数と合わない論点 {len(count_mismatch)} 件: "
            + " / ".join(count_mismatch[:3])
        )
    if folded:
        problems.append(
            f"出題頻度が同一内容を畳んだ数になっている論点 {len(folded)} 件: {folded[:3]}"
            "（頻度は重複を数えたまま持つ）"
        )

    # --- 問題ごとの解説と用語集 ---------------------------------------------
    # 解説は content_key で問題と結ぶ（FK は張っていない）。鍵が1文字でも違えば
    # どの問題にも表示されない。投入は通るので、ここで見ないと気づけない。
    question_keys = {r["content_key"] for r in rows_full if r.get("content_key")}
    expl = _insert_rows(sql, "question_explanations")
    stray_expl = [r["content_key"] for r in expl if r.get("content_key") not in question_keys]
    if stray_expl:
        problems.append(
            f"過去問に無い content_key を指す解説 {len(stray_expl)} 件: {sorted(stray_expl)[:3]}"
            "（どの問題にも表示されない）"
        )

    # 用語集の topic_id も FK を張っていない（論点の統合で参照先が消えうるため）。
    # 消えた論点を指したままだと、ポップの「この論点を学ぶ →」が 404 に飛ぶ。
    topic_ids = {
        int(r["id"]) for r in _insert_rows(sql, "topics") if str(r.get("id") or "").isdigit()
    }
    gloss = _insert_rows(sql, "glossary")
    stray_topic = [
        (r["term"], r["topic_id"]) for r in gloss
        if r.get("topic_id") is not None and int(r["topic_id"]) not in topic_ids
    ]
    if stray_topic:
        problems.append(
            f"存在しない論点を指す用語 {len(stray_topic)} 件: {stray_topic[:3]}"
            "（ポップの「この論点を学ぶ →」が行き先を失う）"
        )

    # --- 結果 -------------------------------------------------------------
    print(f"{sql_path}: 過去問 {len(rows)} 問 / {len(per_exam)} 回  試験名『{want_name}』")
    for exam in sorted(per_exam, reverse=True):
        print(f"  {exam:10} {per_exam[exam]:4} 問  {sorted(labels[exam])[0]}")

    # 参考情報。出題は DB の全問だが、学習側はここで数えた重複ぶんを畳んで出す。
    dup_extra = sum(len(v) - 1 for v in same_content.values())
    print(
        f"\n同一内容の組 {len(same_content)} 組 / 重複ぶん {dup_extra} 問"
        f"（学習側は1問にまとめて出題。通し受験は原本どおり全問）"
    )
    print(f"教材に差し込まれた図 {len(material_images)} 枚")
    print(f"問題解説 {len(expl)} 本 / 用語集 {len(gloss)} 語"
          f"（うち論点に結び付いた用語 {sum(1 for r in gloss if r.get('topic_id') is not None)}）")

    # D16: seed は利用者データ（users / progress / sessions / feedback）に触らない。触ると再投入で消える
    sql_text = sql_path.read_text(encoding="utf-8")
    for tbl in ("feedback", "users", "progress", "sessions", "session_questions", "daily_visits"):
        import re as _re
        if _re.search(rf"\b(DELETE\s+FROM|INSERT\s+INTO|UPDATE)\s+`?{tbl}`?\b", sql_text):
            problems.append(f"seed が利用者データの表 {tbl} に触っている（再投入で消える。D16）")

    if warnings:
        print(f"\n警告 {len(warnings)} 件:")
        for w in warnings:
            print(f"  - {w}")

    if problems:
        print(f"\n問題 {len(problems)} 件:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print("\n検証: 問題なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
