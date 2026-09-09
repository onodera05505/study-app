# study-app

IT パスポート試験に**最短で合格する**ための学習アプリ。身内・友人・会社の人が気軽に使えるものを目指す。

過去問（IPA 公開分）を起点に、その背後にある**論点**を学習単位として構成する。
単なる過去問暗記にせず、周辺知識を添えて理解を深められるようにするのが方針。

- 要件定義: [`docs/要件定義書_draft.md`](docs/要件定義書_draft.md)
- 開発の経緯: [`docs/作業ログ_2026-08-23.md`](docs/作業ログ_2026-08-23.md)

## 設計の中核

**論点に紐づく過去問の件数＝出題頻度＝重要度。** 頻出論点から潰すのが最短合格経路になる。

```
論点（例:「損益分岐点」）
  ├─ 解説・周辺知識          ← 学習する対象はこっち
  └─ 紐づく過去問（M:N）      ← この件数が重要度になる
```

テーマ分けは自前で作らず、**IPA シラバス Ver.6.5 の階層**（3分野 → 9大分類 → 23中分類 → 63項目）に乗せる。
合格条件が分野単位の AND 条件なので、分類が分野に接続していないと
「マネジメント系が足りない」という最も重要なフィードバックが出せないため。

## 現在のデータ

| 項目 | 数 |
| --- | --- |
| 取り込み済みの回 | **11回**（平成30年度春期〜令和8年度）／ 公開されているのは29回 |
| 過去問 | **1,100問** |
| 論点 | **532件**（うち複数回出題 234件） |
| 教材（解説・周辺知識） | **532 / 532 論点** |
| 図の画像 | **39問**（図として描かれた問題のみ。表・擬似言語は文章のまま） |

回の追加手順は [`docs/回を追加する手順.md`](docs/回を追加する手順.md) を参照。
論点 ID は固定されているので、回を追加しても学習の進捗と教材はずれない。

## 機能

| 機能 | 内容 |
| --- | --- |
| **学習** | 分野 → 中分類 → 論点。既定の並びは出題頻度順。論点ごとに解説・周辺知識・出題された過去問を読み、理解度を3段階（未理解／やや理解／理解）で記録 |
| **練習テスト** | 論点ドリル（その論点の過去問だけ）／分野別演習／弱点復習（間違えた問題） |
| **過去問実践** | 公開回をそのまま100問120分で通す、または全範囲からランダム100問。分野別の正答率と合否目安を表示 |

## 技術構成

| 層 | 技術 |
| --- | --- |
| API | Hono（Cloudflare Workers） |
| DB | Cloudflare D1 + Drizzle ORM |
| フロント | React + Vite（SPA, React Router） |
| 配信 | Workers Assets。API と静的配信を**同じ Worker から1デプロイ** |
| 認証 | JWT（HS256）+ PBKDF2（Web Crypto） |

`bcryptjs` は Workers 上で純 JS 実装になり CPU 時間を食うため使わず、Web Crypto の PBKDF2 を使っている。

## セットアップ

```bash
npm install
pip install pymupdf          # コンテンツ取り込みスクリプト用

# DB を作って初期データを入れる
npx wrangler d1 migrations apply study-app-db --local
python3 scripts/build_seed.py
npx wrangler d1 execute study-app-db --local --file=data/seed.sql

# 起動（API + 静的配信が 8787 で一体）
npm run build
npx wrangler dev
```

管理ユーザは `build_seed.py --admin-password <パスワード>` を**渡したときだけ**作られる
（`admin@example.com` / ADMIN）。渡さなければ `users` には一切触らない。

以前は既定のパスワードで必ず作っていたため、公開中の2サイトとも既知のパスワードで
ログインできる状態が続いていた（2026-08-31 に交換）。回を追加して再投入するたびに
パスワードが既定値へ戻る作りでもあったので、**既定では作らない**ようにしてある。
アプリを使うだけなら管理ユーザは要らない（新規登録から普通のユーザを作ればよい）。

フロントだけホットリロードしたい場合は `npm run dev`（5173、`/api` は 8787 に転送）。

### 本番

**公開先: https://itpass-study-c91.pages.dev**

