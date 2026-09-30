---
id: INVENTORY
status: working
---

# ドキュメント棚卸し（Phase 0 成果物）

分類: `SSOT候補` / `派生物` / `重複` / `不明・死蔵`
処遇: `維持` / `参照化` / `生成対象化` / `attic` / `要判断(→OPEN-QUESTIONS)`

前提: 本人の決定 2026-09-30「このアプリも原本 harness の作り方に寄せる」。挙動は変えない（A-3）。移行の範囲は**アプリ（`src/`・`portal/`・`tests/`・API の検査スクリプト）**。過去問の取り込み・教材生成の Python パイプライン（`scripts/*.py`・`scripts/prompts/*.md`）は前回の決定（2026-09-28「第 2 段」）どおり今回の UC/REQ の範囲外とし、その仕様書は運用手順として維持する（→ OQ-01）。

## ドキュメント

| パス | 内容の要約 (1 行) | 分類 | 重複相手 / 導出元 | 処遇と理由 |
| --- | --- | --- | --- | --- |
| `docs/要件定義書_draft.md` | 仕様書（v0.12、685 行）。§1 目的、§3 中核設計、§4/§15 利用者と権限・SSO、§5 機能要件（5.1〜5.8）、§6 データモデル、§7 パイプライン、§8 技術構成、§9 著作権、§10 非機能、§11 未決、§13.5/13.6 ロードマップ型の画面、§16 画面の共通の振る舞い、§17 運用の土台 | SSOT候補（本体） | `docs/spec.yaml`（quote で引用）・`docs/usecases/` | **生成対象化**: §1→`00-vision.md`、§4/§15→`02-actors.md`＋UC、§5/§13.5/§13.6/§17→GOAL/UC/REQ、§3/§9/§5.7/§5.8 の決まり→BR、§10→NFR（計測がある物だけ）、§6→schema が SSOT（R-102。参照化）、§8→ADR（現在の記録）、§7→運用手順（維持）、§11→OPEN-QUESTIONS、§12/§14/§5.5→`goals-backlog.md`、§16 の UI の文言・役割→契約と検証の葉（仕様に画面のことは書かない。→ OQ-03）。中身が全部行き先を持った時点で attic（A-2） |
| `docs/spec.yaml` | 要件 240 件（active 224・draft 16・withdrawn 1）。UC の 1 ステップに属し quote で仕様書を引く。`@implements`/`@verifies` の参照先 | SSOT候補 | `docs/要件定義書_draft.md`（quote）、`docs/usecases/` | **生成対象化**: Phase 4 で 1 件 1 ファイルの `REQ-nnn.md`（EARS 1 文）へ。**番号は新たに採番**（原本の `--next` は docs/goals しか数えないため旧番号と衝突する。Phase 4 の前にコードの `@implements REQ-nnn` を `@implements-old` に機械改名。→ OQ-04）。全件に行き先が付いたら attic |
| `docs/usecases/UC-001〜019, 024〜032.md`（28 本。active 19・draft 9） | UC の書類（frontmatter id/title/status/actor/source、前提・基本の流れ・例外の流れ・事後条件） | SSOT候補 | `docs/要件定義書_draft.md`（source の節） | **生成対象化**: Phase 3 で `docs/goals/GOAL-nn-<slug>/UC-nnn-<slug>/UC.md` へ（状態×イベント表を既存コードの分岐から埋める。draft 9 本は `goals-backlog.md` か `(planned)`）。行き先が付いたら attic |
| `docs/01-glossary.md` | 用語集の空の草案（表の行 0。識別子の列を持つ＝原本の思想と違う） | 不明・死蔵 | — | **attic**（Phase 2 で原本テンプレから spec-author が業務語だけで書く） |
| `docs/verification/DEFERRED.md` | 保留台帳（reviewer の持ち越し 7 件） | SSOT候補 | 原本 `templates/develop/DEFERRED.md` と同じ置き場 | **維持**（形を原本テンプレに合わせる。中身は Phase 6〜7 で返済か継続） |
| `docs/不変条件と門.md` | 壊してはいけないこと 25 件＋運用 13 件と、守る門の対応表 | SSOT候補（BR/NFR の材料）＋運用表 | `CLAUDE.md`「設計の中核」「落とし穴」と一部重複 | **参照化**: D1〜D25・O1〜O13 のうち業務の決まり（D1 論点 ID 固定、D2 同一内容の正解、D4 出典、D9、D16、D17〜D19）は Phase 4 で BR に、計測できる物は NFR に。表そのものは「門の状態」の運用表として維持し、BR の ID を参照させる |
| `docs/検討事項_2026-09-29_要件の仕分け.md` | 監査で仕様書に無かった要件 116 件の仕分け表（2026-09-29 に全件決着） | 派生物（決着済みの記録） | `docs/spec.yaml`・`docs/要件定義書_draft.md` | **attic**（決着は仕様書に反映済み） |
| `docs/検討事項_2026-09-14_市場比較.md` | e ラーニング市場との比較（点の調査） | 派生物 | `brain/approaches/学習アプリの充実の検討事項.md` | 維持（記録。vision の材料として参照） |
| `docs/作業ログ_2026-08-23.md` 〜 `作業ログ_2026-09-29_三層のトレーサビリティ.md`（18 本） | 点の記録（当時の経緯・失敗・決定の理由） | 派生物（記録） | 仕様書の改訂履歴・`brain/PREMISES.md` | **維持**（歴史。SSOT ではない。ADR の Context が引くことがある。Phase 7 で旧パスへの参照だけ付け替え） |
| `docs/レビュー詳細_2026-09-02_学習系.md` / `_受験系.md`、`docs/改善候補_2026-09-02.md` | 一斉検査の記録と改善候補（大半は修正済み） | 派生物（記録） | — | 維持（記録） |
| `docs/回を追加する手順.md`、`docs/応用情報を追加する.md`、`docs/ロードマップ対象を追加する.md` | コンテンツ取り込み・対象追加の運用手順（線） | 運用手順（範囲外） | `README.md`「コンテンツ取り込みパイプライン」と重複 | **維持**（生成パイプラインは範囲外。README 側は要約に留め手順書を参照させる＝Phase 7） |
| `docs/懸念_表示データに検証が無い.md`、`docs/検査観点カタログ.md`、`docs/未修正のバグ.md` | 検証の穴・検査の層・未修正バグ（線） | 運用文書 | `docs/不変条件と門.md`（門の一覧と一部重複） | 維持（検証の運用。`verification/GLOBAL.md` の「検証していない範囲」の材料） |
| `docs/Screenshot 2026-09-15 at 14.36.57.png` | 画面の撮影 1 枚（参照元なし） | 不明・死蔵 | — | **attic** |
| `README.md` | 何を作っているか・セットアップ・パイプライン・制約 | 派生物 | `CLAUDE.md`・`docs/要件定義書_draft.md` §1/§8 | 維持。Phase 7 で SSOT（vision・goals）への参照に付け替え |
| `CLAUDE.md` | 作業時の前提（分類・設計の中核・落とし穴・分担・門） | 運用文書 | `docs/不変条件と門.md`・`brain/PREMISES.md` | 維持。「仕様⇔コード⇔テスト」節は Phase 7 で原本の定常運用（R-801/803/804）に書き換え |
| `brain/PREMISES.md`・`brain/INDEX.md`・`brain/APPROACHES.md`・`brain/reports/`（27）・`brain/rework/`（5）・`brain/feedback/`・`brain/spec_consolidation/` | 前提・未決・事故報告・手戻り台帳（センターブレインの PJ 側） | 運用の記憶（範囲外） | — | 維持。§11 の未決と PREMISES の判断待ちは OPEN-QUESTIONS に転記して 1 か所に |
| `scripts/prompts/*.md`（15 本） | コンテンツ生成の担当が最初に読む仕様書（抽出・分類・教材・解説・図・ロードマップ・セルフフィードバック） | SSOT候補（生成パイプラインの） | `brain/spec_consolidation/`（統合の記録） | **維持**（範囲外。→ OQ-01） |
| `traceconfig.json`（brain スキーマ）、`scripts/trace/*.mjs`、`scripts/trace_check`、`.githooks/pre-commit`・`pre-push` | 写した型の門と配線 | 派生物（道具） | 原本 `tools/trace-check`・`spec-lint`・`gate-hook` | **Phase 1 で置き換え**: traceconfig を原本スキーマに、複製と `trace_check` は撤去、pre-commit/pre-push/CI を原本の門に |
| `.claude/agents/{extract-questions,verify-answers,classify-questions,crop-figures,write-materials,write-explanations,qa-acceptance}.md` | 取り込み工程と受入の担当の型（APM の外） | 運用（範囲外） | — | 維持（APM の生成物と混ぜない） |

