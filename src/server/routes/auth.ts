import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { schema } from '../lib/db'
import type { Bindings, Variables } from '../lib/db'
import { getDb, getSecret } from '../lib/db'
import { hashPassword, issueToken, verifyPassword } from '../lib/auth'

const credentials = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
})

const registration = credentials.extend({
  name: z.string().min(1).max(50),
  signupCode: z.string().max(100).optional(),
})

/** 検証エラーを項目名つきの文にする。「入力が正しくありません」だけだと、合言葉を疑って詰まる
 *  （実際はメールアドレスに `.` が無かった。2026-09-15）。 */
const FIELD_LABEL: Record<string, string> = {
  email: 'メールアドレスの形式が正しくありません（例: name@example.com）',
  password: 'パスワードは 8 文字以上にしてください',
  name: 'お名前を入力してください（50 文字まで）',
  signupCode: '合言葉が長すぎます',
}
function validationMessage(err: z.ZodError): string {
  const field = String(err.issues[0]?.path?.[0] ?? '')
  return FIELD_LABEL[field] ?? '入力が正しくありません'
}

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/** SSO（まなびば。要件 §15）が設定された環境か。設定されていればパスワードのログイン・登録は受けない。 */
// 秘密が欠けても「開く」側（パスワード登録の復活）に倒さない。URL があれば SSO 環境と見なし、秘密が無ければ /auth/sso が 503 で止まる（受入の所見 2026-09-17、D17）
const ssoOn = (env: Bindings) => !!env.SSO_PORTAL_URL

/** 画面がログインの形を決めるための設定（公開）。 */
// @implements REQ-205
authRoutes.get('/config', (c) => c.json({ sso: ssoOn(c.env), portal: c.env.SSO_PORTAL_URL ?? null, app: c.env.EXAM }))

/** まなびばから戻ってきた使い捨てコードを、まなびばのサーバでメールと名前に交換し、この学びのトークンを出す。 */
// @implements REQ-191, REQ-192, REQ-193, REQ-206, REQ-207, REQ-208
authRoutes.post('/sso', async (c) => {
  if (!ssoOn(c.env)) return c.json({ error: 'この環境では SSO が設定されていません' }, 404)
  if (!c.env.SSO_SECRET) return c.json({ error: 'SSO の共有秘密が設定されていません。管理者に連絡してください' }, 503)
  const body = (await c.req.json().catch(() => null)) as { code?: string } | null
  if (!body?.code || typeof body.code !== 'string' || body.code.length > 100) return c.json({ error: '入力が正しくありません' }, 400)
  let res: Response
  try {
    res = await fetch(`${c.env.SSO_PORTAL_URL!.replace(/\/$/, '')}/api/sso/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: body.code, app: c.env.EXAM, secret: c.env.SSO_SECRET }),
    })
  } catch {
    return c.json({ error: 'まなびばに繋がりませんでした。もう一度お試しください' }, 502)
  }
  const data = (await res.json().catch(() => null)) as { email?: string; name?: string; error?: string } | null
  if (!res.ok || !data?.email) return c.json({ error: data?.error ?? 'ログインに失敗しました。まなびばからやり直してください' }, res.status === 403 ? 403 : 401)

  const db = getDb(c.env)
  const email = data.email.trim().toLowerCase()
  let user = await db.query.users.findFirst({ where: eq(schema.users.email, email) })
  if (!user) {
    // この学びでは初めての人。パスワード列は使わない印（sso）。進捗・受験履歴はこの行に付く
    user = { id: crypto.randomUUID(), email, name: (data.name ?? email).slice(0, 50), passwordHash: 'sso', role: 'MEMBER', createdAt: Math.floor(Date.now() / 1000) }
    await db.insert(schema.users).values(user)
  }
  const token = await issueToken(getSecret(c.env), user)
  return c.json({ token, user: { id: user.id, name: user.name, role: user.role } })
})

// @implements REQ-204
authRoutes.post('/register', async (c) => {
  if (ssoOn(c.env)) return c.json({ error: 'アカウントはまなびばで作ります' }, 404)
  const parsed = registration.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: validationMessage(parsed.error) }, 400)
  const { email, password, name, signupCode } = parsed.data

  // 身内向けなので合言葉方式。未設定なら誰でも登録できる。
  // 「入れ忘れた」と「間違えた」は直す手が違うので、文言を分ける
  // （入力欄が「設定されている場合のみ」なので、空のまま送る人がいる）。
  if (c.env.SIGNUP_CODE && signupCode !== c.env.SIGNUP_CODE) {
    return c.json({ error: signupCode ? '合言葉が違います' : '合言葉を入力してください' }, 403)
  }

  const db = getDb(c.env)
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email) })
  if (existing) return c.json({ error: 'このメールアドレスは登録済みです' }, 409)

  const user = {
    id: crypto.randomUUID(),
    email,
    name,
    passwordHash: await hashPassword(password),
    role: 'MEMBER',
  }
  await db.insert(schema.users).values(user)
  const token = await issueToken(getSecret(c.env), user)
  return c.json({ token, user: { id: user.id, name: user.name, role: user.role } }, 201)
})

// @implements REQ-204
authRoutes.post('/login', async (c) => {
  if (ssoOn(c.env)) return c.json({ error: 'まなびばからログインしてください' }, 404)
  const parsed = credentials.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: validationMessage(parsed.error) }, 400)

  const db = getDb(c.env)
  const user = await db.query.users.findFirst({
    where: eq(schema.users.email, parsed.data.email),
  })
  // メールの存在有無を答えで漏らさないよう、失敗時のメッセージは共通にする
  const ok = user && (await verifyPassword(parsed.data.password, user.passwordHash))
  if (!user || !ok) return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401)

  const token = await issueToken(getSecret(c.env), user)
  return c.json({ token, user: { id: user.id, name: user.name, role: user.role } })
})
