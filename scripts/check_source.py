#!/usr/bin/env python3
"""ソースの静的な門（デプロイの前段）。`docs/不変条件と門.md` の O5 と D11 を機械で守る。

    python3 scripts/check_source.py                 # プロジェクト全体
    python3 scripts/check_source.py --auth <ts> --client <dir>   # 変異テスト用に対象を差し替える

## 見るもの

- **O5** `src/server/lib/auth.ts` の `const ITERATIONS = N` が 100,000 以下か。
  Cloudflare Workers の PBKDF2 はこれを超えると NotSupportedError になるが、ローカルの
  miniflare は上限を課さないので、本番でだけログインが 500 になる。定数が見つからない場合も落とす
  （改名されて検査が素通りするのを防ぐ）
- **D11** `src/client/**/*.{ts,tsx}`（画面のコードの置き場にあるコード全体。部品でない `.ts` も含む）で `useState(...)([])` のように**空配列で初期化している一覧**が無いか
  （関数で `[]` を返す形・`[] as T` の形・呼び出しが複数の行にまたがる形も含む。挙げる行は `useState` の行）。
  取得前と「結果が空」が区別できず、読み込み中に「該当する論点がありません」と誤って出る
  （`null`＝未取得 / `[]`＝空 に分ける）。行ごとの例外は持たず、当たる箇所はすべて挙げて止める

落ちたら exit 1。deploy-pages.sh が描画検査の前に呼ぶ。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from tool_refusal import RefusingArgumentParser  # noqa: E402

PBKDF2_MAX = 100_000
ITER_RE = re.compile(r"^\s*(?:export\s+)?const\s+ITERATIONS\s*=\s*([\d_]+)", re.M)
_USE_STATE_RE = re.compile(r"\buseState\b")
# 初期値が空の一覧か: そのまま渡す形・関数で返す形、型を後ろに添える形（as / satisfies）を含む
_EMPTY_INIT_RE = re.compile(
    r"^(?:\(\s*\)\s*=>\s*)?\(?\s*\[\s*\]\s*(?:(?:as|satisfies)\s+[\s\S]+)?\)?\s*$"
)
_CLOSE = {"(": ")", "[": "]", "{": "}"}


# @implements REQ-550, BR-039
def check_iterations(auth: Path, errors: list[str]) -> None:
    if not auth.exists():
        errors.append(f"O5: {auth} が無い（改名したらこの検査も直す）")
        return
    m = ITER_RE.search(auth.read_text(encoding="utf-8"))
    if not m:
        errors.append(f"O5: {auth} に `const ITERATIONS = N` が見つからない")
        return
    n = int(m.group(1).replace("_", ""))
    if n > PBKDF2_MAX:
        errors.append(f"O5: PBKDF2 の反復回数 {n:,} が Workers の上限 {PBKDF2_MAX:,} を超えている（本番だけログインが 500 になる）")


def _skip_type_args(text: str, i: int) -> int:
    """`<` から対になる `>` の次の位置を返す（`=>` の `>` は数えない）。対が無ければ -1。"""
    depth = 0
    for j in range(i, len(text)):
        c = text[j]
        if c == "<":
            depth += 1
        elif c == ">" and text[j - 1] != "=":
            depth -= 1
            if depth == 0:
                return j + 1
    return -1


def _call_argument(text: str, i: int) -> str | None:
    """`(` から対になる `)` までの中身を返す（文字列の中の括弧は数えない）。対が無ければ None。"""
    stack: list[str] = []
    quote = ""
    for j in range(i, len(text)):
        c = text[j]
        if quote:
            if c == quote and text[j - 1] != "\\":
                quote = ""
            continue
        if c in "'\"`":
            quote = c
        elif c in _CLOSE:
            stack.append(_CLOSE[c])
        elif c in ")]}":
            if not stack or stack.pop() != c:
                return None
            if not stack:
                return text[i + 1 : j]
    return None


def _empty_list_sites(text: str) -> list[int]:
    """状態を空の一覧で始める `useState` の呼び出しが始まる行の番号（1 始まり）。"""
    lines: list[int] = []
    for m in _USE_STATE_RE.finditer(text):
        k = m.end()
        while k < len(text) and text[k].isspace():
            k += 1
        if k < len(text) and text[k] == "<":
            k = _skip_type_args(text, k)
            if k < 0:
                continue
            while k < len(text) and text[k].isspace():
                k += 1
        if k >= len(text) or text[k] != "(":
            continue
        arg = _call_argument(text, k)
        if arg is not None and _EMPTY_INIT_RE.match(arg.strip()):
            lines.append(text.count("\n", 0, m.start()) + 1)
    return lines


# @implements REQ-551, BR-015
def check_empty_lists(client: Path, errors: list[str]) -> int:
    n = 0
    for f in sorted(p for p in client.rglob("*") if p.is_file() and p.suffix in (".ts", ".tsx")):
        text = f.read_text(encoding="utf-8")
        for i in _empty_list_sites(text):
            errors.append(f"D11: {f}:{i} 一覧を空配列で初期化している（null＝未取得 / []＝空 に分ける）")
        n += len(text.splitlines())
    return n


# @operation UC-032#checkSource
# @implements REQ-549, REQ-571
def main() -> int:
    root = Path(__file__).resolve().parent.parent
    ap = RefusingArgumentParser()
    ap.add_argument("--auth", default=str(root / "src/server/lib/auth.ts"))
    ap.add_argument("--client", default=str(root / "src/client"))
    a = ap.parse_args()

    errors: list[str] = []
    check_iterations(Path(a.auth), errors)
    n_lines = check_empty_lists(Path(a.client), errors)
    for e in errors:
        print(f"✘ {e}")
    print(f"O5: PBKDF2 反復回数 / D11: クライアント {n_lines:,} 行を確認{'' if not errors else f'、問題 {len(errors)} 件'}")
    if errors:
        return 1
    print("✓ ソースの静的な門は通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
