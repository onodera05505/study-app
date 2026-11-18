#!/usr/bin/env python3
"""作り手と運用者が手元で回す道具が、契約の errors に当たって止まるときの断りの形（契約の ToolError）を組む部品。

断りの種類の名前の出所は src/shared/error-codes.json の 1 ファイル（ADR-0012）。道具は名前をここの CODE から引き、
名前の文字列を出す場所ごとに書かない。CODE に無い名前を引くと AttributeError で落ちる（出所に無い名前は出さない）。

    from tool_refusal import CODE, tool_error, tool_error_line
    print(tool_error_line(CODE.NOT_FOUND, "学びの置き場が無い"))   # {"error": {"code": "NOT_FOUND", "reason": "…"}} を 1 行で

シェルの道具は、標準出力に同じ形を 1 行で出すために、これをコマンドとして呼ぶ。

    python3 scripts/tool_refusal.py <名前> <理由>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

NAMES_FILE = Path(__file__).resolve().parent.parent / "src" / "shared" / "error-codes.json"
NAMES: dict[str, str] = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
CODE = SimpleNamespace(**NAMES)


class Refused(Exception):
    """契約の errors に当たって止まる失敗。code は断りの種類の名前（出所のファイルにある物だけ）、reason は理由の文、
    detail はその失敗が挙げる物の欄。道具の中の読み書きの関数はこれを投げて呼んだ側に名前を渡し（ADR-0013）、
    道具を回す入口はこれを断りの形（tool_error）にして標準出力へ出す。"""

    def __init__(self, code: str, reason: str, **detail):
        if code not in NAMES.values():
            raise ValueError(f"断りの種類の名前 {code!r} が {NAMES_FILE} に無い")
        super().__init__(reason)
        self.code, self.reason, self.detail = code, reason, detail


def tool_error(code: str, reason: str, **detail) -> dict:
    """契約の ToolError（{"error": {"code", "reason", ...detail}}）。code は出所のファイルにある名前に限る。"""
    if code not in NAMES.values():
        raise ValueError(f"断りの種類の名前 {code!r} が {NAMES_FILE} に無い")
    return {"error": {"code": code, "reason": reason, **detail}}


def tool_error_line(code: str, reason: str, **detail) -> str:
    """契約の ToolError を 1 行の JSON にした物。人が読む文を前の行に出した道具でも、最後の空でない行として読める。"""
    return json.dumps(tool_error(code, reason, **detail), ensure_ascii=False)


class RefusingArgumentParser(argparse.ArgumentParser):
    """引数を読めないとき、argparse と同じく使い方と理由を標準エラーに出して終了の状態 2 で終え、
    その前に標準出力へ断りの形（名前は INVALID_INPUT、理由は argparse の理由を添えた文）を 1 行で出す引数の読み手。"""

    def error(self, message: str):
        print(tool_error_line(CODE.INVALID_INPUT, f"引数が契約の形の外（{message}）"))
        sys.stdout.flush()
        super().error(message)


def main() -> int:
    ap = argparse.ArgumentParser(description="断りの形を 1 行の JSON で標準出力に出す")
    ap.add_argument("code", choices=sorted(NAMES))
    ap.add_argument("reason")
    a = ap.parse_args()
    print(tool_error_line(NAMES[a.code], a.reason))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
