#!/usr/bin/env python3
"""数字と単位の間の空白を詰める（対象の決まり「数字と単位の間に空白を入れない」を機械で当てる）。

    python3 scripts/tighten_number_units.py --data data/mkt            # 変更箇所を数えて書く
    python3 scripts/tighten_number_units.py --data data/mkt --dry-run  # 数えるだけ

対象: materials/*.json、roadmap_questions/*.json、roadmap.json、roadmap_config.json の文字列値すべて。
かなの直後の数字の前の空白（「月 100万円」）は触らない。÷ × ＝ の前後も触らない。
"""
from __future__ import annotations
import argparse, glob, json, re, sys
from pathlib import Path

UNITS = "円|万円|万|千|億|か月|カ月|ヶ月|週|日|年|時間|分|秒|件|社|人|回|割|%|％|倍|枚|本|か所|通り|段|つ|ポイント|点|個|台|語|文|字|問|種類|桁|行|部|色|店|校|名|か国|口|席|層|軸|列|種|枠|名分|人分|件分|割引|歳|年目|か月目|日目|回目|番目|位|組"
RX = re.compile(rf"(\d)[ 　]+({UNITS})(?![A-Za-z])")

def walk(x, cnt):
    if isinstance(x, str):
        y, n = RX.subn(r"\1\2", x); cnt[0] += n; return y
    if isinstance(x, list): return [walk(v, cnt) for v in x]
    if isinstance(x, dict):
        # 出典の name は sources/*.json の登録名と突き合わせるので触らない（2026-09-25 に「No.2662 年末調整」が詰まって門が落ちた）
        return {k: (v if k == "name" else walk(v, cnt)) for k, v in x.items()}
    return x

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(); d = Path(a.data)
    files = sorted(glob.glob(str(d / "materials" / "*.json"))) + sorted(glob.glob(str(d / "roadmap_questions" / "*.json"))) + [str(d / "roadmap.json"), str(d / "roadmap_config.json")]
    total = 0
    for f in files:
        p = Path(f)
        if not p.exists(): continue
        raw = p.read_text(encoding="utf-8"); obj = json.loads(raw); cnt = [0]
        new = walk(obj, cnt)
        if cnt[0]:
            print(f"{p.relative_to(d.parent.parent) if d.parent.parent in p.parents else p}: {cnt[0]}"); total += cnt[0]
            if not a.dry_run:
                indent = 1 if raw.startswith("{\n \"") or raw.startswith("[\n {") else 2
                p.write_text(json.dumps(new, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
    print(f"合計 {total} 箇所" + ("（dry-run）" if a.dry_run else ""))
    return 0

if __name__ == "__main__":
    sys.exit(main())
