import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** 入力の検証（出題を組む前に弾く所）だけを叩く。
 *  出題の中身（進行中が既にある 409・範囲に過去問が無い 400）は本物のデータが要るので
 *  scripts/check_api.py が本番相当で見る。
 *
 *  認証を通った要求は来訪を D1 に書くので、空を返す偽の D1 を渡して経路まで届かせる。 */
type FakeStmt = {
  bind: () => FakeStmt
  run: () => Promise<unknown>
  all: () => Promise<unknown>
  first: () => Promise<unknown>
  raw: () => Promise<unknown[]>
}
const stmt: FakeStmt = {
  bind: () => stmt,
  run: async () => ({ success: true, results: [], meta: {} }),
  all: async () => ({ success: true, results: [], meta: {} }),
  first: async () => null,
  raw: async () => [],
}
const fakeDb = { prepare: () => stmt, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) }

const SECRET = 'test-secret'
const env = () => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeDb } as unknown as Bindings)

async function post(path: string, body: unknown) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env(),
  )
}

const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

describe('POST /api/sessions の入力の検証', () => {
  // @verifies REQ-193
  it('問題数が 1 未満・100 超なら 400 の {error}', async () => {
    for (const size of [0, -1, 101, 1000]) {
      const res = await post('/api/sessions', { kind: 'field', field: 'テクノロジ系', size })
      expect(res.status, `size=${size} が通ってしまう`).toBe(400)
      const body = (await res.json()) as { error?: string }
      expect(typeof body.error).toBe('string')
      expect(JAPANESE.test(body.error ?? '')).toBe(true)
    }
  })

  // @verifies REQ-193
  it('範囲内の問題数（1・100）は問題数の検証で弾かない', async () => {
    const rejected = await (await post('/api/sessions', { kind: 'field', field: 'テクノロジ系', size: 0 })).json()
    for (const size of [1, 100]) {
      const res = await post('/api/sessions', { kind: 'field', field: 'テクノロジ系', size })
      // 範囲内なので「問題数が範囲外」では弾かれない（弾かれるとしても別の理由）
      expect(await res.json(), `size=${size} が範囲外と同じ理由で弾かれる`).not.toEqual(rejected)
    }
  })

  // @verifies REQ-193
  it('種別が無い・知らない種別・問題数が数でないときは 400', async () => {
    for (const body of [{}, { kind: 'nope' }, { kind: 'field', field: 'テクノロジ系', size: '20' }]) {
      const res = await post('/api/sessions', body)
      expect(res.status, `${JSON.stringify(body)} が通ってしまう`).toBe(400)
      expect(await res.json()).toHaveProperty('error')
    }
  })

  // @verifies REQ-193
  it('種別に対応する範囲（論点・分野・カテゴリ）が無いときは 400', async () => {
    for (const body of [{ kind: 'drill' }, { kind: 'field' }, { kind: 'middle' }]) {
      const res = await post('/api/sessions', body)
      expect(res.status, `${JSON.stringify(body)} が範囲なしで通ってしまう`).toBe(400)
      expect(await res.json()).toHaveProperty('error')
    }
  })
})
