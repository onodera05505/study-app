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


def sql_values(vals: str) -> list[str | None]:
    """VALUES(...) の中身を値の並びに分ける。文字列は '' を ' に戻した中身、NULL は None、ほかは書かれたままの字。"""
    out: list[str | None] = []
    i, n = 0, len(vals)
    while i < n:
        while i < n and vals[i] in " \t":
            i += 1
        if i < n and vals[i] == "'":
            i += 1
            buf = []
            while i < n:
                if vals[i] == "'" and i + 1 < n and vals[i + 1] == "'":
                    buf.append("'"); i += 2
                elif vals[i] == "'":
                    i += 1; break
                else:
                    buf.append(vals[i]); i += 1
            out.append("".join(buf))
        else:
            j = i
            while j < n and vals[j] != ",":
                j += 1
            tok = vals[i:j].strip()
            out.append(None if tok.upper() == "NULL" else tok)
            i = j
        while i < n and vals[i] in " \t":
            i += 1
        if i < n and vals[i] == ",":
            i += 1
    return out


def column(cols: str, vals: str, name: str) -> str | None:
    """INSERT の列の並びと値の並びから、名前の列の値。列が無いか数が合わなければ None。"""
    names = [c.strip().strip('"') for c in cols.split(",")]
    values = sql_values(vals)
    if name not in names or len(values) != len(names):
        return None
    return values[names.index(name)]

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
            tid = column(cols, vals, "topic_id")
            if tid is not None and tid.isdigit() and int(tid) not in topic_ids: dropped["progress"] += 1; continue
        if t == "session_questions":
            # 問題の ID の形によらず、渡した投入に無い問題を指す行を落とす
            qid = column(cols, vals, "question_id")
            if qid is not None and qid not in qids: dropped["session_questions"] += 1; continue
        lines.append(f"INSERT OR IGNORE INTO {t} ({cols}) VALUES({vals});"); counts[t] += 1
    order = {t: i for i, t in enumerate(TABLES)}
    body = sorted(lines[1:], key=lambda l: order[re.match(r"INSERT OR IGNORE INTO ([a-z_]+)", l).group(1)])
    a.out.write_text("\n".join([lines[0]] + body) + "\n", encoding="utf-8")
    print(f"→ {a.out}: " + " / ".join(f"{t} {n}" for t, n in counts.items()) + f"（落とした progress {dropped['progress']}・session_questions {dropped['session_questions']}）")
    return 0

if __name__ == "__main__":
    sys.exit(main())
