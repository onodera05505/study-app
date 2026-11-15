# 図の見直し（資格対策。単元の突き合わせの後。1 体が 1 単元の図の一覧を受け持つ）

書き直しの段（`scripts/prompts/rewrite_materials_by_group.md`）と単元の突き合わせの段（`scripts/prompts/rewrite_unit_crosscheck.md`）は、図の中身を変えない。
この段は、その 2 つの段と仕分けが「図に原因がある」として残した図を、親が作った一覧で受け取り、**図の仕様の JSON を直す**。
直すのは図の中身・caption・`after`・論点の間の移し替え・外した図の戻し・同じ内容の図を外すこと。教材の本文・問題解説・単元の構成は直さない（本文に要る直しは報告に挙げる）。

**図の決まりの正本は `scripts/prompts/material_figures_spec.md`、教材の書き方の正本は `scripts/prompts/write_materials.md`、点の台帳の正本は `scripts/prompts/rewrite_materials_by_group.md`。** この仕様書は、この段の入力・やること・書いてよい範囲・門・報告だけを決める。決まりで迷ったら正本に戻る（ここに書き写さない）。

---

## 先に読むもの（順に全部）

1. `scripts/prompts/material_figures_spec.md` — 全部。中でも「書くときの決まり」「過去問の答えを言わない・写さない」「図を付ける判断と、図だけで分かること」（閉じた図のテスト・同じ内容の図の判定）と、使う型の節
2. `scripts/prompts/write_materials.md` — 「1 つの点は 1 か所で言う」「他の論点との分担」「教材と問題解説の役割分担」「図の置き場」「書き方の約束」
3. `scripts/prompts/rewrite_materials_by_group.md` — 「情報を落とさない確かめ方」（点の台帳の形と `fate` の 8 つ）
4. `scripts/prompts/unit_plan.md` — 単元の構成の形（学ぶ順・受け持ち）
5. 担当の図の一覧（下の「入力」）と、一覧の図の論点の入力

## 親が渡すもの（可変部分）

親が指示で渡すのは **対象（`ip`・`ap`・`fe` のどれか）・担当する図の一覧のパス・報告のパス** の 3 つだけで、ほかはこの仕様書が決める。

### 1 体の担当範囲

- 1 つの一覧は **1 つの単元の中の図だけ**で、**12 枚まで**（一覧が名指す図と、移し替えの行き先の論点の図を合わせた図の枚数）、かつ **項目 16 件まで**（`items` の件数）
- 同じ論点の図は、全部同じ一覧に入る。移し替え・同じ内容の図の組・戻す図の組（行き先の論点・残す側の図）は、1 つの一覧から分けない。組を分けないと 12 枚を超えるときは、その組だけで 1 つの一覧にする
- 1 つの単元に一覧が 2 つ以上あるときは、前の担当が終わってから次の担当を起こす（同じ単元の点の台帳を 2 体が並行して書かない）。違う単元の一覧は並行してよい

## 入力

### 図の一覧（親が渡すパス。JSON）

```json
{
  "target": "ip",
  "unit": "23",
  "items": [
    {
      "no": 1,
      "figure": {"topic_id": 213, "figure_id": 1},
      "source": "triage",
      "kind": "answer",
      "what": "セルが 2024r06-q73 の選択肢ア〜エを人／機械で振り分け、強調が正解エ",
      "proposal": "対策の例を選択肢と違う物にする",
      "questions": ["2024r06-q73"],
      "related": [],
      "restore_from": null
    }
  ]
}
```

