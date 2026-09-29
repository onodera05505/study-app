import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** DB を触らない経路だけを叩く（DB が要る経路は scripts/check_api.py が本番相当で見る）。 */
const env = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', JWT_SECRET: 'test-secret', ...over }) as Bindings
const sso = () => env({ SSO_PORTAL_URL: 'https://portal.example', SSO_SECRET: 'shared' })
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('認証の境界', () => {
  // @verifies REQ-033
  it('トークンが無いと保護された経路は 401', async () => {
    const res = await app.request('/api/fields', {}, env())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'ログインが必要です' })
  })

  // @verifies REQ-033
  it('壊れたトークン・別の秘密で署名したトークンは 401', async () => {
    for (const token of ['not-a-token', 'Bearer', await issueToken('other-secret', { id: 'u-1', name: '名', role: 'MEMBER' })]) {
      const res = await app.request('/api/sessions', { headers: { Authorization: `Bearer ${token}` } }, env())
      expect(res.status).toBe(401)
    }
  })

  // @verifies REQ-033, REQ-047
  it('/api/health は認証なしで通る', async () => {
    const res = await app.request('/api/health', {}, env())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('セキュリティヘッダ', () => {
  // @verifies REQ-035
  it('応答に CSP・HSTS・X-Frame-Options・nosniff・Referrer-Policy が付く', async () => {
    const res = await app.request('/api/health', {}, env())
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })
})

describe('SSO の環境（まなびばが認証の正本）', () => {
  // @verifies REQ-005
  it('register と login は 404', async () => {
    for (const path of ['/api/auth/register', '/api/auth/login']) {
      const res = await app.request(path, json({ email: 'a@example.com', password: 'password1', name: '名' }), sso())
      expect(res.status).toBe(404)
      expect(await res.json()).toHaveProperty('error')
    }
  })

  // @verifies REQ-005
  it('config は sso・portal・app だけを返し、secretSet を出さない', async () => {
    const res = await app.request('/api/auth/config', {}, sso())
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['app', 'portal', 'sso'])
    expect(body.sso).toBe(true)
    expect(body.portal).toBe('https://portal.example')
  })
})

describe('失敗の形', () => {
  // @verifies REQ-034
  it('/api/auth/sso は壊れた入力を 400 の {error} で返す', async () => {
    for (const init of [json({}), json({ code: 12 }), { method: 'POST', body: 'not json' }]) {
      const res = await app.request('/api/auth/sso', init, sso())
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: '入力が正しくありません' })
    }
  })

  // @verifies REQ-034
  it('未知の API の経路は 404 の {error}', async () => {
    const res = await app.request('/api/auth/no-such-path', {}, sso())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '見つかりません' })
  })
})

describe('SSO のコード交換（学び側）', () => {
  // @verifies REQ-004
  it('共有秘密が無い環境では 503 で止まり、まなびばに問い合わせない', async () => {
    const res = await app.request('/api/auth/sso', json({ code: 'abc' }), env({ SSO_PORTAL_URL: 'https://portal.example' }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('共有秘密')
  })

  // @verifies REQ-004
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

  // @verifies REQ-004
  it('まなびばがコードを拒んだら 401 で、その理由をそのまま返す', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'コードが無効です' }), { status: 401 })) as typeof fetch
    try {
      const res = await app.request('/api/auth/sso', json({ code: 'used' }), sso())
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'コードが無効です' })
    } finally {
      globalThis.fetch = orig
    }
  })
})
