import { examOf } from '../../shared/exam'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Bindings, Db, Variables } from '../lib/db'
import { getDb, schema } from '../lib/db'
import { explanationOf, type ExplanationColumns } from '../lib/explanations'
import { frequencyTierOf } from '../lib/frequency-tier'
import { listOrder, listOrderJoin, nextTopics, recommendedOrder } from '../lib/next-topics'
import { joinStatus, stageOf, statusOf, statusSourceOf } from '../lib/understanding'
import { bodyErrorMessage } from '../lib/body-error'
import { compareExam, dedupe } from '../lib/session-builder'

export const catalogRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/** 分野ごとの論点数と理解度の内訳。理解度の段階は lib/understanding が求め、未（unanswered）は資格対策だけが持つ。 */
// @implements REQ-014, BR-029, REQ-480
// @operation UC-002#listFields
catalogRoutes.get('/fields', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const roadmap = examOf(c.env.EXAM).roadmap
  const stage = stageOf(roadmap)
  const rows = await db.all<{
    field: string
    topics: number
    questions: number
    understood: number
    partly: number
    untouched: number
    unanswered: number
  }>(sql`
    SELECT s.field                                       AS field,
           COUNT(*)                                      AS topics,
           COALESCE(SUM(t.question_count), 0)            AS questions,
           SUM(CASE WHEN ${stage} = 3 THEN 1 ELSE 0 END) AS understood,
           SUM(CASE WHEN ${stage} = 2 THEN 1 ELSE 0 END) AS partly,
           SUM(CASE WHEN ${stage} = 1 THEN 1 ELSE 0 END) AS untouched,
           SUM(CASE WHEN ${stage} = 0 THEN 1 ELSE 0 END) AS unanswered
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      ${joinStatus(userId, roadmap)}
     GROUP BY s.field
  `)
  // 試験の並び順（資格版はストラテジ→マネジメント→テクノロジ、ロードマップ型は自前の分野）に揃える
  const order = examOf(c.env.EXAM).fields
  rows.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field))
  return c.json({ fields: rows })
})

/** 分野配下の単元。理解した数は lib/understanding の段階で数える。 */
// @implements REQ-015, REQ-019, REQ-480
// @operation UC-002#listCategories
catalogRoutes.get('/categories', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const roadmap = examOf(c.env.EXAM).roadmap
  const field = c.req.query('field')
  const rows = await db.all<{
    middleNo: number
    middle: string
    major: string
    field: string
    topics: number
    questions: number
    understood: number
  }>(sql`
    SELECT s.middle_no                                    AS middleNo,
           s.middle                                       AS middle,
           s.major                                        AS major,
           s.field                                        AS field,
           COUNT(*)                                       AS topics,
           COALESCE(SUM(t.question_count), 0)             AS questions,
           SUM(CASE WHEN ${stageOf(roadmap)} = 3 THEN 1 ELSE 0 END) AS understood
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      ${joinStatus(userId, roadmap)}
     ${field ? sql`WHERE s.field = ${field}` : sql``}
     GROUP BY s.middle_no, s.middle, s.major, s.field
     ORDER BY s.middle_no
  `)
  return c.json({ categories: rows })
})