| 欄 | 中身 |
| --- | --- |
| `target`・`unit` | 対象と単元番号（2 桁）。担当の範囲はこの単元 |
| `items[].no` | 一覧の中の通し番号（報告で指す） |
| `items[].figure` | 見直す図（論点 ID と図 ID）。戻す図は、戻す先の論点 ID と外す前の図 ID |
| `items[].source` | 出どころ。`triage`（量産の報告の仕分けで「直す必要がある図」・「軽い直し」）・`not_fixed`（突き合わせの報告の `not_fixed` の図の種類。突き合わせの `figure_spec` は、親が `what` の中身で `heading`（指す見出しの物）・`order`（置く順の物）・`error`（それ以外の図の仕様の誤り）のどれかに振り分ける）・`figure_duplicates`（突き合わせの報告の同じ図の組）・`learner`（学習者役の指摘のうち図に当たる物）・`removed`（外した図のうち外すべきでなかった疑いの物）・`closed_test`（下の「閉じた図のテスト（親が回す）」で、比べる担当の判定が `一部` か `言えない` だった図。`kind` は `small`。`what` は親が、判定・比べる担当の所見・見る担当の 1 文・言えるべき 1 文（`intended_point`）・見る担当が分からなかった所を入れる）・`review`（この段の前の回の報告の `not_fixed` が、一覧に無い図として挙げた図（過去問の値・場面の写しや答えの名指しの疑い）。親が現物の申告を読んで `kind`（`copy`・`answer` など）を付ける）・`open_items`（申告の消化の段の報告の `returned` が `figure_followup` で返した図と、`noticed` が挙げた図。親が申告を読んで `kind` を付け、`what` に申告の文をそのまま入れる）・`acceptance`（受入の判定が「出す前に直すべき物」として挙げた図。親が所見を読んで `kind` を付け、`what` に所見の文をそのまま入れる） |
| `items[].kind` | 見直す種類。下の「種類と直し方」の表の名前 |
| `items[].what`・`proposal` | 指摘の要約と直し方の案。**候補として使い、現物で確かめる**（案に縛られない） |
| `items[].questions` | 指摘が名指した過去問の ID（無ければ空）。答えの判定はこれに限らず、その論点の紐づく過去問の全部で行う |
| `items[].related` | 組になる図（同じ内容の図の組・食い違う相手の図・移し替えの行き先の論点の図。`{"topic_id", "figure_id"}`。行き先の論点に図が無いときは `{"topic_id", "figure_id": null}`） |
| `items[].restore_from` | `kind` が `restore` のとき、外す前の図の JSON（`figures[]` の 1 件）を置いたファイルのパス。親が用意する。それ以外は `null` |

### 一覧の図の論点ごとに読む物

| 読む物 | パス | 使う欄 |
| --- | --- | --- |
| 図の仕様 | `data/<対象>/material_figures/<論点 ID>.json` | 全部 |
| 単元の構成 | `data/<対象>/unit_plans/<単元>.json` | `groups[]`（学ぶ順）、`owners[]`（受け持ち） |
| 教材 | `python3 scripts/material_generations.py --data data/<対象>` の標準出力の `materials`（`topic_id` は文字列） | `_generation`、`explanation`・`detail`（`after` の見出しの実在と、図を置く位置の前後の本文） |
| 書き直しの束 | `data/<対象>/rewrite_bundles/<単元>-<k>.json`（その論点を含む束） | 論点の `questions`（`question_id`・`stem`・`choices`・`answer`・`has_figure`・`figure_description`）、`question_explanations`（`correct_reason`・`choices[].note`） |
| 点の台帳 | `data/<対象>/rewrite_ledgers/<単元>-<k>.json` | 論点の `points`（`fate` が `figure` の行）・`removed_figures` |
| 論点の一覧 | `data/<対象>/topics.json` | `term`（図の中の語が学ぶ順で後の論点名か、同じ語の意味の正本はどの論点か） |

- 担当の単元の論点で、一覧に出る論点の `_generation` が全部 `materials_v4` であることを確かめる。違えば、その論点の項目は何も直さず、報告の `blocked` に挙げる
- **紐づく過去問**は、その論点の束の `questions`（同一内容の問題は 1 件に畳んである）。答えの判定は、名指しの過去問だけでなく、その論点の `questions` の全部と並べる。移し替えの行き先の論点では、行き先の論点の `questions` とも並べる

## やること（項目ごと。一覧の順に）

