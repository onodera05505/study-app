---
id: VERIFICATION_DEFERRED
status: living
---

# 保留台帳（機械判定できない指摘）

reviewer の指摘のうち、機械検査（spec-lint / trace-check / contract-run / テスト / 型 / lint / hook）に落とせないものだけを 1 行 1 件で持つ。
解消したら行を消す。機械検査へ昇格したら行を消す（縮む方向にしか動かない）。書くのは orchestrator だけ。
機械判定できる指摘はここに書かない — テストか lint に変換して機械側で赤にする。

## 保留中の指摘

| ID | 起票日 | 出所 | 対象 | 指摘 | 機械判定できない理由（反例） | 昇格先 |
| --- | --- | --- | --- | --- | --- | --- |
| DEF-001 | 2026-09-30 | reviewer（シナリオテストと仕様の空白埋めの審査） | `src/client/App.tsx` の未認証ガード ⇔ REQ-305（draft） | トークン無しでどの場所もログイン画面、という出荷済みの振る舞いを支配する active な要件が無い。ガードを消しても `npm test` は緑 | REQ-305 が draft（本人の承認待ち）の間は検査の対象外。昇格の案: REQ-305 を active にし、トークン無しで `/topics` を開いて中身が描かれない断言 1 本 | test |
| DEF-002 | 2026-09-30 | reviewer | `src/client/components/TermPop.tsx` の表示名の短縮 ⇔ §16.1 | 閾値を外したことで、別項目の用語が本文で同じ表示名になる組が ip 3・ap 9（`CRM`／`CRM（顧客関係管理）`、`ROA`／`ROA（総資産利益率）` など） | §16.1 に一意性の決まりが無く、現実装は仕様どおり。昇格の案: §16.1 に「短くすると他の語と同じ表示名になる語は落とさない」を本人が足せば `check_render`／単体で機械判定できる | test |
| DEF-003 | 2026-09-30 | reviewer | 同上 ⇔ REQ-140「括弧書き（読み・英字表記）」 | 読みでも英字表記でもない括弧書き（itc `DX（デジタル化との違い）`、mkt `4P（打ち手の組み立て）`、msg `やってはいけない相手（禁忌）`）も落とす | 仕様書 §16.1 の括弧が例示とも条件とも読める。昇格の案: §16.1 の括弧を条件にするか例示にするかを本人が決めたら、条件なら括弧の中身の型を見るテスト | test |
| DEF-004 | 2026-09-30 | reviewer | REQ-126・REQ-279 の acceptance ⇔ `@implements` の単位 | 「回の新しい順」「代表を含めない」を保証するのは `session-builder.ts` の `dedupe`（REQ-021）で、REQ-126 の単位（`DupBadge`）の外。3 件以上の並びを確かめるテストがどこにも無い。REQ-279 の「画面を開いたときに」も `App` 側 | 1 要件 1 か所の原則で acceptance の一部が別の単位に属する。昇格の案: `dedupe` に 3 回組の並びを見るケースを REQ-021 の `@verifies` に足す（test-author） | test |
| DEF-006 | 2026-09-30 | reviewer | `traceconfig.json` の `commands.system`（`check_api.sh ip` のみ） | UC-011 のまとめる側（step 3・4）は ip に同一内容の組が無く恒久的に未検査。組を持つのは ap | 遅い層の対象の選択は設定の問題で、検査自体は書けている。昇格の案: `commands.system` に `check_api.sh ap` を足す。2026-09-30 に試すとローカルの ap D1 が無く検査用アカウントの登録が 500 で止まる（環境の準備が先。実行時間も増える。本人の判断） | test |
| DEF-007 | 2026-09-30 | reviewer | `.github/workflows/test.yml`・`.githooks/pre-push` | サーバ経路のシナリオ 9 本を回すのは pre-push だけで `--no-verify` で迂回できる。CI は `npm test` のみ | CI で wrangler dev（D1 のローカル）を立てる配線が要る。昇格の案: CI に遅い層を足す（本人の判断） | 未定 |
| DEF-016 | 2026-10-03 | reviewer | scripts/check_api.py | `check_scenario_uc006_007` に `@scenario UC-006` と `UC-007` の 2 本が同居し、主シナリオに無いステップ（破棄・履歴）を含む（R-1107） | UC-006/007 のシナリオを 1 UC 1 関数に再導出するのは track scenario の仕事で、実 API と D1 を要する（OQ-181）。関数名・ラベル・REQ-240 の参照先は直した | 未定 |
| DEF-026 | 2026-10-03 | reviewer（slice: 第 3 件の続き） | src/server/db/schema.ts | 契約 `SessionRow.scopeLabel` は `string minLength 1`（UC-006/008）だが列 `scope_label` は null 可。作る経路（session-builder）は全て空でない文字列を入れるので実在の反例は作れない | 保存先を締める（`.notNull()`）は本番 D1 の移行を伴う。昇格の案: schema に `.notNull()` を足し、session-builder の返り値の型と突き合わせる（本人の判断） | test |
| DEF-027 | 2026-10-03 | reviewer | docs/goals/GOAL-03-roadmap-learning/UC-009-follow-roadmap-day/UC.md | 状態×イベント表の行軸は「学ぶ順の並びの上で開いている層」なのに、行「ロードマップ（進行中の案内が出ている）」は層でなく案内の状態。畳む決定の帰結だが軸の意味が 1 つの表で 2 種類 | 表の読みの問題で機械は見ない。UC-009 を次に触る件で spec-author が行軸の名を広げるか行を分けるかを決める | 未定 |
