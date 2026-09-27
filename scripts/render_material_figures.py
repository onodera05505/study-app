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

型は 4 つだけ（`blocks` / `sequence` / `matrix` / `chart`）。増やさない。
型が増えるほど担当が迷い、様式がばらつくのを避けるための制約。
書き方は `scripts/prompts/material_figures_spec.md` にまとめてある。

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
import sys
from pathlib import Path

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

FIGURE_TYPES = ("blocks", "sequence", "matrix", "chart")
SERIES_COLORS = (ACCENT, INK, "#9ca3af")
# emphasis の系列があるときは、そこだけを強調色にして他は無彩色にする
# （既定の1本目も強調色なので、そのままだと同じ色の系列が2本できる）
SERIES_COLORS_EMPH = (INK, "#6b7280", "#9ca3af")


# ---------------------------------------------------------------- 文字幅の見積もり

def char_width(ch: str, size: float) -> float:
    """1文字の幅。日本語は全角、英数字・記号は半角として見積もる。"""
    return size * 0.55 if ord(ch) < 0x2E80 else size * 1.0


def text_width(s: str, size: float) -> float:
    return sum(char_width(c, size) for c in str(s))


def lines_of(label: str) -> list:
    """`\\n` の明示だけで改行する（自動折り返しはしない）。"""
    return str(label).split("\n")


def block_width(label: str, size: float = FS_BODY) -> float:
    return max(text_width(ln, size) for ln in lines_of(label))


def wrap(s: str, size: float, max_w: float) -> list:
    """caption 用の折り返し。英単語の途中では割らない。"""
    tokens, buf = [], ""
    for ch in str(s):
        if ch.isascii() and not ch.isspace():
            buf += ch
            continue
        if buf:
            tokens.append(buf)
            buf = ""
        tokens.append(ch)
    if buf:
        tokens.append(buf)

    out, cur, cur_w = [], "", 0.0
    for t in tokens:
        w = text_width(t, size)
        if cur and cur_w + w > max_w and t != " ":
            out.append(cur.rstrip())
            cur, cur_w = "", 0.0
        if not cur and t == " ":
            continue
        cur += t
        cur_w += w
    if cur.strip():
        out.append(cur.rstrip())
    return out or [""]


# ---------------------------------------------------------------- SVG の部品

def esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def n(v: float) -> str:
    """座標を丸める。決定的な出力にするため必ずここを通す。"""
    r = round(float(v), 2)
    if r == int(r):
        return str(int(r))
    return f"{r:g}"


def rect(x, y, w, h, fill=CARD, stroke=INK, sw=1.0, rx=6) -> str:
    st = f' stroke="{stroke}" stroke-width="{n(sw)}"' if stroke else ""
    return (f'<rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}" '
            f'rx="{n(rx)}" fill="{fill}"{st}/>')


def line(x1, y1, x2, y2, stroke=INK, sw=1.0, dashed=False) -> str:
    d = ' stroke-dasharray="5 4"' if dashed else ""
    return (f'<line x1="{n(x1)}" y1="{n(y1)}" x2="{n(x2)}" y2="{n(y2)}" '
            f'stroke="{stroke}" stroke-width="{n(sw)}"{d}/>')


def path(d: str, stroke=INK, sw=1.0, fill="none", dashed=False) -> str:
    da = ' stroke-dasharray="5 4"' if dashed else ""
    return f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{n(sw)}"{da}/>'


def text(x, y, s, size=FS_BODY, fill=INK, anchor="middle", bold=False) -> str:
    w = ' font-weight="600"' if bold else ""
    return (f'<text x="{n(x)}" y="{n(y)}" font-family="{FONT}" font-size="{n(size)}" '
            f'fill="{fill}" text-anchor="{anchor}"{w}>{esc(s)}</text>')


def text_block(cx, cy, label, size=FS_BODY, fill=INK, anchor="middle", bold=False,
               line_h=None) -> list:
    """複数行を (cx, cy) 中央そろえで置く。baseline は自前で計算する
    （dominant-baseline はレンダラによって効かない）。"""
    lh = line_h or (LINE_H if size >= FS_BODY else LINE_H_S)
    ls = lines_of(label)
    top = cy - lh * len(ls) / 2
    return [text(cx, top + lh * i + lh / 2 + size * 0.35, ln, size, fill, anchor, bold)
            for i, ln in enumerate(ls)]


