#!/usr/bin/env python3
"""教材に添える図を、仕様 JSON から決まった様式の SVG に描く。

    python3 scripts/render_material_figures.py --data data/ap
    python3 scripts/render_material_figures.py --data data/ap --check
    python3 scripts/render_material_figures.py --data data/ap --samples \\
        --out /tmp/figcheck --png-dir /tmp/figcheck

入力: data/<試験>/material_figures/*.json   1ファイル＝1論点
      {"topic_id": 53, "term": "論理関数",
       "figures": [{"id": 1, "type": "blocks", "caption": "…", "after": "explanation", …}]}
出力: public/figures/materials/<試験>/<topic_id>-<図ID>.svg

## なぜスクリプトで描くか

図は執筆の担当（LLM）が書くが、SVG をそのまま書かせると担当ごとに見た目がばらつき、
直すときに図形の座標を追う羽目になる。**担当は仕様 JSON だけを書き、様式はここが持つ。**
そうすれば、直すのは JSON、見た目の統一はスクリプトの修正1か所、検証は機械でできる。

型は仕様書の 10（`blocks` / `sequence` / `matrix` / `chart` / `steps` / `cycle` / `layers` /
`parts` / `timeline` / `venn`）だけで、絵は閉じた語彙の絵記号（`icon`）だけ。
型と絵が仕様書の外に増えるほど担当が迷い、様式がばらつく。
書き方と `--check` の門の文言は `scripts/prompts/material_figures_spec.md` にまとめてある。

## 様式

- 幅 640 固定、高さは内容から決める（内容が横に広いときは viewBox で縮める）
- **白背景の角丸カードを焼き込む。** 画面がダークテーマでも図は白いまま出す
  （`public/figures/` に置いてある切り出し画像と同じ扱いにするため）
- 線と文字は #1f2937、強調は #2563eb の1色だけ。薄い塗りは #eff6ff / #f3f4f6
- 文字幅は実測できないので、日本語＝フォントサイズ×1.0、英数字＝×0.55 で見積もる。
  自動折り返しはしない（ラベルの改行は `\\n` の明示だけ）
- 矢印は marker を使わず多角形で描く。SVG の marker はレンダラによって出ないことがある

外部ライブラリは使わない（標準ライブラリだけで SVG 文字列を組む）。
`--png-dir` を付けたときだけ PyMuPDF で PNG も書く（目視確認用）。

## `--png-dir` の PNG で「壊れて見える」もの（SVG は正しい）

PyMuPDF（MuPDF）の SVG 描画には次の穴がある。**PNG だけの現象なので直さないこと。**
ブラウザでは正しく出る。判断に迷ったら SVG をブラウザで開いて確かめる。

- **長音符「ー」と中黒「・」が消える。** 「サーバー」が「サ バ」に見える。
  font-family を何にしても同じ（sans-serif 単独でも消える）
- **`stroke-dasharray` が効かない。** 破線（ライフライン、`style: "dashed"` の矢印、
  補助線）がすべて実線に見える
"""

from __future__ import annotations

import argparse
import json
import re
import math
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from material_generations import emit_refusal, learning_refusal, select_materials  # noqa: E402

# ---------------------------------------------------------------- 様式（定数）

WIDTH = 640                      # 出力 SVG の幅（固定）
PAD = 20                         # カードの内側余白
FONT = "Hiragino Sans, Hiragino Kaku Gothic ProN, Noto Sans JP, Yu Gothic, Meiryo, sans-serif"
FS_BODY = 14                     # 本文
FS_SMALL = 12                    # 注記・目盛り・凡例

INK = "#1f2937"                  # 線と文字
MUTED = "#6b7280"                # 注記の文字
ACCENT = "#2563eb"               # 強調（この1色だけ）
FILL_ACCENT = "#eff6ff"          # 強調の塗り
FILL_MUTED = "#f3f4f6"           # 通常の塗り
CARD = "#ffffff"                 # カードの地
CARD_EDGE = "#e5e7eb"            # カードの縁・補助線

LINE_H = 20                      # 本文の行送り
LINE_H_S = 16                    # 小さい文字の行送り

FIGURE_TYPES = ("blocks", "sequence", "matrix", "chart",
                "steps", "cycle", "layers", "parts", "timeline", "venn")
SERIES_COLORS = (ACCENT, INK, "#9ca3af")
# emphasis の系列があるときは、そこだけを強調色にして他は無彩色にする
# （既定の1本目も強調色なので、そのままだと同じ色の系列が2本できる）
SERIES_COLORS_EMPH = (INK, "#6b7280", "#9ca3af")


# ---------------------------------------------------------------- 文字幅の見積もり

def _char_width(ch: str, size: float) -> float:
    """1文字の幅。日本語は全角、英数字・記号は半角として見積もる。"""
    return size * 0.55 if ord(ch) < 0x2E80 else size * 1.0


def _text_width(s: str, size: float) -> float:
    return sum(_char_width(c, size) for c in str(s))


def _lines_of(label: str) -> list:
    """`\\n` の明示だけで改行する（自動折り返しはしない）。"""
    return str(label).split("\n")


def _block_width(label: str, size: float = FS_BODY) -> float:
    return max(_text_width(ln, size) for ln in _lines_of(label))


# ---------------------------------------------------------------- SVG の部品

def _esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _n(v: float) -> str:
    """座標を丸める。決定的な出力にするため必ずここを通す。"""
    r = round(float(v), 2)
    if r == int(r):
        return str(int(r))
    return f"{r:g}"


def _rect(x, y, w, h, fill=CARD, stroke=INK, sw=1.0, rx=6) -> str:
    st = f' stroke="{stroke}" stroke-width="{_n(sw)}"' if stroke else ""
    return (f'<rect x="{_n(x)}" y="{_n(y)}" width="{_n(w)}" height="{_n(h)}" '
            f'rx="{_n(rx)}" fill="{fill}"{st}/>')


def _line(x1, y1, x2, y2, stroke=INK, sw=1.0, dashed=False) -> str:
    d = ' stroke-dasharray="5 4"' if dashed else ""
    return (f'<line x1="{_n(x1)}" y1="{_n(y1)}" x2="{_n(x2)}" y2="{_n(y2)}" '
            f'stroke="{stroke}" stroke-width="{_n(sw)}"{d}/>')


def _path(d: str, stroke=INK, sw=1.0, fill="none", dashed=False) -> str:
    da = ' stroke-dasharray="5 4"' if dashed else ""
    return f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{_n(sw)}"{da}/>'


def _text(x, y, s, size=FS_BODY, fill=INK, anchor="middle", bold=False) -> str:
    w = ' font-weight="600"' if bold else ""
    return (f'<text x="{_n(x)}" y="{_n(y)}" font-family="{FONT}" font-size="{_n(size)}" '
            f'fill="{fill}" text-anchor="{anchor}"{w}>{_esc(s)}</text>')


def _text_block(cx, cy, label, size=FS_BODY, fill=INK, anchor="middle", bold=False,
               line_h=None) -> list:
    """複数行を (cx, cy) 中央そろえで置く。baseline は自前で計算する
    （dominant-baseline はレンダラによって効かない）。"""
    lh = line_h or (LINE_H if size >= FS_BODY else LINE_H_S)
    ls = _lines_of(label)
    top = cy - lh * len(ls) / 2
    return [_text(cx, top + lh * i + lh / 2 + size * 0.35, ln, size, fill, anchor, bold)
            for i, ln in enumerate(ls)]


def _label_on_line(cx, cy, s, size=FS_SMALL, fill=INK) -> list:
    """線の上に置くラベル。白い下地を敷いて線を隠す。"""
    w = _text_width(s, size) + 8
    return [_rect(cx - w / 2, cy - size * 0.75, w, size + 4, fill=CARD, stroke=None, rx=3),
            _text(cx, cy + size * 0.35, s, size, fill)]


def _arrow_head(x, y, dx, dy, fill=INK, length=8.0, half=3.6) -> str:
    """(x, y) を先端とする矢じり。(dx, dy) は進行方向。"""
    d = math.hypot(dx, dy) or 1.0
    ux, uy = dx / d, dy / d
    bx, by = x - ux * length, y - uy * length
    px, py = -uy * half, ux * half
    return (f'<polygon points="{_n(x)},{_n(y)} {_n(bx + px)},{_n(by + py)} '
            f'{_n(bx - px)},{_n(by - py)}" fill="{fill}"/>')


def _polyline(points, stroke=INK, sw=1.2, dashed=False, arrow="to") -> list:
    """折れ線＋矢じり。arrow は "to" / "both" / "none"。"""
    out = []
    pts = " ".join(f"{_n(x)},{_n(y)}" for x, y in points)
    da = ' stroke-dasharray="5 4"' if dashed else ""
    out.append(f'<polyline points="{pts}" fill="none" stroke="{stroke}" '
               f'stroke-width="{_n(sw)}"{da} stroke-linejoin="round"/>')
    if arrow in ("to", "both"):
        (x1, y1), (x2, y2) = points[-2], points[-1]
        out.append(_arrow_head(x2, y2, x2 - x1, y2 - y1, stroke))
    if arrow == "both":
        (x1, y1), (x2, y2) = points[1], points[0]
        out.append(_arrow_head(x2, y2, x2 - x1, y2 - y1, stroke))
    return out


# ---------------------------------------------------------------- 箱の形

def _shape(x, y, w, h, kind="box", emphasis=False) -> list:
    """4種類の箱。中身の文字は呼び出し側が置く。"""
    fill = FILL_ACCENT if emphasis else FILL_MUTED
    stroke = ACCENT if emphasis else INK
    sw = 1.8 if emphasis else 1.0

    if kind == "round":
        return [_rect(x, y, w, h, fill, stroke, sw, rx=h / 2)]
    if kind == "cylinder":
        ry = min(9.0, h / 5)
        d = (f"M {_n(x)} {_n(y + ry)} A {_n(w / 2)} {_n(ry)} 0 0 0 {_n(x + w)} {_n(y + ry)} "
             f"L {_n(x + w)} {_n(y + h - ry)} "
             f"A {_n(w / 2)} {_n(ry)} 0 0 1 {_n(x)} {_n(y + h - ry)} Z")
        top = (f"M {_n(x)} {_n(y + ry)} A {_n(w / 2)} {_n(ry)} 0 0 1 {_n(x + w)} {_n(y + ry)}")
        return [_path(d, stroke, sw, fill), _path(top, stroke, sw, "none")]
    if kind == "cloud":
        d = (f"M {_n(x + 0.16 * w)} {_n(y + h)} "
             f"C {_n(x - 0.06 * w)} {_n(y + h)} {_n(x - 0.04 * w)} {_n(y + 0.40 * h)} "
             f"{_n(x + 0.18 * w)} {_n(y + 0.42 * h)} "
             f"C {_n(x + 0.18 * w)} {_n(y - 0.06 * h)} {_n(x + 0.56 * w)} {_n(y - 0.12 * h)} "
             f"{_n(x + 0.60 * w)} {_n(y + 0.30 * h)} "
             f"C {_n(x + 0.80 * w)} {_n(y + 0.10 * h)} {_n(x + 1.06 * w)} {_n(y + 0.30 * h)} "
             f"{_n(x + 0.95 * w)} {_n(y + 0.62 * h)} "
             f"C {_n(x + 1.06 * w)} {_n(y + 0.94 * h)} {_n(x + 0.94 * w)} {_n(y + h)} "
             f"{_n(x + 0.82 * w)} {_n(y + h)} Z")
        return [_path(d, stroke, sw, fill)]
    return [_rect(x, y, w, h, fill, stroke, sw, rx=6)]


# ---------------------------------------------------------------- blocks

NODE_MIN_W = 96.0
NODE_MIN_H = 46.0
COL_GAP = 40.0
ROW_GAP = 46.0
CELL_W = 150.0
CELL_H = 60.0
SELF_LOOP_W = 24.0   # 自分への輪が箱の右にはみ出す幅