1. **現物で確かめる。** 図の JSON と、描いた画像（下の「門」の PNG）を見る。指摘の当否を、図の仕様書の決まりと紐づく過去問の現物（問題文・選択肢・正解）で決める。報告の `verdict` に `applies`（当たる）・`not_applies`（当たらない。理由を付ける）・`data_suspect`（過去問のデータが壊れて見える）のどれかを付ける
2. **データが壊れて見える物は直さない。** 問題文・選択肢・正解・図の説明が原本と違うように見えるとき（正解が問題文と合わない、選択肢の字が欠ける、など）は、図も直さずに報告の `not_fixed` に `question_data` で挙げる（原本の画像との照合は親が行う）
3. **直し方を選ぶ**（下の「種類と直し方」）。直すのは指摘の当たる所だけでなく、その図の全体を図の仕様書の今の決まりに合わせる（1 枚の図の中で他の決まりに当たる所が残らないように）。一覧に無い図は直さない
4. **直した図を、紐づく過去問と並べてもう一度見る。** 答え合わせと写しが、caption と図の中身に残っていないこと（判定の問いと線は図の仕様書の「過去問の答えを言わない・写さない」。論点の芯が答えと重なるのは残す）
5. **解けるかを確かめる。** その論点（と移し替えの行き先・元の論点）の紐づく過去問が、教材（直した図の中の文字と caption を含む）と問題解説で今も解けること（正解は `answer` に従う）。図から外した値・例が解くのに要るなら、それが本文か問題解説にあることを確かめる。無ければその直しはせず、報告の `not_fixed` に `text_followup` で挙げる（問題解説にあっても、正解の根拠が本文に無いときの扱いは下の「点の台帳の直し方」）
6. **点の台帳を合わせる**（下の「点の台帳の直し方」）
7. **門を通す**（下の「門」）

### 種類と直し方

| `kind` | 何か | 直し方 |
| --- | --- | --- |
| `answer` | 答え合わせ（答え合わせの印・選択肢と問題文の言い回し・本文が説明していない誤答の否定・振り分け・論点の芯でなく答えに当たるだけの強調・caption の計算の答えの値と問いへの答えの形の文） | 図の仕様書の「過去問の答えを言わない・写さない」のとおり、例・値・注記・強調・caption を直す。要点を運ぶ芯（論点の定義・規則そのもの）は残す |
| `copy` | 過去問の値・登場物と題材・図表・振り分けの事例の写し（計算の手順の図を含む） | 図の仕様書の「過去問の答えを言わない・写さない」の線（値・登場物と題材・骨組み・図表・振り分け）で写しに当たる物を、同じ種類の別の物に変える。値を変えたら図の中の計算を全部合わせ直す（途中の値・結果・注記・軸の範囲） |
| `body_rule` | 本文の決まり（計算の解き方は過去問 1 件まで・全選択肢の値を出さない・誤答のケアは問題解説）で本文から外した物を、図が持つ | その値・例題・注記を図から外す。外した物が解くのに要るなら、手順の 5 |
| `error` | 図の中身の誤り（丸の位置とラベル、caption と強調の食い違い、用語の取り違え。突き合わせの `figure_spec` のうち見出しと置く順のどちらでもない物を含む） | 正しい側を、問題解説・その語を論点名に持つ論点の定義の文・紐づく過去問で言えるなら、図をそちらに合わせる。言えないなら直さず `not_fixed` に `unverified` で挙げる |
| `text_mismatch` | 本文と図の食い違い（突き合わせの `figure_text_mismatch`） | `error` と同じ材料で正しい側を決める。図が違うなら図を直す。本文が違うなら図は直さず `not_fixed` に `text_followup` で挙げる |
| `drawing` | 図の描き方が本文の説明と合わない（矢印の向き・段の数・並び。突き合わせの `figure_drawing`） | 本文の説明に合わせて図を直す（型を変えてよい。図 ID は変えない） |
| `figure_only_term` | 図の中の文字にだけ出て、本文に説明の無い語 | 図より前の本文で説明された語に言い換えるか、その項目のラベルの 2 行目（名前＋一言の一言）で意味を言う。学ぶ順で後の論点の語なら、次の `order` |
| `heading` | 図が指す見出しが中身と合わない（突き合わせの `figure_spec` のうち指す見出しの物） | その論点の教材に実在する、図の要点を述べている見出しへ `after` を移す。合う見出しが無いなら直さず `not_fixed` に `text_followup` で挙げる（見出しの名前は直さない） |
| `order` | 学ぶ順・持ち場の食い違い（前の論点の図に後の論点の語や比較が入る、受け持ちでない論点が図を持つ、3 つ以上の比較を最初の論点が持つ。突き合わせの `figure_spec` のうち置く順の物を含む） | 後の論点の語の列・項目・箱を外すか、図ごと持つべき論点へ移す（下の「論点の間の移し替え」）。持つ論点は `write_materials.md` の「他の論点との分担」「図の置き場」と単元の構成の受け持ち。`after` を変えて決まりを避けない |
| `meaning` | 同じ語を図ごとに違う意味で描く | 図の仕様書の「同じ語は、どの図でも同じ意味で描く」のとおり、正本の意味に合わせるか、2 つの意味を書き分ける |
| `duplicate` | 同じ内容に見える図の組（突き合わせの `figure_duplicates`・束をまたぐ同じ図） | 図の仕様書の「同じ内容の図の判定」で決める。同じ内容なら、持たない側を外す（下の「外す」）。同じ内容でなく要点の一部が重なるなら、持たない側の図から重なる項目を外す |
| `restore` | 外した図のうち、残る図が要点を運んでいない疑いの物 | 「同じ内容の図の判定」を残る図に当てる。同じ内容でなければ、`restore_from` の図を元の論点に戻す（下の「戻す」）。同じ内容なら戻さず、`verdict` を `not_applies` にする |
| `small` | 小さすぎる `blocks` の警告・閉じた図のテストに通らない疑い | 図だけで要点が言えるように直す。本文だけで一言で言える要点なら、下の「外す」の 2 の条件で外す |

