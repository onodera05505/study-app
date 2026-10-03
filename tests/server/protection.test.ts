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

/** /api の具体の経路の一覧を、サーバが登録した経路の表から導く（一覧の正本はサーバの経路の定義。
 *  BR-001・R-102）。手書きの一覧は経路を足したときに取り残され、守りの漏れを検査が見逃す。
 *  前置き（ヘッダ・認証）は `*` を含む経路で登録されるので、それを除いたものが具体の経路。 */
const API_ROUTES: Array<[string, string]> = [
  ...new Map(
    app.routes
      .filter((route) => route.path.startsWith('/api/') && !route.path.includes('*'))
      .map((route) => [`${route.method} ${route.path}`, [route.method, route.path] as [string, string]]),
  ).values(),
]

/** 認証を要さない経路は、死活確認と /api/auth/* （ログインの形の問い合わせと発行）だけ。残りは認証が要る。 */
const isPublic = (path: string) => path === '/api/health' || path.startsWith('/api/auth/')
const AUTH_REQUIRED = API_ROUTES.filter(([, path]) => !isPublic(path))
const PUBLIC_ROUTES = API_ROUTES.filter(([, path]) => isPublic(path))
const label = ([method, path]: [string, string]) => `${method} ${path}`

/** 導いた一覧が空・片側だけ、になっていないことの確認。これを欠くと経路が 1 本も無くても緑になる。 */
const expectRoutesDerived = () => {
  expect(AUTH_REQUIRED.length, '経路の表から導いた認証の要る経路が 17 本を下回る').toBeGreaterThanOrEqual(17)
  expect(PUBLIC_ROUTES.map(label).sort(), '認証を要さない経路').toEqual([
    'GET /api/auth/config',
    'GET /api/health',
    'POST /api/auth/login',
    'POST /api/auth/register',
    'POST /api/auth/sso',
  ])
  // 手書きの一覧に入っていなかった :id 付きの経路も導けている
  expect(AUTH_REQUIRED.map(label)).toContain('GET /api/sessions/:id/current')
  expect(AUTH_REQUIRED.map(label)).toContain('POST /api/sessions/:id/answer')
  expect(AUTH_REQUIRED.map(label)).toContain('POST /api/sessions/:id/finish')
  expect(AUTH_REQUIRED.map(label)).toContain('GET /api/sessions/:id')
}

const call = (method: string, path: string, token?: string) =>
  app.request(
    path.replace(/:\w+/g, '1'),
    {
      method,
      headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}),
    },
    env(),
  )

/** 失敗の本文は契約の ErrorBody（`{ error }` だけ）。文言そのものは照合しない。 */
const errorOf = async (res: Response) => {
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body)).toEqual(['error'])
  const error = String(body.error)
  expect(error).toMatch(JAPANESE)
  return error
}

describe('認証の境界（保護された経路と公開の経路）', () => {
  // @covers REQ-255#credential-absent
  it('認証の要る経路は、経路の表から導いた全件が、トークン無し・壊れたトークン・別の秘密・期限切れのどれでも 401 の {error}', async () => {
    expectRoutesDerived()
    const wrongSecret = await issueToken('other-secret', { id: 'u-1', name: '名', role: 'MEMBER' })
    const expired = await sign({ sub: 'u-1', name: '名', role: 'MEMBER', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, 'HS256')
    const tokens: Array<[string, string | undefined]> = [
      ['トークン無し', undefined],
      ['形になっていない', 'not-a-token'],
      ['署名が別の秘密', wrongSecret],
      ['期限切れ', expired],
    ]
    for (const route of AUTH_REQUIRED) {
      for (const [kind, token] of tokens) {
        const res = await call(route[0], route[1], token)
        expect(res.status, `${label(route)}（${kind}）`).toBe(401)
        await errorOf(res)
      }
    }
  })

  // @covers REQ-255#public-route-not-refused
  it('認証を要さない経路は、トークン無しでも認証では断られない（死活確認とログインの形は 200）', async () => {
    expectRoutesDerived()
    for (const route of PUBLIC_ROUTES) {
      const res = await call(route[0], route[1])
      expect(res.status, `${label(route)}（認証で断られている）`).not.toBe(401)
    }
    for (const path of ['/api/health', '/api/auth/config']) {
      const res = await app.request(path, {}, env())
      expect(res.status, path).toBe(200)
    }
  })
})

describe('セキュリティヘッダ（公開・認証の要る経路の両方）', () => {
  // @covers REQ-259#headers-on-refusal
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

  it('login は条件を満たさない本文を照合に進めず 400、満たす本文は進む', async () => {
    for (const body of [{}, { email: 'not-an-email', password: 'password1' }, { email: 'a@example.com', password: 'short' }]) {
      const res = await app.request('/api/auth/login', json(body), env())
      expect(res.status, JSON.stringify(body)).toBe(400)
      await errorOf(res)
    }
    const ok = await app.request('/api/auth/login', json({ email: 'a@example.com', password: 'password1' }), env())
    expect(ok.status).not.toBe(400)
  })

  // @covers REQ-257#reason-names-the-field
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
  // @covers REQ-256#unknown-path-authenticated
  it('知らない /api の経路は 404 の {error}（本人として呼んでも同じ）', async () => {
    const token = await issueToken(SECRET, { id: 'u-1', name: '名', role: 'MEMBER' })
    const mine = await app.request('/api/no-such-path', { headers: { Authorization: `Bearer ${token}` } }, env())
    expect(mine.status, '/api/no-such-path（本人）').toBe(404)
    await errorOf(mine)
    // 認証の要らない /api/auth/* 配下は未ログインでも 404
    const anon = await app.request('/api/auth/no-such-path', {}, env())
    expect(anon.status, '/api/auth/no-such-path').toBe(404)
    await errorOf(anon)
  })

  // @covers REQ-258#learning-internal-fixed
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
