"""本番に触る Python の道具が、ログイン中の配備先のアカウントを決めたアカウントと照らす部品。

照らし方の正本はシェルの部品 check_account.sh（シェルの道具と同じ照らし方にするため、ここではそれを子プロセスで回す）。

    from account_check import account_mismatch
    reason = account_mismatch(ROOT)   # 合えば None、違えば理由の 1 行
"""
from __future__ import annotations

import subprocess
from pathlib import Path

PART = Path(__file__).resolve().parent / "check_account.sh"


def account_mismatch(root: Path) -> str | None:
    """root（リポジトリの根）を作業の場所にして照らす。違うか分からなければ理由の 1 行を返す。"""
    out = subprocess.run(["bash", str(PART)], capture_output=True, text=True, cwd=root)
    if out.returncode == 0:
        return None
    lines = [line for line in (out.stdout + out.stderr).splitlines() if line.strip()]
    return lines[-1] if lines else "ログイン中のアカウントを照らせない"
