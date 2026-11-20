/**
 * UC-037 の受け持ち（文書の検査の道具 2 つ。入口は CLAUDE.md の「道具を回す操作」の行: checkDocs ＝ `python3 scripts/check_docs.py`、
 * checkFeedbackLedger ＝ `python3 scripts/check_feedback_ledger.py`）。
 * 実例は ok だけで、前提はリポジトリのままの状態（道具は読むだけで書かない）。request の各欄は同じ名前の引数（root は --root）。
 * 応答は終了の状態（契約の exitCode）。道具は断りの種類の名前を出さない（errors: []）。
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { argsOf } from '../kit/td'
import { REPO_ROOT, runTool, toolAnswer } from '../kit/tool'

const tool = (script: string): Operation => async (line: ExampleLine) => {
  if (line.case !== 'ok') throw new Unanswerable(`UC-037 ${line.operation} の例 ${line.case} の前提を知らない`)
  const run = await runTool(['python3', `scripts/${script}`, ...argsOf(line.request)], { cwd: REPO_ROOT, timeoutMs: 300_000 })
  return toolAnswer(run, (r) => ({ exitCode: r.code }))
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-037',
  parallel: true,
  operations: { checkDocs: tool('check_docs.py'), checkFeedbackLedger: tool('check_feedback_ledger.py') },
})
