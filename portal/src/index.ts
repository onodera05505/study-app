/** まなびば — 認証と権限の正本（要件 §15、2026-09-17）。
 *
 *  学び（ip / ap / itc / mkt）は別の Pages・別の D1 のまま。ここがアカウント（メール一意）と「誰がどの学びを見られるか」を持ち、
 *  学び側は `/sso/start` → 使い捨てコード → `/api/sso/exchange`（共有秘密）でメールと名前を受け取って自分のトークンを出す。
 *  管理（一覧・作成・権限の付け外し・パスワード再設定）は役割 ADMIN だけ。統計や CSV は作らない。
 *
 *  パスワードのハッシュは学び側と同じ関数（PBKDF2、100,000 回）。既存アカウントのハッシュをそのまま移せる。 */
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import { hashPassword, verifyPassword } from '../../src/server/lib/auth'
import learnings from './learnings.json'

type Bindings = { DB: D1Database; ASSETS: Fetcher; SSO_SECRET?: string }
type Account = { id: string; email: string; name: string; role: string; password_hash?: string }
type Variables = { account: Account }

type Learning = { key: string; brand: string; url: string; kind: string; desc: string }
const LEARNINGS = learnings as Learning[]
const learningOf = (key: string) => LEARNINGS.find((l) => l.key === key)

const SESSION_COOKIE = 'mb_session'
const SESSION_DAYS = 30
const CODE_TTL_SEC = 120
const now = () => Math.floor(Date.now() / 1000)
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// @implements REQ-035
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
  }),
)

// ---- セッション ---------------------------------------------------------

async function accountOf(env: Bindings, sessionId: string | undefined): Promise<Account | null> {
  if (!sessionId) return null
  const row = await env.DB.prepare(
    `SELECT a.id, a.email, a.name, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(sessionId, now())
    .first<Account>()
  return row ?? null
}

async function grantsOf(env: Bindings, accountId: string): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT learning FROM grants WHERE account_id = ? ORDER BY learning`).bind(accountId).all<{ learning: string }>()
  return (rows.results ?? []).map((r) => r.learning)
}

async function openSession(c: any, accountId: string) {
  const id = crypto.randomUUID()
  const exp = now() + SESSION_DAYS * 86400
  await c.env.DB.prepare(`INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)`).bind(id, accountId, exp).run()
  // Secure は https のときだけ（ローカルの http では Cookie が返らず、ログインしたのに未ログインに見える。2026-09-17 のリハーサル）
  setCookie(c, SESSION_COOKIE, id, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 })
}

const api = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// @implements REQ-047
api.get('/health', (c) => c.json({ ok: true }))

/** 学びの一覧（公開。URL は公開情報。合言葉や秘密は含めない） */
// @implements REQ-045
api.get('/learnings', (c) => c.json({ learnings: LEARNINGS.map(({ key, brand, kind, desc }) => ({ key, brand, kind, desc })) }))

// @implements REQ-001
api.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { email?: string; password?: string } | null
  const email = (body?.email ?? '').trim().toLowerCase()
  const password = body?.password ?? ''
  if (!emailOk(email) || !password) return c.json({ error: 'メールアドレスとパスワードを入れてください' }, 400)
  if (password.length > 200) return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401)
  const acc = await c.env.DB.prepare(`SELECT id, email, name, role, password_hash FROM accounts WHERE email = ?`).bind(email).first<Account>()
  const ok = acc && (await verifyPassword(password, acc.password_hash!))
  if (!acc || !ok) return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401)
  await openSession(c, acc.id)
  return c.json({ account: { id: acc.id, email: acc.email, name: acc.name, role: acc.role }, grants: await grantsOf(c.env, acc.id) })
})