def _draw_blocks(spec) -> tuple:
    nodes = spec["nodes"]
    edges = spec.get("edges", [])

    box = {}
    for nd in nodes:
        ls = _lines_of(nd["label"])
        pad_x = 30 if nd.get("shape") == "cloud" else 24
        pad_y = 20 if nd.get("shape") == "cloud" else 16
        w = max(NODE_MIN_W, _block_width(nd["label"]) + pad_x
                + (ICON + ICON_GAP if nd.get("icon") else 0))
        h = max(NODE_MIN_H, len(ls) * LINE_H + pad_y)
        box[nd["id"]] = {"w": w, "h": h, "node": nd}

    ncols = max(nd["col"] for nd in nodes) + 1
    nrows = max(nd["row"] for nd in nodes) + 1
    col_w = [CELL_W - COL_GAP] * ncols
    row_h = [CELL_H - 14] * nrows
    for nd in nodes:
        b = box[nd["id"]]
        col_w[nd["col"]] = max(col_w[nd["col"]], b["w"])
        row_h[nd["row"]] = max(row_h[nd["row"]], b["h"])

    # 横向きの矢印のラベルが隣の箱に掛からないよう、列の間隔を広げる。
    # 自分への輪は箱の右に描くので、その分も間隔（最終列なら右の余白）で確保する
    col_gap = COL_GAP
    right_pad = 0.0
    self_need = {}           # 自分への輪が箱の右に食う幅（ノードごと）
    for e in edges:
        if e["from"] != e["to"]:
            continue
        a = box[e["from"]]
        lw = _text_width(e.get("label", ""), FS_SMALL)
        need = SELF_LOOP_W + (lw + 12 if e.get("label") else 4)
        self_need[e["from"]] = max(self_need.get(e["from"], 0.0), need)
        if a["node"]["col"] == ncols - 1:
            right_pad = max(right_pad, need)
        else:
            col_gap = max(col_gap, need + 10)
    for e in edges:
        a, z = box[e["from"]], box[e["to"]]
        if e["from"] == e["to"] or not e.get("label"):
            continue
        if a["node"]["row"] == z["node"]["row"] \
                and abs(a["node"]["col"] - z["node"]["col"]) == 1:
            # 左側のノードに自分への輪があると、その分だけ隙間を余分に要る
            left = e["from"] if a["node"]["col"] < z["node"]["col"] else e["to"]
            col_gap = max(col_gap, _text_width(e["label"], FS_SMALL) + 16
                          + self_need.get(left, 0.0))

    col_x = []
    x = 0.0
    for c in range(ncols):
        col_x.append(x + col_w[c] / 2)
        x += col_w[c] + col_gap
    grid_w = x - col_gap

    row_y = []
    y = 0.0
    for r in range(nrows):
        row_y.append(y + row_h[r] / 2)
        y += row_h[r] + ROW_GAP
    grid_h = y - ROW_GAP

    for nd in nodes:
        b = box[nd["id"]]
        b["cx"] = col_x[nd["col"]]
        b["cy"] = row_y[nd["row"]]
        b["x"] = b["cx"] - b["w"] / 2
        b["y"] = b["cy"] - b["h"] / 2

    # 同じ2つの箱を結ぶ線が複数あるとき（往復など）は、重ねずにずらす。
    # ずらさないと線もラベルも上書きされ、片方が黙って消える
    pair_count: dict = {}
    for e in edges:
        if e["from"] != e["to"]:
            k = frozenset((e["from"], e["to"]))
            pair_count[k] = pair_count.get(k, 0) + 1
    pair_seen: dict = {}

    out = []
    edge_labels: list = []   # ラベルは箱より後に描く（箱に隠されないように）
    # 矢印を先に描き、箱で上書きする（線の端が箱に潜っても目立たない）
    for e in edges:
        a, z = box[e["from"]], box[e["to"]]
        style = e.get("style", "solid")
        arrow = e.get("arrow", "to")
        dashed = style == "dashed"
        na, nz = a["node"], z["node"]

        off = 0.0
        if e["from"] != e["to"]:
            k = frozenset((e["from"], e["to"]))
            i = pair_seen.get(k, 0)
            pair_seen[k] = i + 1
            if pair_count[k] > 1:
                off = (i - (pair_count[k] - 1) / 2) * 16

        if e["from"] == e["to"]:
            # 自分への線は箱の右に小さく回す（上に出すと、上の行から降りてくる
            # 矢印とぶつかる）。ラベルは輪のさらに右へ。
            rx = a["x"] + a["w"]
            pts = [(rx, a["cy"] - 9), (rx + SELF_LOOP_W, a["cy"] - 9),
                   (rx + SELF_LOOP_W, a["cy"] + 9), (rx + 3, a["cy"] + 9)]
            lx = rx + SELF_LOOP_W + 6 + _text_width(e.get("label", ""), FS_SMALL) / 2
            ly = a["cy"]
        elif na["row"] == nz["row"] and abs(na["col"] - nz["col"]) == 1:
            ay = a["cy"] + off
            if na["col"] < nz["col"]:
                pts = [(a["x"] + a["w"], ay), (z["x"], ay)]
            else:
                pts = [(a["x"], ay), (z["x"] + z["w"], ay)]
            # 左のノードに自分への輪があるときは、その先にラベルを寄せる
            left = e["from"] if na["col"] < nz["col"] else e["to"]
            lx = (pts[0][0] + pts[-1][0]) / 2 + self_need.get(left, 0.0) / 2
            ly = ay - 8
        elif na["row"] == nz["row"]:                   # 同じ行で離れている＝下を回す
            drop = max(a["h"], z["h"]) / 2 + 22
            pts = [(a["cx"], a["y"] + a["h"]), (a["cx"], a["cy"] + drop),
                   (z["cx"], z["cy"] + drop), (z["cx"], z["y"] + z["h"])]
            lx, ly = a["cx"] * 0.6 + z["cx"] * 0.4, a["cy"] + drop - 5
        else:                                          # 行が違う＝上下の辺を直角でつなぐ
            down = na["row"] < nz["row"]
            sy = a["y"] + a["h"] if down else a["y"]
            ey = z["y"] if down else z["y"] + z["h"]
            my = (sy + ey) / 2
            pts = [(a["cx"], sy), (a["cx"], my), (z["cx"], my), (z["cx"], ey)]
            lx, ly = (a["cx"] + z["cx"]) / 2, my - 5
            if abs(a["cx"] - z["cx"]) < 0.5:
                pts = [(a["cx"] + off, sy), (z["cx"] + off, ey)]
                # ずらした線のラベルは、線の外側（左の線は左、右の線は右）に置く
                half = (_text_width(e.get("label", ""), FS_SMALL) + 8) / 2 + 2
                sgn = -1 if off < 0 else 1
                lx = a["cx"] + off + (sgn * half if off else 0)
                ly = (sy + ey) / 2

        out += _polyline(pts, INK, 1.2, dashed, arrow)
        if e.get("label"):
            edge_labels += _label_on_line(lx, ly, e["label"])

    for nd in nodes:
        b = box[nd["id"]]
        emph = bool(nd.get("emphasis"))
        out += _shape(b["x"], b["y"], b["w"], b["h"], nd.get("shape", "box"), emph)
        cy = b["cy"] + (2 if nd.get("shape") == "cylinder" else 0)
        out += _item_content(b["cx"], cy, nd["label"], emph, nd.get("icon"))
    out += edge_labels

    # 同じ行を下から回り込む線がはみ出す分の余白
    bottom_pad = 0.0
    for e in edges:
        a, z = box[e["from"]], box[e["to"]]
        if e["from"] != e["to"] and a["node"]["row"] == z["node"]["row"] \
                and abs(a["node"]["col"] - z["node"]["col"]) > 1:
            bottom_pad = max(bottom_pad, max(a["h"], z["h"]) / 2 + 30
                             - (grid_h - a["cy"]))
    return out, grid_w + right_pad, grid_h + max(0.0, bottom_pad)


# ---------------------------------------------------------------- sequence

ACTOR_H = 34.0
STEP_H = 40.0
SELF_H = 34.0


def _draw_sequence(spec) -> tuple:
    actors = spec["actors"]
    steps = spec["steps"]

    aw = [max(96.0, _block_width(a["label"]) + 26) for a in actors]
    gap = 56.0
    xs, x = [], 0.0
    for w in aw:
        xs.append(x + w / 2)
        x += w + gap
    total_w = x - gap

    # ラベルが矢印より長いときは間隔を広げる（文字が隣のライフラインに掛からない）
    need = 0.0
    for s in steps:
        if s["from"] == s["to"]:
            continue
        i = [a["id"] for a in actors].index(s["from"])
        j = [a["id"] for a in actors].index(s["to"])
        span = abs(xs[i] - xs[j])
        want = _text_width(f"{len(steps)}. {s['label']}", FS_SMALL) + 20
        if want > span:
            need = max(need, (want - span) / max(1, abs(i - j)))
    if need > 0:
        xs, x = [], 0.0
        for w in aw:
            xs.append(x + w / 2)
            x += w + gap + need
        total_w = x - gap - need

    idx = {a["id"]: i for i, a in enumerate(actors)}

    y = ACTOR_H + 16
    rows = []
    for s in steps:
        h = SELF_H if s["from"] == s["to"] else STEP_H
        if s.get("note"):
            h += LINE_H_S * len(_lines_of(s["note"]))
        rows.append((s, y, h))
        y += h
    body_h = y + 10

    out = []
    for i, a in enumerate(actors):
        out.append(_line(xs[i], ACTOR_H, xs[i], body_h, CARD_EDGE, 1.2, dashed=True))
    for i, a in enumerate(actors):
        out += _shape(xs[i] - aw[i] / 2, 0, aw[i], ACTOR_H, "box", False)
        out += _text_block(xs[i], ACTOR_H / 2, a["label"], FS_BODY, INK)

    for k, (s, top, h) in enumerate(rows):
        num = f"{k + 1}."
        label = f"{num} {s['label']}"
        if s["from"] == s["to"]:
            i = idx[s["from"]]
            x0 = xs[i]
            ay = top + 10
            pts = [(x0, ay), (x0 + 26, ay), (x0 + 26, ay + 14), (x0 + 2, ay + 14)]
            out += _polyline(pts, INK, 1.2, False, "to")
            out.append(_text(x0 + 34, ay + 8, label, FS_SMALL, INK, anchor="start"))
            ly = ay + 14
        else:
            i, j = idx[s["from"]], idx[s["to"]]
            ay = top + 18
            x0, x1 = xs[i], xs[j]
            d = 1 if x1 > x0 else -1
            out += _polyline([(x0 + d * 3, ay), (x1 - d * 3, ay)], INK, 1.2, False, "to")
            out.append(_text((x0 + x1) / 2, ay - 7, label, FS_SMALL, INK))
            ly = ay
        if s.get("note"):
            nx = (xs[idx[s["from"]]] + xs[idx[s["to"]]]) / 2
            for j, nl in enumerate(_lines_of(s["note"])):
                out += _label_on_line(nx, ly + 14 + LINE_H_S * j, nl, FS_SMALL, MUTED)

    # 絵記号は登場人物の名前の箱の上に出す。絵記号の分だけ図全体を下げる
    if any(a.get("icon") for a in actors):
        top = ICON + 6
        icons = [_icon_svg(a["icon"], xs[i] - ICON / 2, 0, INK)
                 for i, a in enumerate(actors) if a.get("icon")]
        return icons + _shift(out, 0, top), total_w, body_h + top
    return out, total_w, body_h


# ---------------------------------------------------------------- matrix

AXIS_GUTTER = 26.0
HEAD_H = 30.0


def _draw_matrix(spec) -> tuple:
    xs_vals = spec["x"]["values"]
    ys_vals = spec["y"]["values"]
    cells = spec["cells"]
    emph = {tuple(p) for p in spec.get("emphasis", [])}

    nc, nr = len(xs_vals), len(ys_vals)
    head_w = max([76.0] + [_block_width(v, FS_SMALL) + 18 for v in ys_vals])
    cell_w = max([120.0] + [_block_width(c, FS_SMALL) + 20 for row in cells for c in row]
                 + [_block_width(v, FS_SMALL) + 20 for v in xs_vals])
    max_lines = max(len(_lines_of(c)) for row in cells for c in row)
    cell_h = max(58.0, max_lines * LINE_H_S + 26)

    grid_x = AXIS_GUTTER + head_w
    grid_y = AXIS_GUTTER + HEAD_H
    total_w = grid_x + cell_w * nc
    total_h = grid_y + cell_h * nr

    out = []
    out.append(_text((grid_x + total_w) / 2, AXIS_GUTTER - 8, spec["x"]["label"],
                    FS_SMALL, MUTED, bold=True))
    # 日本語を 90 度回転させると読みにくい（文字が横倒しになる）ので、
    # 縦軸ラベルは行見出し列の真上に水平で置く
    out.append(_text(AXIS_GUTTER + head_w / 2, grid_y - HEAD_H - 8 + FS_SMALL,
                    spec["y"]["label"], FS_SMALL, MUTED, bold=True))

    for c, v in enumerate(xs_vals):
        out += _text_block(grid_x + cell_w * (c + 0.5), grid_y - HEAD_H / 2, v,
                          FS_SMALL, INK, bold=True)
    for r, v in enumerate(ys_vals):
        out += _text_block(grid_x - head_w / 2, grid_y + cell_h * (r + 0.5), v,
                          FS_SMALL, INK, bold=True)

    for r in range(nr):
        for c in range(nc):
            on = (r, c) in emph
            x = grid_x + cell_w * c
            y = grid_y + cell_h * r
            out.append(_rect(x, y, cell_w, cell_h,
                            FILL_ACCENT if on else CARD,
                            ACCENT if on else INK, 1.8 if on else 1.0, rx=4))
            out += _text_block(x + cell_w / 2, y + cell_h / 2, cells[r][c], FS_SMALL,
                              ACCENT if on else INK, bold=on)

    return out, total_w, total_h


# ---------------------------------------------------------------- chart

PLOT_H = 210.0


def _is_number(v) -> bool:
    """仕様書の「数」＝有限の数。真偽値は数に数えない。無限大・NaN（JSON の 1e400 は無限大に読まれる）と、
    浮動小数点に収まらない大きさの整数は描く計算が成り立たないので数に数えない。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        return math.isfinite(v)
    except OverflowError:
        return False


def _non_finite(v) -> bool:
    """数の形をしているが有限の数でない値（無限大・NaN・浮動小数点に収まらない整数）。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and not _is_number(v)


def _widen(lo: float, hi: float) -> tuple:
    """軸の幅が 0 以下にならないよう広げる。1 を足しても値が変わらない大きさでも幅を残す。"""
    if hi > lo:
        return lo, hi
    if lo + 1.0 > lo:
        return lo, lo + 1.0
    d = abs(lo) * 1e-6
    return (lo, lo + d) if math.isfinite(lo + d) else (lo - d, lo)


def _ratio(v: float, lo: float, hi: float) -> float:
    """lo〜hi の中での v の位置（0〜1）。差が浮動小数点の上限を超える大きさでも半分にして測る。
    軸の外の値は描く座標が有限に収まるよう ±1e6 で頭打ちにする。"""
    span, off = hi - lo, v - lo
    if math.isfinite(span) and math.isfinite(off):
        r = off / span
    else:
        r = (v / 2 - lo / 2) / (hi / 2 - lo / 2)
    return min(max(r, -1e6), 1e6)


