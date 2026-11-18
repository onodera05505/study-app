# study-app — 作業時の前提

**このプロジェクトは個人。** トラブル時はまず `brain/INDEX.md`（このリポジトリ）と
`~/.claude/brain/INDEX.md`（共通）を症状の言葉で grep する。解決したら報告書を1枚還す。
作業の着手時は `brain/APPROACHES.md` と `~/.claude/brain/APPROACHES.md` を作業の言葉で grep し、
`brain/PREMISES.md`（未決・本人の指示）を読む。

IT パスポート試験の学習アプリ。**このディレクトリがプロジェクトのルート**で、
以降のパスはすべてここからの相対パス。

このファイルは**地図**（固有の決まり・構成・層の向き・命名・規約からの逸脱・正本へのリンク。150 行以内）。
決まりの全文と理由は、下の「場面から読む物を引く」の行き先が持つ。ここに写さない。

## 着手前に要求を3つに分ける（コードやデータを触る前に）

要求を **質問 / バグ修正 / 仕様変更** のどれかに置いてから動く。判定軸はコードの行数ではなく
「**決めてある意図が変わるか**」。意図は `docs/goals/`（UC・REQ・契約）・`docs/rules/`（BR）・「設計の中核」・
`docs/不変条件と門.md` が持つ。

- **質問**: 調べて答える。直さない
- **バグ修正**: 意図は変えず、実装や データを意図に合わせる。観測できる挙動が変わってもバグ修正。
  **データの修正は、原本の画像と照合してから**（[`docs/落とし穴.md`](docs/落とし穴.md)）
- **仕様変更**: 意図そのものを変える／新設する。1行でも該当する。先に本人へ提示して合意し、
  合意した内容を `docs/goals/` の UC・REQ（spec-author）か該当の手順書に書いてから着手する。
  既存の文書と矛盾する要求は、実装で黙って上書きせず矛盾を提示して止まる

分類と根拠（どの文書のどこか）を作業の最初に一言で書く。空回りしたら粘らない：
検証が3回続けて落ちる、または同じ誤りを繰り返したら、新しいコンテキストでやり直す。

## 設計の中核（ここを壊さない）

**論点に紐づく過去問の件数＝出題頻度＝重要度。** 頻出論点から潰すのが最短合格経路になる。
この一点のためにデータ構造が組んである。

- 論点 ID は `data/<対象>/topic_ids.json`（対象ごとに 1 つ）で固定。**並び順から採ってはいけない。**
  回を追加すると頻度順が変わり、学習の進捗と教材が別の論点を指してしまう
- 初期データ投入は UPSERT。DELETE すると進捗・受験履歴が外部キー制約で壊れる
- **同一内容の過去問は DB に全問残し、学習側だけ `content_key` で1問にまとめる**（応用情報は 119 組）。
  出題頻度は重複を数えたまま。通し受験は原本どおり。`check_seed.py` が「同一内容なのに正解が違う」を止める
- 分類は自前で行う（IPA の公開問題に分野タグは無い）。テーマ分けは IPA シラバスの階層に乗せる。
  **合否が分野単位の AND 条件なので、分類が分野に接続していないと最重要のフィードバックが出せない**

上の各項目と [`docs/落とし穴.md`](docs/落とし穴.md) の各項目を、**どのスクリプトが守っているか**まで含めて一覧にしたのが
[`docs/不変条件と門.md`](docs/不変条件と門.md)。不変条件を足したら行を足す。門を作ったら状態を更新する。

## 場面から読む物を引く

| 場面 | 読む物 |
| --- | --- |
| 着手する（毎回） | [`brain/PREMISES.md`](brain/PREMISES.md)（未決・本人の指示）、[`docs/未修正のバグ.md`](docs/未修正のバグ.md) |
| トラブル・原因不明のエラー | [`brain/INDEX.md`](brain/INDEX.md)（調査の前に。解決したら報告書を 1 枚還す） |
| 文書を探す・足す、作業ログを書く | [`docs/文書の索引.md`](docs/文書の索引.md)（点／線の区別、`docs/` の全ファイルの表、還元行の決まり） |
| 仕様・実装・テストに触る、担当に任せる | [`docs/作業の進め方.md`](docs/作業の進め方.md)（`/develop` の運び、担当の型と仕様書、権限、環境の制約） |
| データを直す、seed・配備・本番に触る | [`docs/落とし穴.md`](docs/落とし穴.md)、[`README.md`](README.md) の「本番」 |
| 壊してはいけないことと、それを守る門 | [`docs/不変条件と門.md`](docs/不変条件と門.md)、[`docs/検査観点カタログ.md`](docs/検査観点カタログ.md) |
| 回・対象を足す | [`docs/回を追加する手順.md`](docs/回を追加する手順.md)、[`docs/応用情報を追加する.md`](docs/応用情報を追加する.md)、[`docs/基本情報を追加する.md`](docs/基本情報を追加する.md)、[`docs/ロードマップ対象を追加する.md`](docs/ロードマップ対象を追加する.md)、Skill `learn-target` |
| 今の数・本番の URL | [`docs/現在地.md`](docs/現在地.md) |
| 利用者のフィードバック | Skill `improve-from-feedback`、[`brain/feedback/判断基準.md`](brain/feedback/判断基準.md) |

