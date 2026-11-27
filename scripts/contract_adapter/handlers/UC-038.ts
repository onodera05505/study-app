/**
 * UC-038 の受け持ち（取り込み・分類・書き直し・手順書の結果を照らす道具 5 つ。入口は CLAUDE.md の「道具を回す操作」の行:
 * 操作名を snake_case にした `scripts/<名前>.py`）。
 * 実例は ok だけで、前提はリポジトリのままの状態（道具は読むだけで書かない）。request の各欄は同じ名前の引数
 * （checkAnswerability の exam と specInventory の path は第 1 引数。answersDir は --answers-dir のように大文字の前に - を入れた小文字）。
 * 応答は終了の状態（契約の exitCode）。道具は断りの種類の名前を出さない（errors: []）。
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { argsOf } from '../kit/td'
import { REPO_ROOT, runTool, toolAnswer } from '../kit/tool'

const tool = (script: string, positional: string[] = []): Operation => async (line: ExampleLine) => {
  if (line.case !== 'ok') throw new Unanswerable(`UC-038 ${line.operation} の例 ${line.case} の前提を知らない`)
  const run = await runTool(['python3', `scripts/${script}`, ...argsOf(line.request, { positional })], { cwd: REPO_ROOT, timeoutMs: 300_000 })
  return toolAnswer(run, (r) => ({ exitCode: r.code }))
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-038',
  parallel: true,
  operations: {
    checkAnswerability: tool('check_answerability.py', ['exam']),
    checkAnswerabilityMaterials: tool('check_answerability_materials.py'),
    checkClassified: tool('check_classified.py'),
    checkMaterialCoverage: tool('check_material_coverage.py'),
    specInventory: tool('spec_inventory.py', ['path']),
  },
})
