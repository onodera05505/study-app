#!/usr/bin/env python3
"""分類結果から論点マスタを作り、論点⇔過去問の紐付けと出題頻度を算出する。

study-app の設計の根幹は「論点に紐づく過去問の件数＝出題頻度＝重要度」。
頻出論点から潰すのが最短合格経路になる。

    python3 scripts/build_topics.py

入力: data/classified/<exam>/batch_*.json, data/questions/<exam>.json,
      data/answer_keys.json, data/exam_labels.json, data/syllabus.json,
      data/topic_aliases.json（任意）
出力: data/topics.json

## 表記揺れを潰す必要がある理由

同じ論点が別表記で登録されると**頻度が分散して重要度が壊れる**。実際に分類を
分担させたところ「IT ガバナンス」と「ITガバナンス」、「アジャイル」と
「アジャイル開発」のような揺れが出た。シラバスの用語例に無い頻出テーマ
（著作権法・ランサムウェア・ゼロトラストなど）は各担当が独自に命名するため、
ここは避けられない。

そこで2段構えにする。

1. **照合キーによる自動統合** — NFKC 正規化し、空白と記号を除いた文字列で
   突き合わせる。「IT ガバナンス」と「ITガバナンス」はこれで同一になる
2. **別名辞書による手動統合** — 「アジャイル」→「アジャイル開発」のように
   文字列が違うものは `data/topic_aliases.json` で明示的に寄せる

自動でやりすぎると別物を誤って統合するため、**似ているだけの候補は統合せず
報告にとどめる**。報告を見て別名辞書に足す運用にする。

### 大小文字だけが違う別物に注意

照合キーは `.lower()` を通すので、**`ARP`（プロトコル）と `arp`（コマンド）が
自動統合される**。実際に起きた（応用情報 2021r03a 問32 と 2024r06a 問36）。
IT 分野ではプロトコル名とコマンド名が同綴りのことがあり（arp, ping, route ほか）、
これらは別の論点として扱うべきもの。

`.lower()` を外すと「Python/python」のような真の表記揺れが寄らなくなるので、
**分類側で名前を区別する**（「ARP（アドレス解決プロトコル）」のように補足を付ける）。
検知は `check_materials.py` の「論点名が不一致」で拾える。既存の論点 ID を守るため、
名前を変えるのは**新しく現れた側**にすること（既存側を改名すると照合キーが変わり、
別 ID が採番されて教材と進捗が孤立する）。

## 同じ論点が別のシラバス項目に割り当てられた場合

論点は学習の単位なので、所属する項目は1つに決まっていないと画面が破綻する。
担当者ごとに項目の判断が割れた場合は**多数決**で決め、割れた事実を報告する。
"""

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

# 照合時に無視する文字（表記の揺れやすい記号と空白）
NOISE = re.compile(r"[\s　・･\-−－_/／()（）\[\]［］「」『』,，、.。:：;；]")


def match_key(term: str) -> str:
    """統合判定に使う照合キー。表示用の文字列とは別に持つ。"""
    k = unicodedata.normalize("NFKC", term).lower()
    return NOISE.sub("", k)


