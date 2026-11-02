import { beforeEach, describe, expect, it } from 'vitest'
import portal from '../../portal/src/index'
import learning from '../../src/server/index'
import { issueToken } from '../../src/server/lib/auth'
import type { Bindings } from '../../src/server/lib/db'
import { learningD1, portalD1, sqliteOf } from './repay_UC-014_sqlite_d1'

/**
 * UC-014 自分のパスワードを変える（まなびば。REQ-209〜212）。
 *
 * 契約 `changeOwnPassword`（POST /api/me/password、auth: session）を境界から叩き、
 * 入れ替わったかどうかは契約 `signIn`（POST /api/login）の可否と `getMe`（GET /api/me）の通り方で観測する。
 * D1 はメモリの SQLite（repay_UC-014_sqlite_d1）で、アカウントは管理者の `createAccount` で作る
 * （利用者が自分で作ることはできない。UC の事前条件）。
 */

type PortalEnv = Parameters<typeof portal.request>[2]

/** 契約 UC-013 signIn / UC-014 changeOwnPassword / UC-011 createAccount の examples の値。 */
const YUDAI = { email: 'yudai@example.com', name: '山田 太郎', password: 'harunokaze8' }
const HANAKO = { email: 'hanako@example.com', name: '鈴木 花子', password: 'fuyunoyuki7' }
const NEXT = 'natsunoame9'
const WRONG_CURRENT = 'chigaupass9'
const SHORT_NEXT = 'mijikai'
const MIN_LENGTH = 8
const MAX_LENGTH = 200
const SESSION_COOKIE = 'mb_session'

/** 管理者の行とそのセッションを DDL の表に直接置く（管理者の作り方はこの UC の外）。 */
const ADMIN = { id: 'acc-admin', email: 'admin@example.com', name: '管理者', sessionId: 'sess-admin' }
/** 秒でもミリ秒でも 2100 年ごろの先（期限の単位に依らず、まだ切れていない）。 */
const FAR_FUTURE = 4_100_000_000_000

const assets = { fetch: async () => new Response('') }

const jsonInit = (method: string, body: unknown, cookie?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie === undefined ? {} : { Cookie: `${SESSION_COOKIE}=${cookie}` }) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** Set-Cookie からセッションの Cookie の値を取り出す。 */
const sessionCookieOf = (res: Response): string => {
  const header = res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
  expect(header, `応答に ${SESSION_COOKIE} の Set-Cookie が無い`).toBeDefined()
  return header!.split(';')[0].slice(SESSION_COOKIE.length + 1)
}

/** 失敗の本文は契約の ErrorBody（`{ error }` だけ）。文言は照合しない。 */
const expectError = async (res: Response, status: number, label: string) => {
  expect(res.status, label).toBe(status)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), `${label}: 本文が {error} だけでない`).toEqual(['error'])
  expect(typeof body.error, `${label}: error が文字列でない`).toBe('string')
}

/** 1 件の検査が使うまなびば（空の D1 に管理者と 2 つのアカウントを置いたもの）。 */
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

  request(path: string, init: RequestInit = {}) {
    return portal.request(path, init, this.env)
  }

  /** 管理者がアカウントを作る（契約 UC-011 createAccount）。 */
  async createAccount(account: { email: string; name: string; password: string }) {
    const res = await this.request('/api/admin/accounts', jsonInit('POST', account, ADMIN.sessionId))
    expect(res.status, `仕込み: ${account.email} のアカウントを作れない`).toBe(201)
  }

  /** メールとパスワードでログインする（契約 UC-013 signIn）。 */
  login(email: string, password: string) {
    return this.request('/api/login', jsonInit('POST', { email, password }))
  }

  /** ログインしてセッションの Cookie を得る。 */
  async session(email: string, password: string): Promise<string> {
    const res = await this.login(email, password)
    expect(res.status, `仕込み: ${email} でログインできない`).toBe(200)
    return sessionCookieOf(res)
  }

  /** 契約 changeOwnPassword。本文は JSON にする値か、そのまま送る文字列。 */
  changePassword(cookie: string, body: unknown) {
    return this.request('/api/me/password', jsonInit('POST', body, cookie))
  }

  /** セッションで本人を引く（契約 UC-013 getMe）。 */
  me(cookie: string) {
    return this.request('/api/me', { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } })
  }

  async expectLogin(email: string, password: string, status: 200 | 401, label: string) {
    const res = await this.login(email, password)
    expect(res.status, label).toBe(status)
  }
}

