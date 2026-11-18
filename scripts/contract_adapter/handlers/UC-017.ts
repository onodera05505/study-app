/** UC-017 の受け持ち（getHealth）。死活確認は学び側とまなびばの両方の配備が受ける経路なので、両方に渡し、両方の応えをそろえて返す。 */

import { learningWorld } from '../kit/learning'
import { portalWorld } from '../kit/portal'
import { defineHandler } from '../kit/protocol'

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-017',
  operations: {
    getHealth: async (line) => {
      const fromLearning = await (await learningWorld()).send(line, null)
      if ('error' in fromLearning) return fromLearning
      const fromPortal = await (await portalWorld()).send(line, null)
      if ('error' in fromPortal) return fromPortal
      return fromLearning
    },
  },
})
