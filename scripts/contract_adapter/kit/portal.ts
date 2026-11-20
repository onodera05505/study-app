/**
 * まなびばの app（`portal/src/index.ts` の default export）に実例を渡す前提の部品。
 *
 * 実例ごとに portalWorld() で空のまなびばの D1（portal/migrations を当てたメモリの SQLite）を作り、
 * アカウント・権限・セッションの行を前提の値で置く（パスワードの持ち方は tests/portal の土台と同じく hashPassword）。
 * 実例の要求は `world.request` で渡す。重なった別の求めが先に書き込む前提は `world.beforeFirstWrite` で作る:
 * 実例の要求が最初の書き込みの文に達したところで止め、別の求め（`world.other`。止めない口）を先に済ませてから進める。
 */

import portal from '../../../portal/src/index'
import { hashPassword } from '../../../src/server/lib/auth'
import { portalD1, sqliteOf, type DatabaseSync } from '../../../tests/portal/repay_UC-014_sqlite_d1'
import { answerOf, pieces, withoutIdentity, type PieceOptions } from './http'
import type { Answer, ExampleLine } from './protocol'

export type PortalEnv = Parameters<typeof portal.request>[2]

/** _shared/components.yaml の authSchemes.session の Cookie 名。 */
export const SESSION_COOKIE = 'mb_session'
/** 配備の共有秘密（authSchemes.sharedSecret の値）。 */
export const SHARED_SECRET = 'contract-adapter-shared'
/** 秒でもミリ秒でもまだ切れていない期限。 */
const FAR_FUTURE = 4_100_000_000_000
const WRITE = /^\s*(insert|update|delete|replace)\b/i

export type AccountSpec = {
  id: string
  email: string
  name: string
  password: string
  role?: 'ADMIN' | 'MEMBER'
  grants?: string[]
  createdAt?: number
}

export type PortalWorld = {
  db: DatabaseSync
  /** 実例の要求を渡す口（書き込みの前に差し込みを置ける）。 */
  request: (path: string, init?: RequestInit) => Promise<Response>
  /** 差し込みを置かない口（重なった別の求めを渡す）。 */
  other: (path: string, init?: RequestInit) => Promise<Response>
  account: (spec: AccountSpec) => Promise<void>
  /** 期限の切れていないセッションを置き、Cookie の値を返す。 */
  session: (accountId: string) => string
  cookie: (value: string) => Record<string, string>
  /** 実例の要求が最初の書き込みの文に達したとき、1 度だけ body を済ませてから進める。 */
  beforeFirstWrite: (body: () => Promise<unknown>) => void
  /** 実例を境界から叩いて答えに読む。sessionId を渡すとその Cookie を付ける（本人を持たない前提の実例には付けない）。 */
  send: (line: ExampleLine, sessionId: string | null, options?: PieceOptions) => Promise<Answer>
  /** fetch と同じ形で、まなびばを手元の偽の相手として呼ぶ（学び側の外への口をここへ向ける）。 */
  asFetch: typeof globalThis.fetch
}

/** 書き込みの文の前に 1 度だけ前提を済ませる D1 の包み。まなびばの app が使う口（prepare・batch）だけを持つ。 */
class HookedD1 {
  hook: ((sql: string) => Promise<void>) | null = null
  constructor(readonly inner: D1Database) {}
  private async before(sql: string) {
    if (this.hook && WRITE.test(sql)) await this.hook(sql)
  }
  private wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return {
      original: statement,
      bind: (...values: unknown[]) => this.wrap(statement.bind(...values), sql),
      first: async (column?: string) => {
        await this.before(sql)
        return column === undefined ? statement.first() : statement.first(column)
      },
      all: async () => {
        await this.before(sql)
        return statement.all()
      },
      run: async () => {
        await this.before(sql)
        return statement.run()
      },
      raw: async (options?: { columnNames?: boolean }) => {
        await this.before(sql)
        return (statement.raw as (o?: { columnNames?: boolean }) => Promise<unknown[]>)(options)
      },
      sql,
    } as unknown as D1PreparedStatement
  }
  prepare(sql: string) {
    return this.wrap(this.inner.prepare(sql), sql)
  }
  async batch(statements: D1PreparedStatement[]) {
    const originals = statements as unknown as Array<{ original: D1PreparedStatement; sql: string }>
    for (const { sql } of originals) await this.before(sql)
    return this.inner.batch(originals.map((o) => o.original))
  }
}

/**
 * 実例 1 件のまなびばの配備を作る。
 * @implements REQ-570
 */
export async function portalWorld(extraEnv: Record<string, unknown> = {}): Promise<PortalWorld> {
  const d1 = await portalD1()
  const db = sqliteOf(d1)
  const hooked = new HookedD1(d1)
  const base = { ASSETS: { fetch: async () => new Response('') }, SSO_SECRET: SHARED_SECRET, ...extraEnv }
  const env = { ...base, DB: hooked } as unknown as PortalEnv
  const plainEnv = { ...base, DB: d1 } as unknown as PortalEnv
  let sessions = 0
  const request = (path: string, init: RequestInit = {}) => portal.request(path, init, env) as Promise<Response>
  const cookie = (value: string) => ({ Cookie: `${SESSION_COOKIE}=${value}` })
  return {
    db,
    request,
    other: (path, init = {}) => portal.request(path, init, plainEnv) as Promise<Response>,
    account: async (spec) => {
      const at = spec.createdAt ?? Math.floor(Date.now() / 1000)
      db.prepare('INSERT INTO accounts (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        spec.id,
        spec.email,
        spec.name,
        await hashPassword(spec.password),
        spec.role ?? 'MEMBER',
        at,
        at,
      )
      for (const learning of spec.grants ?? []) db.prepare('INSERT INTO grants (account_id, learning) VALUES (?, ?)').run(spec.id, learning)
    },
    session: (accountId) => {
      const id = `contract-adapter-session-${++sessions}`
      db.prepare('INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)').run(id, accountId, FAR_FUTURE)
      return id
    },
    cookie,
    beforeFirstWrite: (body) => {
      hooked.hook = async () => {
        hooked.hook = null
        await body()
      }
    },
    send: async (line, sessionId, options = {}) => {
      const headers = { ...(options.headers ?? {}) }
      if (sessionId && !withoutIdentity(line)) Object.assign(headers, cookie(sessionId))
      const { path, init } = pieces(line, { ...options, headers })
      return answerOf(await request(path, init), line)
    },
    asFetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      portal.request(new Request(input, init), undefined, plainEnv)) as typeof globalThis.fetch,
  }
}
