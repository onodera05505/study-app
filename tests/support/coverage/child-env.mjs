/**
 * 実行の記録の足場（ADR-0015）: vitest の setupFiles。テストを回すプロセス（worker）の中で、
 * テストが起こす子プロセスにだけ記録を始める環境を足す（vitest を起こす前の環境には置かない。置くと vitest 自身まで記録される）。
 * 値の出所は run.mjs が渡す TEST_RECORD_RAW（記録の生の置き場）と TEST_RECORD_VENV（Python の記録の道具を入れた仮想環境）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// URL を組み立てない（画面のテストでは大域の URL が jsdom の物に替わり、file: の URL を組めない）
const here = dirname(fileURLToPath(import.meta.url))
const raw = process.env.TEST_RECORD_RAW
const venv = process.env.TEST_RECORD_VENV

if (raw && venv) {
  const bin = join(venv, 'bin')
  // 仮想環境の python3 を先に見つかる位置に置く（子の Python の道具が起動のたびに記録を始める）
  if (!(process.env.PATH ?? '').startsWith(bin + ':')) process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  process.env.COVERAGE_PROCESS_START = join(raw, 'coveragerc')
  // シェルの道具: 起動のたびに読むファイルで、命令ごとの行を記録のファイルへ書き足す
  process.env.BASH_ENV = join(here, 'bash_env.sh')
  process.env.TEST_RECORD_SH = join(raw, 'sh', 'trace.log')
  // Node の道具: 組み込みの記録。このプロセスは起動の後に足すので記録されず、子だけが記録する
  process.env.NODE_V8_COVERAGE = join(raw, 'v8')
}
