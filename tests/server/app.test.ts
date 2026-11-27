import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** DB を触らない経路だけを叩く（DB が要る経路は scripts/check_api.py が本番相当で見る）。 */
const env = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', JWT_SECRET: 'test-secret', ...over }) as Bindings
const sso = () => env({ SSO_PORTAL_URL: 'https://portal.example', SSO_SECRET: 'shared' })
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('認証の境界（UC-015・UC-017）', () => {
  // @covers REQ-223#learning-protected-refused
  it('トークンが無いと保護された経路は 401', async () => {
    const res = await app.request('/api/fields', {}, env())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'ログインが必要です', code: 'UNAUTHENTICATED' })
  })

  // @covers REQ-255#credential-malformed
  it('壊れたトークン・別の秘密で署名したトークンは 401', async () => {
    for (const token of ['not-a-token', 'Bearer', await issueToken('other-secret', { id: 'u-1', name: '名', role: 'MEMBER' })]) {
      const res = await app.request('/api/sessions', { headers: { Authorization: `Bearer ${token}` } }, env())
      expect(res.status).toBe(401)
    }
  })

  // @covers REQ-213#learning-alive
  it('/api/health は認証なしで通る', async () => {
    const res = await app.request('/api/health', {}, env())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('セキュリティヘッダ（UC-017）', () => {
  // @covers REQ-259#headers-on-public
  it('応答に CSP・HSTS・X-Frame-Options・nosniff・Referrer-Policy が付く', async () => {
    const res = await app.request('/api/health', {}, env())
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })
})

describe('SSO の環境（まなびばが認証の正本。UC-013）', () => {
  // @covers REQ-205#config-shape
  it('config は sso・portal・app だけを返し、秘密の有無（secretSet）を出さない', async () => {
    const res = await app.request('/api/auth/config', {}, sso())
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['app', 'portal', 'sso'])
    expect(body).not.toHaveProperty('secretSet')
    expect(body.sso).toBe(true)
    expect(body.portal).toBe('https://portal.example')
    expect(typeof body.app).toBe('string')
    expect(body.app).not.toBe('')
  })
})

describe('失敗の形（UC-013・UC-017）', () => {
  // @covers REQ-193#malformed-code
  it('/api/auth/sso は壊れた入力を 400 の {error} で返す', async () => {
    for (const init of [json({}), json({ code: 12 }), { method: 'POST', body: 'not json' }]) {
      const res = await app.request('/api/auth/sso', init, sso())
      expect(res.status).toBe(400)
      // 契約が決めるのは ErrorBody の形だけ（文言の語は REQ-257 が検証しないと置く）
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(['code', 'error'])
      expect(typeof body.error).toBe('string')
      expect(String(body.error).trim()).not.toBe('')
      expect(String(body.error)).toMatch(/[ぁ-んァ-ヶ一-龥]/)
    }
  })

  // @covers REQ-256#unknown-path-anonymous
  it('受け持たない /api の経路は、本人と分からない要求にも 404 の {error}（認証の前置きの 401 に変わらない）', async () => {
    const res = await app.request('/api/no-such-path', {}, sso())
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['code', 'error'])
    expect(String(body.error)).toMatch(/[ぁ-んァ-ヶ一-龥]/)
  })
})

describe('SSO のコード交換（学び側。UC-013）', () => {
  // @covers REQ-206#secret-missing-refused
  it('共有秘密が無い環境では 503 の {error} で止まり、まなびばに問い合わせずトークンも渡さない', async () => {
    const orig = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls += 1; throw new TypeError('fetch failed') }) as typeof fetch
    try {
      const res = await app.request('/api/auth/sso', json({ code: 'abc' }), env({ SSO_PORTAL_URL: 'https://portal.example' }))
      expect(res.status).toBe(503)
      const body = (await res.json()) as Record<string, unknown>
      // 足りない設定を名指ししない（BR-002）。本文が等しいことは signing_secret.test.ts が見る
      expect(Object.keys(body).sort()).toEqual(['code', 'error'])
      const error = String(body.error)
      expect(error).toMatch(/[ぁ-んァ-ヶ一-龥]/)
      expect(error.trim().split('\n')).toHaveLength(1)
      expect(calls, 'まなびばへの呼び出し').toBe(0)
    } finally {
      globalThis.fetch = orig
    }
  })

  // @covers REQ-208#portal-unreachable
  it('まなびばに繋がらないときは 502 の {error}', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    try {
      const res = await app.request('/api/auth/sso', json({ code: 'abc' }), sso())
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: string }).error).toContain('まなびば')
    } finally {
      globalThis.fetch = orig
    }
  })

  // @covers REQ-193#exchange-refused
  it('まなびばがコードを拒んだら 401 で、その理由をそのまま返す', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'コードが無効です', code: 'UNAUTHENTICATED' }), { status: 401 })) as typeof fetch
    try {
      const res = await app.request('/api/auth/sso', json({ code: 'used' }), sso())
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'コードが無効です', code: 'UNAUTHENTICATED' })
    } finally {
      globalThis.fetch = orig
    }
  })
})
