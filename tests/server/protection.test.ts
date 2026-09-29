import { sign } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** DB を束ねない環境。DB が要る処理まで進んだ呼び出しは例外になるので、
 *  「検証で断ったか（400）」と「処理に進んだか（400 でない）」を切り分けられる。 */
const env = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', JWT_SECRET: 'test-secret', ...over }) as Bindings
const SECRET = 'test-secret'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** 本人として通った要求は来訪の記録で D1 に書くので、そこまで進む経路には何も返さない偽の D1 を渡す。 */
type FakeStmt = {
  bind: (...a: unknown[]) => FakeStmt
  run: () => Promise<unknown>
  all: () => Promise<unknown>
  first: () => Promise<null>
  raw: () => Promise<unknown[]>
}
const fakeD1 = () => {
  const empty = { success: true, results: [], meta: {} }
  const stmt: FakeStmt = {
    bind: () => stmt,
    run: async () => empty,
    all: async () => empty,
    first: async () => null,
    raw: async () => [],
  }
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) } as unknown as D1Database
}

/** 認証が要る経路（/api のうち /api/auth/* と /api/health 以外）。 */
const PROTECTED: Array<[string, string]> = [
  ['GET', '/api/me'],
  ['GET', '/api/fields'],
  ['GET', '/api/categories'],
  ['GET', '/api/topics'],
  ['GET', '/api/topics/1'],
  ['PUT', '/api/topics/1/progress'],
  ['GET', '/api/glossary'],
  ['GET', '/api/exams'],
  ['GET', '/api/sessions'],
  ['POST', '/api/sessions'],
  ['GET', '/api/sessions/current'],
  ['DELETE', '/api/sessions/current'],
  ['POST', '/api/feedback'],
]

const call = (method: string, path: string, token?: string) =>
  app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}),
    },
    env(),
  )

const errorOf = async (res: Response) => {
  const body = (await res.json()) as { error?: unknown }
  expect(typeof body.error).toBe('string')
  const error = String(body.error)
  expect(error).toMatch(JAPANESE)
  return error
}

