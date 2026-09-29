/** 学習の一覧・論点・用語集の API（src/server/routes/catalog.ts）のうち、DB の中身に依らない経路。
 *
 *  件数や並びは実データが要るので scripts/check_api.py が本番相当で見る。ここでは
 *  入力の受け付け（決めた値の外は記録しない）と、ログインしていない人に返さないことだけ。
 *  認証を通った要求は来訪の記録で D1 を触るので、何も返さない偽の D1 を渡す。 */

import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'

/** 何も入っていない D1（prepare → bind → run/all/first がすべて空を返す）。 */
function fakeDb() {
  const stmt: Record<string, unknown> = {
    bind: () => stmt,
    run: async () => ({ success: true, results: [], meta: {} }),
    all: async () => ({ success: true, results: [], meta: {} }),
    first: async () => null,
    raw: async () => [],
  }
  return {
    prepare: () => stmt,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  }
}

const env = () => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeDb() } as unknown as Bindings)

async function headers() {
  const token = await issueToken(SECRET, { id: 'u-1', name: '学ぶ人', role: 'MEMBER' })
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

describe('理解度の記録（PUT /api/topics/:id/progress）', () => {
  // @verifies REQ-013
  it('3 段階（1・2・3）の外の値は 400 で記録しない', async () => {
    const h = await headers()
    for (const body of [{ status: 0 }, { status: 4 }, { status: -1 }, { status: 'りかい' }, {}]) {
      const res = await app.request(
        '/api/topics/1/progress',
        { method: 'PUT', headers: h, body: JSON.stringify(body) },
        env(),
      )
      expect(res.status, `本文 ${JSON.stringify(body)} が 400 にならない`).toBe(400)
      expect(await res.json()).toHaveProperty('error')
    }
  })
})

describe('論点の一覧（GET /api/topics）', () => {
  // @verifies REQ-011
  it('並べ替えと件数の上限は決めた値だけを受ける', async () => {
    const h = await headers()
    for (const query of ['?sort=nonsense', '?limit=9999']) {
      const res = await app.request(`/api/topics${query}`, { headers: h }, env())
      expect(res.status, `${query} が 400 にならない`).toBe(400)
      expect(await res.json()).toHaveProperty('error')
    }
  })
})

describe('用語集（GET /api/glossary）', () => {
  // @verifies REQ-137
  it('ログインしていない人には返さない', async () => {
    const res = await app.request('/api/glossary', {}, env())
    expect(res.status).toBe(401)
    expect(await res.json()).toHaveProperty('error')

    const bad = await app.request(
      '/api/glossary',
      { headers: { Authorization: 'Bearer not-a-token' } },
      env(),
    )
    expect(bad.status).toBe(401)
  })
})
