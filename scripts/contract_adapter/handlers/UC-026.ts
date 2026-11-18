/**
 * UC-026 の受け持ち（束を作る道具。入口は `python3 scripts/build_rewrite_bundles.py`）。
 * - buildUnitInputs ＝ `--unit-inputs --data <学びの置き場> --out <出力先> [--units <番号>…]`
 * - buildRewriteBundles ＝ `--data <学びの置き場> --out <出力先> [--units <番号>…]`
 * 前提は実例の名前ごとに影の根へ作る（kit/tb.ts）。基の学びは次のとおり。
 * - シラバスの単元は 1・21・23・24。論点は単元 1 に 11〜13、21 に 211〜219、23 に 231〜233（24 は論点を持たない）
 * - 単元の構成は 21（まとまり 3 つ: 211〜213・214〜216・217〜219）と 23（まとまり 1 つ）で、どちらも止める理由に当たらない。
 *   単元 1 は単元の構成を持たない
 * - 論点 211 に過去問 2019h31h の 7 が紐づき、正解表・問題解説・図の仕様があり、全論点に教材の世代 materials の教材がある
 * 実例ごとの違い:
 * - outputExists・unknownUnitBeforeOutputExists（buildUnitInputs）: 出力先に単元の入力の束の名前のファイル 21.json がある
 * - outputExists・outputExistsBeforePlanMissing（buildRewriteBundles）: 出力先に書き直しの束の名前のファイル 21-1.json がある
 * - planStops: 単元 23 の構成で論点 233 がどのまとまりにも入っていない
 * - answerMissing: 正解表に過去問 2019h31h の 7 の正解が無い
 * - unknownLearning（zzz）・notQualification（itc）: 基の学びと同じ形
 * - syllabusMissing（fe）: 論点の一覧はあり、シラバスが無い。syllabusUnreadable（ap）: シラバスが JSON として読めない
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import {
  answerOf, chunk, contentKeyOf, field, inShadow, keyOf, planOf, range, removeFile, runScript, writeJson, writeLearning, writePlan,
  type SyllabusUnit, type TopicSeed,
} from '../kit/tb'
import type { Shadow } from '../kit/tool'

const UNIT_1: SyllabusUnit = { no: 1, name: '単元一', items: [1] }
const UNIT_21: SyllabusUnit = { no: 21, name: '単元二十一', items: [54] }
const UNIT_23: SyllabusUnit = { no: 23, name: '単元二十三', items: [60] }
const UNIT_24: SyllabusUnit = { no: 24, name: '単元二十四', items: [61] }

const EXAM = '2019h31h'
const QUESTION = { number: 7, text: '問いの本文です。', choices: { ア: '選択肢アです。', イ: '選択肢イです。', ウ: '選択肢ウです。', エ: '選択肢エです。' }, answer: 'ウ' }

const topicsOf = (ids: number[], item: number): TopicSeed[] => ids.map((id) => ({ id, term: `論点${id}`, item }))

type Variant = { answerMissing?: boolean; plan23Stops?: boolean; existing?: string }

/** 基の学びを置き、実例ごとの違いを重ねる。 */
async function learning(shadow: Shadow, key: string, v: Variant = {}) {
  const t21 = range(211, 9)
  const t23 = range(231, 3)
  const topics: TopicSeed[] = [
    ...topicsOf(range(11, 3), 1),
    ...t21.map((id) => ({ id, term: `論点${id}`, item: 54, questions: id === 211 ? [{ exam: EXAM, number: QUESTION.number }] : [] })),
    ...topicsOf(t23, 60),
  ]
  await writeLearning(shadow, key, { units: [UNIT_1, UNIT_21, UNIT_23, UNIT_24], topics })
  await writePlan(shadow, key, planOf(UNIT_21, chunk(t21, [3, 3, 3])))
  await writePlan(shadow, key, planOf(UNIT_23, [v.plan23Stops ? [231, 232] : t23]))
  const base = `data/${key}`
  await writeJson(shadow, `${base}/questions/${EXAM}.json`, {
    exam: EXAM,
    source: '仕込みの出典',
    normalized: true,
    question_count: 1,
    questions: [{ number: QUESTION.number, page: 1, text: QUESTION.text, choices: QUESTION.choices, has_figure: false, figure_description: null, confidence: 'high', notes: null }],
  })
  await writeJson(shadow, `${base}/answer_keys.json`, { [EXAM]: v.answerMissing ? {} : { [String(QUESTION.number)]: QUESTION.answer } })
  await writeJson(shadow, `${base}/exam_labels.json`, { [EXAM]: '平成31年度 春期' })
  await writeJson(shadow, `${base}/question_explanations/expl_01.json`, {
    bundle: 'expl_01',
    explanations: [
      {
        question_id: `${EXAM}-q${QUESTION.number}`,
        content_key: contentKeyOf(QUESTION.text, QUESTION.choices),
        correct: QUESTION.answer,
        correct_reason: '正解の根拠です。',
        choices: ['ア', 'イ', 'ウ', 'エ'].map((label) => ({ label, term: null, note: `選択肢${label}の説明です。` })),
      },
    ],
  })
  await writeJson(shadow, `${base}/materials/batch_01.json`, {
    batch: 1,
    materials: topics.map((t) => ({ topic_id: t.id, term: t.term, explanation: `**${t.term}**とは、${t.term}の説明です。`, detail: `### しくみ\n${t.term}の解説です。` })),
  })
  await writeJson(shadow, `${base}/material_figures/211.json`, {
    topic_id: 211,
    term: '論点211',
    figures: [{ id: 1, type: 'matrix', after: 'explanation', caption: '論点211の図の説明です。', rows: [['甲', '乙']] }],
  })
  if (v.existing) await shadow.write(v.existing, '{}')
}

