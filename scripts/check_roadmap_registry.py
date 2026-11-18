#!/usr/bin/env python3
"""ロードマップ型の学びの、回の語・回の数・印の門。登録簿 src/shared/targets.json と投入データ（seed.sql）を見る。

    python3 scripts/check_roadmap_registry.py <対象>      # 登録簿だけ（配備の前。deploy-pages.sh が呼ぶ）

投入データの側は check_seed.py が `seed_problems` を呼ぶ。資格型（roadmap が true でない対象）は何も見ない。

回の束ね方は data/<対象>/roadmap.json の `group_by`（無ければ日）で決まる:
- 日: 回の ID は <対象>-dNN で、NN は「学ぶ順 ÷ 1 日の論点数（登録簿 roadmapSpec.perDay）」の切り上げ。
  回ごとの問題数は登録簿 questionsPerRound
- 章: 回の ID は <対象>-cNN。各論点の round_label が章の名前。回ごとの問題数は「その回の単位数 × 2」
- どちらも: 学ぶ順は 1 から欠番なく続き、確認問題の回（past_questions.exam）は紐づく単位の回と一致する
- 章で束ねる学びの登録簿は、日の値（questionsPerRound・roadmapSpec.perDay・perRoundCount）を持たない
補足の回（登録簿 exemptRounds と roadmapSpec.extraRoundId）は回の決まり方・問題数・回の一致を見ない。
"""
from __future__ import annotations
import json, math, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from targets import ROOT, keys, target  # noqa: E402
from tool_refusal import CODE, tool_error_line  # noqa: E402

# 登録簿 roadmapSpec に要る語（キー → (何の語か, 入っていなければならない差し込み)）。
# roundHeading は画面の回の見出し、roundLabel は確認問題の回の見出し（exam_label）と日の回のラベルを作る型
ROUND_WORDS = {
    "roundLabel": ("確認問題の回の見出しの型", ["{day}"]),
    "roundHeading": ("回の見出しの語", ["{day}"]),
    "roundCount": ("回の数の語", ["{n}"]),
    "roundCheck": ("回ごとの確認の語", []),
    "extraField": ("補足の分野の名前", []),
    "extraRoundId": ("補足の回の ID", []),
    "extraRoundLabel": ("補足の回の見出し", []),
}
# 日で束ねる学びだけが持つ語（1 回の論点数）
DAY_WORDS = {"perRoundCount": ("1 回の論点数の語", ["{perDay}"])}
QUESTIONS_PER_UNIT = 2


def _is_roadmap(key: str) -> bool:
    return bool(target(key).get("roadmap"))


def _group_by(key: str, data: Path | None = None) -> str:
    rm = (data or ROOT / "data" / key) / "roadmap.json"
    return json.loads(rm.read_text(encoding="utf-8")).get("group_by", "day") if rm.exists() else "day"


def _extra_rounds(key: str) -> set[str]:
    t = target(key); spec = t.get("roadmapSpec") or {}
    return set(t.get("exemptRounds", [])) | ({spec["extraRoundId"]} if spec.get("extraRoundId") else set())