#### 論点の間の移し替え

- 移せるのは**単元の中の論点の間だけ**。単元をまたぐ移し替えはせず、報告の `not_fixed` に `cross_unit` で挙げる
- 行き先の論点の教材に、図の要点を述べている見出しが実在するときだけ移す（`after` はその見出しか、要点そのものの図で行き先に `after: "explanation"` の図が無いときは `explanation`）。無ければ移さず `not_fixed` に `text_followup` で挙げる
- 行き先での図 ID は、行き先のファイルの今の最大の ID ＋ 1。元の論点からはその図を `figures` から外す（残りの図の `id` は詰め直さない）
- 移した図も、行き先の論点の学ぶ順の位置で図の仕様書の決まり（図の中の語・答え・写し）に合わせる

#### 外す

外せるのは、次の 1 か 2 のどちらかで、かつ外す論点（と残す側の論点）の紐づく過去問が、残る図・教材・問題解説で解けるときだけ。

1. 同じ内容の図が単元の中に残る（図の仕様書の「同じ内容の図の判定」で同じ内容。残すのは `write_materials.md` の「図の置き場」が持つとする側）
2. 図の要点が、その論点の本文だけで一言で言える（図の仕様書の「本文だけで一言で言える要点は図にしない」）うえ、図にしか無い点が無い

#### 戻す

- `restore_from` の図を、元の論点の `figures` に加える。図 ID は、元の ID が今のファイルに無ければ元の ID、あれば最大の ID ＋ 1
- `after` を今の教材に実在する見出しに合わせ、図の仕様書の今の決まりに合わせて中身を見直す（戻す図も一覧の図として扱う）

### 点の台帳の直し方

形と `fate` の 8 つは `rewrite_materials_by_group.md` の「情報を落とさない確かめ方」のとおり。この段では新しいキーを足さない。

- 直した図・外した図・移した図を `where` に持つ行（`fate` が `figure`）を探し、点の行き先を今の場所に書き換える
  - 移した図: `where` を行き先の論点 ID と新しい図 ID に
  - 外した図: `where` を残る図に（1 で外した）。2 で外した図は、点のある本文の見出しにし、`fate` を `kept` に
  - 中身を直したが点の事柄（手順・関係）は直した図に残り、図から消えるのが例の値だけで、その値がどの紐づく過去問の正解の根拠でもない（同じ手順を別の値でたどる図に替えた、など）: `fate` は `figure` のまま、`where` を今の図に合わせる（直した図の論点 ID と図 ID。`where` に例の値を書いているなら今の値に）
  - 上に当たらず、中身を直して点が図から消えた（過去問の値を別の値にした、など）: 点が本文にあれば `kept` と見出し。本文に無く、点が `rewrite_materials_by_group.md` の `explanation` の定義で問題解説に送ってよい物（誤答のケア・計算の 2 件目以降・全選択肢の値）で、問題解説にあれば `fate` を `explanation`・`where` を解説のどこか。点が正解の根拠（判断材料）で本文に無いときは、問題解説にあっても `explanation` にせず、その直しはせずに `not_fixed` に `text_followup` で挙げる（本文へ戻す申告。`what` に、戻す点・台帳のファイルとその行の `point`・止めた図の直し）。どこにも無いときも同じ。旧版で図だけが持っていた過去問 1 件を解いてみせる手順・値（正解の根拠）も同じで、本文の後追いの段（`scripts/prompts/rewrite_text_followup.md`）が旧版の教材にあった内容として本文の `### 計算の解き方` へ戻す