def _fmt_num(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:g}"


def _nice_ticks(lo: float, hi: float, count: int = 5) -> list:
    lo, hi = _widen(lo, hi)
    raw = (hi - lo) / count
    if not math.isfinite(raw):
        raw = hi / count - lo / count
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1.0
    step = mag * 10
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            step = m * mag
            break
    # 幅が浮動小数点の刻みより細かいと刻みが 0 になり、目盛りを並べられない
    if not (step > 0 and _is_number(step)):
        return [lo, hi]
    start = math.floor(lo / step) * step
    if not _is_number(start):
        start = lo
    ticks, v = [], start
    while v <= hi + step * 1e-6 and len(ticks) <= 100:
        ticks.append(round(v, 10))
        nv = v + step
        # 刻みが値に対して細かすぎて進まない・浮動小数点に収まらない所まで進んだら打ち切る
        if nv == v or not _is_number(nv):
            break
        v = nv
    return ticks or [lo, hi]


def _series_color(series, i: int) -> str:
    """系列の色。強調が指定されていたら、そこだけ強調色にする。"""
    if series[i].get("emphasis"):
        return ACCENT
    if any(s.get("emphasis") for s in series):
        return SERIES_COLORS_EMPH[i % len(SERIES_COLORS_EMPH)]
    return SERIES_COLORS[i % len(SERIES_COLORS)]


def _draw_chart(spec) -> tuple:
    kind = spec["kind"]
    xv = spec["x"]["values"]
    series = spec["series"]
    numeric_x = all(_is_number(v) for v in xv)

    vals = [v for s in series for v in s["values"] if _is_number(v)]
    ymin = spec["y"].get("min")
    ymax = spec["y"].get("max")
    lo = float(ymin) if ymin is not None else min(vals + [0.0])
    hi = float(ymax) if ymax is not None else max(vals)
    lo, hi = _widen(lo, hi)
    ticks = _nice_ticks(lo, hi)
    if ymin is None:
        lo = min(lo, ticks[0])
    if ymax is None:
        hi = max(hi, ticks[-1])
    ticks = [t for t in ticks if lo - 1e-9 <= t <= hi + 1e-9] or [lo, hi]

    tick_lbl_w = max(_text_width(_fmt_num(t), FS_SMALL) for t in ticks)
    left = 16 + tick_lbl_w + 10          # 縦軸ラベル（回転）＋目盛りの文字
    right = 12.0
    plot_w = max(360.0, 600.0 - left - right)
    x0, x1 = left, left + plot_w
    y0, y1 = 6.0, 6.0 + PLOT_H           # y0=上端, y1=下端

    def sy(v: float) -> float:
        return y1 - _ratio(float(v), lo, hi) * (y1 - y0)

    if numeric_x:
        xlo, xhi = _widen(float(min(xv)), float(max(xv)))

        def sx(v):
            return x0 + _ratio(float(v), xlo, xhi) * plot_w
        x_ticks = [(sx(v), _fmt_num(float(v))) for v in xv]
    else:
        band = plot_w / len(xv)
        if kind == "bar":
            def sx_i(i):
                return x0 + band * (i + 0.5)
        else:
            def sx_i(i):
                return x0 + (plot_w * i / (len(xv) - 1) if len(xv) > 1 else plot_w / 2)

        def sx(v):
            return sx_i(xv.index(v)) if v in xv else x0
        x_ticks = [(sx_i(i), str(v)) for i, v in enumerate(xv)]

    out = []
    # 目盛り線
    for t in ticks:
        y = sy(t)
        out.append(_line(x0, y, x1, y, CARD_EDGE, 1.0))
        out.append(_text(x0 - 8, y + FS_SMALL * 0.35, _fmt_num(t), FS_SMALL, MUTED,
                        anchor="end"))
    out.append(_line(x0, y0, x0, y1, INK, 1.2))
    out.append(_line(x0, y1, x1, y1, INK, 1.2))

    # 縦の補助線（損益分岐点など）
    for v in spec.get("vlines", []):
        vx = sx(v["x"])
        out.append(_line(vx, y0, vx, y1, ACCENT, 1.2, dashed=True))
        if v.get("label"):
            anchor = "end" if vx > x1 - 60 else "start"
            out += [_rect(vx + (2 if anchor == "start" else -_text_width(v["label"], FS_SMALL) - 6),
                         y0 - 1, _text_width(v["label"], FS_SMALL) + 6, FS_SMALL + 5,
                         CARD, None, rx=3),
                    _text(vx + (5 if anchor == "start" else -5), y0 + FS_SMALL,
                         v["label"], FS_SMALL, ACCENT, anchor=anchor)]

    # 系列
    for si, s in enumerate(series):
        color = _series_color(series, si)
        sw = 2.6 if s.get("emphasis") else 1.8
        pts = [(x_ticks[i][0], sy(v)) for i, v in enumerate(s["values"])]
        if kind == "bar":
            band = plot_w / len(xv)
            bw = min(26.0, band / (len(series) + 0.8))
            base = sy(max(lo, min(0.0, hi)) if lo <= 0 <= hi else lo)
            for i, v in enumerate(s["values"]):
                cx = x_ticks[i][0] + (si - (len(series) - 1) / 2) * (bw + 3)
                top = sy(v)
                out.append(_rect(cx - bw / 2, min(top, base), bw, abs(base - top),
                                color, None, rx=2))
        elif kind == "step":
            d = [f"M {_n(pts[0][0])} {_n(pts[0][1])}"]
            for i in range(1, len(pts)):
                d.append(f"L {_n(pts[i][0])} {_n(pts[i - 1][1])}")
                d.append(f"L {_n(pts[i][0])} {_n(pts[i][1])}")
            out.append(_path(" ".join(d), color, sw))
        else:
            d = "M " + " L ".join(f"{_n(px)} {_n(py)}" for px, py in pts)
            out.append(_path(d, color, sw))
            for px, py in pts:
                out.append(f'<circle cx="{_n(px)}" cy="{_n(py)}" r="2.6" fill="{color}"/>')

    # 点への注記
    for a in spec.get("annotations", []):
        ax, ay = sx(a["x"]), sy(a["y"])
        out.append(f'<circle cx="{_n(ax)}" cy="{_n(ay)}" r="3.4" fill="{ACCENT}"/>')
        w = _text_width(a["text"], FS_SMALL) + 12
        left_side = ax + w + 10 > x1
        tx = ax - 8 - w if left_side else ax + 8
        ty = max(y0 + 2, ay - 22)
        # 線の上に置くことになるので、白で塗ったうえで枠を付ける。
        # 枠が無いと系列の線が途切れて見える
        out.append(_rect(tx, ty, w, FS_SMALL + 7, CARD, ACCENT, 1.0, rx=4))
        out.append(_text(tx + w / 2, ty + FS_SMALL + 2, a["text"], FS_SMALL, ACCENT))

    # 横軸の目盛りラベル（多いと重なるので間引く）
    stride = 1
    while stride < len(x_ticks):
        widest = max(_text_width(t[1], FS_SMALL) for t in x_ticks)
        if len(x_ticks[::stride]) * (widest + 8) <= plot_w + widest:
            break
        stride += 1
    for i, (px, lbl) in enumerate(x_ticks):
        if i % stride:
            continue
        out.append(_text(px, y1 + FS_SMALL + 6, lbl, FS_SMALL, MUTED))
    y_after_x = y1 + FS_SMALL + 10

    out.append(_text((x0 + x1) / 2, y_after_x + FS_SMALL + 6, spec["x"]["label"],
                    FS_SMALL, MUTED, bold=True))
    y_after_x += FS_SMALL + 12
    # 日本語を 90 度回転させると読みにくいので、縦軸ラベルはプロット左上に水平で置く
    out.append(_text(16, y0 - 10, spec["y"]["label"], FS_SMALL, MUTED,
                    anchor="start", bold=True))

    # 凡例（グラフの下。重ならないように折り返す）
    if len(series) > 1 or series[0].get("label"):
        items = []
        for si, s in enumerate(series):
            color = _series_color(series, si)
            items.append((s["label"], color, 20 + 6 + _text_width(s["label"], FS_SMALL)))
        rows, cur, cur_w = [], [], 0.0
        for it in items:
            if cur and cur_w + it[2] + 18 > plot_w:
                rows.append((cur, cur_w))
                cur, cur_w = [], 0.0
            cur_w += it[2] + (18 if cur else 0)
            cur.append(it)
        rows.append((cur, cur_w))
        ly = y_after_x + 10
        for row, rw in rows:
            lx = x0 + (plot_w - rw) / 2
            for lbl, color, w in row:
                out.append(_line(lx, ly + 6, lx + 20, ly + 6, color, 2.6))
                out.append(_text(lx + 26, ly + 6 + FS_SMALL * 0.35, lbl, FS_SMALL, INK,
                                anchor="start"))
                lx += w + 18
            ly += LINE_H_S + 2
        y_after_x = ly - 4

    return out, x1 + right, y_after_x


# ---------------------------------------------------------------- 絵の語彙（icon）

ICON = 22.0          # 絵記号の一辺（全部の絵記号で同じ）
ICON_GAP = 8.0       # 絵記号と文字の間
ICON_SW = 1.6        # 24 の格子での線の太さ（全部の絵記号で同じ）

ICON_NAMES = ("person", "people", "server", "database", "document", "device", "phone",
              "cloud", "network", "money", "building", "lock", "key", "clock", "gear",
              "box", "arrow-cycle", "warning", "check", "mail", "chart", "search", "hand")


def _gear_teeth() -> str:
    d = []
    for k in range(8):
        a = math.pi * 2 * k / 8
        d.append(f"M {_n(12 + 6.6 * math.cos(a))} {_n(12 + 6.6 * math.sin(a))} "
                 f"L {_n(12 + 9.6 * math.cos(a))} {_n(12 + 9.6 * math.sin(a))}")
    return " ".join(d)


# 24×24 の格子で描いた単色の線画。線の色と太さは _icon_svg の <g> が与える。
# "{c}" は塗りの点に入る色
_ICONS = {
    "person": ['<circle cx="12" cy="7.5" r="3.6"/>',
               '<path d="M4.5 21 C4.5 14.2 19.5 14.2 19.5 21"/>'],
    "people": ['<circle cx="9" cy="8" r="3.2"/>', '<circle cx="16.5" cy="9" r="2.6"/>',
               '<path d="M2.8 20.5 C2.8 14.5 15.2 14.5 15.2 20.5"/>',
               '<path d="M15 14.4 C18.5 13.8 21.4 15.8 21.4 20.5"/>'],
    "server": ['<rect x="4" y="3.5" width="16" height="7" rx="1.2"/>',
               '<rect x="4" y="13.5" width="16" height="7" rx="1.2"/>',
               '<circle cx="7.5" cy="7" r="0.9" fill="{c}" stroke="none"/>',
               '<circle cx="7.5" cy="17" r="0.9" fill="{c}" stroke="none"/>',
               '<path d="M11 7 H17 M11 17 H17"/>'],
    "database": ['<ellipse cx="12" cy="5.5" rx="7" ry="2.6"/>',
                 '<path d="M5 5.5 V18.5 C5 21.2 19 21.2 19 18.5 V5.5"/>',
                 '<path d="M5 12 C5 14.7 19 14.7 19 12"/>'],
    "document": ['<path d="M6 3 H14 L19 8 V21 H6 Z"/>', '<path d="M14 3 V8 H19"/>',
                 '<path d="M9 12 H16 M9 15 H16 M9 18 H13.5"/>'],
    "device": ['<rect x="3" y="4" width="18" height="12" rx="1.2"/>',
               '<path d="M12 16 V20 M8.5 20 H15.5"/>'],
    "phone": ['<rect x="7" y="2.5" width="10" height="19" rx="2"/>',
              '<path d="M11 18.5 H13"/>'],
    "cloud": ['<path d="M7 18.5 H17.5 A3.6 3.6 0 0 0 17.6 11.3 A5.2 5.2 0 0 0 7.6 10.2 '
              'A4.2 4.2 0 0 0 7 18.5 Z"/>'],
    "network": ['<circle cx="12" cy="5" r="2.3"/>', '<circle cx="5" cy="18.5" r="2.3"/>',
                '<circle cx="19" cy="18.5" r="2.3"/>',
                '<path d="M10.9 7.1 L6.1 16.4 M13.1 7.1 L17.9 16.4 M7.3 18.5 H16.7"/>'],
    "money": ['<circle cx="12" cy="12" r="9"/>',
              '<path d="M8.6 6.8 L12 11.6 L15.4 6.8 M12 11.6 V17.6 M8.8 12.6 H15.2 M8.8 15.2 H15.2"/>'],
    "building": ['<path d="M5.5 21 V3.5 H18.5 V21"/>', '<path d="M3 21 H21"/>',
                 '<path d="M8.5 7 H10.5 M13.5 7 H15.5 M8.5 10.5 H10.5 M13.5 10.5 H15.5 '
                 'M8.5 14 H10.5 M13.5 14 H15.5"/>',
                 '<path d="M10.5 21 V17.5 H13.5 V21"/>'],
    "lock": ['<rect x="5" y="10.5" width="14" height="10.5" rx="1.6"/>',
             '<path d="M8 10.5 V7.5 A4 4 0 0 1 16 7.5 V10.5"/>',
             '<circle cx="12" cy="15" r="1.3"/>', '<path d="M12 16.3 V18"/>'],
    "key": ['<circle cx="7.5" cy="12" r="4"/>',
            '<path d="M11.5 12 H21 M18.2 12 V15.6 M15 12 V14.6"/>'],
    "clock": ['<circle cx="12" cy="12" r="9"/>', '<path d="M12 6.8 V12 L15.6 14.2"/>'],
    "gear": ['<circle cx="12" cy="12" r="6.6"/>', '<circle cx="12" cy="12" r="2.4"/>',
             f'<path d="{_gear_teeth()}" stroke-width="3" stroke-linecap="butt"/>'],
    "box": ['<path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z"/>',
            '<path d="M4 7.5 L12 12 L20 7.5 M12 12 V21"/>'],
    "arrow-cycle": ['<path d="M5.2 10 A7 7 0 0 1 18.4 8.6"/>',
                    '<path d="M18.9 4.6 L18.6 9 L14.4 8.2"/>',
                    '<path d="M18.8 14 A7 7 0 0 1 5.6 15.4"/>',
                    '<path d="M5.1 19.4 L5.4 15 L9.6 15.8"/>'],
    "warning": ['<path d="M12 3.2 L21.4 20 H2.6 Z"/>', '<path d="M12 9 V14"/>',
                '<circle cx="12" cy="17" r="1" fill="{c}" stroke="none"/>'],
    "check": ['<circle cx="12" cy="12" r="9"/>', '<path d="M7.6 12.4 L10.6 15.4 L16.4 9.2"/>'],
    "mail": ['<rect x="3" y="6" width="18" height="12.5" rx="1.2"/>',
             '<path d="M3.6 6.8 L12 13 L20.4 6.8"/>'],
    "chart": ['<path d="M4 3.5 V20 H21"/>',
              '<rect x="7" y="13" width="3" height="7"/>',
              '<rect x="11.5" y="8" width="3" height="12"/>',
              '<rect x="16" y="11" width="3" height="9"/>'],
    "search": ['<circle cx="10.5" cy="10.5" r="6"/>',
               '<path d="M15 15 L20.5 20.5" stroke-width="2.6"/>'],
    "hand": ['<path d="M8.2 21 C6.2 19.2 4.6 16.4 4.6 13.6 V11.2 A1.3 1.3 0 0 1 7.2 11.2 V13 '
             'V6.2 A1.3 1.3 0 0 1 9.8 6.2 V11 V4.6 A1.3 1.3 0 0 1 12.4 4.6 V11 '
             'V5.6 A1.3 1.3 0 0 1 15 5.6 V11.6 V8.2 A1.3 1.3 0 0 1 17.6 8.2 V14.6 '
             'C17.6 17.6 16.6 19.6 15.4 21"/>'],
}


