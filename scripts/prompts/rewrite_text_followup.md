# 本文の後追い（資格対策。図の見直しの後。1 体が 1 単元の項目の一覧を受け持つ）

図の見直しの段（`scripts/prompts/rewrite_figures_review.md`）は、図の値・場面を替え、図を外し・移し・戻すが、教材の本文は書き換えない。本文の側に要る直しは、その段の報告の `not_fixed` に `text_followup` で挙がる。
この段は、そのうち**図が変わったために本文と図が合わなくなった所**と、**点の台帳で本文から外れた判断材料と、図の直しで行き場が無くなる点**だけを、親が作った一覧で受け取り、**教材の本文（`materials_v4`）を直す**。直すのは次の 3 つだけ。

- **図を指す文が、今の図と合わない**（「図のとおり」「図の段の順に」「そちらの図で」「この節の図に示します」が、今の図に無い値・場面・図を指す。指す図が別の論点・別の節へ移った）
- **図に任せていた過去問 1 件の解く手順・値が、本文から欠けた**（図を別の値にしたので、本文が過去問を解いてみせる所の値・段が、今はどこにも無いか問題解説にだけある）
- **点の台帳の行き先が、問題解説に任せてよい物の線に合わない**（行き先が `explanation` の行の点が正解の根拠＝判断材料で、今の教材のどこにも無い。図の見直しの段が、判断材料が本文に無いために図の直しを止めた点（旧版で図だけが持っていた、過去問 1 件を解いてみせる手順・値を含む）を含む。図の見直しの段が図の直しを止めた点が判断材料でなくても、図から外すと行き先が `fate` のどれにも当たらなくなる点は、ここに含む）

**教材の書き方の正本は `scripts/prompts/write_materials.md`、図の決まりの正本は `scripts/prompts/material_figures_spec.md`、点の台帳の正本は `scripts/prompts/rewrite_materials_by_group.md`、本文を直す段の共通の作法（直してよい範囲・解けるかの確かめ・門）は `scripts/prompts/rewrite_unit_crosscheck.md`。** この仕様書は、この段の入力・範囲・直し方の選び方・書いてよい範囲・門・報告だけを決める。新しい書き方の決まりは作らない。直し方は正本の決まりから導き、**正本の決まりで直し方が 1 つに決まらない項目は直さない**（下の「直さずに返す物」）。

---

## 先に読むもの（順に全部）

1. `scripts/prompts/write_materials.md` — 「満たすべき最低条件」「書き直し」の「情報を落とさない」（正解の根拠は本文に残す・旧版に無い内容を足さない）「1 つの点は 1 か所で言う」「他の論点との分担」（他の論点を文で指す形）、「見出し」の表と `### 計算の解き方` の行（番号付きの手順が正本・過去問の数値で解く・同じ手順をたどる図は別の値）、「書き方の約束」（計算の解き方は型ごとに 1 件・全選択肢の値を出さない・過去問の問題文を引用しない・敬体）
2. `scripts/prompts/material_figures_spec.md` — 「書くときの決まり」と「過去問の答えを言わない・写さない」（計算の手順の図は値の線を守って別の例で同じ手順をたどる骨組みの線。図と本文で値が違うのはこの決まりのとおりで、食い違いではない）
3. `scripts/prompts/rewrite_unit_crosscheck.md` — 「直し方」の「どの種にも共通」、「点の台帳の直し方」、「書いてよいファイル・読むだけのファイル」、「門」、「報告」の形
4. `scripts/prompts/rewrite_materials_by_group.md` — 「情報を落とさない確かめ方」（点の台帳の形と `fate` の 8 つ。`explanation` の定義が、問題解説に任せてよい物の線）
5. `scripts/prompts/rewrite_figures_review.md` — 「報告（親へ）」（一覧の項目の出どころ）と「点の台帳の直し方」（図から点が消えたときの行き先）
6. 担当の項目の一覧（下の「入力」）と、一覧の論点の入力

## 親が渡すもの（可変部分）

親が指示で渡すのは **対象（`ip`・`ap`・`fe` のどれか）・項目の一覧のパス・報告のパス** の 3 つだけで、ほかはこの仕様書が決める。

### 1 体の担当範囲

- 1 つの一覧は **1 つの単元の項目だけ**で、**項目 16 件まで**（`items` の件数。図の申告の項目と台帳の行の項目を合わせて数える）。図の見直しの段（追加の一覧と閉じた図のテストの後の回を含む）が、その単元で全部終わってから組む
- 1 つの単元に一覧が 2 つ以上あるときは、前の担当が終わってから次の担当を起こす（同じ単元の教材と点の台帳を 2 体が並行して書かない）。違う単元の一覧は並行してよい
- 同じ論点の項目は、同じ一覧に入れる

## 入力

### 項目の一覧（親が渡すパス。JSON）

一覧の項目には、出どころ（`source`）が 2 つある。

- `figures_review` — 図の見直しの段の報告の `not_fixed` のうち `kind` が `text_followup` の行から、親が作る。図の見直しの段が、判断材料が本文に無いために図の直しを止めた申告（`rewrite_figures_review.md` の「点の台帳の直し方」）は、親が `ledger_row` にその台帳の行を入れる
- `ledger` — 点の台帳の `fate` が `explanation` の行の見直しから、親が作る（1 行 1 項目。どの行を入れるかは親が決める）

