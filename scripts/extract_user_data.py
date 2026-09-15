#!/usr/bin/env python3
"""本番 D1 のバックアップ（wrangler d1 export の SQL）から、seed では作れない利用者データだけを抜き出す。

    python3 scripts/extract_user_data.py backups/study-app-db_2026-09-01_1032.sql --seed data/ip/seed.sql --out backups/restore_ip.sql

対象: users, sessions, session_questions, progress, daily_visits, login_attempts（FK の順）。app_settings は seed の値を使うので抜かない。
progress の topic_id が seed に無い論点（統合で消えた）は落として件数を出す。session_questions の question_id が seed に無いものも落とす。
用途: 2026-09-15 に社用アカウントから個人アカウントへ移したとき、新しい D1 に seed を流した後でこれを流す。
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

TABLES = ["users", "sessions", "session_questions", "progress", "daily_visits", "login_attempts"]

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("backup", type=Path); ap.add_argument("--seed", type=Path, required=True); ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    seed = a.seed.read_text(encoding="utf-8")
    topic_ids = set(int(m) for m in re.findall(r"INSERT INTO topics \([^)]*\) VALUES \((\d+),", seed))
    qids = set(re.findall(r"INSERT INTO past_questions \([^)]*\) VALUES \('([^']+)'", seed))
    lines = ["PRAGMA defer_foreign_keys=TRUE;"]; counts = {t: 0 for t in TABLES}; dropped = {"progress": 0, "session_questions": 0}
    for raw in a.backup.read_text(encoding="utf-8").splitlines():
        m = re.match(r'INSERT INTO "([a-z_]+)" \(([^)]*)\) VALUES\((.*)\);$', raw)
        if not m or m.group(1) not in TABLES: continue
        t, cols, vals = m.groups()
        if t == "progress":
            tm = re.match(r"'[^']*',(\d+),", vals)
            if tm and int(tm.group(1)) not in topic_ids: dropped["progress"] += 1; continue
        if t == "session_questions":
            qm = re.search(r"'((?:\d{4}[hr]\d{2}[hao]?|itc-d\d{2}|itc-ex)-q\d+)'", vals)
            if qm and qm.group(1) not in qids: dropped["session_questions"] += 1; continue
        lines.append(f"INSERT OR IGNORE INTO {t} ({cols}) VALUES({vals});"); counts[t] += 1
    order = {t: i for i, t in enumerate(TABLES)}
    body = sorted(lines[1:], key=lambda l: order[re.match(r"INSERT OR IGNORE INTO ([a-z_]+)", l).group(1)])
    a.out.write_text("\n".join([lines[0]] + body) + "\n", encoding="utf-8")
    print(f"→ {a.out}: " + " / ".join(f"{t} {n}" for t, n in counts.items()) + f"（落とした progress {dropped['progress']}・session_questions {dropped['session_questions']}）")
    return 0

if __name__ == "__main__":
    sys.exit(main())