## 作業の約束（1 行ずつ。全文は行き先）

- 要求は Skill `/develop` の手順で運ぶ。親（この会話）は仕様も実装もテストも書かない。実装の前に REQ があるか確かめ、無ければ仕様が先（[`docs/作業の進め方.md`](docs/作業の進め方.md)）
- 作業完了の条件は `npm test` が全部通ること。赤や欠けは上流（仕様の正本）から直し、実装に合わせて要件やテストを寄せない
- 「仕様外」の印・除外の印は存在しない。検査の緩和・テストの skip は本人の許可なく行わない
- 担当は `.claude/agents/` の型で、モデルは Opus。決まりは指示に直書きせず、先に仕様書（`scripts/prompts/`）へ書く。成果物は自己申告でなく機械で確かめ、受入は別コンテキスト（`qa-acceptance`）
- 「データが壊れている」という報告は、原本の画像と照合してから判断する
- seed は `bash scripts/seed_remote.sh`、配備は `bash scripts/deploy-pages.sh` を通す。wrangler を直に叩かない。破壊的な操作は毎回確認する
- 仕様書の本文は現在形だけ。経緯は `## 改訂履歴` と作業ログ（点）へ

## 構成

同じコードを、対象（`ip`・`ap`・…）ごとに別のデータ・別の D1・別の Pages として配備する。対象の一覧は `src/shared/targets.json`、
配備先は `scripts/pages_projects.json`、D1 の結び先は `wrangler.jsonc` の `env.<対象>`。

| 置き場 | 中身 |
| --- | --- |
| `src/client/` | 学び側の画面（React + Vite の SPA。`pages/`・`components/`・`lib/`） |
| `src/server/` | 学び側の API（Hono。`index.ts` が受け口、`routes/` → `lib/` → `db/`） |
| `src/shared/` | 画面と API が共有する物（対象の登録簿など） |
| `portal/` | 入口「まなびば」（認証と権限の正本。`src/index.ts`・`static/`・`migrations/`。学び側とは別の配備） |
| `scripts/` | 作り手と運用の道具（取り込み・生成・門・seed・配備）。`scripts/prompts/` は担当が最初に読む仕様書 |
| `data/<対象>/`・`public/figures/<対象>/` | 対象ごとの原本と生成物（論点 ID・教材・単元の構成・図の仕様）／図の画像 |
| `migrations/`・`contracts/fixtures/` | 学び側の D1 の構造の変更／出荷済みの版が書いたデータの控え |
| `tests/` | `client/`・`server/`・`portal/`・`scenario/`、入力の置き場 `fixtures/` |
| `docs/` | 仕様の正本（`goals/`・`rules/`・`nfr/`・`adr/`・`_shared/`・`01-glossary.md`）と、手順書・記録 |
| `brain/` | このプロジェクトの前提・トラブルの報告書・作業の型・手戻りの台帳 |
| `.harness/`・`.claude/`・`apm_modules/` | 原本 harness の道具と展開物（APM が作る。手で直さない）。宣言は `traceconfig.json`・`apm.yml` |

## 層と命名

- 層の向き（[`ADR-0005`](docs/adr/ADR-0005-layering.md)）: `src/client` と `src/server` は互いを import せず、共有するのは `src/shared` だけ。サーバーは `routes/` → `lib/` → `db/` の一方向
- 仕様の置き場: `docs/goals/GOAL-nn-<slug>/UC-nnn-<slug>/` に `UC.md`・`REQ-nnn.md`・`contract.yaml`、横断の決まりは `docs/rules/BR-nnn.md`。次の番号は `node .harness/tools/trace-check/trace-check.mjs --next req`（`uc`・`br`・`adr` も同じ）
- 注釈: コードに `@implements REQ-nnn`／`BR-nnn`、境界の入口に `@operation UC-nnn#操作名`、テストは `it(` の直前の行に `@covers REQ-nnn#class`（1 テスト 1 クラス）、シナリオは `@scenario UC-nnn`。ID だけを書く（[`.claude/rules/comments.md`](.claude/rules/comments.md)）
- テストの名前: `tests/server/UC-nnn_<話題>.test.ts`、`tests/client/UC-nnn_<話題>.test.tsx`、`tests/scenario/UC-nnn-<slug>.test.tsx`（UC 1 本に 1 本）。土台は `UC-nnn_fixture.ts`
- 文書の名前: `作業ログ_<日付>_<題>`・`レビュー詳細_*`・`改善候補_*` は点（書き換えず追記）、それ以外は線。足したら [`docs/文書の索引.md`](docs/文書の索引.md) に行を足す
- 図の画像は `public/figures/<対象>/` に分ける（試験 ID は対象をまたいで一意でない）

