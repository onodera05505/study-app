---
name: learn-target
description: 「この学びをしたい」と対象（資格・分野・職種・入社先の業務）を 1 つ投げて、質疑応答→ロードマップ→教材・確認問題→学習者役の検証→本番、まで一発で作る入口。手戻りは台帳に書いて次回の質問にする。
---

# 学びの対象を 1 つ作る（この学びをしたい）

思想: **最初の質疑応答で仕様を完結させ、一発で出す。生成の後に決めたことは全部「手戻り」として台帳に書き、質問に変えて次回に効かせる。**

## 0. 質疑応答（生成に入る前に完結させる。空欄は手戻りの予約）
1. 対象の短い ID（例: `itc`）と一言の名前を決める
2. 中央の質問を対象名つきで出す: `python3 ~/.claude/brain/kickoff_questions.py` の段階 7（企画と教材の設計）と段階 3 の「図をスクリプトで描く」。
   質問 ID（`〔q: …〕`）付きの質問に本人と答え、`data/<対象>/kickoff.json` に書く（形は `data/itc/kickoff.json`）
3. 門: `python3 ~/.claude/brain/check_target_kickoff.py --file data/<対象>/kickoff.json` が未回答 0 になるまで生成に入らない
4. 答えを値のファイルと仕様書に写す: `data/<対象>/roadmap_config.json`（max / min_per_goal / must_include / exclude / prereq / cluster）、
   `scripts/prompts/roadmap_materials.md` と `roadmap_questions.md`（読者像・書式・禁止語は対象ごとに差し替える）、`src/shared/exam.ts` の EXAMS

## 1. 生成（手順の詳細は docs/ロードマップ対象を追加する.md）
一次資料の収集（担当 3）→ 名寄せ（1）→ `build_roadmap.py` → 教材（8 論点 / 担当）→ 確認問題（誤答解説つき）→ 独立解答 2 → 図（`figures` の答えが「付ける」なら）→ `check_roadmap.py`

## 2. 検証（学習者役）
`build_learner_pack.py` で開発情報を含まないパックを出し、初心者ロールの新しい担当に学ばせる。閉じた本の説明テストを別担当が採点。`grade_learner.py`。直して新しい担当でもう 1 周（2〜3 周）

## 3. 本番（個人アカウント）
`build_itc_dataset.py` 相当で投入経路の形に変換 → ローカルで `seed_remote.sh <対象> --local` と `check_api.sh` → `bootstrap_personal.sh <対象>`（人）→ `finish_remote.sh <対象>`

## 4. 手戻り台帳（締めに必ず）
生成の後に判明して直したこと・本人が後から決めたことを `brain/rework/<日付>_<対象>.md`（書式 `~/.claude/brain/TEMPLATE_REWORK.md`）に全部書く。各行に「事前に聞けた質問」と反映先の質問 ID。
ID が無ければ中央のアプローチに質問を足して ID を付ける。門: `python3 ~/.claude/brain/check_rework.py --root .`。作業ログの末尾に還元行。

## 使わないこと
- 質疑応答を飛ばして生成に入る（未回答は必ず手戻りになる）
- 学習者役に小さいモデルを使う（本人の決定 2026-09-15。Opus のまま）
