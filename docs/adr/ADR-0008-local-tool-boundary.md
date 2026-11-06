---
id: ADR-0008
title: 手元の道具の境界 — 作り手が呼ぶコマンドとそれが読み書きするファイルを local-store で読む
status: accepted
date: 2026-11-05
---

# ADR-0008 手元の道具の境界 — 作り手が呼ぶコマンドとそれが読み書きするファイルを local-store で読む

## Context

GOAL-10 の UC-018（教材の門）と GOAL-12 の UC-019（学習者役のパックと採点）の境界は、作り手が手元で呼ぶコマンドと、そのコマンドが読み書きするファイル（書き手の出力・自己申告・パックの写し）である。HTTP も SDK も通らない。R-1206 はすべての UC に契約を求め、HTTP でない境界に HTTP の operation を作ることを禁じる。spec-lint の transport の閉じた集合（http / sdk / local-store / deeplink / push / device / internal）には、コマンドやファイルを表す語が無い。ADR-0001 は端末の記憶を local-store で読んでいる。

## Decision

手元の道具の境界は `transport: local-store` で書く。コマンドの入口は `direction: inbound` とし、request に引数、response に結果の形と終了の状態を持つ。コマンドが読み書きするファイルは `direction: outbound` とし、response にファイルの中身の形を持つ。閾値・別名・1 単位の問題数などの値は、契約の型か例に持つ（R-102）。コマンドの入口が読み書きするファイルは、それぞれ読む操作（`read*`）・書く操作（`write*`）として同じ契約に置き、読む操作は中身の形を response に、書く操作は中身の形を request に持つ。ADR-0001 の 3 は鍵名を operation 名で表し値の形を request に書くが、この ADR ではファイルの向きに合わせて形の置き場を分ける。ADR-0001 の「端末の記憶は local-store」を作り手の手元のファイルにも広げる読み方であり、手元の道具の UC はすべてこの読み方に従う。

## Consequences

- よい: 門・パック・採点の入口と結果の形が契約に載り、test-author が実装を読まずに境界のテストを導ける。値の正本が契約に 1 つになる。
- 悪い: local-store は本来、利用者の端末の記憶を指す語で、読む人が取り違えうる。contract-run の adapter は未宣言なので、契約の例は実行されない（`docs/検証の返済計画.md` が持つ既知の穴と同じ）。

## 却下した選択肢

- **http**: HTTP の通り道を作り話にすることになり、R-1206 が禁じる。
- **internal**: 同じプロセスの中のモジュールの境界の語で、作り手が別のプロセスから呼ぶ境界に合わない。
- **operations: {} と x-no-boundary**: 書き手・学習者役という別の文脈とファイルで受け渡すので、境界が無いとは言えない。
- **harness の transport に cli を足す**: harness 側の変更でこのホストだけでは決められない。足されたら、この ADR を supersedes で置き換える。