type Prepare = (shadow: Shadow, key: string, out: string) => Promise<void>

const plain: Prepare = (shadow, key) => learning(shadow, key)
const syllabusMissing: Prepare = async (shadow, key) => {
  await learning(shadow, key)
  await removeFile(shadow, `data/${key}/syllabus.json`)
}
const syllabusUnreadable: Prepare = async (shadow, key) => {
  await learning(shadow, key)
  await shadow.write(`data/${key}/syllabus.json`, '{"items": [')
}
/** 出力先に name のファイルを置く。 */
const existing = (name: string): Prepare => (shadow, key, out) => learning(shadow, key, { existing: `${out}/${name}` })

const UNIT_INPUTS: Record<string, Prepare> = {
  ok: plain,
  unknownLearning: plain,
  notQualification: plain,
  syllabusMissing,
  syllabusUnreadable,
  unknownUnit: plain,
  outputExists: existing('21.json'),
  unknownUnitBeforeOutputExists: existing('21.json'),
}

const REWRITE_BUNDLES: Record<string, Prepare> = {
  ok: plain,
  unknownLearning: plain,
  notQualification: plain,
  syllabusMissing,
  syllabusUnreadable,
  unknownUnit: plain,
  outputExists: existing('21-1.json'),
  planMissing: plain,
  planStops: (shadow, key) => learning(shadow, key, { plan23Stops: true }),
  answerMissing: (shadow, key) => learning(shadow, key, { answerMissing: true }),
  planMissingWhenUnitsOmitted: plain,
  outputExistsBeforePlanMissing: existing('21-1.json'),
}

/** 実例の request を道具の引数にして回す。 */
function build(operation: string, preconditions: Record<string, Prepare>, leading: string[]): Operation {
  return async (line: ExampleLine) => {
    const prepare = preconditions[line.case]
    if (!prepare) throw new Unanswerable(`UC-026 ${operation} の例 ${line.case} の前提を知らない`)
    const key = keyOf(line.request)
    const out = field(line.request, 'out')
    if (out === undefined) throw new Unanswerable(`UC-026 ${operation} の例 ${line.case} の request に out が無い`)
    const units = line.request?.units
    const unitArgs = Array.isArray(units) ? ['--units', ...units.map(String)] : []
    return inShadow(async (shadow) => {
      await prepare(shadow, key, out)
      return answerOf(await runScript(shadow, 'build_rewrite_bundles.py', [...leading, '--data', `data/${key}`, '--out', out, ...unitArgs]), [0])
    })
  }
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-026',
  parallel: true,
  operations: {
    buildUnitInputs: build('buildUnitInputs', UNIT_INPUTS, ['--unit-inputs']),
    buildRewriteBundles: build('buildRewriteBundles', REWRITE_BUNDLES, []),
  },
})
