---
id: ADR-0002
title: 実行環境と配信の構成（Hono・React/Vite・Cloudflare Pages・D1・drizzle。現在の記録）
status: accepted
date: 2026-10-01
---

# ADR-0002 実行環境と配信の構成（Hono・React/Vite・Cloudflare Pages・D1・drizzle。現在の記録）

## Context

原本 harness への移行（Phase 5）で、現在のアーキテクチャを決定として記録する。仕様書 `docs/要件定義書_draft.md` §8 は「Hono（Workers）・D1・React＋Vite・Workers Assets で 1 デプロイ・ORM は要決定（推奨 Drizzle）・認証 JWT＋bcryptjs」と書いた。現物（2026-10-01）は、API は Hono、画面は React＋Vite の SPA、配信は **Cloudflare Pages**（`scripts/deploy-pages.sh` が `wrangler.jsonc` の `env.<学び>` から D1 のバインディング込みで配備。学びごとに別の Pages プロジェクト）、DB は Cloudflare D1、ORM は **drizzle**（`src/server/db/schema.ts`・`migrations/`）、認証は JWT（HS256）＋ **PBKDF2**（Workers の上限 100,000 回。bcryptjs ではない）。まなびば（`portal/`）は別の Pages プロジェクトで、Hono 1 ファイル＋静的な画面。コンテンツ生成は Python（範囲外）。§8 の「Workers Assets」と「bcryptjs」は現物と違う（配信先を Pages にした経緯は `CLAUDE.md` の「workers.dev の URL にアカウント名が入る」）。

## Decision

現物のとおり記録する: API＝Hono、画面＝React＋Vite SPA、配信＝Cloudflare Pages（学びごとに 1 プロジェクト、D1 のバインディング込み。`scripts/deploy-pages.sh` 経由だけ）、DB＝D1、ORM＝drizzle（schema が DB 設計の正本。R-704）、認証＝JWT HS256＋PBKDF2、まなびば＝別の Pages プロジェクト。守る箇所: `scripts/deploy-pages.sh`（配備の 1 本道）、`scripts/check_source.py`（PBKDF2 の上限）、`traceconfig.json` の `schema.files`。仕様書 §8 の技術の表は Phase 7 で attic にし、この ADR が記録になる。

## Consequences

- よい: 配信・DB・ORM の正本が `wrangler.jsonc`・`schema.ts`・`deploy-pages.sh` に閉じる。学びごとに Pages と D1 を分けるので、学びを足す作業が登録簿と env の追加だけになる（BR-005・BR-033）。
- 悪い: 学びの数だけ配備が増え、本番の検査（UC-015）も学びの数だけ回る。Pages は secret を更新しても再配備するまで反映しない（`CLAUDE.md` の落とし穴）。

## 却下した選択肢

- **Prisma＋`@prisma/adapter-d1`**: §8 に比較あり。生成ステップとバンドルの重さ、§6 のデータモデルが前身と違い流用が効かないため Drizzle に（§8 の推奨どおり）。
- **Workers Assets で API と同一 Worker から配信**: §8 の案。workers.dev の URL に本名（アカウント名）が入り、共通サブドメインを変えると同アカウントの稼働中の Worker の URL も変わるため Pages に（`CLAUDE.md`）。
- **bcryptjs**: 現物は PBKDF2。比較の記録は無い（移行時に付した記録）。
