import { expect } from 'vitest'
import portal from '../../portal/src/index'
import targets from '../../src/shared/targets.json'
import pagesProjects from '../../scripts/pages_projects.json'
import { portalD1, sqliteOf, type DatabaseSync } from './repay_UC-014_sqlite_d1'

/**
 * UC-013 のまなびば側の検査が共有する仕込み。
 *
 * D1 はメモリの SQLite（repay_UC-014_sqlite_d1）。アカウントは管理者の `createAccount`（契約 UC-011）で作り、
 * 以後はすべて UC-013 の契約の operation（signIn / getMe / signOut / listLearnings / startSso / exchangeCode）を
 * HTTP の境界から叩く。SQLite に直接触るのは、仕込み（期限を過ぎさせる・権限を外す）と、
 * 境界からは見えない行の観測（使い捨てコードの行・セッションの行）だけ。
 */

export type PortalEnv = Parameters<typeof portal.request>[2]

/** 契約 _shared/components.yaml authSchemes.session の Cookie 名。 */
export const SESSION_COOKIE = 'mb_session'
/** 契約 authSchemes.sharedSecret（本文の `secret`）。配備の値。 */
export const SHARED_SECRET = 'shared'
export const WRONG_SECRET = 'chigau-aikotoba'

/** 登録簿の値（まなびばの入口と、学びの入口）。 */
export const PORTAL_URL = (targets as unknown as { _portal: { url: string; name: string } })._portal.url
export const learningUrl = (key: string) => (pagesProjects as unknown as Record<string, { url?: string }>)[key]?.url ?? ''

/** 契約 signIn / exchangeCode の examples の値。権限は examples の grants（ip・ap）。itc は権限の無い学び。 */
export const YUDAI = { email: 'yudai@example.com', name: '山田 太郎', password: 'harunokaze8', grants: ['ip', 'ap'] }
export const HANAKO = { email: 'hanako@example.com', name: '鈴木 花子', password: 'fuyunoyuki7', grants: ['ip'] }
export const GRANTED = 'ip'
export const ALSO_GRANTED = 'ap'
export const NOT_GRANTED = 'itc'
export const UNKNOWN_LEARNING = 'zzz'

/** 管理者の行とそのセッションを DDL の表に直接置く（管理者の作り方はこの UC の外）。 */
const ADMIN = { id: 'acc-admin', email: 'admin@example.com', name: '管理者', sessionId: 'sess-admin' }
/** 秒でもミリ秒でも 2100 年ごろの先（期限の単位に依らず、まだ切れていない）。 */
export const FAR_FUTURE = 4_100_000_000_000

const assets = { fetch: async () => new Response('') }

export const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

export const jsonInit = (method: string, body: unknown, cookie?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie === undefined ? {} : { Cookie: `${SESSION_COOKIE}=${cookie}` }) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** Set-Cookie からセッションの Cookie の値を取り出す。 */
export const sessionCookieOf = (res: Response): string => {
  const header = res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
  expect(header, `応答に ${SESSION_COOKIE} の Set-Cookie が無い`).toBeDefined()
  return header!.split(';')[0].slice(SESSION_COOKIE.length + 1)
}

/** 失敗の本文は契約の ErrorBody（`{ error }` だけ）。文言は照合しない。 */
export const expectError = async (res: Response, status: number, label: string): Promise<string> => {
  expect(res.status, label).toBe(status)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), `${label}: 本文が {error} だけでない`).toEqual(['error'])
  expect(typeof body.error, `${label}: error が文字列でない`).toBe('string')
  return body.error as string
}

/** 302 の Location を、まなびばの入口を基準に絶対 URL として読む（相対でも絶対でも同じ形で見る）。 */
export const locationOf = (res: Response, label: string): URL => {
  expect(res.status, `${label}: 302 でない`).toBe(302)
  const location = res.headers.get('Location')
  expect(location, `${label}: Location が無い`).toBeTruthy()
  return new URL(location!, PORTAL_URL)
}

export type CodeRow = { code: string; account_id: string; learning: string; expires_at: number; used_at: number | null }

/** 1 件の検査が使うまなびば（空の D1 に管理者と 2 つのアカウントを置いたもの）。 */
export class Portal {
  readonly env: PortalEnv
  readonly sqlite: DatabaseSync

  private constructor(readonly db: D1Database) {
    this.env = { DB: db, ASSETS: assets, SSO_SECRET: SHARED_SECRET } as unknown as PortalEnv
    this.sqlite = sqliteOf(db)
  }

  static async open(): Promise<Portal> {
    const db = await portalD1()
    const sqlite = sqliteOf(db)
    sqlite
      .prepare('insert into accounts (id, email, name, password_hash, role) values (?, ?, ?, ?, ?)')
      .run(ADMIN.id, ADMIN.email, ADMIN.name, 'not-used-for-login', 'ADMIN')
    sqlite.prepare('insert into sessions (id, account_id, expires_at) values (?, ?, ?)').run(ADMIN.sessionId, ADMIN.id, FAR_FUTURE)
    const p = new Portal(db)
    await p.createAccount(YUDAI)
    await p.createAccount(HANAKO)
    return p
  }

