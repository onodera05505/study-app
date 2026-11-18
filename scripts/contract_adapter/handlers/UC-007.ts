/**
 * UC-007 の受け持ち（受験履歴）。ok は本人が締めたテスト 2 つ（令和6年度の模試 3f2a… と、論点: RAID の演習 9c5d…）がある学び、
 * okEmpty は締めたテストが無い学び。
 */

import { LEARNER, learningWorld, putSession } from '../kit/learning'
import { defineHandler } from '../kit/protocol'

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-007',
  operations: {
    listExamHistory: async (line) => {
      const w = await learningWorld()
      w.user(LEARNER.id, LEARNER.name)
      if (line.case === 'ok') {
        putSession(w.db, {
          id: '3f2a7c1e-5b84-4d6a-9e10-2c7b8a4f0d55',
          userId: LEARNER.id,
          kind: 'mock',
          status: 'completed',
          sourceExam: '2024r06',
          scopeLabel: '令和6年度 を通しで受験',
          timeLimitSec: 7200,
          questionCount: 100,
          correctCount: 64,
          startedAt: 1759276800,
          finishedAt: 1759283500,
        })
        putSession(w.db, {
          id: '9c5d41b2-0e7a-4f38-b6c1-5a0d3e92f7aa',
          userId: LEARNER.id,
          kind: 'drill',
          status: 'completed',
          scopeLabel: '論点: RAID',
          questionCount: 10,
          correctCount: 8,
          startedAt: 1759190400,
          finishedAt: 1759190940,
        })
      }
      return w.send(line, LEARNER)
    },
  },
})
