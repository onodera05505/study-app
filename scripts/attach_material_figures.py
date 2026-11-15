#!/usr/bin/env python3
"""図の仕様（material_figures/<topic_id>.json）を読んで、論点ごとに配る本文と同じ選び方で選んだ教材の世代に画像行を差し込む。

画像行の形: `![キャプション](/figures/materials/<試験>/<topic_id>-<id>.svg)`
差し込む位置は仕様の `after` と、論点を選んだ世代で決まる。

書き直した世代（`materials_v4` 以降）から選んだ論点は、既存の画像行をいったん全部外し、学びを問わず 1 枚につき 1 行だけ
入れ直す:
  - "explanation" … explanation の末尾
  - "### 見出し"  … detail のその見出しの節の末尾（次の見出しの行の直前。後に見出しが無ければ detail の末尾）
同じ `after` の図は、仕様に並ぶ順に上から並ぶ。見出しが無ければ差し込まずに問題として示す。
置けない図が 1 つでもあれば、全部の図を確かめたうえで教材のファイルを 1 つも書き換えずに失敗で終える。
前の世代から選んだ論点は、図の置き方を変えない。既に入っている図の行はその場所のまま（キャプションだけ仕様に合わせ）、
仕様に無い図の行は外し、まだ入っていない図だけを足す（`after` が "explanation" なら explanation の末尾、見出しなら
detail のその見出し行の直後、見出しが無ければ explanation の末尾。`--all-to-explanation` を渡せば explanation の末尾）。

図の仕様のファイルが無い論点は、図の仕様に図が 1 つも無い論点として扱う（どの世代から選んでも本文の図の行を外す）。

何度実行しても同じ結果になる。
描画（render_material_figures.py）は別。ここではファイルの実在も確かめる。

契約は docs/goals/GOAL-11-run-content-pipeline/UC-027-assemble-rewritten-generation/contract.yaml の attachMaterialFigures。
標準出力に結果の JSON を 1 つ出し、人が読む報告は標準エラーに出す。

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
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from material_generations import (emit_refusal, generation_counts, is_rewritten, learning_refusal,  # noqa: E402
                                  select_materials)

# 図の行は、前後の空白（半角の空白・タブ・全角の空白など、JavaScript の trim が外す字）を外した行全体が
# `![キャプション](指す先)` で、指す先が /figures/materials/ で始まる行。画面（Markdown.tsx）が図として出す行と同じ。
# キャプションには角括弧が入ることがある（「A[1]」など）。`](` だけは入らない。
# 指す先は `)` と空白を含まない字の並び。ここでの空白は、画面の正規表現の `\s` が空白と読む字から U+FEFF を除いた字で、
# U+0085・U+001C〜U+001F を含まない（Python の `\s` はこれらも空白と読むので使わない）。
LINE_SPACES = ("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
               "\u2028\u2029\u202f\u205f\u3000\ufeff")
SRC_SPACES = LINE_SPACES.replace("\ufeff", "")
# 指す先の 1 字（図の行を読むどの道具もこの字の集合で指す先を読む）
SRC_CHAR = "[^)" + re.escape(SRC_SPACES) + "]"
IMAGE = re.compile(r"^!\[(?:[^\]]|\](?!\())*\]\((" + SRC_CHAR + r"+)\)$")
FIGURE_PREFIX = "/figures/materials/"
# 見出しの行は、前後の空白を外した行全体が `###`・1 字以上の空白・見出しの文 の行。画面（Markdown.tsx）が見出しとして出す行と同じ。
# 見出しの文は行の区切りの字（U+000D・U+2028・U+2029）を含まない（画面の正規表現の `.` がこれらに当たらない）。
LINE_SPACE = "[" + re.escape(LINE_SPACES) + "]"
HEADING = re.compile(r"^###" + LINE_SPACE + r"+[^\n\r\u2028\u2029]*[^" + re.escape(LINE_SPACES) + r"]"
                     + LINE_SPACE + r"*\Z")


def figure_src(line: str) -> Optional[str]:
    """図の行なら指す先を、そうでなければ None を返す。"""
    mo = IMAGE.match(line.strip(LINE_SPACES))
    return mo.group(1) if mo and mo.group(1).startswith(FIGURE_PREFIX) else None


def strip_images(text: str) -> str:
    """図の行を行ごと外す（外した行の跡に空行を残さない）。"""
    out = "\n".join(l for l in text.split("\n") if figure_src(l) is None)
    return re.sub(r"\n{3,}", "\n\n", out).strip("\n")


def is_heading(line: str) -> bool:
    """画面が見出しとして出す行か。"""
    return HEADING.match(line.strip(LINE_SPACES)) is not None


def insert_at_section_end(detail: str, heading: str, line: str) -> str:
    """見出しの節の末尾（次の見出しの行の直前。後に見出しが無ければ detail の末尾）に 1 行入れる。
    同じ見出しに続けて呼ぶと、後から入れた行が下に並ぶ。"""
    lines = detail.split("\n")
    for i, l in enumerate(lines):
        if l.strip() == heading.strip():
            end = next((j for j in range(i + 1, len(lines)) if is_heading(lines[j])), len(lines))
            lines.insert(end, line)
            return "\n".join(lines)
    raise KeyError(heading)


def insert_after_heading(detail: str, heading: str, line: str) -> str:
    lines = detail.split("\n")
    for i, l in enumerate(lines):
        if l.strip() == heading.strip():
            lines.insert(i + 1, line)
            return "\n".join(lines)
    raise KeyError(heading)


def keep_placed(text: str, lines_by_src: dict[str, str]) -> tuple[str, set[str]]:
    """既に入っている図の行をその場所のまま（同じ図が何度あっても数も変えず）仕様の行に合わせ、仕様に無い図の行を外す。
    (本文, 入っていた src) を返す。"""
    out, found, dropped = [], set(), False
    for l in text.split("\n"):
        src = figure_src(l)
        if src is None:
            out.append(l)
        elif src in lines_by_src:
            out.append(lines_by_src[src])
            found.add(src)
        else:
            dropped = True
    body = "\n".join(out)
    return (re.sub(r"\n{3,}", "\n\n", body).strip("\n") if dropped else body), found


def unplaced(problems: list, where: str, reason: str) -> None:
    """差し込まなかった図を問題として記す。where は図の仕様書の門の表の `{where}` の形。"""
    problems.append(f"{where}: {reason}")


# @implements REQ-488
def write_materials(changed_files: dict[Path, dict], problems: list[str], dry_run: bool) -> int:
    """全部の図を確かめたあとに呼ぶ。置けない図が 1 つでもあれば教材のファイルを 1 つも書き換えず、
    図ごとの問題を残したまま失敗（終了 1）で終える。問題が無ければ変わった教材のファイルを書き、終了 0。"""
    if problems:
        return 1
    if not dry_run:
        for path, bundle in changed_files.items():
            json.dump(bundle, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return 0


def place_figures(m: dict, spec: dict, spec_name: str, exam: str, public: Path, rewritten: bool,
                  all_to_explanation: bool, problems: list) -> tuple[str, str, int]:
    """1 論点の教材に図を差し込んだ (explanation, detail, 教材にある図の数)。"""
    lines_by_src: dict[str, str] = {}
    figs = []
    for fig in spec["figures"]:
        where = f"[{spec_name}] 論点 {m['topic_id']} 図 {fig['id']}"
        src = f"/figures/materials/{exam}/{m['topic_id']}-{fig['id']}.svg"
        if not (public / src.lstrip("/")).exists():
            unplaced(problems, where, f"画像が無い {src}（先に render_material_figures.py を実行）")
            continue
        lines_by_src[src] = f"![{fig['caption']}]({src})"
        figs.append((where, src, fig["after"]))

    # @implements REQ-470
    if rewritten:
        ex, det = strip_images(m["explanation"]), strip_images(m["detail"])
        placed = 0
        for where, src, after in figs:
            if after == "explanation":
                ex = ex.rstrip("\n") + "\n\n" + lines_by_src[src]
            else:
                try:
                    det = insert_at_section_end(det, after, lines_by_src[src])
                except KeyError:
                    unplaced(problems, where, f"after {after!r} が教材に無い")
                    continue
            placed += 1
        return ex, det, placed

    ex, in_ex = keep_placed(m["explanation"], lines_by_src)
    det, in_det = keep_placed(m["detail"], lines_by_src)
    for where, src, after in figs:
        if src in in_ex or src in in_det:
            continue
        line = lines_by_src[src]
        if all_to_explanation or after == "explanation":
            ex = ex.rstrip("\n") + "\n\n" + line
        else:
            try:
                det = insert_after_heading(det, after, line)
            except KeyError:
                # 前の世代の教材は見出しが消えていれば explanation の末尾へ逃がす（図が落ちるより、上に出る方がよい）
                ex = ex.rstrip("\n") + "\n\n" + line
    return ex, det, len(figs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/ap")
    ap.add_argument("--public", default="public")
    ap.add_argument("--only", nargs="*", type=int)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all-to-explanation", action="store_true",
                    help="前の世代から選んだ論点の図を、仕様の after を無視して explanation 末尾に置く")
    args = ap.parse_args()
    d = Path(args.data)
    exam = d.name
    refusal = learning_refusal(d, registered=False)
    if refusal:
        return emit_refusal(refusal)

    specs, spec_names = {}, {}
    for f in sorted(glob.glob(str(d / "material_figures" / "*.json"))):
        s = json.load(open(f, encoding="utf-8"))
        specs[s["topic_id"]] = s
        spec_names[s["topic_id"]] = Path(f).name
    if args.only:
        specs = {k: v for k, v in specs.items() if k in set(args.only)}

    chosen = select_materials(d)
    problems: list[str] = []
    touched = 0
    inserted = 0
    changed_files: dict[Path, dict] = {}
    # 選んだ論点を全部回す。図の仕様のファイルが無い論点は図の仕様に図が 1 つも無い論点として扱い、本文の図の行を外す
    for tid, c in sorted(chosen.items()):
        if args.only and tid not in set(args.only):
            continue
        spec = specs.get(tid, {"topic_id": tid, "figures": []})
        bundle = changed_files.get(c.path) or json.loads(c.path.read_text(encoding="utf-8"))
        m = next(x for x in reversed(bundle["materials"]) if x["topic_id"] == tid)
        ex, det, n = place_figures(m, spec, spec_names.get(tid, f"{tid}.json"), exam, Path(args.public),
                                   is_rewritten(c.generation), args.all_to_explanation, problems)
        inserted += n
        if ex != m["explanation"] or det != m["detail"]:
            m["explanation"], m["detail"] = ex, det
            changed_files[c.path] = bundle
            touched += 1
    status = write_materials(changed_files, problems, args.dry_run)

    # --only のときは絞った論点だけを数える
    counts = generation_counts({t: c for t, c in chosen.items() if not args.only or t in set(args.only)})
    print(f"対象論点 {len(specs)} / 教材を更新 {touched} 論点 / 差し込んだ画像行 {inserted}"
          + ("（dry-run、書き込みなし）" if args.dry_run else "（問題があるため書き込みなし）" if problems else ""),
          file=sys.stderr)
    print(f"  選んだ世代: {counts}", file=sys.stderr)
    if problems:
        print(f"\n問題 {len(problems)} 件:", file=sys.stderr)
        for p in problems:
            print("  -", p, file=sys.stderr)
    result = {"exitCode": status, "figures": inserted, "topicsByGeneration": counts, "problems": problems}
    print(json.dumps(result, ensure_ascii=False))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
