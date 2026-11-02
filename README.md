# study-app

資格試験と「資格でない学び」を、**同じコード・別データ・別配備**で出している学習アプリ群。
入口「まなびば」が認証と権限を持ち、学び側は 9 対象（資格型 3・ロードマップ型 6）。

過去問（IPA 公開分）を起点に、その背後にある**論点**を学習単位として構成する。
単なる過去問暗記にせず、周辺知識を添えて理解を深められるようにするのが方針。

- 作業の前提と決まり: [`CLAUDE.md`](CLAUDE.md)（着手前の三分類・分担の原則・落とし穴・仕様 ⇔ コード ⇔ テストの門）
- 仕様の正本: [`docs/goals/`](docs/goals/)（GOAL → UC → REQ → 契約）・[`docs/rules/`](docs/rules/)（BR）・[`docs/adr/`](docs/adr/)・[`docs/01-glossary.md`](docs/01-glossary.md)。旧の要件定義書は [`docs/attic/要件定義書_draft.md`](docs/attic/要件定義書_draft.md)
- 壊してはいけないことと、何がそれを守っているか: [`docs/不変条件と門.md`](docs/不変条件と門.md)
- 開発の経緯: `docs/作業ログ_*`（最初は [`docs/作業ログ_2026-08-23.md`](docs/作業ログ_2026-08-23.md)）、トラブルの記録は [`brain/INDEX.md`](brain/INDEX.md)

## 設計の中核

**論点に紐づく過去問の件数＝出題頻度＝重要度。** 頻出論点から潰すのが最短合格経路になる。

```
論点（例:「損益分岐点」）
  ├─ 解説・周辺知識          ← 学習する対象はこっち
  └─ 紐づく過去問（M:N）      ← この件数が重要度になる
```

テーマ分けは自前で作らず、**IPA シラバスの階層**（分野 → 大分類 → 中分類 → 項目）に乗せる。
合格条件が分野単位の AND 条件なので、分類が分野に接続していないと
「マネジメント系が足りない」という最も重要なフィードバックが出せないため。

ロードマップ型（資格でない学び）は、論点の代わりに「日ごとの単位」を学ぶ順に並べ、
確認問題で理解を測る。データ構造は資格型と同じ表に乗せている。

## 対象と現在のデータ

| 対象 | 型 | 回・単位 | 問題 | 論点 | 本番 |
| --- | --- | --- | --- | --- | --- |
| IT パスポート（`ip`） | 資格 | 11 回（公開 29 回） | 1,100 | 532 | https://itpass-study-d02.pages.dev |
| 応用情報 午前（`ap`） | 資格 | 18 回（直近 10 年分を達成） | 1,440 | 772 | https://ap-am-study-2px.pages.dev |
| 基本情報 科目A（`fe`） | 資格 | 5 回（旧午前の最新 5 回） | 400 | 315 | 配備待ち |
| IT コンサル就活（`itc`） | ロードマップ | 42 単位＋補足 5 | 94 | — | https://itc-roadmap.pages.dev |
| マーケティング 実務の判断（`mkt`） | ロードマップ | 42 単位 | 84 | — | https://mkt-roadmap.pages.dev |
| マッサージ 肩と腰の手当て（`msg`） | ロードマップ | 42 単位 | 84 | — | https://msg-roadmap.pages.dev |
| 経済 暮らし編（`ecl`）／学問編（`eca`） | ロードマップ | 42／66 単位 | 84／132 | — | https://ecl-roadmap.pages.dev ／ https://eca-roadmap.pages.dev |
| 会話術 汲み取って伝える（`cnv`） | ロードマップ | 63 単位 | 126 | — | https://cnv-roadmap.pages.dev |

全論点・全単位に教材（解説・周辺知識）と問題解説があり、図として描かれた問題は原本から切り出した画像を出す。
対象の登録簿は [`src/shared/targets.json`](src/shared/targets.json)、配備先は [`scripts/pages_projects.json`](scripts/pages_projects.json)。
入口「まなびば」: **https://manabiba-5oz.pages.dev**（学びの一覧・ログイン・管理）。

回や対象の追加手順:
[`docs/回を追加する手順.md`](docs/回を追加する手順.md)・[`docs/応用情報を追加する.md`](docs/応用情報を追加する.md)・
[`docs/基本情報を追加する.md`](docs/基本情報を追加する.md)・[`docs/ロードマップ対象を追加する.md`](docs/ロードマップ対象を追加する.md)。
論点 ID は対象ごとに固定されているので、回を追加しても学習の進捗と教材はずれない。

## 機能

