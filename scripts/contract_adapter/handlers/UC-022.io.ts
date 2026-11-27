/**
 * UC-022 の読み書きの受け持ち（道具の中の読み書き。入口は kit/py.ts の橋で呼ぶ Python の関数。ADR-0013）。
 * 前提のファイルは実例ごとの影の根（登録簿を写す）に置き、関数は影の根を作業ディレクトリにして呼ぶ。
 * - ok: 実例が読むファイルに、契約の例の応答の中身を、書き手と道具が書くファイルの形で置く
 *   （入力の束は論点ごとに問題を束ねた形、正解表は回ごと・問番号ごとの形、過去問は回のファイルの形、論点の一覧・教材は束ねる欄を添えた形）
 * - missing: 読むファイルを置かない
 * - unreadable: 読むファイルに途中で途切れた JSON を置く
 * - readLearningKind は登録簿を読むので、ok（ip）・unknown（zzz）とも写した登録簿のまま
 */

import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { callOperation, pyAnswer } from '../kit/py'
import { field, inShadow, writeJson } from '../kit/tb'
import type { Shadow } from '../kit/tool'

const EXPLANATION = {
  question_id: '2026r08-q97',
  content_key: '50bfe9f96eabc25f',
  correct: 'イ',
  correct_reason: '…',
  choices: [
    { label: 'ア', term: null, note: '…' },
    { label: 'イ', term: null, note: '正解。…' },
    { label: 'ウ', term: null, note: '…' },
    { label: 'エ', term: null, note: '…' },
  ],
}

/** 例の名前ごとに、request の path に置く物（undefined は置かない）。 */
function readOperation(okContent: unknown): Operation {
  return async (line: ExampleLine) => {
    const path = field(line.request, 'path')
    if (path === undefined) throw new Unanswerable(`${line.uc} ${line.operation}.${line.case} の request に path が無い`)
    const put: Record<string, ((shadow: Shadow) => Promise<void>) | undefined> = {
      ok: (shadow) => writeJson(shadow, path, okContent),
      missing: undefined,
      unreadable: (shadow) => shadow.write(path, '{"bundle": "expl_02", "items": ['),
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
  uc: 'UC-022',
  parallel: true,
  operations: {
    readLearningKind: registryOperation,
    readExplanationBundle: readOperation({ bundle: 'expl_01', topics: [{ topic_id: 2, term: 'オープンソースソフトウェア', questions: [{ question_id: '2026r08-q97', content_key: '50bfe9f96eabc25f' }] }] }),
    readExplanations: readOperation({ bundle: 'expl_01', explanations: [EXPLANATION] }),
    readAnswerKeys: readOperation({ '2026r08': { '97': 'イ' } }),
    readPastQuestions: readOperation({
      exam: '2018h30h',
      questions: [{ number: 1, page: 1, text: '…', choices: { ア: '…', イ: '…', ウ: '…', エ: '…' }, has_figure: false, figure_description: null, confidence: 'high', notes: null }],
    }),
    readTopics: readOperation({ topic_count: 1, topics: [{ id: 9, term: 'ITガバナンス', aliases: [], questions: [] }] }),
    readTopicAliases: readOperation({ _comment: '仕込み', アジャイル: 'アジャイル開発' }),
    readMaterialFile: readOperation({ bundle: '01-1', materials: [{ topic_id: 395, term: '経営理念', explanation: '**経営理念**（企業理念）とは…', detail: '### しくみ\n…' }] }),
    readGlossaryOverrides: readOperation({ RPA: '…' }),
  },
})
