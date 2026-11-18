/** まなびば — 認証と権限の正本。
 *
 *  学び（ip / ap / itc / mkt）は別の Pages・別の D1。ここがアカウント（メール一意）と「誰がどの学びを見られるか」を持ち、
 *  学び側は `/sso/start` → 使い捨てコード → `/api/sso/exchange`（共有秘密）でメールと名前を受け取って自分のトークンを出す。
 *  管理（一覧・作成・権限の付け外し・パスワード再設定）は役割 ADMIN だけ。統計や CSV は作らない。
 *
 *  パスワードの記録は `src/server/lib/auth` の 1 か所で作り、照合する。 */
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import { z } from 'zod'
import { hashPassword, verifyPassword } from '../../src/server/lib/auth'
import { ErrorCode, refuse } from '../../src/server/lib/refusal'
import learnings from './learnings.json'

type Bindings = { DB: D1Database; ASSETS: Fetcher; SSO_SECRET?: string }
type Account = { id: string; email: string; name: string; role: string; password_hash?: string }
type Variables = { account: Account }
type AppEnv = { Bindings: Bindings; Variables: Variables }

type Learning = { key: string; brand: string; url: string; kind: string; desc: string }
const LEARNINGS = learnings as Learning[]
const learningOf = (key: string) => LEARNINGS.find((l) => l.key === key)

const SESSION_COOKIE = 'mb_session'
const SESSION_DAYS = 30
const CODE_TTL_SEC = 120
const now = () => Math.floor(Date.now() / 1000)
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

// ---- 本文の検証（zod。文言は日本語で、項目名を入れる） ---------------------------

const NAME_MSG = '名前を 50 文字以内で入れてください'
const GRANTS_MSG = '権限の学びが正しくありません'
const ROLE_MSG = '役割は管理者か利用者のどちらかにしてください'
const NEW_PASSWORD_MSG = '新しいパスワードは 8 文字以上 200 文字以内にしてください'
const LOGIN_MSG = 'メールアドレスとパスワードを入れてください'
const ME_PASSWORD_MSG = '現在のパスワードと新しいパスワードを入れてください'

const zEmail = (message: string) => z.string({ error: message }).trim().toLowerCase().refine(emailOk, message)
const zPassword = (message: string) => z.string({ error: message }).min(8, message).max(200, message)
const zName = (message: string) => z.string({ error: message }).trim().min(1, message).max(50, message)
const zRole = z.enum(['ADMIN', 'MEMBER'], { error: ROLE_MSG })
/** 権限は登録簿にある学びの key だけ。同じ key を 2 回書かれても 1 つに畳む。 */
// @implements REQ-169, BR-004
const zGrants = z
  .array(z.string(), { error: GRANTS_MSG })
  .refine((keys) => keys.every((k) => !!learningOf(k)), GRANTS_MSG)
  .transform((keys) => [...new Set(keys)])

const loginBody = z.object({
  email: zEmail(LOGIN_MSG),
  password: z.string({ error: LOGIN_MSG }).min(1, LOGIN_MSG),
})
// @implements REQ-263, BR-004
const exchangeBody = z.object({
  code: z.string({ error: 'コードが正しくありません' }).min(1, 'コードが正しくありません'),
  app: z.string({ error: '学びの指定が正しくありません' }).min(1, '学びの指定が正しくありません').refine((k) => !!learningOf(k), '知らない学びです'),
})
// @implements REQ-211
const mePasswordBody = z.object({
  current: z.string({ error: ME_PASSWORD_MSG }).min(1, ME_PASSWORD_MSG),
  next: z.string({ error: ME_PASSWORD_MSG }).min(8, NEW_PASSWORD_MSG).max(200, NEW_PASSWORD_MSG),
})
// @implements REQ-177
const accountCreateBody = z.object({
  email: zEmail('メールアドレスの形式が正しくありません'),
  name: zName(NAME_MSG),
  password: zPassword('初期パスワードは 8 文字以上 200 文字以内にしてください'),
  grants: zGrants.default([]),
})
// @implements REQ-178
const accountUpdateBody = z.object({
  name: zName(NAME_MSG).optional(),
  role: zRole.optional(),
  grants: zGrants.optional(),
})
// @implements REQ-179
const passwordResetBody = z.object({ password: zPassword(NEW_PASSWORD_MSG) })