| 機能 | 内容 |
| --- | --- |
| **学習** | 分野 → 中分類 → 論点。既定の並びは出題頻度順。論点ごとに解説・周辺知識・出題された過去問を読み、理解度を 3 段階（未理解／やや理解／理解）で記録。用語は本文の中でポップで説明する |
| **練習テスト** | 論点ドリル（その論点の過去問だけ）／分野別演習／弱点復習（間違えた問題） |
| **過去問実践** | 公開回をそのまま通す、または全範囲から構成した模試（対象ごとに問題数と制限時間を持つ）。分野別の正答率と合否目安を表示。中断・再開・破棄ができる |
| **ロードマップ** | 日ごとの単位を順に学び、確認問題で理解を測る（ロードマップ型の対象） |
| **フィードバック** | 画面から自由記述を送る。溜まったものを審議して改善に回す（[`docs/作業ログ_2026-09-16_フィードバック.md`](docs/作業ログ_2026-09-16_フィードバック.md)） |

## 技術構成

| 層 | 技術 |
| --- | --- |
| API | Hono（Cloudflare Workers。Pages の `_worker.js` として配備） |
| DB | Cloudflare D1 + Drizzle ORM。対象ごとに 1 つ |
| フロント | React + Vite（SPA, React Router） |
| 配信 | API と静的配信を**同じ Worker から 1 デプロイ** |
| 認証・権限 | 入口「まなびば」（`portal/`）が正本。学び側はまなびばからの使い捨てコードを交換してトークン（HS256）を得るだけで、**パスワードも登録も持たない**。まなびば側のパスワードは Web Crypto の PBKDF2 |
| 検査 | spec-lint → trace-check → vitest（298）→ `check_source` → `check_docs` を `npm test` で。API は `check_api.sh`、描画は `check_render.sh`、本番は `check_sso_prod.sh` |

セキュリティヘッダ・SQL・XSS・秘密の扱いは本番の経路で確認してある（[`docs/作業ログ_2026-09-25_脆弱性診断.md`](docs/作業ログ_2026-09-25_脆弱性診断.md)）。

## 仕様 ⇔ コード ⇔ テストの作法

原本 harness（`tsay-dev/harness`）の作法で回す。要求はまず `docs/goals/` の UC（状態 × イベント表）と REQ（EARS 1 文、1 要件 1 か所のコード）に写し、
承認後に implementer と test-author を別コンテキストで並行させる。コードには `@implements REQ-nnn`、テストには `@covers REQ-nnn#class`。
書き込みの瞬間は PreToolUse の門、作業終了の瞬間は Stop の門が止める。未返済は `.trace-baseline.json` に持ち、縮む方向にしか動かさない
（[`docs/検証の返済計画.md`](docs/検証の返済計画.md)）。詳しくは [`CLAUDE.md`](CLAUDE.md) の「仕様 ⇔ コード ⇔ テスト の対応」。

## セットアップ（ローカル）

```bash
npm install
pip install pymupdf                                  # コンテンツ取り込みスクリプト用

# DB を作って初期データを入れる（例: IT パスポート）
npx wrangler d1 migrations apply study-app-db --local
python3 scripts/build_seed.py --data data/ip
bash scripts/seed_remote.sh ip --local               # check_seed → ローカル D1 へ投入 → 突き合わせ

# ローカルに渡す値（トークンの署名の秘密など）
cp .dev.vars.example .dev.vars

# 起動（API + 静的配信が 8787 で一体）
npm run build
npx wrangler dev
```

`.dev.vars` に `JWT_SECRET` を置く（雛形 `.dev.vars.example`）。無いと学び側はトークンを発行も検証もせず、
ログインも認証を要する経路も 503 で断る。ローカルではまなびば（`SSO_PORTAL_URL`）を設定しないので、
パスワードでのログインと登録が使える（本番ではこの経路は 404 を返す）。

フロントだけホットリロードしたい場合は `npm run dev`（5173、`/api` は 8787 に転送）。
別の対象で起動するなら `npx wrangler dev --env ap` のように `--env <対象>`（D1 も対象のものに切り替わる）。

## 本番（Cloudflare Pages、個人アカウント）

公開先が Pages なのは、workers.dev の URL に**アカウント名が入る**から。
共通サブドメインを変えると同じアカウントの他の Worker の URL も一斉に変わるため触れない。

```bash
bash scripts/deploy-pages.sh ap                      # 描画検査 → ビルド → Worker を束ねる → Pages へ
python3 scripts/build_seed.py --data data/ap
bash scripts/seed_remote.sh ap                       # check_seed → backup → --remote で投入 → 投入後の突き合わせ
bash scripts/finish_remote.sh ap                     # 上の 3 つを 1 本で
```

新しい対象を初めて出すときは `bash scripts/bootstrap_personal.sh <対象>`（Pages 作成・migrations・secret。対話あり）→
`bash scripts/set_sso_secret.sh`（まなびばと同じ共有秘密）→ `finish_remote.sh <対象>` → `pages_projects.json` に URL →
`python3 scripts/build_portal.py` と `bash scripts/deploy_portal.sh`（入口に並べる）→ まなびばの管理画面で権限を付ける。

