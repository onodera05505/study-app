import { examOf } from '../shared/exam'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { sql } from 'drizzle-orm'
import { readToken } from './lib/auth'
import type { Bindings, Variables } from './lib/db'
import { getDb, getSecret } from './lib/db'
import { authRoutes } from './routes/auth'
import { catalogRoutes } from './routes/catalog'
import { sessionRoutes } from './routes/sessions'
import { feedbackRoutes } from './routes/feedback'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

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

const api = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// @implements REQ-213, REQ-260
api.get('/health', (c) => c.json({ ok: true }))

api.route('/auth', authRoutes)

/** 認証。/api/auth/* 以外は Bearer トークンを要求する。
 *  @implements REQ-196, REQ-223, REQ-255, BR-001, BR-002
 */
api.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/health') return next()
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const payload = token ? await readToken(getSecret(c.env), token) : null
  if (!payload) return c.json({ error: 'ログインが必要です' }, 401)
  c.set('user', { id: payload.sub, name: payload.name, role: payload.role })

  // その日に「動きがあった」ことを記録する。ホームを開いたときだけでなく、
  // どの画面を触っても記録する。23:00 に始めて 0:01 まで続けた場合、
  // 0時をまたいだあとの操作が1つでもあれば、その日も1日として数える。
  // @implements REQ-270
  const db = getDb(c.env)
  await db.run(sql`
    INSERT INTO daily_visits (user_id, day) VALUES (${payload.sub}, ${jstDay(new Date())})
    ON CONFLICT(user_id, day) DO NOTHING
  `)

  await next()
})

// @implements REQ-043, REQ-044, REQ-271, REQ-272, BR-030
api.get('/me', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id

  const topics = await db.get<{ total: number; understood: number; partly: number }>(sql`
    SELECT (SELECT COUNT(*) FROM topics) AS total,
           SUM(CASE WHEN p.status = 3 THEN 1 ELSE 0 END) AS understood,
           SUM(CASE WHEN p.status = 2 THEN 1 ELSE 0 END) AS partly
      FROM progress p WHERE p.user_id = ${userId}
  `)
  const recent = await db.all(sql`
    SELECT id, kind, scope_label AS scopeLabel, question_count AS questionCount,
           correct_count AS correctCount, finished_at AS finishedAt
      FROM sessions
     WHERE user_id = ${userId} AND status = 'completed'
     ORDER BY finished_at DESC LIMIT 5
  `)
  // 「頻出なのに、まだ理解できていない」論点。最短合格の次の一手。
  const next = await db.all(sql`
    SELECT t.id AS id, t.term AS term, t.question_count AS questionCount, s.field AS field
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      LEFT JOIN progress p ON p.topic_id = t.id AND p.user_id = ${userId}
     WHERE COALESCE(p.status, 1) < 3 AND t.question_count > 0
     ${examOf(c.env.EXAM).roadmap ? sql`ORDER BY COALESCE(t.sort_order, 999999) ASC, t.term` : sql`ORDER BY t.question_count DESC, t.term`}
     LIMIT 10
  `)
  // 記録そのものは認証ミドルウェアで入れている。ここでは集計するだけ。
  const today = jstDay(new Date())
  const visitRows = await db.all<{ day: string }>(sql`
    SELECT day FROM daily_visits WHERE user_id = ${userId} ORDER BY day DESC LIMIT 400
  `)
  const days = visitRows.map((r) => r.day)

  return c.json({
    user: c.get('user'),
    topics: {
      total: topics?.total ?? 0,
      understood: topics?.understood ?? 0,
      partly: topics?.partly ?? 0,
    },
    recentSessions: recent,
    nextTopics: next,
    visits: {
      today,
      streak: streakFrom(days, today),
      longest: longestStreak(days),
      total: days.length,
    },
  })
})

/** 日本時間の暦日を YYYY-MM-DD で返す。 */
function jstDay(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function shiftDay(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + delta * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

/** 今日から遡って何日続いているか。今日の記録は必ず入っている前提。 */
function streakFrom(days: string[], today: string): number {
  const set = new Set(days)
  let n = 0
  let cursor = today
  while (set.has(cursor)) {
    n += 1
    cursor = shiftDay(cursor, -1)
  }
  return n
}

/** これまでの最長記録。途切れても「戻ってきた」ことが分かるように出す。 */
function longestStreak(days: string[]): number {
  const sorted = [...days].sort()
  let best = 0
  let run = 0
  let prev: string | null = null
  for (const d of sorted) {
    run = prev && shiftDay(prev, 1) === d ? run + 1 : 1
    best = Math.max(best, run)
    prev = d
  }
  return best
}

api.route('/', catalogRoutes)
api.route('/sessions', sessionRoutes)
api.route('/feedback', feedbackRoutes)

app.route('/api', api)

// @implements REQ-258, BR-002
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  // 内部エラーの詳細は返さない。ログには残す。
  console.error('unhandled error', err)
  return c.json({ error: 'サーバでエラーが発生しました' }, 500)
})

// @implements REQ-256
app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: '見つかりません' }, 404)
  // SPA のルーティングは assets 側の single-page-application 設定に委ねる。
  // ASSETS が返す Response はヘッダが immutable で、後段の secureHeaders が
  // 書き込もうとして落ちる。複製して可変にしてから返す。
  const res = await c.env.ASSETS.fetch(c.req.raw)
  return new Response(res.body, res)
})

export default app
