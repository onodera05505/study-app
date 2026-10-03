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
| DEF-008 | 2026-10-03 | reviewer（slice: 署名の秘密）| `docs/goals/GOAL-06-delivery-and-operations/UC-017-guard-api-boundary/REQ-257.md` | REQ-257 の `検証しない` ⇔ UC-017 表①行 4。署名の秘密が無い配備で本文を取る認証を要さない経路は発行の 3 本だけで、すべて REQ-274 が先に断る。REQ-257 側はどの実在の入力でも成り立たない（表のセルは直した） | REQ-257 の `検証しない` に REQ-274 との先後を書く作業（test-author の持ち物）。機械は観測できない | 未定 |
| DEF-009 | 2026-10-03 | reviewer | `src/server/routes/auth.ts` | BR-002 ⇔ 404 の本文「この環境では SSO が設定されていません」。404（まなびばの場所が無い）と 503（秘密が無い）で本文が変わり「どの設定が足りないか」が外から判る。(A) 404 の本文も名指しをやめる（実装）か (B) まなびばの場所の有無は REQ-205 が公に答える設計なので BR-002 の射程を秘密に絞る（文）か | どちらの層を直すかは本人の決め（OQ-174）。(A) なら本文の等値を見るテストで昇格 | test |
| DEF-010 | 2026-10-03 | reviewer | `src/server/index.ts` | `hasRouteHandler` が引数の数で前置きと具体のハンドラを見分ける。将来 `(c, next)` 形のハンドラを足すと前置きと見なされ認証ミドルウェアを飛ばす。今の門 `protection.test.ts` は手書き 13 本で `/api/sessions/:id/*` の 4 本を含まない | 昇格の案: `app.routes` から経路を導いて「/api/auth/* と /api/health 以外は匿名で 401」を全件断言するテスト（`/attack` 向け） | test |
| DEF-011 | 2026-10-03 | reviewer | `docs/goals/GOAL-06-delivery-and-operations/UC-017-guard-api-boundary/REQ-275.md` | REQ-275 `#public-route-not-refused` の説明・REQ-206 の frontmatter `br:`・REQ-256 の `@implements` が 2 か所。クラスの説明が死活確認だけを名指す（getAuthConfig の 2 本目を含まない）。REQ-206 のクラスの根拠が BR-002 なのに `br:` が無い。REQ-256 が認証ミドルウェアと notFound の 2 か所に注釈（1 要件 1 か所） | 文書の整合。C14 は存在だけを見る | 未定 |
| DEF-012 | 2026-10-03 | reviewer | `tests/server/protection.test.ts` | 「本人として通る側は来訪の記録で D1 に書く」のコメント、および `scripts/check_api.py` の `check_scenario_uc014`（`@scenario UC-017`）の関数名・ラベル `UC-014`・step 6 の O5 の断言。実装の変更で成り立たない古い都合のコメント。シナリオが主シナリオに無いステップ（R-1107）を含む | コメントと名の整理（implementer）。R-1107 は人の読み | 未定 |