```json
{
  "target": "ip",
  "unit": "01",
  "items": [
    {
      "no": 1,
      "source": "figures_review",
      "topic_id": 489,
      "figure": {"topic_id": 489, "figure_id": 1},
      "from": {"list": "ip_01_1", "no": 1},
      "what": "本文 ### 計算の解き方 の「…の例を、図の段の順に解いています。」が、図の値を替えたため図と合わなくなった",
      "questions": ["2018h30a-q16"],
      "figure_before": "<親の置き場>/before/ip/489-1.json",
      "related": [],
      "ledger_row": null
    },
    {
      "no": 2,
      "source": "ledger",
      "topic_id": 14,
      "figure": null,
      "from": {"ledger": "data/ip/rewrite_ledgers/02-1.json", "topic_id": 14, "point": "アルゴリズム・プログラム言語は守られない"},
      "what": "行き先 explanation の行。where は question_explanations の 2021r03-q7・2018h30a-q7 の correct_reason",
      "questions": ["2021r03-q7", "2018h30a-q7"],
      "figure_before": null,
      "related": [],
      "ledger_row": {"file": "data/ip/rewrite_ledgers/02-1.json", "topic_id": 14, "point": "アルゴリズム・プログラム言語は守られない", "fate": "explanation", "where": "question_explanations の 2021r03-q7・2018h30a-q7 の correct_reason"}
    }
  ]
}
```

| 欄 | 中身 |
| --- | --- |
| `target`・`unit` | 対象と単元番号（2 桁）。担当の範囲はこの単元 |
| `items[].no` | 一覧の中の通し番号（報告で指す） |
| `items[].source` | 出どころ。`figures_review` か `ledger`（上の 2 つ） |
| `items[].topic_id` | 本文を直す候補の論点（申告の `topic_id`、台帳の行の論点） |
| `items[].figure` | 申告が名指した図（今の論点 ID と図 ID）。図が特定されていない申告は `figure_id` が `null`。`ledger` の項目は `null` |
| `items[].from` | 項目の出どころ。`figures_review` は図の見直しの一覧の名前と、その報告の `not_fixed` の `no`（`{"list", "no"}`）。`ledger` は台帳のファイル・論点 ID・行の `point` の全文（`{"ledger", "topic_id", "point"}`。台帳の行は `point` の全文で引く） |
| `items[].what` | 申告の要約（図の見直しの担当が書いた物のまま）か、台帳の行の要約（親が書く）。**候補として使い、現物で確かめる**（申告の直し方の案に縛られない） |
| `items[].questions` | `figures_review` は、申告の図の論点で図の見直しの担当が並べた過去問の ID（報告の `questions_checked`）。`ledger` は、台帳の行の `where` が名指す過去問の ID。無ければ空。解けるかの確かめと判断材料かの判定は、これに限らずその論点の紐づく過去問の全部で行う |
| `items[].figure_before` | 図の見直しの段の前の、その図の JSON（`figures[]` の 1 件）を置いたファイルのパス。親が用意する。戻した図・前に無かった図・`ledger` の項目は `null` |
| `items[].related` | 図の見直しの段の報告の `moved`・`removed`・`restored` で、その図と組になる図（移し替えの行き先と元、外した図の `kept`）。`{"topic_id", "figure_id"}`。無ければ空 |
| `items[].ledger_row` | 見直す台帳の行の、一覧を作ったときの写し（`file`・`topic_id`・`point`・`fate`・`where`）。`ledger` の項目と、図の見直しの段が判断材料のために図の直しを止めた申告の項目に入る。それ以外は `null`。今の台帳の行が写しと違うときは、その項目は直さず `blocked` に挙げる |

### 一覧の論点ごとに読む物

| 読む物 | パス | 使う欄 |
| --- | --- | --- |
| 教材 | `python3 scripts/material_generations.py --data data/<対象>` の標準出力の `materials`（`topic_id` は文字列） | `_generation`・`_file`、`explanation`・`detail` |
| 図の仕様（今） | `data/<対象>/material_figures/<論点 ID>.json` | `figures[]` の `id`・`after`・`caption` と図の中の文字・値 |
| 図の仕様（前） | `items[].figure_before` | 図の見直しの前に、図が何を持っていたか（過去問の値・場面・解く段） |
| 書き直しの束 | `data/<対象>/rewrite_bundles/<単元>-<k>.json`（その論点を含む束） | 論点の `questions`（`stem`・`choices`・`answer`）、`question_explanations`（`correct_reason`・`choices[].note`）、`current`（旧版の本文）と `figures`（旧版の図。束を作ったときの `figure_file` の `figures` の写し）。台帳の点が旧版にあったかは、この 2 つを合わせた旧版の教材で見る |
| 点の台帳 | `data/<対象>/rewrite_ledgers/<単元>-<k>.json` | 論点の `points`（`fate` が `figure`・`explanation` の行） |
| 単元の構成 | `data/<対象>/unit_plans/<単元>.json` | `groups[]`（学ぶ順）、`owners[]`（受け持ち） |
| 論点の一覧 | `data/<対象>/topics.json` | `term`（他の論点を `[[ ]]` で指すとき） |

- 一覧の論点の `_generation` が `materials_v4` であることを確かめる。違えば、その論点の項目は何も直さず、報告の `blocked` に挙げる
- **紐づく過去問**は、その論点の束の `questions`（同一内容の問題は 1 件に畳んである）
- 図は、本文の `after` の位置（`after: "explanation"` は短い説明の末尾、見出しの名前ならその見出しの節の末尾。同じ `after` の図は図の仕様に並ぶ順。置き方の正本は `material_figures_spec.md` の `figures[].after`）にあるものとして読む

