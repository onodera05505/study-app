"""実行の記録の足場（ADR-0015）: 子プロセスの Python の道具が残した記録（coverage.py の parallel のデータ）を、
写し元のファイルの記録に直して 1 つの lcov に書き出す。仮想環境の python で run.mjs が回す。

    python py_record.py <置き場の根> <生のデータの置き場> <出力の lcov>

- 写しの置き場（影の根）で回した道具は、パスの先頭を 1 段ずつ落として、範囲（scripts/）の中で置き場の根に同じ相対パスの
  ファイルがある物に戻す。戻せない物（テストが置いた偽物・別の名前の写し）は捨てる。
- 読めないデータのファイル（打ち切られた・書けなかった子プロセスが残した物）は飛ばし、飛ばした数を標準出力に数だけ出す。
"""
import glob
import os
import sys
import tempfile

from coverage import Coverage, CoverageData

SCOPE = ("scripts/",)


def to_source(root_variants, path):
    """記録のパス → 置き場の根からの相対パス（範囲の中で、同じファイルがある物だけ）。無ければ None。"""
    for r in root_variants:
        if path.startswith(r + os.sep):
            rel = path[len(r) + 1:]
            return rel if rel.startswith(SCOPE) and os.path.isfile(os.path.join(root_variants[0], rel)) else None
    parts = path.split(os.sep)
    for i in range(1, len(parts)):
        rel = "/".join(parts[i:])
        if rel.startswith(SCOPE) and os.path.isfile(os.path.join(root_variants[0], rel)):
            return rel
    return None


def main():
    root, raw, out = sys.argv[1], sys.argv[2], sys.argv[3]
    # 根はリンクを解いた本当のパスを先にする（記録の道具は、動いたファイルの名前をリンクを解いたパスで照らす）
    roots = [os.path.realpath(root), os.path.abspath(root)]
    lines = {}
    skipped = 0
    for f in sorted(glob.glob(os.path.join(raw, ".coverage*"))):
        try:
            data = CoverageData(basename=f)
            data.read()
            measured = {name: data.lines(name) or [] for name in data.measured_files()}
        except Exception:
            skipped += 1
            continue
        for name, ls in measured.items():
            rel = to_source(roots, name)
            if rel is None:
                continue
            lines.setdefault(os.path.join(roots[0], rel), set()).update(ls)
    if lines:
        with tempfile.TemporaryDirectory() as tmp:
            merged = CoverageData(basename=os.path.join(tmp, "merged"))
            merged.add_lines({k: sorted(v) for k, v in lines.items()})
            merged.write()
            cov = Coverage(data_file=os.path.join(tmp, "merged"), config_file=False)
            cov.load()
            os.chdir(roots[0])
            cov.lcov_report(outfile=out, ignore_errors=True)
    else:
        open(out, "w").close()
    print(skipped)


if __name__ == "__main__":
    main()