  request(path: string, init: RequestInit = {}) {
    return portal.request(path, init, this.env)
  }

  /** 管理者がアカウントを作る（契約 UC-011 createAccount）。 */
  async createAccount(account: { email: string; name: string; password: string; grants: string[] }) {
    const res = await this.request('/api/admin/accounts', jsonInit('POST', account, ADMIN.sessionId))
    expect(res.status, `仕込み: ${account.email} のアカウントを作れない`).toBe(201)
  }

  /** 契約 signIn。本文は JSON にする値か、そのまま送る文字列。 */
  login(body: unknown) {
    return this.request('/api/login', jsonInit('POST', body))
  }

  /** ログインしてセッションの Cookie を得る。 */
  async session(account: { email: string; password: string } = YUDAI): Promise<string> {
    const res = await this.login({ email: account.email, password: account.password })
    expect(res.status, `仕込み: ${account.email} でログインできない`).toBe(200)
    return sessionCookieOf(res)
  }

  /** 契約 getMe。cookie を渡さなければセッション無しで叩く。 */
  me(cookie?: string) {
    return this.request('/api/me', cookie === undefined ? {} : { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } })
  }

  /** 契約 signOut。 */
  logout(cookie?: string) {
    return this.request('/api/logout', { method: 'POST', ...(cookie === undefined ? {} : { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }) })
  }

  /** 契約 listLearnings（auth: none）。 */
  learnings() {
    return this.request('/api/learnings')
  }

  /** 契約 startSso。query は `app=…` のほかに足したいクエリをそのまま渡せる。 */
  startSso(query: string, cookie?: string) {
    return this.request(`/sso/start?${query}`, cookie === undefined ? {} : { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } })
  }

  /** 権限のある学びを開いて、戻し先の URL に付いた使い捨てコードを得る。 */
  async issueCode(cookie: string, app: string = GRANTED): Promise<string> {
    const location = locationOf(await this.startSso(`app=${app}`, cookie), `仕込み: ${app} のコードの発行`)
    const code = location.searchParams.get('code')
    expect(code, `仕込み: 戻し先の URL にコードが付いていない（${location.href}）`).toBeTruthy()
    return code!
  }

  /** 契約 exchangeCode。共有秘密は本文の `secret`（authSchemes.sharedSecret）。 */
  exchange(body: Record<string, unknown>) {
    return this.request('/api/sso/exchange', jsonInit('POST', body))
  }

  /** 合う共有秘密を添えた交換。 */
  exchangeWithSecret(body: Record<string, unknown>) {
    return this.exchange({ secret: SHARED_SECRET, ...body })
  }

  /** アカウントの id（signIn の応答から）。 */
  async accountId(account: { email: string; password: string } = YUDAI): Promise<string> {
    const res = await this.login({ email: account.email, password: account.password })
    const body = (await res.json()) as { account: { id: string } }
    return body.account.id
  }

  // ---- 境界からは見えない行の観測と仕込み（SQLite に直接触る） ----

  codeRows(): CodeRow[] {
    return this.sqlite.prepare('select code, account_id, learning, expires_at, used_at from sso_codes').all() as CodeRow[]
  }

  codeRow(code: string): CodeRow | undefined {
    return this.sqlite.prepare('select code, account_id, learning, expires_at, used_at from sso_codes where code = ?').get(code) as CodeRow | undefined
  }

  sessionCount(accountId?: string): number {
    const row = (
      accountId === undefined
        ? this.sqlite.prepare("select count(*) as n from sessions where account_id <> 'acc-admin'").get()
        : this.sqlite.prepare('select count(*) as n from sessions where account_id = ?').get(accountId)
    ) as { n: number }
    return Number(row.n)
  }

  /** 期限を「過ぎた直後」にする（期限の単位が秒でもミリ秒でも、今より 1 だけ前）。 */
  expireCode(code: string) {
    const row = this.codeRow(code)
    expect(row, `仕込み: コード ${code} の行が無い`).toBeDefined()
    const now = row!.expires_at > 1e11 ? Date.now() : Math.floor(Date.now() / 1000)
    this.sqlite.prepare('update sso_codes set expires_at = ? where code = ?').run(now - 1, code)
  }

  /** 期限の過ぎたセッションを置き、その Cookie の値を返す。 */
  expiredSession(accountId: string): string {
    const id = `sess-expired-${accountId}`
    this.sqlite.prepare('insert into sessions (id, account_id, expires_at) values (?, ?, ?)').run(id, accountId, 1)
    return id
  }

  /** 発行のあとで学びの権限を外す。 */
  revokeGrant(accountId: string, learning: string) {
    this.sqlite.prepare('delete from grants where account_id = ? and learning = ?').run(accountId, learning)
  }
}
