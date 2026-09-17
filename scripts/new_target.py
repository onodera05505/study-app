#!/usr/bin/env python3
"""新しい学びの対象を足す入口（`/learn-target` の 0 段目）。人が触る場所を 1 か所にする。

    python3 scripts/new_target.py <key> --name "<画面に出す名前>" --target-name "<対象の一言>" --fields "分野1,分野2,…" [--per-day 3] [--days 14]
    python3 scripts/new_target.py --check            # 登録簿の整合（各対象に .env・wrangler env・pages_projects・kickoff）

やること（冪等。既にあるものは触らない）:
  1. src/shared/targets.json に対象を登録（ロードマップ型の既定値と roadmapSpec の骨組み）
  2. scripts/pages_projects.json に Pages 名・DB 名・合言葉（読み違えにくい 10 文字）を登録
  3. .env.<key>、wrangler.jsonc の env.<key>（database_id は PLACEHOLDER。bootstrap_personal.sh が D1 を作って埋める）
  4. data/<key>/ に kickoff.json（既定の答えを写し、対象ごとに聞く質問は空）、roadmap_config.json、explain_terms.json、prompts/
  5. 未回答の質問を一覧で出す（本人と答えてから生成へ）
"""
from __future__ import annotations
import argparse, json, re, secrets, string, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
T = ROOT / "src/shared/targets.json"; P = ROOT / "scripts/pages_projects.json"; W = ROOT / "wrangler.jsonc"

def load(p): return json.loads(p.read_text(encoding="utf-8"))
def save(p, d): p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def check() -> int:
    t = {k: v for k, v in load(T).items() if not k.startswith("_")}; pj = load(P); w = W.read_text(encoding="utf-8"); probs = []
    for k in t:
        if k not in pj: probs.append(f"{k}: scripts/pages_projects.json に無い")
        if not (ROOT / f".env.{k}").exists() and not (k == "ip" and (ROOT / ".env").exists()): probs.append(f"{k}: .env.{k} が無い")  # ip は既定の .env
        if f'"{k}": {{' not in w: probs.append(f"{k}: wrangler.jsonc に env.{k} が無い")
        if t[k].get("roadmap") and not (ROOT / "data" / k / "kickoff.json").exists(): probs.append(f"{k}: data/{k}/kickoff.json が無い")
        if t[k].get("roadmap") and not (ROOT / "data" / k / "prompts").is_dir(): probs.append(f"{k}: data/{k}/prompts/ が無い（render_prompts.py）")
    for x in probs: print(f"✘ {x}")
    print(f"対象 {len(t)} 件 / 問題 {len(probs)} 件"); return 1 if probs else 0

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("key", nargs="?"); ap.add_argument("--name"); ap.add_argument("--target-name"); ap.add_argument("--fields")
    ap.add_argument("--per-day", type=int, default=3); ap.add_argument("--days", type=int, default=14); ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if a.check: return check()
    if not (a.key and a.name and a.target_name and a.fields): ap.error("key --name --target-name --fields が要る")
    key = a.key; assert re.fullmatch(r"[a-z][a-z0-9]{1,15}", key), "key は英小文字と数字（2〜16 文字）"
    fields = [f.strip() for f in a.fields.split(",") if f.strip()]; extra = "補足（ロードマップ外）"
    t = load(T)
    if key not in t:
        n = a.per_day * a.days; ratio = {f: n // len(fields) for f in fields}; ratio[fields[0]] += n - sum(ratio.values())
        t[key] = {"kind": "roadmap", "brand": a.name, "title": a.name, "examName": f"{a.name} 確認問題", "mockSize": n, "mockMinutes": max(10, round(n * 0.95)),
                  "fieldThreshold": False, "passRule": "確認テストです。合否はありません。到達基準ごとの正答率を見て、弱い分野の単位に戻ります。問題は教材から作った自作の確認問題です。",
                  "fieldRatio": ratio, "fields": fields + [extra], "questionsPerRound": a.per_day * 2, "exemptRounds": [f"{key}-ex"], "roadmap": True,
                  "words": {"question": "確認問題", "questions": "確認問題", "mock": "確認テスト", "nextUp": "ロードマップの順で、まだ理解できていない単位"},
                  "roadmapSpec": {"targetName": a.target_name, "extraField": extra, "extraMiddle": "ロードマップ外", "extraRoundId": f"{key}-ex", "extraRoundLabel": extra, "roundLabel": "{day} 日目",
                                  "loginLead": f"ロードマップの順に 1 日 {a.per_day} 単位を読み、確認問題で確かめる学習アプリです。",
                                  "reader": ["（質疑応答 reader の答えを箇条書きで）"], "usageLabel": "（利用場面でどう出るか。例: 就活でどう出るか）", "usageHint": "（例: 面接で聞かれる形）",
                                  "usageShort": "（例: 就活での出方）", "usageSection": "（detail の 2 段目の見出し。例: 面接で話すなら）", "usageSectionHint": "（その段に何を書くか）",
                                  "goalShort": "（例: 面接で示せること）", "goalVerb": "（例: 面接で示せる）", "q2Label": "（問 2 の趣旨。例: 就活での使い方）", "q2Hint": "（例: 面接の答え方）",
                                  "extraSourceRule": "", "taboo": ["陳腐化する断定（「最新」「近年」）を避ける"], "learnerRole": "（学習者役の 2 文。読者像を一人称で）"}}
        save(T, t); print(f"targets.json に {key} を登録（roadmapSpec の（…）を質疑応答の答えで埋める）")
    pj = load(P)
    if key not in pj:
        alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
        pj[key] = {"project": f"{key}-roadmap", "db": f"study-app-{key}-db", "signup_code": "".join(secrets.choice(alphabet) for _ in range(10))}
        save(P, pj); print(f"pages_projects.json に {key} を登録（Pages {key}-roadmap / DB study-app-{key}-db）")
    env = ROOT / f".env.{key}"
    if not env.exists(): env.write_text(f"# {a.name}。scripts/deploy-pages.sh {key} が --mode {key} で読ませる\nVITE_EXAM={key}\nVITE_TITLE={a.name}\n", encoding="utf-8"); print(f".env.{key}")
    w = W.read_text(encoding="utf-8")
    if f'"{key}": {{' not in w:
        block = f'''    "{key}": {{
      "d1_databases": [
        {{ "binding": "DB", "database_name": "study-app-{key}-db", "database_id": "PLACEHOLDER-run-scripts/bootstrap_personal.sh", "migrations_dir": "migrations" }}
      ],
      "vars": {{ "APP_NAME": "study-app-{key}", "EXAM": "{key}", "SSO_PORTAL_URL": "https://manabiba-5oz.pages.dev" }},
      "assets": {{ "directory": "./dist", "binding": "ASSETS", "not_found_handling": "single-page-application" }}
    }}
  }}
}}'''
        w = re.sub(r"\n    \}\n  \}\n\}\s*$", "\n    },\n" + block + "\n", w); W.write_text(w, encoding="utf-8"); print(f"wrangler.jsonc env.{key}（ID は bootstrap が埋める）")
    d = ROOT / "data" / key; d.mkdir(exist_ok=True)
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
    print("\n▶ 未回答の質問（本人と答える）:")
    subprocess.run([sys.executable, str(Path.home() / ".claude/brain/check_target_kickoff.py"), "--file", str(kf), "--warn"])
    print(f"\n次: 答えを kickoff.json と targets.json の roadmapSpec に写す → python3 scripts/render_prompts.py --data data/{key} → 手順書 docs/ロードマップ対象を追加する.md の 1 から")
    return 0

if __name__ == "__main__":
    sys.exit(main())
