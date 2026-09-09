#!/usr/bin/env python3
"""教材を書く（書き直す）担当に渡すバンドルを作る。

    python3 scripts/build_material_bundles.py               # 未 v2 の論点を全部
    python3 scripts/build_material_bundles.py --limit 8     # 先頭8論点だけ（パイロット）
    python3 scripts/build_material_bundles.py --missing     # 教材が無い論点だけ（回の追加時）

出力: data/material_bundles/bundle_NN.json（1バンドル8論点）

**出題頻度の降順に詰める。** 論点に紐づく過去問の件数がそのまま重要度なので、
頻出論点から書き直せば、途中で止めても効果の大きいところが先に良くなる。
表示側は v1 のプレーンテキストもそのまま描けるので、混在したまま本番に出せる。

バンドルには現行の教材（`current`）と、その論点が実際に出題された過去問を丸ごと入れる。
書き直しの最低条件が「紐づく過去問をこの教材だけで解けること」なので、
担当が過去問を見ずに整形だけして情報を落とすことを防ぐ必要がある。

バンドル番号は論点 ID から決まらない（頻度順なので回を追加すると変わる）。
**実行中の担当が読んでいるファイルを上書きしない。** やり直すときは --out で別名にする。
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

BUNDLE_SIZE = 8  # これ以上増やすと出力量オーバーで担当が落ちる。prompts 側にも書いてある


def load_materials(d: Path) -> dict[int, dict]:
    """v1 → v2 の順に読み、後勝ちで上書きする（build_seed.py と同じ扱い）。"""
    out: dict[int, dict] = {}
    for sub in ("materials", "materials_v2"):
        for path in sorted((d / sub).glob("*.json")):
            for m in json.loads(path.read_text(encoding="utf-8")).get("materials", []):
                m["_v2"] = sub == "materials_v2"
                out[m["topic_id"]] = m
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    # 既定は <data>/material_bundles。固定値だと試験を取り違える（--data data/ap を
    # 指定したのに IT パスポート側へ出る）。--out と --exam-name で同じ事故が起きている。
    ap.add_argument("--out", default=None, type=Path)
    # 既存のバンドルを消して 01 から振り直す。**執筆中の担当がいるときに使わないこと。**
    ap.add_argument("--fresh", action="store_true",
                    help="出力先を空にして bundle_01 から振り直す（既存バンドルは消える）")
    ap.add_argument("--limit", type=int, help="先頭から何論点ぶんだけ作るか")
    ap.add_argument("--missing", action="store_true", help="教材が無い論点だけを対象にする")
    ap.add_argument("--only", type=int, nargs="*", help="指定した論点 ID だけを対象にする")
    args = ap.parse_args()
    d = args.data
    args.out = args.out or (d / "material_bundles")

    topics = json.loads((d / "topics.json").read_text(encoding="utf-8"))["topics"]
    materials = load_materials(d)

    questions: dict[str, dict] = {}
    for path in sorted((d / "questions").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for q in data["questions"]:
            questions[f"{data['exam']}-q{q['number']}"] = q

    keys = json.loads((d / "answer_keys.json").read_text(encoding="utf-8"))
    labels = json.loads((d / "exam_labels.json").read_text(encoding="utf-8"))

    # 対象を絞る
    targets = topics
    if args.only:
        want = set(args.only)
        targets = [t for t in targets if t["id"] in want]
    elif args.missing:
        targets = [t for t in targets if t["id"] not in materials]
    else:
        targets = [t for t in targets if not materials.get(t["id"], {}).get("_v2")]

    # 出題頻度の降順。同数なら ID 順にして、実行ごとに並びが変わらないようにする
    targets.sort(key=lambda t: (-t["question_count"], t["id"]))
    if args.limit:
        targets = targets[: args.limit]

    if not targets:
        print("対象の論点はありません。")
        return 0

    # 既定では既存バンドルを残し、**続きの番号**から振る。
    # 以前は無条件に出力先を rmtree して 01 から振り直していた。回を追加するたびに
    # 走らせるスクリプトなので、これだと執筆済みバンドル（応用情報では77個）が消え、
    # 実行中の担当が読んでいるファイルまで入れ替わる。--fresh のときだけ従来どおり。
    if args.fresh and args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True, exist_ok=True)

    existing = [int(p.stem.split("_")[1]) for p in args.out.glob("bundle_*.json")
                if p.stem.split("_")[1].isdigit()]
    start = max(existing, default=0) + 1

    written = 0
    first_n = start
    for i in range(0, len(targets), BUNDLE_SIZE):
        chunk = targets[i : i + BUNDLE_SIZE]
        n = start + i // BUNDLE_SIZE
        items = []
        for t in chunk:
            qs = []
            for link in t["questions"]:
                qid = f"{link['exam']}-q{link['number']}"
                q = questions.get(qid)
                if not q:
                    continue
                qs.append({
                    "exam": labels.get(link["exam"], link["exam"]),
                    "number": q["number"],
                    "text": q["text"],
                    "choices": q["choices"],
                    # 正解は必ず入れる。どの選択肢を選ばせたかが分からないと
                    # 「出題パターン」を書けない
                    "answer": keys.get(link["exam"], {}).get(str(q["number"])),
                    "figure_description": q.get("figure_description"),
                })
            item = {
                "topic_id": t["id"],
                "term": t["term"],
                "field": t["field"],
                "major": t["major"],
                "middle": t["middle"],
                "syllabus_item_name": t["syllabus_item_name"],
                "question_count": t["question_count"],
                "related_terms": t["related_terms"],
                "questions": qs,
            }
            cur = materials.get(t["id"])
            if cur:
                item["current"] = {
                    "explanation": cur.get("explanation"),
                    "detail": cur.get("detail"),
                }
            items.append(item)

        path = args.out / f"bundle_{n:02d}.json"
        path.write_text(
            json.dumps({"bundle": n, "topics": items}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written += 1

    print(f"→ {args.out}/bundle_{first_n:02d}.json 〜 bundle_{first_n + written - 1:02d}.json")
    print(f"  対象論点     : {len(targets)}（{written} バンドル × 最大 {BUNDLE_SIZE} 論点）")
    print(f"  書き直し     : {sum(1 for t in targets if t['id'] in materials)} 論点")
    print(f"  新規執筆     : {sum(1 for t in targets if t['id'] not in materials)} 論点")
    print(f"  出題回数     : {targets[0]['question_count']} 回 〜 {targets[-1]['question_count']} 回")
    print("\n仕様: scripts/prompts/write_materials.md を担当に必ず最初に読ませること。")
    print("出力先: data/materials_v2/bundle_NN.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