- 外した図は、外した論点の束の台帳の `removed_figures` に 1 件足す（`figure_id`・`caption`・`kept`）。戻した図は、`removed_figures` からその図の行を消す
- 台帳の他の行・`shared`・`fixed_captions` は変えない

## 書いてよいファイル・読むだけのファイル

- **書いてよい**: 一覧の図の論点（移し替えの行き先と元を含む）の `data/<対象>/material_figures/<論点 ID>.json`、その論点の束の `data/<対象>/rewrite_ledgers/<単元>-<k>.json`（上の「点の台帳の直し方」の範囲だけ）、描いた図（下の「門」の 2 つ目が書く `public/figures/materials/<対象>/<論点 ID>-<図 ID>.svg`）、報告のパスと同じフォルダの `figures_png/<対象>-<単元>/`（目で見る PNG）
- **読むだけ**: 教材の全世代（`materials/`〜`materials_v4/`）、単元の構成、書き直しの束、問題解説、過去問・正解表、`topics.json`・`topic_ids.json`、仕様書（`scripts/prompts/`）、`restore_from` のファイル
- 外した図・移した図の元の SVG は消さない（配る置き場から消すかは親が決める）

## やらないこと

- 教材の本文（`materials_v4/` ほか）・問題解説・過去問・正解表・単元の構成・論点名を書き換えない。本文に要る直しは `not_fixed` の `text_followup` に挙げる
- 一覧に無い図を直さない・新しい図を足さない（戻す図を除く。欲しい図が足りないという指摘は内容の補いで、`not_fixed` の `content_addition` に挙げる）
- 図の仕様書の決まり・門の判定を変えない。門の誤検出と見える物は直さず、報告に挙げる
- 書き直しの束を作る道具・`build_material_bundles.py`・図の差し込みの道具（`attach_material_figures.py`）を実行しない。教材の代替文は、親が図を差し込むときに caption から作り直す
- 作業用の一時ファイルは、名前に対象と単元番号を含め、`data/` の外に置く

## 門（直したあとに担当が回す）

```bash
python3 scripts/render_material_figures.py --data data/<対象> --check --only <一覧の図の論点 ID…>
python3 scripts/render_material_figures.py --data data/<対象> --only <一覧の図の論点 ID…>
python3 scripts/render_material_figures.py --data data/<対象> --only <一覧の図の論点 ID…> \
    --out <報告のフォルダ>/figures_png/<対象>-<単元> --png-dir <報告のフォルダ>/figures_png/<対象>-<単元>
```

- 1 つ目は図の門。止める理由は 0 にする。警告は直す前と後で数を比べ、増えた警告は直すか、直さない理由を報告に書く
- 2 つ目で配る置き場へ描き、3 つ目で目で見る PNG を書く。**直した図・移した図・戻した図は全部、PNG を目で見る**（文字のはみ出し・矢印が箱に届くか・強調の位置・caption が指す所。PNG で壊れて見える物は図の仕様書の「PNG で「壊れて見える」もの」）
- 閉じた図のテストは、図を直した担当ではなく親が別の担当に PNG だけを渡して行う（下の「閉じた図のテスト（親が回す）」）。担当は自分で確かめたとはしない。親に渡すため、直した図ごとに、その図が受け持つ要点の 1 文（`intended_point`）を報告に書く

## 閉じた図のテスト（親が回す）

この節は親が読む。テストの決まりの正本は `material_figures_spec.md` の「閉じた図のテスト」「同じ内容の図の判定」で、ここは回し方だけを決める。

### 対象と PNG

- 対象は、見直しで直した・移した・戻した図（報告の `changed_figures`）と、`same_content` で外したときの残した側の図（報告の `removed` の `kept`）
- 最終の図の仕様から PNG を描き直して使う。置き場は学びの置き場（`data/`・`public/`）の外

```bash
python3 scripts/render_material_figures.py --data data/<対象> --only <論点 ID…> --out <置き場> --png-dir <置き場>
```

### 束と 2 体の担当

束は単元ごと・図 12 枚まで。1 束につき、次の 2 体を順に起こす。

