---
id: ADR-0001
title: 境界の読み方 — どの呼び出しを契約の operation にし、transport・direction・auth をどう当てるか
status: accepted
date: 2026-10-01
---

# ADR-0001 境界の読み方

## Context

原本 harness への移行（docs-migrate Phase 5）で、UC 15 本に `contract.yaml` を書く。契約は「所有・変更の頻度・寿命が違う 2 者の間の、機械可読な合意」（規約の葉 §12）で、HTTP だけではない。この学びの境界はコードの読み取り（2026-10-01、`docs/作業ログ_2026-09-30_原本harnessへの移行.md`）で次のとおり: 学び側の HTTP API 22 経路（Bearer）、まなびばの HTTP API 14 経路（Cookie セッション）、学び側サーバからまなびばへの交換の呼び出し（共有秘密を本文に載せる）、端末の記憶（localStorage 2 鍵・sessionStorage 3 鍵・メモリ 3 か所）、配信物の静的ファイル `version.json`、D1（学びごとに 1 つ）、Cloudflare Pages の秘密（名前だけを検査が見る）、外部 API は無い。エラーコードの単一の出所は無く、全経路が `{error: 日本語 1 文}` を直書きしている。契約の担当は UC ごとに並行で書くので、transport と direction と auth の当て方を 1 か所で決め、担当ごとに再判断させない（R-1204・R-1206・R-1207）。

## Decision

1. **HTTP の経路は 1 経路 1 operation**。学び側の API は `transport: http`・`direction: inbound`・`owned: true`・`auth: bearer`（`/api/health` と `/api/auth/*` は `auth: none`）。まなびばの API は同じく inbound・owned で `auth: session`（`/api/health`・`/api/learnings`・`/api/login` は `none`、`/api/sso/exchange` は `auth: sharedSecret`）。`/sso/start` はブラウザが開く経路なので inbound の http（応答は 302）。operation 名は振る舞いの動詞＋目的語の lowerCamelCase（例 `startSession`・`exchangeCode`）。**entry（コードの入口）は Hono のルートハンドラ**で、operation 名 → 入口の対応は Phase 7 で `CLAUDE.md` に 1 行で宣言する（rules パッケージが無いため。R-1204）。
2. **学び側サーバがまなびばの交換を呼ぶ呼び出し**は、まなびば側の inbound operation（UC-013 の契約に `exchangeCode`）として 1 回だけ書く。学び側から見た outbound を別に書かない（同じ形の二重の正を避ける。R-101）。学び側の `POST /api/auth/sso` はそれとは別の inbound operation。
3. **端末の記憶**（localStorage・sessionStorage）は `transport: local-store`・`direction: outbound`・`owned: true`・`auth: none` の operation。鍵名は `request`/`response` の形の中ではなく operation 名で表し、値の形を `request` に書く。**メモリ上の記憶**（取得の記憶・用語集・版の印の保持）は境界でない（同じプロセスの中）ので operation にしない（R-1204）。
4. **配信物の静的ファイル（版の印）**を画面が取りに行くのは `transport: http`・`direction: outbound`・`owned: true`・`auth: none`（自分の配備の静的ファイルを呼ぶ。UC-016）。配信の手続きが印を書き出す側は operation にしない（ビルド時の成果物。正本は `scripts/deploy-pages.sh`）。
5. **D1 と配備の設定は契約の operation にしない**。DB の形の正本は drizzle の schema と DDL（R-704）、配備の設定は `wrangler.jsonc`（R-1203）。
6. **本番の検査（UC-015）**は、死活確認と入口の画面を外から叩く operation（http・outbound・owned・none）と、Cloudflare の秘密の一覧を読む operation（`transport: sdk`・`owned: false`・`source: Cloudflare wrangler`）で表す。
7. **UC-005（前回の続き）・UC-001 のメモリの記憶**など、境界が端末の記憶だけの UC はその local-store operation を書く。境界が本当に無い UC は無い見込みだが、あれば `operations: {}` と `x-no-boundary`（R-1206）。
8. **エラーコードの語彙**は `docs/_shared/components.yaml` の `errorCodes` に閉じる（HTTP の status は `wire.status` で持つ）。失敗条件の評価順は各 operation の `errors` の並びだけが持つ（R-1207）。コード側に単一の出所が無いので `traceconfig.json` の `contract` ブロックは置かず C7 は skip（Phase 7 の返済候補）。
9. **認証スキーム**は `bearer`（学び側）・`session`（まなびば）・`sharedSecret`（交換）の 3 つ（`docs/_shared/components.yaml`）。
10. 2 つ以上の UC が使う形（`ErrorBody`・`Ok`・`QuestionSnapshot`）だけを `_shared` に置き、1 UC の形はその契約に書く。足したい物は担当が報告し、orchestrator が足す。**同じ経路は 1 つの契約にだけ書き、他の UC は `UC-nnn: <operation 名>` で参照する**（同じ形が 2 か所に立つと片方だけ直る。R-101）。
11. 横断の決まり（BR-001・BR-002・BR-014・NFR-001）の射影は、1 回の着座の価値を持たない UC（UC-017）に束ねて REQ の置き場にする。R-503 の例外で、`@covers` の先が REQ にしか無いために置く。主アクターは配備を扱う運用者（ACT-03）。

守る箇所: spec-lint（`transport`・`auth`・`errors[].code` の語彙、operation の鍵の閉じた集合）。operation 名 → 入口の規約は Phase 7 まで文書だけ（R-901 の説得的統制）。

## Consequences

- よい: 15 本の契約が同じ読み方で書かれ、担当は transport を再判断しない。学び側とまなびばの間の交換は 1 か所に書かれる。
- 悪い: 学び側から見た outbound の形（相手が返す物をどう畳むか）は UC-013 の学び側 operation の `errors` に押し込まれ、交換の失敗の畳み方（403 だけ 403、他は 401）が 2 つの operation にまたがって読まれる。メモリの記憶を operation にしないので、取得の 1 回性（REQ-001・227）の検証は契約でなくテストに頼る。エラーコードの語彙とコードの `{error}` の文は機械で突き合わされない（C7 skip）。
- 運用: 経路を足すときは operation を足し、`errors` の並びを評価順どおりに書く。

## 却下した選択肢

- **内部のモジュール境界（UI → 取得関数 → サーバ）も `internal` で契約する**: 型システムが契約で、C6 の層構造も宣言していない。契約が倍に増えるだけで検査が増えない（R-1204）。
- **学び側→まなびばの交換を学び側の outbound として別に書く**: 同じ形が 2 か所に立ち、片方だけ直る。まなびば側の inbound に寄せる。
- **メモリの記憶を local-store にする**: プロセスの外に出ない物を境界と呼ぶと、契約が実装の構造を写すことになる（R-401 の裏返し）。
- **エラーコードをコードに新設して C7 を効かせる**: 挙動を変える（A-3）。移行後の返済候補として残す。
