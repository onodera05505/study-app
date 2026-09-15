#!/usr/bin/env python3
"""ロードマップ試作の門（正解表が無い対象の代わり）。要件定義書 §13「検証の門」。

    python3 scripts/check_roadmap.py --data data/itc [--solutions data/itc/eval/solve_*.json]

見るもの:
- 教材: 全単位に教材があり、担当バンドルと topic_id/term が一致する（自己申告を信じない）。sources が 1 件以上。
  explanation / detail の長さが仕様の範囲（下限は落とす、上限は警告）。見分けワードの行がある。記法が 5 つ以外でない（`**`/`###`/`- `/`1. `/表）。
  `[[用語]]` はロードマップ内の論点名だけ。会社の評価・年収・「最新」「近年」を含まない
- 問題: 1 論点 2 問、四択、answer が選択肢にある、qid 一意、正解位置が 1 つに偏りすぎない（1 位置が 45% 超で警告）、tests_goal が 1〜6。\n  正解の選択肢が教材と 14 字以上連続一致するものを数えて警告（サイクル 1 で独立解答 2 体が「再認で当たる」と指摘）
- 独立解答（--solutions）: 教材だけで解いた担当の答えと answer を比べ、不一致を列挙する。不一致率 20% 超でエラー
"""
from __future__ import annotations
import argparse, glob, json, re, sys
from pathlib import Path

NG_DEFAULT = ["激務", "ブラック(?!ボックス)", "年収", "万円", "最新", "近年"]  # 対象の登録簿 roadmapSpec.ngWords で上書き（2026-09-15: マーケの金額例に「万円」が要る）
VERBATIM = 14

def verbatim(choice: str, text: str) -> bool:
    """正解の選択肢が教材本文と VERBATIM 字以上連続で一致するか（記号・空白は除いて比べる）。"""
    norm = lambda t: re.sub(r"[\s、。・「」『』（）()\[\]*#\-|]", "", t)
    c, t = norm(choice), norm(text)
    if len(c) < VERBATIM: return False  # 用語そのものを選ばせる短い選択肢は対象外（語が教材に出るのは当然）
    return any(c[i:i + VERBATIM] in t for i in range(0, max(1, len(c) - VERBATIM + 1)))