def label_on_line(cx, cy, s, size=FS_SMALL, fill=INK) -> list:
    """線の上に置くラベル。白い下地を敷いて線を隠す。"""
    w = text_width(s, size) + 8
    return [rect(cx - w / 2, cy - size * 0.75, w, size + 4, fill=CARD, stroke=None, rx=3),
            text(cx, cy + size * 0.35, s, size, fill)]


def arrow_head(x, y, dx, dy, fill=INK, length=8.0, half=3.6) -> str:
    """(x, y) を先端とする矢じり。(dx, dy) は進行方向。"""
    d = math.hypot(dx, dy) or 1.0
    ux, uy = dx / d, dy / d
    bx, by = x - ux * length, y - uy * length
    px, py = -uy * half, ux * half
    return (f'<polygon points="{n(x)},{n(y)} {n(bx + px)},{n(by + py)} '
            f'{n(bx - px)},{n(by - py)}" fill="{fill}"/>')


def polyline(points, stroke=INK, sw=1.2, dashed=False, arrow="to") -> list:
    """折れ線＋矢じり。arrow は "to" / "both" / "none"。"""
    out = []
    pts = " ".join(f"{n(x)},{n(y)}" for x, y in points)
    da = ' stroke-dasharray="5 4"' if dashed else ""
    out.append(f'<polyline points="{pts}" fill="none" stroke="{stroke}" '
               f'stroke-width="{n(sw)}"{da} stroke-linejoin="round"/>')
    if arrow in ("to", "both"):
        (x1, y1), (x2, y2) = points[-2], points[-1]
        out.append(arrow_head(x2, y2, x2 - x1, y2 - y1, stroke))
    if arrow == "both":
        (x1, y1), (x2, y2) = points[1], points[0]
        out.append(arrow_head(x2, y2, x2 - x1, y2 - y1, stroke))
    return out


# ---------------------------------------------------------------- 箱の形

def shape(x, y, w, h, kind="box", emphasis=False) -> list:
    """4種類の箱。中身の文字は呼び出し側が置く。"""
    fill = FILL_ACCENT if emphasis else FILL_MUTED
    stroke = ACCENT if emphasis else INK
    sw = 1.8 if emphasis else 1.0

    if kind == "round":
        return [rect(x, y, w, h, fill, stroke, sw, rx=h / 2)]
    if kind == "cylinder":
        ry = min(9.0, h / 5)
        d = (f"M {n(x)} {n(y + ry)} A {n(w / 2)} {n(ry)} 0 0 0 {n(x + w)} {n(y + ry)} "
             f"L {n(x + w)} {n(y + h - ry)} "
             f"A {n(w / 2)} {n(ry)} 0 0 1 {n(x)} {n(y + h - ry)} Z")
        top = (f"M {n(x)} {n(y + ry)} A {n(w / 2)} {n(ry)} 0 0 1 {n(x + w)} {n(y + ry)}")
        return [path(d, stroke, sw, fill), path(top, stroke, sw, "none")]
    if kind == "cloud":
        d = (f"M {n(x + 0.16 * w)} {n(y + h)} "
             f"C {n(x - 0.06 * w)} {n(y + h)} {n(x - 0.04 * w)} {n(y + 0.40 * h)} "
             f"{n(x + 0.18 * w)} {n(y + 0.42 * h)} "
             f"C {n(x + 0.18 * w)} {n(y - 0.06 * h)} {n(x + 0.56 * w)} {n(y - 0.12 * h)} "
             f"{n(x + 0.60 * w)} {n(y + 0.30 * h)} "
             f"C {n(x + 0.80 * w)} {n(y + 0.10 * h)} {n(x + 1.06 * w)} {n(y + 0.30 * h)} "
             f"{n(x + 0.95 * w)} {n(y + 0.62 * h)} "
             f"C {n(x + 1.06 * w)} {n(y + 0.94 * h)} {n(x + 0.94 * w)} {n(y + h)} "
             f"{n(x + 0.82 * w)} {n(y + h)} Z")
        return [path(d, stroke, sw, fill)]
    return [rect(x, y, w, h, fill, stroke, sw, rx=6)]