const topicQuery = z.object({
  field: z.string().optional(),
  middleNo: z.coerce.number().int().optional(),
  /** 理解度の番号のカンマ区切り。複数を選んで「まだ仕上がっていないものだけ見る」に使う。 */
  status: z.string().optional(),
  /** structure: 学びの種類で決まる一覧の並び（既定）。recommended: おすすめ順。 */
  sort: z.enum(['structure', 'recommended']).default('structure'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

type UnitStructure = { overview: string; groups: { no: number; name: string; description: string }[] }

/** 資格対策の単元の構成（全体像とまとまりの並び）。構成を持たない単元では null。 */
// @implements REQ-475, BR-031
async function unitStructureOf(db: Db, middleNo: number): Promise<UnitStructure | null> {
  const [plan, groups] = await Promise.all([
    db.get<{ overview: string }>(sql`SELECT overview FROM unit_plans WHERE middle_no = ${middleNo}`),
    db.all<{ no: number; name: string; description: string }>(sql`
      SELECT group_no AS no, name, description FROM unit_groups WHERE middle_no = ${middleNo} ORDER BY group_no
    `),
  ])
  if (!plan || groups.length === 0) return null
  return { overview: plan.overview, groups }
}

/** 論点一覧。並びは structure（学びの種類で決まる一覧の並び）か recommended（おすすめ順）。
 *  資格対策で単元を 1 つ指定し structure で並べたときだけ、その単元の構成を添える。 */
// @implements REQ-474, REQ-021, REQ-042, REQ-265, REQ-478, REQ-480, BR-029, BR-031, REQ-279, REQ-282, REQ-413
// @operation UC-002#listTopics
catalogRoutes.get('/topics', async (c) => {
  const parsed = topicQuery.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: '検索条件が正しくありません' }, 400)
  const { field, middleNo, status, sort, limit } = parsed.data

  const db = getDb(c.env)
  const userId = c.get('user').id
  const roadmap = examOf(c.env.EXAM).roadmap

  // 未（0）は資格対策だけの段階。決めた段階の外の値は無視する。
  const lowest = roadmap ? 1 : 0
  const wanted = [
    ...new Set(
      (status ?? '')
        .split(',')
        .filter((x) => x.trim() !== '')
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n >= lowest && n <= 3),
    ),
  ]
  const conditions = [
    field ? sql`AND s.field = ${field}` : sql``,
    middleNo !== undefined ? sql`AND s.middle_no = ${middleNo}` : sql``,
    wanted.length > 0
      ? sql`AND ${stageOf(roadmap)} IN (${sql.join(wanted.map((n) => sql`${n}`), sql`, `)})`
      : sql``,
  ]
  const ordering = sort === 'recommended' ? recommendedOrder(roadmap) : sql`ORDER BY ${listOrder(roadmap)}`

  const structureP =
    !roadmap && middleNo !== undefined && sort === 'structure'
      ? unitStructureOf(db, middleNo)
      : Promise.resolve(null)

  // 資格版の SQL はロードマップ型の列（sort_order・round・round_label・tier・subtitle）を参照せず、
  // ロードマップ型の SQL は単元の構成の表を参照しない。
  const rowsP = db.all<{
    id: number
    term: string
    subtitle: string | null
    questionCount: number
    status: number | null
    statusSource: 'auto' | 'override' | null
    field: string
    middle: string
    itemNo: number | null
    itemName: string
    groupNo: number | null
    isNew: number
    sortOrder: number | null
    round: string | null
    roundLabel: string | null
    tier: number | null
  }>(sql`
    SELECT t.id            AS id,
           t.term          AS term,
           ${roadmap ? sql`t.subtitle` : sql`NULL`} AS subtitle,
           t.question_count AS questionCount,
           ${statusOf(roadmap)} AS status,
           ${statusSourceOf(roadmap)} AS statusSource,
           s.field         AS field,
           s.middle        AS middle,
           ${roadmap ? sql`NULL` : sql`s.id`} AS itemNo,
           s.name          AS itemName,
           ${roadmap ? sql`NULL` : sql`ug.group_no`} AS groupNo,
           t.is_new        AS isNew,
           ${roadmap ? sql`t.sort_order` : sql`NULL`} AS sortOrder,
           ${roadmap ? sql`t.round` : sql`NULL`} AS round,
           ${roadmap ? sql`t.round_label` : sql`NULL`} AS roundLabel,
           ${roadmap ? sql`t.tier` : sql`NULL`} AS tier
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      ${joinStatus(userId, roadmap)}
      ${listOrderJoin(roadmap)}
     WHERE 1 = 1 ${conditions[0]} ${conditions[1]} ${conditions[2]}
     ${ordering}
     LIMIT ${limit}
  `)
  const [structure, rows] = await Promise.all([structureP, rowsP])
  return c.json({
    structure,
    topics: rows.map((r) => ({
      ...r,
      frequencyTier: frequencyTierOf(r.questionCount, roadmap),
      // まとまりの番号は単元の構成を添えたときだけ意味を持つ
      groupNo: structure ? r.groupNo : null,
    })),
  })
})