## 範囲

### 直す物（この段の範囲）

`ledger_row` が `null` の項目は、次の 1・2 のどちらかに当たり、**今の図か図の置き場が図の見直しの段で変わったことが原因**のときだけ直す。原因は `figure_before` と今の図の仕様を並べて決める（`figure_before` が `null` の図は、図の見直しの報告の `moved`・`removed`・`restored` で決める）。`ledger_row` のある項目は、3 に当たるときだけ直す。

1. **図を指す文が、今の図と合わない。** 図を指す文とは、教材の図（図の仕様の JSON が描く図）の位置か中身を指す文・句（「図のとおり」「図の段の順に」「上の図の」「この節の図に示します」「前の節の図の並びで」「そちらの図で示しました」）。合わないとは、次のどれか
   - 指す中身（値・場面・名前・段）が、今の図に無い
   - 指す置き場（同じ節・前の節・他の論点）に、今その図が無い（図が移った・戻った・外れた）
2. **図に任せていた過去問 1 件の解く手順・値が、本文から欠けた。** `figure_before` が紐づく過去問 1 件の値・段で解いてみせていて、今の図は別の値になり、本文のその節にその値・段が無い
3. **台帳の行の点が判断材料で、今の教材に無い。** `ledger_row` の点が、旧版の教材（束の `current` の本文と、束の `figures` の図の中の文字と caption）にあり、`rewrite_materials_by_group.md` の `explanation` の定義で問題解説に送ってよい物（誤答のケア・計算の 2 件目以降・全選択肢の値）でなく正解の根拠（判断材料）で、今の教材のどこにも無い。「今の教材」は、その論点の今の本文と図（図の中の文字と caption）と、`fate` の定義が認める他の論点（`owner`・`prior`・`later`）の今の本文。図の見直しの段が図の直しを止めた申告の項目（`ledger_row` の `fate` が `figure`）では、その点を言う図は、止めた直しで点が消える図なので数えない。図の直しを止めた申告の項目は、点が判断材料でなくても、止めた直しで点が図から消えたあとの行き先が `rewrite_materials_by_group.md` の 8 つの `fate` のどれにも当たらないとき（応用情報の周辺知識。問題解説に送ってよい物だが、問題解説のどこにも無い）も、3 に当たる

次は「図を指す文」に数えない（当たらない）。

- 論点の中身としての図（カルノー図・状態遷移図・過去問の問題の図、本文が言葉で描いた図）を指す「図」
- 今の図と同じ手順・構成を指すだけの文（「予算を引く順を図に並べました」で、今の図が別の値で同じ順をたどる）。図の値が本文の例と違うのは `material_figures_spec.md` の「過去問の答えを言わない・写さない」の値の線と骨組みの線のとおりで、食い違いではない

### 直さずに返す物（範囲の外）

次は、この段では直さず、報告の `not_fixed` に挙げる（本人に諮る）。申告の `what` がこれらと 1〜3 を両方含むときは、1〜3 の分だけを直し、残りを挙げる。

| `kind` | 何か |
| --- | --- |
| `example` | 本文の例・場面を別の物に替える直し（本文の例が過去問の場面と同じ、図の場面を替えるために本文の例を替える） |
| `content_addition` | 説明・点・文を足す直し（図を指していない所に「図は別の値の例です」の 1 文を添える、など）。下の「直し方」の 2 で戻す値・段と、3 で戻す旧版の点は、これに当たらない。旧版の教材（本文と図）に無い点を足す直しは、これに当たる |
| `duplicate` | 本文と図・表の同じ点のなぞりを縮める直し |
| `heading` | 見出しの名前の直し（図の `after` が指す） |
| `unit_plan` | 学ぶ順・受け持ち・比較を持つ論点の直し（単元をまたぐ物を含む） |
| `term` | 語の揺れ |
| `figure` | 本文ではなく図の側の直しが要る物（図の見直しの段へ戻す） |
| `rule` | 本文が正本の書き方の決まりに合わないが、図の変更が原因でない物（計算の解き方で型の同じ 2 件目の過去問を解いている疑い、など） |
| `undetermined` | 1〜3 に当たるが、正本の決まりで直し方が 1 つに決まらない物（下の「直し方が 1 つに決まらないとき」）。3 の、判断材料か問題解説に任せてよい物かが決まらない物を含む |
| `question_data` | 過去問のデータが壊れて見える物（原本との照合は親が行う） |
| `other` | どれにも当たらない物（`what` に理由） |

## やること（項目ごと。一覧の順に）

1. **現物で確かめる。** 申告が指す文を今の本文（`materials_v4`）で探し、今の図の仕様・`figure_before`・紐づく過去問・問題解説と並べる。`ledger_row` のある項目は、台帳の行の点を旧版の本文と図（束の `current`・`figures`）・今の本文と図・紐づく過去問と問題解説で探す（下の「直し方」の 3）。報告の `verdict` に `applies`（範囲の 1〜3 に当たる）・`not_applies`（当たらない。理由を付ける）・`out_of_scope`（範囲の外。`not_fixed` に挙げる）・`data_suspect`（過去問のデータが壊れて見える。直さず `not_fixed` に `question_data`）のどれかを付ける
2. **直し方を選ぶ**（下の「直し方」）。直すのは、項目の文と、下の「直してよい文」の範囲だけ
3. **解けるかを確かめる。** `rewrite_unit_crosscheck.md` の「どの種にも共通」の 3 つ目のとおり、その論点の紐づく過去問が、直した本文（図の中の文字と caption を含む）と問題解説で今も解けること。解けなくなる直しはしない
4. **点の台帳を合わせる**（下の「点の台帳の直し方」）
5. **門を通す**（下の「門」）