ALLOWED_INLINE = re.compile(r"^(#{3} |- |\d+\. |\||!\[)")

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--solutions", nargs="*", default=[])
    a = ap.parse_args(); d = Path(a.data)
    errors: list[str] = []; warns: list[str] = []
    sys.path.insert(0, str(Path(__file__).parent)); from targets import target
    USAGE = (target(d.name).get("roadmapSpec") or {}).get("usageSection", "面接で話すなら")
    NG = re.compile("|".join((target(d.name).get("roadmapSpec") or {}).get("ngWords", NG_DEFAULT)))
    rm = json.loads((d / "roadmap.json").read_text(encoding="utf-8"))
    units = {u["topic_id"]: u for u in rm["units"]}; terms = {u["term"] for u in rm["units"]}
    # 前提はロードマップ上で前に置かれているか（クラスタ寄せで前提を飛び越えた mkt 1 周目の再発防止 2026-09-15）
    order_of = {u["term"]: u["order"] for u in rm["units"]}
    for u in rm["units"]:
        for pt in u.get("prereq", []):
            if pt in order_of and order_of[pt] > u["order"]:
                errors.append(f"順序 {u['order']} {u['term']}: 前提『{pt}』が後ろ（{order_of[pt]}）にある")
    # 教材
    mats: dict[int, dict] = {}
    for mp in sorted((d / "materials").glob("*.json")):
        m = json.loads(mp.read_text(encoding="utf-8"))
        for x in m.get("materials", []):
            tid = x["topic_id"]; tag = f"教材 {tid} {x['term']}"
            if tid in mats: errors.append(f"{tag}: 教材が重複（{mp.name}）"); continue
            mats[tid] = x
            if tid not in units: warns.append(f"{tag}: ロードマップ外の教材（{mp.name}。害は無いが除外済みの単位）"); continue
            if units[tid]["term"] != x["term"]: errors.append(f"{tag}: 論点名がロードマップと不一致（{units[tid]['term']}）")
            if not x.get("sources"): errors.append(f"{tag}: 出典が無い")
            ex, de = x.get("explanation", ""), x.get("detail", "")
            if len(ex) < 120: errors.append(f"{tag}: explanation が短すぎる {len(ex)} 字")
            if len(ex) > 420: warns.append(f"{tag}: explanation が長い {len(ex)} 字（目安 200〜300）")
            if len(de) < 150: errors.append(f"{tag}: detail が短すぎる {len(de)} 字")
            if len(de) > 800: warns.append(f"{tag}: detail が長い {len(de)} 字（目安 300〜500）")
            if "見分けワード" not in ex: errors.append(f"{tag}: 見分けワードの行が無い")
            if "### しくみ" not in de: errors.append(f"{tag}: detail に「### しくみ」が無い")
            if f"### {USAGE}" not in de: warns.append(f"{tag}: detail に「### {USAGE}」が無い")
            for term in re.findall(r"\[\[([^\]]+)\]\]", ex + de):
                if term not in terms: errors.append(f"{tag}: [[{term}]] はロードマップに無い論点")
            for hit in NG.findall(ex + de): warns.append(f"{tag}: 避ける語「{hit}」")
            for line in (ex + "\n" + de).splitlines():
                if line.startswith("#") and not line.startswith("### "): errors.append(f"{tag}: 見出しは ### だけ: {line[:30]}")
    for tid in units:
        if tid not in mats: errors.append(f"教材が無い論点: {tid} {units[tid]['term']}")
    # 問題
    qs: dict[str, dict] = {}; per_topic: dict[int, int] = {}; pos: dict[str, int] = {}; verb: list[str] = []
    for qp in sorted((d / "roadmap_questions").glob("bundle_*.json")):
        for q in json.loads(qp.read_text(encoding="utf-8")).get("questions", []):
            if q["qid"] in qs: errors.append(f"qid 重複: {q['qid']}")
            qs[q["qid"]] = q; per_topic[q["topic_id"]] = per_topic.get(q["topic_id"], 0) + 1
            if set(q["choices"].keys()) != {"ア", "イ", "ウ", "エ"}: errors.append(f"{q['qid']}: 選択肢がア〜エでない")
            if q["answer"] not in q["choices"]: errors.append(f"{q['qid']}: 正解が選択肢に無い")
            if q.get("tests_goal") not in range(1, 7): errors.append(f"{q['qid']}: tests_goal が 1〜6 でない")
            if q["topic_id"] not in units: warns.append(f"{q['qid']}: ロードマップ外の問題（除外済みの単位）"); continue
            pos[q["answer"]] = pos.get(q["answer"], 0) + 1
            cn = q.get("choice_notes") or {}
            if set(cn) != {"ア", "イ", "ウ", "エ"} or any(not (v or "").strip() for v in cn.values()): errors.append(f"{q['qid']}: choice_notes が 4 つ揃っていない")
            elif not cn[q["answer"]].startswith("正解"): errors.append(f"{q['qid']}: 正解の note が「正解。」で始まっていない")
            m = mats.get(q["topic_id"])
            if m and verbatim(q["choices"][q["answer"]], m.get("explanation", "") + "\n" + m.get("detail", "")):
                verb.append(q["qid"])
    if qs:
        for tid in units:
            if per_topic.get(tid, 0) != 2: errors.append(f"論点 {tid} {units[tid]['term']} の問題が {per_topic.get(tid,0)} 問（2 問）")
        if verb: warns.append(f"正解の選択肢が教材と {VERBATIM} 字以上連続一致（読んだ文の再認で当たる）: {len(verb)} 問 {verb[:12]}{'…' if len(verb) > 12 else ''}")
        top = max(pos.values()) / len(qs)
        if top > 0.45: warns.append(f"正解位置が偏っている: {pos}")
    # 独立解答
    mism = []
    for sp in a.solutions:
        for f in glob.glob(sp):
            s = json.loads(Path(f).read_text(encoding="utf-8"))
            ans = s.get("answers", {}); n = 0; bad = []
            for qid, q in qs.items():
                if q["topic_id"] not in units: continue  # ロードマップ外（除外済み）の問題は学習者パックに無い
                if qid not in ans: bad.append((qid, "未回答")); continue
                n += 1
                if ans[qid] != q["answer"]: bad.append((qid, f"{ans[qid]}≠{q['answer']}"))
            n_in = sum(1 for q in qs.values() if q["topic_id"] in units)
            rate = len(bad) / max(1, n_in)
            print(f"独立解答 {Path(f).name}: {n_in - len(bad)}/{n_in} 一致（不一致 {rate:.0%}）")
            for qid, why in bad: print(f"   不一致 {qid} {qs[qid]['term']}: {why}")
            if rate > 0.20: errors.append(f"{Path(f).name}: 不一致率 {rate:.0%} が 20% を超えている（教材で解けない問題か、教材の穴）")
            mism += bad
    for w in warns: print(f"警告: {w}")
    for e in errors: print(f"✘ {e}")
    print(f"単位 {len(units)} / 教材 {len(mats)} / 問題 {len(qs)} / 警告 {len(warns)} / 問題点 {len(errors)}")
    if errors: return 1
    print("✓ ロードマップ試作の門を通過"); return 0

if __name__ == "__main__":
    sys.exit(main())
