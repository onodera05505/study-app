import { afterAll, describe, expect, it } from 'vitest'
import { contractRun, opWith, realExample, removeTemps, runsTestMs, shadowSpec, tailOf, verdictOf } from './UC-033_fixture'

/**
 * UC-033 の REQ-568: 実装に渡せない実例（受け持ちが前提を決められない例の名前）があれば、確かめはその実例を挙げて失敗で終える。
 * 本物の契約の UC-032 checkSource の実例 unknownArgument を、受け持ちが前提を知らない例の名前に付け替えた影の根（`--root`。契約だけを差し替える）で照らす。
 * 理由の文の文言は照らさない（REQ-568 の検証しない）。
 */

afterAll(async () => {
  await removeTemps()
})

const SOURCE = ['UC-032', 'checkSource'] as const
const UNKNOWN = 'premiseNobodyKnows'

describe('UC-033 実装に渡せない実例を挙げて失敗で終える（REQ-568）', () => {
  // @covers REQ-568#unreachable
  it('受け持ちが前提を決められない名前の実例があれば、通さずにその実例を挙げて失敗で終える', async () => {
    const root = shadowSpec([{ uc: SOURCE[0], operations: { [SOURCE[1]]: opWith(...SOURCE, { [UNKNOWN]: realExample(...SOURCE, 'unknownArgument') }) } }])
    const run = await contractRun(['--root', root, '--json'])
    expect(run.code, `前提を決められない実例があるのに通った:\n${tailOf(run)}`).not.toBe(0)
    expect(run.code, '止められて終わった').not.toBe(-1)
    expect(verdictOf(run, { uc: SOURCE[0], operation: SOURCE[1], case: UNKNOWN })?.verdict).not.toBe('pass')
    expect(`${run.stdout}\n${run.stderr}`, '渡せなかった実例（例の名前）が挙がっていない').toContain(UNKNOWN)
  }, runsTestMs())
})