1. **見る担当**: PNG のパスの一覧だけを渡す（caption・本文・JSON・仕様書・`intended_point` は渡さない）。図ごとに「この図が言っていること」を 1 文と、分からなかった所を返させる。役は `scripts/prompts/rewrite_unit_learner.md` の「役の 1 文の決め方」の対象ごとの役に合わせる
2. **比べる担当**（見る担当とも、図を直した担当とも別の文脈）: `material_figures_spec.md` の「閉じた図のテスト」「同じ内容の図の判定」を読ませ、見る担当の 1 文を `intended_point` と比べさせる。図ごとに次の判定を付け、欠点が図の側か読み手の側かを所見に書かせる
   - `言えた` — 要点の芯を言えた
   - `一部` — 芯が欠けた
   - `言えない` — 要点を言えなかった
   - `対象外` — `intended_point` が無い（残した側として見ただけの図）
   - 外した図の組は、残した側の図だけで外した図の要点が言えるかを `言える`・`言えない` で付ける

- 親は、見る担当の答えを要約・選別せずに比べる担当へ渡す
- PNG で長音符「ー」と中黒「・」が抜けて見えるのは、`material_figures_spec.md` の「PNG で「壊れて見える」もの」の既知の見え方で、欠点に数えない

### 判定の後

- `一部`・`言えない` の図は、`source` を `closed_test` にして追加の一覧に入れ、もう一度この段に掛ける
- 外した図の組で `言えない` なら、その外した図を `kind` が `restore` の項目として追加の一覧に入れる
- 追加の一覧で直した図にも、同じテストを掛ける

## 報告（親へ）

報告の最後に、次の JSON を 1 つ置く（親が機械で集める）。報告のパスに同じ JSON を書く。直す物が無い一覧は `status` を `"none"` にする。

```json
{
  "target": "ip",
  "unit": "23",
  "status": "fixed",
  "blocked": [],
  "items": [
    {"no": 1, "figure": {"topic_id": 213, "figure_id": 1}, "kind": "answer", "verdict": "applies", "action": "edit", "what": "対策の例を入館時の本人確認・ファイアウォールに替え、強調を外した", "questions_checked": ["2024r06-q73", "2021r03-q61"]}
  ],
  "changed_figures": [
    {"topic_id": 213, "figure_id": 1, "png": "<報告のフォルダ>/figures_png/ip-23/213-1.png", "intended_point": "情報セキュリティの対策は、人が守る物と仕組みが守る物に分かれる"}
  ],
  "moved": [
    {"from": {"topic_id": 55, "figure_id": 1}, "to": {"topic_id": 388, "figure_id": 3}, "after": "### CSR との違い"}
  ],
  "removed": [
    {"topic_id": 305, "figure_id": 2, "caption": "…", "kept": {"topic_id": 245, "figure_id": 2}, "reason": "same_content"}
  ],
  "restored": [
    {"topic_id": 428, "figure_id": 2, "after": "### 日常的と独立的"}
  ],
  "ledgers": [
    {"file": "data/ip/rewrite_ledgers/23-1.json", "changed_points": 1, "removed_figures_added": 0, "removed_figures_dropped": 0}
  ],
  "not_fixed": [
    {"kind": "text_followup", "no": 4, "topic_id": 471, "figure_id": 1, "what": "要点の図を置ける見出しが本文に無い"}
  ],
  "not_fixed_counts": {"text_followup": 1},
  "counts": {"applies": 1, "not_applies": 0, "data_suspect": 0},
  "gates": {
    "render_check": {"stops": 0, "warnings_before": 0, "warnings_after": 0},
    "unfixed_warnings": []
  },
  "written": ["data/ip/material_figures/213.json"]
}
```