def _icon_svg(name, x, y, color=INK, size=ICON) -> str:
    """絵の語彙の 1 つを、左上 (x, y)・一辺 size の正方形に描く。"""
    s = size / 24
    body = "".join(p.replace("{c}", color) for p in _ICONS[name])
    return (f'<g transform="translate({_n(x)} {_n(y)}) scale({s:.4f})" fill="none" '
            f'stroke="{color}" stroke-width="{_n(ICON_SW)}" stroke-linecap="round" '
            f'stroke-linejoin="round">{body}</g>')


# ---------------------------------------------------------------- 5〜10 の型に共通の項目

ITEM_MIN_W = 120.0
ITEM_MIN_H = 46.0


def _item_size(label, icon=None, size=FS_BODY) -> tuple:
    """項目の箱の大きさ。文字の幅＋余白（絵記号があればその分も）。"""
    lh = LINE_H if size >= FS_BODY else LINE_H_S
    w = _block_width(label, size) + 24 + (ICON + ICON_GAP if icon else 0)
    h = len(_lines_of(label)) * lh + 16
    return max(ITEM_MIN_W, w), max(ITEM_MIN_H, h)


def _item_content(cx, cy, label, emphasis=False, icon=None, size=FS_BODY, bold=None) -> list:
    """箱の中身。絵記号は文字の左に置き、絵記号と文字をひとまとまりで (cx, cy) に中央そろえする。"""
    color = ACCENT if emphasis else INK
    b = emphasis if bold is None else bold
    if not icon:
        return _text_block(cx, cy, label, size, color, bold=b)
    tw = _block_width(label, size)
    left = cx - (ICON + ICON_GAP + tw) / 2
    return ([_icon_svg(icon, left, cy - ICON / 2, color)]
            + _text_block(left + ICON + ICON_GAP + tw / 2, cy, label, size, color, bold=b))


def _hit(a, b, m=0.0) -> bool:
    """長方形 (x, y, w, h) どうしが m の余裕を含めて重なるか。"""
    return (a[0] < b[0] + b[2] + m and b[0] < a[0] + a[2] + m
            and a[1] < b[1] + b[3] + m and b[1] < a[1] + a[3] + m)


def _inside(p, r, m=0.0) -> bool:
    return r[0] - m <= p[0] <= r[0] + r[2] + m and r[1] - m <= p[1] <= r[1] + r[3] + m


def _shift(elems, dx, dy) -> list:
    """組んだ要素を (dx, dy) だけ動かす。座標を後から決める型で使う。"""
    return [f'<g transform="translate({_n(dx)} {_n(dy)})">'] + elems + ["</g>"]


# ---------------------------------------------------------------- steps

STEP_RUN = 28.0      # 前の段の右端から、次の段の中心（矢印の折れる角）までの距離
STEP_GAP_Y = 30.0    # 段の行の間（縦の矢印の長さ）


def _draw_steps(spec) -> tuple:
    st = spec["stages"]
    k = len(st)
    up = spec.get("direction") == "up"
    sizes = [_item_size(s["label"], s.get("icon")) for s in st]
    h = max(sz[1] for sz in sizes)
    gy = h + STEP_GAP_Y

    xs = [0.0]
    for i in range(k - 1):
        w0, w1 = sizes[i][0], sizes[i + 1][0]
        xs.append(max(xs[i] + 24, xs[i] + w0 + STEP_RUN - w1 / 2))
    ys = [((k - 1 - i) if up else i) * gy for i in range(k)]

    out, labels = [], []
    right = xs[-1] + sizes[-1][0]
    for i in range(k - 1):
        cy = ys[i] + h / 2
        cx1 = xs[i + 1] + sizes[i + 1][0] / 2
        ey = ys[i + 1] + h if up else ys[i + 1]
        out += _polyline([(xs[i] + sizes[i][0], cy), (cx1, cy), (cx1, ey)], INK, 1.2, False, "to")
        lbl = str(st[i].get("next_label", ""))
        # 段の間のラベルは、折れる角の右に線と同じ高さで置く（その高さには前の段しか無い）
        labels += _text_block(cx1 + 8, cy, lbl, FS_SMALL, INK, anchor="start")
        right = max(right, cx1 + 8 + _block_width(lbl, FS_SMALL))
    for i, s in enumerate(st):
        emph = bool(s.get("emphasis"))
        out += _shape(xs[i], ys[i], sizes[i][0], h, "box", emph)
        out += _item_content(xs[i] + sizes[i][0] / 2, ys[i] + h / 2, s["label"], emph, s.get("icon"))
    out += labels
    return out, right, (k - 1) * gy + h


# ---------------------------------------------------------------- cycle

def _draw_cycle(spec) -> tuple:
    st = spec["stages"]
    k = len(st)
    sizes = [_item_size(s["label"], s.get("icon")) for s in st]
    nls = [str(s.get("next_label", "")) for s in st]
    lsz = [(_block_width(t, FS_SMALL) + 4, len(_lines_of(t)) * LINE_H_S) for t in nls]
    center = spec.get("center")
    crect = None
    if center:
        cw = _block_width(center, FS_BODY) + 16
        ch = len(_lines_of(center)) * LINE_H + 8
        crect = (-cw / 2, -ch / 2, cw, ch)
    step = 2 * math.pi / k
    ang = [-math.pi / 2 + step * i for i in range(k)]

    def geom(rx, ry):
        boxes = [(rx * math.cos(a) - w / 2, ry * math.sin(a) - hh / 2, w, hh)
                 for a, (w, hh) in zip(ang, sizes)]
        arcs, labs, mids = [], [], []
        for i in range(k):
            b0, b1 = boxes[i], boxes[(i + 1) % k]
            pts = [(rx * math.cos(ang[i] + step * j / 240), ry * math.sin(ang[i] + step * j / 240))
                   for j in range(241)]
            s = next((j for j, p in enumerate(pts) if not _inside(p, b0, 5)), None)
            e = next((j for j in range(240, -1, -1) if not _inside(pts[j], b1, 1)), None)
            arcs.append(pts[s:e + 1] if s is not None and e is not None and e > s else [])
            am = ang[i] + step / 2
            mx, my = rx * math.cos(am), ry * math.sin(am)
            mids.append((mx, my))
            ux, uy = math.cos(am), math.sin(am)
            w, hh = lsz[i]
            # ラベルは輪の外側に置き、矢印の線を隠さない
            lx = mx + (math.copysign(w / 2 + 6, ux) if abs(ux) > 0.3 else 0.0)
            ly = my + (math.copysign(hh / 2 + 6, uy) if abs(uy) > 0.3 else 0.0)
            labs.append((lx - w / 2, ly - hh / 2, w, hh))
        return boxes, arcs, labs, mids

    def ok(g) -> bool:
        boxes, arcs, labs, mids = g
        rects = boxes + labs + ([crect] if crect else [])
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                if _hit(rects[i], rects[j], 10 if i < k and j < k else 4):
                    return False
        for a, m in zip(arcs, mids):
            if len(a) < 2 or any(_inside(m, b, 2) for b in boxes):
                return False
            if sum(math.hypot(a[j + 1][0] - a[j][0], a[j + 1][1] - a[j][1])
                   for j in range(len(a) - 1)) < 56:
                return False
        return True

    rx = max(sz[0] for sz in sizes) / 2 + 20
    g = None
    for _ in range(400):
        ry = max(rx * 0.62, max(sz[1] for sz in sizes) / 2 + 20)
        g = geom(rx, ry)
        if ok(g):
            break
        rx += 4
    boxes, arcs, labs, _mids = g

    rects = boxes + labs + ([crect] if crect else [])
    x0 = min(r[0] for r in rects)
    y0 = min(r[1] for r in rects)
    x1 = max(r[0] + r[2] for r in rects)
    y1 = max(r[1] + r[3] for r in rects)

    out = []
    for a in arcs:
        if len(a) >= 2:
            out += _polyline(a, INK, 1.2, False, "to")
    for i, s in enumerate(st):
        emph = bool(s.get("emphasis"))
        bx, by, bw, bh = boxes[i]
        out += _shape(bx, by, bw, bh, "box", emph)
        out += _item_content(bx + bw / 2, by + bh / 2, s["label"], emph, s.get("icon"))
    for i, r in enumerate(labs):
        out += _text_block(r[0] + r[2] / 2, r[1] + r[3] / 2, nls[i], FS_SMALL, INK)
    if center:
        out += _text_block(0, 0, center, FS_BODY, INK, bold=True)
    return _shift(out, -x0, -y0), x1 - x0, y1 - y0


# ---------------------------------------------------------------- layers

LAYER_GAP = 4.0


def _draw_layers(spec) -> tuple:
    ls = spec["layers"]
    k = len(ls)
    pyramid = spec.get("shape", "stack") == "pyramid"
    sizes = [_item_size(la["label"], la.get("icon")) for la in ls]
    h = max(sz[1] for sz in sizes)
    total_h = k * h + (k - 1) * LAYER_GAP
    tops = [i * (h + LAYER_GAP) for i in range(k)]

    if pyramid:
        # 幅は上端からの深さに比例して広がる。各層の上辺（その層で一番狭い所）に文字が収まる幅にする
        need = [sz[0] + 16 for sz in sizes]
        w_top = need[0]
        w_bot = max([w_top + k * 50] + [w_top + (need[i] - w_top) * total_h / tops[i]
                                       for i in range(1, k)])

        def width_at(y):
            return w_top + (w_bot - w_top) * y / total_h
    else:
        w_bot = max([240.0] + [sz[0] for sz in sizes])

        def width_at(y):
            return w_bot

    brackets = spec.get("brackets", [])
    bcol = (max(_block_width(b["label"], FS_SMALL) for b in brackets) + 24) if brackets else 0.0
    notes = [str(la.get("note") or "") for la in ls]
    has_note = any(notes)
    note_x = bcol + w_bot + 16
    mid = bcol + w_bot / 2

    out = []
    for i, la in enumerate(ls):
        emph = bool(la.get("emphasis"))
        fill = FILL_ACCENT if emph else FILL_MUTED
        stroke = ACCENT if emph else INK
        sw = 1.8 if emph else 1.0
        y0, y1 = tops[i], tops[i] + h
        if pyramid:
            a, b = width_at(y0) / 2, width_at(y1) / 2
            d = (f"M {_n(mid - a)} {_n(y0)} L {_n(mid + a)} {_n(y0)} "
                 f"L {_n(mid + b)} {_n(y1)} L {_n(mid - b)} {_n(y1)} Z")
            out.append(_path(d, stroke, sw, fill))
        else:
            out.append(_rect(bcol, y0, w_bot, h, fill, stroke, sw, rx=4))
        out += _item_content(mid, y0 + h / 2, la["label"], emph, la.get("icon"))
        if notes[i]:
            cy = y0 + h / 2
            if pyramid:
                # 台形の右の斜辺から注記の列までを細い線で結ぶ
                out.append(_line(mid + width_at(cy) / 2 + 4, cy, note_x - 6, cy, MUTED, 0.8))
            out.append(_text(note_x, cy + FS_SMALL * 0.35, notes[i], FS_SMALL, MUTED, anchor="start"))

    for b in brackets:
        y0 = tops[b["from"]] + 2
        y1 = tops[b["to"]] + h - 2
        bx = bcol - 10
        out.append(_path(f"M {_n(bx + 6)} {_n(y0)} H {_n(bx)} V {_n(y1)} H {_n(bx + 6)}", INK, 1.2))
        out += _text_block(bx - 6, (y0 + y1) / 2, b["label"], FS_SMALL, INK, anchor="end")

    w = bcol + w_bot
    if has_note:
        w = note_x + max(_text_width(t, FS_SMALL) for t in notes)
    return out, w, total_h