## コード内の仕様的記述（コメント・README・wiki）

| 場所 | 内容 | 分類 | 処遇 |
| --- | --- | --- | --- |
| `src/**`・`portal/src/**` の `@implements REQ-nnn`（要件 224 件ぶん、1 要件 1 か所） | 旧番号の要件への参照 | 派生物（注釈） | Phase 4 の前に `@implements-old` へ機械改名（挙動不変）、Phase 6 で新 ID の `@implements` を付け直し、Phase 7 で旧注釈を撤去 |
| `tests/**` の `@verifies REQ-nnn`（vitest 261 件）と `tests/scenario/*.test.tsx` の `@scenario UC-nnn`（10 本、jsdom） | テストの要件参照 | 派生物（注釈） | Phase 6 で `@covers REQ-nnn#class` へ。jsdom のシナリオを `tests.system` に数えるかは → OQ-05 |
| `scripts/check_api.py`・`check_portal_api.py`・`check_sso_prod.sh`・`check_seed.py`・`build_seed.py`・`deploy-pages.sh` の `@implements`/`@verifies`/`@scenario` | 実 API を叩く検査（wrangler dev）と運用スクリプトの注釈 | 派生物（注釈） | Phase 6 で `@covers`（Python の `test_pattern`: `def check_(\w+)`）。サーバ経路のシナリオ 9 本は `tests.system` 候補 |
| `src/**` の設計コメント（「null は未取得、[] は空」「同一内容は学習側で 1 問に」「PBKDF2 上限」等） | 決まりの理由 | 仕様的コメント | 原本の comments 葉に従い、今の仕様だけ残す（Phase 6 の注釈の際に確認。書き換えは A-3 の範囲内＝コメントのみ） |
| `src/shared/targets.json`（対象の登録簿: 名前・分野・roadmap・questionsPerRound・roadmapSpec）、`scripts/pages_projects.json` | 対象ごとの値（機械可読） | SSOT（値。R-102） | 維持。仕様書 §5.8「対象ごとの値」は参照化 |
| `wrangler.jsonc`・`migrations/`・drizzle の schema | DB 設計と配備の設定 | SSOT（機械可読。R-704） | 維持。`traceconfig.json` の `schema.files` に宣言。仕様書 §6 は参照化 |