type TopicLinkRow = { id: number; term: string; questionCount: number }

/** 論点の詳細。教材と、その論点が出題された過去問と、前提の論点と、同じまとまり（構成の無い単元では同じ小項目）の他の論点。 */
// @implements REQ-023, REQ-045, REQ-478, REQ-479, REQ-480, REQ-483, REQ-284, REQ-413
// @operation UC-002#getTopicDetail
catalogRoutes.get('/topics/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '不正な ID です' }, 400)

  const db = getDb(c.env)
  const userId = c.get('user').id
  const roadmap = examOf(c.env.EXAM).roadmap

  // D1 は 1 クエリごとに往復が要るので、論点を待たずに引けるものは同時に投げる。
  const topicP = db.get<{
    id: number
    term: string
    subtitle: string | null
    explanation: string | null
    detail: string | null
    questionCount: number
    isNew: number
    status: number | null
    statusSource: 'auto' | 'override' | null
    field: string
    major: string
    middle: string
    middleNo: number
    itemName: string
    tier: number | null
  }>(sql`
    SELECT t.id AS id, t.term AS term, ${roadmap ? sql`t.subtitle` : sql`NULL`} AS subtitle,
           t.explanation AS explanation, t.detail AS detail,
           t.question_count AS questionCount, t.is_new AS isNew,
           ${statusOf(roadmap)} AS status, ${statusSourceOf(roadmap)} AS statusSource,
           ${roadmap ? sql`t.tier` : sql`NULL`} AS tier,
           s.field AS field, s.major AS major, s.middle AS middle, s.name AS itemName,
           s.middle_no AS middleNo
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      ${joinStatus(userId, roadmap)}
     WHERE t.id = ${id}
  `)
  const questionsP = db.all<{
    id: string
    number: number
    examLabel: string
    text: string
    choices: string
    answer: string
    hasFigure: number
    figureDescription: string | null
    figureImage: string | null
    citation: string
    modified: number
    contentKey: string | null
    exam: string
  } & ExplanationColumns>(sql`
    SELECT q.id AS id, q.number AS number, q.exam_label AS examLabel, q.text AS text,
           q.choices AS choices, q.answer AS answer, q.has_figure AS hasFigure,
           q.figure_description AS figureDescription, q.figure_image AS figureImage,
           q.citation AS citation, q.modified AS modified,
           q.content_key AS contentKey, q.exam AS exam,
           qe.correct_reason AS explCorrectReason, qe.choices_json AS explChoicesJson
      FROM topic_questions tq
      JOIN past_questions q ON q.id = tq.question_id
      -- 問題ごとの解説は content_key（主キー）で結ぶので行は増えない
      LEFT JOIN question_explanations qe ON qe.content_key = q.content_key
     WHERE tq.topic_id = ${id}
     ORDER BY q.exam DESC, q.number
  `)

  // 同じまとまりの他の論点を一覧の並びで。論点が単元の構成のまとまりに入っていなければ同じ小項目の他の論点。
  // ロードマップ型は同じ小項目の他の論点を出題頻度の順に 8 件まで。
  const siblingsP: Promise<TopicLinkRow[]> = roadmap
    ? db.all<TopicLinkRow>(sql`
        SELECT id, term, question_count AS questionCount
          FROM topics
         WHERE syllabus_item_id = (SELECT syllabus_item_id FROM topics WHERE id = ${id})
           AND id <> ${id}
         ORDER BY question_count DESC
         LIMIT 8
      `)
    : db.all<TopicLinkRow>(sql`
        WITH me AS (
          SELECT t0.syllabus_item_id AS item, u0.middle_no AS mno, u0.group_no AS gno
            FROM topics t0 LEFT JOIN unit_group_topics u0 ON u0.topic_id = t0.id
           WHERE t0.id = ${id}
        )
        SELECT t.id AS id, t.term AS term, t.question_count AS questionCount
          FROM topics t
          JOIN syllabus_items s ON s.id = t.syllabus_item_id
          ${listOrderJoin(false)}
          JOIN me
         WHERE t.id <> ${id}
           AND CASE WHEN me.gno IS NULL THEN t.syllabus_item_id = me.item
                    ELSE ug.middle_no = me.mno AND ug.group_no = me.gno END
         ORDER BY ${listOrder(false)}
      `)

  // 前提の論点は資格対策の単元の構成だけが持つ。書かれた順に返す。
  // @implements REQ-479
  const prerequisitesP: Promise<TopicLinkRow[]> = roadmap
    ? Promise.resolve([])
    : db.all<TopicLinkRow>(sql`
        SELECT t.id AS id, t.term AS term, t.question_count AS questionCount
          FROM topic_prerequisites tp
          JOIN topics t ON t.id = tp.prerequisite_topic_id
         WHERE tp.topic_id = ${id}
         ORDER BY tp.position
      `)

  // 「次に学ぶ」の先頭。いま開いている論点自身は除く。尽きたら null。
  const nextP = nextTopics(db, userId, { roadmap, limit: 1, exclude: id }).then((rows) => rows[0])

  // ロードマップ型: 学ぶ順の前後（sort_order）。資格版は sort_order を参照しない（D13）ので null。
  const neighborsP: Promise<{ prev: { id: number; term: string } | null; next: { id: number; term: string } | null } | null> = roadmap
    ? Promise.all([
        db.get<{ id: number; term: string }>(sql`
          SELECT id, term FROM topics
           WHERE sort_order IS NOT NULL AND sort_order < (SELECT sort_order FROM topics WHERE id = ${id})
           ORDER BY sort_order DESC LIMIT 1`),
        db.get<{ id: number; term: string }>(sql`
          SELECT id, term FROM topics
           WHERE sort_order IS NOT NULL AND sort_order > (SELECT sort_order FROM topics WHERE id = ${id})
           ORDER BY sort_order ASC LIMIT 1`),
      ]).then(([prev, next]) => ({ prev: prev ?? null, next: next ?? null }))
    : Promise.resolve(null)

  const [topic, questions, siblings, prerequisites, next, neighbors] = await Promise.all([
    topicP,
    questionsP,
    siblingsP,
    prerequisitesP,
    nextP,
    neighborsP,
  ])
  if (!topic) return c.json({ error: '論点が見つかりません' }, 404)

  const link = (r: TopicLinkRow) => ({
    id: r.id,
    term: r.term,
    questionCount: r.questionCount,
    frequencyTier: frequencyTierOf(r.questionCount, roadmap),
  })

  // 同一内容の過去問は 1 枚にまとめ、代表に件数と他の出典を付ける（出題頻度は重複を数えたまま）。
  // 並びは新しい回が先。SQL の ORDER BY q.exam は辞書順で同じ年の春（h）と秋（a）が逆になるので compareExam で並べ直す。
  const deduped = dedupe(questions).sort(
    (x, y) => compareExam(y.exam, x.exam) || x.number - y.number,
  )

  return c.json({
    topic: { ...topic, frequencyTier: frequencyTierOf(topic.questionCount, roadmap) },
    // まだ解説が無い問題は explanation が null
    questions: deduped.map((q) => ({
      ...q,
      choices: JSON.parse(q.choices),
      explanation: explanationOf(q),
    })),
    prerequisites: prerequisites.map(link),
    siblings: siblings.map(link),
    nextTopic: next ? link(next) : null,
    // ロードマップ型だけ。学ぶ順の前後の単位（資格版は null）
    neighbors,
  })
})

