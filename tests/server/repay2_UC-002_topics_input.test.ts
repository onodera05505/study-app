/** 論点の一覧（UC-002 の listTopics ＝ GET /api/topics）の、受け付けない求め。
 *
 *  叩くのは契約の操作の入口だけ。認証を通った要求は来訪の記録で D1 を触るので、何も返さない偽の D1 を渡す。
 *  拒みの観測は 400 と ErrorBody（鍵は error だけ）で、内側の値が通ることも同じ偽の D1 で確かめる
 *  （内側が通らなければ外側の 400 は拒みの証拠にならない）。 */

import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'

/** 何も入っていない D1（prepare → bind → run/all/first/raw がすべて空を返す）。 */
function fakeDb() {
  const stmt: Record<string, unknown> = {
    bind: () => stmt,
    run: async () => ({ success: true, results: [], meta: {} }),
    all: async () => ({ success: true, results: [], meta: {} }),
    first: async () => null,
    raw: async () => [],
  }
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) }
}

const env = () => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeDb() }) as unknown as Bindings

async function list(query: string) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '学ぶ人', role: 'MEMBER' })
  return app.request(`/api/topics${query}`, { headers: { Authorization: `Bearer ${token}` } }, env())
}

/** 一覧を返さず、受け付けなかったこと（400 と {error} だけ）を示している。 */
async function expectRejected(query: string) {
  const res = await list(query)
  expect(res.status, `${query} が 400 にならない`).toBe(400)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), `${query} の応答が {error} だけでない`).toEqual(['error'])
  expect(body).not.toHaveProperty('topics')
}

async function expectAccepted(query: string) {
  const res = await list(query)
  expect(res.status, `${query}（決めた範囲の内側）が受け付けられない`).toBe(200)
  expect(await res.json()).toHaveProperty('topics')
}

describe('論点の一覧の受け付けない求め（GET /api/topics。UC-002）', () => {
  // @covers REQ-265#sort-outside-allowed
  it('決めた並べ替え（structure・recommended）以外の値は、一覧を返さず受け付けない', async () => {
    for (const sort of ['structure', 'recommended']) await expectAccepted(`?middleNo=12&sort=${sort}`)
    for (const sort of ['frequency', 'name', 'STRUCTURE', 'nonsense']) await expectRejected(`?middleNo=12&sort=${encodeURIComponent(sort)}`)
  })

  // @covers REQ-265#limit-above-max
  it('件数が上限 500 を超える求めは、一覧を返さず受け付けない（500 ちょうどは受け付ける）', async () => {
    await expectAccepted('?middleNo=12&limit=500')
    for (const limit of [501, 9999]) await expectRejected(`?middleNo=12&limit=${limit}`)
  })

  // @covers REQ-265#limit-below-min
  it('件数が下限 1 を下回る求めは、一覧を返さず受け付けない（1 ちょうどは受け付ける）', async () => {
    await expectAccepted('?middleNo=12&limit=1')
    for (const limit of [0, -1]) await expectRejected(`?middleNo=12&limit=${limit}`)
  })
})