## 直し方

### 1. 図を指す文が今の図と合わない

文の中の、今の図と合わない句だけを直す。直し方は次の順に当て、最初に当たった物にする。

| 場合 | 直し方 | `action` |
| --- | --- | --- |
| 指す図が別の置き場にある（移った・戻った。外した図で `related` に `kept` の図がある） | 置き場を指す句だけを今の置き場に替える。同じ論点で、その文より後ろに出る図なら「下の図」、前に出る図なら「上の図」、他の論点なら `write_materials.md` の「他の論点との分担」の文で指す形（`[[論点名]]` の図）。指す中身の句は変えない | `repoint` |
| 指す中身が今の図に無い | その句を外す。今の図の値・名前を本文に書き写して合わせない（`write_materials.md` の「1 つの点は 1 か所で言う」の、本文が図の中身を読み上げ直さない） | `drop_pointer` |

- 句を外して残りが文として成り立つなら、残りを文にする。残りが成り立たず、その文が図を指すことだけを言っていたなら、文ごと消す
- 外した句・消した文に、図を指すこと以外の点（例の値・場面・結論）があるときは、その点の行き先が `rewrite_materials_by_group.md` の 8 つの `fate` のどれかに当たること（同じ論点の本文の別の所にある、問題解説に送ってよい物で問題解説にある、など。正解の根拠は問題解説にあっても `explanation` に当たらない）を確かめてから外す。当たらないなら外さず、`undetermined` に挙げる
- 外した句が過去問 1 件を解いてみせる値・段だったときは、続けて 2 を当てる

### 2. 図に任せていた過去問 1 件の解く手順・値が欠けた

戻すかどうかは、その節が何かで決まる。

| その節 | 直し方 | `action` |
| --- | --- | --- |
| `### 計算の解き方` | 戻す。`write_materials.md` の「見出し」の表と `### 計算の解き方` の行のとおり、過去問の数値で解いてみせる。戻すのは `figure_before` がたどっていた過去問 1 件の値（本文が既に例の値を名指していれば、その過去問）。図に任せていた動作が番号付きの段にあるなら、その段に値を入れる。節に番号付きの段が無いなら、番号付きの段（1 段 1 動作）を、例の条件を言う文の後ろに書く | `restore_steps` |
| それ以外の節 | 紐づく過去問が、本文と問題解説で今も解けるなら戻さない（`write_materials.md` の「満たすべき最低条件」。問題解説が持つ値は問題解説に任せる）。1 の直し方だけを当てる。解けないときだけ、解くのに要る値・段を、図を指していた句の位置に戻す | `none`（1 の `action` だけ）か `restore_text` |

- 項目の文の点（値・条件）が、戻した段に全部入ったなら、その文を消す（`write_materials.md` の「1 つの点は 1 か所で言う」。例の値を並べただけの文の値が、全部段に出た、など）。段に無い点（今の図と合う、図を指す句など）が残る文は消さない
- 戻すのは過去問 1 件の分だけ。全選択肢の値は書かない（`write_materials.md` の「書き方の約束」）。過去問の問題文はそのまま写さない
- `### 計算の解き方` に、過去問の場面と値を出すだけで、番号付きの段にも続きの文にも解いた値が無い文があるときは、直し方を次の 1 つに決める。その過去問と同じ計算の型を節が既に 1 件解いていれば、その文を消す（`drop_text`。計算の 2 件目以降で、値の計算は問題解説の持ち場）。解いていなければ、その過去問の値で段を解く（`restore_steps`。形は上の表の `### 計算の解き方` の行のとおり）
- `figure_before` も旧版の図（束の `figures`）も紐づく過去問を解いていなかった図（もともと別の値だった）なら、計算の解き方に過去問の値が無いのは図の変更が原因でなく、旧版の教材にも無い値なので、`content_addition` に挙げる

### 3. 台帳の行の点が判断材料で、今の教材に無い

`ledger_row` のある項目は、次の順に決める。最初に当たった物にする。