const progressBody = z.object({ status: z.number().int().min(1).max(3) })

/** 理解度の記録（未理解 / やや理解 / 理解）。 */
// @implements REQ-034, REQ-035, REQ-036, REQ-037, REQ-268
// @operation UC-003#recordUnderstanding
catalogRoutes.put('/topics/:id/progress', async (c) => {
  const id = Number(c.req.param('id'))
  const raw = await c.req.json().catch(() => null)
  const parsed = progressBody.safeParse(raw)
  if (!Number.isInteger(id)) return c.json({ error: '論点の番号が正しくありません' }, 400)
  if (!parsed.success) return c.json({ error: bodyErrorMessage(parsed.error, raw, { status: '理解度' }) }, 400)
  const db = getDb(c.env)
  const userId = c.get('user').id
  // 存在しない論点は 404（外部キー違反で 500 にしない）
  const exists = await db.get<{ id: number }>(sql`SELECT id FROM topics WHERE id = ${id}`)
  if (!exists) return c.json({ error: '論点が見つかりません' }, 404)
  await db
    .insert(schema.progress)
    .values({ userId, topicId: id, status: parsed.data.status })
    .onConflictDoUpdate({
      target: [schema.progress.userId, schema.progress.topicId],
      set: { status: parsed.data.status, updatedAt: sql`(unixepoch())` },
    })
  return c.json({ ok: true, status: parsed.data.status })
})

