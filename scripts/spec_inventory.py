#!/usr/bin/env python3
"""仕様書（scripts/prompts/*.md）を統合・書き換えたとき、旧版の決まりが新版に残っているかを機械で見る。

    python3 scripts/spec_inventory.py scripts/prompts/material_figures_spec.md            # 旧版 = git HEAD
    python3 scripts/spec_inventory.py scripts/prompts/write_materials.md --old <rev>        # 旧版 = 指定の版
    python3 scripts/spec_inventory.py <path> --dropped brain/spec_consolidation/<名前>.md   # 消した・変えた理由の一覧（追記のみ）

## なぜ要るか

仕様書を「足す」形から「現在形に書き換える」形へ変えた（2026-09-27）。書き換えは元の良さ
（個別の規則・例・数値・理由）を落としやすく、書いた本人は抜けに気づけない。そこで旧版の
**原子（箇条書きの 1 項目・表の 1 行・番号付きの 1 手順・段落の 1 文）**を全部抜き出し、
新版に同じ原子があるか、無ければ「原子の鍵（数値・`コード`・「引用」）」が全部残っているか、
それも無ければ --dropped の一覧に理由つきで載っているかを見る。1 つでも説明できない欠けが
あれば終了コード 1。

## 見ないもの

言い回しの違い（原子が丸ごと一致しなくても鍵が残れば通す）。新版で増えた文（増える方向は
別の目で読む）。改訂履歴の節（`## 改訂履歴` 以降）は旧版・新版とも対象外。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST = re.compile(r"^## 改訂履歴", re.M)
KEY = re.compile(r"`[^`]+`|「[^」]+」|\d+(?:[.,]\d+)?")


def body(text: str) -> str:
    m = HIST.search(text)
    return text[: m.start()] if m else text


def atoms(text: str) -> list[str]:
    """箇条書き・表の行・番号付き・段落の文・コード例の行を原子として返す。"""
    out: list[str] = []
    in_code = False
    code: list[str] = []
    para: list[str] = []

    def flush_para():
        if para:
            joined = " ".join(s.strip() for s in para)
            for sent in re.split(r"(?<=[。])\s*", joined):
                sent = sent.strip()
                if len(sent) >= 6:
                    out.append(sent)
            para.clear()

    for line in body(text).splitlines():
        if line.strip().startswith("```"):
            if in_code:
                # コード例は 1 行 1 原子（例の caption を直したときに、その行だけが欠けとして出る）
                out.extend(c.strip() for c in code if len(c.strip()) >= 6)
                code = []
            else:
                flush_para()
            in_code = not in_code
            continue
        if in_code:
            code.append(line)
            continue
        s = line.strip()
        if not s or s == "---":
            flush_para()
            continue
        if s.startswith("#"):
            flush_para()
            out.append(s)
            continue
        if s.startswith("|"):
            flush_para()
            if not re.match(r"^\|\s*-+", s):
                out.append(s)
            continue
        if re.match(r"^([-*]|\d+\.)\s", s):
            flush_para()
            out.append(s)
            continue
        if para and re.match(r"^\s{2,}", line) and out and re.match(r"^([-*]|\d+\.)\s", out[-1]):
            out[-1] += " " + s  # 箇条書きの続きの行
            continue
        if not para and out and re.match(r"^([-*]|\d+\.)\s", out[-1]) and re.match(r"^\s{2,}", line):
            out[-1] += " " + s
            continue
        para.append(s)
    flush_para()
    return out


def norm(s: str) -> str:
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"\*\*|\*|__", "", s)
    return s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--old", default="HEAD", help="旧版の git の版（既定 HEAD）。ファイルパスでもよい")
    ap.add_argument("--dropped", help="消した原子と理由の一覧（1 行に「原子の先頭 12 字以上 … — 理由」）")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    path = Path(a.path)
    try:
        rel = path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        rel = path.as_posix()  # プロジェクト外（変異テストの複製など）。旧版はファイルで渡す
    if Path(a.old).exists():
        old_text = Path(a.old).read_text(encoding="utf-8")
    else:
        r = subprocess.run(["git", "show", f"{a.old}:{rel}"], cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"旧版が取れない: git show {a.old}:{rel}", file=sys.stderr)
            return 2
        old_text = r.stdout
    new_text = path.read_text(encoding="utf-8")
    dropped = Path(a.dropped).read_text(encoding="utf-8") if a.dropped else ""
    dropped_norm = norm(dropped)

    new_norm = norm(body(new_text))
    old_atoms = atoms(old_text)
    kept = merged = explained = 0
    missing: list[str] = []
    for at in old_atoms:
        n = norm(at)
        if n and n in new_norm:
            kept += 1
            continue
        keys = [norm(k) for k in KEY.findall(re.sub(r"\d{4}-\d{2}-\d{2}", "", at))]  # 日付は経緯なので鍵にしない
        keys = [k for k in keys if not (k.isdigit() and len(k) < 2)]  # 1 桁の数は他の文にもあるので鍵にならない
        if keys and all(k in new_norm for k in keys):
            merged += 1
            continue
        head = norm(at)[:12]
        if head and head in dropped_norm:
            explained += 1
            continue
        missing.append(at)

    if not a.quiet:
        print(f"{rel}: 旧版の原子 {len(old_atoms)} / そのまま {kept} / 鍵が残る {merged} / 理由つきで消した {explained} / 説明できない欠け {len(missing)}")
        for m in missing:
            print(f"  ✘ {m[:120]}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