## 操作 → 入口（R-1204）

テストは、契約（`contract.yaml`）の操作名と `transport` から、次の規則で入口を導く。実装を読んで導かない。

| 契約の transport | 入口 | 呼び方 |
| --- | --- | --- |
| `http`（学び側） | `src/server/index.ts` の default export（Hono の app。経路は `/api` の下） | 契約の `wire` から `Request` を組んで `app.request()` |
| `http`（まなびば） | `portal/src/index.ts` の default export（同上） | 同上 |
| `local-store`（画面の手元の保存） | `src/client/lib/` の export。名前は操作名の `read…` を `get…`、`save…` を `set…` に読み替え、ほかは操作名のまま | その関数を呼ぶ。契約の `errors` に当たる失敗は、投げられた値の `code` で名前を読む |
| 道具を回す操作 | `scripts/<操作名を snake_case にした名前>.py`（または `.sh`） | 子プロセスで回し、終了の状態・出力・書き出したファイルを見る |
| 道具の中の読み書き（`read…`・`write…`） | その操作を `@operation` で持つ道具 | 道具を回し、契約が名指す置き場のファイルで見る |

規則に従わない入口: `markSessionExpired` は `api`（`src/client/lib/api.ts`）、画面から出る `http` の `fetchVersionStamp` は `rememberBuild`・`checkForUpdate`（`src/client/lib/version.ts`）。
道具の名前と違う操作は
`renderLearnerInstructions`（`render_prompts.py`）、`gradeLearnerAnswers`（`grade_learner.py`）、`listDeliveredMaterials`（`material_generations.py`）、
`checkFigureSpecs`（`render_material_figures.py`）、`buildUnitInputs`（`build_rewrite_bundles.py`）、本番の確かめ 4 つ（`check_sso_prod.sh`）。

## スタックの規約からの逸脱

`.claude/rules/` のスタックの葉（Cloudflare / Hono / React）と違う所。葉とここが食い違ったら、ここが優先。

- 配置は機能単位（`apps/api/src/features/<feature>/`）でなく、上の「構成」。実現単位は `*.service.ts` でなく、`src/**`・`portal/src/**` と要件に結んだ `scripts/` の道具（区分は traceconfig の `source`）
- 画面の単体テスト（`tests/client/`）を持つ。葉は作らないと決めているが、ここでは要件のクラスを画面の部品で確かめる
- シナリオテストは Playwright でなく、vitest + jsdom（`tests/scenario/`）と API を通す道具（`scripts/check_api.py`・`check_portal_api.py`）
- `@covers` はテスト本文の先頭行でなく、`it(` の直前の行
- 配信は Workers + Static Assets でなく Pages（[`ADR-0002`](docs/adr/ADR-0002-runtime-and-delivery.md)）。画面の経路は React Router、サーバーの状態の取得は自前（TanStack を使わない）
- `layering` は宣言しない（型検査とビルドの入口の分離が見る。ADR-0005）

## 正本へのリンク

- 規約: [`.claude/rules/docs.md`](.claude/rules/docs.md)（R-101〜R-1207）、[`.claude/rules/comments.md`](.claude/rules/comments.md)、手順は Skill `/develop`
- 検査の宣言とコマンド: `traceconfig.json`（次の版への移行の間は `traceconfig.next.json` と `.harness-next/` が並ぶ）、`package.json` の `scripts`
- 仕様: [`docs/goals/`](docs/goals/)・[`docs/rules/`](docs/rules/)・[`docs/nfr/`](docs/nfr/)・[`docs/adr/`](docs/adr/)・[`docs/01-glossary.md`](docs/01-glossary.md)・[`docs/_shared/`](docs/_shared/)
- 検証の台帳: [`docs/verification/GLOBAL.md`](docs/verification/GLOBAL.md)・[`docs/verification/DEFERRED.md`](docs/verification/DEFERRED.md)・[`docs/検証の返済計画.md`](docs/検証の返済計画.md)
- 人の運用手順（動かし方・本番・secret）: [`README.md`](README.md)
