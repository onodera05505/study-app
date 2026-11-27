/**
 * UC-020 の読み書きの受け持ち（道具の中の読み書き。入口は kit/py.ts の橋で呼ぶ Python の関数。ADR-0013）。
 * 前提のファイルは実例ごとの影の根（登録簿を写す）に置き、関数は影の根を作業ディレクトリにして呼ぶ。
 * - ok: 実例が読むファイルに、契約の例の応答の中身を、書き手と道具が書くファイルの形（束の名前を添えた物）で置く
 * - missing: 読むファイルを置かない（readRoadmap は data/ip に置かない）
 * - unreadable: 読むファイルに途中で途切れた JSON を置く
 * - readMaterialRequirements は登録簿を読むので、ok（itc）・unknown（zzz）とも写した登録簿のまま
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { callOperation, pyAnswer } from '../kit/py'
import { field, inShadow, writeJson } from '../kit/tb'
import type { Shadow } from '../kit/tool'

const TERM = 'ITコンサルタントの仕事'
const QUESTION = {
  qid: 't1-1',
  topic_id: 1,
  term: TERM,
  stem: '…',
  choices: { ア: '…', イ: '…', ウ: '…', エ: '…' },
  answer: 'イ',
  reason: '…',
  choice_notes: { ア: '…', イ: '正解。…', ウ: '…', エ: '…' },
  tests_goal: 1,
}

/** 例の名前ごとに、request の path に置く物（undefined は置かない）。 */
function readOperation(okContent: unknown): Operation {
  return async (line: ExampleLine) => {
    const path = field(line.request, 'path')
    if (path === undefined) throw new Unanswerable(`${line.uc} ${line.operation}.${line.case} の request に path が無い`)
    const put: Record<string, ((shadow: Shadow) => Promise<void>) | undefined> = {
      ok: (shadow) => writeJson(shadow, path, okContent),
      missing: undefined,
      unreadable: (shadow) => shadow.write(path, '{"bundle": "bundle_c2_new_a", "items": ['),
    }
    if (!(line.case in put)) throw new Unanswerable(`${line.uc} ${line.operation} の例 ${line.case} の前提を知らない`)
    return inShadow(async (shadow) => {
      await put[line.case]?.(shadow)
      return pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root }))
    })
  }
}

/** 登録簿だけを読む操作（前提は写した登録簿）。 */
const registryOperation: Operation = async (line) => {
  if (!['ok', 'unknown'].includes(line.case)) throw new Unanswerable(`${line.uc} ${line.operation} の例 ${line.case} の前提を知らない`)
  return inShadow(async (shadow) => pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root })))
}

/**
 * @implements REQ-567, REQ-570, REQ-579
 */
export default defineHandler({
  uc: 'UC-020',
  parallel: true,
  operations: {
    readBundleAssignment: readOperation({ bundle: 'bundle_01', topics: [{ topic_id: 1, term: TERM, field: '業界と仕事', middle: '案件の流れ', summary: '…', goals: [1], prereq: [], sources: [] }] }),
    readBundleMaterials: readOperation({
      bundle: 'bundle_01',
      materials: [{ topic_id: 1, term: TERM, explanation: `**${TERM}**は…`, detail: '### しくみ\n…', sources: [] }],
    }),
    readBundleQuestions: readOperation({ bundle: 'bundle_01', questions: [QUESTION] }),
    readRoadmap: readOperation({ target: '…', units: [{ order: 1, day: 1, topic_id: 1, term: TERM, goals: [1] }] }),
    readSources: readOperation({ collected_at: '2026-11-19', collector: 'public_official', sources: [{ name: '経済産業省「DXレポート」' }] }),
    readMaterialRequirements: registryOperation,
  },
})
