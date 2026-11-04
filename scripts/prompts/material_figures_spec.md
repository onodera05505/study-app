# 教材に添える図の仕様

図は**自分で SVG を書かない**。仕様 JSON を書くと `scripts/render_material_figures.py` が
決まった様式で描く。担当ごとに見た目がばらつかず、直すときは JSON を直して描き直せる。

---

## 置き場所と形

1論点1ファイル。`data/<試験>/material_figures/<topic_id>-<用語>.json`

```json
{
  "topic_id": 53,
  "term": "論理関数",
  "figures": [ { "id": 1, "type": "blocks", "caption": "…", "after": "explanation", "…": "…" } ]
}
```

| キー | 意味 |
| --- | --- |
| `topic_id` | 論点 ID（`data/<試験>/topic_ids.json` の値。並び順から採らない） |
| `term` | その論点の用語。教材の `term` と同じ文字列にする |
| `figures[].id` | 1 始まりの整数。ファイル内で重複させない |
| `figures[].type` | `blocks` / `sequence` / `matrix` / `chart` の4つだけ |
| `figures[].caption` | 図の下に出す 1〜2 文（60 字前後まで）。**敬体（です・ます）**で、図が何を表しどう読むかを書く（`--check` が全文の文末と禁止語を見る）。必須。教材の `![…]` の代替文と SVG の `<title>` にも使われる |
| `figures[].after` | 差し込み位置。`"explanation"`＝短い説明の末尾、それ以外は `detail` に**実在する**見出しを `"### しくみ"` の形で。必須。見出しが無いと `attach_material_figures.py` は explanation 末尾へ黙って逃がすので、`render_material_figures.py --check` が実在を見る |

出力は `public/figures/materials/<試験>/<topic_id>-<id>.svg`。

## 書くときの決まり

- **図は解説の代わりではなく、文章では追いにくいものだけに付ける**（構成・手順・
  2軸の分類・数値の動き）。表や擬似言語は文章のままにする
- **ロードマップ型の学びで図を付けた単位は、図が示す構成・手順・対比を本文の文で繰り返さない。** 本文には、図を読む前の 1〜2 文の導入と、図に描けないこと（理由・例外・使いどころ）だけを残し、図に移った文は削る。削った後も本文だけで単位の要点が一言で言えること
- ラベルは短く。**自動で折り返さない**ので、長いときは `\n` を自分で入れる
- 図の中に問題文や選択肢を書き写さない（引用になる）
- **caption と図の中身に、特定の過去問の答え・誤答の否定・選択肢の記号や語の並び・回と問番号を書かない**
  （×「機能4だけ」「シングルサインオンは試行を止めない」「（正）（誤）」「シナリオ d の累積」「令和7年度秋期 問77」）。
  図は概念を表し、答え合わせは問題解説がする。**「計算の解き方」の図が例題の値で解いてみせるのはよい**（教材は過去問 1 件を解いてみせる）。
  答えのセルだけを `emphasis` で指すのも答えの名指しになるので、読み方の印として意味がある所だけに
- 記法: `^`・上付き数字（²）・IPA の句読点（，．）を書かない（「2 の n 乗」「、」「。」）。caption の 2 文目は「〜してください」で閉じない（敬体の門に当たる）
- **caption を変えたら SVG も描き直す**（caption は SVG に焼き込まれる）。正本（この JSON）・SVG・教材の代替文の 3 者が一致していることを見る
- 強調（`emphasis`）は**1図に1つか2つ**。全部強調すると強調にならない

---

## 1. `blocks` — 箱と矢印

構成図・ブロック図・状態遷移・階層に使う。

```json
{
  "id": 1, "type": "blocks", "after": "explanation",
  "caption": "業務処理をアプリケーションサーバに集めるので、クライアントは画面だけを持てばよくなります。",
  "nodes": [
    {"id": "cl", "label": "クライアント\nプレゼンテーション層", "row": 0, "col": 0},
    {"id": "ap", "label": "アプリサーバ\nファンクション層", "row": 0, "col": 1, "emphasis": true},
    {"id": "db", "label": "DB サーバ\nデータ層", "row": 0, "col": 2, "shape": "cylinder"}
  ],
  "edges": [
    {"from": "cl", "to": "ap", "label": "画面の入力", "arrow": "both"},
    {"from": "ap", "to": "db", "label": "SQL", "arrow": "both"}
  ]
}
```

- `nodes[]` — `id`（図の中で一意）、`label`、`row` / `col`（**0 始まりの格子位置**。
  同じ `row` は横一列）。任意で `emphasis`（true で強調色）、
  `shape`（`box` 既定 / `round` / `cylinder`＝データストア / `cloud`＝ネットワーク）
- `edges[]` — `from` / `to`（`nodes` の `id`）。任意で `label`、
  `style`（`solid` 既定 / `dashed`）、`arrow`（`to` 既定 / `both` / `none`）
- `from` と `to` が同じなら自分への矢印（状態遷移の自己ループ）になる
- 格子は詰めて使う。列は 3〜4、行は 3 くらいまでが読みやすい

## 2. `sequence` — 手順・やり取り

プロトコルのハンドシェイク、処理の流れに使う。