新規登録には合言葉（`SIGNUP_CODE`）が要る。身内以外が勝手に登録できないようにするため。

#### なぜ Workers ではなく Pages か

workers.dev の URL は `<worker名>.<アカウント共通サブドメイン>.workers.dev` という形で、
**アカウント共通サブドメインにアカウント名が入る**。これを変えると同じアカウントの
同じアカウントで稼働中の他の Worker の URL も一斉に変わってしまう。

Pages の URL は `<プロジェクト名>.pages.dev` でアカウント名を含まないため、
**他のプロジェクトに影響を出さずに済む**。この理由で Pages を選んでいる。

Worker 版（`study-app`）は残してあるが、workers.dev は無効化済みで URL からは到達できない。

#### デプロイ

```bash
npm run deploy      # scripts/deploy-pages.sh を実行する
```

このスクリプトは、フロントのビルド → Worker を1ファイルに束ねて `dist/_worker.js` に配置
→ Pages へデプロイ、までを行う。Pages は wrangler 設定ファイルのカスタムパスに対応して
いないため、Workers 用の `wrangler.jsonc` を一時退避してから実行する。

データ（過去問・論点・教材）を更新したときは、DB への反映を別途行う:

```bash
scripts/backup_d1.sh ip                        # 先に本番を吸い出しておく
python3 scripts/build_seed.py --data data/ip
python3 scripts/check_seed.py --data data/ip   # 投入前に中身を見る
npx wrangler d1 execute study-app-db --env ip --remote --file=data/ip/seed.sql
```

**`--remote` を付け忘れるとローカルの D1 に入るだけで本番は変わらない。**

#### バックアップ

進捗（`progress`）と受験履歴（`sessions`）は**本番 D1 にしか無い**。問題・論点・教材は
`data/` から作り直せるが、進捗は作り直せない。しかも seed の投入は
`DELETE FROM topics WHERE id NOT IN (…)` を含み、`progress` は ON DELETE CASCADE なので、
**中身のおかしい seed を流すと理解度が消える**。

```bash
scripts/backup_d1.sh          # 両方の D1 を backups/ に吸い出す（git 管理外）
scripts/backup_d1.sh ap       # 片方だけ
```

投入の直前に取るのを習慣にする。Cloudflare の Time Travel でも直近30日は戻せるが、
手元に現物があるほうが速い。

secret（`JWT_SECRET` / `SIGNUP_CODE`）は Pages プロジェクト側に設定する。合言葉を変えるなら:

```bash
npx wrangler pages secret put SIGNUP_CODE --project-name ap-am-study   # ip なら itpass-study
scripts/deploy-pages.sh ap                                            # ← 再デプロイまでが1セット
```

**secret は更新しただけでは反映されない。** 稼働中のデプロイは古い値を持ち続けるので、
必ず再デプロイする。値は暗号化されて保存され、あとから読み出せない（忘れたら入れ直すしかない）。

D1 のバインディング（`DB`）はデプロイ時に渡す。`scripts/deploy-pages.sh` が
wrangler.jsonc の `env.<試験>` から Pages 用の設定を組んで `wrangler pages deploy` に食わせる。
**設定ファイル無しでデプロイすると `env.DB` が undefined になり、ログインも登録も 500 で落ちる。**

#### 本番でだけ起きる制約

- **PBKDF2 の反復回数は 100,000 が上限。** 超えると `NotSupportedError` で
  ログインが 500 になる。ローカルの miniflare は上限を課さないので、
  本番に出すまで気づけない
- **Cloudflare のボット対策が素の HTTP クライアントを 403 で弾く。**
  `curl` は通るが Python の `urllib`（既定の User-Agent）は弾かれた。
  API を叩いて動作確認するときはブラウザ相当の User-Agent を付ける
- **`wrangler.jsonc` の `database_id` を変えると、ローカルの D1 も別物に切り替わる。**
  本番用の ID を入れた直後はローカルが空になるので、migrations と seed を流し直す

## コンテンツ取り込みパイプライン

