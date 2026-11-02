import { examOf } from '../../shared/exam'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Bindings, Variables } from '../lib/db'
import { getDb, schema } from '../lib/db'
import { explanationOf, type ExplanationColumns } from '../lib/explanations'
import { compareExam, dedupe } from '../lib/session-builder'

export const catalogRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

/** 分野ごとの論点数と理解度の内訳。トップ画面の骨格になる。 */
// @implements REQ-014
catalogRoutes.get('/fields', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
  const rows = await db.all<{
    field: string
    topics: number
    questions: number
    understood: number
    partly: number
    untouched: number
  }>(sql`
    SELECT s.field                                        AS field,
           COUNT(*)                                       AS topics,
           COALESCE(SUM(t.question_count), 0)             AS questions,
           SUM(CASE WHEN p.status = 3 THEN 1 ELSE 0 END)  AS understood,
           SUM(CASE WHEN p.status = 2 THEN 1 ELSE 0 END)  AS partly,
           SUM(CASE WHEN p.status IS NULL THEN 1 ELSE 0 END) AS untouched
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      LEFT JOIN progress p ON p.topic_id = t.id AND p.user_id = ${userId}
     GROUP BY s.field
  `)
  // 試験の並び順（資格版はストラテジ→マネジメント→テクノロジ、ロードマップ型は自前の分野）に揃える
  const order = examOf(c.env.EXAM).fields
  rows.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field))
  return c.json({ fields: rows })
})

