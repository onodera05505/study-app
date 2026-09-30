import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Bindings, Variables } from '../lib/db'
import { getDb } from '../lib/db'

/** 利用者からのフィードバック（要件 §5.5-4、2026-09-16）。
 *
 *  受け取って DB に置くだけ。その場で AI は応答しない（API 費用と品質の制御は開発側で行う）。
 *  取り出しと処理済みの印は scripts/feedback.py（開発側）。利用者向けの一覧 API は作らない。 */
export const feedbackRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const body = z.object({
  body: z.string().trim().min(1, '本文を入れてください').max(2000, '2,000 字以内にしてください'),
  // good=良かった / improve=改善の提案 / other=その他（画面で選ばせる。本人 2026-09-18）。
  // text・unclear は前の版で入った行の値。読み出し側が落ちないよう受け付けたままにする
  kind: z.enum(['text', 'unclear', 'good', 'improve', 'other']).default('text'),
  page: z.string().max(200).optional(),
  topicId: z.number().int().positive().optional(),
  questionId: z.string().max(64).optional(),
})

/** 1 人が 1 日に送れる件数。連打や誤操作で表が埋まるのを防ぐだけの上限。 */
const DAILY_LIMIT = 20

// @implements-old REQ-030, REQ-274, REQ-275
feedbackRoutes.post('/', async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    // 本文の欠け・長さは利用者が直せるので具体に。それ以外（型違い・不正な kind）は他の経路と同じ固定文
    // （zod の既定メッセージは英語で、そのまま画面に出る。受入の所見 2026-09-16）
    const issue = parsed.error.issues[0]
    const onBody = issue?.path?.[0] === 'body' && issue.code !== 'invalid_type'
    return c.json({ error: onBody ? issue.message : '入力が正しくありません' }, 400)
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