# ---------------------------------------------------------------- parts

PARTS_PAD = 14.0     # 物の箱の内側の余白
PARTS_TITLE_H = 38.0
PARTS_GAP = 10.0     # 区画どうしの間
PARTS_LEAD = 36.0    # 引き出し線の長さ（物の箱の外）


def _draw_parts(spec) -> tuple:
    whole = spec["whole"]
    ps = spec["parts"]
    k = len(ps)
    half = (k + 1) // 2      # 前半（切り上げ）は左、残りは右に注記を出す
    names = [_lines_of(p["label"])[0] for p in ps]
    sec_w = max([160.0] + [_text_width(nm, FS_BODY) + 24 + (ICON + ICON_GAP if p.get("icon") else 0)
                           for nm, p in zip(names, ps)])
    title_w = (_text_width(whole["label"], FS_BODY) + 24
               + (ICON + ICON_GAP if whole.get("icon") else 0))
    ann = [(_block_width(p["label"], FS_SMALL), len(_lines_of(p["label"])) * LINE_H_S) for p in ps]
    sec_h = max(40.0, max(a[1] for a in ann) + 8)
    box_w = max(sec_w, title_w) + 2 * PARTS_PAD
    box_h = PARTS_TITLE_H + k * sec_h + (k - 1) * PARTS_GAP + PARTS_PAD
    lw_left = max(ann[i][0] for i in range(half))
    lw_right = max(ann[i][0] for i in range(half, k))
    bx = lw_left + PARTS_LEAD

    out = [_rect(bx, 0, box_w, box_h, CARD, INK, 1.4, rx=10)]
    out += _item_content(bx + box_w / 2, PARTS_TITLE_H / 2 + 2, whole["label"], False,
                        whole.get("icon"), bold=True)
    # 区画は書いた順に上から並べる（1 列なので、左の注記は上の区画、右の注記は下の区画と横一直線で結べる）
    sx, sw = bx + PARTS_PAD, box_w - 2 * PARTS_PAD
    for j, p in enumerate(ps):
        emph = bool(p.get("emphasis"))
        sy = PARTS_TITLE_H + j * (sec_h + PARTS_GAP)
        cy = sy + sec_h / 2
        out += _shape(sx, sy, sw, sec_h, "box", emph)
        out += _item_content(sx + sw / 2, cy, names[j], emph, p.get("icon"), bold=True)
        color = ACCENT if emph else INK
        if j < half:
            ax, anchor = lw_left, "end"
            out.append(_line(lw_left + 6, cy, sx, cy, INK, 0.9))
            out.append(f'<circle cx="{_n(sx)}" cy="{_n(cy)}" r="2.6" fill="{INK}"/>')
        else:
            ax, anchor = bx + box_w + PARTS_LEAD, "start"
            out.append(_line(sx + sw, cy, ax - 6, cy, INK, 0.9))
            out.append(f'<circle cx="{_n(sx + sw)}" cy="{_n(cy)}" r="2.6" fill="{INK}"/>')
        ls = _lines_of(p["label"])
        top = cy - LINE_H_S * len(ls) / 2
        for i, ln in enumerate(ls):
            out.append(_text(ax, top + LINE_H_S * i + LINE_H_S / 2 + FS_SMALL * 0.35, ln, FS_SMALL,
                            color if i == 0 else INK, anchor=anchor, bold=(i == 0)))
    return out, bx + box_w + PARTS_LEAD + lw_right, box_h


# ---------------------------------------------------------------- timeline

TL_STRIP_H = 14.0    # 期間の帯の太さ
TL_ROW_GAP = 10.0    # 帯の段どうしの間


def _draw_timeline(spec) -> tuple:
    axis = spec["axis"]
    ticks = [str(t) for t in axis["ticks"]]
    nt = len(ticks)
    tick_w = max(_text_width(t, FS_SMALL) for t in ticks)
    unit = max(560.0 / (nt - 1), tick_w + 14)
    width = unit * (nt - 1)

    def X(v):
        return float(v) * unit

    events = spec["events"]
    periods = [e for e in events if "from" in e]
    points = [e for e in events if "at" in e]

    # 期間は帯と、その上のラベルで描く。同じ段では帯どうし・ラベルどうし・ラベルと他の帯を重ねない
    # （重ねると、ラベルがどの帯のものか読めない）。重なるものは段を分ける
    rows: list = []
    placed = []
    for e in periods:
        b0, b1 = X(e["from"]), X(e["to"])
        lw = _block_width(e["label"], FS_SMALL) + 8
        l0 = min(max((b0 + b1) / 2 - lw / 2, 0.0), max(0.0, width - lw))
        item = (b0, b1, l0, l0 + lw, e)

        def clash(a, b):
            return ((a[0] < b[1] - 0.5 and b[0] < a[1] - 0.5)
                    or (a[2] < b[3] + 8 and b[2] < a[3] + 8)
                    or (a[2] < b[1] - 0.5 and b[0] < a[3] - 0.5)
                    or (b[2] < a[1] - 0.5 and a[0] < b[3] - 0.5))
        r = next((i for i, row in enumerate(rows) if not any(clash(item, o) for o in row)), None)
        if r is None:
            rows.append([])
            r = len(rows) - 1
        rows[r].append(item)
        placed.append((r, item))

    lab_h = [max(len(_lines_of(it[4]["label"])) * LINE_H_S for it in row) for row in rows]
    row_top = [0.0] * len(rows)
    cur = 0.0
    for r in reversed(range(len(rows))):       # 段 0 が軸に一番近い
        row_top[r] = cur
        cur += lab_h[r] + 4 + TL_STRIP_H + TL_ROW_GAP
    y_axis = cur + 8

    out, guides = [], []
    for r, (b0, b1, l0, l1, e) in placed:
        emph = bool(e.get("emphasis"))
        sy = row_top[r] + lab_h[r] + 4
        # 帯の端から軸への補助線。下の段のラベルの所は、ラベルの白い下地が線を隠す
        for gx in (b0, b1):
            guides.append(_line(gx, sy + TL_STRIP_H, gx, y_axis, "#9ca3af", 0.8, dashed=True))
        out.append(_rect(b0, sy, b1 - b0, TL_STRIP_H, FILL_ACCENT if emph else FILL_MUTED,
                        ACCENT if emph else INK, 1.8 if emph else 1.0, rx=3))
        lh = len(_lines_of(e["label"])) * LINE_H_S
        out.append(_rect(l0, sy - 4 - lh, l1 - l0, lh, CARD, None, rx=3))
        out += _text_block((l0 + l1) / 2, sy - 4 - lh / 2, e["label"], FS_SMALL,
                          ACCENT if emph else INK, bold=emph)
    out = guides + out

    out.append(_line(0, y_axis, width, y_axis, INK, 1.4))
    tick_y = y_axis + 5 + FS_SMALL + 2
    for i, t in enumerate(ticks):
        out.append(_line(X(i), y_axis, X(i), y_axis + 5, INK, 1.2))
        out.append(_text(X(i), tick_y, t, FS_SMALL, MUTED))
    tick_band = (y_axis + 6, tick_y + 4)

    # 点は軸の上の印と、目盛りの下の注記。注記どうしが重なるときは段を分ける
    ann_rows: list = []
    ann_placed = []
    for e in points:
        x = X(e["at"])
        lw = _block_width(e["label"], FS_SMALL) + 8
        l0 = min(max(x - lw / 2, 0.0), max(0.0, width - lw))
        r = next((i for i, row in enumerate(ann_rows)
                  if not any(l0 < o[1] + 10 and o[0] < l0 + lw + 10 for o in row)), None)
        if r is None:
            ann_rows.append([])
            r = len(ann_rows) - 1
        ann_rows[r].append((l0, l0 + lw))
        ann_placed.append((r, x, l0 + lw / 2, e))
    ann_h = [0.0] * len(ann_rows)
    for r, _x, _c, e in ann_placed:
        ann_h[r] = max(ann_h[r], len(_lines_of(e["label"])) * LINE_H_S)
    ann_top = [0.0] * len(ann_rows)
    cur = tick_band[1] + 12
    for r in range(len(ann_rows)):
        ann_top[r] = cur
        cur += ann_h[r] + 8
    # 引き出し線を先に描き、注記は白い下地に載せる（上の段の注記を下の段への線が横切らない）
    leads, marks = [], []
    for r, x, cx, e in ann_placed:
        emph = bool(e.get("emphasis"))
        on_tick = any(abs(x - X(i)) < _text_width(t, FS_SMALL) / 2 + 3 for i, t in enumerate(ticks))
        if on_tick:
            leads.append(_line(x, y_axis + 5, x, tick_band[0] - 2, MUTED, 0.8))
            leads.append(_line(x, tick_band[1] + 2, x, ann_top[r] - 2, MUTED, 0.8))
        else:
            leads.append(_line(x, y_axis + 5, x, ann_top[r] - 2, MUTED, 0.8))
        marks.append(f'<circle cx="{_n(x)}" cy="{_n(y_axis)}" r="4.5" '
                     f'fill="{ACCENT if emph else CARD}" stroke="{ACCENT if emph else INK}" '
                     f'stroke-width="1.6"/>')
        lh = len(_lines_of(e["label"])) * LINE_H_S
        lw = _block_width(e["label"], FS_SMALL) + 8
        marks.append(_rect(cx - lw / 2, ann_top[r], lw, lh, CARD, None, rx=3))
        marks += _text_block(cx, ann_top[r] + lh / 2, e["label"], FS_SMALL,
                            ACCENT if emph else INK, bold=emph)
    out += leads + marks

    bottom = cur if ann_rows else tick_band[1]
    out.append(_text(width / 2, bottom + FS_SMALL + 8, axis["label"], FS_SMALL, MUTED, bold=True))
    bottom += FS_SMALL + 12

    left = tick_w / 2 + 4
    return _shift(out, left, 0), width + 2 * left, bottom


# ---------------------------------------------------------------- venn

VENN_STEP = 5.0      # 領域の中心を探す格子の間隔


def _draw_venn(spec) -> tuple:
    sets = spec["sets"]
    ids = [s["id"] for s in sets]
    m = len(sets)
    nested = spec.get("layout") == "nested"
    universe = spec.get("universe")
    regions = spec["regions"]
    inner = [(i, r) for i, r in enumerate(regions) if r.get("in")]
    outer = [(i, r) for i, r in enumerate(regions) if not r.get("in")]
    lsz = {i: (_block_width(r["label"], FS_SMALL) + 10, len(_lines_of(r["label"])) * LINE_H_S + 6)
           for i, r in enumerate(regions)}
    max_lw = max(lsz[i][0] for i, _ in inner)

    def circles(g):
        """範囲の円 (cx, cy, r) と、範囲の名前を置く円周上の点。"""
        if nested:
            r_in = max(56.0, lsz[inner[-1][0]][0] / 2 + 14) + 4 * g
            ring = 36.0 + 6 * g
            rs = [r_in + ring * (m - 1 - j) for j in range(m)]
            cs = [(0.0, -r, r) for r in rs]           # 下端をそろえた入れ子
            names = [(0.0, -2 * r) for r in rs]
        else:
            r = max(90.0, max_lw / 2 + 24) + 6 * g
            cs = [(-r / 2, 0.0, r), (r / 2, 0.0, r)]
            if m == 3:
                cs.append((0.0, r * 0.866, r))
            names = [(c[0], c[1] + c[2]) if j == 2 else (c[0], c[1] - c[2]) for j, c in enumerate(cs)]
        return cs, names

    def sig(cs, x, y):
        return frozenset(ids[j] for j, (cx, cy, r) in enumerate(cs)
                         if (x - cx) ** 2 + (y - cy) ** 2 <= r * r)

    cs = names = name_rects = None
    spots = {}
    for g in range(80):
        cs, names = circles(g)
        name_rects = [(x - (_text_width(s["label"], FS_SMALL) + 10) / 2, y - (FS_SMALL + 6) / 2,
                       _text_width(s["label"], FS_SMALL) + 10, FS_SMALL + 6)
                      for (x, y), s in zip(names, sets)]
        bx0 = min(c[0] - c[2] for c in cs)
        bx1 = max(c[0] + c[2] for c in cs)
        by0 = min(c[1] - c[2] for c in cs)
        by1 = max(c[1] + c[2] for c in cs)
        grid = [(bx0 + VENN_STEP * a, by0 + VENN_STEP * b)
                for a in range(int((bx1 - bx0) / VENN_STEP) + 1)
                for b in range(int((by1 - by0) / VENN_STEP) + 1)]
        spots = {}
        ok = True
        for i, reg in inner:
            target = frozenset(reg["in"])
            pts = [p for p in grid if sig(cs, *p) == target]
            if not pts:
                ok = False
                break
            if nested:
                j = len(reg["in"]) - 1
                if j == m - 1:
                    pref = (cs[j][0], cs[j][1])
                else:
                    pref = (0.0, (-2 * cs[j][2] - 2 * cs[j + 1][2]) / 2)
            else:
                pref = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
            pts.sort(key=lambda p: (p[0] - pref[0]) ** 2 + (p[1] - pref[1]) ** 2)
            w, h = lsz[i]
            found = None
            for (px, py) in pts[:500]:
                rr = (px - w / 2, py - h / 2, w, h)
                if any(_hit(rr, o, 3) for o in name_rects + list(spots.values())):
                    continue
                samples = [(rr[0] - 4 + (rr[2] + 8) * a / 4, rr[1] - 4 + (rr[3] + 8) * b / 3)
                           for a in range(5) for b in range(4)]
                if all(sig(cs, *q) == target for q in samples):
                    found = rr
                    break
            if found is None:
                ok = False
                break
            spots[i] = found
        if ok:
            break

    rects = [(c[0] - c[2], c[1] - c[2], 2 * c[2], 2 * c[2]) for c in cs] + name_rects
    x0 = min(r[0] for r in rects)
    y0 = min(r[1] for r in rects)
    x1 = max(r[0] + r[2] for r in rects)
    y1 = max(r[1] + r[3] for r in rects)

    out = []
    if universe:
        out_h = max((lsz[i][1] for i, _ in outer), default=0.0)
        ux, uy = x0 - 20, y0 - 30
        uw = x1 - x0 + 40
        uh = (y1 - y0) + 30 + 16 + (out_h + 10 if outer else 0)
        out.append(_rect(ux, uy, uw, uh, "none", INK, 1.0, rx=8))
        out.append(_text(ux + 12, uy + 18, universe, FS_SMALL, MUTED, anchor="start", bold=True))
        for i, reg in outer:
            w, h = lsz[i]
            spots[i] = (ux + uw - 12 - w, uy + uh - 10 - h, w, h)
        x0, y0, x1, y1 = ux, uy, ux + uw, uy + uh
    for cx, cy, r in cs:
        out.append(f'<circle cx="{_n(cx)}" cy="{_n(cy)}" r="{_n(r)}" fill="none" '
                   f'stroke="{INK}" stroke-width="1.2"/>')
    for i, reg in enumerate(regions):
        if i not in spots:
            continue
        rx, ry, w, h = spots[i]
        emph = bool(reg.get("emphasis"))
        if emph:
            out.append(_rect(rx, ry, w, h, FILL_ACCENT, ACCENT, 1.4, rx=6))
        out += _text_block(rx + w / 2, ry + h / 2, reg["label"], FS_SMALL,
                          ACCENT if emph else INK, bold=emph)
    for (x, y), s in zip(names, sets):
        w = _text_width(s["label"], FS_SMALL) + 10
        out += [_rect(x - w / 2, y - (FS_SMALL + 6) / 2, w, FS_SMALL + 6, CARD, None, rx=3),
                _text(x, y + FS_SMALL * 0.35, s["label"], FS_SMALL, INK, bold=True)]
    return _shift(out, -x0, -y0), x1 - x0, y1 - y0

