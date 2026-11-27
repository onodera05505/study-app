#!/usr/bin/env python3
"""入口「まなびば」を組み立てる（要件 §14-A・§15）。

    python3 scripts/build_portal.py       # portal/src/learnings.json（登録簿から）と portal/dist/（静的ファイル）を書く
    bash scripts/deploy_portal.sh         # 上を呼んでから Worker を束ね、Pages（manabiba）へ出す

学びの一覧は登録簿（src/shared/targets.json）と scripts/pages_projects.json の url から作る。
合言葉や秘密は載せない（公開 URL）。アカウントと権限はまなびばの D1（portal/migrations）。
"""
from __future__ import annotations
import json, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from targets import targets, deploy  # noqa: E402

ORDER = ["itc", "mkt", "ip", "ap"]  # 先頭の並びは固定。載っていない対象は ロードマップ型 → 資格版 の順で続ける


def learning(key: str, t: dict) -> dict:
    spec = t.get("roadmapSpec") or {}
    if t.get("roadmap"):
        kind, desc = "ロードマップ", spec.get("targetName", "")
    else:
        kind, desc = "資格対策", "過去問の出題頻度＝重要度の順に、最短で合格ラインへ"
    return {"key": key, "brand": t["brand"], "url": deploy(key)["url"].rstrip("/"), "kind": kind, "desc": desc}


def main() -> int:
    ts = targets()
    rest = [k for k in ts if k not in ORDER]
    keys = [k for k in ORDER if k in ts] + [k for k in rest if ts[k].get("roadmap")] + [k for k in rest if not ts[k].get("roadmap")]
    # まだ本番に出していない対象（登録簿に url が無い）は一覧に出さない。出すと「開く」が壊れたリンクになる
    # （url が無い対象を載せると、入口の生成が KeyError で落ちる）
    pending = [k for k in keys if "url" not in deploy(k)]
    keys = [k for k in keys if k not in pending]
    ls = [learning(k, ts[k]) for k in keys]
    if pending: print(f"注: まだ本番に出していないので一覧に出さない: {', '.join(pending)}（finish_remote.sh の後にもう一度 deploy_portal.sh）")
    (ROOT / "portal/src/learnings.json").write_text(json.dumps(ls, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out = ROOT / "portal/dist"
    if out.exists(): shutil.rmtree(out)
    shutil.copytree(ROOT / "portal/static", out)
    print(f"→ portal/src/learnings.json（{len(ls)} 件: {', '.join(keys)}）/ portal/dist/（{len(list(out.iterdir()))} ファイル）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
