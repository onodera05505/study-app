"""教材の本文の図の行の読み（BR-054）。学習者役のパック（build_learner_pack.py）と単元の読み物（build_unit_reading.py）が
共にこの 1 か所で、図の行か・図の置き場を指すのに形に合わない行か・図を PNG に描いて置く先を決める。

形の値の SSOT は docs/_shared/components.yaml の MaterialFigureRefPrefix・MaterialFigureLine・MaterialFigureSrc・MaterialFigurePng。
ここの正規表現はその pattern と同じ字の並びで、行全体（fullmatch）に当てる。"""
from __future__ import annotations
import re
from typing import NamedTuple, Optional

# MaterialFigureRefPrefix
REF_PREFIX = "/figures/materials/"
# MaterialFigureSrc（学びの key の段・0 個以上のサブパスの段・名前と拡張子）
_SRC = r"/figures/materials/[a-z]+/(?:[a-z0-9_-]+/)*[a-z0-9_-]+\.(?:svg|png)"
SRC = re.compile(_SRC)
# MaterialFigureLine。行頭と行末に置けるのは半角の空白・タブ・全角の空白だけで、図の説明文は空でなく `](` を含まない
_EDGE = "[ \\t\\u3000]*"
LINE = re.compile("(" + _EDGE + r"!\[)((?:[^\]\n]|\](?!\())+)(\]\()(" + _SRC + r")(\)" + _EDGE + ")")
# MaterialFigurePng
PNG = re.compile(r"figures/(?:[a-z0-9_-]+/)*[a-z0-9_-]+\.png")


class FigureLine(NamedTuple):
    """図の行の部分。head + caption + mid + src + tail が行そのもの。"""
    head: str
    caption: str
    mid: str
    src: str
    tail: str


# @implements BR-054
def figure_line(line: str) -> Optional[FigureLine]:
    """行が図の行の形に合えばその部分を、合わなければ None を返す。"""
    mo = LINE.fullmatch(line)
    return FigureLine(*mo.groups()) if mo else None


def is_malformed(line: str) -> bool:
    """図の置き場を指す前置きを含むのに図の行の形に合わない行か。その行は図の行でも本文の文でもない。"""
    return REF_PREFIX in line and figure_line(line) is None


def malformed_lines(text: str) -> list[str]:
    """本文の中の、図の置き場を指すのに図の行の形に合わない行を、書かれたままの行で本文の順に返す。"""
    return [l for l in text.split("\n") if is_malformed(l)]


def figure_srcs(text: str) -> list[str]:
    """本文の図の行の指す先を本文の順に返す。"""
    return [f.src for f in (figure_line(l) for l in text.split("\n")) if f is not None]


def map_figure_lines(text: str, fn) -> str:
    """本文の図の行だけを fn(FigureLine) の返す文字に置き換え、ほかの行はそのまま残す。"""
    out = []
    for l in text.split("\n"):
        f = figure_line(l)
        out.append(fn(f) if f is not None else l)
    return "\n".join(out)


def png_target(src: str) -> str:
    """図の行の指す先を PNG に描いて出力先に置く先。学びの key の段より下のサブパスと名前を保ち、拡張子だけを .png にする。"""
    if not SRC.fullmatch(src):
        raise ValueError(src)
    sub = src[len(REF_PREFIX):].split("/", 1)[1]
    target = "figures/" + sub.rsplit(".", 1)[0] + ".png"
    assert PNG.fullmatch(target)
    return target
