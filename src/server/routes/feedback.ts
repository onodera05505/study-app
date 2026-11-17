import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Bindings, Variables } from '../lib/db'
import { getDb } from '../lib/db'
import { bodyErrorMessage } from '../lib/body-error'

/** 利用者からのフィードバック。
 *
 *  受け取って DB に置くだけ。その場で AI は応答しない（API 費用と品質の制御は開発側で行う）。
 *  取り出しと処理済みの印は scripts/feedback.py（開発側）。利用者向けの一覧 API は作らない。 */
export const feedbackRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const body = z.object({
  body: z.string().trim().min(1, '本文を入れてください').max(2000, '2,000 字以内にしてください'),
  // good=良かった / improve=改善の提案 / other=その他（画面で選ばせる）。
  // text・unclear は既に残っている行が持つ値で、受け付けたままにする。種類の無い送信は断る
  kind: z.enum(['text', 'unclear', 'good', 'improve', 'other']),
  page: z.string().max(200).optional(),
  topicId: z.number().int().positive().optional(),
  questionId: z.string().max(64).optional(),
})

/** 1 人が 1 日に送れる件数。連打や誤操作で表が埋まるのを防ぐだけの上限。 */
const DAILY_LIMIT = 20

// @implements REQ-159, REQ-160, REQ-161
// @operation UC-010#submitFeedback
feedbackRoutes.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null)
  const parsed = body.safeParse(raw)
  if (!parsed.success) {
    // 本文の欠け・長さは利用者が直せるので具体の文。それ以外は満たされていない項目を日本語の名前で指す
    // （zod の既定の文言は英語なので出さない）
    const issue = parsed.error.issues[0]
    const onBody = issue?.path?.[0] === 'body' && issue.code !== 'invalid_type'
    const reason = onBody
      ? issue.message
      : bodyErrorMessage(parsed.error, raw, { body: '本文', kind: '種類', page: 'ページ', topicId: '論点', questionId: '問題' })
    return c.json({ error: reason }, 400)
  }
  const db = getDb(c.env)
  const userId = c.get('user').id
  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60
  const recent = await db.get<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM feedback WHERE user_id = ${userId} AND created_at >= ${since}
  `)
  if ((recent?.n ?? 0) >= DAILY_LIMIT) {
    return c.json({ error: '本日の送信は上限に達しました。明日またお願いします' }, 429)
  }
  const id = crypto.randomUUID()
  const v = parsed.data
  await db.run(sql`
    INSERT INTO feedback (id, user_id, kind, page, topic_id, question_id, body)
    VALUES (${id}, ${userId}, ${v.kind}, ${v.page ?? null}, ${v.topicId ?? null}, ${v.questionId ?? null}, ${v.body})
  `)
  return c.json({ id }, 201)
})
