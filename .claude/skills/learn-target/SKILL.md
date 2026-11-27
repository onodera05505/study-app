---
name: learn-target
description: 「この学びをしたい」と対象（資格・分野・職種・入社先の業務）を 1 つ投げて、質疑応答→ロードマップ→教材・確認問題→学習者役の検証→本番、まで一発で作る入口。手戻りは台帳に書いて次回の質問にする。
---

# 学びの対象を 1 つ作る（この学びをしたい）

思想: **最初の質疑応答で仕様を完結させ、一発で出す。生成の後に決めたことは全部「手戻り」として台帳に書き、質問に変えて次回に効かせる。**

## 0. 対象の登録と質疑応答（生成に入る前に完結させる。空欄は手戻りの予約）
1. `python3 scripts/new_target.py <key> --name "<名前>" --target-name "<対象の一言>" --fields "分野,…"` で登録簿・env・wrangler・`data/<key>/kickoff.json`（既定の答え入り）を作る
2. 空の質問だけを本人と答え、`kickoff.json` に書く。仕様書に効く値は `src/shared/targets.json` の `<key>.roadmapSpec` に写す
3. 門: `python3 ~/.claude/brain/check_target_kickoff.py --file data/<key>/kickoff.json` と `python3 scripts/new_target.py --check` が 0 になるまで生成に入らない
4. `python3 scripts/render_prompts.py --data data/<key>` で仕様書を描出し、担当には `data/<key>/prompts/` を読ませる。選定の値は `roadmap_config.json`

## 1. 生成（手順の詳細は docs/ロードマップ対象を追加する.md）
一次資料の収集（担当 3）→ 名寄せ（1）→ `build_roadmap.py` → 教材（8 論点 / 担当）→ 確認問題（誤答解説つき）→ 独立解答 2 → 図（`figures` の答えが「付ける」なら）→ `check_roadmap.py`

## 2. 検証（学習者役）
`build_learner_pack.py` で開発情報を含まないパックを出し、初心者ロールの新しい担当に学ばせる。閉じた本の説明テストを別担当が採点。`grade_learner.py`。直して新しい担当でもう 1 周（2〜3 周）

## 3. 本番（個人アカウント）
`build_target_dataset.py` で投入経路の形に変換 → ローカルで `seed_remote.sh <対象> --local` と `check_api.sh` → `bootstrap_personal.sh <対象>`（人）→ `finish_remote.sh <対象>`

## 3.5 出した後（利用者の声で回す）
- フィードバックの受け口は全対象に共通で付いている（上部メニュー。要件 §5.5-4）。対象ごとに作らない
- 届いたら Skill `improve-from-feedback`: `scripts/feedback.py fetch --every` → **審議**（事実確認・意図との整合・一般性・費用・採否の案。採否は本人）→ 直す → 受入（別コンテキスト。**資格版も起こす**）→ `finish_remote.sh <key>` → `mark --status done`
- 学習者役 3 周で出ない層の欠陥（画面の不具合・解説の型の単調さ・並びの向き）は、本人以外の利用者 1 人の声で出る。投入直後の数件は必ず審議に掛ける

## 4. 手戻り台帳（締めに必ず）
生成の後に判明して直したこと・本人が後から決めたことを `brain/rework/<日付>_<対象>.md`（書式 `~/.claude/brain/TEMPLATE_REWORK.md`）に全部書く。各行に「事前に聞けた質問」と反映先の質問 ID。
ID が無ければ中央のアプローチに質問を足して ID を付ける。門: `python3 ~/.claude/brain/check_rework.py --root .`。作業ログの末尾に還元行。

## 使わないこと
- 質疑応答を飛ばして生成に入る（未回答は必ず手戻りになる）
- 学習者役に小さいモデルを使う（本人の決定 2026-09-15。Opus のまま）