DRAWERS = {"blocks": _draw_blocks, "sequence": _draw_sequence,
           "matrix": _draw_matrix, "chart": _draw_chart,
           "steps": _draw_steps, "cycle": _draw_cycle, "layers": _draw_layers,
           "parts": _draw_parts, "timeline": _draw_timeline, "venn": _draw_venn}


# ---------------------------------------------------------------- 組み立て

# @implements REQ-428
def render(fig) -> str:
    """図 1 枚の SVG。説明文（caption）は画面が図の下に文字として出すので、SVG には見える文字としても
    <title> などの読み上げに届く文字としても持たせず、画像の高さも図の中身の分だけにする。"""
    body, w, h = DRAWERS[fig["type"]](fig)

    inner_w = max(WIDTH - 2 * PAD, w)
    nat_w = inner_w + 2 * PAD
    nat_h = PAD + h + PAD

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" '
        f'height="{_n(round(WIDTH * nat_h / nat_w))}" '
        f'viewBox="0 0 {_n(nat_w)} {_n(nat_h)}">',
        # 白いカードを焼き込む。画面がダークテーマでも図は白いまま出す
        _rect(0.5, 0.5, nat_w - 1, nat_h - 1, CARD, CARD_EDGE, 1.0, rx=12),
        f'<g transform="translate({_n(PAD + (inner_w - w) / 2)} {_n(PAD)})">',
    ]
    parts += body
    parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------- 検証

def _need(d, keys, where, problems, path="") -> bool:
    """必須の欄。無い・null・空の文字列は無いのと同じ。path は欄の名前の頭（"nodes[0]" など）。"""
    if not isinstance(d, dict):
        problems.append(f"{where}: {path or 'ファイルの中身'} の型が違う（辞書）")
        return False
    ok = True
    for k in keys:
        if _absent(d.get(k)):
            problems.append(f"{where}: {f'{path}.{k}' if path else k} がありません")
            ok = False
    return ok


def _absent(v) -> bool:
    return v is None or (isinstance(v, str) and v == "")


# ---- 欄の値の型（仕様書の各型の節の書き方）。型が違えば中身の判定に進まず、その欄を示して止める

def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


T_STR = ("文字列", lambda v: isinstance(v, str))
T_INT = ("整数", _is_int)
T_NUM = ("数", lambda v: _is_number(v))
T_BOOL = ("真偽", lambda v: isinstance(v, bool))
T_ID = ("文字列か整数", lambda v: isinstance(v, str) or _is_int(v))
T_NUM_STR = ("数か文字列", lambda v: isinstance(v, str) or _is_number(v))
T_CELL = ("[行, 列] の整数 2 つ", lambda v: isinstance(v, list) and len(v) == 2 and all(_is_int(x) for x in v))
T_ANY = ("", lambda v: True)


class _Dict:
    """辞書の欄。fields は 欄の名前 → (型, 必須か)。必須でない欄は無い・null なら見ない。
    決められた語から選ぶ欄（type・kind・shape など）と icon は、語の門が値ごと判定するのでここに書かない。
    個別の文言がある欄（項目の label・y・whole・axis.label など）は必須にせず、その判定に任せる。"""
    def __init__(self, fields):
        self.fields = fields


class _List:
    """配列の欄。item が真なら仕様書の「項目の配列」で、配列でないときの文言が `<配列名> は配列` になる。"""
    def __init__(self, elem, item=False):
        self.elem, self.item = elem, item


def _check_shape(v, spec, path, where, problems) -> None:
    if isinstance(spec, _Dict):
        if not isinstance(v, dict):
            problems.append(f"{where}: {path} の型が違う（辞書）")
            return
        for k, (sub, required) in spec.fields.items():
            x = v.get(k)
            p = f"{path}.{k}" if path else k
            if _absent(x):
                if required:
                    problems.append(f"{where}: {p} がありません")
                continue
            _check_shape(x, sub, p, where, problems)
    elif isinstance(spec, _List):
        if not isinstance(v, list):
            problems.append(f"{where}: {path} は配列" if spec.item else f"{where}: {path} の型が違う（配列）")
            return
        for i, x in enumerate(v):
            _check_shape(x, spec.elem, f"{path}[{i}]", where, problems)
    else:
        name, ok = spec
        if not ok(v):
            # 数か文字列の欄に有限でない数が来たのは、数として型が違う
            if name == T_NUM_STR[0] and _non_finite(v):
                name = T_NUM[0]
            problems.append(f"{where}: {path} の型が違う（{name}）")


# 整数の欄（figures[].id・nodes[] の row／col・brackets[] の from／to・matrix の emphasis の行・列）の上限
INT_MAX = 10000


def _show(v) -> str:
    """理由の文に入れる値の repr。長い値は頭だけにする。"""
    try:
        s = repr(v)
    except ValueError:
        s = f"<{type(v).__name__}>"
    return s if len(s) <= 40 else s[:37] + "..."


# @implements REQ-440
def _check_range(v, name, where, problems, lo=0) -> bool:
    """整数の欄の値が lo〜INT_MAX の内か。外ならその欄と値を示す。"""
    if lo <= v <= INT_MAX:
        return True
    problems.append(f"{where}: {name} の値 {_show(v)} が範囲（{lo}〜{INT_MAX}）の外")
    return False


_ITEM = {"label": (T_STR, False), "emphasis": (T_BOOL, False)}
_STAGES = _List(_Dict({**_ITEM, "next_label": (T_STR, False)}), item=True)

# 図の一番上の階層の id・type・caption・after は load と validate_figure が見る
FIGURE_SHAPES = {
    "blocks": _Dict({
        "nodes": (_List(_Dict({"id": (T_ID, True), "label": (T_STR, True), "row": (T_INT, True),
                               "col": (T_INT, True), "emphasis": (T_BOOL, False)}), item=True), True),
        "edges": (_List(_Dict({"from": (T_ID, True), "to": (T_ID, True), "label": (T_STR, False)}),
                        item=True), False),
    }),
    "sequence": _Dict({
        "actors": (_List(_Dict({"id": (T_ID, True), "label": (T_STR, True)}), item=True), True),
        "steps": (_List(_Dict({"from": (T_ID, True), "to": (T_ID, True), "label": (T_STR, True),
                               "note": (T_STR, False)}), item=True), True),
    }),
    "matrix": _Dict({
        "x": (_Dict({"label": (T_STR, True), "values": (_List(T_STR), True)}), True),
        "y": (_Dict({"label": (T_STR, True), "values": (_List(T_STR), True)}), True),
        "cells": (_List(_List(T_STR)), True),
        "emphasis": (_List(T_CELL), False),
    }),
    "chart": _Dict({
        "x": (_Dict({"label": (T_STR, True), "values": (_List(T_NUM_STR), True)}), True),
        "y": (_Dict({"label": (T_STR, False), "min": (T_NUM, False), "max": (T_NUM, False)}), False),
        "series": (_List(_Dict({"label": (T_STR, True), "values": (_List(T_ANY), True),
                                "emphasis": (T_BOOL, False)}), item=True), True),
        "vlines": (_List(_Dict({"x": (T_NUM_STR, True), "label": (T_STR, False)})), False),
        "annotations": (_List(_Dict({"x": (T_NUM_STR, True), "y": (T_NUM, True),
                                     "text": (T_STR, True)})), False),
    }),
    "steps": _Dict({"stages": (_STAGES, True)}),
    "cycle": _Dict({"stages": (_STAGES, True), "center": (T_STR, False)}),
    "layers": _Dict({
        "layers": (_List(_Dict({**_ITEM, "note": (T_STR, False)}), item=True), True),
        "brackets": (_List(_Dict({"from": (T_INT, True), "to": (T_INT, True),
                                  "label": (T_STR, False)})), False),
    }),
    "parts": _Dict({
        "whole": (_Dict({"label": (T_STR, False)}), False),
        "parts": (_List(_Dict(_ITEM), item=True), True),
    }),
    "timeline": _Dict({
        "axis": (_Dict({"label": (T_STR, False), "ticks": (_List(T_STR), True)}), True),
        "events": (_List(_Dict({**_ITEM, "at": (T_NUM, False), "from": (T_NUM, False),
                                "to": (T_NUM, False)}), item=True), True),
    }),
    "venn": _Dict({
        "universe": (T_STR, False),
        "sets": (_List(_Dict({"id": (T_ID, True), "label": (T_STR, True)}), item=True), True),
        "regions": (_List(_Dict({**_ITEM, "in": (_List(T_ID), True)}), item=True), True),
    }),
}


CAPTION_POLITE = re.compile(r"(です|ます|ません|でしょう|ました)[。）)]*$")
CAPTION_BANNED = re.compile(r"誤答|選択肢|正解(?!率)|問\d|\d+年度|令和|平成|引っかけ|[\^²³]|[，．]")
FIGURE_BANNED = re.compile(r"誤答|正解(?!率)|（正）|（誤）|問\d+|\d+年度|令和|平成|引っかけ|[\^²³]|[，．]")


def _figure_texts(fig) -> list:
    """図の中身の文字列（ラベル・セル・注釈・note）を平らに集める。禁止語の検査に使う。"""
    out = []
    def walk(v):
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, dict):
            for k, x in v.items():
                if k in ("caption", "after", "type", "id", "kind", "shape", "style", "arrow", "color",
                         "direction", "layout", "icon", "in"):
                    continue
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk({k: v for k, v in fig.items() if k not in ("caption", "after")})
    return out


ICON_PLACES = "blocks・sequence・steps・cycle・layers・parts"

# 5〜10 の型の項目の配列・項目の呼び名・項目の数の門（数える配列, 下限, 上限, 文言の頭）
ITEM_ARRAYS = {"steps": ("stages", "段"), "cycle": ("stages", "段"), "layers": ("layers", "層"),
               "parts": ("parts", "部位"), "timeline": ("events", "出来事"), "venn": ("regions", "領域")}
ITEM_COUNTS = {"steps": ("stages", 3, 6, "steps の段は 3〜6"),
               "cycle": ("stages", 3, 6, "cycle の段は 3〜6"),
               "layers": ("layers", 2, 7, "layers の層は 2〜7"),
               "parts": ("parts", 3, 8, "parts の部位は 3〜8"),
               "timeline": ("events", 3, 8, "timeline の出来事は 3〜8"),
               "venn": ("sets", 2, 3, "venn の範囲は 2〜3")}


# 絵記号を置ける 7 か所（型ごとの、図の直下の鍵。配列なら各要素、whole はその辞書）
ICON_ALLOWED = {"blocks": ("nodes",), "sequence": ("actors",), "steps": ("stages",),
                "cycle": ("stages",), "layers": ("layers",), "parts": ("parts", "whole")}