/** 学び側サーバが使い捨てコードをメールと名前に交換する（共有秘密）。権限は交換時にも見る。 */
// @implements REQ-003
api.post('/sso/exchange', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: string; app?: string; secret?: string } | null
  if (!c.env.SSO_SECRET || !body?.secret || body.secret !== c.env.SSO_SECRET) return c.json({ error: '不正な要求です' }, 403)
  if (!body.code || !body.app || !learningOf(body.app)) return c.json({ error: '入力が正しくありません' }, 400)
  const row = await c.env.DB.prepare(
    `SELECT s.code, s.account_id, s.learning, s.expires_at, s.used_at, a.email, a.name
       FROM sso_codes s JOIN accounts a ON a.id = s.account_id WHERE s.code = ?`,
  )
    .bind(body.code)
    .first<{ code: string; account_id: string; learning: string; expires_at: number; used_at: number | null; email: string; name: string }>()
  if (!row || row.learning !== body.app || row.used_at || row.expires_at < now()) return c.json({ error: 'コードが無効です。もう一度ログインしてください' }, 401)
  const grant = await c.env.DB.prepare(`SELECT 1 AS ok FROM grants WHERE account_id = ? AND learning = ?`).bind(row.account_id, body.app).first()
  if (!grant) return c.json({ error: 'この学びの権限がありません' }, 403)
  await c.env.DB.prepare(`UPDATE sso_codes SET used_at = ? WHERE code = ?`).bind(now(), body.code).run()
  return c.json({ email: row.email, name: row.name })
})

// 以降はログインが要る
api.use('*', async (c, next) => {
  const acc = await accountOf(c.env, getCookie(c, SESSION_COOKIE))
  if (!acc) return c.json({ error: 'ログインが必要です' }, 401)
  c.set('account', acc)
  await next()
})

// @implements REQ-009
api.post('/logout', async (c) => {
  const sid = getCookie(c, SESSION_COOKIE)
  if (sid) await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run()
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

// @implements REQ-046, REQ-009
api.get('/me', async (c) => {
  const a = c.get('account')
  return c.json({ account: a, grants: await grantsOf(c.env, a.id) })
})

// @implements REQ-009
api.post('/me/password', async (c) => {
  const a = c.get('account')
  const body = (await c.req.json().catch(() => null)) as { current?: string; next?: string } | null
  if (!body?.current || !body?.next) return c.json({ error: '現在のパスワードと新しいパスワードを入れてください' }, 400)
  if (body.next.length < 8 || body.next.length > 200) return c.json({ error: '新しいパスワードは 8 文字以上 200 文字以内にしてください' }, 400)
  const row = await c.env.DB.prepare(`SELECT password_hash FROM accounts WHERE id = ?`).bind(a.id).first<{ password_hash: string }>()
  if (!row || !(await verifyPassword(body.current, row.password_hash))) return c.json({ error: '現在のパスワードが違います' }, 401)
  await c.env.DB.prepare(`UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?`).bind(await hashPassword(body.next), now(), a.id).run()
  return c.json({ ok: true })
})

// ---- 管理（ADMIN だけ） ------------------------------------------------------

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>()
admin.use('*', async (c, next) => {
  if (c.get('account').role !== 'ADMIN') return c.json({ error: '管理者だけが使えます' }, 403)
  await next()
})

// @implements REQ-007
admin.get('/accounts', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.name, a.role, a.created_at AS createdAt,
            (SELECT GROUP_CONCAT(g.learning) FROM grants g WHERE g.account_id = a.id) AS grants
       FROM accounts a ORDER BY a.created_at`,
  ).all<{ id: string; email: string; name: string; role: string; createdAt: number; grants: string | null }>()
  return c.json({ accounts: (rows.results ?? []).map((r) => ({ ...r, grants: r.grants ? r.grants.split(',').sort() : [] })) })
})

const validGrants = (g: unknown): string[] | null => {
  if (!Array.isArray(g)) return null
  const keys = g.filter((x): x is string => typeof x === 'string')
  return keys.every((k) => learningOf(k)) ? [...new Set(keys)] : null
}

// @implements REQ-007
admin.post('/accounts', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { email?: string; name?: string; password?: string; grants?: unknown; role?: string } | null
  const email = (body?.email ?? '').trim().toLowerCase()
  const name = (body?.name ?? '').trim()
  const grants = validGrants(body?.grants ?? [])
  if (!emailOk(email)) return c.json({ error: 'メールアドレスの形式が正しくありません' }, 400)
  if (!name || name.length > 50) return c.json({ error: '名前を 50 文字以内で入れてください' }, 400)
  if (!body?.password || body.password.length < 8 || body.password.length > 200) return c.json({ error: '初期パスワードは 8 文字以上 200 文字以内にしてください' }, 400)
  if (!grants) return c.json({ error: '権限の学びが正しくありません' }, 400)
  const role = body?.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'
  const dup = await c.env.DB.prepare(`SELECT id FROM accounts WHERE email = ?`).bind(email).first()
  if (dup) return c.json({ error: 'このメールアドレスは登録済みです' }, 409)
  const id = crypto.randomUUID()
  const stmts = [c.env.DB.prepare(`INSERT INTO accounts (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)`).bind(id, email, name, await hashPassword(body.password), role)]
  for (const g of grants) stmts.push(c.env.DB.prepare(`INSERT INTO grants (account_id, learning, granted_by) VALUES (?, ?, ?)`).bind(id, g, c.get('account').id))
  await c.env.DB.batch(stmts)
  return c.json({ id, email, name, role, grants }, 201)
})

// @implements REQ-007, REQ-008
admin.put('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { name?: string; role?: string; grants?: unknown } | null
  const target = await c.env.DB.prepare(`SELECT id, role FROM accounts WHERE id = ?`).bind(id).first<{ id: string; role: string }>()
  if (!target) return c.json({ error: 'アカウントが見つかりません' }, 404)
  const stmts: D1PreparedStatement[] = []
  if (typeof body?.name === 'string') {
    const name = body.name.trim()
    if (!name || name.length > 50) return c.json({ error: '名前を 50 文字以内で入れてください' }, 400)
    stmts.push(c.env.DB.prepare(`UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?`).bind(name, now(), id))
  }
  if (typeof body?.role === 'string') {
    if (id === c.get('account').id && body.role !== 'ADMIN') return c.json({ error: '自分の管理者権限は外せません' }, 400)
    stmts.push(c.env.DB.prepare(`UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?`).bind(body.role === 'ADMIN' ? 'ADMIN' : 'MEMBER', now(), id))
  }
  if (body?.grants !== undefined) {
    const grants = validGrants(body.grants)
    if (!grants) return c.json({ error: '権限の学びが正しくありません' }, 400)
    stmts.push(c.env.DB.prepare(`DELETE FROM grants WHERE account_id = ?`).bind(id))
    for (const g of grants) stmts.push(c.env.DB.prepare(`INSERT INTO grants (account_id, learning, granted_by) VALUES (?, ?, ?)`).bind(id, g, c.get('account').id))
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

// @implements REQ-007
admin.post('/accounts/:id/password', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { password?: string } | null
  if (!body?.password || body.password.length < 8 || body.password.length > 200) return c.json({ error: '新しいパスワードは 8 文字以上 200 文字以内にしてください' }, 400)
  const r = await c.env.DB.prepare(`UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?`).bind(await hashPassword(body.password), now(), id).run()
  if (!r.meta.changes) return c.json({ error: 'アカウントが見つかりません' }, 404)
  // 再設定したら開いているセッションは切る
  await c.env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?`).bind(id).run()
  return c.json({ ok: true })
})

