/** UC-018「資格対策の教材を配る前に教材の門で確かめる」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。止める理由・警告・断りの種類ごとは各要件のテストが見る）。
 *  作り手は小さな資格対策の学び（tests/server/UC-018_fixture.ts。影の根の中）を教材の門にかける。 */

import { afterAll, describe, expect, it } from 'vitest'
import { TOPICS, gate, makeLearning, outOf, removeShadows } from '../server/UC-018_fixture'

afterAll(async () => {
  await removeShadows()
})

describe('UC-018 資格対策の教材を配る前に教材の門で確かめる', () => {
  // @scenario UC-018
  it('作り手が教材を門にかけると、止める理由が無いので通り、見た論点の数と教材の無い論点と警告が返る', async () => {
    const l = makeLearning('scenario')
    // 1〜5. 作り手が教材を門にかけ、システムが確かめて、結果を人が読む行と最後の機械向けの 1 行で返す
    const r = await gate(l)
    // 6. 作り手が、通ったことを見る
    expect(r.code, outOf(r)).toBe(0)
    expect(r.result, `機械向けの 1 行が無い:\n${outOf(r)}`).not.toBeNull()
    expect(r.result!.exitCode).toBe(0)
    expect(r.result!.topics).toBe(TOPICS.length)
    expect(r.result!.missingTopics).toEqual([])
    expect(r.result!.stops).toEqual([])
  }, 180_000)
})