- `items` は一覧の項目の全件（`no` で一覧と対応）。`verdict` は `applies`・`not_applies`・`data_suspect`。`not_applies` は `reason` を足す（`rule_allows`＝図の仕様書の決まりが認める形、`not_in_figure`＝現物に無い、`already_fixed`＝前の段で直っている）。`action` は `edit`（中身）・`caption`・`after`・`move`・`remove`・`restore`・`none` のどれか（複数なら配列）。`questions_checked` は並べた紐づく過去問の ID の全部
- `changed_figures` は、直した・移した・戻した図の全部（今の論点 ID と図 ID）。`intended_point` は閉じた図のテストで言えるべき 1 文
- `removed` の `reason` は `same_content`（外すの 1）か `text_suffices`（外すの 2）。`kept` は 2 のとき `null`
- `not_fixed` の `kind` は次のどれか。`not_fixed_counts` はその件数
  - `question_data` — 過去問のデータが壊れて見える（原本との照合待ち）
  - `text_followup` — 本文の側の直しが要る（本文の食い違い・見出しが無い・外した値が本文にも解説にも無い）
  - `unverified` — 材料で正しい側が言えない
  - `cross_unit` — 単元をまたぐ移し替え・同じ内容の図
  - `unit_plan` — 学ぶ順・受け持ちが合わない（単元の構成を変えないと直せない）
  - `content_addition` — 新しい図が欲しいという指摘（内容の補い）
  - `gate` — 門の誤検出と見える物
  - `other` — どれにも当たらない物（`what` に理由）
- JSON の前の文には、項目ごとに「何を・なぜ」直したか（直さなかったか）を一覧の順で 1 行ずつ書く
- **書いたのは `material_figures/`・`rewrite_ledgers/` の名指したファイルと、描いた SVG・PNG だけ**、と明記する

---

## 改訂履歴（本文は常に現在形。変えるときは該当の文を書き換え、ここに 1 行）

- 2026-11-15: 種類の表の `answer` の何かと手順の 4 を、図の仕様書の書き換えた線（答え合わせの印・言い回し・誤答の否定・caption・強調。論点の芯が答えと重なるのは残す）に合わせた（X64。「答え」の並べ書きが論点の芯の図まで直す対象に読めた。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）
- 2026-11-15: 手順の 4 と種類の表の `copy` の写しの中身を、図の仕様書の「過去問の答えを言わない・写さない」の線の参照に書き換えた（X61。写しの線を図の仕様書の 1 か所に置くため。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）
- 2026-11-15: 図を別の値に替えても点の事柄が図に残り、消えるのが正解の根拠でない例の値だけのときは `fate` を `figure` のまま `where` を今の図に合わせる、を点の台帳の直し方に書き、旧版で図だけが持っていた過去問 1 件を解く手順・値は本文の後追いの段が `### 計算の解き方` へ戻す、を本文へ戻す申告の文に足した（X60。後追い r5 で ap 論点 38 図 2 が `undetermined`、ip 論点 258 図 1 が `not_in_previous` で行き場なく返った。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）

- 2026-11-15: 図から消えた点の行き先を、書き直しの仕様書の `explanation` の定義の線で振り分ける形に書き換えた（正解の根拠は問題解説にあっても `explanation` にせず、図の直しを止めて本文へ戻す申告にする。ip 論点 14・ap 論点 1 で判断材料が教材から消えた。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）

- 2026-11-15: 1 体の担当範囲に項目 16 件までを足した（項目 17・図 12 の一覧で余裕が 2〜3 割だったため）。`source` に `closed_test`・`review` を足し、閉じた図のテストの回し方（対象と PNG・見る担当と比べる担当・判定の後）を節に起こした（親が見直しの後に回した手順を仕様書へ落とした。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）

- 2026-11-15: `fate` の数を書き直しの仕様書の 8 つに合わせ、突き合わせの `figure_spec` は親が `what` の中身で `heading`・`order`・`error` に振り分ける、を入力の節と種類の表に書いた（`brain/research/2026-11-15_教材の様式/03_量産の結果と単元の突き合わせ.md` の X54。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）
- 2026-11-15: 作成（書き直しと単元の突き合わせの後に、図の仕様の JSON を直す段。入力の一覧・1 体 12 枚まで 1 単元・種類と直し方・移し替え・外す・戻す・点の台帳・門・報告の JSON。`brain/research/2026-11-15_教材の様式/03_量産の結果と単元の突き合わせ.md` の X20・X24・X27・X36・X37）
- 2026-11-16: `source` に `open_items`（申告の消化の段が図の側へ返した図）を足した（申告の消化の後に図の見直しへ戻す一覧を作るため。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）
- 2026-11-16: `source` に `acceptance`（受入の判定が挙げた図）を足した（受入が挙げた図をこの段へ戻す一覧を作るため。台帳 `brain/spec_consolidation/rewrite_figures_review.md`）