| 場合 | 直し方 | `action`・`verdict` |
| --- | --- | --- |
| 点が旧版の教材（束の `current` の本文と、束の `figures` の図の中の文字と caption）のどこにも無い | 直さない（`write_materials.md` の「書き直し」の、旧版に無い内容を足さない。旧版は本文と図を合わせた教材で数える） | `none`・`not_applies`（`reason` は `not_in_previous`） |
| 点が問題解説に送ってよい物（`rewrite_materials_by_group.md` の `explanation` の定義。誤答のケア・計算の 2 件目以降・全選択肢の値）で、`where` の問題解説にその点がある | 直さない（`explanation` が正しい） | `none`・`not_applies`（`reason` は `explanation_ok`） |
| 図の見直しの段が図の直しを止めた申告の項目（`ledger_row` の `fate` が `figure`）で、点が判断材料でなく、問題解説に送ってよい物で紐づく過去問の問題解説にあるか、IT パスポートで `aside` の定義に当たる | 本文は直さず、台帳の行だけを `explanation`（`where` は解説のどこか）か `aside`（`where` に理由を 1 行）に書き換える（下の「点の台帳の直し方」） | `ledger_only`・`applies` |
| 図の直しを止めた申告の項目で、点が判断材料でなく、上の行にも当たらない（止めた直しで図から消えたあとの行き先が 8 つの `fate` のどれにも当たらない。応用情報の周辺知識。問題解説に送ってよい物だが、問題解説のどこにも無い） | 本文へ戻す（下の「戻し方」。`rewrite_materials_by_group.md` の「8 つのどれにも当たらない点は消さない」「解説に無ければ消さずに教材に残す」） | `restore_text`・`applies` |
| 点が問題解説に送ってよい物だが、`where` の問題解説にその点が無い | 直さない | `none`・`out_of_scope`（`not_fixed` に `undetermined`。`what` に、解説に無いこと） |
| 判断材料か問題解説に送ってよい物かが、紐づく過去問と問題解説から決まらない | 直さない | `none`・`out_of_scope`（`not_fixed` に `undetermined`） |
| 判断材料で、今の教材（範囲の 3 の数え方）にある | 本文は直さず、台帳の行だけを点のある所に直す（下の「点の台帳の直し方」） | `ledger_only`・`applies` |
| 判断材料で、今の教材のどこにも無い | 本文へ戻す（下の「戻し方」） | `restore_text`（旧版で図だけが持っていた過去問 1 件を解いてみせる手順・値は `restore_steps`）・`applies` |

- **判断材料**は、紐づく過去問のどれかの正解を選ぶのに要る事実・条件・例（`write_materials.md` の「書き直し」の「情報を落とさない」）。同じ事実が誤答の選択肢の `note` に出ていても、どれかの過去問の正解を選ぶのに要るなら判断材料。判定は、点を本文に無いものとして紐づく過去問を解き、正解を選ぶのにその点が要るかで見る（問題解説の `correct_reason` がその点で正解を言っていれば要る）。旧版で図だけが持っていた過去問 1 件を解いてみせる手順・値は、今の `### 計算の解き方` が同じ計算の型の別の過去問を既に解いていれば、計算の 2 件目以降（問題解説に送ってよい物）として表を引く（`write_materials.md` の「書き方の約束」の、計算の解き方は型ごとに 1 件）
- **誤答のケア**は、誤答の選択肢を打ち消すだけの説明で、どの過去問の正解を選ぶのにも要らない物

#### 戻し方（`restore_text`）

- 戻すのは、旧版の教材（本文と図）にあったその点だけ。旧版の言い方（図だけにあった点は、旧版の図の中の文字と caption）から点の事実を取り、**最短の形**（句か 1 文か、箇条の 1 項目か、表の 1 行か、番号付きの段。どれにするかは下の置く所で決まる）で書く。旧版の文・図に、点のほかの事実（台帳の別の行の点）が混ざっていれば、その事実は書かない
- 旧版で図だけが持っていた過去問 1 件を解いてみせる手順・値は、`### 計算の解き方` に置く（`action` は `restore_steps`）。形は「直し方」の 2 の `### 計算の解き方` の行のとおりで、その論点の段に値を入れ、節に番号付きの段が無いなら番号付きの段（1 段 1 動作）を例の条件を言う文の後ろに書く。戻すのは過去問 1 件の分だけで、全選択肢の値は書かない
- それ以外の点の置く所は、次の順に当て、最初に当たった所にする
  1. `detail` の、中身の型のブロックのうち、その点と同じ事柄（同じ対応・同じ条件・同じ例の並び）を述べている見出しの節。節の中では、その事柄を言う文・箇条・表の続きに置く（箇条の並びなら 1 項目、表なら 1 行、文章なら 1 文）。`### 混同しやすい用語` には、点が見分けそのものでない限り置かない
  2. 1 の節が無く、`explanation` に、その点と同じ事柄を言う要点の箇条があるときは、その箇条の続きに最短の形（句か 1 文）で置く。要点の箇条の数は増やさない
  3. 1 の節も 2 の箇条も無く、旧版の本文（束の `current`）でその点が `explanation` の要点の箇条だったときは、`explanation` の要点の箇条の 1 項目として、今の要点の箇条の並びの末尾に置く
- 1 の節が 2 つ以上あって決まらないとき、2 の箇条が 2 つ以上あって決まらないとき、1〜3 のどれにも当たらないとき、図だけが持っていた手順・値を置く `### 計算の解き方` がその論点の教材に無いときは戻さず、`undetermined` に挙げる（見出しを足さない・節を組み直さない）
- 書き方は `write_materials.md` の「書き方の約束」のとおり。事実を言う文にし、選択肢の消し方の言い方（「〜ではありません」で選択肢を打ち消す形）にしない。過去問の問題文と選択肢の文はそのまま写さない。全選択肢の値を書かない
- 図の見直しの段が図の直しを止めた申告の項目では、図がまだその点を言っていても、戻した文をなぞりに数えない（図の見直しの段が、その後にその点を図から外す）。報告の `what` に、止めていた図の直しが進められることを書く
- 戻したあと、紐づく過去問が、直した本文と問題解説で今も解けることを確かめる（「やること」の 3）

### 直してよい文

- 直してよいのは、項目の文（図を指す文・戻す値の入る段や文・3 で戻す点の文）と、それを直したために崩れる**隣の文のつなぎの語**だけ（消した文を受ける「反対に」「この」「上の例なら」）。つなぎの語を直すときも、文の他の字は変えない
- 一覧に無い文は 1 字も変えない。見出しの名前は変えない（図の `after` が指す）。節の構成・型・定義の文・キーワードは変えない
- 文体と記法は `write_materials.md` の「書き方の約束」と「使ってよい記法」のとおり（敬体・読点・`[[ ]]`）

