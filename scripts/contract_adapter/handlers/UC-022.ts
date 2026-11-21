/**
 * UC-022 の受け持ち（問題解説の門 checkExplanations ＝ `python3 scripts/check_explanations.py --data <学びの置き場> [--bundles <入力の束の置き場>]`）。
 * 引数は request の各欄と同じ名前（kit/td.ts の argsOf）。道具は実例ごとの影の根（登録簿だけを写す。kit/tb.ts の inShadow）を
 * 作業ディレクトリにして回す。応答は標準出力の全体か最後の空でない行の JSON（kit/td.ts の answerOf。止める理由ありの 1 も応答）。
 *
 * 前提（例の名前と契約の errors の when から）:
 * - pass（ip）: 1 回分の過去問 1100 問と正解表、入力の束 11 個（100 問ずつ）と、同じ名前の問題解説のファイル 11 個を置く。
 *   本文は問題ごとに違い、問題解説は過去問の原文と 30 字続けて一致しない。選択肢の用語は問題ごとに違う語で、説明は敬体で 90 字以内。
 *   止める理由にも警告にも当たらない
 * - badArguments: 同じ学び（入力の束 1 つ）を置き、知らない名前の引数を渡す
 * - unknownLearning（zzz）・notQualification（itc）: 同じ形の学びを置き、問題解説のファイルは途中で途切れている（確かめれば止まる）
 * - bundlesMissing（ip）・notQualificationBeforeBundlesMissing（itc）: 学びはあり、request の bundles の置き場が無い
 * - answerKeysMissing（fe）: 同じ形の学びから正解表を除き、問題解説のファイルは途中で途切れている（確かめれば止まる）
 * - answerKeysUnreadable（ap）: 同じ形の学びの正解表が途中で途切れている
 */

import { rm } from 'node:fs/promises'
import { defineHandler, Unanswerable } from '../kit/protocol'
import { contentKeyOf, inShadow, keyOf, runScript, writeJson } from '../kit/tb'
import { answerOf, argsOf } from '../kit/td'
import type { Shadow } from '../kit/tool'

const LABELS = ['ア', 'イ', 'ウ', 'エ'] as const
const EXAM = '2018h30a'

/**
 * data/<key> に、過去問 count 問を 100 問ずつの束に分けた資格対策の学びを置く。brokenExplanations なら問題解説のファイルを途切れさせる。
 * @implements REQ-570
 */
async function writeExplanationLearning(shadow: Shadow, key: string, count: number, brokenExplanations: boolean): Promise<void> {
  const qs = Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const choices = Object.fromEntries(LABELS.map((l) => [l, `選択肢${n}${l}`])) as Record<string, string>
    const text = `第${n}問の本文です。合うものを選びます。`
    return { n, text, choices, answer: LABELS[i % 4], qid: `${EXAM}-q${n}`, key: contentKeyOf(text, choices) }
  })
  await writeJson(shadow, `data/${key}/questions/${EXAM}.json`, {
    exam: EXAM,
    source: '仕込みの出典',
    normalized: true,
    question_count: count,
    questions: qs.map((q) => ({ number: q.n, page: 1, text: q.text, choices: q.choices, has_figure: false, figure_description: null, confidence: 'high', notes: null })),
  })
  await writeJson(shadow, `data/${key}/answer_keys.json`, { [EXAM]: Object.fromEntries(qs.map((q) => [String(q.n), q.answer])) })
  await writeJson(shadow, `data/${key}/exam_labels.json`, { [EXAM]: '平成30年度 秋期' })
  await writeJson(shadow, `data/${key}/glossary_overrides.json`, {})
  await writeJson(shadow, `data/${key}/topics.json`, {
    topic_count: 1,
    question_count: count,
    exams: [EXAM],
    topics: [{ id: 1, term: '仕込みの論点', match_key: 'key1', syllabus_item: 1, syllabus_item_name: '小項目一', field: '分野', major: '大項目', middle: '中項目', is_new: false, related_terms: [], question_count: 0, questions: [] }],
  })
  for (let b = 0; b * 100 < count; b++) {
    const bundle = `expl_${String(b + 1).padStart(2, '0')}`
    const part = qs.slice(b * 100, b * 100 + 100)
    await writeJson(shadow, `data/${key}/explanation_bundles/${bundle}.json`, {
      bundle,
      topics: [{ topic_id: 1, term: '仕込みの論点', questions: part.map((q) => ({ question_id: q.qid, content_key: q.key, stem: q.text, choices: q.choices, answer: q.answer })) }],
    })
    const explanations = part.map((q) => ({
      question_id: q.qid,
      content_key: q.key,
      correct: q.answer,
      correct_reason: `決め手は第${q.n}問の条件です。`,
      choices: LABELS.map((l) => (l === q.answer ? { label: l, term: null, note: '正解。' } : { label: l, term: `用語${q.n}${l}`, note: `用語${q.n}${l}の説明です。` })),
    }))
    const file = `data/${key}/question_explanations/${bundle}.json`
    if (brokenExplanations) await shadow.write(file, `{"bundle": "${bundle}", "explanations": [`)
    else await writeJson(shadow, file, { bundle, explanations })
  }
}

const PRECONDITIONS: Record<string, (shadow: Shadow, key: string) => Promise<void>> = {
  pass: (shadow, key) => writeExplanationLearning(shadow, key, 1100, false),
  badArguments: (shadow, key) => writeExplanationLearning(shadow, key, 4, false),
  unknownLearning: (shadow, key) => writeExplanationLearning(shadow, key, 4, true),
  notQualification: (shadow, key) => writeExplanationLearning(shadow, key, 4, true),
  bundlesMissing: (shadow, key) => writeExplanationLearning(shadow, key, 4, false),
  notQualificationBeforeBundlesMissing: (shadow, key) => writeExplanationLearning(shadow, key, 4, false),
  answerKeysMissing: async (shadow, key) => {
    await writeExplanationLearning(shadow, key, 4, true)
    await rm(shadow.path(`data/${key}/answer_keys.json`), { force: true })
  },
  answerKeysUnreadable: async (shadow, key) => {
    await writeExplanationLearning(shadow, key, 4, false)
    await shadow.write(`data/${key}/answer_keys.json`, `{"${EXAM}": {"1": "ア", `)
  },
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-022',
  parallel: true,
  operations: {
    checkExplanations: async (line) => {
      const prepare = PRECONDITIONS[line.case]
      if (!prepare) throw new Unanswerable(`UC-022 checkExplanations の例 ${line.case} の前提を知らない`)
      const key = keyOf(line.request)
      return inShadow(async (shadow) => {
        await prepare(shadow, key)
        return answerOf(await runScript(shadow, 'check_explanations.py', argsOf(line.request)), [0, 1])
      })
    },
  },
})
