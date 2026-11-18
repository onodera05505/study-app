import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { learningD1, sqliteOf, type DatabaseSync } from '../portal/repay_UC-014_sqlite_d1'

/**
 * UC-013 まなびばから権限のある学びに入る — 学び側がコードを換えて本人を受け入れるところ
 * （REQ-191・192・193・196・205・206・207・208）。
 *
 * 契約 signInWithCode（POST /api/auth/sso）を境界から叩く。まなびばは fetch を差し替えた偽物で、
 * 契約 exchangeCode の応答（本人のメールと名前、または断り）を返す。
 * 本人の記録は migrations を当てたメモリの SQLite（users・progress）で観測し、
 * 引き継ぎは契約 getMyHome（GET /api/me）と recordUnderstanding（PUT /api/topics/:id/progress）の境界で見る。
 */

/** 契約 signInWithCode / exchangeCode の examples の値。 */
const CODE = '3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40'
const PERSON = { email: 'yudai@example.com', name: '山田 太郎' }
const OTHER_PERSON = { email: 'hanako@example.com', name: '鈴木 花子' }
const PORTAL = { SSO_PORTAL_URL: 'https://portal.example', SSO_SECRET: 'shared' }
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/
const TOPIC = 101

type TokenAndUser = { token: string; user: { id: string; name: string; role: string } }
type Me = { user: { id: string; name: string }; topics: { total: number; understood: number; partly: number } }
type UserRow = { id: string; email: string; name: string; role: string }

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** まなびばの代わり。呼ばれた要求を記録し、決めた応答を返す（投げれば「届かない」）。 */
const fakePortal = (reply: () => Response | never) => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return reply()
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = orig) }
}
const replyPerson = (person = PERSON) => () => new Response(JSON.stringify(person), { status: 200, headers: { 'Content-Type': 'application/json' } })
const replyRefusal = (status: number) => () => new Response(JSON.stringify({ error: 'コードが無効です' }), { status, headers: { 'Content-Type': 'application/json' } })
const replyUnreachable = () => () => {
  throw new TypeError('fetch failed')
}

