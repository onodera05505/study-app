# 23. 模試の問題数が試験の設定でなく app_settings の列の既定値（100 問）になる

- **日付/場所**: 2026-09-15 / ロードマップ試作（itc）を 3 つ目の試験として投入したローカルの受入検査
- **症状**: `POST /api/sessions {"kind":"mock"}` が 42 問（`src/shared/exam.ts` の `mockSize`）でなく **84 問**（全問）になった。
- **原因**: `sessions.ts` の `settings()` は `app_settings` に行があればそれを優先する。seed が `INSERT INTO app_settings (id) VALUES ('default')` と id だけ入れるため、
  `mock_size` は列の既定値 **100**（IT パスポート用）になり、試験ごとの設定が使われない。ランダム構成は分野比率で 42 問選んだ後、`size` に足りない分を残りから埋めるので全問になった。
  **応用情報（80 問・150 分）も同じ経路で 100 問・120 分になっている可能性がある**（本番の行は未確認）。
- **対処**: `build_seed.py` が `EXAM_SETTINGS`（試験 → 問題数・秒）で `mock_size` / `mock_time_limit_sec` を入れて行を作る（`ON CONFLICT DO NOTHING`。既存の行は触らない）。ローカルの itc は UPDATE で直した。
- **再発防止**: 新しい D1 は seed で正しい値になる。既存 DB（ip / ap の本番）は `SELECT mock_size, mock_time_limit_sec FROM app_settings` で確かめ、違えば UPDATE（要本人確認）。門は無し（`check_api.py` の「セッションの流れ」は問題数を試験の設定と比べていない。足すなら `mock` の `questionCount == exam.mockSize`）。
- **検索語**: 模試 問題数 100 になる, mock_size 既定値, app_settings 上書き, ランダム模試 全問
- **アプローチへの反映**: 中央 `配信先と実行環境を決める.md` の確認項目に「試験（対象）ごとの設定値が DB の既定値で上書きされないか」を足す候補。今回は固有の実例としてここに置く
