import { sign } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import { learningD1, sqliteOf } from '../portal/repay_UC-014_sqlite_d1'

/**
 * UC-017 学びとまなびばの要求の受け口を一様に守る（学び側。REQ-255・257・259・260）。
 *
 * 叩くのは契約の操作の入口だけ（認証を要する取得＝UC-002 の GET /api/fields、認証を要する変更＝
 * UC-004 startSession の POST /api/sessions、認証を要さない発行＝UC-013 signInWithCode の POST /api/auth/sso、
 * 死活確認＝UC-015 の GET /api/health）。
 *
 * 保存先は 3 通りに使い分ける。
 * - 束ねない env: 断らずに処理へ進んだ呼び出しは保存先が無くて例外になるので、「断ったか」「進んだか」を切り分けられる
 * - 何も入っていない偽の D1: 認証を通った要求は来訪を保存先に書くので、本文の形の検査まで届かせるのに要る
 * - メモリの SQLite（repay_UC-014_sqlite_d1）: 本人として通った 200 の応答を得るのに要る
 */

const SECRET = 'test-secret'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/
const PORTAL = { SSO_PORTAL_URL: 'https://portal.example', SSO_SECRET: 'shared' }

/** 保存先を束ねない配備。 */
const noStore = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', JWT_SECRET: SECRET, ...over }) as Bindings

/** 何を聞かれても空を返す偽の D1。認証を通った要求を本文の検査まで届かせるためだけに置く。 */
const passiveStore = (): D1Database => {
  const stmt: any = {
    bind: () => stmt,
    run: async () => ({ success: true, results: [], meta: {} }),
    all: async () => ({ success: true, results: [], meta: {} }),
    first: async () => null,
    raw: async () => [],
  }
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) } as unknown as D1Database
}

/** どのメソッドでも例外を投げる偽の D1（配備に結びついてはいるが壊れている保存先）。 */
const brokenStore = (): D1Database => {
  const boom = () => {
    throw new Error('boom')
  }
  return { prepare: boom, batch: boom, exec: boom, dump: boom } as unknown as D1Database
}

const memberToken = (secret = SECRET) => issueToken(secret, { id: 'u-1', name: '名', role: 'MEMBER' })

const init = (method: string, body?: unknown, token?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
})

/** 失敗の本文は _shared の ErrorBody（`{ error }` だけ・日本語）。文言そのものは照合しない。 */
const errorOf = async (res: Response, label: string) => {
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), `${label}: 本文が {error} だけでない`).toEqual(['error'])
  const error = String(body.error)
  expect(error, `${label}: 理由が日本語でない`).toMatch(JAPANESE)
  return error
}

const expectRefused = async (res: Response, status: number, label: string) => {
  expect(res.status, label).toBe(status)
  return errorOf(res, label)
}