describe('UC-013 学び側がコードを換えて本人を受け入れる', () => {
  let db: D1Database
  let sqlite: DatabaseSync
  let env: Bindings
  let restore: () => void = () => {}

  const users = () => sqlite.prepare('select id, email, name, role from users').all() as UserRow[]
  const signIn = (code: string = CODE, over: Partial<Bindings> = {}) => app.request('/api/auth/sso', json({ code }), { ...env, ...over })
  const withToken = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
  const me = async (token: string) => {
    const res = await app.request('/api/me', { headers: withToken(token) }, env)
    expect(res.status, '/api/me').toBe(200)
    return (await res.json()) as Me
  }
  /** 理解度の記録に要る最小の論点（契約 recordUnderstanding の対象）。 */
  const seedTopic = () => {
    sqlite
      .prepare('insert into syllabus_items (id, name, field, major_no, major, middle_no, middle) values (1, ?, ?, 1, ?, 4, ?)')
      .run('会計と財務', 'ストラテジ系', '企業と法務', '事業の指標')
    sqlite.prepare('insert into topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count) values (?, ?, 1, 0, ?, NULL, 3)').run(TOPIC, '原価計算', '説明')
  }
  /** その学びに本人の記録がすでにある状態。 */
  const seedExistingPerson = (id: string, person = PERSON) => {
    sqlite.prepare('insert into users (id, email, name, password_hash, role) values (?, ?, ?, ?, ?)').run(id, person.email, person.name, 'not-used-for-login', 'MEMBER')
  }

  beforeEach(async () => {
    db = await learningD1()
    sqlite = sqliteOf(db)
    env = { EXAM: 'ip', JWT_SECRET: 'test-secret', DB: db, ...PORTAL } as unknown as Bindings
  })

  afterEach(() => {
    restore()
    restore = () => {}
  })

  describe('REQ-191 記録の無い本人が使えるコードで戻る', () => {
    // @covers REQ-191#person-record-created
    it('まなびばが換えた本人のメールと名前で本人の記録が 1 つ作られ、返るトークンの本人はその記録を指す', async () => {
      ;({ restore } = fakePortal(replyPerson()))
      const res = await signIn()
      expect(res.status).toBe(200)
      const body = (await res.json()) as TokenAndUser
      expect(body.token).toBeTruthy()
      expect(body.user).toMatchObject({ name: PERSON.name, role: 'MEMBER' })
      const rows = users()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ email: PERSON.email, name: PERSON.name, role: 'MEMBER' })
      expect(body.user.id).toBe(rows[0].id)
    })
  })

  describe('REQ-192 同じメールの記録がある本人が戻る', () => {
    // @covers REQ-192#existing-record-reused
    it('同じメールの記録があれば新しい記録を作らず、その記録の本人としてトークンを渡す', async () => {
      seedExistingPerson('u-existing')
      ;({ restore } = fakePortal(replyPerson()))
      const res = await signIn()
      expect(res.status).toBe(200)
      const body = (await res.json()) as TokenAndUser
      expect(body.user.id).toBe('u-existing')
      expect(users()).toHaveLength(1)
    })

    // @covers REQ-192#progress-carried-over
    it('それまでに積まれた理解度と受験履歴が、渡されたトークンの本人の物として見える', async () => {
      seedTopic()
      seedExistingPerson('u-existing')
      sqlite.prepare('insert into progress (user_id, topic_id, status) values (?, ?, 3)').run('u-existing', TOPIC)
      sqlite
        .prepare("insert into sessions (id, user_id, kind, status, scope_label, question_count, correct_count, finished_at) values ('s-1', 'u-existing', 'mock', 'finished', '全範囲のランダム', 10, 7, unixepoch())")
        .run()
      ;({ restore } = fakePortal(replyPerson()))
      const res = await signIn()
      expect(res.status).toBe(200)
      const { token, user } = (await res.json()) as TokenAndUser
      const home = await me(token)
      expect(home.user.id).toBe(user.id)
      expect(home.topics.understood, '引き継いだ理解度が見えない').toBe(1)
      const owner = sqlite.prepare("select user_id from sessions where id = 's-1'").get() as { user_id: string }
      expect(owner.user_id, '受験履歴の持ち主がトークンの本人と違う').toBe(user.id)
    })
  })

  describe('REQ-193 コードが換えられないまま戻る', () => {
    // @covers REQ-193#no-person-record
    it.each([
      ['まなびばが断った（401）', replyRefusal(401), { code: CODE }],
      ['まなびばが断った（403）', replyRefusal(403), { code: CODE }],
      ['コードが無い', replyPerson(), {}],
      ['コードが空', replyPerson(), { code: '' }],
      ['コードが形を満たさない（上限の 1 つ先、101 文字）', replyPerson(), { code: 'a'.repeat(101) }],
    ])('%s とき、トークンを渡さず本人の記録も作らない', async (label, reply, body) => {
      ;({ restore } = fakePortal(reply))
      const res = await app.request('/api/auth/sso', json(body), env)
      expect(res.status, label).toBeGreaterThanOrEqual(400)
      expect((await res.json()) as Record<string, unknown>, label).not.toHaveProperty('token')
      expect(users(), `${label}: 本人の記録が作られた`).toEqual([])
    })
  })

  describe('REQ-196 通るトークンの要求は、返す内容と積む記録を同じ本人にそろえる', () => {
    // @covers REQ-196#same-person-in-response-and-records
    it('本人のトークンで積んだ理解度は本人の記録に残り、本人のホームにだけ数えられる', async () => {
      seedTopic()
      ;({ restore } = fakePortal(replyPerson()))
      const yudai = (await (await signIn()).json()) as TokenAndUser
      restore()
      ;({ restore } = fakePortal(replyPerson(OTHER_PERSON)))
      const hanako = (await (await signIn()).json()) as TokenAndUser
      expect(hanako.user.id, '仕込み: 2 人目が同じ本人になった').not.toBe(yudai.user.id)

      const recorded = await app.request(`/api/topics/${TOPIC}/progress`, { method: 'PUT', headers: withToken(yudai.token), body: JSON.stringify({ status: 3 }) }, env)
      expect(recorded.status).toBe(200)
      const rows = sqlite.prepare('select user_id from progress where topic_id = ?').all(TOPIC) as Array<{ user_id: string }>
      expect(rows.map((r) => r.user_id)).toEqual([yudai.user.id])
      const homeYudai = await me(yudai.token)
      const homeHanako = await me(hanako.token)
      expect(homeYudai.user.id).toBe(yudai.user.id)
      expect(homeYudai.topics.understood).toBe(1)
      expect(homeHanako.user.id).toBe(hanako.user.id)
      expect(homeHanako.topics.understood, '別の本人のホームに記録が数えられた').toBe(0)
    })
  })

  describe('REQ-205 認証の形の問い合わせ', () => {
    // @covers REQ-205#no-portal-config
    it('まなびばの場所が無い配備では sso が false・portal が null で、受け持つ学びは答える', async () => {
      const res = await app.request('/api/auth/config', {}, { EXAM: 'ip', JWT_SECRET: 'test-secret', DB: db } as unknown as Bindings)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sso: false, portal: null, app: 'ip' })
    })
  })

  describe('REQ-206 まなびばの場所はあるが共有秘密が無い配備', () => {
    // @covers REQ-206#no-fallback-to-password
    it('学び側のパスワードでのログインと登録には戻さず（404）、交換の断りもパスワードを案内しない', async () => {
      const noShared = { EXAM: 'ip', JWT_SECRET: 'test-secret', DB: db, SSO_PORTAL_URL: PORTAL.SSO_PORTAL_URL } as unknown as Bindings
      const portal = fakePortal(replyPerson())
      restore = portal.restore
      const login = await app.request('/api/auth/login', json({ email: PERSON.email, password: 'harunokaze8' }), noShared)
      expect(login.status, 'パスワードでのログインに戻された').toBe(404)
      const register = await app.request('/api/auth/register', json({ email: PERSON.email, password: 'harunokaze8', name: PERSON.name }), noShared)
      expect(register.status, '登録に戻された').toBe(404)
      const exchange = await app.request('/api/auth/sso', json({ code: CODE }), noShared)
      expect(exchange.status).toBe(503)
      const body = (await exchange.json()) as { error: string }
      expect(body.error, '断りがパスワードの経路を案内している').not.toMatch(/パスワード/)
      expect(portal.calls, 'まなびばを呼んだ').toEqual([])
      expect(users()).toEqual([])
    })
  })

  describe('REQ-207 まなびばの場所が無い配備は交換を受け付けない', () => {
    // @covers REQ-207#no-portal-refuses-exchange
    it('使い捨てコードの交換は 404 の {error} で、まなびばを呼ばずトークンも本人の記録も作らない', async () => {
      const portal = fakePortal(replyPerson())
      restore = portal.restore
      const res = await app.request('/api/auth/sso', json({ code: CODE }), { EXAM: 'ip', JWT_SECRET: 'test-secret', DB: db } as unknown as Bindings)
      expect(res.status).toBe(404)
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(['code', 'error'])
      expect(String(body.error)).toMatch(JAPANESE)
      expect(portal.calls).toEqual([])
      expect(users()).toEqual([])
    })
  })

  describe('REQ-208 まなびばに届かない', () => {
    // @covers REQ-208#retry-hinted
    it('502 の断りに、もう一度試せることが書かれている', async () => {
      ;({ restore } = fakePortal(replyUnreachable()))
      const res = await signIn()
      expect(res.status).toBe(502)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/もう一度|再度|しばらく|やり直|時間をおいて|再試行/)
    })

    // @covers REQ-208#no-person-record
    it('届かなかったとき、トークンを渡さず本人の記録も作らない', async () => {
      ;({ restore } = fakePortal(replyUnreachable()))
      const res = await signIn()
      expect(res.status).toBe(502)
      expect(await res.json()).not.toHaveProperty('token')
      expect(users()).toEqual([])
    })
  })
})
