import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Bindings, Variables } from '../lib/db'
import { getDb, schema } from '../lib/db'
import { explanationOf, type ExplanationColumns } from '../lib/explanations'
import { buildQuestions, snapshotOf } from '../lib/session-builder'
import { examOf } from '../../shared/exam'

export const sessionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// @implements BR-005
async function settings(db: ReturnType<typeof getDb>, env: Bindings) {
  const row = await db.query.appSettings.findFirst()
  // 既定値は試験ごとに違う（IT パスポート 100問120分 / 応用情報 午前 80問150分）。
  // app_settings に行があればそちらが優先。
  const e = examOf(env.EXAM)
  return (
    row ?? {
      id: 'default',
      drillSize: 10,
      mockSize: e.mockSize,
      mockTimeLimitSec: e.mockMinutes * 60,
      passOverallPct: 60,
      passFieldPct: 30,
      masteredStreak: 3,
      updatedAt: 0,
    }
  )
}

const createBody = z.object({
  kind: z.enum(['drill', 'field', 'middle', 'review', 'mock']),
  topicId: z.number().int().optional(),
  field: z.string().optional(),
  middleNo: z.number().int().optional(),
  exam: z.string().optional(),
  size: z.number().int().min(1).max(100).optional(),
})

// @implements REQ-050, REQ-055, REQ-057, REQ-105, REQ-109, BR-017
// @implements-old REQ-193, REQ-203, REQ-204, REQ-023
sessionRoutes.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: '入力が正しくありません' }, 400)
  const body = parsed.data

  const db = getDb(c.env)
  const userId = c.get('user').id

  // 進行中のセッションは1つまで。放置されたものが新規開始を塞がないよう、
  // 既存があれば内容を返して選ばせる（前身アプリ は 409 で止まるだけだった）。
  const running = await db.query.sessions.findFirst({
    where: and(eq(schema.sessions.userId, userId), eq(schema.sessions.status, 'in_progress')),
  })
  if (running) {
    return c.json({ error: '進行中のセッションがあります', inProgress: running }, 409)
  }

  const cfg = await settings(db, c.env)
  const size =
    body.size ?? (body.kind === 'mock' ? cfg.mockSize : body.kind === 'drill' ? cfg.drillSize : 20)

  const built = await buildQuestions(db, userId, {
    kind: body.kind,
    topicId: body.topicId,
    field: body.field,
    middleNo: body.middleNo,
    exam: body.exam,
    size,
    masteredStreak: cfg.masteredStreak,
    fieldRatio: examOf(c.env.EXAM).fieldRatio,
  })
  if (built.questions.length === 0) {
    return c.json({ error: '出題できる問題がありません' }, 400)
  }

  const sessionId = crypto.randomUUID()
  const timeLimit = body.kind === 'mock' ? cfg.mockTimeLimitSec : null

  await db.insert(schema.sessions).values({
    id: sessionId,
    userId,
    kind: body.kind,
    status: 'in_progress',
    sourceExam: built.sourceExam,
    scopeLabel: built.scopeLabel,
    timeLimitSec: timeLimit,
    questionCount: built.questions.length,
  })
  const rows = built.questions.map((q, idx) => ({
    id: crypto.randomUUID(),
    sessionId,
    questionId: q.id,
    idx,
    snapshot: JSON.stringify(snapshotOf(q)),
  }))
  // D1 は1文あたりのバインド変数が100個まで。1行6個なので16行ずつに割る。
  // 過去問実践は100問なので、まとめて1文にすると必ず超える。
  const CHUNK = 16
  const statements = []
  for (let i = 0; i < rows.length; i += CHUNK) {
    statements.push(db.insert(schema.sessionQuestions).values(rows.slice(i, i + CHUNK)))
  }
  if (statements.length === 1) {
    await statements[0]
  } else {
    await db.batch(statements as [typeof statements[0], ...typeof statements])
  }

  return c.json(
    {
      id: sessionId,
      kind: body.kind,
      scopeLabel: built.scopeLabel,
      questionCount: built.questions.length,
      timeLimitSec: timeLimit,
    },
    201,
  )
})

