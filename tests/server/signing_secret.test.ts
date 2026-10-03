import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'

/** 署名の秘密を与えていない配備（JWT_SECRET を束ねない）。DB も束ねないので、
 *  断らずに処理へ進んだ呼び出しは 503 にならない（断ったか進んだかを切り分けられる）。 */
const noSecret = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', ...over }) as Bindings
/** 署名の秘密を与えている配備。 */
const withSecret = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', JWT_SECRET: 'test-secret', ...over }) as Bindings
/** まなびばの場所と共有秘密がそろっている配備の設定。 */
const PORTAL = { SSO_PORTAL_URL: 'https://portal.example', SSO_SECRET: 'shared' }

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

/** 契約の examples の値（UC-013 signInWithCode・signInWithPassword・register）。 */
const CODE = '3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40'
const CREDENTIAL = { email: 'yudai@example.com', password: 'harunokaze8' }
const TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0ZDJiOGExMCIsIm5hbWUiOiJ0YXJvIiwicm9sZSI6Ik1FTUJFUiIsImV4cCI6MTc5OTk5OTk5OX0.c2lnbmF0dXJlLXNhbXBsZQ'

/** 配備に設定が無いことに当たる断り（NOT_CONFIGURED の 503 と _shared の ErrorBody。文言そのものは見ない）。 */
const expectNotConfigured = async (res: Response, label: string): Promise<string> => {
  expect(res.status, label).toBe(503)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), label).toEqual(['error'])
  const error = String(body.error)
  expect(error, label).toMatch(JAPANESE)
  expect(error.trim().split('\n'), label).toHaveLength(1)
  return error
}

/** まなびばへの呼び出しをこのテストの中だけ偽に差し替え、呼ばれた回数を数える。 */
const withFetchCounter = async (body: (calls: { count: number }) => Promise<void>) => {
  const calls = { count: 0 }
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    calls.count += 1
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    await body(calls)
  } finally {
    globalThis.fetch = orig
  }
}

describe('署名の秘密が無い配備ではトークンを発行しない（UC-013）', () => {
  // @covers REQ-274#exchange-refused
  it('使い捨てコードの交換は、まなびばの場所や共有秘密の有無に関わらず断られ、まなびばを呼ばない', async () => {
    await withFetchCounter(async (calls) => {
      const deployments: Array<[string, Bindings]> = [
        ['まなびばの場所と共有秘密がそろう配備', noSecret(PORTAL)],
        ['まなびばの場所が無い配備', noSecret()],
        ['まなびばの場所はあるが共有秘密が無い配備', noSecret({ SSO_PORTAL_URL: PORTAL.SSO_PORTAL_URL })],
      ]
      for (const [label, env] of deployments) {
        await expectNotConfigured(await app.request('/api/auth/sso', json({ code: CODE }), env), label)
      }
      // 形を満たさない code より先に断る（契約の errors の並びが評価の順）
      await expectNotConfigured(await app.request('/api/auth/sso', json({ code: '' }), noSecret(PORTAL)), 'code が空')
      expect(calls.count, 'まなびばへの呼び出し').toBe(0)
    })
  })

  // @covers REQ-274#password-login-refused
  it('学び側のパスワードでのログインは、まなびばの場所の有無に関わらず断られる', async () => {
    const cases: Array<[string, Bindings, unknown]> = [
      ['まなびばの場所がある配備', noSecret(PORTAL), CREDENTIAL],
      ['まなびばの場所が無い配備', noSecret(), CREDENTIAL],
      ['形を満たさない本文', noSecret(), { email: CREDENTIAL.email, password: 'mijikai' }],
    ]
    for (const [label, env, body] of cases) {
      await expectNotConfigured(await app.request('/api/auth/login', json(body), env), label)
    }
  })

  // @covers REQ-274#register-refused
  it('学び側の登録は、まなびばの場所の有無に関わらず断られる', async () => {
    const account = { ...CREDENTIAL, name: '山田 太郎' }
    const cases: Array<[string, Bindings, unknown]> = [
      ['まなびばの場所がある配備', noSecret(PORTAL), account],
      ['まなびばの場所が無い配備', noSecret(), account],
      ['形を満たさない本文', noSecret(), { ...account, name: '' }],
      ['合言葉を添えた本文', noSecret(), { ...account, signupCode: 'aikotoba' }],
    ]
    for (const [label, env, body] of cases) {
      await expectNotConfigured(await app.request('/api/auth/register', json(body), env), label)
    }
  })

  // @covers REQ-274#signing-secret-present-not-refused
  it('署名の秘密がある配備では、発行の 3 つの経路は設定の不足で止まらず、自分の入力の検証まで届く', async () => {
    await withFetchCounter(async () => {
      // 形を満たさない本文を渡し、その経路自身の検証による断り（INVALID_INPUT・400）に達することで
      // 設定の不足で止まっていないことを見る
      const cases: Array<[string, Bindings, unknown]> = [
        ['/api/auth/sso', withSecret(PORTAL), { code: '' }],
        ['/api/auth/login', withSecret(), { email: CREDENTIAL.email, password: 'mijikai' }],
        ['/api/auth/register', withSecret(), { ...CREDENTIAL, name: '' }],
      ]
      for (const [path, env, body] of cases) {
        const res = await app.request(path, json(body), env)
        expect(res.status, path).toBe(400)
      }
    })
  })
})

