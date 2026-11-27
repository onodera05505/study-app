import { examOf, resolveExam } from '../shared/exam'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { matchedRoutes } from 'hono/route'
import { secureHeaders } from 'hono/secure-headers'
import { sql } from 'drizzle-orm'
import { NOT_CONFIGURED, readToken } from './lib/auth'
import type { Bindings, Variables } from './lib/db'
import { getDb } from './lib/db'
import { getSecret } from './lib/secret'
import { ErrorCode, refuse } from './lib/refusal'
import { nextTopics } from './lib/next-topics'
import { joinStatus, stageOf } from './lib/understanding'
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

/** 学びの key を解決できない配備は、受け持つどの経路（死活確認と認証の形を含む）も、
 *  認証・本文・署名の秘密の断りより先に、設定が無いことに当たる形で断る。
 *  受け持たない経路は notFound へ委ねる。
 *  @implements REQ-354, BR-005
 */
api.use('*', async (c, next) => {
  if (!hasRouteHandler(c)) return next()
  if (!resolveExam(c.env.EXAM)) return refuse(c, ErrorCode.NOT_CONFIGURED, NOT_CONFIGURED)
  return next()
})

// @implements REQ-213, REQ-260
// @operation UC-017#getHealth
api.get('/health', (c) => c.json({ ok: true }))

api.route('/auth', authRoutes)

/** この要求に、経路として登録された具体のハンドラが当たっているか。
 *  Hono は前置き（use で足したもの）も当たった経路として数えるので、
 *  引数を 2 つ以上とる関数＝前置きとして外す（Hono 自身の isMiddleware と同じ判じ方）。
 *  子の Hono が独自の onError を持つときハンドラは包まれるので、包みを剥いでから数える。
 */
function hasRouteHandler(c: Context<{ Bindings: Bindings; Variables: Variables }>): boolean {
  return matchedRoutes(c).some((route) => {
    let handler = route.handler as ((...args: unknown[]) => unknown) & {
      __COMPOSED_HANDLER?: (...args: unknown[]) => unknown
    }
    while (handler.__COMPOSED_HANDLER) handler = handler.__COMPOSED_HANDLER as typeof handler
    return handler.length <= 1
  })
}

/** 認証。/api/auth/* 以外は Bearer トークンを要求する。
 *  署名の秘密が無い配備では、添えられたトークンを読まずに断る（通る／通らないを判じられない）。
 *  受け持たない経路は、秘密の有無もトークンの有無も見ずに notFound へ委ねる。
 *  @implements REQ-196, REQ-223, REQ-255, REQ-275, BR-001, BR-002
 */
api.use('*', async (c, next) => {
  if (!hasRouteHandler(c)) return next()
  if (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/health') return next()
  const secret = getSecret(c.env)
  if (!secret) return refuse(c, ErrorCode.NOT_CONFIGURED, NOT_CONFIGURED)
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const payload = token ? await readToken(secret, token) : null
  if (!payload) return refuse(c, ErrorCode.UNAUTHENTICATED, { error: 'ログインが必要です', status: 401 })
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

// @implements REQ-043, REQ-044, REQ-271, REQ-272, REQ-480
// @operation UC-003#getHomeSummary
api.get('/me', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const roadmap = examOf(c.env.EXAM).roadmap

  // 理解・やや理解の数は論点の一覧と同じ理解度（lib/understanding）で数える
  const stage = stageOf(roadmap)
  const topics = await db.get<{ total: number; understood: number; partly: number }>(sql`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN ${stage} = 3 THEN 1 ELSE 0 END), 0) AS understood,
           COALESCE(SUM(CASE WHEN ${stage} = 2 THEN 1 ELSE 0 END), 0) AS partly
      FROM topics t
      ${joinStatus(userId, roadmap)}
  `)
  const recent = await db.all(sql`
    SELECT id, kind, scope_label AS scopeLabel, question_count AS questionCount,
           correct_count AS correctCount, finished_at AS finishedAt
      FROM sessions
     WHERE user_id = ${userId} AND status = 'completed'
     ORDER BY finished_at DESC LIMIT 5
  `)
  const next = await nextTopics(db, userId, { roadmap, limit: 10 })
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
  // 内部エラーの詳細は返さない。ログには残す。
  console.error('unhandled error', err)
  return refuse(c, ErrorCode.INTERNAL, { error: 'サーバでエラーが発生しました', status: 500 })
})

// @implements REQ-256
app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) return refuse(c, ErrorCode.NOT_FOUND, { error: '見つかりません', status: 404 })
  // SPA のルーティングは assets 側の single-page-application 設定に委ねる。
  // ASSETS が返す Response はヘッダが immutable で、後段の secureHeaders が
  // 書き込もうとして落ちる。複製して可変にしてから返す。
  const res = await c.env.ASSETS.fetch(c.req.raw)
  return new Response(res.body, res)
})

export default app
