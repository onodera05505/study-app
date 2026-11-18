import { describe, expect, it } from 'vitest'
import portal from '../../portal/src/index'
import learning from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { portalD1, sqliteOf } from './repay_UC-014_sqlite_d1'

/**
 * UC-017 学びとまなびばの要求の受け口を一様に守る（まなびば側。REQ-255・256・257・259）。
 *
 * 叩くのは契約の操作の入口だけ（セッションを要する取得＝UC-013 getMe の GET /api/me、
 * セッションを要する変更＝UC-014 changeOwnPassword の POST /api/me/password と UC-013 signOut の POST /api/logout、
 * 認証を要さない本文つき＝UC-013 signIn の POST /api/login、死活確認＝GET /api/health、学びの一覧＝GET /api/learnings）。
 * 管理者の再設定は UC-011 resetAccountPassword（POST /api/admin/accounts/:id/password）。
 *
 * D1 はメモリの SQLite（repay_UC-014_sqlite_d1）。最初の管理者はまなびばに作る API が無いので表に直に置く。
 * 保存先に届いていないことだけは、どのメソッドでも例外を投げる偽の D1 で見る（届けば 500 になる）。
 */

type PortalEnv = Parameters<typeof portal.request>[2]

const JAPANESE = /[ぁ-んァ-ヶ一-龥]/
const SESSION_COOKIE = 'mb_session'
/** 契約 UC-013 signIn / UC-011 createAccount の examples の値。 */
const YUDAI = { email: 'yudai@example.com', name: '山田 太郎', password: 'harunokaze8' }
const NEXT = 'natsunoame9'
const ADMIN = { id: 'acc-admin', email: 'admin@example.com', name: '管理者', sessionId: 'sess-admin' }
/** 秒でもミリ秒でも 2100 年ごろの先（期限の単位に依らず、まだ切れていない）。 */
const FAR_FUTURE = 4_100_000_000_000
/** 秒でもミリ秒でも 1970 年の直後（期限の単位に依らず、既に過ぎている）。 */
const LONG_AGO = 1

const assets = { fetch: async () => new Response('') }

const brokenStore = (): D1Database => {
  const boom = () => {
    throw new Error('boom')
  }
  return { prepare: boom, batch: boom, exec: boom, dump: boom } as unknown as D1Database
}

const cookieHeader = (cookie?: string): Record<string, string> => (cookie === undefined ? {} : { Cookie: `${SESSION_COOKIE}=${cookie}` })

const init = (method: string, body?: unknown, cookie?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...cookieHeader(cookie) },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
})

const show = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body))

/** 失敗の本文は _shared の ErrorBody（`{ error, code }` だけ・日本語）。文言そのものは照合しない。 */
const errorOf = async (res: Response, label: string) => {
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body).sort(), `${label}: 本文が {error, code} だけでない`).toEqual(['code', 'error'])
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

/** Set-Cookie からセッションの Cookie の値を取り出す。 */
const sessionCookieOf = (res: Response): string => {
  const header = res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
  expect(header, `応答に ${SESSION_COOKIE} の Set-Cookie が無い`).toBeDefined()
  return header!.split(';')[0].slice(SESSION_COOKIE.length + 1)
}

/** 1 件の検査が使うまなびば（空の D1 に管理者を置いたもの）。 */
class Portal {
  readonly env: PortalEnv

  private constructor(readonly db: D1Database) {
    this.env = { DB: db, ASSETS: assets, SSO_SECRET: 'shared' } as unknown as PortalEnv
  }

  static async open(): Promise<Portal> {
    const db = await portalD1()
    const sqlite = sqliteOf(db)
    sqlite
      .prepare('insert into accounts (id, email, name, password_hash, role) values (?, ?, ?, ?, ?)')
      .run(ADMIN.id, ADMIN.email, ADMIN.name, 'not-used-for-login', 'ADMIN')
    sqlite.prepare('insert into sessions (id, account_id, expires_at) values (?, ?, ?)').run(ADMIN.sessionId, ADMIN.id, FAR_FUTURE)
    return new Portal(db)
  }

  request(path: string, requestInit: RequestInit = {}) {
    return portal.request(path, requestInit, this.env)
  }

  /** 期限を指定したセッションを管理者のアカウントに直に置く。 */
  placeSession(id: string, expiresAt: number) {
    sqliteOf(this.db).prepare('insert into sessions (id, account_id, expires_at) values (?, ?, ?)').run(id, ADMIN.id, expiresAt)
    return id
  }

