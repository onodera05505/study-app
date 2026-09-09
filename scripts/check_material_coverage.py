#!/usr/bin/env python3
"""書き直し（v1 → v2）で情報が落ちていないかを見る。

    python3 scripts/check_material_coverage.py
    python3 scripts/check_material_coverage.py --top 30   # 落ち幅の大きい順に30件

v2 は「体裁を整え直すもので、書き下ろしではない」という約束で書かせている。
だが要約してしまう事故は起きるし、67バンドルを1件ずつ読んで見つけるのは無理がある。

そこで **v1 にあって v2 に無い固有語** を機械的に洗い出す。対象にするのは、
拾いやすくて情報量の多い次の3種類。

- 英数字の語（GPL、MySQL、PDCA、KPI、RAID5 など）— 選択肢を選び分ける決め手になる
- 数値（3要素、100,000 など）
- カタカナ語（コピーレフト、パブリックドメイン など）4文字以上

**これは検出であって判定ではない。** 言い換えれば落ちていない語もあるし
（「ディープラーニング」を「深層学習」と書くなど）、落として構わない語もある。
出てきたものを人が見て、過去問を解くのに要る情報かどうかを判断する。
"""

import argparse
import json
import re
import sys
from pathlib import Path

LATIN = re.compile(r"[A-Za-z][A-Za-z0-9.\-]{1,}")
NUMBER = re.compile(r"\d[\d,]*")
KATAKANA = re.compile(r"[ァ-ヴー]{4,}")

# 表記の揺れで誤検出しやすいものを吸収する
NORMALIZE = str.maketrans({"（": "(", "）": ")", "，": ",", "　": " "})


def terms(text: str) -> set[str]:
    t = (text or "").translate(NORMALIZE)
    out = {m.group(0).rstrip(".-") for m in LATIN.finditer(t)}
    out |= {m.group(0).replace(",", "") for m in NUMBER.finditer(t)}
    out |= {m.group(0) for m in KATAKANA.finditer(t)}
    return {x for x in out if len(x) >= 2}


def load(paths: list[Path]) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for p in paths:
        for f in sorted(p.glob("*.json")):
            for m in json.loads(f.read_text(encoding="utf-8")).get("materials", []):
                m["_file"] = f"{p.name}/{f.name}"
                out[m["topic_id"]] = m
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ip", type=Path)
    ap.add_argument("--top", type=int, default=20)
    args = ap.parse_args()

    v1 = load([args.data / "materials"])
    v2 = load([args.data / "materials_v2"])
    if not v2:
        print("data/materials_v2 に教材がありません。")
        return 0

    rows = []
    shrunk = []
    for tid, new in sorted(v2.items()):
        old = v1.get(tid)
        if not old:
            continue  # 新規執筆。比べる相手がいない
        a = terms(f"{old.get('explanation')}\n{old.get('detail')}")
        b = terms(f"{new.get('explanation')}\n{new.get('detail')}")
        lost = sorted(a - b)
        if lost:
            rows.append((len(lost), tid, new.get("term"), new["_file"], lost))

        len_old = len(old.get("detail") or "")
        len_new = len(new.get("detail") or "")
        if len_new < len_old * 0.8:
            shrunk.append((len_new / len_old, tid, new.get("term"), len_old, len_new, new["_file"]))

    print(f"照合: v2 {len(v2)} 論点（うち v1 と比べられたもの {sum(1 for t in v2 if t in v1)}）")

    if shrunk:
        shrunk.sort()
        print(f"\n■ detail が短くなった論点 {len(shrunk)} 件（v1 比 8割未満）")
        print("  構造を付けると普通は長くなる。縮んでいるものは要約された疑いがある。")
        for ratio, tid, term, lo, ln, f in shrunk[: args.top]:
            print(f"  - id={tid} {term}（{lo}字 → {ln}字 / {ratio:.0%}）{f}")
        if len(shrunk) > args.top:
            print(f"  … 他 {len(shrunk) - args.top} 件")

    if rows:
        rows.sort(reverse=True)
        total = sum(r[0] for r in rows)
        print(f"\n■ v1 にあって v2 に無い語 {total} 件 / {len(rows)} 論点")
        print("  言い換えただけのものも混ざる。過去問を解くのに要る語かどうかで判断する。")
        for n, tid, term, f, lost in rows[: args.top]:
            print(f"  - id={tid} {term}（{n}件）{f}")
            print(f"      {'、'.join(lost[:12])}{' …' if len(lost) > 12 else ''}")
        if len(rows) > args.top:
            print(f"  … 他 {len(rows) - args.top} 論点")

    if not rows and not shrunk:
        print("\n情報の欠落は検出されませんでした。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
