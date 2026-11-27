/**
 * UC-044 の受け持ち（手元に依らない検査と検査の振り分けの道具 2 つ。入口は CLAUDE.md の「道具を回す操作」の行:
 * runPortableChecks ＝ `scripts/run_portable_checks.*`、classifyChecks ＝ `scripts/classify_checks.*`。`.sh` は bash、`.ts` は npx tsx、`.py` は python3）。
 * 実例は ok だけで、前提は UC-044 のテストと同じ影の根の小さな作業ツリー（tests/server/UC-044_fixture.local.ts の makeShadow。
 * 手元に依らないテスト 1 つ・手元だけのテスト 1 つ・手元に依らない UC と手元だけの UC の受け持ち 1 つずつを持ち、手元の物を持たない）。
 * 道具は影の根の写しを、影の根を作業の場所にして回す。request は空。応答は終了の状態（契約の exitCode）。道具は断りの種類の名前を出さない（errors: []）。
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { runTool, toolAnswer } from '../kit/tool'
import { childEnv, entryOf, makeShadow, removeTemps } from '../../../tests/server/UC-044_fixture.local'

const tool = (name: string): Operation => async (line: ExampleLine) => {
  if (line.case !== 'ok') throw new Unanswerable(`UC-044 ${line.operation} の例 ${line.case} の前提を知らない`)
  const s = makeShadow()
  try {
    let command: string[]
    try {
      command = entryOf(s.root, name)
    } catch (error) {
      throw new Unanswerable(`UC-044 ${line.operation}: ${(error as Error).message}`)
    }
    const run = await runTool(command, { cwd: s.root, env: childEnv(), timeoutMs: 600_000 })
    return toolAnswer(run, (r) => ({ exitCode: r.code }))
  } finally {
    await removeTemps()
  }
}

export default defineHandler({
  uc: 'UC-044',
  operations: { runPortableChecks: tool('run_portable_checks'), classifyChecks: tool('classify_checks') },
})