# @implements REQ-440
def _check_icons(fig, t, where, problems) -> None:
    """絵の語彙の門。図の JSON を全部たどり、置ける 7 か所では語彙に無い名前を、
    それ以外のどこか（図の一番上の階層・入れ子の奥を含む）では icon があること自体を止める。"""
    allowed_keys = ICON_ALLOWED.get(t, ())

    def place_of(path) -> str:
        s = ""
        for p in path:
            s += f"[{p}]" if isinstance(p, int) else (f".{p}" if s else p)
        return s or "図の一番上の階層"

    def allowed(path, obj) -> bool:
        if len(path) == 1 and path[0] == "whole":
            return "whole" in allowed_keys and obj is fig.get("whole")
        return (len(path) == 2 and path[0] in allowed_keys and path[0] != "whole"
                and isinstance(path[1], int))

    def walk(v, path) -> None:
        if isinstance(v, dict):
            if "icon" in v:
                place = place_of(path)
                if not allowed(path, v):
                    problems.append(f"{where}: {place} に icon は置けない（置けるのは {ICON_PLACES}）")
                elif v["icon"] not in ICON_NAMES:
                    problems.append(f"{where}: {place} の未知の icon {v['icon']!r}"
                                    f"（絵の語彙 {'/'.join(ICON_NAMES)} のいずれか）")
            for k, x in v.items():
                if k != "icon":
                    walk(x, path + [k])
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, path + [i])

    walk(fig, [])


def _blank(v) -> bool:
    return v is None or not str(v).strip()


def _first_line(item) -> str:
    lb = item.get("label") if isinstance(item, dict) else None
    return "" if lb is None else _lines_of(str(lb).strip())[0]


def _check_items(items, arr, noun, where, problems) -> None:
    """項目（段・層・部位・出来事・領域）は「名前＋一言」を 2〜3 行で書く。"""
    labels = []
    # @implements REQ-440
    for i, it in enumerate(items):
        lb = it.get("label") if isinstance(it, dict) else None
        s = "" if lb is None else str(lb)
        if not s.strip():
            problems.append(f"{where}: {arr}[{i}] に label が無い")
        else:
            k = len(s.strip().split("\n"))
            if k >= 4:
                problems.append(f"{where}: {arr}[{i}] の label が {k} 行（3 行まで）")
        labels.append(s)
    # 1 行だけの項目が全項目の半分を超えればエラー（blocks の箱と同じ判定）
    # @implements REQ-438
    one_line = [s for s in labels if "\n" not in s.strip()]
    if labels and len(one_line) * 2 > len(labels):
        problems.append(f"{where}: 1 行だけ（名前だけ）の{noun}が {len(one_line)}/{len(labels)} 個で半分を超える"
                        f"（{noun}は「名前＋一言」を \\n で 2 行以上に）")


def _check_next_labels(stages, cyclic, where, problems) -> None:
    """段の間の矢印のラベル。cycle は最後の段の先が最初の段、steps は最後の段に書かない。"""
    k = len(stages)
    for i, s in enumerate(stages):
        nl = s.get("next_label") if isinstance(s, dict) else None
        # @implements REQ-440
        if i == k - 1 and not cyclic:
            if not _blank(nl):
                problems.append(f"{where}: 最後の段 stages[{i}] に next_label がある（矢印の先の段が無い）")
            continue
        # 段の間の矢印は何を渡すか・何が起きるかを運ぶ（blocks の線と同じ判定）
        # @implements REQ-438
        if _blank(nl):
            nxt = stages[(i + 1) % k]
            problems.append(f"{where}: stages[{i}]（{_first_line(s)}→{_first_line(nxt)}）に next_label が無い"
                            "（段の間には何を渡すか／何が起きるかを書く）")


# @implements REQ-440
def _validate_item_type(fig, t, where, problems) -> None:
    """5〜10 の型（steps・cycle・layers・parts・timeline・venn）の中身の門。"""
    arr, noun = ITEM_ARRAYS[t]
    items = fig[arr]
    c_arr, lo, hi, head = ITEM_COUNTS[t]
    counted = fig[c_arr]
    if not lo <= len(counted) <= hi:
        problems.append(f"{where}: {head}（今は {len(counted)}）")
    _check_items(items, arr, noun, where, problems)

    if t in ("steps", "cycle"):
        _check_next_labels(items, t == "cycle", where, problems)
        if t == "steps" and fig.get("direction") not in ("up", "down"):
            problems.append(f"{where}: 未知の direction {fig.get('direction')!r}（up/down）")

    elif t == "layers":
        if fig.get("shape", "stack") not in ("stack", "pyramid"):
            problems.append(f"{where}: 未知の shape {fig.get('shape')!r}（stack/pyramid）")
        taken = []
        for i, b in enumerate(fig.get("brackets") or []):
            if _blank(b.get("label")):
                problems.append(f"{where}: brackets[{i}] に label が無い")
            f, to = b.get("from"), b.get("to")
            _check_range(f, f"brackets[{i}].from", where, problems)
            _check_range(to, f"brackets[{i}].to", where, problems)
            valid = (isinstance(f, int) and isinstance(to, int) and not isinstance(f, bool)
                     and not isinstance(to, bool) and 0 <= f <= to < len(items))
            if valid and any(f <= t1 and t0 <= to for t0, t1 in taken):
                valid = False
            if not valid:
                problems.append(f"{where}: brackets[{i}] の範囲 {f}〜{to} が不正"
                                "（層の位置の内で from ≤ to、括弧どうしは重ねない）")
            else:
                taken.append((f, to))

    elif t == "parts":
        if _blank((fig.get("whole") or {}).get("label")):
            problems.append(f"{where}: whole の label が無い（分解する物の名前を書く）")

    elif t == "timeline":
        axis = fig["axis"]
        if _blank(axis.get("label")):
            problems.append(f"{where}: axis の label が無い（軸の名前を書く）")
        ticks = axis["ticks"]
        if not 2 <= len(ticks) <= 12:
            problems.append(f"{where}: axis.ticks は 2〜12（今は {len(ticks)}）")
        last = len(ticks) - 1
        for i, e in enumerate(items):
            has_at = "at" in e
            has_from, has_to = "from" in e, "to" in e
            if has_at == (has_from or has_to) or (has_from != has_to):
                problems.append(f"{where}: events[{i}] は at か from／to のどちらか一方だけを持つ")
                continue
            vals = [e["at"]] if has_at else [e["from"], e["to"]]
            ok = all(_is_number(v) and 0 <= v <= last for v in vals)
            if ok and not has_at and not e["from"] < e["to"]:
                ok = False
            if not ok:
                problems.append(f"{where}: events[{i}] の位置が範囲外（0〜ticks の個数 −1、期間は from < to）")

    elif t == "venn":
        layout = fig.get("layout")
        if layout not in ("overlap", "nested"):
            problems.append(f"{where}: 未知の layout {layout!r}（overlap/nested）")
        ids = []
        for s in counted:
            if s["id"] in ids:
                problems.append(f"{where}: sets の id {s['id']!r} が重複する（範囲の id は図の中で一意）")
            ids.append(s["id"])
        combos = []
        for i, r in enumerate(items):
            got = r["in"]
            # in は集合として比べる（書く順は問わない）。同じ id を 2 回書くのはエラー
            if len(got) != len(set(map(repr, got))):
                problems.append(f"{where}: regions[{i}].in に同じ id がある（in は範囲の id を 1 回ずつ書く）")
            bad = [x for x in got if x not in ids]
            for x in bad:
                problems.append(f"{where}: regions[{i}] の in の {x!r} が sets にない")
            if not bad:
                combos.append(frozenset(got))
        if layout in ("overlap", "nested") and len(ids) == len(counted) and 2 <= len(ids) <= 3:
            if layout == "overlap":
                need = {frozenset(ids[j] for j in range(len(ids)) if mask >> j & 1)
                        for mask in range(1, 2 ** len(ids))}
            else:
                need = {frozenset(ids[:j]) for j in range(1, len(ids) + 1)}
            allowed = need | ({frozenset()} if fig.get("universe") else set())

            def show(c):
                return json.dumps([x for x in ids if x in c], ensure_ascii=False)
            seen, dup = set(), []
            for c in combos:
                if c in seen and c not in dup:
                    dup.append(c)
                seen.add(c)
            missing = sorted((c for c in need if c not in seen), key=show)
            misplaced = [c for c in dict.fromkeys(combos) if c not in allowed]
            parts = []
            if missing:
                parts.append("欠け: " + "、".join(show(c) for c in missing))
            if dup:
                parts.append("重複: " + "、".join(show(c) for c in dup))
            if misplaced:
                parts.append("置けない並び: " + "、".join(show(c) for c in misplaced))
            if parts:
                problems.append(f"{where}: regions が layout に合わない（{'／'.join(parts)}）")


# @implements REQ-433, REQ-438, REQ-439, REQ-440
def validate_figure(fig, where, problems, warnings=None) -> None:
    """problems はエラー（描かずに止める）、warnings は警告（出すだけ）。
    判定の文は scripts/prompts/material_figures_spec.md の「図だけで分かること」と揃える。"""
    if warnings is None:
        warnings = []
    cap = fig.get("caption")
    if not isinstance(cap, str) or not cap.strip():
        # @implements REQ-433
        problems.append(f"{where}: caption が無いか、空か空白だけか、文字列でない（この図は描かない）")
    else:
        cap = cap.strip()
        # caption は敬体で、答え・誤答の否定・選択肢の記号・回と問番号を書かない
        if not CAPTION_POLITE.search(cap):
            problems.append(f"{where}: caption の文末が敬体（です・ます）でない: {cap[-20:]!r}")
        if CAPTION_BANNED.search(cap):
            problems.append(f"{where}: caption に答え・誤答・選択肢・問の名指しか禁止記法（^ 上付き ，．）: {cap[:40]!r}")
    after = fig.get("after")
    if after is None or (isinstance(after, str) and not after.strip()):
        problems.append(f"{where}: after がありません")
    elif not isinstance(after, str):
        problems.append(f"{where}: after の型が違う（文字列）")
    for txt in _figure_texts(fig):
        if FIGURE_BANNED.search(txt):
            problems.append(f"{where}: 図の中身に誤答の否定・正誤の印・問の名指しか禁止記法: {txt[:40]!r}")
    # 型そのものと、必須の欄・欄の値の型・blocks・sequence・matrix・chart の形
    # @implements REQ-440
    t = fig.get("type")
    if t not in FIGURE_TYPES:
        problems.append(f"{where}: 未知の type {t!r}（{'/'.join(FIGURE_TYPES)} のいずれか）")
        return
    _check_icons(fig, t, where, problems)
    # 欄が無い・型が違う図は中身の判定に進まない（中身の判定は欄の型が書き方どおりであることを前提にする）
    before = len(problems)
    _check_shape(fig, FIGURE_SHAPES[t], "", where, problems)
    if len(problems) > before:
        return

    if t == "blocks":
        ids = []
        for i, nd in enumerate(fig["nodes"]):
            if nd["id"] in ids:
                problems.append(f"{where}: nodes の id {nd['id']!r} が重複する（箱の id は図の中で一意）")
            ids.append(nd["id"])
            for k in ("row", "col"):
                _check_range(nd[k], f"nodes[{i}].{k}", where, problems)
            if nd.get("shape", "box") not in ("box", "round", "cylinder", "cloud"):
                problems.append(f"{where}: nodes[{i}] の未知の shape {nd.get('shape')!r}（box/round/cylinder/cloud）")
        edges = fig.get("edges") or []
        for i, e in enumerate(edges):
            for side in ("from", "to"):
                if e[side] not in ids:
                    problems.append(f"{where}: edges[{i}] の {side} の {e[side]!r} が nodes にない")
            if e.get("style", "solid") not in ("solid", "dashed"):
                problems.append(f"{where}: edges[{i}] の未知の style {e.get('style')!r}（solid/dashed）")
            if e.get("arrow", "to") not in ("to", "both", "none"):
                problems.append(f"{where}: edges[{i}] の未知の arrow {e.get('arrow')!r}（to/both/none）")
            # 線は何が流れるか・何が起きるか・どの条件で移るかを運ぶ（arrow: none の線と自己ループも同じ）
            # @implements REQ-438
            if not (e.get("label") or "").strip():
                problems.append(f"{where}: edges[{i}]（{e['from']}→{e['to']}）に label が無い"
                                "（線には何が流れるか／何が起きるか／どの条件で移るかを書く）")
        # 箱は「名前＋一言」。1 行だけの箱が全ノードの半分を超えればエラー
        # @implements REQ-438
        labels = [nd["label"] for nd in fig["nodes"]]
        one_line = [l for l in labels if "\n" not in l.strip()]
        if labels and len(one_line) * 2 > len(labels):
            problems.append(f"{where}: 1 行だけ（名前だけ）の箱が {len(one_line)}/{len(labels)} 個で半分を超える"
                            "（箱は「名前＋一言」を \\n で 2 行以上に）")
        # 小さすぎる blocks は描くが、警告として作り手に示す（main が stderr に出し、件数を集計行に出す）
        # @implements REQ-439
        n_edges = len(edges)
        if len(labels) <= 3 and n_edges <= 2:
            warnings.append(f"{where}: ノード {len(labels)} 個・線 {n_edges} 本の blocks"
                            "（本文の 1 文で足りる疑い。閉じた図のテストに通るか見直す）")

    elif t == "sequence":
        ids = []
        for a in fig["actors"]:
            if a["id"] in ids:
                problems.append(f"{where}: actors の id {a['id']!r} が重複する（登場人物の id は図の中で一意）")
            ids.append(a["id"])
        if not 2 <= len(fig["actors"]) <= 4:
            problems.append(f"{where}: sequence の登場人物は 2〜4（今は {len(fig['actors'])}）")
        for i, s in enumerate(fig["steps"]):
            for side in ("from", "to"):
                if s[side] not in ids:
                    problems.append(f"{where}: steps[{i}] の {side} の {s[side]!r} が actors にない")

    elif t == "matrix":
        xs, ys, cells = fig["x"]["values"], fig["y"]["values"], fig["cells"]
        if not (2 <= len(xs) <= 3 and 2 <= len(ys) <= 3):
            problems.append(f"{where}: 行 {len(ys)} × 列 {len(xs)}（2〜3 × 2〜3）")
        if len(cells) != len(ys) or any(len(row) != len(xs) for row in cells):
            problems.append(f"{where}: cells の大きさが y.values × x.values（行 {len(ys)} × 列 {len(xs)}）と違う")
        for i, (r, c) in enumerate(fig.get("emphasis") or []):
            _check_range(r, f"emphasis[{i}][0]", where, problems)
            _check_range(c, f"emphasis[{i}][1]", where, problems)
            if not (0 <= r < len(ys) and 0 <= c < len(xs)):
                problems.append(f"{where}: emphasis[{i}] の [行, 列] が cells の外（行 {len(ys)} × 列 {len(xs)}）")

    elif t == "chart":
        # kind は必須。欄が無いのも未知の kind として止める
        if fig.get("kind") not in ("line", "bar", "step"):
            problems.append(f"{where}: 未知の kind {fig.get('kind')!r}（line/bar/step）")
        series = fig["series"]
        if len(series) > 3:
            problems.append(f"{where}: chart の系列は 3 本まで（今は {len(series)}）")
        elif not series:
            problems.append(f"{where}: chart の系列が無い（今は 0）")
        # y の欄が無いのも縦軸の名前が無いとして止める
        if _blank((fig.get("y") or {}).get("label")):
            problems.append(f"{where}: y の label が無い（縦軸の名前を書く）")
        xs = fig["x"]["values"]
        if len(xs) < 2:
            problems.append(f"{where}: x.values は 2 個以上（今は {len(xs)}）")
        for i, s in enumerate(series):
            if len(s["values"]) != len(xs):
                problems.append(f"{where}: series[{i}] の values は x.values と同じ {len(xs)} 個"
                                f"（今は {len(s['values'])}）")
            # 無限大・NaN は数の型の違い、文字列・null・真偽値などは数値でない物として示す
            for j, v in enumerate(s["values"]):
                if _non_finite(v):
                    problems.append(f"{where}: series[{i}].values[{j}] の型が違う（数）")
            if any(not _is_number(v) and not _non_finite(v) for v in s["values"]):
                problems.append(f"{where}: series[{i}] の values に数値でない物がある")
        # x.values がすべて数なら数値軸、それ以外はカテゴリ軸
        numeric_x = bool(xs) and all(_is_number(v) for v in xs)
        for arr in ("vlines", "annotations"):
            for i, v in enumerate(fig.get(arr) or []):
                x = v["x"]
                if numeric_x:
                    if not (_is_number(x) and min(xs) <= x <= max(xs)):
                        problems.append(f"{where}: {arr}[{i}] の x {x!r} が軸の範囲"
                                        f"（{_fmt_num(min(xs))}〜{_fmt_num(max(xs))}）の外")
                elif x not in xs:
                    problems.append(f"{where}: {arr}[{i}] の x {x!r} が x.values にない")

    else:
        _validate_item_type(fig, t, where, problems)