/** 項目の名前。スキーマの文言が日本語でないときの差し替えに使う。 */
const FIELD_LABEL: Record<string, string> = {
  email: 'メールアドレス',
  password: 'パスワード',
  name: 'お名前',
  secret: '合言葉',
  current: '現在のパスワード',
  next: '新しいパスワード',
  code: 'コード',
  app: '学び',
  grants: '権限の学び',
  role: '役割',
}
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

/** 断った理由の 1 文。スキーマの既定の英語の文言は出さず、項目名つきの日本語にする。 */
function validationMessage(err: z.ZodError): string {
  const issue = err.issues[0]
  if (issue && JAPANESE.test(issue.message)) return issue.message
  const label = FIELD_LABEL[String(issue?.path?.[0] ?? '')]
  return label ? `${label}の入力が正しくありません` : '入力が正しくありません'
}

/** POST / PUT の本文はここを通して読む。通った値だけを使い、通らなければ 400 と {error} の日本語を返す。 */
// @implements REQ-257
async function parseBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; res: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return { ok: false, res: refuse(c, ErrorCode.INVALID_INPUT, { error: validationMessage(parsed.error), status: 400 }) }
  return { ok: true, data: parsed.data }
}

const app = new Hono<AppEnv>()

// @implements REQ-259
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
  // Secure は https のときだけ（ローカルの http では Secure の Cookie が返らず、ログインしても未ログインに見える）
  setCookie(c, SESSION_COOKIE, id, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 })
}

const api = new Hono<AppEnv>()

// @implements REQ-213, REQ-260
// @operation UC-017#getHealth
api.get('/health', (c) => c.json({ ok: true }))

/** 学びの一覧（公開。URL は公開情報。合言葉や秘密は含めない） */
// @implements REQ-183
// @operation UC-013#listLearnings
api.get('/learnings', (c) => c.json({ learnings: LEARNINGS.map(({ key, brand, kind, desc }) => ({ key, brand, kind, desc })) }))

// @implements REQ-181, REQ-182
// @operation UC-013#signIn
api.post('/login', async (c) => {
  const p = await parseBody(c, loginBody)
  if (!p.ok) return p.res
  const { email, password } = p.data
  // 長すぎるパスワードは 400 にせず 401（メールが在るか無いかを漏らさない。ハッシュも計算しない）
  if (password.length > 200) return refuse(c, ErrorCode.UNAUTHENTICATED, { error: 'メールアドレスまたはパスワードが違います', status: 401 })
  const acc = await c.env.DB.prepare(`SELECT id, email, name, role, password_hash FROM accounts WHERE email = ?`).bind(email).first<Account>()
  const ok = acc && (await verifyPassword(password, acc.password_hash!))
  if (!acc || !ok) return refuse(c, ErrorCode.UNAUTHENTICATED, { error: 'メールアドレスまたはパスワードが違います', status: 401 })
  await openSession(c, acc.id)
  return c.json({ account: { id: acc.id, email: acc.email, name: acc.name, role: acc.role }, grants: await grantsOf(c.env, acc.id) })
})

/** 学び側サーバが使い捨てコードをメールと名前に交換する（共有秘密）。権限は交換時にも見る。 */
// @implements REQ-200, REQ-201, REQ-202, REQ-203, BR-003, BR-004
// @operation UC-013#exchangeCode
api.post('/sso/exchange', async (c) => {
  // 共有秘密は本文の検証より先に見る（合わなければ 403 で止まり、本文が欠けていても DB も見ない）
  const secret = ((await c.req.json().catch(() => null)) as { secret?: unknown } | null)?.secret
  if (!c.env.SSO_SECRET || typeof secret !== 'string' || secret !== c.env.SSO_SECRET) return refuse(c, ErrorCode.FORBIDDEN, { error: '不正な要求です', status: 403 })
  const p = await parseBody(c, exchangeBody)
  if (!p.ok) return p.res
  const { code, app: learningKey } = p.data
  const row = await c.env.DB.prepare(
    `SELECT s.code, s.account_id, s.learning, s.expires_at, s.used_at, a.email, a.name
       FROM sso_codes s JOIN accounts a ON a.id = s.account_id WHERE s.code = ?`,
  )
    .bind(code)
    .first<{ code: string; account_id: string; learning: string; expires_at: number; used_at: number | null; email: string; name: string }>()
  if (!row || row.learning !== learningKey || row.used_at || row.expires_at < now()) return refuse(c, ErrorCode.UNAUTHENTICATED, { error: 'コードが無効です。もう一度ログインしてください', status: 401 })
  const grant = await c.env.DB.prepare(`SELECT 1 AS ok FROM grants WHERE account_id = ? AND learning = ?`).bind(row.account_id, learningKey).first()
  if (!grant) return refuse(c, ErrorCode.FORBIDDEN, { error: 'この学びの権限がありません', status: 403 })
  await c.env.DB.prepare(`UPDATE sso_codes SET used_at = ? WHERE code = ?`).bind(now(), code).run()
  return c.json({ email: row.email, name: row.name })
})