/** 進行中のセッション。中断からの復帰に使う。 */
// @implements BR-015
// @implements-old REQ-025
sessionRoutes.get('/current', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const s = await db.query.sessions.findFirst({
    where: and(eq(schema.sessions.userId, userId), eq(schema.sessions.status, 'in_progress')),
  })
  if (!s) return c.json({ session: null })
  const answered = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM session_questions WHERE session_id = ${s.id} AND result <> 0`,
  )
  return c.json({ session: { ...s, answered: answered?.n ?? 0 } })
})

/** 進行中のセッションを破棄する。 */
// @implements REQ-085, REQ-090
// @implements-old REQ-231
sessionRoutes.delete('/current', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const s = await db.query.sessions.findFirst({
    where: and(eq(schema.sessions.userId, userId), eq(schema.sessions.status, 'in_progress')),
  })
  if (!s) return c.json({ ok: true })
  await db.delete(schema.sessions).where(eq(schema.sessions.id, s.id))
  return c.json({ ok: true })
})

// 他人のセッション ID は 404 になる（user_id で絞る）。
// @implements REQ-076, BR-018
// @implements-old REQ-026
async function loadSession(db: ReturnType<typeof getDb>, userId: string, id: string) {
  return db.query.sessions.findFirst({
    where: and(eq(schema.sessions.id, id), eq(schema.sessions.userId, userId)),
  })
}

/** 制限時間を超えていないか。超えていれば自動的に締める。 */
function isExpired(s: { timeLimitSec: number | null; startedAt: number }): boolean {
  if (!s.timeLimitSec) return false
  return Date.now() / 1000 > s.startedAt + s.timeLimitSec
}

/** 現在の問題（未回答の最小 idx）。 */
// @implements REQ-058, REQ-060, REQ-071, REQ-111, REQ-116, REQ-117, BR-021
// @implements-old REQ-196, REQ-214
sessionRoutes.get('/:id/current', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const s = await loadSession(db, userId, c.req.param('id'))
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404)

  const q = await db.get<{ idx: number; snapshot: string }>(sql`
    SELECT idx, snapshot FROM session_questions
     WHERE session_id = ${s.id} AND result = 0
     ORDER BY idx LIMIT 1
  `)
  const answered = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM session_questions WHERE session_id = ${s.id} AND result <> 0`,
  )

  const remainingSec = s.timeLimitSec
    ? Math.max(0, Math.round(s.startedAt + s.timeLimitSec - Date.now() / 1000))
    : null

  if (!q || isExpired(s)) {
    return c.json({
      session: s,
      question: null,
      finished: true,
      expired: isExpired(s),
      answered: answered?.n ?? 0,
      remainingSec,
    })
  }

  const snap = JSON.parse(q.snapshot)
  return c.json({
    session: {
      id: s.id,
      kind: s.kind,
      scopeLabel: s.scopeLabel,
      questionCount: s.questionCount,
      // 通し受験（kind='mock' かつ回の指定あり）は原本どおり全問出しているので、
      // 画面側で「同一の問題が n 回…」を出さない。その判別に使う。
      sourceExam: s.sourceExam,
    },
    question: {
      idx: q.idx,
      text: snap.text,
      choices: snap.choices,
      citation: snap.citation,
      modified: snap.modified ?? false,
      hasFigure: snap.hasFigure,
      figureDescription: snap.figureDescription,
      figureImage: snap.figureImage ?? null,
      // 古いスナップショットには入っていないので既定値を置く
      timesAsked: snap.timesAsked ?? 1,
      otherCitations: snap.otherCitations ?? [],
    },
    answered: answered?.n ?? 0,
    remainingSec,
    finished: false,
  })
})

const answerBody = z.object({
  idx: z.number().int().min(0),
  answer: z.enum(['ア', 'イ', 'ウ', 'エ']),
})