describe('UC-014 自分のパスワードを変える（まなびば）', () => {
  let p: Portal
  let yudai: string

  beforeEach(async () => {
    p = await Portal.open()
    await p.createAccount(YUDAI)
    await p.createAccount(HANAKO)
    yudai = await p.session(YUDAI.email, YUDAI.password)
  })

  describe('REQ-209 合う現在のパスワードで新しいものに入れ替える', () => {
    // @covers REQ-209#replaced
    it('合う現在のパスワードと決めの長さの新しいパスワードを送ると 200 {ok: true}', async () => {
      const res = await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    })

    // @covers REQ-209#new-password-logs-in
    it('入れ替えのあと、新しいパスワードでログインできる', async () => {
      await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      await p.expectLogin(YUDAI.email, NEXT, 200, '新しいパスワードで入れない')
    })

    // @covers REQ-209#old-password-rejected
    it('入れ替えのあと、前のパスワードではログインできない', async () => {
      await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      await p.expectLogin(YUDAI.email, YUDAI.password, 401, '前のパスワードで入れてしまう')
    })

    // @covers REQ-209#min-length-passes
    it('新しいパスワードが下限ちょうど（8 文字）なら入れ替わり、そのパスワードでログインできる', async () => {
      const next = 'a'.repeat(MIN_LENGTH)
      const res = await p.changePassword(yudai, { current: YUDAI.password, next })
      expect(res.status, '下限ちょうどが断られる').toBe(200)
      await p.expectLogin(YUDAI.email, next, 200, '下限ちょうどのパスワードで入れない')
    })

    // @covers REQ-209#max-length-passes
    it('新しいパスワードが上限ちょうど（200 文字）なら入れ替わり、そのパスワードでログインできる', async () => {
      const next = 'b'.repeat(MAX_LENGTH)
      const res = await p.changePassword(yudai, { current: YUDAI.password, next })
      expect(res.status, '上限ちょうどが断られる').toBe(200)
      await p.expectLogin(YUDAI.email, next, 200, '上限ちょうどのパスワードで入れない')
    })

    // @covers REQ-209#next-equals-current
    it('新しいパスワードが現在のものと同じ値でも入れ替えとして通り、そのパスワードでログインできる', async () => {
      const res = await p.changePassword(yudai, { current: YUDAI.password, next: YUDAI.password })
      expect(res.status, '同じ値への入れ替えが断られる').toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      await p.expectLogin(YUDAI.email, YUDAI.password, 200, '同じ値に入れ替えたあとに入れない')
    })

    // @covers REQ-209#only-own-account
    it('入れ替わるのは本人のアカウントだけで、他のアカウントのパスワードは前のまま', async () => {
      await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      await p.expectLogin(HANAKO.email, HANAKO.password, 200, '他のアカウントの前のパスワードで入れなくなった')
      await p.expectLogin(HANAKO.email, NEXT, 401, '他のアカウントに本人の新しいパスワードで入れてしまう')
    })
  })

  describe('REQ-210 現在のパスワードが合わない要求は変えずに断る', () => {
    // @covers REQ-210#wrong-current
    it('どのアカウントのものでもない現在のパスワードは 401 の {error}', async () => {
      await expectError(await p.changePassword(yudai, { current: WRONG_CURRENT, next: NEXT }), 401, '合わない現在のパスワード')
    })

    // @covers REQ-210#other-account-password
    it('他のアカウントのパスワードと合う値を現在のパスワードにしても 401', async () => {
      await expectError(await p.changePassword(yudai, { current: HANAKO.password, next: NEXT }), 401, '他人のパスワードを現在のものとして送る')
    })

    // @covers REQ-210#password-unchanged
    it('断ったあと、送った新しいパスワードではログインできない（入れ替わっていない）', async () => {
      await p.changePassword(yudai, { current: WRONG_CURRENT, next: NEXT })
      await p.expectLogin(YUDAI.email, NEXT, 401, '断ったのに新しいパスワードで入れる')
    })

    // @covers REQ-210#old-password-still-works
    it('断ったあと、前のパスワードで引き続きログインできる', async () => {
      await p.changePassword(yudai, { current: WRONG_CURRENT, next: NEXT })
      await p.expectLogin(YUDAI.email, YUDAI.password, 200, '断ったあとに前のパスワードで入れない')
    })
  })

  describe('REQ-211 決められた形を満たさない本文は変えずに断る', () => {
    // @covers REQ-211#next-too-short
    it.each([
      ['下限の 1 つ手前（7 文字）', 'c'.repeat(MIN_LENGTH - 1)],
      ['契約の例 mijikai', SHORT_NEXT],
      ['1 文字', 'd'],
    ])('新しいパスワードが短い（%s）と 400', async (_label, next) => {
      await expectError(await p.changePassword(yudai, { current: YUDAI.password, next }), 400, `短い新しいパスワード: ${_label}`)
    })

    // @covers REQ-211#next-too-long
    it.each([
      ['上限の 1 つ先（201 文字）', 'e'.repeat(MAX_LENGTH + 1)],
      ['上限の 2 倍', 'f'.repeat(MAX_LENGTH * 2)],
    ])('新しいパスワードが長い（%s）と 400', async (_label, next) => {
      await expectError(await p.changePassword(yudai, { current: YUDAI.password, next }), 400, `長い新しいパスワード: ${_label}`)
    })

    // @covers REQ-211#next-empty
    it('新しいパスワードが空だと 400', async () => {
      await expectError(await p.changePassword(yudai, { current: YUDAI.password, next: '' }), 400, '空の新しいパスワード')
    })

    // @covers REQ-211#current-empty
    it('現在のパスワードが空だと 400', async () => {
      await expectError(await p.changePassword(yudai, { current: '', next: NEXT }), 400, '空の現在のパスワード')
    })

    // @covers REQ-211#field-missing
    it.each([
      ['current が無い', { next: NEXT }],
      ['next が無い', { current: YUDAI.password }],
      ['両方無い', {}],
    ])('欄そのものが無い（%s）と 400', async (label, body) => {
      await expectError(await p.changePassword(yudai, body), 400, label)
    })

    // @covers REQ-211#wrong-type
    it.each([
      ['current が数値', { current: 12345678, next: NEXT }],
      ['next が配列', { current: YUDAI.password, next: [NEXT] }],
      ['next が null', { current: YUDAI.password, next: null }],
      ['next がオブジェクト', { current: YUDAI.password, next: { value: NEXT } }],
    ])('欄の値が文字列でない（%s）と 400', async (label, body) => {
      await expectError(await p.changePassword(yudai, body), 400, label)
    })

    // @covers REQ-211#not-json
    it.each([
      ['平文', 'これは JSON ではない'],
      ['閉じていない JSON', '{"current": "harunokaze8", "next": '],
      ['空の本文', ''],
    ])('本文が JSON として読めない（%s）と 400', async (label, body) => {
      await expectError(await p.changePassword(yudai, body), 400, label)
    })

    // @covers REQ-211#password-unchanged
    it('断ったあと、前のパスワードで引き続きログインでき、送った値では入れない', async () => {
      const attempts: unknown[] = [
        { current: YUDAI.password, next: SHORT_NEXT },
        { current: YUDAI.password, next: 'g'.repeat(MAX_LENGTH + 1) },
        { current: '', next: NEXT },
        { next: NEXT },
        'これは JSON ではない',
      ]
      for (const body of attempts) {
        const res = await p.changePassword(yudai, body)
        expect(res.status, `仕込み: 形を満たさない本文が 400 でない: ${JSON.stringify(body)}`).toBe(400)
      }
      await p.expectLogin(YUDAI.email, YUDAI.password, 200, '断ったあとに前のパスワードで入れない')
      await p.expectLogin(YUDAI.email, NEXT, 401, '断ったのに送った新しいパスワードで入れる')
      await p.expectLogin(YUDAI.email, SHORT_NEXT, 401, '断ったのに短い新しいパスワードで入れる')
    })

    // @covers REQ-211#precedes-wrong-current
    it('現在のパスワードが合わず、かつ新しいパスワードが長さの外なら、先に 400（契約の errors の並び）', async () => {
      await expectError(await p.changePassword(yudai, { current: WRONG_CURRENT, next: SHORT_NEXT }), 400, '合わない現在 × 短い新しい')
      await expectError(await p.changePassword(yudai, { current: WRONG_CURRENT, next: 'h'.repeat(MAX_LENGTH + 1) }), 400, '合わない現在 × 長い新しい')
    })
  })

  describe('REQ-212 本人が変えてもログイン中の端末と配られたトークンはそのまま', () => {
    // @covers REQ-212#changing-device-session-kept
    it('変えた端末のセッションは変更のあとも通る', async () => {
      const res = await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      expect(res.status, '仕込み: 入れ替えが通らない').toBe(200)
      const me = await p.me(yudai)
      expect(me.status, '変えた端末のセッションが切れた').toBe(200)
      const body = (await me.json()) as { account: { email: string } }
      expect(body.account.email).toBe(YUDAI.email)
    })

    // @covers REQ-212#other-device-session-kept
    it('同じ本人が他の端末で変更の前から持っているセッションも、変更のあとに通る', async () => {
      const otherDevice = await p.session(YUDAI.email, YUDAI.password)
      expect(otherDevice, '仕込み: 2 つ目の端末のセッションが 1 つ目と同じ').not.toBe(yudai)
      const res = await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      expect(res.status, '仕込み: 入れ替えが通らない').toBe(200)
      const me = await p.me(otherDevice)
      expect(me.status, '他の端末のセッションが切れた（本人による変更では残す）').toBe(200)
      const body = (await me.json()) as { account: { email: string } }
      expect(body.account.email).toBe(YUDAI.email)
    })

    // @covers REQ-212#issued-token-still-passes
    it('変更の前に学び側が配ったトークンは、変更のあとも学びの要求を通す', async () => {
      const secret = 'test-secret'
      const learningDb = await learningD1()
      const learningEnv = { EXAM: 'ip', JWT_SECRET: secret, DB: learningDb } as unknown as Bindings
      // トークンの本人は学び側の users にもいる（学び側はまなびばから換えた本人を自分の users に持つ。UC-013）
      sqliteOf(learningDb)
        .prepare('insert into users (id, email, name, password_hash, role) values (?, ?, ?, ?, ?)')
        .run('acc-yudai', YUDAI.email, YUDAI.name, 'not-used-for-login', 'MEMBER')
      const token = await issueToken(secret, { id: 'acc-yudai', name: YUDAI.name, role: 'MEMBER' })
      const withToken = { headers: { Authorization: `Bearer ${token}` } }
      const before = await learning.request('/api/fields', withToken, learningEnv)
      expect(before.status, '仕込み: 変更の前にトークンで学びの要求が通らない').toBe(200)

      const res = await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      expect(res.status, '仕込み: 入れ替えが通らない').toBe(200)

      const after = await learning.request('/api/fields', withToken, learningEnv)
      expect(after.status, '変更のあとに配られていたトークンが通らない').toBe(200)
    })

    // @covers REQ-212#other-account-sessions-untouched
    it('他のアカウントのセッションは本人の変更に触られない', async () => {
      const hanako = await p.session(HANAKO.email, HANAKO.password)
      const res = await p.changePassword(yudai, { current: YUDAI.password, next: NEXT })
      expect(res.status, '仕込み: 入れ替えが通らない').toBe(200)
      const me = await p.me(hanako)
      expect(me.status, '他のアカウントのセッションが切れた').toBe(200)
      const body = (await me.json()) as { account: { email: string } }
      expect(body.account.email).toBe(HANAKO.email)
    })
  })
})
