---
id: ADR-0005
title: 層構造 — ディレクトリで分け、依存の向きは型システムに任せる（C6 の宣言は置かない）
status: accepted
date: 2026-10-01
---

# ADR-0005 層構造 — ディレクトリで分け、依存の向きは型システムに任せる（C6 の宣言は置かない）

## Context

現物: `src/client`（pages・components・lib）、`src/server`（routes・lib・db）、`src/shared`（学びの登録簿 `targets.json` と `exam.ts`）、`portal/src`（Hono 1 ファイル＋静的な画面）。client と server は `shared` だけを共有し、互いを import しない。server の中は routes → lib → db の向きだが、lint や trace-check の `layering`（C6）で強制していない。規約の葉 R-702 は「層の向きは lint か C6 で強制する」と言うが、この学びの層は 3 つの最上位ディレクトリで、C6 の `layer_pattern` で表せる形（`{layer}` が最上位）ではある。

## Decision

移行中は `layering` を宣言せず、依存の向きは TypeScript の型システムと import の実在に任せる（R-1204。モジュール間の契約は型）。client ↔ server の分離は Vite のビルド（client）と wrangler のビルド（server）が別の入口を持つことで実質的に守られている。Phase 7 の返済候補として「`layering: {root: src, forbidden: {client: [server], server: [client]}}` を置いて C6 を効かせる」を残す。守る箇所: 今はビルドの入口の分離だけ（R-901 の説得的統制）。

## Consequences

- よい: 移行中に新しい検査を増やさず、A-5 の baseline を育てない。
- 悪い: server のコードを client が import しても trace-check は気づかない（ビルドが落ちる経路はあるが、型だけの import は通る）。

## 却下した選択肢

- **記録なし**: 当時の比較は記録されていない（移行時に付した記録）
