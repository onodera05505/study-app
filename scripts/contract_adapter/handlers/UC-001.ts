/** UC-001 の受け持ち（getGlossary）。ok は用語集に 2 語（論点 418 に紐づく語と、紐づかない語）、okEmpty は空の用語集。 */

import { LEARNER, learningWorld } from '../kit/learning'
import { defineHandler } from '../kit/protocol'

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-001',
  operations: {
    getGlossary: async (line) => {
      const world = await learningWorld()
      world.user(LEARNER.id, LEARNER.name)
      if (line.case === 'ok') {
        const put = world.db.prepare('INSERT INTO glossary (term, brief, topic_id) VALUES (?, ?, ?)')
        put.run('ARP（アドレス解決プロトコル）', 'IP アドレスから MAC アドレスを調べる仕組み。', 418)
        put.run('アローダイアグラム', '作業の順序と所要日数を矢印で表した図。', null)
      }
      return world.send(line, LEARNER)
    },
  },
})