# ---------------------------------------------------------------- blocks

NODE_MIN_W = 96.0
NODE_MIN_H = 46.0
COL_GAP = 40.0
ROW_GAP = 46.0
CELL_W = 150.0
CELL_H = 60.0
SELF_LOOP_W = 24.0   # 自分への輪が箱の右にはみ出す幅


def draw_blocks(spec) -> tuple:
    nodes = spec["nodes"]
    edges = spec.get("edges", [])

    box = {}
    for nd in nodes:
        ls = lines_of(nd["label"])
        pad_x = 30 if nd.get("shape") == "cloud" else 24
        pad_y = 20 if nd.get("shape") == "cloud" else 16
        w = max(NODE_MIN_W, block_width(nd["label"]) + pad_x)
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
        lw = text_width(e.get("label", ""), FS_SMALL)
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
            col_gap = max(col_gap, text_width(e["label"], FS_SMALL) + 16
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
            lx = rx + SELF_LOOP_W + 6 + text_width(e.get("label", ""), FS_SMALL) / 2
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
                half = (text_width(e.get("label", ""), FS_SMALL) + 8) / 2 + 2
                sgn = -1 if off < 0 else 1
                lx = a["cx"] + off + (sgn * half if off else 0)
                ly = (sy + ey) / 2

        out += polyline(pts, INK, 1.2, dashed, arrow)
        if e.get("label"):
            edge_labels += label_on_line(lx, ly, e["label"])

    for nd in nodes:
        b = box[nd["id"]]
        emph = bool(nd.get("emphasis"))
        out += shape(b["x"], b["y"], b["w"], b["h"], nd.get("shape", "box"), emph)
        cy = b["cy"] + (2 if nd.get("shape") == "cylinder" else 0)
        out += text_block(b["cx"], cy, nd["label"], FS_BODY,
                          ACCENT if emph else INK, bold=emph)
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


def draw_sequence(spec) -> tuple:
    actors = spec["actors"]
    steps = spec["steps"]

    aw = [max(96.0, block_width(a["label"]) + 26) for a in actors]
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
        want = text_width(f"{len(steps)}. {s['label']}", FS_SMALL) + 20
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
            h += LINE_H_S * len(lines_of(s["note"]))
        rows.append((s, y, h))
        y += h
    body_h = y + 10

    out = []
    for i, a in enumerate(actors):
        out.append(line(xs[i], ACTOR_H, xs[i], body_h, CARD_EDGE, 1.2, dashed=True))
    for i, a in enumerate(actors):
        out += shape(xs[i] - aw[i] / 2, 0, aw[i], ACTOR_H, "box", False)
        out += text_block(xs[i], ACTOR_H / 2, a["label"], FS_BODY, INK)

    for k, (s, top, h) in enumerate(rows):
        num = f"{k + 1}."
        label = f"{num} {s['label']}"
        if s["from"] == s["to"]:
            i = idx[s["from"]]
            x0 = xs[i]
            ay = top + 10
            pts = [(x0, ay), (x0 + 26, ay), (x0 + 26, ay + 14), (x0 + 2, ay + 14)]
            out += polyline(pts, INK, 1.2, False, "to")
            out.append(text(x0 + 34, ay + 8, label, FS_SMALL, INK, anchor="start"))
            ly = ay + 14
        else:
            i, j = idx[s["from"]], idx[s["to"]]
            ay = top + 18
            x0, x1 = xs[i], xs[j]
            d = 1 if x1 > x0 else -1
            out += polyline([(x0 + d * 3, ay), (x1 - d * 3, ay)], INK, 1.2, False, "to")
            out.append(text((x0 + x1) / 2, ay - 7, label, FS_SMALL, INK))
            ly = ay
        if s.get("note"):
            nx = (xs[idx[s["from"]]] + xs[idx[s["to"]]]) / 2
            for j, nl in enumerate(lines_of(s["note"])):
                out += label_on_line(nx, ly + 14 + LINE_H_S * j, nl, FS_SMALL, MUTED)

    return out, total_w, body_h


# ---------------------------------------------------------------- matrix

AXIS_GUTTER = 26.0
HEAD_H = 30.0


def draw_matrix(spec) -> tuple:
    xs_vals = spec["x"]["values"]
    ys_vals = spec["y"]["values"]
    cells = spec["cells"]
    emph = {tuple(p) for p in spec.get("emphasis", [])}

    nc, nr = len(xs_vals), len(ys_vals)
    head_w = max([76.0] + [block_width(v, FS_SMALL) + 18 for v in ys_vals])
    cell_w = max([120.0] + [block_width(c, FS_SMALL) + 20 for row in cells for c in row]
                 + [block_width(v, FS_SMALL) + 20 for v in xs_vals])
    max_lines = max(len(lines_of(c)) for row in cells for c in row)
    cell_h = max(58.0, max_lines * LINE_H_S + 26)

    grid_x = AXIS_GUTTER + head_w
    grid_y = AXIS_GUTTER + HEAD_H
    total_w = grid_x + cell_w * nc
    total_h = grid_y + cell_h * nr

    out = []
    out.append(text((grid_x + total_w) / 2, AXIS_GUTTER - 8, spec["x"]["label"],
                    FS_SMALL, MUTED, bold=True))
    # 日本語を 90 度回転させると読みにくい（文字が横倒しになる）ので、
    # 縦軸ラベルは行見出し列の真上に水平で置く
    out.append(text(AXIS_GUTTER + head_w / 2, grid_y - HEAD_H - 8 + FS_SMALL,
                    spec["y"]["label"], FS_SMALL, MUTED, bold=True))

    for c, v in enumerate(xs_vals):
        out += text_block(grid_x + cell_w * (c + 0.5), grid_y - HEAD_H / 2, v,
                          FS_SMALL, INK, bold=True)
    for r, v in enumerate(ys_vals):
        out += text_block(grid_x - head_w / 2, grid_y + cell_h * (r + 0.5), v,
                          FS_SMALL, INK, bold=True)

    for r in range(nr):
        for c in range(nc):
            on = (r, c) in emph
            x = grid_x + cell_w * c
            y = grid_y + cell_h * r
            out.append(rect(x, y, cell_w, cell_h,
                            FILL_ACCENT if on else CARD,
                            ACCENT if on else INK, 1.8 if on else 1.0, rx=4))
            out += text_block(x + cell_w / 2, y + cell_h / 2, cells[r][c], FS_SMALL,
                              ACCENT if on else INK, bold=on)

    return out, total_w, total_h


# ---------------------------------------------------------------- chart

PLOT_H = 210.0


def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def fmt_num(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:g}"


def nice_ticks(lo: float, hi: float, count: int = 5) -> list:
    if hi <= lo:
        hi = lo + 1.0
    raw = (hi - lo) / count
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1.0
    step = mag * 10
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            step = m * mag
            break
    start = math.floor(lo / step) * step
    ticks, v = [], start
    while v <= hi + step * 1e-6:
        ticks.append(round(v, 10))
        v += step
    return ticks


def series_color(series, i: int) -> str:
    """系列の色。強調が指定されていたら、そこだけ強調色にする。"""
    if series[i].get("emphasis"):
        return ACCENT
    if any(s.get("emphasis") for s in series):
        return SERIES_COLORS_EMPH[i % len(SERIES_COLORS_EMPH)]
    return SERIES_COLORS[i % len(SERIES_COLORS)]


def draw_chart(spec) -> tuple:
    kind = spec["kind"]
    xv = spec["x"]["values"]
    series = spec["series"]
    numeric_x = all(is_number(v) for v in xv)

    vals = [v for s in series for v in s["values"] if is_number(v)]
    ymin = spec["y"].get("min")
    ymax = spec["y"].get("max")
    lo = float(ymin) if ymin is not None else min(vals + [0.0])
    hi = float(ymax) if ymax is not None else max(vals)
    if hi <= lo:
        hi = lo + 1.0
    ticks = nice_ticks(lo, hi)
    if ymin is None:
        lo = min(lo, ticks[0])
    if ymax is None:
        hi = max(hi, ticks[-1])
    ticks = [t for t in ticks if lo - 1e-9 <= t <= hi + 1e-9] or [lo, hi]

    tick_lbl_w = max(text_width(fmt_num(t), FS_SMALL) for t in ticks)
    left = 16 + tick_lbl_w + 10          # 縦軸ラベル（回転）＋目盛りの文字
    right = 12.0
    plot_w = max(360.0, 600.0 - left - right)
    x0, x1 = left, left + plot_w
    y0, y1 = 6.0, 6.0 + PLOT_H           # y0=上端, y1=下端

    def sy(v: float) -> float:
        return y1 - (float(v) - lo) / (hi - lo) * (y1 - y0)

    if numeric_x:
        xlo, xhi = float(min(xv)), float(max(xv))
        if xhi <= xlo:
            xhi = xlo + 1.0

        def sx(v):
            return x0 + (float(v) - xlo) / (xhi - xlo) * plot_w
        x_ticks = [(sx(v), fmt_num(float(v))) for v in xv]
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
        out.append(line(x0, y, x1, y, CARD_EDGE, 1.0))
        out.append(text(x0 - 8, y + FS_SMALL * 0.35, fmt_num(t), FS_SMALL, MUTED,
                        anchor="end"))
    out.append(line(x0, y0, x0, y1, INK, 1.2))
    out.append(line(x0, y1, x1, y1, INK, 1.2))

    # 縦の補助線（損益分岐点など）
    for v in spec.get("vlines", []):
        vx = sx(v["x"])
        out.append(line(vx, y0, vx, y1, ACCENT, 1.2, dashed=True))
        if v.get("label"):
            anchor = "end" if vx > x1 - 60 else "start"
            out += [rect(vx + (2 if anchor == "start" else -text_width(v["label"], FS_SMALL) - 6),
                         y0 - 1, text_width(v["label"], FS_SMALL) + 6, FS_SMALL + 5,
                         CARD, None, rx=3),
                    text(vx + (5 if anchor == "start" else -5), y0 + FS_SMALL,
                         v["label"], FS_SMALL, ACCENT, anchor=anchor)]

    # 系列
    for si, s in enumerate(series):
        color = series_color(series, si)
        sw = 2.6 if s.get("emphasis") else 1.8
        pts = [(x_ticks[i][0], sy(v)) for i, v in enumerate(s["values"])]
        if kind == "bar":
            band = plot_w / len(xv)
            bw = min(26.0, band / (len(series) + 0.8))
            base = sy(max(lo, min(0.0, hi)) if lo <= 0 <= hi else lo)
            for i, v in enumerate(s["values"]):
                cx = x_ticks[i][0] + (si - (len(series) - 1) / 2) * (bw + 3)
                top = sy(v)
                out.append(rect(cx - bw / 2, min(top, base), bw, abs(base - top),
                                color, None, rx=2))
        elif kind == "step":
            d = [f"M {n(pts[0][0])} {n(pts[0][1])}"]
            for i in range(1, len(pts)):
                d.append(f"L {n(pts[i][0])} {n(pts[i - 1][1])}")
                d.append(f"L {n(pts[i][0])} {n(pts[i][1])}")
            out.append(path(" ".join(d), color, sw))
        else:
            d = "M " + " L ".join(f"{n(px)} {n(py)}" for px, py in pts)
            out.append(path(d, color, sw))
            for px, py in pts:
                out.append(f'<circle cx="{n(px)}" cy="{n(py)}" r="2.6" fill="{color}"/>')

    # 点への注記
    for a in spec.get("annotations", []):
        ax, ay = sx(a["x"]), sy(a["y"])
        out.append(f'<circle cx="{n(ax)}" cy="{n(ay)}" r="3.4" fill="{ACCENT}"/>')
        w = text_width(a["text"], FS_SMALL) + 12
        left_side = ax + w + 10 > x1
        tx = ax - 8 - w if left_side else ax + 8
        ty = max(y0 + 2, ay - 22)
        # 線の上に置くことになるので、白で塗ったうえで枠を付ける。
        # 枠が無いと系列の線が途切れて見える
        out.append(rect(tx, ty, w, FS_SMALL + 7, CARD, ACCENT, 1.0, rx=4))
        out.append(text(tx + w / 2, ty + FS_SMALL + 2, a["text"], FS_SMALL, ACCENT))

    # 横軸の目盛りラベル（多いと重なるので間引く）
    stride = 1
    while stride < len(x_ticks):
        widest = max(text_width(t[1], FS_SMALL) for t in x_ticks)
        if len(x_ticks[::stride]) * (widest + 8) <= plot_w + widest:
            break
        stride += 1
    for i, (px, lbl) in enumerate(x_ticks):
        if i % stride:
            continue
        out.append(text(px, y1 + FS_SMALL + 6, lbl, FS_SMALL, MUTED))
    y_after_x = y1 + FS_SMALL + 10

    out.append(text((x0 + x1) / 2, y_after_x + FS_SMALL + 6, spec["x"]["label"],
                    FS_SMALL, MUTED, bold=True))
    y_after_x += FS_SMALL + 12
    # 日本語を 90 度回転させると読みにくいので、縦軸ラベルはプロット左上に水平で置く
    out.append(text(16, y0 - 10, spec["y"]["label"], FS_SMALL, MUTED,
                    anchor="start", bold=True))

    # 凡例（グラフの下。重ならないように折り返す）
    if len(series) > 1 or series[0].get("label"):
        items = []
        for si, s in enumerate(series):
            color = series_color(series, si)
            items.append((s["label"], color, 20 + 6 + text_width(s["label"], FS_SMALL)))
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
                out.append(line(lx, ly + 6, lx + 20, ly + 6, color, 2.6))
                out.append(text(lx + 26, ly + 6 + FS_SMALL * 0.35, lbl, FS_SMALL, INK,
                                anchor="start"))
                lx += w + 18
            ly += LINE_H_S + 2
        y_after_x = ly - 4

    return out, x1 + right, y_after_x


DRAWERS = {"blocks": draw_blocks, "sequence": draw_sequence,
           "matrix": draw_matrix, "chart": draw_chart}


# ---------------------------------------------------------------- 組み立て

def render(fig) -> str:
    body, w, h = DRAWERS[fig["type"]](fig)

    inner_w = max(WIDTH - 2 * PAD, w)
    nat_w = inner_w + 2 * PAD
    cap_lines = wrap(fig["caption"], FS_SMALL, inner_w)
    cap_top = PAD + h + 16
    nat_h = cap_top + LINE_H_S * len(cap_lines) + PAD - 4

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" '
        f'height="{n(round(WIDTH * nat_h / nat_w))}" '
        f'viewBox="0 0 {n(nat_w)} {n(nat_h)}" role="img">',
        f'<title>{esc(fig["caption"])}</title>',
        # 白いカードを焼き込む。画面がダークテーマでも図は白いまま出す
        rect(0.5, 0.5, nat_w - 1, nat_h - 1, CARD, CARD_EDGE, 1.0, rx=12),
        f'<g transform="translate({n(PAD + (inner_w - w) / 2)} {n(PAD)})">',
    ]
    parts += body
    parts.append("</g>")
    for i, ln in enumerate(cap_lines):
        parts.append(text(nat_w / 2, cap_top + LINE_H_S * i + FS_SMALL, ln,
                          FS_SMALL, MUTED))
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------- 検証

