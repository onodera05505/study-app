/**
 * UC-005 の受け持ち（前回の続きの端末の記憶。saveLastTopic・readLastTopic・clearLastTopic）。
 * 入口は `src/client/lib/` の export（save… は set…、read… は get…）。実例ごとに端末の記憶の代わりを新しく置く（kit/tc.ts）。
 * 応答は契約どおり「書いた・捨てたあとに読む」値（getLastTopic）。
 * 前提:
 * - saveLastTopic.storageBlocked: 端末の記憶に書けない（errors の when）。
 * - readLastTopic.ok: saveLastTopic の実例の論点を覚えた端末。none: 覚えていない端末。
 *   unreadable: 覚えた値が壊れている端末（REQ-082 の「覚えた値が読めない」）。
 * - clearLastTopic.ok: 論点を覚えた端末。
 */

import { answerFrom, deviceWorld } from '../kit/tc'
import { defineHandler, type ExampleLine } from '../kit/protocol'

type LastTopic = { id: number; term: string; middle: string; middleNo: number }

/** 契約 saveLastTopic の実例の論点（読む・捨てる実例の前提に覚えさせる値）。 */
const REMEMBERED: LastTopic = { id: 412, term: '公開鍵暗号方式', middle: '情報セキュリティ', middleNo: 11 }

const requested = (line: ExampleLine) => (line.request as { lastTopic: LastTopic }).lastTopic

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-005',
  operations: {
    saveLastTopic: async (line) => {
      const w = await deviceWorld()
      if (line.case === 'storageBlocked') w.blockWrites()
      return answerFrom(() => {
        w.api.setLastTopic(requested(line))
        return { lastTopic: w.api.getLastTopic() }
      })
    },
    readLastTopic: async (line) => {
      const w = await deviceWorld()
      if (line.case !== 'none') w.api.setLastTopic(REMEMBERED)
      if (line.case === 'unreadable') w.corrupt(REMEMBERED.term)
      return answerFrom(() => ({ lastTopic: w.api.getLastTopic() }))
    },
    clearLastTopic: async () => {
      const w = await deviceWorld()
      w.api.setLastTopic(REMEMBERED)
      return answerFrom(() => {
        w.api.clearLastTopic()
        return { lastTopic: w.api.getLastTopic() }
      })
    },
  },
})