# @implements REQ-547, BR-037
def registry_problems(key: str, data: Path | None = None) -> list[str]:
    """登録簿に回の語・印の語・日の値が揃っているか。"""
    if not _is_roadmap(key): return []
    t = target(key); spec = t.get("roadmapSpec") or {}; gb = _group_by(key, data); out: list[str] = []
    words = {**ROUND_WORDS, **(DAY_WORDS if gb == "day" else {})}
    if gb == "chapter": words["roundHeading"] = ("回の見出しの語", ["{day}", "{label}"])  # 章の名前は {label}
    for k, (what, holes) in words.items():
        v = str(spec.get(k) or "")
        if not v.strip(): out.append(f"{key}: 登録簿 roadmapSpec.{k}（{what}）が無い"); continue
        for h in holes:
            if h not in v: out.append(f"{key}: 登録簿 roadmapSpec.{k}（{what}）に {h} が無い（{v}）")
    if spec.get("extraRoundId") and spec["extraRoundId"] not in t.get("exemptRounds", []):
        out.append(f"{key}: 補足の回 {spec['extraRoundId']} が登録簿 exemptRounds に無い（補足の回の問題数が回ごとの数で見られる）")
    if spec.get("extraField") and spec["extraField"] not in t.get("fields", []):
        out.append(f"{key}: 補足の分野 {spec['extraField']} が登録簿 fields に無い")
    if gb == "chapter":
        # 1 回の論点数と問題数は日で束ねる学びだけの値。章の学びが持つと画面が日の語（1 回の論点数）を出す
        for where, k in (("", "questionsPerRound"), ("roadmapSpec.", "perDay"), ("roadmapSpec.", "perRoundCount")):
            if (t if not where else spec).get(k) is not None:
                out.append(f"{key}: 章で束ねる学びなのに登録簿 {where}{k}（日で束ねる学びだけの値）がある")
    if gb == "day":
        per_day, qpr = spec.get("perDay"), t.get("questionsPerRound")
        if not isinstance(per_day, int) or per_day < 1: out.append(f"{key}: 日で束ねる学びに登録簿 roadmapSpec.perDay（1 日の論点数）が無い")
        if not isinstance(qpr, int) or qpr < 1: out.append(f"{key}: 日で束ねる学びに登録簿 questionsPerRound（1 回の問題数）が無い")
        elif isinstance(per_day, int) and qpr != per_day * QUESTIONS_PER_UNIT:
            out.append(f"{key}: questionsPerRound {qpr} が 1 日の論点数 {per_day} × {QUESTIONS_PER_UNIT} と合わない")
    tiers = spec.get("tiers")
    if tiers is not None:
        levels = [x.get("level") for x in tiers]
        if not tiers or any(not isinstance(lv, int) or lv < 1 for lv in levels) or len(set(levels)) != len(levels):
            out.append(f"{key}: 登録簿 roadmapSpec.tiers の段（level）が 1 以上の整数で重複なし、でない: {levels}")
        for x in tiers:
            if not str(x.get("label") or "").strip(): out.append(f"{key}: 登録簿 roadmapSpec.tiers の段 {x.get('level')} に語（label）が無い")
    return out


def _int(v) -> int | None:
    return int(v) if v is not None and str(v).lstrip("-").isdigit() else None


