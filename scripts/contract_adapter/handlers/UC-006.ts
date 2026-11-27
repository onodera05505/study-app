/**
 * UC-006 の受け持ち（進行中のテストを取る・捨てる）。
 * 本人は実例の userId（u_01HQ8Z3K5M）。okInProgress・okDiscarded は、本人に進行中の演習 7b1e…（論点: RAID・10 問のうち 4 問に回答済み・
 * 開始 1759276800）がある学び。okNone・okNothingToDiscard は進行中のテストが無い学び。
 */

import { learningWorld, putItem, putQuestion, putSession, putSessionQuestion, type Item } from '../kit/learning'
import { defineHandler, type Operation } from '../kit/protocol'

const ME = { id: 'u_01HQ8Z3K5M', name: '学ぶ人', role: 'MEMBER' }
const SESSION = '7b1e3d50-9c42-4a8f-bd21-6e0f5a39c714'
const STORAGE: Item = { id: 32, name: 'RAID', field: 'テクノロジ系', majorNo: 8, major: 'コンピュータシステム', middleNo: 6, middle: 'システム構成要素' }

const run: Operation = async (line) => {
  const w = await learningWorld()
  w.user(ME.id, ME.name)
  if (line.case === 'okInProgress' || line.case === 'okDiscarded') {
    putItem(w.db, STORAGE)
    putSession(w.db, { id: SESSION, userId: ME.id, kind: 'drill', status: 'in_progress', scopeLabel: '論点: RAID', questionCount: 10, startedAt: 1759276800 })
    for (let idx = 0; idx < 10; idx++) {
      putQuestion(w.db, { id: `2022r04-${idx + 1}`, exam: '2022r04', examLabel: '令和4年度', number: idx + 1 })
      putSessionQuestion(w.db, {
        sessionId: SESSION,
        questionId: `2022r04-${idx + 1}`,
        idx,
        snapshot: { idx },
        userAnswer: idx < 4 ? 'ア' : null,
        result: idx < 4 ? 1 : 0,
        answeredAt: idx < 4 ? 1759276900 + idx : null,
      })
    }
  }
  return w.send(line, ME)
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-006',
  operations: { getCurrentSession: run, discardCurrentSession: run },
})
