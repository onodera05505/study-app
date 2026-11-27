/**
 * UC-008 の受け持ち（公開回の一覧）。ok は令和6年度（2024r06）と令和5年度（2023r05）の 100 問ずつがあり、
 * 本人が令和6年度の模試を 2 回締めた（正答 78 と 61）学び。
 */

import { LEARNER, learningWorld, putQuestion, putSession } from '../kit/learning'
import { defineHandler } from '../kit/protocol'

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-008',
  operations: {
    listExams: async (line) => {
      const w = await learningWorld()
      w.user(LEARNER.id, LEARNER.name)
      if (line.case === 'ok') {
        for (const [exam, label] of [
          ['2024r06', '令和6年度'],
          ['2023r05', '令和5年度'],
        ]) {
          for (let n = 1; n <= 100; n++) putQuestion(w.db, { id: `${exam}-${n}`, exam, examLabel: label, number: n })
        }
        ;[78, 61].forEach((correct, i) =>
          putSession(w.db, {
            id: `mock-2024r06-${i + 1}`,
            userId: LEARNER.id,
            kind: 'mock',
            status: 'completed',
            sourceExam: '2024r06',
            scopeLabel: '令和6年度 を通しで受験',
            timeLimitSec: 7200,
            questionCount: 100,
            correctCount: correct,
            startedAt: 1759000000 + i * 100000,
            finishedAt: 1759007000 + i * 100000,
          }),
        )
      }
      return w.send(line, LEARNER)
    },
  },
})