```bash
python3 scripts/fetch_pdfs.py                    # 過去問 PDF を一括取得（既存はスキップ）
python3 scripts/extract_answer_keys.py           # 解答例から正解表を抽出（全2,900問）
python3 scripts/parse_syllabus.py                # シラバスを構造化（63項目・用語例1,119語）

python3 scripts/render_pages.py 2024r06          # 問題冊子のページを PNG 化
#   → ページ画像をビジョンモデルに読ませて data/extracted/2024r06/chunk_*.json を作る
#      仕様: scripts/prompts/extract_questions.md
python3 scripts/merge_questions.py 2024r06       # 結合・正規化・構造検証
python3 scripts/check_answerability.py 2024r06   # 抽出テキストだけで解いた結果を正解表と突合
#   → 図として描かれた問題の切り出し範囲を data/figures/boxes.json に書く
python3 scripts/crop_figures.py --boxes data/ip/figures --pdf-dir data/ip/pdfs --out public/figures/ip
#   ↑ 出力先は試験ごとに分ける。両試験に同じ試験 ID があり、平置きだと図が上書きされる

#   → 各問をシラバス項目と論点に分類。仕様: scripts/prompts/classify_questions.md
python3 scripts/build_topics.py                  # 論点マスタと出題頻度を算出（表記揺れを統合）
#   → 論点ごとの教材を執筆。仕様: scripts/prompts/write_materials.md
python3 scripts/build_seed.py                    # 全部まとめて seed.sql に
```

新年度は毎年4月頃に公開されるので、`fetch_pdfs.py` を再実行すれば差分だけ入る。

### 品質管理の考え方

読み取り・分類・執筆はいずれもページや論点の範囲で分担するため、**担当ごとに流儀がずれる**。
1件ずつ見ても気づけないので、仕組みで潰している。

- **仕様を文書に固定**（`scripts/prompts/*.md`）。各担当が最初にこれを読む
- **表記は自動正規化**。`merge_questions.py` が句読点を、`build_topics.py` が論点の表記揺れを統合
- **ブレは警告として報告**。自動で直せないものは人が判断して `data/topic_aliases.json` に足す
- **正解表を突合先に使う**。`check_answerability.py` は抽出テキストだけで問題を解かせ、正解率で読み取り品質を測る

### 図を含む問題の扱い

400問のうち64問が図表を含む。すべて `figure_description` に文章として書き起こしてあり、
品質検証では**64問すべてが文章だけで解答可能**と判定された。

ただし解けることと学習しやすいことは別なので、**図として描かれているもの（ブロック図・
アローダイアグラム・擬似言語など13問）は原本から切り出した画像も表示する**。本番も図で
出るため、図で慣れておくほうが実戦的でもある。

表は画像を持たせていない。Markdown 風の書き起こしのほうが折り返しに強く読みやすいため。
文章の書き起こしは画像がある問題でも残してあり、読み上げや検索に使える。

`build_seed.py` は「図として描かれているのに画像が無い問題」を警告として出す。

## 事実確認済みの制約

詳細は要件定義書 §2 を参照。

- IPA の公開過去問は **29回分・2,900問**が上限。CBT 移行後は年度あたり100問しか公開されない
- **問題冊子は全29回・1,450頁すべてテキスト0文字のスキャン画像**。画像→テキスト化が必須
- **解答例 PDF はテキスト抽出可能**。全2,900問の正解表を抽出済み。これが唯一の客観的な突合先
- 各問題に**分野タグは付いていない**。分類はアプリ側で行う
- 合格判定は **IRT** で算出され換算式が非公開。**このアプリの点数は素点による目安**で、画面にもその旨を表示する
- 過去問の利用は**申請不要・使用料不要**。ただし**出典明記が必須**（改変時はその旨も）。
  出典は `past_questions.citation` に持たせ、問題を表示する全画面で出している

## 参考資料


引き継いだ設計で特に重要なのが**出題時スナップショット**（出題時点の問題文・選択肢・正解を固定し、
教材を後から直しても当時の内容で採点・振り返りできる）と、**中断・再開時のズレ防止**。

逆に真似しなかった点は要件定義書 §7 に列挙してある（合格判定を正答数で行っている、
パラメータがハードコード、放置セッションが新規開始を塞ぐ、など）。
