---
name: develop
description: 本人の要求（機能追加・変更・修正）を受けたときの入口。要件（docs/spec.yaml）の書き直し → 承認 → 製造とテスト設計を別コンテキストで並行 → npm test が通るまで → コミット。「〜を作って」「〜を直して」「〜を変えて」で使う。
---

# 開発の入口（要件 → 製造 ⫽ テスト設計 → 機械の門）

思想: **仕様が絶対の正解。** 要求はまず `docs/spec.yaml` の要件に写し、承認を得てから、製造とテスト設計を**別コンテキストで同時に**始める。どちらも同じ要件の文面だけを見る。完了は人の「確認しました」ではなく `npm test`（trace_check → vitest → check_source → check_docs）が全部通ること。書き込みの瞬間は `write_gate`（PreToolUse）、作業終了の瞬間は `stop_gate`（Stop）が機械で止める。

## 手順

1. **分類**（CLAUDE.md の 3 分類）: 質問／バグ修正／仕様変更。バグ修正は「要件は正しく実装が違う」＝対象の REQ を名指しする。仕様変更と機能追加は要件を書き換える
2. **要件を書く（承認前に製造しない）**
   - 新規: `bash scripts/trace_check --next req` で ID を取り、`docs/spec.yaml` に `status: draft` で足す（UC が無ければ `--next uc`）。description は「条件・振る舞い」、acceptance は「機械で確かめられる受入の条件」
   - 変更: 該当 REQ の文面を書き換える（足さない。経緯は git）。取り下げは `status: withdrawn`
   - バグ修正: spec は触らず `.trace-gate/work.json` に `{"reqs": ["REQ-xxx"], "kind": "bugfix", "note": "…"}` を書く（write_gate がこれを見る）
   - 本人に要件の文面を示して承認を得る。既存の文書（要件定義書・不変条件）と矛盾するなら矛盾を提示して止まる
3. **製造とテスト設計を別コンテキストで並行**（Agent を 1 回の応答で同時に起こす）
   - `implementer`: REQ の ID・文面・関連ファイルを渡す。テストは書かせない
   - `test-author`: REQ の ID・文面と**契約**（公開関数の名前・引き数・応答の形。実装が先に決めた外形）だけを渡す。実装ファイルのパスを渡さない。Bash は持たない
   - 契約がまだ無い新規機能は、implementer に「契約（外形）だけ先に返す」短い 1 巡目をさせ、その契約で test-author を起こす
4. **機械の門**: `npm test` を回す。`[NG]` と赤を、どちらの欠陥か切り分けて戻す（実装の欠陥 → implementer／テストが要件と違う → test-author／要件の空白 → 2 へ戻り本人へ）。**実装側にテストを書き換えさせない。test-author に実装を見せない**
5. `draft` の REQ を `active` にし、`npm test` が全部通ったら `.trace-gate/work.json` を消してコミット（Conventional Commits）。Stop フックが最後にもう一度回す
6. 挙動を変えたら `docs/不変条件と門.md`・`brain/PREMISES.md` の反映先（`→ 反映:`）を更新。作業ログは点、仕様書は現在形

## やらないこと
- 要件を書かずに製造を始める（write_gate が止める）。要件に無い振る舞いを足す。除外（`trace_ignore`）で通す
- 実装した文脈でテストを書く／test-author に実装を読ませる（`reports/106`）
- 検査の緩和・skip・中身の無いテストやタグ（本人の許可制）