/** 1問回答する。採点は**出題時スナップショット**に対して行う。 */
// @implements REQ-061, REQ-064, REQ-066, REQ-067, REQ-072, REQ-119, BR-020, BR-022, BR-023
// @implements-old REQ-199, REQ-205, REQ-207, REQ-223
sessionRoutes.post('/:id/answer', async (c) => {
  const parsed = answerBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: '入力が正しくありません' }, 400)

  const db = getDb(c.env)
  const userId = c.get('user').id
  const s = await loadSession(db, userId, c.req.param('id'))
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404)
  if (s.status !== 'in_progress') return c.json({ error: 'このセッションは終了しています' }, 409)
  if (isExpired(s)) return c.json({ error: '制限時間を過ぎています', expired: true }, 409)

  const current = await db.get<{
    id: string
    idx: number
    snapshot: string
  } & ExplanationColumns>(sql`
    SELECT sq.id AS id, sq.idx AS idx, sq.snapshot AS snapshot,
           qe.correct_reason AS explCorrectReason, qe.choices_json AS explChoicesJson
      FROM session_questions sq
      JOIN past_questions q ON q.id = sq.question_id
      LEFT JOIN question_explanations qe ON qe.content_key = q.content_key
     WHERE sq.session_id = ${s.id} AND sq.result = 0
     ORDER BY sq.idx LIMIT 1
  `)
  if (!current) return c.json({ error: '未回答の問題がありません' }, 409)

  // 中断・再開でクライアントとサーバの位置がずれたまま採点すると、
  // 別の問題に答えが記録されてしまう。ずれていたら採点しない。
  if (current.idx !== parsed.data.idx) {
    return c.json({ error: '表示中の問題が最新ではありません', staleQuestion: true, expected: current.idx }, 409)
  }

  const snap = JSON.parse(current.snapshot)
  const correct = snap.answer === parsed.data.answer
  await db
    .update(schema.sessionQuestions)
    .set({
      userAnswer: parsed.data.answer,
      result: correct ? 1 : 2,
      answeredAt: sql`(unixepoch())`,
    })
    .where(eq(schema.sessionQuestions.id, current.id))

  const remaining = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM session_questions WHERE session_id = ${s.id} AND result = 0`,
  )
  // 解説は**答え合わせの応答に載せる**。出題（/current）に載せると、答える前に
  // 正解が読めてしまう。まだ解説が無い問題は null で、画面は今までどおり。
  return c.json({
    correct,
    correctAnswer: snap.answer,
    explanation: explanationOf(current),
    remaining: remaining?.n ?? 0,
    finished: (remaining?.n ?? 0) === 0,
  })
})

/** 集計して締める。分野別の正答率も出す（合否は分野単位の AND 条件のため）。 */
async function finalize(db: ReturnType<typeof getDb>, sessionId: string) {
  const rows = await db.all<{ field: string | null; total: number; correct: number }>(sql`
    SELECT s.field AS field,
           COUNT(*) AS total,
           SUM(CASE WHEN sq.result = 1 THEN 1 ELSE 0 END) AS correct
      FROM session_questions sq
      LEFT JOIN topic_questions tq ON tq.question_id = sq.question_id
      LEFT JOIN topics t ON t.id = tq.topic_id
      LEFT JOIN syllabus_items s ON s.id = t.syllabus_item_id
     WHERE sq.session_id = ${sessionId}
     GROUP BY s.field
  `)
  const total = await db.get<{ total: number; correct: number }>(sql`
    SELECT COUNT(*) AS total, SUM(CASE WHEN result = 1 THEN 1 ELSE 0 END) AS correct
      FROM session_questions WHERE session_id = ${sessionId}
  `)
  return { byField: rows.filter((r) => r.field), total: total ?? { total: 0, correct: 0 } }
}

// @implements REQ-069, REQ-073, REQ-075, BR-024
// @implements-old REQ-202
sessionRoutes.post('/:id/finish', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const s = await loadSession(db, userId, c.req.param('id'))
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404)

  const agg = await finalize(db, s.id)
  if (s.status === 'in_progress') {
    await db
      .update(schema.sessions)
      .set({
        status: 'completed',
        correctCount: agg.total.correct,
        finishedAt: sql`(unixepoch())`,
      })
      .where(eq(schema.sessions.id, s.id))
  }
  return c.json({ ok: true, correct: agg.total.correct, total: agg.total.total })
})

/** 結果の詳細。間違えた問題から論点へ戻れるようにする。 */
// @implements REQ-115, REQ-120, REQ-121, REQ-123
// @implements-old REQ-218, REQ-224, REQ-226
sessionRoutes.get('/:id', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const s = await loadSession(db, userId, c.req.param('id'))
  if (!s) return c.json({ error: 'セッションが見つかりません' }, 404)
  // 終わっていない回の結果は返さない。URL を直に開けば、まだ答えていない問題の
  // 正解と解説がそのまま読めてしまう（過去問実践の途中でも開ける）。
  if (s.status !== 'completed') {
    return c.json({ error: 'このセッションはまだ終了していません' }, 404)
  }

  const cfg = await settings(db, c.env)
  const agg = await finalize(db, s.id)

  const items = await db.all<{
    idx: number
    snapshot: string
    userAnswer: string | null
    result: number
    topicId: number | null
    topicTerm: string | null
  } & ExplanationColumns>(sql`
    SELECT sq.idx AS idx, sq.snapshot AS snapshot, sq.user_answer AS userAnswer,
           sq.result AS result, t.id AS topicId, t.term AS topicTerm,
           qe.correct_reason AS explCorrectReason, qe.choices_json AS explChoicesJson
      FROM session_questions sq
      JOIN past_questions q ON q.id = sq.question_id
      -- 解説は content_key（主キー）で結ぶ。通し受験は100問あるので、
      -- 別クエリにすると往復が増える。ここで一緒に取れば0回で済む。
      LEFT JOIN question_explanations qe ON qe.content_key = q.content_key
      LEFT JOIN topic_questions tq ON tq.question_id = sq.question_id AND tq.is_primary = 1
      LEFT JOIN topics t ON t.id = tq.topic_id
     WHERE sq.session_id = ${s.id}
     ORDER BY sq.idx
  `)

  const overallPct = agg.total.total ? Math.round((agg.total.correct / agg.total.total) * 100) : 0
  const fields = agg.byField.map((f) => ({
    field: f.field as string,
    total: f.total,
    correct: f.correct,
    pct: f.total ? Math.round((f.correct / f.total) * 100) : 0,
  }))
  // 合格条件は試験で違う。
  //   IT パスポート: 総合600点 **かつ** 各分野300点（素点の割合に読み替えた近似）
  //   応用情報 午前: 総合60%のみ。分野ごとの足切りは無い
  // 分野の足切りがある試験で AND を落とすと、落ちる人に受かると言ってしまう。
  // IRT のスコアは再現できないので、画面にもその旨を出す。
  const e = examOf(c.env.EXAM)
  const passed =
    overallPct >= cfg.passOverallPct &&
    (!e.fieldThreshold || fields.every((f) => f.pct >= cfg.passFieldPct))

  // 制限時間のある回で、締めた時刻が期限を過ぎていれば時間切れ。
  // isExpired は「いま」を見るので完了済みの回には使えない（早く終えた回も、
  // 期限の時刻を過ぎれば true になってしまう）。締めた時刻で判定する。
  const expired = !!(
    s.timeLimitSec &&
    s.finishedAt &&
    s.finishedAt >= s.startedAt + s.timeLimitSec
  )

  return c.json({
    session: s,
    overall: { ...agg.total, pct: overallPct },
    fields,
    passed,
    expired,
    criteria: { overallPct: cfg.passOverallPct, fieldPct: cfg.passFieldPct },
    approximation:
      'IPA の合否は項目応答理論（IRT）で算出され換算式が非公開のため、ここでの点数は素点による目安です。',
    items: items.map((i) => {
      const snap = JSON.parse(i.snapshot)
      return {
        idx: i.idx,
        text: snap.text,
        choices: snap.choices,
        answer: snap.answer,
        userAnswer: i.userAnswer,
        result: i.result,
        citation: snap.citation,
        modified: snap.modified ?? false,
        hasFigure: snap.hasFigure,
        figureDescription: snap.figureDescription,
        figureImage: snap.figureImage ?? null,
        // 古いスナップショットには入っていないので既定値を置く
        timesAsked: snap.timesAsked ?? 1,
        otherCitations: snap.otherCitations ?? [],
        topicId: i.topicId,
        topicTerm: i.topicTerm,
        // 模試（通し受験）にも出す。DupBadge は原本どおりの出題を崩すので出さないが、
        // 解説は「なぜ間違えたか」を返すものなので、むしろ模試のほうが要る。
        explanation: explanationOf(i),
      }
    }),
  })
})

/** 受験履歴。 */
// @implements REQ-095, REQ-096, REQ-097
// @implements-old REQ-232
sessionRoutes.get('/', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const rows = await db.all(sql`
    SELECT id, kind, scope_label AS scopeLabel, question_count AS questionCount,
           correct_count AS correctCount, started_at AS startedAt, finished_at AS finishedAt,
           source_exam AS sourceExam
      FROM sessions
     WHERE user_id = ${userId} AND status = 'completed'
     ORDER BY finished_at DESC
     LIMIT 50
  `)
  return c.json({ sessions: rows })
})
