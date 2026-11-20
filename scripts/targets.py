"""対象（試験・題材）の登録簿を読む 1 か所。UI 設定は src/shared/targets.json、デプロイ先と合言葉は scripts/pages_projects.json。
スクリプトは対象名を列挙せず、ここから引く（対象を足すときに触る場所を 1 つにするため）。"""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_T = ROOT / "src" / "shared" / "targets.json"
_P = ROOT / "scripts" / "pages_projects.json"

# @implements BR-005
def targets() -> dict:
    return {k: v for k, v in json.loads(_T.read_text(encoding="utf-8")).items() if not k.startswith("_")}

# @implements BR-005
def target(key: str) -> dict:
    t = targets()
    if key not in t: raise SystemExit(f"対象 '{key}' が src/shared/targets.json に無い（scripts/new_target.py で登録する）")
    return t[key]

# @implements BR-005
def keys() -> list[str]:
    return sorted(targets())

# @implements BR-005
def deploy(key: str) -> dict:
    p = {k: v for k, v in json.loads(_P.read_text(encoding="utf-8")).items() if not k.startswith("_")}
    if key not in p: raise SystemExit(f"対象 '{key}' が scripts/pages_projects.json に無い")
    return p[key]

# 資格版の互換: 出典の試験名と模試設定
# @implements BR-005
def exam_names() -> dict[str, str]:
    return {k: v["examName"] for k, v in targets().items()}

# @implements BR-005
def exam_settings() -> dict[str, tuple[int, int]]:
    return {k: (v["mockSize"], v["mockMinutes"] * 60) for k, v in targets().items()}

if __name__ == "__main__":
    import sys
    # シェルから: python3 scripts/targets.py db ip → study-app-db / keys → ap fe ip … / project ip → itpass-study
    what, key = (sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    if what == "keys": print(" ".join(keys()))
    elif what == "title": print(target(key)["title"])
    elif what == "kind": print(target(key).get("kind", "roadmap"))
    elif what == "db": print(deploy(key)["db"])
    elif what == "project": print(deploy(key)["project"])
    elif what == "url": print(deploy(key).get("url", f"https://{deploy(key)['project']}.pages.dev"))
    elif what == "account": print(json.loads(_P.read_text(encoding="utf-8"))["account_id"])
    elif what == "has": print("yes" if key in targets() else "no")
