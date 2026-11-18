/** UC-014 の受け持ち（changeOwnPassword。まなびば）。本人は実例のパスワード（harunokaze8）を持つ一般の利用者。 */

import { YUDAI } from '../kit/people'
import { portalWorld } from '../kit/portal'
import { defineHandler } from '../kit/protocol'

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-014',
  operations: {
    changeOwnPassword: async (line) => {
      const world = await portalWorld()
      await world.account({ ...YUDAI, grants: ['ip'] })
      return world.send(line, world.session(YUDAI.id))
    },
  },
})
