#!/usr/bin/env python3
"""利用者のフィードバック（feedback 表）を本番 D1 から取り出し、処理済みの印を付ける（要件 §5.5-4）。

    python3 scripts/feedback.py fetch mkt              # 未処理（status=new）を取り出して表示し、data/mkt/feedback/inbox_<日付>.json に保存
    python3 scripts/feedback.py fetch mkt --all        # 状態を問わず全部
    python3 scripts/feedback.py mark mkt <id> [<id>…] --status done --note "単位 66 の説明を直した（コミット abc123）"
    python3 scripts/feedback.py fetch --every          # 4 対象ぶんまとめて
    python3 scripts/feedback.py fetch mkt --local      # ローカル D1（リハーサル）
    python3 scripts/feedback.py summary                # 未処理の件数だけ（定期確認。0 件なら黙る運用）

利用者側には一覧 API を作らない。ここが唯一の読み口。改善フェーズの手順は .claude/skills/improve-from-feedback/SKILL.md。
wrangler は登録簿の account_id のアカウントでログインしている必要がある（別アカウントなら止まる）。
"""
from __future__ import annotations
import argparse, datetime as dt, json, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from targets import deploy, keys  # noqa: E402

STATUSES = ("new", "triaged", "done")


LOCAL = False  # --local でローカル D1（リハーサル）


def d1(exam: str, command: str) -> list[dict]:
    db = deploy(exam)["db"]
    # 定期確認（1 時間おき）の最初の呼び出しだけが一時的に落ちることがある（2026-09-17 に 3 回。直後の再実行は通る）。
    # 2 回まで待って取り直す。--json のとき wrangler はエラーを stdout に出すので、落ちたときは両方を見せる
    for attempt in range(3):
        out = subprocess.run(
            ["npx", "wrangler", "d1", "execute", db, "--env", exam, "--local" if LOCAL else "--remote", "--json", "--command", command],
            capture_output=True, text=True, cwd=ROOT,
        )
        if out.returncode == 0:
            break
        if attempt < 2:
            time.sleep(5 * (attempt + 1))
    else:
        sys.exit(f"{exam}: wrangler が 3 回失敗\n[stdout] {out.stdout[-800:]}\n[stderr] {out.stderr[-800:]}")
    text = out.stdout[out.stdout.find("[") :]  # 起動メッセージが混ざることがあるので JSON 部分だけ
    data = json.loads(text)
    return data[0].get("results", []) if data else []


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def fetch(exam: str, everything: bool) -> list[dict]:
    where = "" if everything else " WHERE f.status = 'new'"
    rows = d1(exam, f"""
        SELECT f.id, f.kind, f.status, f.page, f.topic_id, t.term AS topic, f.question_id, f.body, f.note,
               u.name AS user_name, f.created_at, f.handled_at
          FROM feedback f JOIN users u ON u.id = f.user_id LEFT JOIN topics t ON t.id = f.topic_id{where}
         ORDER BY f.created_at ASC
    """)
    for r in rows:
        r["created"] = dt.datetime.fromtimestamp(r["created_at"], dt.timezone(dt.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")
    return rows


def show(exam: str, rows: list[dict]) -> None:
    print(f"▶ {exam}: {len(rows)} 件")
    for r in rows:
        where = " / ".join(x for x in (r.get("page") or "", r.get("topic") or "", r.get("question_id") or "") if x)
        print(f"  [{r['status']}] {r['id'][:8]}  {r['created']}  {r['user_name']}  {where}")
        for line in (r["body"] or "").splitlines():
            print(f"      {line}")
        if r.get("note"):
            print(f"      → メモ: {r['note']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch"); f.add_argument("exam", nargs="?"); f.add_argument("--all", action="store_true"); f.add_argument("--every", action="store_true", help="全対象")
    sub.add_parser("summary", help="未処理の件数だけを 1 行で（定期確認用）")
    m = sub.add_parser("mark"); m.add_argument("exam"); m.add_argument("ids", nargs="+"); m.add_argument("--status", choices=STATUSES, required=True); m.add_argument("--note", default="")
    for sp in (f, m): sp.add_argument("--local", action="store_true", help="ローカル D1 を読む（リハーサル）")
    a = ap.parse_args()
    global LOCAL; LOCAL = getattr(a, "local", False)
    if a.cmd == "summary":
        counts = {exam: len(d1(exam, "SELECT id FROM feedback WHERE status = 'new'")) for exam in keys()}
        total = sum(counts.values())
        print("未処理 " + str(total) + " 件" + ("（" + " / ".join(f"{k} {v}" for k, v in counts.items() if v) + "）" if total else ""))
        return 0
    if a.cmd == "fetch":
        exams = list(keys()) if a.every else [a.exam]
        if not a.every and not a.exam: ap.error("対象の ID か --every")
        total = 0
        for exam in exams:
            rows = fetch(exam, a.all)
            show(exam, rows); total += len(rows)
            if rows:
                out = ROOT / "data" / exam / "feedback"; out.mkdir(parents=True, exist_ok=True)
                p = out / f"inbox_{dt.date.today().isoformat()}.json"
                p.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
                print(f"  → {p.relative_to(ROOT)}")
        print(f"合計 {total} 件")
        return 0
    # mark
    ids = ",".join(q(i) for i in a.ids)
    handled = "unixepoch()" if a.status == "done" else "handled_at"
    note = f", note = {q(a.note)}" if a.note else ""
    d1(a.exam, f"UPDATE feedback SET status = {q(a.status)}, handled_at = {handled}{note} WHERE id IN ({ids})")
    rows = d1(a.exam, f"SELECT id, status, note FROM feedback WHERE id IN ({ids})")
    for r in rows: print(f"  {r['id'][:8]} → {r['status']}" + (f"（{r['note']}）" if r.get("note") else ""))
    missing = set(a.ids) - {r["id"] for r in rows}
    if missing: sys.exit(f"見つからない id: {', '.join(missing)}（fetch の表示は先頭 8 文字。mark には全体を渡す）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
