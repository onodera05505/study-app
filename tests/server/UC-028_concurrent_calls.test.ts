import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildAsync, cleanWorkspaces, makeWorkspace, setupRewritten, toolError, withParentDirs, type Run, type Ws } from './UC-028_fixture'

/** UC-028 同じ出力先に単元の読み物を作る呼び出しが同時に進む（REQ-511）。
 *  入口（buildUnitReading）を同じ作業場で同じ出力先に向けて同時に何本も起こし、終了コード・標準出力の JSON・出力先の中身だけを見る。
 *  どの呼び出しが勝つかは問わない。 */

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 })

const CALLS = 3
const ROUNDS = 2
const OUT = 'readings/ip_21'

afterAll(() => cleanWorkspaces())

async function buildTogether(): Promise<{ ws: Ws; rs: Run[] }> {
  const ws = makeWorkspace('concurrent')
  setupRewritten(ws)
  ws.write('readings/.keep', '')
  const rs = await Promise.all(Array.from({ length: CALLS }, () => buildAsync(ws, { out: OUT })))
  return { ws, rs }
}

describe('UC-028 同じ出力先に単元の読み物を作る呼び出しが同時に進む（REQ-511）', () => {
  /** @covers REQ-511#one-writer */
  it('同時に進んだ呼び出しのうち読み物を書くのは 1 つだけで、出力先にはその呼び出しが応答した物だけが残る', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { ws, rs } = await buildTogether()
      const won = rs.filter((r) => r.status === 0)
      expect(won.length, rs.map((r) => r.stdout + r.stderr).join('\n---\n')).toBe(1)
      expect(ws.files(OUT)).toEqual([won[0].json.reading, ...(won[0].json.figures as string[])].sort())
    }
  })

  /** @covers REQ-511#others-stopped-clean */
  it('ほかの呼び出しは CONFLICT で止まり、作りかけの物を出力先にもその親にも残さない', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { ws, rs } = await buildTogether()
      const lost = rs.filter((r) => r.status !== 0)
      expect(lost.length, rs.map((r) => r.stdout + r.stderr).join('\n---\n')).toBe(CALLS - 1)
      for (const r of lost) {
        expect(r.code, r.stdout + r.stderr).toBe('CONFLICT')
        expect(typeof toolError(r.json)?.reason === 'string' && toolError(r.json).reason.length > 0).toBe(true)
      }
      const won = rs.find((r) => r.status === 0)!
      expect(ws.entries('readings')).toEqual(withParentDirs(['.keep', ...[won.json.reading, ...(won.json.figures as string[])].map((f) => `ip_21/${f}`)]))
    }
  })
})
