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

authRoutes.post('/register', async (c) => {
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

authRoutes.post('/login', async (c) => {
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
