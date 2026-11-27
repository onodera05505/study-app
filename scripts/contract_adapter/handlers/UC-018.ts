/**
 * UC-018 の受け持ち（資格対策の教材の門。入口は CLAUDE.md の「道具を回す操作」の行: checkMaterials ＝ `python3 scripts/check_materials.py`）。
 * request の各欄は同じ名前の引数（dir は値を並べる。all は名前だけ）。実例ごとの影の根（kit/td.ts の projectShadow）で回し、
 * 応答は終了の状態と標準出力の最後の行の JSON（契約の response）、断りは ToolError の名前。
 *
 * 前提:
 * - pass: 「止める理由も警告も無い資格対策の学び fe」。影の根に写した fe の教材のうち、計算に触れる説明に式が無い警告
 *   （REQ-324 の calcWithoutFormula。要件どおりの警告）に当たる説明だけ、「計算」の語を「処理」に替えて警告の無い状態にする。
 *   それ以外の種類の警告が当たるときは前提を作れない（Unanswerable）
 * - ほかの実例: リポジトリの学びの置き場をリンクのまま読ませる（門は読むだけ）
 */

import { readFile, writeFile } from 'node:fs/promises'
import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { answerOf, argsOf, inShadow, unknownCase, type ProjectShadow } from '../kit/td'

const CASES = ['badArguments', 'pass', 'unknownLearning', 'notQualification', 'dirOutsideLearning', 'outsideBeforeMissing', 'dirMissing', 'notQualificationBeforeDirMissing']

type Finding = { kind: string; where: string }

/** 門を回して、最後の行の警告を読む。 */
async function warningsOf(s: ProjectShadow, args: string[]): Promise<Finding[]> {
  const run = await s.run(['python3', 'scripts/check_materials.py', ...args], 300_000)
  const last = run.stdout.split('\n').filter((l) => l.trim() !== '').pop() ?? ''
  try {
    return ((JSON.parse(last) as { warnings?: Finding[] }).warnings ?? []) as Finding[]
  } catch {
    throw new Unanswerable(`前提を作れない: 門の最後の行が読めない: ${last.slice(0, 200)}`)
  }
}

/** 警告の where（「<世代>/<ファイル> id=<論点>…」）の教材の説明の「計算」を「処理」に替える。 */
async function clearCalcMention(s: ProjectShadow, data: string, where: string): Promise<void> {
  const m = /^(materials(?:_v\d+)?\/[^\s]+\.json)\s+id=(\d+)/.exec(where)
  if (!m) throw new Unanswerable(`前提を作れない: 警告の箇所を読めない: ${where}`)
  const rel = `${data}/${m[1]}`
  const body = JSON.parse(await readFile(s.path(rel), 'utf8')) as { materials: Array<{ topic_id: number; explanation?: string }> }
  for (const mat of body.materials) if (mat.topic_id === Number(m[2]) && mat.explanation) mat.explanation = mat.explanation.replaceAll('計算', '処理')
  await writeFile(s.path(rel), JSON.stringify(body, null, 2))
}

/**
 * @implements REQ-567, REQ-570
 */
const checkMaterials: Operation = (line: ExampleLine) => {
  if (!CASES.includes(line.case)) unknownCase(line)
  const args = argsOf(line.request)
  if (line.case !== 'pass') return inShadow({}, async (s) => answerOf(await s.run(['python3', 'scripts/check_materials.py', ...args], 300_000), [0, 1]))
  const data = String(line.request?.data)
  const key = data.split('/').pop()!
  return inShadow({ learnings: [key] }, async (s) => {
    const warnings = await warningsOf(s, args)
    const other = warnings.filter((w) => w.kind !== 'calcWithoutFormula')
    if (other.length) throw new Unanswerable(`前提を作れない: 警告の無い ${key} にできない種類の警告がある: ${[...new Set(other.map((w) => w.kind))].join(',')}`)
    for (const w of warnings) await clearCalcMention(s, data, w.where)
    return answerOf(await s.run(['python3', 'scripts/check_materials.py', ...args], 300_000), [0, 1])
  })
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-018',
  parallel: true,
  operations: { checkMaterials },
})
