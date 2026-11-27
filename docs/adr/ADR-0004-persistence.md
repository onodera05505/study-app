---
id: ADR-0004
title: 永続化の置き場 — 学びごとの D1、drizzle の schema が正本、端末の記憶は localStorage と sessionStorage
status: accepted
date: 2026-10-01
---

# ADR-0004 永続化の置き場 — 学びごとの D1、drizzle の schema が正本、端末の記憶は localStorage と sessionStorage

## Context

現物: 学び側は学びごとに D1 を 1 つ（`wrangler.jsonc` の `env.<学び>.d1_databases`。バインディング名は全て `DB`）、形の正本は `src/server/db/schema.ts`（drizzle）と `migrations/*.sql`。まなびばは `manabiba-db`（`portal/migrations/0001_init.sql`）。利用者の記録（`progress`・`sessions`・`session_questions`・`daily_visits`・`feedback`・`users`）は本番の D1 にしか無く、初期データの投入（seed）はこれらに触れない UPSERT（BR-032）。端末側は localStorage にトークンと最後に開いた論点（ログアウト・401 で両方消す。BR-010）、sessionStorage に期限切れの印・直前の画面（添え先）・フィードバックの下書き。メモリに取得の記憶・用語集・版の印（読み直しで消える）。時間の境界（配った版が書いたデータの互換）は、D1 は migrations が担い、端末の記憶は読めない値を無視して機能を出さないだけにする（BR-011）。

## Decision

現物のとおり記録する。DB の形の正本は drizzle の schema と DDL（R-704。`traceconfig.json` の `schema.files`）。学びをまたいでデータを混ぜない（BR-033。配備の設定が守る）。端末の記憶は「端末の中だけで通用し、読めなければ出さない」（BR-011・012）。守る箇所: `scripts/check_seed.py`・`seed_remote.sh`（BR-032）、`scripts/deploy-pages.sh`（学びごとの D1 のバインディング）、`src/client/lib/api.ts` の `clearToken`（BR-010）。

## Consequences

- よい: 学びの追加が D1 の作成と env の追加で済む。seed の再投入で利用者の記録が消えない。
- 悪い: 端末の記憶の形（鍵名・JSON の形）に版の互換の仕組みが無く、形を変えたら古い値を黙って捨てるしかない（規約の葉 R-1202 の golden fixture は未採用。移行後の候補）。学びごとに D1 が分かれるので、学びをまたぐ統計はできない（vision の「やらないこと」と整合）。

## 却下した選択肢

- **記録なし**: 当時の比較は記録されていない（移行時に付した記録）
