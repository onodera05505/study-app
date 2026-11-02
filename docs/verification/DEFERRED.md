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
| DEF-029 | 2026-11-02 | reviewer（slice: 章と印） | REQ-279・282・284・281・129・135 と BR-037 の `@implements` の置き場 | 1 つの REQ に 2〜3 か所の `@implements` が付いている（経路・登録簿の語の関数・画面）。BR-037 を守るのは門なのに、表示の関数にも `@implements BR-037` がある | C14 は存在を見るだけで粒度は機械が見ない（R-705・R-901）。昇格の案: 経路側は契約の列を返すだけなので REQ の注釈を外し、BR-037 の注釈は門（check_roadmap_registry.py）に寄せる整理の件を立てる | 未定 |
| DEF-030 | 2026-11-02 | reviewer（slice: 章と印 2 巡目） | src/client/pages/Roadmap.tsx の先頭の導線 ⇔ REQ-283・REQ-144 | 印で絞り込んだ中に未理解の単位が無いとき、先頭の導線は REQ-144 の 3 段目（論点の一覧の先頭＝ロードマップ自身、「最初の単位から始める」）に下がる。一方、先頭の行の「次は X」は絞り込みに従わず残る | REQ-283 の「『ここから』の段が指す単位だけを変える」がこの組み合わせで (a) 3 段目へ下がる（今の実装）とも (b) 絞り込みの外の「ここから」を残すとも読める。昇格の案: 本人がどちらかに決めたら REQ-283 にクラスを足してテストで固定 | test |
| DEF-031 | 2026-11-02 | reviewer（slice: 返済 UC-004） | tests/client/repay_UC-004_practice.test.tsx | findReload ⇔ REQ-244「読み直す手段を添え」・BR-014。カテゴリ別の節を DOM 順に押して取り直しが増えた最初の物を手段とみなすため、先頭の分野チップが手段として返り、専用の「再読み込み」は観測されない。反例: 専用ボタンを消してもテストは緑 | 「添える」が範囲チップと別の操作部を要求するかは本人の読み。要求するなら候補から aria-pressed のチップを外し、同じ field= を取り直すことを要求するテストに再導出する | test |
| DEF-032 | 2026-11-02 | reviewer（slice: 返済 UC-004） | tests/server/repay_UC-004_sessions.test.ts | review の scopeLabel ⇔ REQ-050 #scope-label-and-count「種別ごとの形で返る」。review だけ空でなければ何でも通る。反例: scopeLabel が "a" でも緑 | 契約の例 okReview（間違えた問題の復習）の文言を規範とみなすかは本人の判断。みなすなら /復習/ を要求する | test |
| DEF-033 | 2026-11-02 | reviewer（slice: 返済 UC-004） | scripts/check_api.py | UC-004 のシナリオ ⇔ UC.md 主シナリオ 1〜3・事前条件。ステップ 1〜2 で分野と単元の一覧を出した後、開始が kind: drill・topicId で練習テストの画面に無い入口を継いでいる（R-1107） | 再導出（ステップ 1 で得た field か categories[0].middleNo で始める）は track scenario の仕事で生の wrangler を要する（DEF-016 と同じ性質） | 未定 |
| DEF-034 | 2026-11-02 | reviewer（slice: 返済 UC-004） | src/server/routes/sessions.ts | 回答の記録 ⇔ REQ-066「1 件だけ残す」・REQ-061。同じ idx の回答が同時に 2 本届くと、どちらも result = 0 の行を読んで同じ行を 2 度 UPDATE し、後着が先着の user_answer を上書きする。逐次のテストでは見えない | 同時性は /attack の層。案: UPDATE に AND result = 0 を足し、更新 0 行を 409 にする（仕様の追記が先。/attack の層） | 未定 |
| DEF-035 | 2026-11-02 | reviewer（slice: 返済 UC-017） | src/client/lib/api.ts | 理由の取り出し ⇔ REQ-261 の境界の扱い・_shared ErrorBody（error: string minLength 1）。400 {"error":""} → 空文、{"error":123} → "123"、{"error":{...}} → "[object Object]"。今日のサーバはどれも作らないので反例は仮想 | 「error が空でない文字列でない本文は理由が無い側か」を決めれば #reason-absent-fallback に入力を足して機械化できる | test |
| DEF-036 | 2026-11-02 | reviewer（slice: 返済 UC-017） | src/server/index.ts | portal/src/index.ts と /api の射程が違う ⇔ REQ-256「受け持たない /api の経路」。GET /api（末尾スラッシュ無し）はまなびば 404、学び側は 200 の SPA HTML | REQ-256 の境界の扱いは「/api 配下」と書き /api 自身を決めていない。決めれば #unknown-path-anonymous に 1 入力で機械化できる | test |
| DEF-037 | 2026-11-02 | reviewer（slice: 返済 UC-017） | src/client/lib/api.ts | parseBody と throw の両方に REQ-261 の @implements が付く。1 要件 2 ユニット（DEF-029 と同種、対象 REQ が違う） | C14 は存在しか見ない（R-705・R-901）。置き場の整理は DEF-029 と一緒に | 未定 |
| DEF-038 | 2026-11-02 | reviewer（slice: 返済 UC-017） | scripts/check_api.py | UC-017 のシナリオが主シナリオ（R-1107）と合わない: DELETE /sessions/current（UC-006 の破棄）を 2 回行い、questionCount ≤ 2 は UC-004 の文の断言。ラベル番号も UC のステップ番号と一致しない | 再導出は track scenario の仕事で実 API と D1 を要する（DEF-016 と同じ性質） | 未定 |