def _need(d, keys, where, problems) -> bool:
    ok = True
    for k in keys:
        if k not in d or d[k] in (None, ""):
            problems.append(f"{where}: {k} がありません")
            ok = False
    return ok


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
                if k in ("caption", "after", "type", "id", "kind", "shape", "style", "arrow", "color"):
                    continue
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk({k: v for k, v in fig.items() if k not in ("caption", "after")})
    return out


def validate_figure(fig, where, problems) -> None:
    t = fig.get("type")
    if t not in FIGURE_TYPES:
        problems.append(f"{where}: 未知の type {t!r}（{'/'.join(FIGURE_TYPES)} のいずれか）")
        return
    cap = str(fig.get("caption", "")).strip()
    if not cap:
        problems.append(f"{where}: caption が空")
    else:
        # 2026-09-27 の決定: caption は敬体で、答え・誤答の否定・選択肢の記号・回と問番号を書かない
        if not CAPTION_POLITE.search(cap):
            problems.append(f"{where}: caption の文末が敬体（です・ます）でない: {cap[-20:]!r}")
        if CAPTION_BANNED.search(cap):
            problems.append(f"{where}: caption に答え・誤答・選択肢・問の名指しか禁止記法（^ 上付き ，．）: {cap[:40]!r}")
    if not str(fig.get("after", "")).strip():
        problems.append(f"{where}: after が空")
    for txt in _figure_texts(fig):
        if FIGURE_BANNED.search(txt):
            problems.append(f"{where}: 図の中身に誤答の否定・正誤の印・問の名指しか禁止記法: {txt[:40]!r}")

    if t == "blocks":
        if not _need(fig, ["nodes"], where, problems):
            return
        ids = []
        for i, nd in enumerate(fig["nodes"]):
            if not _need(nd, ["id", "label", "row", "col"], f"{where} nodes[{i}]", problems):
                continue
            if nd["id"] in ids:
                problems.append(f"{where}: nodes の id {nd['id']!r} が重複")
            ids.append(nd["id"])
            if nd.get("shape", "box") not in ("box", "round", "cylinder", "cloud"):
                problems.append(f"{where}: 未知の shape {nd.get('shape')!r}")
        for i, e in enumerate(fig.get("edges", [])):
            if not _need(e, ["from", "to"], f"{where} edges[{i}]", problems):
                continue
            for side in ("from", "to"):
                if e[side] not in ids:
                    problems.append(f"{where}: edges[{i}] の {side} {e[side]!r} が nodes にない")
            if e.get("style", "solid") not in ("solid", "dashed"):
                problems.append(f"{where}: edges[{i}] の未知の style {e.get('style')!r}")
            if e.get("arrow", "to") not in ("to", "both", "none"):
                problems.append(f"{where}: edges[{i}] の未知の arrow {e.get('arrow')!r}")

    elif t == "sequence":
        if not _need(fig, ["actors", "steps"], where, problems):
            return
        ids = []
        for i, a in enumerate(fig["actors"]):
            if not _need(a, ["id", "label"], f"{where} actors[{i}]", problems):
                continue
            if a["id"] in ids:
                problems.append(f"{where}: actors の id {a['id']!r} が重複")
            ids.append(a["id"])
        if len(ids) < 2:
            problems.append(f"{where}: actors は2つ以上必要")
        for i, s in enumerate(fig["steps"]):
            if not _need(s, ["from", "to", "label"], f"{where} steps[{i}]", problems):
                continue
            for side in ("from", "to"):
                if s[side] not in ids:
                    problems.append(f"{where}: steps[{i}] の {side} {s[side]!r} が actors にない")

    elif t == "matrix":
        if not _need(fig, ["x", "y", "cells"], where, problems):
            return
        for ax in ("x", "y"):
            _need(fig[ax], ["label", "values"], f"{where} {ax}", problems)
        xs, ys = fig["x"].get("values", []), fig["y"].get("values", [])
        if not (2 <= len(xs) <= 3 and 2 <= len(ys) <= 3):
            problems.append(f"{where}: matrix は 2×2〜3×3（今は {len(ys)}×{len(xs)}）")
        if len(fig["cells"]) != len(ys):
            problems.append(f"{where}: cells の行数 {len(fig['cells'])} が y.values {len(ys)} と違う")
        for r, row in enumerate(fig["cells"]):
            if len(row) != len(xs):
                problems.append(f"{where}: cells[{r}] の列数 {len(row)} が x.values {len(xs)} と違う")
        for p in fig.get("emphasis", []):
            if len(p) != 2 or not (0 <= p[0] < len(ys) and 0 <= p[1] < len(xs)):
                problems.append(f"{where}: emphasis {p} が範囲外")

    elif t == "chart":
        if not _need(fig, ["kind", "x", "y", "series"], where, problems):
            return
        if fig["kind"] not in ("line", "bar", "step"):
            problems.append(f"{where}: 未知の kind {fig['kind']!r}（line/bar/step）")
        _need(fig["x"], ["label", "values"], f"{where} x", problems)
        _need(fig["y"], ["label"], f"{where} y", problems)
        xs = fig["x"].get("values", [])
        if len(xs) < 2:
            problems.append(f"{where}: x.values は2つ以上必要")
        if not fig["series"] or len(fig["series"]) > 3:
            problems.append(f"{where}: series は1〜3本（今は {len(fig['series'])}）")
        for i, s in enumerate(fig["series"]):
            if not _need(s, ["label", "values"], f"{where} series[{i}]", problems):
                continue
            if len(s["values"]) != len(xs):
                problems.append(f"{where}: series[{i}] の値 {len(s['values'])} 個が "
                                f"x.values {len(xs)} 個と違う")
            for v in s["values"]:
                if not is_number(v):
                    problems.append(f"{where}: series[{i}] に数値でない値 {v!r}")
                    break
        numeric_x = all(is_number(v) for v in xs)
        for i, v in enumerate(fig.get("vlines", [])):
            if not _need(v, ["x"], f"{where} vlines[{i}]", problems):
                continue
            if not numeric_x and v["x"] not in xs:
                problems.append(f"{where}: vlines[{i}] の x {v['x']!r} が x.values にない")
        for i, a in enumerate(fig.get("annotations", [])):
            if not _need(a, ["x", "y", "text"], f"{where} annotations[{i}]", problems):
                continue
            if not numeric_x and a["x"] not in xs:
                problems.append(f"{where}: annotations[{i}] の x {a['x']!r} が x.values にない")


