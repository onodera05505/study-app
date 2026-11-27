#!/usr/bin/env python3
"""学び側 4 つの users をまなびばの accounts に移す（要件 §15。名前・メール・パスワードのハッシュを引き継ぐ）。

    python3 scripts/portal_migrate_accounts.py --admin onodera.development@gmail.com --dry-run   # SQL を出すだけ
    python3 scripts/portal_migrate_accounts.py --admin onodera.development@gmail.com             # 本番の manabiba-db へ投入
    python3 scripts/portal_migrate_accounts.py --admin ... --local                                # ローカル D1 へ（リハーサル）

- 同じメールが複数の学びにあれば 1 アカウントに束ね、それぞれの学びの権限を付ける（ハッシュは最初に見つかった学びのもの）
- --skip のメール（既定 admin@example.com。既定パスワードの管理者。brain 2026-08-31）は移さない
- 既にあるメールは INSERT OR IGNORE で飛ばす（何度流しても壊れない）。権限も同様
"""
from __future__ import annotations
import argparse, json, subprocess, sys, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from targets import deploy, keys  # noqa: E402
sys.path.insert(0, str(ROOT / "scripts" / "lib"))  # 単独で回さない部品の置き場（ADR-0014）
from account_check import account_mismatch  # noqa: E402


def d1_json(args: list[str], cwd: Path, lenient: bool = False) -> list[dict]:
    out = subprocess.run(["npx", "wrangler", "d1", "execute", *args, "--json"], capture_output=True, text=True, cwd=cwd)
    if out.returncode != 0:
        # wrangler はエラーを stdout に JSON で出す（stderr は空のことがある）
        msg = (out.stdout + out.stderr).strip()[-600:]
        if lenient:
            print(f"注: 読めなかったので飛ばす: {' '.join(args[:3])} … {msg[:120]}")
            return []
        sys.exit(msg)
    data = json.loads(out.stdout[out.stdout.find("["):])
    return data[0].get("results", []) if data else []


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin", required=True, help="管理者にするメール（1 つ）")
    ap.add_argument("--skip", default="admin@example.com", help="移さないメール（カンマ区切り）")
    ap.add_argument("--local", action="store_true"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    where = "--local" if a.local else "--remote"
    skip = {s.strip().lower() for s in a.skip.split(",") if s.strip()}
    if a.admin.lower() in skip: sys.exit(f"--admin {a.admin} は移さないメール（--skip）に含まれている。既定パスワードの管理者は使わない（brain 04）")

    # 本番を指すときは、保存先を読む前にログイン中のアカウントを決めたアカウントと照らす（手元を指すときは照らさない）
    if not a.local:
        reason = account_mismatch(ROOT)
        if reason: sys.exit(reason)

    accounts: dict[str, dict] = {}  # email -> {id, name, hash, created, grants:set}
    for k in keys():
        rows = d1_json([deploy(k)["db"], "--env", k, where, "--command", "SELECT email, name, password_hash, role, created_at FROM users ORDER BY created_at"], ROOT, lenient=a.local)
        for r in rows:
            email = r["email"].strip().lower()
            if email in skip: continue
            acc = accounts.setdefault(email, {"id": str(uuid.uuid4()), "name": r["name"], "hash": r["password_hash"], "created": r["created_at"], "grants": set(), "from": []})
            acc["grants"].add(k); acc["from"].append(k)
    if a.admin.lower() not in accounts:
        accounts[a.admin.lower()] = {"id": str(uuid.uuid4()), "name": "管理者", "hash": None, "created": None, "grants": set(keys()), "from": []}
        print(f"注: 管理者 {a.admin} は学び側に無いので、パスワード無し（'sso'）で作る。まなびばの画面で再設定するか、下の SQL の前に --admin を学び側に登録して流し直す")

    stmts = []
    for email, acc in accounts.items():
        role = "ADMIN" if email == a.admin.lower() else "MEMBER"
        h = acc["hash"] or "sso"
        created = f", {acc['created']}" if acc["created"] else ""
        cols = "id, email, name, password_hash, role" + (", created_at" if acc["created"] else "")
        stmts.append(f"INSERT OR IGNORE INTO accounts ({cols}) VALUES ({q(acc['id'])}, {q(email)}, {q(acc['name'])}, {q(h)}, {q(role)}{created});")
        for g in sorted(acc["grants"] if role == "MEMBER" else set(keys())):
            stmts.append(f"INSERT OR IGNORE INTO grants (account_id, learning, granted_by) SELECT id, {q(g)}, 'migration' FROM accounts WHERE email = {q(email)};")
    sql = "\n".join(stmts) + "\n"
    print(f"アカウント {len(accounts)} 件（管理者 1）/ 文 {len(stmts)}")
    for email, acc in accounts.items(): print(f"  {email:40s} {acc['name']:10s} {'ADMIN' if email == a.admin.lower() else 'MEMBER':6s} {','.join(sorted(acc['grants'] if email != a.admin.lower() else set(keys())))}  ← {','.join(acc['from']) or '(新規)'}")
    if a.dry_run:
        print(sql); return 0
    f = ROOT / "portal" / ".migrate_accounts.sql"; f.write_text(sql, encoding="utf-8")
    out = subprocess.run(["npx", "wrangler", "d1", "execute", "manabiba-db", where, "--file", str(f)], capture_output=True, text=True, cwd=ROOT / "portal")
    f.unlink(missing_ok=True)
    if out.returncode != 0: sys.exit(out.stderr[-800:])
    rows = d1_json(["manabiba-db", where, "--command", "SELECT (SELECT COUNT(*) FROM accounts) a, (SELECT COUNT(*) FROM grants) g, (SELECT COUNT(*) FROM accounts WHERE role='ADMIN') adm"], ROOT / "portal")
    print(f"投入後: accounts {rows[0]['a']} / grants {rows[0]['g']} / 管理者 {rows[0]['adm']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
