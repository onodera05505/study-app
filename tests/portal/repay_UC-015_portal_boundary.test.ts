import { describe, expect, it } from 'vitest'
import portal from '../../portal/src/index'
import learning from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'

/**
 * UC-015 本番の検査のうち、まなびばが外から叩かれたときに返す側（REQ-213 の死活確認、REQ-223 の断り）。
 *
 * 本番の検査と同じ形（認証を添えない要求）でまなびばの経路を叩く。D1 は何も入っていない偽物で、
 * 受けた SQL を記録するので「断った要求が何も変えていない」を書き込みの有無で観測できる。
 * 経路の一覧はまなびばのサーバが登録した経路の表から導く（一覧の正本はサーバの経路の定義。BR-001）。
 */

type PortalEnv = Parameters<typeof portal.request>[2]
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

/** 何も入っていない D1。読みは空を返し、受けた SQL をすべて記録する。 */
const recordingD1 = () => {
  const executed: string[] = []
  const statement = (sql: string) => {
    const s = {
      bind: () => s,
      first: async () => {
        executed.push(sql)
        return null
      },
      all: async () => {
        executed.push(sql)
        return { results: [], success: true, meta: {} }
      },
      run: async () => {
        executed.push(sql)
        return { results: [], success: true, meta: {} }
      },
      raw: async () => {
        executed.push(sql)
        return []
      },
    }
    return s
  }
  const db = {
    prepare: statement,
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => Promise.all(statements.map((s) => s.all())),
    exec: async (sql: string) => {
      executed.push(sql)
      return { count: 0, duration: 0 }
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database
  return { db, executed }
}

const assets = { fetch: async () => new Response('') }
const portalEnv = (db: D1Database) => ({ DB: db, ASSETS: assets, SSO_SECRET: 'shared' }) as unknown as PortalEnv
const learningEnv = () => ({ EXAM: 'ip', JWT_SECRET: 'test-secret' }) as Bindings

type Route = [method: string, path: string]
const label = ([method, path]: Route) => `${method} ${path}`

/** /api の具体の経路（前置きの `*` と、メソッドを問わない中間の登録は除く）。 */
const apiRoutes = (app: { routes: Array<{ method: string; path: string }> }): Route[] => [
  ...new Map(
    app.routes
      .filter((r) => r.path.startsWith('/api/') && !r.path.includes('*') && r.method !== 'ALL')
      .map((r) => [`${r.method} ${r.path}`, [r.method, r.path] as Route]),
  ).values(),
]

/** 認証なしで通る応答は、死活確認と学びの一覧だけ（BR-001。契約 UC-015 checkDeploymentHealth、UC-013 listLearnings）。 */
const PORTAL_PUBLIC = ['GET /api/health', 'GET /api/learnings']
/** ログインそのもの（契約 UC-013 signIn）は認証の入口で、通るか断るかは資格情報で決まる（UC-013 の分割クラス）。認証の要る応答の側にも数えない。 */
const AUTH_ENTRY = ['POST /api/login']
const PORTAL_ROUTES = apiRoutes(portal)
const PORTAL_PROTECTED = PORTAL_ROUTES.filter((r) => !PORTAL_PUBLIC.includes(label(r)) && !AUTH_ENTRY.includes(label(r)))

/** 契約の examples の値で組んだ本文（断りが先に立ち、どの経路でも処理に進まないことを見る）。 */
const BODY = { email: 'yudai@example.com', name: '山田 太郎', password: 'harunokaze8', current: 'harunokaze8', next: 'natsunoame9', code: '3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40', app: 'ip', grants: ['ip'] }

const callPortal = (route: Route, db: D1Database) =>
  portal.request(
    route[1].replace(/:\w+/g, 'acc-1'),
    {
      method: route[0],
      headers: { 'Content-Type': 'application/json' },
      ...(route[0] === 'GET' ? {} : { body: JSON.stringify(BODY) }),
    },
    portalEnv(db),
  )

/** 断りの本文は契約の ErrorBody（`{ error }` だけ）。文言は照合しない。 */
const errorBodyOf = async (res: Response, where: string) => {
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), `${where}: 本文が {error} だけでない`).toEqual(['error'])
  expect(typeof body.error, `${where}: error が文字列でない`).toBe('string')
  return body.error as string
}

