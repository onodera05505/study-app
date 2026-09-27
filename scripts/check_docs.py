#!/usr/bin/env python3
"""文書の索引と「不変条件と門」の対応表が現物とずれていないかを見る。デプロイの門。

    python3 scripts/check_docs.py              # このリポジトリ
    python3 scripts/check_docs.py --root DIR   # 変異テスト用（壊した複製を指す）

## なぜ要るか

文書は索引から辿れないと存在しないのと同じ（全部を読むと context rot になる）。
そして「不変条件と門」の表は、名指ししたスクリプトが消えた瞬間に嘘になる。
どちらも人が気づけないので機械で見る。社用側のプロトコル層（doc-layout ゲート）の
型を、CI ではなく deploy-pages.sh の前段に置く形で持ち帰ったもの（2026-09-10）。

## 見るもの

- **docs/ の索引網羅** — `docs/*.md` の全ファイル名が `CLAUDE.md` の表に載っているか
- **brain の索引網羅** — `brain/reports/*.md` の全ファイル名が `brain/INDEX.md` に載っているか
- **門の実在** — `docs/不変条件と門.md` がバッククォートで名指しするパス
  （scripts/ src/ .claude/ docs/ brain/ 配下）が実在するか。`<試験>` のような
  プレースホルダを含むものは見ない
- **仕様書の本文が現在形か** — `SPEC_CURRENT_FORM` の仕様書の本文（`## 改訂履歴` より前）に
  日付・「廃止」「以前は」「方針変更」・版の名前が無いか（決まりは足さず書き換える。2026-09-27）
- **PREMISES の決定行の反映先** — `brain/PREMISES.md` の 2026-09-27 以降の「決定」行に
  `→ 反映: \`<線のファイル>\`` があり、そのパスが実在するか（決めたことが担当の読む仕様書に
  落ちず、生成プロンプトに効いていなかった 2026-09-27 の反省。中央 reports/134）
- **作業ログの還元行** — `docs/作業ログ_YYYY-MM-DD*.md` のうち 2026-09-11 以降のものに
  `ブレイン:` で始まる行があるか（型を中央ブレインへ還したかの申告。2026-09-11 まで
  ここで行の有無だけを見ていたが、2026-09-14 から中央の `~/.claude/brain/check_return_line.py`
  を呼んで文法（「参照した型」に索引を引いた証拠があるか）まで同じ基準で見る。中央の門を
  ここに複製すると両者がずれるので、呼ぶだけにする。中央が無い環境では有無の検査だけで通す。
  中央のアプローチにこのプロジェクトの型が 1 本も無かった反省から）
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

CENTRAL_RETURN_LINE = Path(os.path.expanduser("~/.claude/brain/check_return_line.py"))

INVARIANTS_DOC = "docs/不変条件と門.md"
PATH_IN_BACKTICKS = re.compile(r"`((?:scripts|src|\.claude|docs|brain|data|public)/[^`\s]+)`")


def check_index(root: Path, index_file: str, target_dir: str, errors: list[str]) -> int:
    index_path = root / index_file
    if not index_path.exists():
        errors.append(f"索引が無い: {index_file}")
        return 0
    index = index_path.read_text(encoding="utf-8")
    files = sorted((root / target_dir).glob("*.md")) if (root / target_dir).exists() else []
    for f in files:
        if f.name not in index:
            errors.append(f"索引漏れ: {target_dir}/{f.name} が {index_file} に載っていない")
    return len(files)


def check_gate_paths(root: Path, errors: list[str]) -> int:
    doc = root / INVARIANTS_DOC
    if not doc.exists():
        errors.append(f"対応表が無い: {INVARIANTS_DOC}")
        return 0
    text = doc.read_text(encoding="utf-8")
    seen: set[str] = set()
    for m in PATH_IN_BACKTICKS.finditer(text):
        p = m.group(1)
        if "<" in p or "*" in p or p in seen:
            continue
        seen.add(p)
        if not (root / p).exists():
            errors.append(f"門が無い: {INVARIANTS_DOC} が名指しする {p} が存在しない")
        elif p.endswith(".py"):
            # 存在しても壊れていれば門ではない（docstring の閉じ忘れで 1 度も走らない門があった。2026-09-17 受入の所見）
            import ast
            try:
                ast.parse((root / p).read_text(encoding="utf-8"))
            except SyntaxError as e:
                errors.append(f"門が壊れている: {p} が Python として読めない（{e.msg}, line {e.lineno}）")
    return len(seen)


BRAIN_LINE_FROM = "2026-09-11"
WORKLOG = re.compile(r"^作業ログ_(\d{4}-\d{2}-\d{2}).*\.md$")


def check_worklog_brain_line(root: Path, errors: list[str]) -> int:
    n = 0
    for f in sorted((root / "docs").glob("作業ログ_*.md")) if (root / "docs").exists() else []:
        m = WORKLOG.match(f.name)
        if not m or m.group(1) < BRAIN_LINE_FROM:
            continue
        n += 1
        if not re.search(r"^\s*(?:[-*]\s*)?(?:\*\*)?ブレイン(?:\*\*)?\s*[:：]", f.read_text(encoding="utf-8"), re.M):
            errors.append(f"還元行が無い: docs/{f.name} に「ブレイン: …」の行が無い（型を中央へ還したか、無しの理由を書く）")
    return n


DECISION_FROM = "2026-09-27"
DECISION_LINE = re.compile(r"^- \*{0,2}(\d{4}-\d{2}-\d{2})[^\n]*?決定")


# 本文を現在形だけにした仕様書（統合が済んだものから足す。2026-09-27 本人「保つ前提で可能な限り統合していく」）
SPEC_CURRENT_FORM = [
    "scripts/prompts/material_figures_spec.md",
]
SPEC_HISTORY_HEADING = re.compile(r"^## 改訂履歴", re.M)
SPEC_STALE = re.compile(r"20\d\d-\d\d-\d\d|廃止|以前は|これまでは|方針変更|\bv[123]\b|v1 → v2|v2 → v3")


def check_spec_current_form(root: Path, errors: list[str]) -> int:
    """仕様書の本文（`## 改訂履歴` より前）に、日付・「廃止」「以前は」・版の名前が無いか。

    決まりを「足す」と本文に経緯が積もり、同じ値が 2 か所で食い違って担当が推測で選ぶ
    （2026-09-25 の読み直しで自己矛盾が出た）。変えるときは該当の文を書き換え、経緯は履歴へ。"""
    n = 0
    for rel in SPEC_CURRENT_FORM:
        f = root / rel
        if not f.exists():
            errors.append(f"現在形の仕様書が無い: {rel}")
            continue
        n += 1
        text = f.read_text(encoding="utf-8")
        m = SPEC_HISTORY_HEADING.search(text)
        if not m:
            errors.append(f"{rel}: 末尾に `## 改訂履歴` の節が無い（経緯はそこへ）")
        body = text[: m.start()] if m else text
        for i, line in enumerate(body.splitlines(), 1):
            if SPEC_STALE.search(line):
                errors.append(f"{rel}:{i}: 本文に経緯が残っている（書き換えて履歴へ）: {line.strip()[:70]}")
    return n


def check_premises_decisions(root: Path, errors: list[str]) -> int:
    """PREMISES の「決定」行（2026-09-27 以降）は `→ 反映: <線のファイル>` を持ち、その path が実在するか。

    決めたことを作業ログ（点）と PREMISES にだけ書き、担当が読む仕様書（線）に書かないと、
    次の生成に効かない（2026-09-27、図の caption の決まりが生成プロンプトに落ちていなかった。中央 reports/134）。
    線のファイルを名指しさせ、実在を見る。決定でない行・古い行は見ない。"""
    f = root / "brain" / "PREMISES.md"
    if not f.exists():
        return 0
    n = 0
    for line in f.read_text(encoding="utf-8").splitlines():
        m = DECISION_LINE.match(line)
        if not m or m.group(1) < DECISION_FROM:
            continue
        n += 1
        mm = re.search(r"→\s*反映:\s*(.+?)(?:。|$)", line)
        if not mm:
            errors.append(f"PREMISES の決定行に反映先が無い（`→ 反映: <仕様書や門のパス>` を書く。無いなら `→ 反映: 無し（理由）`）: {line[:60]}…")
            continue
        for path in re.findall(r"`([^`]+)`", mm.group(1)):
            if not (root / path).exists():
                errors.append(f"PREMISES の決定行の反映先が実在しない: {path}")
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    args = ap.parse_args()
    root = Path(args.root).resolve()

    errors: list[str] = []
    n_docs = check_index(root, "CLAUDE.md", "docs", errors)
    n_brain = check_index(root, "brain/INDEX.md", "brain/reports", errors)
    n_gates = check_gate_paths(root, errors)
    n_logs = check_worklog_brain_line(root, errors)
    n_dec = check_premises_decisions(root, errors)
    n_specs = check_spec_current_form(root, errors)
    # 対象の登録簿と .env / wrangler env / pages_projects / kickoff の整合（対象を足す場所は 1 か所、の門）
    r = subprocess.run([sys.executable, str(root / "scripts" / "new_target.py"), "--check"], capture_output=True, text=True)
    r2 = subprocess.run([sys.executable, str(root / "scripts" / "check_feedback_ledger.py")], capture_output=True, text=True)
    if r2.returncode != 0: errors.append("フィードバックの審議台帳（scripts/check_feedback_ledger.py）:\n" + (r2.stdout + r2.stderr).strip())
    if r.returncode != 0: errors.append("対象の登録簿の整合（scripts/new_target.py --check）:\n" + (r.stdout + r.stderr).strip())
    if CENTRAL_RETURN_LINE.exists():
        r = subprocess.run([sys.executable, str(CENTRAL_RETURN_LINE), "--root", str(root), "--quiet"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            errors.append("還元行の文法（中央の check_return_line.py）:\n" + (r.stdout + r.stderr).strip())

    for e in errors:
        print(f"✘ {e}")
    print(f"docs {n_docs} 件 / brain 報告書 {n_brain} 件 / 門の名指し {n_gates} 件 / 還元行の対象 {n_logs} 件 / 決定行の反映先 {n_dec} 件 / 現在形の仕様書 {n_specs} 本を確認"
          f"{'' if not errors else f'、問題 {len(errors)} 件'}")
    if errors:
        return 1
    print("✓ 文書の索引と門の対応表は現物と一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
