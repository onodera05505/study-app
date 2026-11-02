#!/usr/bin/env python3
"""seed を流したあとの D1 の中身が、流した seed.sql と一致しているかを見る。投入の門の最後。

    python3 scripts/verify_seed_remote.py --data data/ip --exam ip            # 本番（--remote）
    python3 scripts/verify_seed_remote.py --data data/ip --exam ip --local    # ローカル D1

## なぜ要るか

**投入が成功したことと、入った中身が正しいことは別。** `Executed N queries` は SQL が
通ったとしか言っていない。出典が全880問おかしいまま数か月気づかなかった事故のあと、
「投入後は件数と代表値を SELECT して確かめる」が手順書の文言になったが、人の手順は飛ばされる。
ここで機械にする（`docs/不変条件と門.md` O1・O2・O10）。

## 見るもの

- **件数** — seed.sql の `INSERT INTO <表>` の行数と、DB の `COUNT(*)` を突き合わせる。
  投入のたびに作り直す表（topics / topic_questions / glossary）は一致、
  UPSERT だけの表（syllabus_items / past_questions / question_explanations）は DB ≧ seed
- **代表値** — seed の先頭の論点（id と term）と先頭の過去問（id と年度ラベル）が
  DB でも同じ値か。表の取り違え（ip の DB に ap の seed）はこれで止まる
- **年度ラベルの素通し** — `exam_label` が `2022r04h` のような内部コードのまま残っている行が 0 か
- **出典の形** — `citation` が「出典：<年度ラベル> <試験名> 問N」の形をしている行が全件か
  （空・年度ラベルが違う・問番号が無いものを数える）
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from targets import deploy as _deploy, keys as _keys  # 対象と DB の対応は登録簿から
DB_OF = {k: _deploy(k)["db"] for k in _keys()}

# 表ごとの比較のしかた。"eq" は seed が作り直す表、"ge" は UPSERT だけの表（古い行が残ってよい）
TABLES = {
    "syllabus_items": "ge",
    "topics": "eq",
    "topic_questions": "eq",
    "past_questions": "ge",
    "question_explanations": "ge",
    "glossary": "eq",
}

INSERT_LINE = re.compile(r"^INSERT INTO (\w+) ")
FIRST_TOPIC = re.compile(r"^INSERT INTO topics \(.*?\) VALUES \((\d+), '((?:[^']|'')*)'")
FIRST_QUESTION = re.compile(r"^INSERT INTO past_questions \(.*?\) VALUES \('([^']+)', '([^']+)', '((?:[^']|'')*)'")
EXAM_CODE = re.compile(r"^\d{4}[hr]\d{2}[hao]?$")


def parse_seed(sql: Path) -> tuple[dict[str, int], tuple[int, str] | None, tuple[str, str, str] | None]:
    counts: dict[str, int] = {t: 0 for t in TABLES}
    topic = question = None
    with sql.open(encoding="utf-8") as f:
        for line in f:
            m = INSERT_LINE.match(line)
            if not m:
                continue
            t = m.group(1)
            if t in counts:
                counts[t] += 1
            if topic is None and t == "topics":
                mt = FIRST_TOPIC.match(line)
                if mt:
                    topic = (int(mt.group(1)), mt.group(2).replace("''", "'"))
            if question is None and t == "past_questions":
                mq = FIRST_QUESTION.match(line)
                if mq:
                    question = (mq.group(1), mq.group(2), mq.group(3).replace("''", "'"))
    return counts, topic, question


def d1_query(db: str, exam: str, where: str, sql: str) -> list[dict]:
    cmd = ["npx", "wrangler", "d1", "execute", db, "--env", exam, where, "--json", "--command", sql]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stderr.strip() or proc.stdout.strip(), file=sys.stderr)
        raise SystemExit(f"wrangler d1 execute が失敗（exit {proc.returncode}）")
    # wrangler は JSON の前後にバナーを出すことがあるので、最初の '[' から読む
    out = proc.stdout
    data = json.loads(out[out.index("["):])
    results = []
    for stmt in data:
        if not stmt.get("success"):
            raise SystemExit(f"SQL が失敗: {stmt}")
        results.append(stmt["results"])
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--exam", required=True, choices=sorted(DB_OF))
    ap.add_argument("--sql", type=Path, help="既定は <data>/seed.sql")
    ap.add_argument("--local", action="store_true", help="本番でなくローカル D1 を見る")
    args = ap.parse_args()

    sql = args.sql or args.data / "seed.sql"
    if not sql.exists():
        raise SystemExit(f"seed が無い: {sql}")
    db, where = DB_OF[args.exam], ("--local" if args.local else "--remote")
    counts, topic, question = parse_seed(sql)
    if topic is None or question is None:
        raise SystemExit("seed から代表値（先頭の論点・過去問）を読めなかった。build_seed.py の出力形が変わった?")

    stmts = [f"SELECT COUNT(*) AS n FROM {t}" for t in TABLES]
    stmts.append(f"SELECT id, term FROM topics WHERE id = {topic[0]}")
    stmts.append(f"SELECT id, exam, exam_label FROM past_questions WHERE id = '{question[0]}'")
    stmts.append("SELECT COUNT(*) AS n FROM past_questions WHERE exam_label = exam")
    # 出典が「出典：<年度ラベル> <試験名> 問N」の形になっていない行
    stmts.append(
        "SELECT COUNT(*) AS n FROM past_questions"
        " WHERE citation IS NULL OR citation = ''"
        "    OR citation NOT GLOB '出典：* 問[0-9]*'"
        # 「出典：<回のラベル> 」で始まるかは前方の切り出しで比べる。LIKE の型にすると、長い回のラベル
        # （章の見出しなど）で D1 の型の長さの上限（50 バイト）を超えて SQLITE_ERROR になる
        "    OR substr(citation, 1, length('出典：' || exam_label || ' ')) <> '出典：' || exam_label || ' '"
    )
    print(f"▶ {db}（{where}）を seed {sql} と突き合わせる")
    results = d1_query(db, args.exam, where, "; ".join(stmts))

    problems: list[str] = []
    for i, (t, mode) in enumerate(TABLES.items()):
        n_db, n_seed = results[i][0]["n"], counts[t]
        ok = (n_db == n_seed) if mode == "eq" else (n_db >= n_seed)
        mark = "=" if mode == "eq" else "≧"
        print(f"  {'✓' if ok else '✘'} {t:22s} DB {n_db:6d} {mark} seed {n_seed:6d}")
        if not ok:
            problems.append(f"{t} の件数: DB {n_db} / seed {n_seed}（期待 DB {mark} seed）")

    row = results[len(TABLES)]
    got = (row[0]["id"], row[0]["term"]) if row else None
    if got != topic:
        problems.append(f"先頭の論点が違う: seed {topic} / DB {got}")
    else:
        print(f"  ✓ 論点 {topic[0]} = {topic[1]!r}")

    # 先頭の過去問の出典（回・年度ラベル）が DB でも同じ値か（表の取り違えはここで止まる）
    row = results[len(TABLES) + 1]
    got_q = (row[0]["id"], row[0]["exam"], row[0]["exam_label"]) if row else None
    if got_q != question:
        problems.append(f"先頭の過去問が違う: seed {question} / DB {got_q}")
    else:
        print(f"  ✓ 過去問 {question[0]} の年度ラベル = {question[2]!r}")

    # 年度ラベルが内部コード（exam と同じ値）のまま残っている行は 0
    n_raw = results[len(TABLES) + 2][0]["n"]
    if n_raw:
        problems.append(f"年度ラベルが内部コードのままの過去問が {n_raw} 件（exam_labels.json の足し忘れ）")
    else:
        print("  ✓ 年度ラベルが内部コードのままの行: 0")

    # 出典が「出典：<年度ラベル> <試験名> 問N」の形をしていない行は 0
    n_bad = results[len(TABLES) + 3][0]["n"]
    if n_bad:
        problems.append(
            f"出典が「出典：<年度ラベル> <試験名> 問N」の形でない過去問が {n_bad} 件"
            "（空・年度ラベルが合わない・問番号が無い）"
        )
    else:
        print("  ✓ 出典が「出典：<年度ラベル> <試験名> 問N」の形: 全件")

    if problems:
        print()
        for p in problems:
            print(f"✘ {p}")
        print(f"問題 {len(problems)} 件。DB の中身が seed と合っていない。")
        return 1
    print("✓ DB の中身は seed と一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
