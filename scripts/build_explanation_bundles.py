#!/usr/bin/env python3
"""問題ごとの解説を書く担当に渡すバンドルを作る。

    python3 scripts/build_explanation_bundles.py --data data/ip
    python3 scripts/build_explanation_bundles.py --data data/ip --missing   # 未執筆ぶんだけ
    python3 scripts/build_explanation_bundles.py --data data/ip --limit 8   # パイロット

出力: data/<試験>/explanation_bundles/expl_NN.json（既定1バンドル8論点）と index.json
担当の出力先: data/<試験>/question_explanations/expl_NN.json（ファイル名を合わせる）

**論点単位で束ねる。** 解説に書くのは「正解の根拠」と「誤答ア〜エが何の用語の説明か」で、
どちらも論点の教材と地続きになる。教材で定義を読ませ、解説で誤答を潰す、という分担なので、
担当が両方を一緒に見られないと同じ説明を二重に書いたり、逆に両方から漏れたりする。

**出題頻度の降順に詰める。** 論点に紐づく過去問の件数がそのまま重要度なので、
頻出論点から書けば、途中で止めても効果の大きいところが先に良くなる（教材と同じ方針）。

同じ内容の問題は content_key で1問にまとめて入れる。IPA は同じ問題を別の回で
使い回すので（応用情報で119組）、まとめないと同じ解説を何度も書かせることになる。
同じ content_key が別の論点にもぶら下がっているときは、**頻度の高い論点にだけ**入れる。
両方に入れると2人が同じ問題を書き、後から入れたほうで上書きされる。

バンドル番号は論点 ID から決まらない（頻度順なので回を追加すると変わる）。
**実行中の担当が読んでいるファイルを上書きしない。** やり直すときは --out で別名にする。
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from build_seed import (  # 計算の定義は1か所に持つ（content_key がずれると解説が迷子になる）
    EXPLANATION_DIR,
    content_key_of,
    exam_rank,
)
from learning_parts import load_materials  # noqa: E402

TOPICS_PER_BUNDLE = 8  # これ以上増やすと出力量オーバーで担当が落ちる（教材と同じ）


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    # 既定は <data>/explanation_bundles。固定値だと試験を取り違える
    # （--data data/ap を指定したのに IT パスポート側へ出る事故が実際に起きている）。
    ap.add_argument("--out", default=None, type=Path,
                    help="出力先。既定は <data>/explanation_bundles")
    ap.add_argument("--topics-per-bundle", type=int, default=TOPICS_PER_BUNDLE)
    ap.add_argument("--max-questions", type=int, default=28,
                    help="1 バンドルの問題数（畳み後）の上限。論点は割らない")
    ap.add_argument("--fresh", action="store_true",
                    help="出力先を空にして expl_01 から振り直す（執筆中の担当がいるときは使わない）")
    ap.add_argument("--limit", type=int, help="先頭から何論点ぶんだけ作るか")
    ap.add_argument("--missing", action="store_true",
                    help="解説がまだ無い問題を含む論点だけを対象にする（回の追加時）")
    ap.add_argument("--only", type=int, nargs="*", help="指定した論点 ID だけを対象にする")
    args = ap.parse_args()
    d = args.data
    out_dir = args.out or (d / "explanation_bundles")

    topics = json.loads((d / "topics.json").read_text(encoding="utf-8"))["topics"]
    materials = load_materials(d)
    labels = json.loads((d / "exam_labels.json").read_text(encoding="utf-8"))
    keys = json.loads((d / "answer_keys.json").read_text(encoding="utf-8"))

    # --- 過去問と content_key ------------------------------------------
    questions: dict[str, dict] = {}
    groups: dict[str, list[str]] = {}  # content_key → 問題 ID（新しい回が先）
    for path in sorted((d / "questions").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for qq in data["questions"]:
            qid = f"{data['exam']}-q{qq['number']}"
            qq["_exam"] = data["exam"]
            qq["_id"] = qid
            qq["_key"] = content_key_of(qq)
            questions[qid] = qq
            groups.setdefault(qq["_key"], []).append(qid)
    for ids in groups.values():
        # 代表は最新の回。直近の本試験の表記に慣れておくほうが実戦的（dedupe と同じ）
        ids.sort(key=lambda i: (exam_rank(questions[i]["_exam"]), -questions[i]["number"]),
                 reverse=True)

    # --- content_key を1つの論点に割り当てる ----------------------------
    # 同じ問題が複数の論点にぶら下がることがある。両方のバンドルに入れると
    # 2人が同じ解説を書く。頻度の高い論点（同数なら ID の小さいほう）にだけ入れる。
    by_id = {t["id"]: t for t in topics}
    owner: dict[str, int] = {}
    for t in topics:
        for link in t["questions"]:
            qq = questions.get(f"{link['exam']}-q{link['number']}")
            if not qq:
                continue
            cur = owner.get(qq["_key"])
            if cur is None:
                owner[qq["_key"]] = t["id"]
            else:
                a, b = by_id[cur], t
                if (-a["question_count"], a["id"]) > (-b["question_count"], b["id"]):
                    owner[qq["_key"]] = t["id"]

    written_keys: set[str] = set()
    if args.missing:
        for path in sorted((d / EXPLANATION_DIR).glob("*.json")):
            for e in json.loads(path.read_text(encoding="utf-8")).get("explanations", []):
                if e.get("content_key"):
                    written_keys.add(e["content_key"])

    # --- 論点ごとの担当範囲 ---------------------------------------------
    def keys_of(t: dict) -> list[str]:
        seen: list[str] = []
        for link in t["questions"]:
            qq = questions.get(f"{link['exam']}-q{link['number']}")
            if not qq or owner.get(qq["_key"]) != t["id"] or qq["_key"] in seen:
                continue
            if args.missing and qq["_key"] in written_keys:
                continue
            seen.append(qq["_key"])
        # バンドルの中の並びは新しい回が先。読む側の目が最近の問題から入る
        seen.sort(key=lambda k: exam_rank(questions[groups[k][0]]["_exam"]), reverse=True)
        return seen

    targets = topics
    if args.only:
        want = set(args.only)
        targets = [t for t in targets if t["id"] in want]
    # 出題頻度の降順。同数なら ID 順にして、実行ごとに並びが変わらないようにする
    targets = sorted(targets, key=lambda t: (-t["question_count"], t["id"]))

    plan: list[tuple[dict, list[str]]] = []
    for t in targets:
        ks = keys_of(t)
        if ks:
            plan.append((t, ks))
    skipped = len(targets) - len(plan)
    if args.limit:
        plan = plan[: args.limit]
    if not plan:
        print("対象の論点はありません。")
        return 0

    # 既定では既存バンドルを残し、**続きの番号**から振る。無条件に振り直すと、
    # 執筆済みバンドルが消え、実行中の担当が読んでいるファイルまで入れ替わる。
    if args.fresh and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = [int(p.stem.split("_")[1]) for p in out_dir.glob("expl_*.json")
                if p.stem.split("_")[1].isdigit()]
    start = max(existing, default=0) + 1

    size = args.topics_per_bundle
    max_q = args.max_questions
    # 論点数の上限と問題数の上限の両方で区切る。頻度順に並ぶので先頭のバンドルほど
    # 問題が多く、8 論点で 85 問になった。解説 85 本は 1 体の出力量を超える
    chunks: list[list] = []
    cur: list = []
    cur_q = 0
    for t, ks in plan:
        if cur and (len(cur) >= size or cur_q + len(ks) > max_q):
            chunks.append(cur)
            cur, cur_q = [], 0
        cur.append((t, ks))
        cur_q += len(ks)
    if cur:
        chunks.append(cur)
    index: list[dict] = []
    total_q = 0
    for ci, chunk in enumerate(chunks):
        name = f"expl_{start + ci:02d}"
        items = []
        for t, ks in chunk:
            qs = []
            for k in ks:
                ids = groups[k]
                rep = questions[ids[0]]
                qs.append({
                    "question_id": rep["_id"],
                    "content_key": k,
                    "exam_label": labels.get(rep["_exam"], rep["_exam"]),
                    "number": rep["number"],
                    "stem": rep["text"],
                    "choices": rep["choices"],
                    # 正解は必ず入れる。どの選択肢が正解かが分からないと
                    # 「正解の根拠」も「誤答が何の説明か」も書けない
                    "answer": keys.get(rep["_exam"], {}).get(str(rep["number"])),
                    "has_figure": bool(rep.get("has_figure")),
                    "figure_description": rep.get("figure_description"),
                    # 同一内容が何回出題されたか。多いほど誤答の潰し甲斐がある
                    "times_asked": len(ids),
                    "other_question_ids": ids[1:],
                })
            m = materials.get(t["id"]) or {}
            items.append({
                "topic_id": t["id"],
                "term": t["term"],
                "field": t["field"],
                "middle": t["middle"],
                "syllabus_item_name": t["syllabus_item_name"],
                "question_count": t["question_count"],
                # 教材は書き換えない。解説と重複させないために読ませる
                "explanation": m.get("explanation"),
                "detail": m.get("detail"),
                "questions": qs,
            })
            total_q += len(qs)

        (out_dir / f"{name}.json").write_text(
            json.dumps({"bundle": name, "topics": items}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        index.append({
            "bundle": name,
            "topic_ids": [t["id"] for t, _ in chunk],
            "question_ids": [q["question_id"] for it in items for q in it["questions"]],
        })

    # 一覧。どのバンドルが誰の担当かを親が見るためのもの。--fresh でなければ
    # 既存の index に足す（続きの番号で作った回を消さない）。
    index_path = out_dir / "index.json"
    if index_path.exists():
        old = json.loads(index_path.read_text(encoding="utf-8")).get("bundles", [])
        names = {b["bundle"] for b in index}
        index = [b for b in old if b["bundle"] not in names] + index
    index.sort(key=lambda b: b["bundle"])
    index_path.write_text(
        json.dumps({"bundles": index}, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    first, last = index[0]["bundle"], index[-1]["bundle"]
    print(f"→ {out_dir}/  （{first} 〜 {last}、今回 {(len(plan) + size - 1) // size} バンドル）")
    print(f"  対象論点     : {len(plan)}（1バンドル最大 {size} 論点）")
    print(f"  対象問題     : {total_q}（同一内容は content_key で1問にまとめた）")
    print(f"  除外した論点 : {skipped}（担当する問題が無い）")
    print(f"  出題回数     : {plan[0][0]['question_count']} 回 〜 {plan[-1][0]['question_count']} 回")
    print(f"\n出力先: {d}/{EXPLANATION_DIR}/<バンドル名>.json（入力とファイル名を合わせる）")
    print("検証  : python3 scripts/check_explanations.py --data " + str(d))
    return 0


if __name__ == "__main__":
    sys.exit(main())