def load(paths, problems) -> list:
    docs, seen = [], {}
    for p in paths:
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            problems.append(f"[{p}] JSON が壊れています: {e}")
            continue
        where = f"[{p.name}]"
        if not _need(doc, ["topic_id", "term", "figures"], where, problems):
            continue
        tid = doc["topic_id"]
        if tid in seen:
            problems.append(f"{where}: 論点 {tid} は {seen[tid]} にもあります（1論点1ファイル）")
        seen[tid] = p.name
        fids = []
        for i, fig in enumerate(doc["figures"]):
            fid = fig.get("id")
            w = f"[{p.name}] 論点 {tid} 図 {fid if fid is not None else f'#{i}'}"
            if not isinstance(fid, int) or fid < 1:
                problems.append(f"{w}: id は1始まりの整数")
            elif fid in fids:
                problems.append(f"{w}: 図の id が重複")
            else:
                fids.append(fid)
            validate_figure(fig, w, problems)
        docs.append((p, doc))
    return docs


# ---------------------------------------------------------------- 実行

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

    problems: list = []
    docs = load(paths, problems)
    # after の見出しが教材（materials_v3）に実在するか。無いと attach が explanation 末尾へ黙って逃がす（2026-09-27）
    heads = {}
    for mp in sorted((args.data / "materials_v3").glob("*.json")) if (args.data / "materials_v3").exists() else []:
        try:
            for m in json.loads(mp.read_text(encoding="utf-8")).get("materials", []):
                heads[m["topic_id"]] = {l.strip() for l in (m.get("detail") or "").split("\n") if l.strip().startswith("### ")}
        except (json.JSONDecodeError, KeyError, TypeError):
            pass
    if heads:
        for p, d in docs:
            for fig in d.get("figures", []):
                a = str(fig.get("after", "")).strip()
                if a and a != "explanation" and d.get("topic_id") in heads and a not in heads[d["topic_id"]]:
                    problems.append(f"[{p.name}] 論点 {d['topic_id']} 図 {fig.get('id')}: after {a!r} が教材の見出しに無い（explanation 末尾へ逃げる）")
    if args.only is not None:
        docs = [(p, d) for p, d in docs if d.get("topic_id") in args.only]

    if args.check:
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(f"\n{len(paths)} ファイル / "
              f"{sum(len(d.get('figures', [])) for _, d in docs)} 図を検証しました")
        if problems:
            print(f"問題 {len(problems)} 件", file=sys.stderr)
            return 1
        print("問題なし")
        return 0

    if problems:
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(f"\n問題 {len(problems)} 件。描画しません。", file=sys.stderr)
        return 1

    out_dir = args.out or Path("public/figures/materials") / exam
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.png_dir:
        args.png_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for _p, doc in docs:
        for fig in doc["figures"]:
            name = f"{doc['topic_id']}-{fig['id']}"
            svg = render(fig)
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