/** ログインが要る経路。`*` に付けると知らない経路まで 401 になって 404（REQ-302）を隠すので、経路を挙げて囲う。 */
// @implements REQ-223, REQ-255, BR-001
const requireLogin = async (c: Context<AppEnv>, next: Next) => {
  const acc = await accountOf(c.env, getCookie(c, SESSION_COOKIE))
  if (!acc) return refuse(c, ErrorCode.UNAUTHENTICATED, { error: 'ログインが必要です', status: 401 })
  c.set('account', acc)
  await next()
}
for (const path of ['/logout', '/me', '/me/*', '/admin/*']) api.use(path, requireLogin)

// @implements REQ-189
// @operation UC-013#signOut
api.post('/logout', async (c) => {
  const sid = getCookie(c, SESSION_COOKIE)
  if (sid) await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run()
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

// @implements REQ-184
// @operation UC-013#getMe
api.get('/me', async (c) => {
  const a = c.get('account')
  return c.json({ account: a, grants: await grantsOf(c.env, a.id) })
})

// @implements REQ-209, REQ-210, REQ-212, BR-007
// @operation UC-014#changeOwnPassword
api.post('/me/password', async (c) => {
  const a = c.get('account')
  const p = await parseBody(c, mePasswordBody)
  if (!p.ok) return p.res
  const { current, next: newPassword } = p.data
  const row = await c.env.DB.prepare(`SELECT password_hash FROM accounts WHERE id = ?`).bind(a.id).first<{ password_hash: string }>()
  if (!row || !(await verifyPassword(current, row.password_hash))) return refuse(c, ErrorCode.UNAUTHENTICATED, { error: '現在のパスワードが違います', status: 401 })
  await c.env.DB.prepare(`UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?`).bind(await hashPassword(newPassword), now(), a.id).run()
  return c.json({ ok: true })
})

// ---- 管理（ADMIN だけ） ------------------------------------------------------

const admin = new Hono<AppEnv>()
// @implements REQ-176
admin.use('*', async (c, next) => {
  if (c.get('account').role !== 'ADMIN') return refuse(c, ErrorCode.FORBIDDEN, { error: '管理者だけが使えます', status: 403 })
  await next()
})

// @implements REQ-162
// @operation UC-011#listAccounts
admin.get('/accounts', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.name, a.role, a.created_at AS createdAt,
            (SELECT GROUP_CONCAT(g.learning) FROM grants g WHERE g.account_id = a.id) AS grants
       FROM accounts a ORDER BY a.created_at`,
  ).all<{ id: string; email: string; name: string; role: string; createdAt: number; grants: string | null }>()
  return c.json({ accounts: (rows.results ?? []).map((r) => ({ ...r, grants: r.grants ? r.grants.split(',').sort() : [] })) })
})

// @implements REQ-163, REQ-164, REQ-405
// @operation UC-011#createAccount
admin.post('/accounts', async (c) => {
  const p = await parseBody(c, accountCreateBody)
  if (!p.ok) return p.res
  const { email, name, password, grants } = p.data
  // 作成の役割は求めから採らず、いつも利用者にする
  const role = 'MEMBER'
  const dup = await c.env.DB.prepare(`SELECT id FROM accounts WHERE email = ?`).bind(email).first()
  if (dup) return refuse(c, ErrorCode.CONFLICT, { error: 'このメールアドレスは登録済みです', status: 409 })
  const id = crypto.randomUUID()
  const stmts = [c.env.DB.prepare(`INSERT INTO accounts (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)`).bind(id, email, name, await hashPassword(password), role)]
  for (const g of grants) stmts.push(c.env.DB.prepare(`INSERT INTO grants (account_id, learning, granted_by) VALUES (?, ?, ?)`).bind(id, g, c.get('account').id))
  // アカウントと権限は 1 つの書き込みにまとめる（途中で失敗すればどちらも残らない）
  await c.env.DB.batch(stmts)
  return c.json({ id, email, name, role, grants }, 201)
})

/** 管理者を減らす書き込みに添える条件。書き込みの時点で、相手のほかに管理者が残るときだけ真になる。 */
const OTHER_ADMIN_REMAINS = `EXISTS (SELECT 1 FROM accounts WHERE role = 'ADMIN' AND id != ?)`
const LAST_ADMIN_MSG = '最後の管理者は外せません'

// @implements REQ-165, REQ-166, REQ-167, REQ-173, REQ-404, REQ-405, BR-006
// @operation UC-011#updateAccount
admin.put('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  const p = await parseBody(c, accountUpdateBody)
  if (!p.ok) return p.res
  const { name, role, grants } = p.data
  const target = await c.env.DB.prepare(`SELECT id, role FROM accounts WHERE id = ?`).bind(id).first<{ id: string; role: string }>()
  if (!target) return refuse(c, ErrorCode.NOT_FOUND, { error: 'アカウントが見つかりません', status: 404 })
  if (role !== undefined && role !== 'ADMIN' && id === c.get('account').id) return refuse(c, ErrorCode.INVALID_INPUT, { error: '自分の管理者権限は外せません', status: 400 })
  // 降格は、重なった求めが先に書き込んでいても管理者が 0 人にならないときだけ書く。
  // 同じ batch の文すべてに同じ条件を添え、通らなければどの項目も権限も変えない。
  const demotion = role === 'MEMBER'
  const guard = demotion ? ` AND ${OTHER_ADMIN_REMAINS}` : ''
  const guardArgs = demotion ? [id] : []
  const by = c.get('account').id
  const stmts: D1PreparedStatement[] = []
  if (name !== undefined) {
    stmts.push(c.env.DB.prepare(`UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?${guard}`).bind(name, now(), id, ...guardArgs))
  }
  if (grants !== undefined) {
    stmts.push(c.env.DB.prepare(`DELETE FROM grants WHERE account_id = ?${guard}`).bind(id, ...guardArgs))
    for (const g of grants) {
      stmts.push(
        c.env.DB.prepare(`INSERT INTO grants (account_id, learning, granted_by) SELECT ?, ?, ?${demotion ? ` WHERE ${OTHER_ADMIN_REMAINS}` : ''}`).bind(id, g, by, ...guardArgs),
      )
    }
  }
  // 役割の文は最後に置く（管理者の数を変えるのはこの文だけなので、前の文は同じ条件を同じ状態で見る）
  const roleAt = stmts.length
  if (role !== undefined) {
    stmts.push(c.env.DB.prepare(`UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?${guard}`).bind(role, now(), id, ...guardArgs))
  }
  if (!stmts.length) return c.json({ ok: true })
  const results = await c.env.DB.batch(stmts)
  if (role !== undefined && !results[roleAt].meta.changes) {
    const still = await c.env.DB.prepare(`SELECT 1 AS ok FROM accounts WHERE id = ?`).bind(id).first()
    if (!still) return refuse(c, ErrorCode.NOT_FOUND, { error: 'アカウントが見つかりません', status: 404 })
    return refuse(c, ErrorCode.CONFLICT, { error: LAST_ADMIN_MSG, status: 409 })
  }
  return c.json({ ok: true })
})

// @implements REQ-168, REQ-174, REQ-403, REQ-405, BR-007
// @operation UC-011#resetAccountPassword
admin.post('/accounts/:id/password', async (c) => {
  const id = c.req.param('id')
  const p = await parseBody(c, passwordResetBody)
  if (!p.ok) return p.res
  if (id === c.get('account').id) return refuse(c, ErrorCode.INVALID_INPUT, { error: '自分のパスワードはこの操作では変えられません。アカウントの欄から変えてください', status: 400 })
  // パスワードの入れ替えと、その相手の開いているセッションの終わらせは 1 つの書き込みにまとめる
  const [r] = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?`).bind(await hashPassword(p.data.password), now(), id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?`).bind(id),
  ])
  if (!r.meta.changes) return refuse(c, ErrorCode.NOT_FOUND, { error: 'アカウントが見つかりません', status: 404 })
  return c.json({ ok: true })
})

// @implements REQ-170, REQ-172, REQ-175, REQ-404, REQ-405, BR-006
// @operation UC-011#deleteAccount
admin.delete('/accounts/:id', async (c) => {
  const id = c.req.param('id')
  if (id === c.get('account').id) return refuse(c, ErrorCode.INVALID_INPUT, { error: '自分は削除できません', status: 400 })
  // 権限とセッションは外部キーの CASCADE で同じ文の中で消える。管理者の削除は、ほかに管理者が残るときだけ書く
  const r = await c.env.DB.prepare(`DELETE FROM accounts WHERE id = ? AND (role != 'ADMIN' OR ${OTHER_ADMIN_REMAINS})`).bind(id, id).run()
  if (r.meta.changes) return c.json({ ok: true })
  const still = await c.env.DB.prepare(`SELECT 1 AS ok FROM accounts WHERE id = ?`).bind(id).first()
  if (!still) return refuse(c, ErrorCode.NOT_FOUND, { error: 'アカウントが見つかりません', status: 404 })
  return refuse(c, ErrorCode.CONFLICT, { error: LAST_ADMIN_MSG, status: 409 })
})

// @implements REQ-171
api.route('/admin', admin)
app.route('/api', api)

// ---- SSO の入口（ブラウザが来る） ----------------------------------------------

// @implements REQ-185, REQ-186, REQ-187, REQ-188, BR-003, BR-004
// @operation UC-013#startSso
app.get('/sso/start', async (c) => {
  const key = c.req.query('app') ?? ''
  const learning = learningOf(key)
  if (!learning) return refuse(c, ErrorCode.INVALID_INPUT, { text: '知らない学びです', status: 400 })
  const acc = await accountOf(c.env, getCookie(c, SESSION_COOKIE))
  if (!acc) return refuse(c, ErrorCode.UNAUTHENTICATED, { redirect: `/?next=${encodeURIComponent(`/sso/start?app=${key}`)}` })
  const grant = await c.env.DB.prepare(`SELECT 1 AS ok FROM grants WHERE account_id = ? AND learning = ?`).bind(acc.id, key).first()
  if (!grant) return refuse(c, ErrorCode.FORBIDDEN, { redirect: `/?denied=${encodeURIComponent(key)}` })
  const code = crypto.randomUUID()
  await c.env.DB.prepare(`INSERT INTO sso_codes (code, account_id, learning, expires_at) VALUES (?, ?, ?, ?)`).bind(code, acc.id, key, now() + CODE_TTL_SEC).run()
  return c.redirect(`${learning.url}/sso/callback?code=${encodeURIComponent(code)}`)
})

// @implements REQ-258, BR-002
app.onError((err, c) => {
  // 想定していない例外。中身（message・stack）は本文に出さず、ログにだけ残す
  console.error('unhandled error', err)
  return refuse(c, ErrorCode.INTERNAL, { error: 'サーバでエラーが発生しました', status: 500 })
})

// 知らない /api は 404。残りは静的ファイル（SPA）で、画面の経路は assets 側に委ねる。
// ASSETS の応答はヘッダーが変更不可なので、写してから返す。そのまま返すと secureHeaders が
// ヘッダーを足そうとして TypeError（Can't modify immutable headers）になり画面が 500 になる（本番の実行環境だけで起き、ローカルの wrangler dev では起きない）
// @implements REQ-214, REQ-256
app.notFound(async (c) => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return refuse(c, ErrorCode.NOT_FOUND, { error: '見つかりません', status: 404 })
  const res = await c.env.ASSETS.fetch(c.req.raw)
  return new Response(res.body, res)
})

export default app