/** 用語集。本文中の `[[用語]]` を押したときに出すポップの中身。
 *
 *  数百語あるが1語が1行なので全部返す。画面側はアプリを開いている間に1度だけ取り、
 *  以降はメモリから引く（用語ごとに問い合わせると、1画面で何十回も往復する）。
 *  中身が変わるのは seed を入れ直したときだけなので、長めにキャッシュしてよい。 */
// @implements REQ-002
// @operation UC-001#getGlossary
catalogRoutes.get('/glossary', async (c) => {
  const db = getDb(c.env)
  const rows = await db.all<{ term: string; brief: string; topicId: number | null }>(sql`
    SELECT term, brief, topic_id AS topicId FROM glossary ORDER BY term
  `)
  // 個人ごとの内容ではないが、ログインしている人にしか返らない経路なので private。
  c.header('Cache-Control', 'private, max-age=3600')
  return c.json({ glossary: rows })
})

/** 過去問の一覧（回ごと）。過去問実践の入口で使う。 */
// @implements REQ-102, BR-038
// @operation UC-008#listExams
catalogRoutes.get('/exams', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const rows = await db.all<{
    exam: string
    examLabel: string
    questions: number
    attempts: number
    bestScore: number | null
  }>(sql`
    SELECT q.exam            AS exam,
           q.exam_label      AS examLabel,
           COUNT(*)          AS questions,
           (SELECT COUNT(*) FROM sessions se
             WHERE se.user_id = ${userId} AND se.source_exam = q.exam AND se.status = 'completed')
                             AS attempts,
           (SELECT MAX(se.correct_count) FROM sessions se
             WHERE se.user_id = ${userId} AND se.source_exam = q.exam AND se.status = 'completed')
                             AS bestScore
      FROM past_questions q
     GROUP BY q.exam, q.exam_label
     ORDER BY q.exam ASC
  `)
  // ロードマップ型は最初の回から順に並べる。資格版は新しい回が先で、同じ年度は
  // 秋期（a）・10 月（o）・特別（tokubetsu）・春期（h）の順。順位は SEASON_RANK が持つ。
  if (!examOf(c.env.EXAM).roadmap) rows.sort((x, y) => compareExam(y.exam, x.exam))
  return c.json({ exams: rows })
})
