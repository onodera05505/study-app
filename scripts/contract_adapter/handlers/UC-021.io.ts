/**
 * UC-021 の読み書きの受け持ち（道具の中の読み書き。入口は kit/py.ts の橋で呼ぶ Python の関数。ADR-0013）。
 * 前提のファイルは実例ごとの影の根（登録簿の写しを持つ。kit/tb.ts の inShadow）に置き、関数は影の根を作業ディレクトリにして呼ぶ。
 * - ok: 実例が読むファイルに、契約の例の応答と同じ中身を置く（教材・確認問題は束の名前も、集めた資料は集めた側の名前も、
 *   独立解答は書き手の名前も持つ、学びの置き場のファイルの形）。readMaterialRequirements の ok は、影の根の登録簿の eng の
 *   roadmapSpec の、例が持つ欄を例の値にする（ほかの欄は登録簿の写しのまま）
 * - missing・unknown: 読むファイル（登録簿なら学び）を置かない
 * - unreadable: 読むファイルに途中で途切れた JSON を置く。readRoadmap はリポジトリの fixture（tests/fixtures/gate-broken-roadmap）を写す。
 *   readIndependentAnswers は周の結果の形（answers を持たない JSON）を置く
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { callOperation, pyAnswer } from '../kit/py'
import { REGISTRY, field, inShadow, writeJson } from '../kit/tb'
import { REPO_ROOT, type Shadow } from '../kit/tool'

type Put = (shadow: Shadow, path: string, line: ExampleLine) => Promise<void>

const truncated: Put = (shadow, path) => shadow.write(path, '{"items": [')

function readOperation(key: string, puts: Record<string, Put | undefined>): Operation {
  return async (line: ExampleLine) => {
    if (!(line.case in puts)) throw new Unanswerable(`${line.uc} ${line.operation} の例 ${line.case} の前提を知らない`)
    const path = field(line.request, key)
    if (path === undefined) throw new Unanswerable(`${line.uc} ${line.operation}.${line.case} の request に ${key} が無い`)
    return inShadow(async (shadow) => {
      await puts[line.case]?.(shadow, path, line)
      return pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root }))
    })
  }
}

const ROADMAP_OK = { target: '仕込み', units: [{ order: 1, topic_id: 1, term: 'ITコンサルタントの仕事', summary: '…', prereq: [], goals: [1] }] }
const MATERIALS_OK = {
  bundle: 'bundle_01',
  materials: [{ topic_id: 1, term: 'ITコンサルタントの仕事', explanation: '**ITコンサルタントの仕事**は…', detail: '### しくみ\n…', sources: [] }],
}
const QUESTIONS_OK = {
  bundle: 'bundle_01',
  questions: [
    {
      qid: 't1-1', topic_id: 1, term: 'ITコンサルタントの仕事', stem: '…',
      choices: { ア: '…', イ: '…', ウ: '…', エ: '…' }, answer: 'イ', reason: '…',
      choice_notes: { ア: '…', イ: '正解。…', ウ: '…', エ: '…' }, tests_goal: 1,
    },
  ],
}
const SOURCES_OK = { collected_at: '2026-09-14', collector: 'public_official', sources: [{ name: '経済産業省「DXレポート」', fetched: true, outline: [] }] }
const ANSWERS_OK = { solver: 'B', answers: { 't1-1': 'ア', 't1-2': 'イ' } }
/** readMaterialRequirements.ok の例の応答の roadmapSpec（登録簿の eng の写しに置く値）。 */
const REQUIREMENTS_OK = {
  keywordLabel: 'キーワード',
  usageSection: 'ひとことで説明すると',
  ngWords: ['最新', '近年', '年収', '万円', '激務'],
  tiers: [
    { level: 3, label: '★★★ まず押さえる', rule: '説明を求められやすい・初日から会話に出る・他の多くの単位の前提になる' },
    { level: 2, label: '★★ 1 年目に要る', rule: '入社 1 年目の仕事で使う・知らないと事故や手戻りになる' },
    { level: 1, label: '★ 必要になったら', rule: '基本情報の水準・特定の職種や場面で要る' },
  ],
}

/** 影の根の登録簿の学び learning の roadmapSpec に、例の応答の roadmapSpec の値を置く。 */
const registryWithExample: Put = async (shadow, _path, line) => {
  const learning = field(line.request, 'learning')!
  const registry = JSON.parse(await readFile(join(REPO_ROOT, REGISTRY), 'utf8')) as Record<string, any>
  if (!registry[learning]) throw new Unanswerable(`readMaterialRequirements.ok の学び ${learning} が登録簿に無い`)
  registry[learning].kind = 'roadmap'
  registry[learning].roadmapSpec = { ...(registry[learning].roadmapSpec ?? {}), ...REQUIREMENTS_OK }
  await writeJson(shadow, REGISTRY, registry)
}

/**
 * @implements REQ-567, REQ-570, REQ-579
 */
export default defineHandler({
  uc: 'UC-021',
  parallel: true,
  operations: {
    readRoadmap: readOperation('path', {
      ok: (shadow, path) => writeJson(shadow, path, ROADMAP_OK),
      missing: undefined,
      unreadable: async (shadow, path) => shadow.write(path, await readFile(join(REPO_ROOT, path), 'utf8')),
    }),
    readMaterialFile: readOperation('path', {
      ok: (shadow, path) => writeJson(shadow, path, MATERIALS_OK),
      missing: undefined,
      unreadable: truncated,
    }),
    readRoadmapQuestions: readOperation('path', {
      ok: (shadow, path) => writeJson(shadow, path, QUESTIONS_OK),
      missing: undefined,
      unreadable: truncated,
    }),
    readSources: readOperation('path', {
      ok: (shadow, path) => writeJson(shadow, path, SOURCES_OK),
      unreadable: truncated,
    }),
    readMaterialRequirements: readOperation('learning', {
      ok: registryWithExample,
      unknown: undefined,
    }),
    readIndependentAnswers: readOperation('path', {
      ok: (shadow, path) => writeJson(shadow, path, ANSWERS_OK),
      missing: undefined,
      unreadable: (shadow, path) => writeJson(shadow, path, { cycle: 3, score: '84/84', rate: 1 }),
    }),
  },
})