### 直し方が 1 つに決まらないとき

次のときは直さず、`undetermined` に挙げる（`what` に、どの決まりの間で決まらないかを書く）。

- 文の「図」が、教材の図を指すのか、論点の中身としての図（本文が言葉で描いた例・過去問の図）を指すのかが、文と `figure_before` から決まらない
- 図を指す句を外すと、節の例・結論の文が成り立たなくなる（消すと節の例が無くなる）
- 3 で、判断材料か問題解説に送ってよい物かが決まらない。戻す置き場が「戻し方」の置く所の 1〜3 で 1 つに決まらない
- 1 の表・2 の表を当てても、直し方が 2 つ以上残る（番号付きの段のある節で、図に任せていた動作が段ではなく段の前の文に書かれていて、段を足すか文に値を入れるかが決まらない、など）
- 戻すと、正本の別の決まり（計算の解き方は型ごとに 1 件・過去問の図表を写さない）に当たる。ただし、`### 計算の解き方` の場面と値を出すだけで解いた値が無い文は、ここに当てず、「直し方」の 2 のとおりに消すか段を解く

## 点の台帳の直し方

形と `fate` の 8 つは `rewrite_materials_by_group.md` の「情報を落とさない確かめ方」のとおり。この段では新しいキーを足さない。書き換え方は `rewrite_unit_crosscheck.md` の「点の台帳の直し方」に合わせる。

- `restore_steps`・`restore_text` で戻した点が、台帳の行（`fate` が `figure` か `explanation`）の行き先にあったなら、その行の `fate` を `kept`、`where` を戻した見出し（`explanation` に戻したときは `explanation`）に書き換える。どの行にも無い点なら、その論点の `points` に 1 行足す（`fate` は `kept`）
- `drop_pointer` で外した句に点があったなら、その点の行き先に合わせて行を書き換えるか足す（行き先の決め方は「直し方」の 1。`explanation` にするのは、問題解説に送ってよい物だけ）
- 3 の `ledger_only` は、`ledger_row` の行の `fate` と `where` を、点のある所に書き換える（本文にあれば `kept` と見出しか `explanation`、その論点の図なら `figure` と図、他の論点なら `owner`・`prior`・`later` の定義のとおり。図の直しを止めた申告の項目で、点が問題解説にあるなら `explanation`、IT パスポートの周辺なら `aside`）。3 の `restore_text`・`restore_steps` は、上の 1 つ目のとおり `ledger_row` の行を `kept` と戻した見出しに書き換える。行は `ledger_row` の `point` の全文で引き、`point` は変えない
- 3 で直さなかった項目（`not_in_previous`・`explanation_ok`・`undetermined`）は、台帳の行を変えない
- `repoint`・図を指すだけの句を外した直し・つなぎの語の直しは台帳に書かない（点が消えていない）
- 台帳の他の行・`shared`・`removed_figures`・`fixed_captions` は変えない

## 書いてよいファイル・読むだけのファイル

- **書いてよい**: 一覧の論点を含む `data/<対象>/materials_v4/<単元>-<k>.json`（その論点の `explanation`・`detail` だけ）と、同じ束の `data/<対象>/rewrite_ledgers/<単元>-<k>.json`（上の「点の台帳の直し方」の範囲だけ）。ファイルの形は変えない（`rewrite_unit_crosscheck.md` の「書いてよいファイル・読むだけのファイル」のとおり）
- **読むだけ**: 図の仕様（`material_figures/`）・`figure_before` のファイル・問題解説・書き直しの束・過去問・正解表・単元の構成・`topics.json`・`topic_ids.json`・`glossary_overrides.json`・他の論点の教材・仕様書（`scripts/prompts/`）
- 直す前の `materials_v4` の退避と、良くならなかったときの戻しは親が行う。担当は退避を作らない・戻さない

## やらないこと

- 図の仕様・描いた図・問題解説・過去問・正解表・単元の構成・論点名を書き換えない。図の側に要る直しは `not_fixed` の `figure` に挙げる
- 範囲の外の直し（例を替える・説明を足す・なぞりを縮める・見出しの名前・学ぶ順と受け持ち・語の揺れ）をしない。気づいたら `not_fixed` に挙げる
- `glossary_overrides.json` に語を足さない
- 書き直しの束を作る道具（`build_rewrite_bundles.py`）・`build_material_bundles.py`・図の差し込みの道具（`attach_material_figures.py`）を実行しない
- 作業用の一時ファイルは、名前に対象と単元番号を含め、`data/` の外に置く

## 門（直したあとに担当が回す）

```bash
python3 scripts/check_materials.py --data data/<対象> --dir data/<対象>/materials_v4 --all
python3 scripts/check_material_style.py --data data/<対象> --dir materials_v4
python3 scripts/render_material_figures.py --data data/<対象> --check --only <一覧の論点 ID…>
python3 scripts/check_explanations.py --data data/<対象> --all
```

- 拾う指摘の範囲・止める理由を 0 にすること・知らせの数の比べ方は、`rewrite_unit_crosscheck.md` の「門」のとおり（担当が直した論点の指摘だけを拾う。3 つ目は `--only` に一覧の論点 ID を渡し、`after` の見出しが実在するままかを見る。4 つ目は担当が付けた `[[ ]]` の行だけを拾う）
- 字数は、一覧の論点の `explanation` と `detail` の文字数の合計を、直す前と後で数える。`restore_steps`・`restore_text` で増えるのはよい。それ以外の直しで増えたら、理由を報告に書く