## 中核リソースと状態値（用語集の材料）

（読み取り専用の担当がコードから写した物の要約。全文（定義箇所の行番号つき）は作業ログ `docs/作業ログ_2026-09-30_原本harnessへの移行.md` に添付）

| エンティティ | 状態値 (コード上の表記そのまま) | 表記揺れの観測 |
| --- | --- | --- |
| `syllabus_items`（シラバス項目。分野 → 大分類 → 中分類） | `field` = `ストラテジ系`／`マネジメント系`／`テクノロジ系`（資格版。ロードマップ型は対象ごと。正本は `src/shared/targets.json` の `fields`）。`major_no`/`major`・`middle_no`/`middle` | 中間階層が `中分類`（DB・要件定義書）／`単元`（画面。`labels.ts` に採択の理由）／`カテゴリ`（要件定義書 §5.2、API `/categories`、画面「カテゴリ別演習」）の 3 語 |
| `topics`（論点） | `is_new` boolean（分類時に新設した論点）、`sort_order` integer nullable（ロードマップ型の学ぶ順） | 日本語は `論点`（資格版）と `単位`（ロードマップ型の画面）。列名 `term` は `glossary.term`（用語名）と同綴・別概念 |
| `past_questions`（過去問） | `answer` = `ア`／`イ`／`ウ`／`エ`（zod）、`has_figure`・`modified`（一部改変）boolean、`content_key` nullable（同一内容の鍵）、`exam`（回の ID。例 `2024r06`）、`exam_label`（例 `令和6年度`） | `exam` が「回」（`past_questions.exam`）と「対象」（`env.EXAM`・`ExamKey`）の 2 概念に同名。同一内容は `同一内容`（コード）／`重複`（要件定義書）。出典は `出典`／`citation` で一貫 |
| `topic_questions` | `is_primary` boolean（seed は常に 1） | — |
| `users`（学び側の利用者） | `role` = `ADMIN`／`MEMBER`（既定 `MEMBER`）、`password_hash` は SSO で作られた行だけ文字列 `'sso'` | 人は `利用者`（本文）／`アカウント`（認証）／`ユーザー`（古い記述）。まなびば `accounts` と学び側 `users` の 2 表（メールで対応）。値 `MEMBER` の表示語は `利用者` |
| `progress`（論点ごとの理解度） | `status` = `1` 未理解／`2` やや理解／`3` 理解（既定 1。行が無ければ 1 扱い） | `status` が `progress`（数値）・`sessions`（文字列）・`feedback`（文字列）の 3 概念で同名。集計は `understood`/`partly`/`untouched` |
| `daily_visits` | `day` = 日本時間の暦日 `YYYY-MM-DD` | — |
| `sessions`（演習・模試） | `kind` = `drill`／`field`／`middle`／`review`／`mock`（zod 5 値。schema のコメントは 4 値で `middle` が漏れ）、`status` = `in_progress`／`completed`（コメントの `abandoned` はどこにも書かれない死んだ値。破棄は DELETE）、`source_exam`・`time_limit_sec` nullable、`scope_label` | 本番形式は `模試`（要件定義書）／`模擬試験`（UC・spec.yaml）／`過去問実践`（資格版の画面）／`確認テスト`（ロードマップ型の画面）。範囲つきは `練習テスト`（入口）／`演習`（総称）／`論点ドリル`（drill）。`弱点復習`（review）は一意 |
| `session_questions` | `result` = `0` 未回答／`1` 正解／`2` 不正解、`user_answer` = ア〜エ | — |
| `app_settings` | `id` = `'default'` の 1 行。`drill_size` 10、`mock_size` 100、`mock_time_limit_sec` 7200、`pass_overall_pct` 60、`pass_field_pct` 30、`mastered_streak` 3 | 値の SSOT はこの表と `targets.json`（R-102） |
| `question_explanations` | 主キー `content_key`。`choices_json` は `label`/`term`/`note` の 4 件 | — |
| `glossary`（用語ポップの用語） | `term` 主キー（`[[用語]]` と完全一致）、`topic_id` nullable | `用語`（画面）／`glossary`（表） |
| `feedback` | `kind` = `text`／`unclear`／`good`／`improve`／`other`（zod 5 値。schema コメントは 2 値）、`status` = `new`／`triaged`／`done` | — |
| まなびば `accounts` | `role` = `ADMIN`／`MEMBER`（表示語 `管理者`／`利用者`） | `役割`＝`role`、`権限`＝`grants` だが「管理者権限」は role を指す |
| まなびば `grants` | `learning` = 登録簿の key（`ip`/`ap`/`itc`/`mkt`/`msg`/`ecl`/`eca`/`cnv`） | アプリ 1 本ぶんの概念が `学び`／`対象`／`試験`／`題材` の 4 語、識別子は `exam`（学び側）／`learning`（まなびば）／`target`（scripts） |
| まなびば `sessions`・`sso_codes` | 状態列なし。`expires_at`・`used_at`（NULL＝未使用）で表す | `まなびば`／`入口`／`portal` |
| 画面の定数 | `STATUS_LABEL`（1/2/3 → 未理解/やや理解/理解）、`KIND_LABEL`（drill 論点ドリル／field 分野別演習／middle 単元演習／review 弱点復習／mock 過去問実践）、`SORTS`（画面 2 値 `frequency`/`name`、サーバは 3 値 `+recommended`）、`exam.words`（対象ごとの語: 過去問／確認問題、過去問実践／確認テスト）、`targets.json` の `kind`（`exam`/`roadmap`）・`roadmap`・`fieldThreshold`・`roadmapSpec` | 版の印は `版の印`（開発側）／`新しい版`（画面）、値は `build`＝`Stamp` |

