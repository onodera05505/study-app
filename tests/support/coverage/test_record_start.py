"""実行の記録の足場（ADR-0015）: Python の道具が起動のたびに記録を始める部品。run.mjs が仮想環境の site-packages に写し、
.pth の 1 行（import test_record_start）から読み込ませる。

- 記録の設定（COVERAGE_PROCESS_START）が無ければ何もしない
- 記録のデータの置き場に書けないとき（道具を囲いの中で回したときなど）は、記録を始めずに黙ってあきらめる
- 書き出しに失敗しても黙ってあきらめる。どの場合も、道具の標準出力・標準エラー・終了の状態は記録なしと変わらない
"""
import atexit
import configparser
import os
import tempfile


def _data_dir(rc: str):
    parser = configparser.ConfigParser()
    parser.read(rc, encoding="utf-8")
    data_file = parser.get("run", "data_file", fallback=None)
    return os.path.dirname(data_file) if data_file else None


def _writable(directory: str) -> bool:
    """実際に一時のファイルを作って消せるか（囲いは os.access では見分けられない）。"""
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix=".probe-"):
            pass
        return True
    except Exception:
        return False


def _start() -> None:
    rc = os.environ.get("COVERAGE_PROCESS_START")
    if not rc or not os.path.isfile(rc):
        return
    directory = _data_dir(rc)
    if not directory or not _writable(directory):
        return
    try:
        import coverage
        cov = coverage.Coverage(config_file=rc)
        cov._warn_no_data = False
        cov._warn_unimported_source = False
        cov._warn_preimported_source = False
        cov.start()
    except Exception:
        return

    def _save() -> None:
        try:
            cov.stop()
            cov.save()
        except BaseException:
            # 書けなかった記録は捨てる（後片付けでもう一度失敗しないよう、閉じる物も手放す）
            try:
                cov._data_to_close.clear()
            except Exception:
                pass

    # coverage 自身の後片付け（止めるだけ。保存はしない）より先に、ここで保存する
    atexit.register(_save)


_start()