## 報告（親へ）

報告の最後に、次の JSON を 1 つ置く（親が機械で集める）。報告のパスに同じ JSON を書く。直す物が無い一覧は `status` を `"none"` にする。

```json
{
  "target": "ip",
  "unit": "01",
  "status": "fixed",
  "blocked": [],
  "items": [
    {"no": 1, "source": "figures_review", "topic_id": 489, "figure": {"topic_id": 489, "figure_id": 1}, "verdict": "applies", "action": ["drop_pointer", "restore_steps"], "what": "「図の段の順に」を外し、2018h30a-q16 の値を手順 1〜3 に入れた。例の値を並べた文は手順に入ったので消した", "questions_checked": ["2018h30a-q16"]},
    {"no": 2, "source": "ledger", "topic_id": 14, "figure": null, "verdict": "applies", "action": ["restore_text"], "point_kind": "decisive", "what": "2018h30a-q7 の正解を選ぶのに要る。旧版の本文にあり今の本文と図に無いので、守られない物を並べた節に 1 項目で戻した", "questions_checked": ["2021r03-q7", "2018h30a-q7"]}
  ],
  "edits": [
    {"no": 1, "op": "replace", "topic_id": 489, "file": "data/ip/materials_v4/01-12.json", "field": "detail", "heading": "### 計算の解き方", "anchor": null, "before": "…", "after": "…"},
    {"no": 2, "op": "insert", "topic_id": 14, "file": "data/ip/materials_v4/02-1.json", "field": "detail", "heading": "### …", "unit": "line", "anchor": "…（足した行の直前の、変えていない行の全文）", "before": null, "after": "…（足した行の全文）"},
    {"no": 1, "op": "delete", "topic_id": 489, "file": "data/ip/materials_v4/01-12.json", "field": "detail", "heading": "### 計算の解き方", "unit": "sentence", "anchor": "…（消した文の直前の、変えていない文の全文）", "before": "…（消した文の全文）", "after": null}
  ],
  "ledgers": [
    {"file": "data/ip/rewrite_ledgers/01-12.json", "changed_points": 1, "added_points": 0}
  ],
  "not_fixed": [
    {"kind": "example", "no": 3, "topic_id": 243, "figure_id": 1, "what": "本文の例が 2023r05-q27 の場面と同じ。例を替える直し"}
  ],
  "not_fixed_counts": {"example": 1},
  "counts": {"applies": 1, "not_applies": 0, "out_of_scope": 1, "data_suspect": 0},
  "gates": {
    "check_materials": {"stops": 0, "warnings_before": 0, "warnings_after": 0},
    "check_material_style": {"stops": 0, "warnings_before": 0, "warnings_after": 0},
    "render_material_figures": {"stops": 0},
    "check_explanations": {"unresolved_terms_added": 0, "removed_pops": []},
    "unfixed_warnings": []
  },
  "chars": {"before": 0, "after": 0},
  "written": ["data/ip/materials_v4/01-12.json", "data/ip/rewrite_ledgers/01-12.json"]
}
```

- `blocked` は直さなかった項目の全件で、1 件は `{"no", "topic_id", "reason"}`。`reason` は `generation`（論点の `_generation` が `materials_v4` でない）か `ledger_changed`（今の台帳の行が `ledger_row` の写しと違う・`point` の全文で引けない）
- `items` は一覧の項目の全件（`no` で一覧と対応。`source` は一覧のまま）
  - `verdict` は `applies`・`not_applies`・`out_of_scope`・`data_suspect`
  - `not_applies` は `reason` を足す: `matches_figure`（今の図と合っている。同じ手順を別の値でたどる図を指す文を含む）・`not_in_text`（現物に申告の文が無い）・`already_fixed`（前の段で直っている）・`not_a_pointer`（文の「図」が論点の中身としての図）・`not_in_previous`（3 で、台帳の点が旧版の教材（本文と図）に無い）・`explanation_ok`（3 で、点が問題解説に送ってよい物で、問題解説にある）
  - `out_of_scope` と `data_suspect` は、`not_fixed` に同じ `no` の行を置く。1 つの項目が範囲の内と外を両方含むときは `verdict` を `applies` にし、外の分を `not_fixed` に置く
  - `action` は `repoint`・`drop_pointer`・`drop_text`・`restore_steps`・`restore_text`・`ledger_only`・`none` のどれか（複数なら配列）。`questions_checked` は解けるかを確かめた紐づく過去問の ID の全部（3 では判断材料かを判定した過去問を含む）
  - `ledger_row` のある項目は `point_kind` を足す: `decisive`（判断材料）・`explanation_side`（問題解説に送ってよい物）・`periphery`（どちらでもない周辺知識）・`undetermined`（決まらない）。`what` に、どの過去問の正解を選ぶのに要るか（要らないか）を書く
