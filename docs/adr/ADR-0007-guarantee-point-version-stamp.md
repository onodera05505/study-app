---
id: ADR-0007
title: 保証点 — 「版の印を書き出せない版は本番に出さない」（REQ-226）は配備の手続きが守る
status: accepted
date: 2026-10-01
---

# ADR-0007 保証点 — 「版の印を書き出せない版は本番に出さない」（REQ-226）は配備の手続きが守る

## Context

REQ-226（UC-016）は「版の印を書き出せない版は本番に出さない」。守りうる点は 2 つ: `scripts/deploy-pages.sh` が `set -euo pipefail` の下で `dist/version.json` を書き出し、失敗すれば配備の前に止まる／`scripts/check_render.tsx` の項目が `dist/version.json` の存在と形を見る（ただし今はビルド前に回る順序で、印を見る検査としては効いていない。OQ の運用 6）。

## Decision

保証点は `scripts/deploy-pages.sh`（配備の手続きが止まる）。`check_render.tsx` の項目は検証（verification）であり保証点ではない。守る箇所: `deploy-pages.sh` の `set -euo pipefail` と書き出しの順序（配備の前）。

## Consequences

- よい: 配備の 1 本道（ADR-0002）に乗っているので、スクリプトを迂回しなければ必ず効く。
- 悪い: `wrangler pages deploy` を直に叩けば迂回できる（`CLAUDE.md` の落とし穴に既出）。`check_render.tsx` の版の印の項目は順序の問題で空振りしている（移行後の返済候補）。

## 却下した選択肢

- **`check_render.tsx` を保証点にする**: ビルド前に回る今の順序では印が無いのが正常で、検査にならない。順序を変えるのは移行後。