```json
{
  "id": 1, "type": "sequence", "after": "### ハンドシェイクの流れ",
  "caption": "公開鍵暗号は共通鍵を渡すためだけに使い、本文の暗号化は共通鍵で行います。",
  "actors": [{"id": "c", "label": "クライアント"}, {"id": "s", "label": "サーバ"}],
  "steps": [
    {"from": "c", "to": "s", "label": "ClientHello（使える暗号方式を提示）"},
    {"from": "s", "to": "c", "label": "ServerHello ＋ サーバ証明書", "note": "証明書の正当性を認証局の公開鍵で確認する"},
    {"from": "c", "to": "s", "label": "共通鍵の素をサーバの公開鍵で暗号化して送付"},
    {"from": "s", "to": "c", "label": "Finished（以降は共通鍵で暗号化）"}
  ]
}
```

- `actors[]` — `id` と `label`。**左から書いた順**に並ぶ。2〜4 人まで
- `steps[]` — `from` / `to` / `label`。上から書いた順に **1. 2. 3.** と番号が付く
- `from` と `to` が同じなら自分への処理（短い折り返し矢印）
- `note` は任意。矢印の下に小さく出る。**そこを外すとどうなるか**のような一言に使う
- 手順は 4〜6 個まで。それ以上は図で見る意味が薄れる

## 3. `matrix` — 2軸の分類・対比

```json
{
  "id": 1, "type": "matrix", "after": "### 4 つの成長戦略",
  "caption": "既存か新規かの2軸で成長戦略を4つに分けます。右下ほどリスクが大きくなります。",
  "x": {"label": "製品", "values": ["既存製品", "新製品"]},
  "y": {"label": "市場", "values": ["既存市場", "新市場"]},
  "cells": [
    ["市場浸透\n既存市場で\nシェアを上げる", "新製品開発\n既存の顧客に\n新製品を売る"],
    ["市場開拓\n既存製品を\n新しい市場へ", "多角化\n新製品を\n新市場へ"]
  ],
  "emphasis": [[1, 1]]
}
```

- **2×2 か 3×3**（2〜3 × 2〜3）。それ以外はエラーになる
- `cells` は **y の行ごと・x の列順**。`cells[r][c]` は `y.values[r]` × `x.values[c]`
- 各セルは「名前 ＋ 一言」を `\n` で改行して書く。3 行まで
- `emphasis` は任意。`[[行, 列], …]`（0 始まり）

## 4. `chart` — 数値のグラフ

```json
{
  "id": 1, "type": "chart", "after": "explanation",
  "caption": "売上高の線と総費用の線が交わる点が損益分岐点です。ここを超えた分だけ利益が出ます。",
  "kind": "line",
  "x": {"label": "売上高（万円）", "values": [0, 200, 400, 600, 800, 1000]},
  "y": {"label": "金額（万円）", "min": 0},
  "series": [
    {"label": "売上高", "values": [0, 200, 400, 600, 800, 1000]},
    {"label": "総費用（固定費 300 ＋ 変動費率 0.5）", "values": [300, 400, 500, 600, 700, 800]}
  ],
  "vlines": [{"x": 600, "label": "損益分岐点"}],
  "annotations": [{"x": 600, "y": 600, "text": "600 万円"}]
}
```

- `kind` — `line` / `bar` / `step`
- `x.values` — 数値（等間隔でなくてよい）またはカテゴリ名の文字列。`bar` は普通カテゴリ
- `series[]` — **最大 3 本**。`values` は `x.values` と同じ個数・すべて数値。
  任意で `emphasis`（true の系列だけ強調色になり、他は無彩色になる）
- `y` — `label` は必須。`min` / `max` は任意（省略するとデータから決める）
- `vlines[]`（縦の補助線。損益分岐点など）と `annotations[]`（点への短い注記）は任意。
  カテゴリ軸のときは `x` に `x.values` の値をそのまま書く

---

## 描く・検証する

```bash
# 検証だけ（描かない）。問題があれば論点IDと図IDを添えて出て、終了コード 1
python3 scripts/render_material_figures.py --data data/ap --check

# 描く（既定の出力先は public/figures/materials/<試験>）
python3 scripts/render_material_figures.py --data data/ap --only 53 174

# 目視確認（PNG も書く）
python3 scripts/render_material_figures.py --data data/ap --only 53 \
    --out /tmp/figcheck --png-dir /tmp/figcheck

# 手本（4つの型のサンプル）
python3 scripts/render_material_figures.py --data data/ap --samples --check
```

手本は `data/ap/material_figures/_samples/` にある（`_` 始まりは本番の入力に入らない）。
**書いたら必ず PNG を目で見ること。** 文字がはみ出していないか、矢印が箱に届いているか、
凡例が重なっていないかは、検証では分からない。

### PNG で「壊れて見える」もの（SVG は正しい。直さない）

PNG 化に使う PyMuPDF の SVG 描画には穴がある。ブラウザでは正しく出る。

- **長音符「ー」と中黒「・」が消える。**「サーバー」が「サ バ」に見える
- **破線が実線に見える**（ライフライン、`style: "dashed"`、`vlines`）

---

## 改訂履歴（本文は常に現在形。変えるときは該当の文を書き換え、ここに 1 行）

- 2026-11-04: ロードマップ型で図を付けた単位は、図が示す中身を本文で繰り返さず削る（本人の決定。eng の解説が文章すぎるとの指摘）
- 2026-09-27: caption は敬体で図の読み方を書く。caption と中身に答え・誤答の否定・選択肢・問の名指しを書かない。`after` の実在と caption の文体を `--check` が見る。caption を変えたら SVG も描き直す（`docs/作業ログ_2026-09-25_セルフフィードバック.md`）
- 2026-09-01: 作成（両試験で 400 枚。`docs/作業ログ_2026-09-01_教材の図.md`）
