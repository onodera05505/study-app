import { describe, expect, it, vi } from 'vitest'
import {
  BUILD_SCRIPT, GRADE_SCRIPT, SNAPSHOT_8, makeWorkspace, prepareGrade, resultFile, runAsync, snapshotFile, toolError,
  type Json, type Run, type Workspace,
} from './uc019_fixture'

/** UC-019 同じ学びの同じ周について、パックを作る呼び出し・採点する呼び出しが同時に進むとき。
 *  入口（buildLearnerPack・gradeLearnerAnswers）を同じ作業場所で同時に何本も起こし、終了コード・標準出力の JSON・
 *  学びの置き場の eval の下の写しと周の結果・各呼び出しの出力先だけを見る。どの呼び出しが勝つかは問わない。 */

/** パックを作る 1 回は図を描くブラウザの起動を含むので、同時に数本走らせる 1 本のテストには長めの見積もりを渡す。 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

/** 同時に起こす呼び出しの数と、競り合いを起こす回の数。 */
const BUILDERS = 3
const GRADERS = 6
const ROUNDS = 3

const parse = (s: string): Json => JSON.parse(s)
const winners = (rs: Run[]) => rs.filter((r) => r.status === 0)
const losers = (rs: Run[]) => rs.filter((r) => r.status !== 0)

/** 同じ周 8 について、出力先だけ違うパックを作る呼び出しを同時に起こす。 */
async function buildTogether(): Promise<{ ws: Workspace; outs: string[]; rs: Run[] }> {
  const ws = makeWorkspace()
  ws.write('packs/.keep', '')
  const outs = Array.from({ length: BUILDERS }, (_, i) => `packs/c8_${i}`)
  const rs = await Promise.all(outs.map((out) => runAsync(BUILD_SCRIPT, ws, ['--data', 'data/eng', '--cycle', '8', '--out', out])))
  return { ws, outs, rs }
}

/** 同じ周 8 について、同じ写しと同じ答えで採点する呼び出しを同時に起こす。 */
async function gradeTogether(): Promise<{ ws: Workspace; rs: Run[] }> {
  const ws = makeWorkspace()
  prepareGrade(ws, { answers: { 't5-1': 'イ', 't5-2': 'イ', 't2-1': 'ア' }, units: [{ topic_id: 5, minutes: 5, understood: 3 }] }, SNAPSHOT_8)
  const rs = await Promise.all(Array.from({ length: GRADERS }, () => runAsync(GRADE_SCRIPT, ws, ['--data', 'data/eng', '--cycle', '8', '--answers', 'answers/learner.json'])))
  return { ws, rs }
}

describe('UC-019 同じ周の呼び出しが同時に進む', () => {
  describe('パックを作る呼び出しが同時に進む（REQ-355）', () => {
    /** @covers REQ-355#one-writer */
    it('同時に進んだ呼び出しのうち写しを書くのは 1 つだけで、残った写しはその呼び出しが応答した写しと同じ', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { ws, rs } = await buildTogether()
        const won = winners(rs)
        expect(won.length, rs.map((r) => r.stdout + r.stderr).join('\n---\n')).toBe(1)
        expect(ws.exists(snapshotFile(8))).toBe(true)
        expect(parse(ws.read(snapshotFile(8)))).toEqual(won[0].json.snapshot)
      }
    })

    /** @covers REQ-355#others-stopped-clean */
    it('ほかの呼び出しは CONFLICT で止まり、作りかけのパックも自分の出力先も残さない', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { ws, outs, rs } = await buildTogether()
        const lost = rs.map((r, i) => ({ r, out: outs[i] })).filter(({ r }) => r.status !== 0)
        expect(lost.length).toBe(BUILDERS - 1)
        for (const { r, out } of lost) {
          expect(r.status, r.stdout + r.stderr).toBe(1)
          expect(r.code, r.stdout).toBe('CONFLICT')
          expect(typeof toolError(r.json)?.reason === 'string' && toolError(r.json).reason.length > 0).toBe(true)
          expect(ws.exists(out), out).toBe(false)
        }
      }
    })
  })

  describe('採点する呼び出しが同時に進む（REQ-356）', () => {
    /** @covers REQ-356#one-writer */
    it('同時に進んだ呼び出しのうち周の結果を書くのは 1 つだけで、残った周の結果はその呼び出しが応答した結果と同じ', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { ws, rs } = await gradeTogether()
        const won = winners(rs)
        expect(won.length, rs.map((r) => r.stdout + r.stderr).join('\n---\n')).toBe(1)
        expect(ws.exists(resultFile(8))).toBe(true)
        expect(parse(ws.read(resultFile(8)))).toEqual(won[0].json)
      }
    })

    /** @covers REQ-356#others-refused */
    it('ほかの呼び出しは CONFLICT で断り、周の結果を書き換えない', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { ws, rs } = await gradeTogether()
        const lost = losers(rs)
        expect(lost.length).toBe(GRADERS - 1)
        for (const r of lost) {
          expect(r.status, r.stdout + r.stderr).toBe(1)
          expect(r.code, r.stdout).toBe('CONFLICT')
          expect(typeof toolError(r.json)?.reason === 'string' && toolError(r.json).reason.length > 0).toBe(true)
        }
        const won = winners(rs)
        if (won.length === 1) expect(parse(ws.read(resultFile(8)))).toEqual(won[0].json)
      }
    })
  })
})