- **デプロイは `scripts/deploy-pages.sh` 経由で行う。** wrangler.jsonc の `env.<対象>` から Pages 用の設定を組んで D1 のバインディングを渡す。設定ファイル無しで `wrangler pages deploy` すると `env.DB` が undefined になり 500 で落ちる
- **secret は更新しただけでは反映されない。** 稼働中のデプロイは古い値を持ち続けるので、`wrangler pages secret put` のあとに必ず再デプロイする
- **seed の投入は `seed_remote.sh` で行い、wrangler を直に叩かない。** 投入は `DELETE FROM topics …` を含み、進捗（`progress`）は CASCADE で消えうる。バックアップ（`scripts/backup_d1.sh`）は `seed_remote.sh` が自動で取る。投入が通ることと中身が正しいことは別で、`verify_seed_remote.py` が件数と代表値を突き合わせる
- 本番の一巡の確認: `bash scripts/check_sso_prod.sh`（まなびばと全学びの secret・SSO の有効）と `bash scripts/check_api.sh <対象>`

### 本番でだけ起きる制約

- **PBKDF2 の反復回数は 100,000 が上限。** 超えると `NotSupportedError` でログインが 500 になる。ローカルの miniflare は上限を課さない
- **Cloudflare のボット対策が素の HTTP クライアントを 403 で弾く。** API を叩いて動作確認するときはブラウザ相当の User-Agent を付ける
- **`wrangler.jsonc` の `database_id` を変えると、ローカルの D1 も別物に切り替わる。** 本番用の ID を入れた直後はローカルが空になるので、migrations と seed を流し直す

## コンテンツ取り込みパイプライン

資格型は「PDF 取得 → 正解表 → ページ画像 → 読み取り（担当） → 解答検証（担当） → 分類（担当） → 論点マスタ → 解説と教材（担当） → 図（担当） → seed」。
担当はサブエージェント（`.claude/agents/` の型）で、1 回分に約 15 体。手順は [`docs/回を追加する手順.md`](docs/回を追加する手順.md)。

### 品質管理の考え方

読み取り・分類・執筆はページや論点の範囲で分担するため、**担当ごとに流儀がずれる**。1 件ずつ見ても気づけないので、仕組みで潰している。

- **仕様を文書に固定**（`scripts/prompts/*.md`）。各担当が最初にこれを読む
- **担当の自己申告を信じず、成果物を機械で突き合わせる**（`scripts/check_*.py` 16 本）
- **正解表を突合先に使う**。`check_answerability.py` は抽出テキストだけで問題を解かせ、正解率で読み取り品質を測る
- **「データが壊れている」報告は原本の画像と照合してから直す**（8 回中 7 回が誤報だった）
- **描画そのものを検査する**。`check_render.sh` が実データ全件を jsdom で描いて DOM を見る（デプロイ前に自動で回る）

### 図を含む問題の扱い

図表はすべて `figure_description` に文章として書き起こしてあり、文章だけで解答できることを検証している。
ただし解けることと学習しやすいことは別なので、**図として描かれているもの（ブロック図・アローダイアグラム・擬似言語など）は原本から切り出した画像も表示する**。
表は Markdown 風の書き起こしのままにする（折り返しに強く読みやすい）。画像は `public/figures/<対象>/` に分ける
（IT パスポートと応用情報に同じ試験 ID があり、平置きだと上書きされる）。`build_seed.py` が「図として描かれているのに画像が無い問題」を警告に出す。

## 事実確認済みの制約（IPA の公開過去問）

- IT パスポートの公開過去問は **29 回分・2,900 問**が上限。CBT 移行後は年度あたり 100 問しか公開されない。基本情報は令和元年度秋期で公開が止まっている
- **問題冊子はすべてテキスト 0 文字のスキャン画像**。画像 → テキスト化が必須
- **解答例 PDF はテキスト抽出可能**。これが唯一の客観的な突合先
- 各問題に**分野タグは付いていない**。分類はアプリ側で行う
- 合格判定は **IRT** で算出され換算式が非公開。**このアプリの点数は素点による目安**で、画面にもその旨を表示する
- 過去問の利用は**申請不要・使用料不要**。ただし**出典明記が必須**（改変時はその旨も）。出典は `past_questions.citation` に持たせ、問題を表示する全画面で出している

## 引き継いだ設計

特に重要なのが**出題時スナップショット**（出題時点の問題文・選択肢・正解を固定し、教材を後から直しても当時の内容で採点・振り返りできる）と、
**中断・再開時のズレ防止**。逆に真似しなかった点は [`docs/attic/要件定義書_draft.md`](docs/attic/要件定義書_draft.md) の §7 に列挙してある。
