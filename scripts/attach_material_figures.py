#!/usr/bin/env python3
"""図の仕様（material_figures/<topic_id>.json）を読んで、教材（materials_v2）に画像行を差し込む。

画像行の形: `![キャプション](/figures/materials/<試験>/<topic_id>-<id>.svg)`
差し込む位置は仕様の `after`:
  - "explanation" … explanation の末尾
  - "### 見出し"  … detail のその見出し行の直後（見出しが無ければエラー）

何度実行しても同じ結果になる（既存の画像行はいったん全部外してから差し直す）。
描画（render_material_figures.py）は別。ここではファイルの実在も確かめる。

使い方:
  python3 scripts/attach_material_figures.py --data data/ap            # 全論点
  python3 scripts/attach_material_figures.py --data data/ap --only 4 53
  python3 scripts/attach_material_figures.py --data data/ap --dry-run
"""
import argparse
import glob
import json
import re
import sys
from pathlib import Path

IMAGE_LINE = re.compile(r"^!\[[^\]]*\]\(/figures/materials/[^)]+\)\s*$", re.M)


def strip_images(text: str) -> str:
    out = IMAGE_LINE.sub("", text)
    # 画像行を消したあとの空行の連なりを詰める
    return re.sub(r"\n{3,}", "\n\n", out).strip("\n")


def insert_after_heading(detail: str, heading: str, line: str) -> str:
    lines = detail.split("\n")
    for i, l in enumerate(lines):
        if l.strip() == heading.strip():
            lines.insert(i + 1, line)
            return "\n".join(lines)
    raise KeyError(heading)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ap")
    ap.add_argument("--public", default="public")
    ap.add_argument("--only", nargs="*", type=int)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all-to-explanation", action="store_true",
                    help="仕様の after を無視して全図を explanation 末尾に置く（IT パスポートの方針: 図は折りたたみの外へ）")
    args = ap.parse_args()
    d = Path(args.data)
    exam = d.name

    specs = {}
    for f in sorted(glob.glob(str(d / "material_figures" / "*.json"))):
        s = json.load(open(f, encoding="utf-8"))
        specs[s["topic_id"]] = s
    if args.only:
        specs = {k: v for k, v in specs.items() if k in set(args.only)}

    problems = []
    touched = 0
    inserted = 0
    # v2 と v3（2026-09-01 の再構成版）の両方に差し込む。seed は v3 を優先して読む
    files = sorted(glob.glob(str(d / "materials_v2" / "*.json"))) + sorted(glob.glob(str(d / "materials_v3" / "*.json")))
    for f in files:
        bundle = json.load(open(f, encoding="utf-8"))
        changed = False
        for m in bundle["materials"]:
            spec = specs.get(m["topic_id"])
            if not spec:
                continue
            ex = strip_images(m["explanation"])
            det = strip_images(m["detail"])
            for fig in spec["figures"]:
                src = f"/figures/materials/{exam}/{m['topic_id']}-{fig['id']}.svg"
                if not (Path(args.public) / src.lstrip("/")).exists():
                    problems.append(f"{m['topic_id']}-{fig['id']}: 画像が無い {src}（先に render_material_figures.py を実行）")
                    continue
                line = f"![{fig['caption']}]({src})"
                after = fig["after"]
                if args.all_to_explanation or after == "explanation":
                    ex = ex.rstrip("\n") + "\n\n" + line
                else:
                    try:
                        det = insert_after_heading(det, after, line)
                    except KeyError:
                        # 教材の書き直しで見出しが消えたときは explanation の末尾へ逃がす
                        # （図が落ちるより、上に出る方がよい）
                        ex = ex.rstrip("\n") + "\n\n" + line
                inserted += 1
            if ex != m["explanation"] or det != m["detail"]:
                m["explanation"], m["detail"] = ex, det
                changed = True
                touched += 1
        if changed and not args.dry_run:
            json.dump(bundle, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print(f"対象論点 {len(specs)} / 教材を更新 {touched} 論点 / 差し込んだ画像行 {inserted}"
          + ("（dry-run、書き込みなし）" if args.dry_run else ""))
    if problems:
        print(f"\n問題 {len(problems)} 件:")
        for p in problems:
            print("  -", p)
        sys.exit(1)


if __name__ == "__main__":
    main()