describe('認証の境界（保護された経路と公開の経路）', () => {
  // @verifies REQ-033
  it('保護された経路は、トークン無し・壊れたトークン・別の秘密・期限切れのどれでも 401 の {error}', async () => {
    const wrongSecret = await issueToken('other-secret', { id: 'u-1', name: '名', role: 'MEMBER' })
    const expired = await sign({ sub: 'u-1', name: '名', role: 'MEMBER', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, 'HS256')
    const tokens: Array<[string, string | undefined]> = [
      ['トークン無し', undefined],
      ['形になっていない', 'not-a-token'],
      ['署名が別の秘密', wrongSecret],
      ['期限切れ', expired],
    ]
    for (const [method, path] of PROTECTED) {
      for (const [label, token] of tokens) {
        const res = await call(method, path, token)
        expect(res.status, `${method} ${path}（${label}）`).toBe(401)
        await errorOf(res)
      }
    }
  })

  // @verifies REQ-033
  it('公開の経路（/api/health・/api/auth/config）はトークン無しで 200', async () => {
    for (const path of ['/api/health', '/api/auth/config']) {
      const res = await app.request(path, {}, env())
      expect(res.status, path).toBe(200)
    }
  })
})

describe('セキュリティヘッダ（公開・認証の要る経路の両方）', () => {
  // @verifies REQ-035
  it('公開の応答にも 401 の応答にも 5 つのヘッダが載る', async () => {
    for (const [method, path, token] of [['GET', '/api/health', undefined], ['GET', '/api/fields', undefined]] as const) {
      const res = await call(method, path, token)
      expect(res.headers.get('Content-Security-Policy'), path).toContain("default-src 'self'")
      expect(res.headers.get('Strict-Transport-Security'), path).toContain('max-age=')
      expect(res.headers.get('X-Frame-Options'), path).toBe('DENY')
      expect(res.headers.get('X-Content-Type-Options'), path).toBe('nosniff')
      expect(res.headers.get('Referrer-Policy'), path).toBe('strict-origin-when-cross-origin')
    }
  })
})

describe('本文のスキーマ検証', () => {
  // 400 で断ったもの＝処理に進んでいない（進めば DB が無い環境なので 400 にはならない）
  // @verifies REQ-089
  it('register は条件を満たさない本文を処理に進めず 400、満たす本文は進む', async () => {
    for (const body of [
      {},
      { email: 'not-an-email', password: 'password1', name: '名' },
      { email: 'a@example.com', password: 'short', name: '名' },
      { email: 'a@example.com', password: 'password1', name: '' },
    ]) {
      const res = await app.request('/api/auth/register', json(body), env())
      expect(res.status, JSON.stringify(body)).toBe(400)
      await errorOf(res)
    }
    const ok = await app.request('/api/auth/register', json({ email: 'a@example.com', password: 'password1', name: '名' }), env())
    expect(ok.status).not.toBe(400)
  })

  // @verifies REQ-090
  it('login は条件を満たさない本文を照合に進めず 400、満たす本文は進む', async () => {
    for (const body of [{}, { email: 'not-an-email', password: 'password1' }, { email: 'a@example.com', password: 'short' }]) {
      const res = await app.request('/api/auth/login', json(body), env())
      expect(res.status, JSON.stringify(body)).toBe(400)
      await errorOf(res)
    }
    const ok = await app.request('/api/auth/login', json({ email: 'a@example.com', password: 'password1' }), env())
    expect(ok.status).not.toBe(400)
  })

  // @verifies REQ-034
  it('検証に失敗した 400 の {error} は、どの項目が悪いか分かる日本語（英語のスキーマの文言を出さない）', async () => {
    const cases: Array<[unknown, RegExp | null]> = [
      [{ email: 'not-an-email', password: 'password1', name: '名' }, /メール/],
      [{ email: 'a@example.com', password: 'short', name: '名' }, /パスワード/],
      [{}, null],
    ]
    for (const [body, needle] of cases) {
      const res = await app.request('/api/auth/register', json(body), env())
      expect(res.status, JSON.stringify(body)).toBe(400)
      const error = await errorOf(res)
      if (needle) expect(error, JSON.stringify(body)).toMatch(needle)
      // zod の既定の文言がそのまま出ていない（日本語の文に例示のメールアドレスが入るのは可）
      expect(error, JSON.stringify(body)).not.toMatch(/Invalid|Required|String must|Expected|received/i)
    }
  })
})

describe('知らない経路と想定していない例外', () => {
  // @verifies REQ-091
  it('知らない /api の経路は 404 の {error}（本人として呼んでも同じ）', async () => {
    const token = await issueToken(SECRET, { id: 'u-1', name: '名', role: 'MEMBER' })
    // 本人として通る側は来訪の記録で D1 に書くので、偽の D1 を渡して 404 まで届かせる
    const mine = await app.request('/api/no-such-path', { headers: { Authorization: `Bearer ${token}` } }, env({ DB: fakeD1() }))
    expect(mine.status, '/api/no-such-path（本人）').toBe(404)
    await errorOf(mine)
    // 認証の要らない /api/auth/* 配下は未ログインでも 404
    const anon = await app.request('/api/auth/no-such-path', {}, env())
    expect(anon.status, '/api/auth/no-such-path').toBe(404)
    await errorOf(anon)
  })

  // @verifies REQ-092
  it('想定していない例外は固定文の 500 で、例外の内容や呼び出しの履歴を本文に出さない', async () => {
    const token = await issueToken(SECRET, { id: 'u-1', name: '名', role: 'MEMBER' })
    // 本人としては通るが、DB を束ねていない環境なので処理の途中で例外になる（例外を起こす名前付きの口は無い）
    const res = await call('GET', '/api/fields', token)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toMatch(/TypeError|Cannot read|\bat \b|stack|D1|drizzle/i)
    const body = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['error'])
    expect(String(body.error)).toMatch(JAPANESE)
  })
})
