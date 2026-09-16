---
name: improve-from-feedback
description: 利用者が画面から送ったフィードバック（feedback 表）を取り出し、質問／バグ／仕様変更に分けて直し、再投入し、処理済みにする改善フェーズ。「フィードバック見て」「改善フェーズ回して」で使う
---

# フィードバックから改善フェーズを回す

利用者は画面の「フィードバック」から自由記述を送る（要件 §5.5-4）。その場で AI は応答しない。
溜まったものをここで読み、直し、処理済みの印を付ける。**唯一の読み口は `scripts/feedback.py`**（利用者向けの一覧 API は無い）。

## 手順

1. **取り出す**: `python3 scripts/feedback.py fetch --every`（対象ごとなら `fetch mkt`）。
   未処理（status=new）が `data/<key>/feedback/inbox_<日付>.json` に保存され、画面に一覧が出る。
   `page` / 論点名 / `question_id`（`<セッション ID>#<番号>`）で、どの画面についての意見かが分かる。
2. **分ける**: 1 件ずつ CLAUDE.md の三分類に置く。
   - **質問**（使い方が分からない等）→ 答えを教材か画面の文言で解消できるか考える。本人への返信経路は無いので、画面側で分かるようにするのが答え
   - **バグ**（表示・データの誤り）→ `brain/INDEX.md` を症状で grep。データなら原本と照合してから直す
   - **仕様変更**（欲しい機能・意図の変更）→ 本人に提示して合意。台帳 `brain/approaches/学習アプリの充実の検討事項.md` に採否の行を足す
   分けた時点で `mark <id> --status triaged --note "<分類>: <一言>"`。
3. **直す**: 教材なら該当の `data/<key>/materials/bundle_*.json` → 門（`check_roadmap.py` か `check_materials.py`）→ `build_target_dataset.py`（ロードマップ型）→ `build_seed.py` → `check_seed.py`。
   画面なら実装 → `tsc` → `check_render.sh` → `check_api.sh` → **受入は `qa-acceptance`（別コンテキスト）**。
4. **出す**: `bash scripts/finish_remote.sh <key>`（seed とデプロイ。feedback 表と進捗は消えない）。
5. **閉じる**: `python3 scripts/feedback.py mark <key> <id> --status done --note "<何を直したか（コミット）>"`。
   同じ指摘が複数なら全部の id を渡す。
6. **還す**: 直した内容が「事前に聞けた質問」に当たるなら `brain/rework/<日付>_<key>.md` に 1 行（`〔q: id〕` を名指し）。
   他の対象でも起きる型なら中央のアプローチへ。作業ログを書いたら末尾に還元行。

## 守ること

- 送った本人の意図を推測で広げない。書いてあることだけに答え、広げるなら仕様変更として本人へ
- fetch した JSON は点の記録（追記のみ）。直した後に消さない
- `mark` は fetch の表示（先頭 8 文字）ではなく id 全体を渡す（JSON にある）
- 「分かりにくい」1 タップ（kind=unclear）を足したら、件数の多い論点から順に再執筆の担当バンドルへ渡す（§5.5-4 の元の意図）
