#!/usr/bin/env python3
"""新しい学びの対象を足す入口（`/learn-target` の 0 段目）。人が触る場所を 1 か所にする。

    python3 scripts/new_target.py <key> --name "<画面に出す名前>" --target-name "<対象の一言>" --fields "分野1,分野2,…" [--per-day 3] [--days 14]
    python3 scripts/new_target.py <key> --kind exam --name "<画面に出す名前>" --exam-name "<試験の正式名>" \
        --mock-size 60 --mock-minutes 90 --field-ratio "テクノロジ系=38,マネジメント系=7,ストラテジ系=15" --pass-rule "<突破の条件の説明>"
    python3 scripts/new_target.py --check            # 登録簿の整合（各対象に .env・wrangler env・pages_projects・kickoff）

対象は 2 種類。`--kind roadmap`（既定）は教材から作るロードマップ型、`--kind exam` は過去問を取り込む資格型。

やること（冪等。既にあるものは触らない）:
  1. src/shared/targets.json に対象を登録（ロードマップ型は既定値と roadmapSpec の骨組み、資格型は模試の設定）
  2. scripts/pages_projects.json に Pages 名・DB 名を登録（学び側での登録の鍵は作らない）
  3. .env.<key>、wrangler.jsonc の env.<key>（database_id は対象ごとに違う PLACEHOLDER-<key>-…。bootstrap_personal.sh が D1 を作って埋める。
     同じ文字列にするとローカル D1 のファイルを共有し、前の対象の行が混ざる。中央 reports/06）
  4. ロードマップ型は data/<key>/ に kickoff.json（既定の答えを写し、対象ごとに聞く質問は空）、roadmap_config.json、explain_terms.json、prompts/。
     資格型は data/<key>/ だけ作る（過去問の取り込みは docs/基本情報を追加する.md・docs/応用情報を追加する.md の流れ）
  5. ロードマップ型は未回答の質問を一覧で出す（本人と答えてから生成へ）
"""
from __future__ import annotations
import argparse, json, re, string, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
T = ROOT / "src/shared/targets.json"; P = ROOT / "scripts/pages_projects.json"; W = ROOT / "wrangler.jsonc"

# 資格型で分野と語を既定にする値（ip・ap と同じ）
EXAM_FIELDS = ["ストラテジ系", "マネジメント系", "テクノロジ系"]
EXAM_WORDS = {"question": "過去問", "questions": "過去問", "mock": "過去問実践", "nextUp": "頻出なのにまだ理解できていない論点"}

def load(p): return json.loads(p.read_text(encoding="utf-8"))
def save(p, d): p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def parse_ratio(spec: str, fields: list[str], total: int) -> dict[str, int]:
    """「テクノロジ系=38,マネジメント系=7,…」を読む。並びは fields に揃え、合計は模試の問題数と一致させる。"""
    got: dict[str, int] = {}
    for part in spec.split(","):
        name, _, n = part.partition("=")
        name = name.strip()
        if name not in fields: raise SystemExit(f"--field-ratio の分野 '{name}' が分野の一覧に無い（{fields}）")
        got[name] = int(n)
    missing = [f for f in fields if f not in got]
    if missing: raise SystemExit(f"--field-ratio に {missing} が無い")
    if sum(got.values()) != total: raise SystemExit(f"--field-ratio の合計 {sum(got.values())} が模試の問題数 {total} と合わない")
    return {f: got[f] for f in fields}