def similar(a: str, b: str) -> bool:
    """統合候補として報告すべきほど似ているか。自動統合はしない。"""
    if a == b:
        return False
    if a.startswith(b) or b.startswith(a):
        return True
    # 短いほうが長いほうに含まれ、差が3文字以内
    if (a in b or b in a) and abs(len(a) - len(b)) <= 3:
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    args = ap.parse_args()
    d = args.data

    syllabus = json.loads((d / "syllabus.json").read_text(encoding="utf-8"))
    item_by_no = {i["number"]: i for i in syllabus["items"]}
    labels = json.loads((d / "exam_labels.json").read_text(encoding="utf-8"))
    keys = json.loads((d / "answer_keys.json").read_text(encoding="utf-8"))

    alias_path = d / "topic_aliases.json"
    aliases_raw = json.loads(alias_path.read_text(encoding="utf-8")) if alias_path.exists() else {}
    # 別名辞書も照合キーで引けるようにする
    aliases = {match_key(k): v for k, v in aliases_raw.items()}

    # --- 分類結果を読む -------------------------------------------------
    records = []  # (exam, number, syllabus_item, term, is_new, related, confidence)
    for exam_dir in sorted((d / "classified").glob("*")):
        if not exam_dir.is_dir():
            continue
        for batch in sorted(exam_dir.glob("batch_*.json")):
            data = json.loads(batch.read_text(encoding="utf-8"))
            exam = data.get("exam", exam_dir.name)
            for c in data.get("classifications", []):
                term = (c.get("topic_term") or "").strip()
                if not term:
                    continue
                records.append({
                    "exam": exam,
                    "number": c["number"],
                    "item": c["syllabus_item"],
                    "term": term,
                    "is_new": bool(c.get("topic_is_new")),
                    "related": c.get("related_terms") or [],
                    "confidence": c.get("confidence") or "high",
                })

    if not records:
        sys.exit("data/classified 配下に分類結果がありません")

    # --- 論点を統合する -------------------------------------------------
    groups: dict[str, dict] = {}
    for r in records:
        key = match_key(r["term"])
        key = match_key(aliases[key]) if key in aliases else key
        display = aliases_raw.get(r["term"], r["term"])
        g = groups.setdefault(key, {
            "displays": Counter(),
            "items": Counter(),
            "is_new": Counter(),
            "related": Counter(),
            "questions": [],
        })
        g["displays"][display] += 1
        g["items"][r["item"]] += 1
        g["is_new"][r["is_new"]] += 1
        for t in r["related"]:
            g["related"][t] += 1
        g["questions"].append((r["exam"], r["number"], r["confidence"]))

    topics = []
    split_items = []  # 項目の判断が割れた論点
    for key, g in groups.items():
        display = g["displays"].most_common(1)[0][0]
        item_no, item_votes = g["items"].most_common(1)[0]
        if len(g["items"]) > 1:
            split_items.append((display, dict(g["items"])))
        item = item_by_no[item_no]
        topics.append({
            "id": None,  # 下の採番で埋める
            "term": display,
            "match_key": key,
            "syllabus_item": item_no,
            "syllabus_item_name": item["name"],
            "field": item["field"],
            "major": item["major"],
            "middle": item["middle"],
            "is_new": g["is_new"].most_common(1)[0][0],
            "related_terms": [t for t, _ in g["related"].most_common(6)],
            "question_count": len(g["questions"]),
            "questions": [
                {"exam": e, "number": n, "confidence": c}
                for e, n, c in sorted(g["questions"])
            ],
            "aliases": sorted(k for k in g["displays"] if k != display),
        })

    topics.sort(key=lambda t: (-t["question_count"], t["syllabus_item"], t["term"]))

    # --- 論点 ID を固定する -------------------------------------------
    # 並び順は出題頻度で決まるので、回を追加するたびに変わる。ID を並び順から
    # 採ると、ユーザーの理解度（progress）や執筆済みの教材が別の論点を指して
    # しまう。照合キーごとに採番した ID を data/<試験>/topic_ids.json に残し、
    # 一度振った ID は二度と使い回さない。
    id_path = d / "topic_ids.json"
    id_map: dict[str, int] = (
        json.loads(id_path.read_text(encoding="utf-8")) if id_path.exists() else {}
    )
    next_id = max(id_map.values(), default=0) + 1
    newly_assigned = 0
    for t in topics:
        key = t["match_key"]
        if key not in id_map:
            id_map[key] = next_id
            next_id += 1
            newly_assigned += 1
        t["id"] = id_map[key]
    id_path.write_text(json.dumps(id_map, ensure_ascii=False, indent=1), encoding="utf-8")

    # --- 統合しそこねている候補を報告する -------------------------------
    all_keys = sorted(groups)
    candidates = []
    for i, a in enumerate(all_keys):
        for b in all_keys[i + 1:]:
            if similar(a, b):
                da = groups[a]["displays"].most_common(1)[0][0]
                db = groups[b]["displays"].most_common(1)[0][0]
                candidates.append((da, db))

    out = {
        "topic_count": len(topics),
        "question_count": len(records),
        "exams": sorted({r["exam"] for r in records}),
        "topics": topics,
    }
    (d / "topics.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    # --- レポート -------------------------------------------------------
    print(f"→ {d / 'topics.json'}")
    print(f"  対象回数     : {len(out['exams'])} 回 {out['exams']}")
    print(f"  分類済み問題 : {len(records)} 問")
    print(f"  論点         : {len(topics)} 件")
    print(f"  うち新設     : {sum(1 for t in topics if t['is_new'])} 件")
    print(f"  別名で統合   : {sum(len(t['aliases']) for t in topics)} 件")
    print(f"  新規に採番   : {newly_assigned} 件（既存の ID は据え置き）")

    multi = [t for t in topics if t["question_count"] >= 2]
    print(f"  複数回出題   : {len(multi)} 件（頻度が意味を持つのはここから）")
    print("\n出題頻度の上位10論点:")
    for t in topics[:10]:
        print(f"  {t['question_count']}回  {t['term']}  [{t['field']} / 項目{t['syllabus_item']} {t['syllabus_item_name']}]")

    if split_items:
        print(f"\n[警告] シラバス項目の判断が割れた論点 {len(split_items)} 件（多数決で決定）:")
        for term, votes in split_items[:10]:
            print(f"  {term}: {votes}")

    if candidates:
        print(f"\n[要確認] 統合候補 {len(candidates)} 組。data/topic_aliases.json に足すと統合されます:")
        for a, b in candidates[:20]:
            print(f"  「{a}」 ⇔ 「{b}」")

    low = [r for r in records if r["confidence"] != "high"]
    print(f"\n分類の confidence が high でない問題: {len(low)} / {len(records)} 問")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
