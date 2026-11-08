import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { schema } from '../lib/db'
import type { Bindings, Variables } from '../lib/db'
import { getDb, getSecret } from '../lib/db'
import { NOT_CONFIGURED, issueToken } from '../lib/auth'
import { bodyErrorMessage } from '../lib/body-error'

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/** SSO（まなびば）が設定された環境か。判定はまなびばの場所の有無だけ。
 *  学び側のパスワードでのログイン・登録の経路は持たず、どの配備でも受け持たない経路の断り（REQ-256）になる。 */
const ssoOn = (env: Bindings) => !!env.SSO_PORTAL_URL

/** 画面がログインの形を決めるための設定（公開）。 */
// @implements REQ-205
authRoutes.get('/config', (c) => c.json({ sso: ssoOn(c.env), portal: c.env.SSO_PORTAL_URL ?? null, app: c.env.EXAM }))

const ssoBody = z.object({ code: z.string().min(1).max(100) })

/** まなびばから戻ってきた使い捨てコードを、まなびばのサーバでメールと名前に交換し、この学びのトークンを出す。 */
// @implements REQ-191, REQ-192, REQ-193, REQ-206, REQ-207, REQ-208, REQ-274, BR-002
authRoutes.post('/sso', async (c) => {
  const secret = getSecret(c.env)
  if (!secret) return c.json(NOT_CONFIGURED.body, NOT_CONFIGURED.status)
  if (!ssoOn(c.env)) return c.json({ error: 'この環境では SSO が設定されていません' }, 404)
  if (!c.env.SSO_SECRET) return c.json(NOT_CONFIGURED.body, NOT_CONFIGURED.status)
  const raw = await c.req.json().catch(() => null)
  const parsed = ssoBody.safeParse(raw)
  if (!parsed.success) return c.json({ error: bodyErrorMessage(parsed.error, raw, { code: 'コード' }) }, 400)
  const body = parsed.data
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
  const token = await issueToken(secret, user)
  return c.json({ token, user: { id: user.id, name: user.name, role: user.role } })
})