def check() -> int:
    t = {k: v for k, v in load(T).items() if not k.startswith("_")}; pj = load(P); w = W.read_text(encoding="utf-8"); probs = []
    for k in t:
        if k not in pj: probs.append(f"{k}: scripts/pages_projects.json に無い")
        if not (ROOT / f".env.{k}").exists() and not (k == "ip" and (ROOT / ".env").exists()): probs.append(f"{k}: .env.{k} が無い")  # ip は既定の .env
        if f'"{k}": {{' not in w: probs.append(f"{k}: wrangler.jsonc に env.{k} が無い")
        if t[k].get("roadmap") and not (ROOT / "data" / k / "kickoff.json").exists(): probs.append(f"{k}: data/{k}/kickoff.json が無い")
        if t[k].get("roadmap") and not (ROOT / "data" / k / "prompts").is_dir(): probs.append(f"{k}: data/{k}/prompts/ が無い（render_prompts.py）")
    # 学び側での登録の鍵を持つ学びは整合の外（値は出さず、学びの名前だけを挙げる）
    for k, v in pj.items():
        if isinstance(v, dict) and "signup_code" in v:
            probs.append(f"{k}: scripts/pages_projects.json が学び側での登録の鍵（signup_code）を持つ。鍵ごと消す")
    for x in probs: print(f"✘ {x}")
    print(f"対象 {len(t)} 件 / 問題 {len(probs)} 件"); return 1 if probs else 0

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("key", nargs="?"); ap.add_argument("--name"); ap.add_argument("--target-name"); ap.add_argument("--fields")
    ap.add_argument("--kind", default="roadmap", choices=["roadmap", "exam"], help="roadmap=教材から作るロードマップ型 / exam=過去問を取り込む資格型")
    ap.add_argument("--per-day", type=int, default=3); ap.add_argument("--days", type=int, default=14); ap.add_argument("--check", action="store_true")
    ap.add_argument("--project", help="Pages プロジェクト名。既定は ロードマップ型 <key>-roadmap / 資格型 <key>-am-study")
    ap.add_argument("--exam-name", help="資格型: 出典に出す試験の正式名（例 基本情報技術者試験 科目A）")
    ap.add_argument("--mock-size", type=int, default=80, help="資格型: 模試の問題数")
    ap.add_argument("--mock-minutes", type=int, default=150, help="資格型: 模試の制限時間（分）")
    ap.add_argument("--practice-size", type=int, default=20, help="分野別演習・単元演習・弱点復習で問題数を省いたときの問題数")
    ap.add_argument("--field-ratio", help="資格型: 模試の分野の内訳（例 テクノロジ系=38,マネジメント系=7,ストラテジ系=15）。合計は --mock-size")
    ap.add_argument("--pass-rule", help="資格型: 突破の条件を画面で説明する文")
    ap.add_argument("--questions-per-round", type=int, default=80, help="資格型: 1 回あたりの問題数（通し受験）")
    ap.add_argument("--field-threshold", action="store_true", help="資格型: 本番の合否に分野ごとの足切りがある（IT パスポート）")
    a = ap.parse_args()
    if a.check: return check()
    exam = a.kind == "exam"
    if exam:
        if not (a.key and a.name and a.exam_name and a.field_ratio and a.pass_rule): ap.error("資格型は key --name --exam-name --field-ratio --pass-rule が要る")
    elif not (a.key and a.name and a.target_name and a.fields): ap.error("key --name --target-name --fields が要る")
    key = a.key; assert re.fullmatch(r"[a-z][a-z0-9]{1,15}", key), "key は英小文字と数字（2〜16 文字）"
    fields = [f.strip() for f in a.fields.split(",") if f.strip()] if a.fields else list(EXAM_FIELDS); extra = "補足（ロードマップ外）"
    t = load(T)
    # 資格型の分野の比率は、登録簿に既にある学びでも、何かを書く前に確かめる。既にある学びはその学びの登録簿の分野と模試の問題数と照らす
    ratio = parse_ratio(a.field_ratio, list(t[key]["fields"]) if key in t else fields, t[key]["mockSize"] if key in t else a.mock_size) if exam else None
    if key not in t and exam:
        t[key] = {"kind": "exam", "brand": a.name, "title": a.name, "examName": a.exam_name, "mockSize": a.mock_size, "mockMinutes": a.mock_minutes, "practiceSize": a.practice_size,
                  "fieldThreshold": a.field_threshold, "passRule": a.pass_rule, "fieldRatio": ratio,
                  "fields": fields, "questionsPerRound": a.questions_per_round, "exemptRounds": [], "roadmap": False, "words": dict(EXAM_WORDS)}
        save(T, t); print(f"targets.json に {key} を登録（資格型。模試 {a.mock_size} 問 / {a.mock_minutes} 分）")
    elif key not in t:
        n = a.per_day * a.days; ratio = {f: n // len(fields) for f in fields}; ratio[fields[0]] += n - sum(ratio.values())
        t[key] = {"kind": "roadmap", "brand": a.name, "title": a.name, "examName": f"{a.name} 確認問題", "mockSize": n, "mockMinutes": max(10, round(n * 0.95)), "practiceSize": a.practice_size,
                  "fieldThreshold": False, "passRule": "確認テストです。合否はありません。到達基準ごとの正答率を見て、弱い分野の単位に戻ります。問題は教材から作った自作の確認問題です。",
                  "fieldRatio": ratio, "fields": fields + [extra], "questionsPerRound": a.per_day * 2, "exemptRounds": [f"{key}-ex"], "roadmap": True,
                  "words": {"question": "確認問題", "questions": "確認問題", "mock": "確認テスト", "nextUp": "ロードマップの順で、まだ理解できていない単位"},
                  "roadmapSpec": {"targetName": a.target_name, "extraField": extra, "extraMiddle": "ロードマップ外", "extraRoundId": f"{key}-ex", "extraRoundLabel": extra, "roundLabel": "{day} 日目",
                                  "roundHeading": "{day} 日目", "roundCheck": "この日の確認", "roundCount": "全 {n} 日", "perRoundCount": "1 日 {perDay} 単位",
                                  "loginLead": f"ロードマップの順に 1 日 {a.per_day} 単位を読み、確認問題で確かめる学習アプリです。",
                                  "reader": ["（質疑応答 reader の答えを箇条書きで）"], "usageLabel": "（利用場面でどう出るか。例: 就活でどう出るか）", "usageHint": "（例: 面接で聞かれる形）",
                                  "usageShort": "（例: 就活での出方）", "usageSection": "（detail の 2 段目の見出し。例: 面接で話すなら）", "usageSectionHint": "（その段に何を書くか）",
                                  "goalShort": "（例: 面接で示せること）", "goalVerb": "（例: 面接で示せる）", "q2Label": "（問 2 の趣旨。例: 就活での使い方）", "q2Hint": "（例: 面接の答え方）",
                                  "extraSourceRule": "", "taboo": ["陳腐化する断定（「最新」「近年」）を避ける"], "learnerRole": "（学習者役の 2 文。読者像を一人称で）"}}
        save(T, t); print(f"targets.json に {key} を登録（roadmapSpec の（…）を質疑応答の答えで埋める）")
    pj = load(P)
    if key not in pj:
        project = a.project or (f"{key}-am-study" if exam else f"{key}-roadmap")
        # 学び側での登録の鍵は作らず、配備先の一覧にも書かない（登録はまなびばだけ）
        pj[key] = {"project": project, "db": f"study-app-{key}-db"}
        save(P, pj); print(f"pages_projects.json に {key} を登録（Pages {project} / DB study-app-{key}-db）")
    env = ROOT / f".env.{key}"
    if not env.exists(): env.write_text(f"# {a.name}。scripts/deploy-pages.sh {key} が --mode {key} で読ませる\nVITE_EXAM={key}\nVITE_TITLE={a.name}\n", encoding="utf-8"); print(f".env.{key}")
    w = W.read_text(encoding="utf-8")
    if f'"{key}": {{' not in w:
        block = f'''    "{key}": {{
      "d1_databases": [
        {{ "binding": "DB", "database_name": "study-app-{key}-db", "database_id": "PLACEHOLDER-{key}-run-scripts/bootstrap_personal.sh", "migrations_dir": "migrations" }}
      ],
      "vars": {{ "APP_NAME": "study-app-{key}", "EXAM": "{key}", "SSO_PORTAL_URL": "https://manabiba-5oz.pages.dev" }},
      "assets": {{ "directory": "./dist", "binding": "ASSETS", "not_found_handling": "single-page-application" }}
    }}
  }}
}}'''
        w = re.sub(r"\n    \}\n  \}\n\}\s*$", "\n    },\n" + block + "\n", w); W.write_text(w, encoding="utf-8"); print(f"wrangler.jsonc env.{key}（ID は bootstrap が埋める）")
    d = ROOT / "data" / key; d.mkdir(exist_ok=True)
    if exam:
        print(f"\n次: python3 scripts/fetch_pdfs_ap.py --exam {key} --exams <回> → extract_answer_keys_ap.py --data data/{key} → parse_syllabus_ap.py --data data/{key} → "
              f"render_pages.py --data data/{key} <回> → 読み取り以降は docs/基本情報を追加する.md の流れ")
        return 0
    kf = d / "kickoff.json"
    if not kf.exists():
        defaults = load(ROOT / "data/_defaults/kickoff_defaults.json")["answers"]
        save(kf, {"_note": "対象ごとの質疑応答の答え。空の項目を本人と答えてから生成に入る（門: check_target_kickoff.py）", "target": key, "answered_at": "",
                  "approaches": ["学習ロードマップの企画", "学習コンテンツの仕様を決める", "教材の説明文の設計と監査", "図をスクリプトで描く"], "answers": defaults}); print(f"data/{key}/kickoff.json（既定の答えを写した）")
    cfg = d / "roadmap_config.json"
    if not cfg.exists(): save(cfg, {"_note": "選定の値。質疑応答 priority の答えを写す", "max": a.per_day * a.days, "per_day": a.per_day, "min_per_goal": 6, "must_include": [], "exclude": [], "prereq_add": {}, "prereq_replace": {}, "cluster": [], "summary_override": {}})
    et = d / "explain_terms.json"
    if not et.exists(): save(et, {"_note": "閉じた本の説明テストの語（12 語）。到達基準を代表する語を選ぶ", "terms": []})
    (d / "prompts").mkdir(exist_ok=True)
    # 中央の質疑応答の検査の道具が手元にあるときだけ、未回答の質問を示す
    kickoff_check = Path.home() / ".claude/brain/check_target_kickoff.py"
    if kickoff_check.is_file():
        print("\n▶ 未回答の質問（本人と答える）:")
        subprocess.run([sys.executable, str(kickoff_check), "--file", str(kf), "--warn"])
    print(f"\n次: 答えを kickoff.json と targets.json の roadmapSpec に写す → python3 scripts/render_prompts.py --data data/{key} → 手順書 docs/ロードマップ対象を追加する.md の 1 から")
    return 0

if __name__ == "__main__":
    sys.exit(main())