describe('署名の秘密が無い配備では添えられたトークンを読まない（UC-017）', () => {
  /** 認証を要する経路の一覧の正本はサーバの経路の定義（BR-001）。ここは読みと変更の代表を取る。 */
  const AUTH_REQUIRED: Array<[string, string]> = [
    ['GET', '/api/me'],
    ['GET', '/api/fields'],
    ['POST', '/api/sessions'],
    ['PUT', '/api/topics/1/progress'],
  ]

  const call = (method: string, path: string, token?: string) =>
    app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
        ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}),
      },
      noSecret(),
    )

  // @covers REQ-275#token-present-refused
  it('トークンを添えた要求も、読まれずに断られる（応答も変更も無い＝保存先に進んでいない）', async () => {
    // 署名の秘密が無い配備では、形になっているものも、なっていないものも区別できない
    for (const token of [TOKEN, 'not-a-token']) {
      for (const [method, path] of AUTH_REQUIRED) {
        await expectNotConfigured(await call(method, path, token), `${method} ${path}（${token.slice(0, 12)}…）`)
      }
    }
  })

  // @covers REQ-275#token-absent-refused
  it('トークンを添えない要求も、添えたときと同じ形で断られる', async () => {
    for (const [method, path] of AUTH_REQUIRED) {
      await expectNotConfigured(await call(method, path), `${method} ${path}`)
    }
  })

  // @covers REQ-275#public-route-not-refused
  it('認証を要さない死活確認は、署名の秘密が無い配備でも断られない', async () => {
    const res = await app.request('/api/health', {}, noSecret())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // @covers REQ-275#public-route-not-refused
  it('認証を要さないログインの形の問い合わせ（getAuthConfig）も、署名の秘密が無い配備でも断られない', async () => {
    const res = await app.request('/api/auth/config', {}, noSecret())
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['app', 'portal', 'sso'])
  })
})

describe('設定が無いことによる断りは足りない秘密で変わらない（UC-013）', () => {
  // @covers REQ-206#same-text-as-other-not-configured
  it('同じ断り（503）を返す 2 つの配備は、足りない秘密が違っても本文が等しい', async () => {
    await withFetchCounter(async (calls) => {
      const code = json({ code: CODE })
      const noSigning = await expectNotConfigured(
        await app.request('/api/auth/sso', code, noSecret(PORTAL)),
        '署名の秘密が無い配備',
      )
      const noShared = await expectNotConfigured(
        await app.request('/api/auth/sso', code, withSecret({ SSO_PORTAL_URL: PORTAL.SSO_PORTAL_URL })),
        'まなびばの場所はあるが共有秘密が無い配備',
      )
      expect(noShared, '足りない秘密で本文が変わらない（BR-002）').toBe(noSigning)
      expect(calls.count, 'まなびばへの呼び出し').toBe(0)
    })
  })
})

describe('受け持たない /api の経路は設定の不足では断らない（UC-017）', () => {
  // @covers REQ-256#unknown-path-no-signing-secret
  it('署名の秘密が無い配備でも、受け持たない経路の断りは見つからないこと（本人として呼んでも同じ）', async () => {
    for (const [label, headers] of [
      ['匿名', {}],
      ['本人として', { Authorization: `Bearer ${TOKEN}` }],
    ] as Array<[string, Record<string, string>]>) {
      const res = await app.request('/api/no-such-path', { headers }, noSecret())
      expect(res.status, label).toBe(404)
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body), label).toEqual(['error'])
      expect(String(body.error), label).toMatch(JAPANESE)
    }
  })
})
