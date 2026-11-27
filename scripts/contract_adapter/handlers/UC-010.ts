/**
 * UC-010 の受け持ち（submitFeedback。`http` の操作だけを持つ。端末の記憶の操作は別の受け持ちが足す）。
 * 本人が居る学び。成功例は作られる受付の id を実例の値にそろえる。overDailyLimit は本人が直近 1 日に 20 件を受け付け済みの学び
 * （上限に達している。errors の when）。
 */

import { LEARNER, learningWorld, putTopic } from '../kit/learning'
import { withUuids } from '../kit/outside'
import { defineHandler } from '../kit/protocol'

const IDS: Record<string, string> = {
  ok: '9c2f7a41-5d38-4b06-9e17-83a0c6d41b29',
  okWithQuestion: '1d84b35e-7c90-4a21-8f63-ce95a2704d18',
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-010',
  operations: {
    submitFeedback: async (line) => {
      const w = await learningWorld()
      w.user(LEARNER.id, LEARNER.name)
      putTopic(w.db, {
        id: 412,
        term: 'LTV',
        item: { id: 1, name: 'ビジネスインダストリ', field: 'ストラテジ系', majorNo: 2, major: '経営戦略', middleNo: 5, middle: '経営戦略マネジメント' },
        questions: 1,
      })
      if (line.case === 'overDailyLimit') {
        for (let i = 0; i < 20; i++)
          w.db.prepare("INSERT INTO feedback (id, user_id, kind, body) VALUES (?, ?, 'good', ?)").run(`accepted-${i}`, LEARNER.id, `受付済み ${i + 1}`)
      }
      const id = IDS[line.case]
      return id ? withUuids([id], () => w.send(line, LEARNER)) : w.send(line, LEARNER)
    },
  },
})
