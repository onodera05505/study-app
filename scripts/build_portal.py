#!/usr/bin/env python3
"""入口「まなびば」の静的ページを作る（要件 §14-A。2026-09-16 本人「形式だけプラットフォーム形式に。名前はまなびば」）。

    python3 scripts/build_portal.py            # portal/dist/index.html を書く
    bash scripts/deploy_portal.sh              # 作って Pages（manabiba）へ出す

学びの一覧は登録簿（src/shared/targets.json）と scripts/pages_projects.json の url から作る。
入口は学びを並べてリンクするだけ。アカウントと合言葉は学びごとに別（合言葉はここに書かない。公開 URL だから）。
"""
from __future__ import annotations
import html, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from targets import targets, deploy  # noqa: E402

PORTAL = json.loads((ROOT / "scripts/pages_projects.json").read_text(encoding="utf-8")).get("_portal", {})
TITLE = PORTAL.get("title", "まなびば")
SUB = PORTAL.get("subtitle", "特化した学びのロードマップ")

ORDER = ["itc", "mkt", "ip", "ap"]  # ロードマップ型を先に、資格版を後に


def card(key: str, t: dict) -> str:
    url = deploy(key).get("url", "#")
    spec = t.get("roadmapSpec") or {}
    if t.get("roadmap"):
        kind = "ロードマップ"
        desc = spec.get("targetName", "")
        meta = f"{t.get('mockSize', '')} 単位・{spec.get('perDay', 3)} 単位／日"
    else:
        kind = "資格対策"
        desc = "過去問の出題頻度＝重要度の順に、最短で合格ラインへ"
        meta = f"模試 {t.get('mockSize', '')} 問 {t.get('mockMinutes', '')} 分"
    return f"""
      <a class="card" href="{html.escape(url)}">
        <span class="kind">{kind}</span>
        <span class="brand">{html.escape(t['brand'])}</span>
        <span class="desc">{html.escape(desc)}</span>
        <span class="meta">{html.escape(meta)}</span>
        <span class="go">開く →</span>
      </a>"""


def main() -> int:
    ts = targets()
    keys = [k for k in ORDER if k in ts] + [k for k in ts if k not in ORDER]
    cards = "".join(card(k, ts[k]) for k in keys)
    page = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(TITLE)}</title>
<meta name="description" content="{html.escape(SUB)}。学びを選んで開く。">
<meta name="robots" content="noindex">
<style>
  :root {{ --bg:#eef1f5; --panel:#fff; --text:#10151c; --muted:#5b6673; --border:#d9dfe7; --accent:#1e4c8a; --accent-soft:#e6edf7; --radius:12px; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg:#0d1117; --panel:#161b22; --text:#e8ecf2; --muted:#98a3b1; --border:#2b323c; --accent:#7fa9e8; --accent-soft:#16283f; }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--text); font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; line-height:1.6; }}
  main {{ max-width: 860px; margin: 0 auto; padding: 2.5rem 1rem 3rem; }}
  h1 {{ font-size: 2rem; margin: 0; letter-spacing: 0.04em; }}
  .sub {{ color: var(--muted); margin: 0.3rem 0 2rem; }}
  .grid {{ display:grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }}
  .card {{ display:flex; flex-direction:column; gap:0.35rem; background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:1.1rem 1.2rem; text-decoration:none; color:inherit; min-height: 170px; }}
  .card:hover, .card:focus-visible {{ border-color: var(--accent); background: var(--accent-soft); outline: none; }}
  .kind {{ font-size:0.72rem; font-weight:700; letter-spacing:0.08em; color:var(--accent); }}
  .brand {{ font-size:1.1rem; font-weight:700; }}
  .desc {{ font-size:0.9rem; color:var(--muted); flex:1; }}
  .meta {{ font-size:0.78rem; color:var(--muted); }}
  .go {{ font-size:0.85rem; font-weight:700; color:var(--accent); }}
  .note {{ font-size:0.82rem; color:var(--muted); margin-top:2rem; }}
</style>
</head>
<body>
<main>
  <h1>{html.escape(TITLE)}</h1>
  <p class="sub">{html.escape(SUB)}</p>
  <div class="grid">{cards}
  </div>
  <p class="note">アカウントは学びごとに別です。合言葉は管理者から受け取ってください。意見や不具合は各学びの「フィードバック」から。</p>
</main>
</body>
</html>
"""
    out = ROOT / "portal" / "dist"; out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(page, encoding="utf-8")
    print(f"→ {out / 'index.html'}（学び {len(keys)} 件: {', '.join(keys)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