- `edits` は直した箇所の全件。`field` は直した欄（`explanation` か `detail`）、`heading` は直した所の `detail` の見出し（`field` が `explanation` なら `null`）。`op` は次の 3 つのどれか。親はこれで、一覧に無い文が変わっていないことを見る
  - `replace` — 文を書き換えた。`before` と `after` は、直した文（つなぎの語を直した隣の文を含む）の直す前と後の全文。`anchor` は `null`
  - `insert` — 文か行を足しただけ（前後の文は変えていない）。`before` は `null`、`after` は足した文か行の全文。`unit` は `sentence`（行の中に文を足した）か `line`（箇条の項目・表の行・段落を行ごと足した）。`anchor` は、足した所の直前の変えていない文（`sentence`）か行（`line`）の全文で、`field` の先頭に足したときは `null`
  - `delete` — 文か行を消しただけ。`before` は消した文か行の全文、`after` は `null`。`unit` と `anchor` は `insert` と同じ（消した所の直前）
  - 足して前の文のつなぎの語も直したときは、つなぎの語の直しを別の `replace` にする
- `ledgers` は書き換えた台帳ごとに、書き換えた行と足した行の数
- `not_fixed` の `kind` は上の「直さずに返す物」の表のどれか。`not_fixed_counts` はその件数。図が特定できる物は `figure_id` を付ける
- `counts` は `verdict` ごとの件数（0 の物も書く。`ledger_row` のある項目も同じ数え方で入る）。`gates` は上の「門」の結果、`unfixed_warnings` は直さなかった知らせと理由
- JSON の前の文には、項目ごとに「何を・なぜ」直したか（直さなかったか）を一覧の順で 1 行ずつ書く
- **書いたのは `materials_v4/` と `rewrite_ledgers/` の名指したファイルだけ**、と明記する

---

## 改訂履歴（本文は常に現在形。変えるときは該当の文を書き換え、ここに 1 行）

- 2026-11-15: 作成（図の見直しの段の `text_followup` のうち、図が変わって本文の図を指す文・図に任せていた過去問 1 件の手順が合わなくなった物だけを直す段。範囲と範囲の外・直し方の選び方（`repoint`・`drop_pointer`・`restore_steps`・`restore_text`）・1 つに決まらない物は返す・書いてよい範囲・門・一覧と報告の JSON。図の見直しの ip・ap の申告 16 件で直し方が決まるかを確かめた）
- 2026-11-15: 入力に点の台帳の行の見直しの項目（`source` が `ledger`。行き先 `explanation` の行）と、図の見直しの段が判断材料のために図の直しを止めた申告（`ledger_row`）を足し、範囲の 3 と直し方の 3（判断材料か問題解説に送ってよい物かを現物で判定し、判断材料で今の教材に無ければ旧版の点を最短の形で中身の型の節へ戻す。`ledger_only`）、1 体 16 件まで、報告の `edits` の `op`（置き換え・挿入だけ・削除だけ）と `blocked` の形を書いた。図の置き場の読み方を見出しの節の末尾にそろえ（REQ-470）、`drop_pointer` の点の行き先から正解の根拠の `correct_reason` を外した（ip 論点 14・ap 論点 1 で判断材料が教材から消えた。台帳 `brain/spec_consolidation/rewrite_text_followup.md`）
- 2026-11-15: 戻し方の置く所を、`detail` の同じ事柄の節 → `explanation` の同じ事柄の要点の箇条の続き（句か 1 文・箇条を増やさない）→ 旧版で要点の箇条だった点は要点の箇条 1 項目、の順に書き換え、台帳の `where` と報告の `edits` の `field`・`heading` をそろえた（後追いの 36 単元で判断材料の 7 件が置き場が無く `undetermined` で返った。ip 論点 18・336、ap 論点 399・381。台帳 `brain/spec_consolidation/rewrite_text_followup.md`）
- 2026-11-15: 「旧版に無い内容を足さない」の旧版を、束の `current` の本文と束の `figures` の図を合わせた教材で数える形に範囲の 3・直し方の 3 の表・`content_addition`・`not_in_previous`・入力の表をそろえ、旧版で図だけが持っていた過去問 1 件を解いてみせる手順・値は `### 計算の解き方` へ `restore_steps` の形で戻す（同じ型を既に解いていれば計算の 2 件目以降）を戻し方に書いた（X60。後追い r5 で ip 論点 258 図 1 が `not_in_previous` で行き場なく返り、図が過去問の値の写しのまま残った。台帳 `brain/spec_consolidation/rewrite_text_followup.md`）
- 2026-11-15: `### 計算の解き方` に過去問の場面と値を出すだけで解いた値が無い文は、同じ計算の型を節が既に解いていれば消し、解いていなければその過去問の値で段を解く（`restore_steps`）、を直し方の 2 に書き（消す直しの `action` は `drop_text`。報告の `action` の値に足した）、「直し方が 1 つに決まらないとき」から外した。図の仕様書の写しの線の名前に読む物と「図を指す文」に数えない物の参照を合わせた（X62・X61・X63。後追い r5 が `undetermined` で返し、3 回目の受入判定が不合格にした。台帳 `brain/spec_consolidation/rewrite_text_followup.md`）
- 2026-11-15: 図の見直しの段が図の直しを止めた申告の項目で、点が判断材料でない物の直し方を直し方の 3 の表に 2 行足した（問題解説にあるか IT パスポートの `aside` なら台帳だけを書き換える。どちらでもなく、図から外すと行き先が 8 つの `fate` のどれにも当たらない点は本文へ戻す）。範囲の 3・冒頭の箇条・`point_kind`（`periphery`）・点の台帳の直し方をそろえた（X68。後追い r8 で ap 論点 166・479・599・258 の 4 点が行き場なく返り、図の直しが止まったまま残った。台帳 `brain/spec_consolidation/rewrite_text_followup.md`）