  /** 管理者がアカウントを作る（契約 UC-011 createAccount）。 */
  async createAccount(account: { email: string; name: string; password: string }) {
    const res = await this.request('/api/admin/accounts', init('POST', account, ADMIN.sessionId))
    expect(res.status, `仕込み: ${account.email} のアカウントを作れない`).toBe(201)
  }

  /** 管理者の一覧（契約 UC-011 listAccounts）から、メールでアカウントの id を引く。 */
  async accountId(email: string): Promise<string> {
    const res = await this.request('/api/admin/accounts', init('GET', undefined, ADMIN.sessionId))
    expect(res.status, '仕込み: 一覧が取れない').toBe(200)
    const { accounts } = (await res.json()) as { accounts: Array<{ id: string; email: string }> }
    const found = accounts.find((account) => account.email === email)
    expect(found, `仕込み: ${email} が一覧に無い`).toBeDefined()
    return found!.id
  }

  login(email: string, password: string) {
    return this.request('/api/login', init('POST', { email, password }))
  }

  /** ログインしてセッションの Cookie を得る。 */
  async session(email: string, password: string): Promise<string> {
    const res = await this.login(email, password)
    expect(res.status, `仕込み: ${email} でログインできない`).toBe(200)
    return sessionCookieOf(res)
  }

  me(cookie?: string) {
    return this.request('/api/me', { headers: cookieHeader(cookie) })
  }
}

/** 学び側の、保存先を束ねない配備（断りの形を比べる相手）。 */
const learningEnv = () => ({ EXAM: 'ip', JWT_SECRET: 'test-secret' }) as Bindings

