import { describe, expect, it } from 'vitest'
import app from '../../portal/src/index'

/**
 * まなびばの想定していない例外の扱い（要件 §10 のエラー処理）。
 *
 * D1 を壊した env（prepare などが必ず投げる偽の D1）で DB を引く経路を呼び、
 * 応答が 500・本文が固定の日本語の {error} だけであることを見る。
 * 例外の message（boom）・stack・コードの場所が本文に出たら情報漏洩。
 */

const BOOM = 'boom'

/** どのメソッドでも例外を投げる偽の D1（drizzle 経由でも生の prepare でも同じ例外になる）。 */
const brokenDb = () => {
  const boom = () => {
    throw new Error(BOOM)
  }
  return { prepare: boom, batch: boom, exec: boom, dump: boom } as unknown as D1Database
}

/** 静的ファイルの束縛。この検査では使われないので固定の応答を返すだけ。 */
const assets = { fetch: async () => new Response('') }

const env = () =>
  ({ DB: brokenDb(), ASSETS: assets, SSO_SECRET: 'shared' }) as unknown as Parameters<typeof app.request>[2]

const login = (email: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'portal-pass-1234' }),
})

/** 本文が {error: 文字列} なら、その文を返す（他の鍵があれば失敗させる）。 */
const errorText = async (res: Response) => {
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), '5xx の本文に error 以外の鍵がある（内部の情報を出さない）').toEqual(['error'])
  expect(typeof body.error).toBe('string')
  return body.error as string
}

describe('想定していない例外（まなびば）', () => {
  // @verifies REQ-301
  it('DB が壊れている呼び出しは 500 で、本文は固定の日本語の {error} だけ（例外の message も stack も出さない）', async () => {
    const res = await app.request('/api/login', login('portal-onerror@example.com'), env())
    expect(res.status, '想定していない例外が 500 になっていない').toBe(500)
    const text = await errorText(res)
    expect(text, 'error が空').not.toBe('')
    expect(text, 'error が日本語でない').toMatch(/[ぁ-んァ-ヶ一-龥]/)
    expect(text, '例外の message が本文に出ている').not.toContain(BOOM)
    expect(text, '例外の種類が本文に出ている').not.toContain('Error')
    expect(text, 'stack が本文に出ている').not.toMatch(/stack|\bat \S+|\.ts:\d+/i)
    expect(text, '固定の 1 文でない（改行がある）').not.toContain('\n')
  })

  // @verifies REQ-301
  it('呼び出しの入力が違っても 5xx の文言は同じ（固定の文で、入力や内部の状態を映さない）', async () => {
    const first = await errorText(await app.request('/api/login', login('portal-onerror-a@example.com'), env()))
    const second = await errorText(await app.request('/api/login', login('portal-onerror-b@example.com'), env()))
    expect(second, '呼び出しごとに 5xx の文言が変わる（固定の文でない）').toBe(first)
  })

  // @verifies REQ-301
  it('DB を引かない /api/health は同じ env でも 200（500 になるのは例外が起きた呼び出しだけ）', async () => {
    const res = await app.request('/api/health', {}, env())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