/** 共有秘密で守る経路（契約 exchangeCode）は FORBIDDEN、セッションで守る経路は UNAUTHENTICATED で断る。 */
const refusalStatusOf = (route: Route) => (route[1] === '/api/sso/exchange' ? 403 : 401)

describe('UC-015 本番の検査が外から叩くまなびばの境界', () => {
  describe('REQ-213 死活確認', () => {
    // @covers REQ-213#portal-alive
    it('まなびばの死活確認は認証を添えずに叩くと 200 で、本文は契約の Ok（{ ok: true }）。保存先には触れない', async () => {
      const { db, executed } = recordingD1()
      const res = await portal.request('/api/health', {}, portalEnv(db))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(executed, '死活確認が保存先に触れている').toEqual([])
    })
  })

  describe('REQ-223 認証の要る応答を認証なしで叩く', () => {
    // @covers REQ-223#portal-protected-refused
    it('まなびばの認証の要る経路は、経路の表から導いた全件が、認証なしでは {error} で断られ中身を返さない', async () => {
      expect(PORTAL_PROTECTED.length, '経路の表から導いた認証の要る経路が少なすぎる').toBeGreaterThanOrEqual(7)
      for (const route of PORTAL_PROTECTED) {
        const res = await callPortal(route, recordingD1().db)
        expect(res.status, label(route)).toBe(refusalStatusOf(route))
        const error = await errorBodyOf(res, label(route))
        expect(error, label(route)).toMatch(JAPANESE)
      }
    })

    // @covers REQ-223#refusal-shape-same
    it('断りの形（状態コードと本文の鍵）がまなびばと学び側で同じ（BR-001）', async () => {
      const learningProtected = apiRoutes(learning).find(([method, path]) => method === 'GET' && !path.startsWith('/api/auth/') && path !== '/api/health')
      expect(learningProtected, '学び側に認証の要る GET の経路が無い').toBeDefined()
      const fromLearning = await learning.request(learningProtected![1].replace(/:\w+/g, '1'), {}, learningEnv())
      const fromPortal = await callPortal(['GET', '/api/me'], recordingD1().db)
      expect(fromPortal.status).toBe(401)
      expect(fromLearning.status).toBe(fromPortal.status)
      const portalBody = (await fromPortal.json()) as Record<string, unknown>
      const learningBody = (await fromLearning.json()) as Record<string, unknown>
      expect(Object.keys(portalBody)).toEqual(['error'])
      expect(Object.keys(learningBody)).toEqual(Object.keys(portalBody))
      expect(fromPortal.headers.get('content-type')?.split(';')[0]).toBe(fromLearning.headers.get('content-type')?.split(';')[0])
    })

    // @covers REQ-223#public-set-is-closed
    it('認証なしで断られずに通る経路は、死活確認と学びの一覧の 2 つだけ（ログインも、資格情報が無ければ通らない）', async () => {
      expect(PORTAL_ROUTES.length).toBeGreaterThanOrEqual(10)
      const passed: string[] = []
      for (const route of PORTAL_ROUTES) {
        const res = await callPortal(route, recordingD1().db)
        if (res.status !== 401 && res.status !== 403) passed.push(label(route))
      }
      expect(passed.sort()).toEqual([...PORTAL_PUBLIC].sort())
    })

    // @covers REQ-223#no-change-on-refusal
    it('認証なしで断られた変更の要求は、保存先に 1 つも書き込まない', async () => {
      const writes = PORTAL_PROTECTED.filter(([method]) => method !== 'GET')
      expect(writes.length, '経路の表から導いた変更の経路が少なすぎる').toBeGreaterThanOrEqual(5)
      for (const route of writes) {
        const { db, executed } = recordingD1()
        const res = await callPortal(route, db)
        expect(res.status, label(route)).toBe(refusalStatusOf(route))
        const written = executed.filter((sql) => /^\s*(insert|update|delete|replace)\b/i.test(sql))
        expect(written, `${label(route)}: 断ったのに書き込んでいる`).toEqual([])
      }
    })
  })
})
