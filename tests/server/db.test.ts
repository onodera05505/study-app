import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'

/** 配備のデータの保存先と死活確認（UC-017 の表「配備のデータの保存先」）。学びの key は登録簿にある ip。 */
const deployment = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', JWT_SECRET: 'test-secret', ...over }) as Bindings

describe('データの保存先（D1）が応答しない配備（UC-017）', () => {
  // @covers REQ-260#health-without-store-learning
  it('保存先が SQL を受けるたびに失敗する配備でも、死活確認は保存先を引かずに 200 {ok: true} を返す', async () => {
    const calls: string[] = []
    const failingD1 = {
      prepare: (sql: string) => {
        calls.push(sql)
        throw new Error('D1 は応答しない')
      },
      batch: async () => {
        calls.push('batch')
        throw new Error('D1 は応答しない')
      },
      exec: async (sql: string) => {
        calls.push(sql)
        throw new Error('D1 は応答しない')
      },
    } as unknown as D1Database
    const res = await app.request('/api/health', {}, deployment({ DB: failingD1 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls, '死活確認が保存先を引いている').toEqual([])
  })
})