/** NFR-001 の 5 つのセキュリティヘッダがすべて載っている。 */
const expectSecurityHeaders = (res: Response, label: string) => {
  expect(res.headers.get('Content-Security-Policy'), `${label}: CSP`).toContain('default-src')
  expect(res.headers.get('Strict-Transport-Security'), `${label}: HSTS`).toContain('max-age=')
  expect(res.headers.get('X-Frame-Options'), `${label}: X-Frame-Options`).toBe('DENY')
  expect(res.headers.get('X-Content-Type-Options'), `${label}: nosniff`).toBe('nosniff')
  expect(res.headers.get('Referrer-Policy'), `${label}: Referrer-Policy`).toBeTruthy()
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

/** 契約 startSession の request を満たさない本文を、満たさない理由ごとに。 */
const START_SESSION_BODIES = {
  fieldMissing: [{}, { kind: 'drill' }, { kind: 'field' }, { kind: 'middle' }],
  wrongType: [{ kind: 12 }, { kind: 'drill', topicId: '1' }, { kind: 'field', field: 3 }, { kind: 'review', size: '10' }],
  outOfRange: [{ kind: 'zzz' }, { kind: 'drill', topicId: 0 }, { kind: 'field', field: '' }, { kind: 'review', size: 0 }, { kind: 'review', size: 101 }],
}

describe('UC-017 要求の受け口（学び側）', () => {
  describe('REQ-255 通るトークンが無い要求の断り', () => {
    // @covers REQ-255#credential-wrong-secret
    it('別の秘密で署名されたトークンは、取得の経路でも変更の経路でも 401 の {error}', async () => {
      const token = await memberToken('other-secret')
      await expectRefused(await app.request('/api/fields', init('GET', undefined, token), noStore()), 401, 'GET /api/fields')
      await expectRefused(await app.request('/api/sessions', init('POST', { kind: 'review' }, token), noStore()), 401, 'POST /api/sessions')
    })

    // @covers REQ-255#credential-expired
    it('期限が過ぎたトークンは、同じ秘密で署名されていても 401 の {error}', async () => {
      const expired = await sign({ sub: 'u-1', name: '名', role: 'MEMBER', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, 'HS256')
      await expectRefused(await app.request('/api/fields', init('GET', undefined, expired), noStore()), 401, 'GET /api/fields')
      await expectRefused(await app.request('/api/sessions', init('POST', { kind: 'review' }, expired), noStore()), 401, 'POST /api/sessions')
    })

    // @covers REQ-255#precedes-body-check
    it('トークンが無く本文も形を満たさない要求は、本文の 400 ではなく認証の 401 で断る', async () => {
      for (const body of [{}, 'not json', { kind: 'zzz' }, { kind: 'drill', topicId: 0 }]) {
        const label = `POST /api/sessions ${typeof body === 'string' ? body : JSON.stringify(body)}`
        await expectRefused(await app.request('/api/sessions', init('POST', body), noStore()), 401, label)
      }
    })
  })

  describe('REQ-257 決められた形を満たさない本文の断り', () => {
    const authed = async (body: unknown) =>
      app.request('/api/sessions', init('POST', body, await memberToken()), noStore({ DB: passiveStore() }))
    const show = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body))

    // @covers REQ-257#not-json
    it('JSON として読めない本文は 400 の {error}', async () => {
      for (const body of ['not json', '{kind: review', '']) {
        await expectRefused(await authed(body), 400, `本文 ${JSON.stringify(body)}`)
      }
    })

    // @covers REQ-257#field-missing
    it('契約が required に挙げる項目（kind と、種別ごとの範囲の項目）が無い本文は 400 の {error}', async () => {
      for (const body of START_SESSION_BODIES.fieldMissing) {
        await expectRefused(await authed(body), 400, show(body))
      }
    })

    // @covers REQ-257#wrong-type
    it('項目の値が契約の型でない本文は 400 の {error}', async () => {
      for (const body of START_SESSION_BODIES.wrongType) {
        await expectRefused(await authed(body), 400, show(body))
      }
    })

    // @covers REQ-257#out-of-range
    it('項目の値が契約の enum・最小・最大の外の本文は 400 の {error}', async () => {
      for (const body of START_SESSION_BODIES.outOfRange) {
        await expectRefused(await authed(body), 400, show(body))
      }
    })

    // @covers REQ-257#not-processed
    it('形を満たさない本文の発行の要求は、まなびばを呼ばずに 400 で止まる', async () => {
      await withFetchCounter(async (calls) => {
        for (const body of [{}, { code: 12 }, { code: '' }, { code: 'a'.repeat(101) }, 'not json']) {
          await expectRefused(await app.request('/api/auth/sso', init('POST', body), noStore(PORTAL)), 400, show(body))
        }
        expect(calls.count, 'まなびばへの呼び出し').toBe(0)
      })
    })
  })

  describe('REQ-259 セキュリティヘッダ', () => {
    // @covers REQ-259#headers-on-authenticated
    it('本人として通った 200 の応答にも 5 つのヘッダが載る', async () => {
      const db = await learningD1()
      sqliteOf(db)
        .prepare('insert into users (id, email, name, password_hash, role) values (?, ?, ?, ?, ?)')
        .run('u-1', 'yudai@example.com', '山田 太郎', 'not-used-for-login', 'MEMBER')
      const res = await app.request('/api/fields', init('GET', undefined, await memberToken()), noStore({ DB: db }))
      expect(res.status, '仕込み: 本人として通らない').toBe(200)
      expectSecurityHeaders(res, 'GET /api/fields（本人）')
    })
  })

  describe('REQ-260 保存先が応答しない間の死活確認', () => {
    // @covers REQ-260#health-without-store-learning
    it('保存先が配備に結びついていなくても、壊れていても、死活確認は 200 {ok: true}', async () => {
      for (const [label, env] of [
        ['結びついていない', noStore()],
        ['壊れている', noStore({ DB: brokenStore() })],
      ] as const) {
        const res = await app.request('/api/health', {}, env)
        expect(res.status, label).toBe(200)
        expect(await res.json(), label).toEqual({ ok: true })
      }
    })
  })
})