# @implements BR-037, BR-032
def seed_problems(key: str, topics: list[dict], per_exam: dict[str, int], labels: dict[str, set[str]], data: Path | None = None,
                  links: list[dict] | None = None, exam_of: dict[str, str] | None = None) -> list[str]:
    """投入データの論点の回・回のラベル・印と、回ごとの問題数。topics は seed.sql の topics の行（列名 → 値）、
    links は topic_questions の行、exam_of は確認問題の ID → その回（past_questions.exam）。"""
    if not _is_roadmap(key): return []
    t = target(key); spec = t.get("roadmapSpec") or {}; gb = _group_by(key, data); extra = _extra_rounds(key); out: list[str] = []
    if topics and not any("round" in r for r in topics):
        return [f"{key}: 論点に回（round・round_label・tier の列）が無い（build_target_dataset.py → build_seed.py を流し直す）"]
    per_day = spec.get("perDay"); qpr = t.get("questionsPerRound")
    levels = {x.get("level") for x in (spec.get("tiers") or [])}
    round_rx = re.compile(rf"^{re.escape(key)}-c\d{{2,}}$")
    no_round, no_label, bad_round, bad_tier = [], [], [], []
    round_labels: dict[str, set[str]] = {}; units_in: dict[str, int] = {}
    ordered = sorted((r for r in topics if _int(r.get("sort_order")) is not None), key=lambda r: _int(r["sort_order"]))
    for r in topics:
        tag = f"{r.get('id')} {r.get('term')}"
        rnd, lab, so = r.get("round"), r.get("round_label"), _int(r.get("sort_order"))
        tier = _int(r.get("tier"))
        if levels:
            if tier not in levels: bad_tier.append(f"{tag}（{r.get('tier')}）")
        elif r.get("tier") is not None: bad_tier.append(f"{tag}（印を持たない学びなのに {r.get('tier')}）")
        if so is None: continue
        if not rnd: no_round.append(tag); continue
        if not lab: no_label.append(tag)
        round_labels.setdefault(rnd, set()).add(lab or "")
        units_in[rnd] = units_in.get(rnd, 0) + 1
        if rnd in extra: continue
        if gb == "day":
            if isinstance(per_day, int) and per_day > 0:
                want = f"{key}-d{math.ceil(so / per_day):02d}"
                if rnd != want: bad_round.append(f"{tag}: 学ぶ順 {so} の回は {want} のはずが {rnd}")
        elif not round_rx.match(rnd): bad_round.append(f"{tag}: 章の回の ID が {key}-cNN の形でない（{rnd}）")
    for what, lst in (("学ぶ順を持つのに回（round）が無い論点", no_round), ("回のラベル（round_label）が無い論点" + ("（章の名前）" if gb == "chapter" else ""), no_label),
                      ("回が学ぶ順と合わない論点", bad_round), ("印が登録簿の段に無い論点" if levels else "印が付いている論点", bad_tier)):
        if lst: out.append(f"{key}: {what} {len(lst)} 件: {lst[:3]}")
    for rnd, ls in sorted(round_labels.items()):
        if len(ls) > 1: out.append(f"{key}: 回 {rnd} に回のラベルが複数ある {sorted(ls)}")
    # 回は学ぶ順のとおりに続く（同じ回が学ぶ順の中で途切れない）
    seq = [r["round"] for r in ordered if r.get("round") and r["round"] not in extra]
    broken = sorted({x for i, x in enumerate(seq) if x in seq[:i] and seq[i - 1] != x})
    if broken: out.append(f"{key}: 学ぶ順の中で途切れている回: {broken[:3]}")
    # 学ぶ順は 1 から欠番なく続く（画面の回の番号は学ぶ順から数え、確認問題の回の番号と合わなくなる）
    orders = [_int(r["sort_order"]) for r in ordered]
    if orders and orders != list(range(1, len(orders) + 1)):
        gaps = sorted(set(range(1, max(orders) + 1)) - set(orders))[:5]; dups = sorted({o for o in orders if orders.count(o) > 1})[:5]
        out.append(f"{key}: 学ぶ順が 1 から欠番なく続いていない（欠番 {gaps}・重複 {dups}・最小 {min(orders)}）")
    # 確認問題の回 ＝ 紐づく単位の回（食い違うと、回の問数と、その回で作られるテストの問題がずれる）
    if links is not None and exam_of is not None:
        round_of = {str(r.get("id")): r.get("round") for r in topics}
        off = []
        for ln in links:
            rnd, ex = round_of.get(str(ln.get("topic_id"))), exam_of.get(str(ln.get("question_id")))
            if ex is None or rnd in extra or ex in extra: continue
            if rnd != ex: off.append(f"{ln.get('question_id')}（回 {ex}）→ 論点 {ln.get('topic_id')}（回 {rnd}）")
        if off: out.append(f"{key}: 確認問題の回と紐づく単位の回が食い違う {len(off)} 件: {off[:3]}")
    # 回ごとの問題数
    for rnd, n_units in sorted(units_in.items()):
        if rnd in extra: continue
        want_n = qpr if gb == "day" else n_units * QUESTIONS_PER_UNIT
        if per_exam.get(rnd, 0) != want_n:
            out.append(f"{key}: 回 {rnd} の確認問題が {per_exam.get(rnd, 0)} 問（{'登録簿 questionsPerRound ' if gb == 'day' else f'単位 {n_units} × {QUESTIONS_PER_UNIT} = '}{want_n} 問のはず）")
        if gb == "chapter":
            name = next(iter(round_labels[rnd]))
            if name and labels.get(rnd) and not any(name in lb for lb in labels[rnd]):
                out.append(f"{key}: 回 {rnd} の見出し {sorted(labels[rnd])} に章の名前『{name}』が無い")
    stray = sorted(e for e in per_exam if e not in units_in and e not in extra)
    if stray: out.append(f"{key}: どの論点の回でもない確認問題の回: {stray[:3]}")
    return out


# @operation UC-032#checkRoadmapRegistry
# @implements REQ-546, REQ-548, REQ-571
def main() -> int:
    # 断るとき（学びが 1 つでない・登録簿に無い）は門の判定をせず、人が読む文のあとに断りの形を出して終了コード 2 で終える
    if len(sys.argv) != 2:
        print(__doc__)
        print(tool_error_line(CODE.INVALID_INPUT, f"学びを 1 つでなく {len(sys.argv) - 1} 個渡した"))
        return 2
    key = sys.argv[1]
    if key not in keys():
        print(f"{key}: 登録簿に無い学び（登録簿の学び: {' '.join(keys())}）")
        print(tool_error_line(CODE.INVALID_INPUT, f"登録簿に無い学び『{key}』"))
        return 2
    if not _is_roadmap(key): print(f"{key}: ロードマップ型ではないので見るものは無い"); return 0
    probs = registry_problems(key)
    for p in probs: print(f"✘ {p}")
    if probs: return 1
    print(f"✓ {key}: 回の語・印の語が登録簿に揃っている（{'章' if _group_by(key) == 'chapter' else '日'}で束ねる）"); return 0


if __name__ == "__main__":
    sys.exit(main())