## 発見した矛盾（→ OPEN-QUESTIONS へ転記済みであること）

| # | 矛盾の内容 | 関係箇所 |
| --- | --- | --- |
| 1 | §5.1「分野 → テーマ → カテゴリ → 論点」と実装「分野 → 単元 → 論点」（大項目は見出しだけ）。語も「カテゴリ／単元／中分類」で揺れる | `docs/要件定義書_draft.md` §5.1、`src/client/pages/Topics.tsx`、UC-004 |
| 2 | §5.1「出題頻度（29回中◯回）」に対し実装は分母を出さない | §5.1、`Topics.tsx`・`TopicDetail.tsx` |
| 3 | §4 と §15 で管理の範囲（アカウント削除・他人の名前と役割の変更）が食い違う | §4、§15、UC-002 |
| 4 | §13.5「資格版（据え置き）」列は対比の記述だが、規範として引かれた例があった（REQ-304 は取り下げ、REQ-133 は 2 本目の quote に残る） | §13.5、`docs/spec.yaml` REQ-133 |
| 5 | §16.1 用語の表示名の短縮に一意性の決まりが無く、`CRM` と `CRM（顧客関係管理）` が同じ表示名になる（ip 3・ap 9 組） | §16.1、`src/client/components/TermPop.tsx` |
| 6 | `getSecret` は JWT_SECRET 未設定で開発用の既定値に倒れる（REQ-049 は現物どおり。本番で秘密が無いと弱い鍵で動く） | `src/server/lib/db.ts`、REQ-049・095 |
| 8 | `status` が 3 つの別概念に同名（`progress.status` 数値、`sessions.status` 文字列、`feedback.status` 文字列）。`exam` が「対象」と「回」に同名。`term` が「論点名」と「用語名」に同名 | `src/server/db/schema.ts` |
| 9 | schema のコメントと zod の値域が食い違う: `sessions.kind`（コメント 4 値・zod 5 値）、`feedback.kind`（コメント 2 値・zod 5 値）。`sessions.status` のコメントにある `abandoned` はどこにも書かれない | `src/server/db/schema.ts:155`・`:164`・`:279`、`src/server/routes/sessions.ts:32`、`feedback.ts:17` |
| 10 | 論点一覧の並べ替えは画面 2 値、サーバ 3 値（`recommended`） | `src/client/pages/Topics.tsx:19-22`、`src/server/routes/catalog.ts:81` |
| 11 | 同じ機能が層ごとに別の語: `模試`（要件定義書）／`模擬試験`（UC・spec.yaml）／`過去問実践`・`確認テスト`（画面）。アプリ 1 本ぶんが `学び`／`対象`／`試験`／`題材` と `exam`／`learning`／`target` | 全層 |
| 7 | 作り手の助言「仕様に画面のことは書かない」に対し、§16（画面の共通の振る舞い）と §13.5/13.6（画面の要素）は UI の文言・役割を規範として持つ | §16、§13.5、§13.6 |

<!-- Written to docs/INVENTORY.md by /docs-migrate Phase 0. -->
