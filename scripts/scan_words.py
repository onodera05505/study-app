#!/usr/bin/env python3
"""対象の教材・確認問題・要約に、決まりで禁じた語が残っていないかを一覧する（読むだけ）。

    python3 scripts/scan_words.py --data data/msg --rx '沿わせ|なぞ|たど[っる]|横になっ|既往'
    python3 scripts/scan_words.py --data data/msg --bold   # explanation が **論点名** で始まらない単位

出す物: 場所（本文/設問/選択肢(正解か)/理由/要約）・topic か qid・当たった語。
"""
from __future__ import annotations
import argparse, glob, json, re, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--rx"); ap.add_argument("--bold", action="store_true")
    a = ap.parse_args(); d = Path(a.data); rx = re.compile(a.rx) if a.rx else None; n = 0
    for f in sorted(glob.glob(str(d / "materials" / "*.json"))):
        raw = json.loads(Path(f).read_text(encoding="utf-8")); items = raw["materials"] if isinstance(raw, dict) else raw
        for m in items:
            if a.bold and not m["explanation"].lstrip().startswith("**"):
                n += 1; print(f"太字なし {Path(f).stem} {m['topic_id']} {m['term']}: {m['explanation'][:30]!r}")
            if rx:
                for hit in rx.findall(m["explanation"] + "\n" + m["detail"]): n += 1; print(f"本文 {m['topic_id']} {m['term']}: {hit}")
    if rx:
        for f in sorted(glob.glob(str(d / "roadmap_questions" / "*.json"))):
            raw = json.loads(Path(f).read_text(encoding="utf-8")); qs = raw["questions"] if isinstance(raw, dict) else raw
            for q in qs:
                for hit in rx.findall(q.get("stem", "")): n += 1; print(f"設問 {q['qid']}: {hit}")
                for lab, txt in q["choices"].items():
                    for hit in rx.findall(txt): n += 1; print(f"選択肢 {q['qid']} {lab}{'(正解)' if lab == q.get('answer') else ''}: {hit}")
                for hit in rx.findall(q.get("reason", "") + " ".join((q.get("choice_notes") or {}).values())): n += 1; print(f"理由 {q['qid']}: {hit}")
        r = json.loads((d / "roadmap.json").read_text(encoding="utf-8")); u = r["units"] if isinstance(r, dict) and "units" in r else r
        for x in (u.values() if isinstance(u, dict) else u):
            for hit in rx.findall(x.get("summary", "")): n += 1; print(f"要約 {x['topic_id']} {x['term']}: {hit}")
    print(f"当たり {n} 件"); return 0

if __name__ == "__main__":
    sys.exit(main())