/** 分野配下の中分類。テーマ分けの中間階層。 */
// @implements REQ-015, REQ-019
catalogRoutes.get('/categories', async (c) => {
  const db = getDb(c.env)
  const userId = c.get('user').id
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
           SUM(CASE WHEN p.status = 3 THEN 1 ELSE 0 END)  AS understood
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      LEFT JOIN progress p ON p.topic_id = t.id AND p.user_id = ${userId}
     ${field ? sql`WHERE s.field = ${field}` : sql``}
     GROUP BY s.middle_no, s.middle, s.major, s.field
     ORDER BY s.middle_no
  `)
  return c.json({ categories: rows })
})

const topicQuery = z.object({
  field: z.string().optional(),
  middleNo: z.coerce.number().int().optional(),
  /** 理解度。カンマ区切りで複数指定できる（例: status=1,2 で「未理解＋やや理解」）。
   *  1つしか選べないと「まだ仕上がっていないものだけ見る」ができない。 */
  status: z.string().optional(),
  /** frequency: 出題頻度順（既定）。最短合格の並び順。 */
  sort: z.enum(['frequency', 'name', 'recommended']).default('frequency'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

/** 論点一覧。既定は出題頻度の降順＝最短合格の優先順位そのもの。 */
// @implements REQ-020, REQ-021, REQ-042, REQ-265, BR-029, BR-031, REQ-279, REQ-282
catalogRoutes.get('/topics', async (c) => {
  const parsed = topicQuery.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: '検索条件が正しくありません' }, 400)
  const { field, middleNo, status, sort, limit } = parsed.data

  const db = getDb(c.env)
  const userId = c.get('user').id

  // 進捗が無い論点は status が NULL。未理解（1）として扱う。
  const wanted = (status ?? '')
    .split(',')
    .map((x) => Number(x))
    .filter((n) => n >= 1 && n <= 3)
  const conditions = [
    field ? sql`AND s.field = ${field}` : sql``,
    middleNo ? sql`AND s.middle_no = ${middleNo}` : sql``,
    wanted.length > 0 && wanted.length < 3
      ? sql`AND COALESCE(p.status, 1) IN (${sql.join(wanted.map((n) => sql`${n}`), sql`, `)})`
      : sql``,
  ]
  // recommended = 「頻出なのに、まだ理解できていない」順。これが最短経路の実体。
  // ロードマップ型は出題頻度が一定（確認問題 2 問）なので、学ぶ順（sort_order）で並べる。
  // 資格版の SQL はロードマップ型の列（sort_order・round・round_label・tier）を参照しない。
  const byRoadmap = examOf(c.env.EXAM).roadmap
  const ordering =
    sort === 'name'
      ? sql`ORDER BY t.term`
      : sort === 'recommended'
        ? byRoadmap
          ? sql`ORDER BY COALESCE(p.status, 1) ASC, COALESCE(t.sort_order, 999999) ASC, t.term`
          : sql`ORDER BY COALESCE(p.status, 1) ASC, t.question_count DESC, t.term`
        : byRoadmap
          ? sql`ORDER BY COALESCE(t.sort_order, 999999) ASC, t.term`
          : sql`ORDER BY t.question_count DESC, t.term`

  const rows = await db.all<{
    id: number
    term: string
    questionCount: number
    status: number | null
    field: string
    middle: string
    itemName: string
    isNew: number
    sortOrder: number | null
    round: string | null
    roundLabel: string | null
    tier: number | null
  }>(sql`
    SELECT t.id            AS id,
           t.term          AS term,
           t.question_count AS questionCount,
           p.status        AS status,
           s.field         AS field,
           s.middle        AS middle,
           s.name          AS itemName,
           t.is_new        AS isNew,
           ${byRoadmap ? sql`t.sort_order` : sql`NULL`} AS sortOrder,
           ${byRoadmap ? sql`t.round` : sql`NULL`} AS round,
           ${byRoadmap ? sql`t.round_label` : sql`NULL`} AS roundLabel,
           ${byRoadmap ? sql`t.tier` : sql`NULL`} AS tier
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      LEFT JOIN progress p ON p.topic_id = t.id AND p.user_id = ${userId}
     WHERE 1 = 1 ${conditions[0]} ${conditions[1]} ${conditions[2]}
     ${ordering}
     LIMIT ${limit}
  `)
  return c.json({ topics: rows })
})

/** 論点の詳細。解説・周辺知識と、その論点が出題された過去問。 */
// @implements REQ-023, REQ-045, BR-030, REQ-284
catalogRoutes.get('/topics/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '不正な ID です' }, 400)

  const db = getDb(c.env)
  const userId = c.get('user').id
  const roadmap = examOf(c.env.EXAM).roadmap

  // D1 は1クエリごとに往復が要る。直列に await すると往復の回数だけ待たされるので、
  // 3本を同時に投げる。siblings は論点の項目 ID が要るが、サブクエリで引けば
  // topic の結果を待たなくて済む。
  const topicP = db.get<{
    id: number
    term: string
    explanation: string | null
    detail: string | null
    questionCount: number
    isNew: number
    status: number | null
    field: string
    major: string
    middle: string
    middleNo: number
    itemName: string
    syllabusItemId: number
    tier: number | null
  }>(sql`
    SELECT t.id AS id, t.term AS term, t.explanation AS explanation, t.detail AS detail,
           t.question_count AS questionCount, t.is_new AS isNew, p.status AS status,
           ${roadmap ? sql`t.tier` : sql`NULL`} AS tier,
           s.field AS field, s.major AS major, s.middle AS middle, s.name AS itemName,
           s.middle_no AS middleNo,
           s.id AS syllabusItemId
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      LEFT JOIN progress p ON p.topic_id = t.id AND p.user_id = ${userId}
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
      -- 問題ごとの解説。content_key（主キー）で結ぶので行は増えない。
      -- 別クエリにすると D1 の往復が1回増えるので、同じ SELECT で取る。
      LEFT JOIN question_explanations qe ON qe.content_key = q.content_key
     WHERE tq.topic_id = ${id}
     ORDER BY q.exam DESC, q.number
  `)

  // 同じ項目に属する他の論点。学習の流れを切らさないための導線。
  const siblingsP = db.all<{ id: number; term: string; questionCount: number }>(sql`
    SELECT id, term, question_count AS questionCount
      FROM topics
     WHERE syllabus_item_id = (SELECT syllabus_item_id FROM topics WHERE id = ${id})
       AND id <> ${id}
     ORDER BY question_count DESC
     LIMIT 8
  `)

  // 「次の一手」＝頻出なのにまだ理解できていない論点の先頭。ホームの nextTopics と
  // 同じ定義（COALESCE(status,1) < 3・頻度降順）にして、"次" の意味をアプリ全体で揃える。
  // いま開いている論点自身は除く。理解にすると自動で候補から外れ、次が繰り上がる。
  // 空（頻出をひととおり潰した）なら null を返し、画面はグレーアウトにする。
  const nextP = db.get<{ id: number; term: string; questionCount: number }>(sql`
    SELECT t.id AS id, t.term AS term, t.question_count AS questionCount
      FROM topics t
      LEFT JOIN progress p ON p.topic_id = t.id AND p.user_id = ${userId}
     WHERE COALESCE(p.status, 1) < 3 AND t.question_count > 0 AND t.id <> ${id}
     ORDER BY t.question_count DESC, t.term
     LIMIT 1
  `)

  // ロードマップ型: 学ぶ順の前後（sort_order）。資格版は sort_order を参照しない（D13）ので null。
  // ロードマップ型は前後の単位だけを出す。「他の論点」「次に学ぶ（次の未理解）」は学ぶ道を散らす
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

  const [topic, questions, siblings, next, neighbors] = await Promise.all([
    topicP,
    questionsP,
    siblingsP,
    nextP,
    neighborsP,
  ])
  if (!topic) return c.json({ error: '論点が見つかりません' }, 404)

  // まだ解説が無い問題は explanation が null。画面は今までどおり表示する。
  const deduped = dedupe(questions).sort(
    (x, y) => compareExam(y.exam, x.exam) || x.number - y.number,
  )

  // IPA は同じ問題を別の回で使い回す。一覧に本文が同じカードが並ぶと、
  // 何問あるのか読み取れないので1枚にまとめ、「同一の問題が n 回出題されています」
  // として代表カードに出す。出題頻度（topics.question_count）は重複を数えたまま
  // にしてある（頻度＝重要度という設計の中核なので触らない）。
  return c.json({
    topic,
    // 並びは新しい回が先。SQL の ORDER BY q.exam は辞書順なので、同じ年の春（h）と
    // 秋（a）が逆になる。代表の選定と同じ compareExam で並べ直す。
    questions: deduped.map((q) => ({
      ...q,
      choices: JSON.parse(q.choices),
      explanation: explanationOf(q),
    })),
    siblings,
    // 頻出未理解が尽きたら null（画面は「ひととおり学べました」でグレーアウト）。
    nextTopic: next ?? null,
    // ロードマップ型だけ。学ぶ順の前後の単位（資格版は null）
    neighbors,
  })
})

const progressBody = z.object({ status: z.number().int().min(1).max(3) })

/** 理解度の記録（未理解 / やや理解 / 理解）。 */
// @implements REQ-034, REQ-035, REQ-036, REQ-037, REQ-268
catalogRoutes.put('/topics/:id/progress', async (c) => {
  const id = Number(c.req.param('id'))
  const parsed = progressBody.safeParse(await c.req.json().catch(() => null))
  if (!Number.isInteger(id) || !parsed.success) {
    return c.json({ error: '入力が正しくありません' }, 400)
  }
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
// @implements REQ-102
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
     ${examOf(c.env.EXAM).roadmap
       ? sql`ORDER BY q.exam ASC` /* ロードマップ型は最初の回から順に並べる。資格版は新しい回が先 */
       : sql`ORDER BY q.exam DESC`}
  `)
  return c.json({ exams: rows })
})
