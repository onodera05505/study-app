#!/usr/bin/env python3
"""学習者ロールの別エージェントに渡す学習パックを作る（開発側の情報を含めない）。

    python3 scripts/build_learner_pack.py --data data/itc --out <パックの出力先ディレクトリ>

出すもの: roadmap.md（日ごとの単位）、units/NN_<論点>.md（教材。出典も見せる）、quiz.md（確認問題。正解と根拠は入れない）。
正解は data 側の questions/ にしかない（学習者には渡さない）。
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args(); d = Path(a.data); out = Path(a.out); (out / "units").mkdir(parents=True, exist_ok=True)
    rm = json.loads((d / "roadmap.json").read_text(encoding="utf-8"))
    mats = {}
    for mp in sorted((d / "materials").glob("bundle_*.json")):
        for x in json.loads(mp.read_text(encoding="utf-8"))["materials"]: mats[x["topic_id"]] = x
    qs = []
    unit_ids = {u["topic_id"] for u in rm["units"]}
    for qp in sorted((d / "questions").glob("bundle_*.json")):
        qs += [q for q in json.loads(qp.read_text(encoding="utf-8"))["questions"] if q["topic_id"] in unit_ids]  # ロードマップ外（除外済み）の問題は渡さない
    lines = [f"# 学習ロードマップ: {rm['target']}", "", f"1 日 {rm['per_day']} 単位、全 {rm['days']} 日、{rm['unit_count']} 単位。1 単位は 5 分が目安。順番どおりに読む。", ""]
    day = 0
    for u in rm["units"]:
        if u["day"] != day: day = u["day"]; lines += ["", f"## {day} 日目"]
        safe = re.sub(r"[/\\ ]", "_", u["term"])
        fn = f"{u['order']:02d}_{safe}.md"
        lines.append(f"- {u['order']}. [{u['term']}](units/{fn}) — {u['summary']}")
        m = mats.get(u["topic_id"])
        body = [f"# {u['term']}", "", f"（{u['field']} / {u['middle']}）", "", m["explanation"] if m else "（教材なし）", "", m["detail"] if m else "", ""]
        if m and m.get("sources"):
            body += ["---", "出典: " + "、".join(f"{s['name']}（{s.get('where','')}）" for s in m["sources"])]
        (out / "units" / fn).write_text("\n".join(body) + "\n", encoding="utf-8")
    (out / "roadmap.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    q_lines = ["# 確認問題（各単位を読んだ直後に答える。答えは learner_answers.json の answers に qid → ア/イ/ウ/エ で）", ""]
    order = {u["topic_id"]: u["order"] for u in rm["units"]}
    for q in sorted(qs, key=lambda q: (order.get(q["topic_id"], 999), q["qid"])):
        q_lines += [f"## {q['qid']}（単位 {order.get(q['topic_id'])}: {q['term']}）", q["stem"], ""] + [f"- {k}. {v}" for k, v in q["choices"].items()] + [""]
    (out / "quiz.md").write_text("\n".join(q_lines) + "\n", encoding="utf-8")
    et = d / "explain_terms.json"
    if et.exists():
        terms = json.loads(et.read_text(encoding="utf-8"))["terms"]
        e_lines = ["# 説明テスト（全部読み終えた後、教材を読み返さずに書く）", "",
                   "次の語を、IT に詳しくない友人に向けて 1〜2 文で説明してください。分からなければ「分からない」と正直に書きます。",
                   "答えは `explain_answers.json` に `{\"answers\": {\"語\": \"説明\", ...}}` の形で。", ""] + [f"- {t['term']}" for t in terms]
        (out / "explain.md").write_text("\n".join(e_lines) + "\n", encoding="utf-8")
    print(f"パック: {out} / 単位 {len(rm['units'])} / 教材あり {sum(1 for u in rm['units'] if u['topic_id'] in mats)} / 問題 {len(qs)}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