// @implements REQ-007, REQ-008
admin.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  if (id === c.get('account').id) return c.json({ error: '自分は削除できません' }, 400)
  const r = await c.env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id).run()
  if (!r.meta.changes) return c.json({ error: 'アカウントが見つかりません' }, 404)
  return c.json({ ok: true })
})

api.route('/admin', admin)
app.route('/api', api)

// ---- SSO の入口（ブラウザが来る） ----------------------------------------------

// @implements REQ-002
app.get('/sso/start', async (c) => {
  const key = c.req.query('app') ?? ''
  const learning = learningOf(key)
  if (!learning) return c.text('知らない学びです', 400)
  const acc = await accountOf(c.env, getCookie(c, SESSION_COOKIE))
  if (!acc) return c.redirect(`/?next=${encodeURIComponent(`/sso/start?app=${key}`)}`)
  const grant = await c.env.DB.prepare(`SELECT 1 AS ok FROM grants WHERE account_id = ? AND learning = ?`).bind(acc.id, key).first()
  if (!grant) return c.redirect(`/?denied=${encodeURIComponent(key)}`)
  const code = crypto.randomUUID()
  await c.env.DB.prepare(`INSERT INTO sso_codes (code, account_id, learning, expires_at) VALUES (?, ?, ?, ?)`).bind(code, acc.id, key, now() + CODE_TTL_SEC).run()
  return c.redirect(`${learning.url}/sso/callback?code=${encodeURIComponent(code)}`)
})

// 残りは静的ファイル（SPA）。ASSETS の応答はヘッダーが変更不可なので、写してから返す。
// そのまま返すと secureHeaders がヘッダーを足そうとして TypeError（Can't modify immutable headers）→ 画面が全部 500。
// ローカルの wrangler dev では再現せず、本番だけで落ちた（2026-09-17。API は Hono が作る応答なので無事だった）
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  return new Response(res.body, res)
})

export default app