describe('UC-017 要求の受け口（まなびば）', () => {
  describe('REQ-255 通るセッションが無い要求の断り', () => {
    // @covers REQ-255#credential-expired
    it('期限が過ぎたセッションを添えた要求は 401 の {error}', async () => {
      const p = await Portal.open()
      const expired = p.placeSession('sess-expired', LONG_AGO)
      await expectRefused(await p.me(expired), 401, 'GET /api/me')
      await expectRefused(await p.request('/api/logout', init('POST', undefined, expired)), 401, 'POST /api/logout')
    })

    // @covers REQ-255#credential-revoked
    it('管理者の再設定で消されたセッションを添えた要求は、消される前は通っていても 401 の {error}', async () => {
      const p = await Portal.open()
      await p.createAccount(YUDAI)
      const yudai = await p.session(YUDAI.email, YUDAI.password)
      expect((await p.me(yudai)).status, '仕込み: 再設定の前にセッションが通らない').toBe(200)
      const id = await p.accountId(YUDAI.email)
      const reset = await p.request(`/api/admin/accounts/${id}/password`, init('POST', { password: NEXT }, ADMIN.sessionId))
      expect(reset.status, '仕込み: 管理者の再設定が通らない').toBe(200)
      await expectRefused(await p.me(yudai), 401, 'GET /api/me（再設定のあと）')
    })

    // @covers REQ-255#portal-session-absent
    it('セッションが無い要求は取得も変更も 401 の {error} で、学び側の断りと同じ形。変更も行われない', async () => {
      const p = await Portal.open()
      await p.createAccount(YUDAI)
      const portalError = await expectRefused(await p.me(), 401, 'GET /api/me')
      await expectRefused(await p.request('/api/logout', init('POST')), 401, 'POST /api/logout')
      await expectRefused(await p.request('/api/me/password', init('POST', { current: YUDAI.password, next: NEXT })), 401, 'POST /api/me/password')
      // 断った変更は行われていない（前のパスワードで入れ、送った値では入れない）
      expect((await p.login(YUDAI.email, YUDAI.password)).status, '断ったのにパスワードが変わった').toBe(200)
      expect((await p.login(YUDAI.email, NEXT)).status, '断ったのに送った値で入れる').toBe(401)
      // 学び側の同じ断りと形が一致する（状態・本文の鍵・日本語の 1 文）
      const learningRes = await learning.request('/api/fields', {}, learningEnv())
      const learningError = await expectRefused(learningRes, 401, '学び側 GET /api/fields')
      expect(portalError.trim().split('\n'), 'まなびばの断りが 1 文でない').toHaveLength(1)
      expect(learningError.trim().split('\n'), '学び側の断りが 1 文でない').toHaveLength(1)
    })

    // @covers REQ-255#precedes-body-check
    it('セッションが無く本文も形を満たさない変更の要求は、本文の 400 ではなく認証の 401 で断る', async () => {
      const p = await Portal.open()
      for (const body of [{}, '{not json', { current: '', next: 'mijikai' }]) {
        await expectRefused(await p.request('/api/me/password', init('POST', body)), 401, `POST /api/me/password ${show(body)}`)
      }
    })
  })

  describe('REQ-256 受け持たない /api の経路', () => {
    // @covers REQ-256#unknown-path-portal
    it('受け持たない /api の経路は 404 の {error} で、セッションの有無で断りが変わらない', async () => {
      const p = await Portal.open()
      const anonymous = await expectRefused(await p.request('/api/no-such-path'), 404, 'GET /api/no-such-path（セッション無し）')
      const withSession = await expectRefused(
        await p.request('/api/no-such-path', { headers: cookieHeader(ADMIN.sessionId) }),
        404,
        'GET /api/no-such-path（本人）',
      )
      expect(withSession, '本人として呼ぶと断りが変わる').toBe(anonymous)
      await expectRefused(await p.request('/api/no-such-path', init('POST', {})), 404, 'POST /api/no-such-path')
    })
  })

  describe('REQ-257 決められた形を満たさない本文の断り（signIn）', () => {
    // @covers REQ-257#not-json
    it('JSON として読めない本文は 400 の {error}', async () => {
      const p = await Portal.open()
      for (const body of ['{not json', 'email=a@example.com', '']) {
        await expectRefused(await p.request('/api/login', init('POST', body)), 400, `本文 ${JSON.stringify(body)}`)
      }
    })

    // @covers REQ-257#field-missing
    it('required の email か password が無い本文は 400 の {error}', async () => {
      const p = await Portal.open()
      for (const body of [{}, { email: YUDAI.email }, { password: YUDAI.password }]) {
        await expectRefused(await p.request('/api/login', init('POST', body)), 400, show(body))
      }
    })

    // @covers REQ-257#wrong-type
    it('email や password が文字列でない本文は 400 の {error}', async () => {
      const p = await Portal.open()
      for (const body of [{ email: 1, password: YUDAI.password }, { email: YUDAI.email, password: 2 }, { email: [YUDAI.email], password: { v: 1 } }]) {
        await expectRefused(await p.request('/api/login', init('POST', body)), 400, show(body))
      }
    })

    // @covers REQ-257#out-of-range
    it('email がメールの形でない・password が空の本文は 400 の {error}', async () => {
      const p = await Portal.open()
      for (const body of [{ email: 'not-an-email', password: YUDAI.password }, { email: YUDAI.email, password: '' }]) {
        await expectRefused(await p.request('/api/login', init('POST', body)), 400, show(body))
      }
    })

    // @covers REQ-257#not-processed
    it('断った本文は保存先を引く段に届かない（保存先が壊れていても 500 でなく 400）', async () => {
      const env = { DB: brokenStore(), ASSETS: assets, SSO_SECRET: 'shared' } as unknown as PortalEnv
      for (const body of ['{not json', {}, { email: 1, password: 2 }, { email: 'not-an-email', password: YUDAI.password }]) {
        await expectRefused(await portal.request('/api/login', init('POST', body), env), 400, show(body))
      }
    })
  })

  describe('REQ-259 セキュリティヘッダ', () => {
    // @covers REQ-259#headers-on-portal
    it('認証を要さない応答・本人の応答・断りの応答のどれにも 5 つのヘッダが載る', async () => {
      const p = await Portal.open()
      const cases: Array<[string, Response, number]> = [
        ['GET /api/health', await p.request('/api/health'), 200],
        ['GET /api/learnings', await p.request('/api/learnings'), 200],
        ['GET /api/me（本人）', await p.me(ADMIN.sessionId), 200],
        ['GET /api/me（セッション無し）', await p.me(), 401],
        ['GET /api/no-such-path', await p.request('/api/no-such-path'), 404],
        ['POST /api/login（形を満たさない本文）', await p.request('/api/login', init('POST', {})), 400],
      ]
      for (const [label, res, status] of cases) {
        expect(res.status, `仕込み: ${label}`).toBe(status)
        expectSecurityHeaders(res, label)
      }
    })
  })
})