# 論点のファイルの入れ子の深さの上限（いちばん外の辞書を 1 段と数える）。図の仕様書の形は 10 段に届かない。
# JSON を読む部品が深い入れ子を読めるかは Python の版で違い、読めても後の形の検査（入れ子をたどる）が版ごとに違う所で
# RecursionError になるので、読んだ直後にこの上限で切り、どの版でも「入れ子が深すぎる」として JSON が読めない側に落とす。
MAX_JSON_DEPTH = 100


def _json_depth_over(doc, limit: int) -> bool:
    """doc の入れ子の深さが limit を超えるか。入れ子をたどるのに再帰を使わない（深い入れ子でも例外にならない）。"""
    stack = [(doc, 1)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, dict):
            children = node.values()
        elif isinstance(node, list):
            children = node
        else:
            continue
        if depth > limit:
            return True
        stack.extend((c, depth + 1) for c in children)
    return False


def _read_json(p):
    """JSON のファイルを読む。読めない（通常のファイルでない・OS の段で開けない・壊れている・入れ子が深すぎる・
    文字コードが違う・桁が多すぎる）ときは (None, 理由) を返す。入れ子が深すぎるかは MAX_JSON_DEPTH で決める。"""
    try:
        # ディレクトリや名前付きパイプは開くと例外になるか読み込みが止まるので、開く前に通常のファイルか見る
        if not stat.S_ISREG(p.stat().st_mode):
            return None, "通常のファイルでない"
        doc = json.loads(p.read_text(encoding="utf-8"))
        if _json_depth_over(doc, MAX_JSON_DEPTH):
            return None, "入れ子が深すぎる"
        return doc, None
    except RecursionError:
        return None, "入れ子が深すぎる"
    except (OSError, ValueError, OverflowError) as e:
        # OSError は無い先を指すリンク・ループするリンク・権限・ディレクトリ、ValueError は UnicodeDecodeError を含む
        return None, f"{type(e).__name__}: {str(e)[:120]}"


# 欄の型が書き方と違う値が、型の門で見落とした形で計算に届いたときに出る例外（最後の砦で受け止める）
FIGURE_ERRORS = (TypeError, AttributeError, KeyError, IndexError, ValueError, OverflowError,
                 RecursionError, ZeroDivisionError)


def load(paths, problems, warnings=None) -> list:
    docs, seen = [], {}
    for p in paths:
        doc, why = _read_json(p)
        if why is not None:
            problems.append(f"[{p.name}]: JSON が読めません（{why}）")
            continue
        where = f"[{p.name}]"
        if not _need(doc, ["topic_id", "term", "figures"], where, problems):
            continue
        tid = doc["topic_id"]
        if not _is_int(tid):
            problems.append(f"{where}: topic_id の型が違う（整数）")
            continue
        if not isinstance(doc["term"], str):
            problems.append(f"{where}: term の型が違う（文字列）")
        if not isinstance(doc["figures"], list):
            problems.append(f"{where}: figures の型が違う（配列）")
            continue
        if tid in seen:
            problems.append(f"{where}: 論点 {tid} は {seen[tid]} にもあります（1論点1ファイル）")
        seen[tid] = p.name
        fids = []
        for i, fig in enumerate(doc["figures"]):
            if not isinstance(fig, dict):
                problems.append(f"[{p.name}] 論点 {tid} 図 #{i}: figures[{i}] の型が違う（辞書）")
                continue
            fid = fig.get("id")
            shown = fid if _is_int(fid) and -INT_MAX <= fid <= INT_MAX else (f'#{i}' if fid is None else _show(fid))
            w = f"[{p.name}] 論点 {tid} 図 {shown}"
            if fid is None:
                problems.append(f"{w}: id がありません")
            elif not _is_int(fid):
                problems.append(f"{w}: figures の id {_show(fid)} は 1 始まりの整数")
            else:
                if fid < 1:
                    problems.append(f"{w}: figures の id {fid!r} は 1 始まりの整数")
                if _check_range(fid, "figures の id", w, problems, lo=1):
                    if fid in fids:
                        problems.append(f"{w}: figures の id {fid} が重複する（id はファイル内で一意）")
                    fids.append(fid)
            # 欄の型は validate_figure が先に見るが、見落とした形で例外になっても traceback で落とさず、
            # その図の欄の型の違いとして示して止める
            try:
                validate_figure(fig, w, problems, warnings)
            except FIGURE_ERRORS as e:
                problems.append(f"{w}: 欄の型が違う（各型の節の書き方と照らす。{type(e).__name__}: {str(e)[:120]}）")
        docs.append((p, doc))
    return docs


def _topic_id_of(path):
    """(論点 ID か None, 読めない理由か None)。読めないファイルは論点が分からない。"""
    doc, why = _read_json(path)
    tid = doc.get("topic_id") if isinstance(doc, dict) else None
    return (tid if _is_int(tid) else None), why


# @implements REQ-471
def after_headings(data: Path) -> dict:
    """論点 ID → 配る本文と同じ選び方で選んだ教材の detail にある `### ` の見出しの集合。教材の世代が読めなければ空。"""
    try:
        chosen = select_materials(data)
        return {tid: {l.strip() for l in (c.material.get("detail") or "").split("\n") if l.strip().startswith("### ")}
                for tid, c in chosen.items()}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError):
        return {}


# ---------------------------------------------------------------- 実行

# @operation UC-027#checkFigureSpecs
# @implements REQ-487
def main() -> int:
    ap = argparse.ArgumentParser(description="教材の図を仕様 JSON から SVG に描く")
    ap.add_argument("--data", default="data/ap", type=Path,
                    help="試験のデータディレクトリ。試験IDはこの名前から採る")
    ap.add_argument("--out", type=Path, default=None,
                    help="既定 public/figures/materials/<試験>")
    ap.add_argument("--only", nargs="*", type=int, default=None, help="論点IDで絞る")
    ap.add_argument("--samples", action="store_true",
                    help="material_figures/_samples/ を対象にする")
    ap.add_argument("--png-dir", type=Path, default=None, help="目視確認用に PNG も書く")
    ap.add_argument("--dpi", type=int, default=144)
    ap.add_argument("--check", action="store_true", help="描かずに検証だけ")
    args = ap.parse_args()

    exam = args.data.name
    refusal = learning_refusal(args.data, registered=False)
    if refusal:
        return emit_refusal(refusal)
    src = args.data / "material_figures"
    if args.samples:
        src = src / "_samples"
    if not src.is_dir():
        sys.exit(f"{src} がありません")

    # `_` 始まりのファイル・ディレクトリは本番の入力に含めない
    paths = sorted(p for p in src.glob("*.json") if not p.name.startswith("_"))
    if not paths:
        # 図がまだ1つも無いのは異常ではない（取り込みの途中では普通）。
        # 取り違えを防ぐのはディレクトリの存在確認のほうなので、ここは 0 で返す
        print(f"{src} に *.json がありません（図はまだありません）")
        return 0
    # --only のときは絞った論点のファイルだけを判定する（他の論点のエラーで描けなくならない）。
    # 読めないファイルは論点が分からず絞った外と言えないので、残して load が JSON が読めないエラーとして止める
    # @implements REQ-438
    if args.only is not None:
        kept = []
        for p in paths:
            tid, why = _topic_id_of(p)
            if why is not None or tid in args.only:
                kept.append(p)
        paths = kept

    problems: list = []
    warnings: list = []
    docs = load(paths, problems, warnings)
    # after の見出しが、配る本文と同じ選び方で選んだ教材に実在するか。無いと attach は差し込み位置どおりに置けない
    heads = after_headings(args.data)
    for p, d in docs:
        for fig in d["figures"]:
            if not isinstance(fig, dict):
                continue
            a = str(fig.get("after", "")).strip()
            if a and a != "explanation" and d.get("topic_id") in heads and a not in heads[d["topic_id"]]:
                problems.append(f"[{p.name}] 論点 {d['topic_id']} 図 {fig.get('id')}: after {a!r} が教材に無い")

    for w in warnings:
        print(f"  - 警告: {w}", file=sys.stderr)

    if args.check:
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(f"\n{len(paths)} ファイル / "
              f"{sum(len(d.get('figures', [])) for _, d in docs)} 図を検証しました（警告 {len(warnings)} 件）", file=sys.stderr)
        if problems:
            print(f"問題 {len(problems)} 件", file=sys.stderr)
        else:
            print("問題なし", file=sys.stderr)
        print(json.dumps({"exitCode": 1 if problems else 0, "findings": problems}, ensure_ascii=False))
        return 1 if problems else 0

    if problems:
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(f"\n問題 {len(problems)} 件。描画しません。", file=sys.stderr)
        return 1

    out_dir = args.out or Path("public/figures/materials") / exam
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.png_dir:
        args.png_dir.mkdir(parents=True, exist_ok=True)

    # 全部の図を描き終えてから書き出す。描く途中で例外になった図があれば、traceback でなく
    # その論点・図・理由を示して 1 枚も書かずに止める
    # @implements REQ-440
    rendered, failed = [], []
    for p, doc in docs:
        for fig in doc["figures"]:
            try:
                rendered.append((f"{doc['topic_id']}-{fig['id']}", fig, render(fig)))
            except FIGURE_ERRORS as e:
                failed.append(f"[{p.name}] 論点 {doc['topic_id']} 図 {_show(fig.get('id'))}: "
                              f"描けません（{type(e).__name__}: {str(e)[:120]}）")
    if failed:
        for f in failed:
            print(f"  - {f}", file=sys.stderr)
        print(f"\n問題 {len(failed)} 件。描画しません。", file=sys.stderr)
        return 1

    written = []
    for name, fig, svg in rendered:
        dest = out_dir / f"{name}.svg"
        dest.write_text(svg, encoding="utf-8")
        written.append((name, fig["type"], len(svg)))
        if args.png_dir:
            try:
                import fitz  # PyMuPDF
            except ImportError:
                sys.exit("PNG 化には PyMuPDF が必要です:  pip install pymupdf")
            with fitz.open(str(dest)) as d:
                d[0].get_pixmap(dpi=args.dpi).save(str(args.png_dir / f"{name}.png"))

    for name, t, size in written:
        print(f"  {name:<12} {t:<9} {size:>6} B")
    print(f"\n{len(written)} 枚を {out_dir} に書き出しました")
    if args.png_dir:
        print(f"PNG: {args.png_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
