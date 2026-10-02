import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** 入力検証（400）だけを見る。保存された中身は scripts/check_api.py が本番相当で見る。
 *
 *  認証を通った要求はどれも「その日の来訪」を DB に書くので、バインディングが無いと
 *  経路に届く前に 500 になる。何も入っていない偽の D1 を渡して素通りさせ、
 *  入力検証の 400 と、検証を通ったときの 201 の差を見る。 */
const stmt: any = {
  bind: () => stmt,
  run: async () => ({ success: true, results: [], meta: {} }),
  all: async () => ({ success: true, results: [], meta: {} }),
  first: async () => null,
  raw: async () => [],
}
const fakeDb = {
  prepare: () => stmt,
  batch: async () => [],
  exec: async () => ({ count: 0, duration: 0 }),
}
const env = () => ({ EXAM: 'ip', JWT_SECRET: 'test-secret', DB: fakeDb }) as unknown as Bindings
const token = () => issueToken('test-secret', { id: 'u-1', name: '名', role: 'MEMBER' })

async function post(payload: unknown, auth = true) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = `Bearer ${await token()}`
  return app.request('/api/feedback', { method: 'POST', headers, body: JSON.stringify(payload) }, env())
}

/** 日本語が 1 文字も無い理由は、たいてい内部の例外がそのまま出ている。 */
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

describe('フィードバックの受け口の入力検証（UC-010）', () => {
  // @covers REQ-255#mutating-route-refused
  it('ログインしていない送信は 401', async () => {
    const res = await post({ body: '読みにくいです' }, false)
    expect(res.status).toBe(401)
    expect(await res.json()).toHaveProperty('error')
  })

  // @covers REQ-160#body-empty
  it('本文が無い・空・空白だけの送信は 400 と日本語の理由', async () => {
    for (const payload of [{}, { body: '' }, { body: '   ' }]) {
      const res = await post(payload)
      expect(res.status, `${JSON.stringify(payload)} が 400 で拒まれていない`).toBe(400)
      const data = (await res.json()) as { error?: string }
      expect(typeof data.error).toBe('string')
      expect(JAPANESE.test(data.error ?? ''), `理由が日本語でない: ${data.error}`).toBe(true)
    }
  })

  // @covers REQ-160#body-too-long
  it('本文が 2,000 字を超える送信は 400（2,000 字は入力検証を通る）', async () => {
    const over = await post({ body: 'あ'.repeat(2001) })
    expect(over.status).toBe(400)
    expect(JAPANESE.test(((await over.json()) as { error?: string }).error ?? '')).toBe(true)

    // 上限ちょうどは受け付ける（止めていたら「2,000 字以内」が送れない）
    const ok = await post({ body: 'あ'.repeat(2000) })
    expect(ok.status, '2,000 字が入力検証で拒まれている').toBe(201)
  })
})
