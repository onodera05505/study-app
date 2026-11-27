/**
 * 学び側の app（`src/server/index.ts` の default export）に実例を渡す前提の部品。
 *
 * 実例ごとに learningWorld() で空の学びの D1（migrations を当てたメモリの SQLite。tests/portal/repay_UC-014_sqlite_d1）を作り、
 * 前提の行を `world.db` に直接置いてから `world.send(line, ...)` で境界から叩く。本人は `world.user()` で置き、
 * 実例が本人を持たない前提（kit/http.ts の withoutIdentity）ならトークンを付けない。
 */

import app from '../../../src/server/index'
import type { Bindings } from '../../../src/server/lib/db'
import { issueToken } from '../../../src/server/lib/auth'
import { learningD1, sqliteOf, type DatabaseSync } from '../../../tests/portal/repay_UC-014_sqlite_d1'
import { answerOf, pieces, withoutIdentity, type PieceOptions } from './http'
import type { Answer, ExampleLine } from './protocol'

export const SIGNING_SECRET = 'contract-adapter-secret'

export type LearningWorld = {
  db: DatabaseSync
  env: Bindings
  /** 本人の行を置く（既定は一般の利用者）。 */
  user: (id: string, name?: string, role?: string) => void
  /** 実例を境界から叩いて答えに読む。asUser を渡すとその本人のトークンを付ける（本人を持たない前提の実例には付けない）。 */
  send: (line: ExampleLine, asUser?: { id: string; name: string; role: string } | null, options?: PieceOptions) => Promise<Answer>
  /** 境界から叩いて Response をそのまま返す（前提を操作で作るとき）。 */
  raw: (method: string, path: string, asUser: { id: string; name: string; role: string } | null, body?: unknown) => Promise<Response>
}

/** 保存先の口を包み、sql が pattern に当たる文を実行すると失敗させる（保存の途中の失敗を前提とする実例）。 */
function failing(inner: D1Database, pattern: RegExp): D1Database {
  const refuse = (sql: string) => {
    if (pattern.test(sql)) throw new Error(`保存に失敗した（前提）: ${sql.slice(0, 60)}`)
  }
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    ({
      original: statement,
      sql,
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      first: async (column?: string) => (refuse(sql), column === undefined ? statement.first() : statement.first(column)),
      all: async () => (refuse(sql), statement.all()),
      run: async () => (refuse(sql), statement.run()),
      raw: async (options?: { columnNames?: boolean }) => (refuse(sql), (statement.raw as (o?: unknown) => Promise<unknown[]>)(options)),
    }) as unknown as D1PreparedStatement
  return {
    prepare: (sql: string) => wrap(inner.prepare(sql), sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const originals = statements as unknown as Array<{ original: D1PreparedStatement; sql: string }>
      for (const { sql } of originals) refuse(sql)
      return inner.batch(originals.map((o) => o.original))
    },
    exec: (sql: string) => inner.exec(sql),
    dump: () => inner.dump(),
  } as unknown as D1Database
}

/**
 * 実例 1 件の学びの配備（空の D1・学びの key・署名の秘密）を作る。failWrites を渡すと、当たる文の実行が失敗する保存先にする。
 * @implements REQ-570
 */
export async function learningWorld(extraEnv: Record<string, unknown> = {}, exam = 'ip', failWrites?: RegExp): Promise<LearningWorld> {
  const d1 = await learningD1()
  const db = sqliteOf(d1)
  const store = failWrites ? failing(d1, failWrites) : d1
  const env = { EXAM: exam, JWT_SECRET: SIGNING_SECRET, DB: store, ...extraEnv } as unknown as Bindings
  const bearer = async (asUser: { id: string; name: string; role: string }) => `Bearer ${await issueToken(SIGNING_SECRET, asUser)}`
  return {
    db,
    env,
    user: (id, name = '学ぶ人', role = 'MEMBER') => {
      db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(id, `${id}@example.com`, name, '-', role)
    },
    send: async (line, asUser, options = {}) => {
      const headers = { ...(options.headers ?? {}) }
      if (asUser && !withoutIdentity(line)) headers.Authorization = await bearer(asUser)
      const { path, init } = pieces(line, { ...options, headers })
      return answerOf(await app.request(path, init, env), line)
    },
    raw: async (method, path, asUser, body) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (asUser) headers.Authorization = await bearer(asUser)
      return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env)
    },
  }
}

/** 契約の実例が名指す学びの本人（UC-003 の getHomeSummary.ok の user）。学び側の実例はこの本人として渡す。 */
export const LEARNER = { id: '8a0f1d62-3c47-4b10-9f85-d2e6a1c70b33', name: '山田 太郎', role: 'MEMBER' }

/** シラバスの小項目（syllabus_items の 1 行。id が小項目の番号）。 */
export type Item = { id: number; name: string; field: string; majorNo: number; major: string; middleNo: number; middle: string }

export type TopicSpec = {
  id: number
  term: string
  item: Item
  /** 出題頻度（topics.question_count）。linked を省くと、この数だけ別々の内容の過去問を紐づける。 */
  questions: number
  /** 紐づける過去問を自分で置くとき true（数だけを持たせる）。 */
  manualQuestions?: boolean
  explanation?: string | null
  detail?: string | null
  subtitle?: string | null
  isNew?: 0 | 1
}

export type QuestionSpec = {
  id: string
  exam: string
  examLabel: string
  number: number
  text?: string
  choices?: Record<string, string>
  answer?: string
  citation?: string
  contentKey?: string
  hasFigure?: 0 | 1
  figureDescription?: string | null
  figureImage?: string | null
  modified?: 0 | 1
}

/**
 * 小項目を置く（同じ id が既にあれば置かない）。
 * @implements REQ-570
 */
export function putItem(db: DatabaseSync, item: Item): void {
  db.prepare('INSERT OR IGNORE INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    item.id,
    item.name,
    item.field,
    item.majorNo,
    item.major,
    item.middleNo,
    item.middle,
  )
}

let filler = 0

/**
 * 過去問を置き、topicId を渡せばその論点に紐づける。
 * @implements REQ-570
 */
export function putQuestion(db: DatabaseSync, q: QuestionSpec, topicId?: number, primary = 1): void {
  db.prepare(
    'INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, has_figure, figure_description, citation, modified, figure_image, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    q.id,
    q.exam,
    q.examLabel,
    q.number,
    q.text ?? `${q.id} の本文`,
    JSON.stringify(q.choices ?? { ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
    q.answer ?? 'ア',
    q.hasFigure ?? 0,
    q.figureDescription ?? null,
    q.citation ?? `${q.examLabel} 問${q.number}`,
    q.modified ?? 0,
    q.figureImage ?? null,
    q.contentKey ?? `ck-${q.id}`,
  )
  if (topicId !== undefined) db.prepare('INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, ?)').run(topicId, q.id, primary)
}

/**
 * 論点を置く（小項目も置く）。manualQuestions でなければ出題頻度の数だけ別々の内容の過去問を紐づける。
 * @implements REQ-570
 */
export function putTopic(db: DatabaseSync, t: TopicSpec): void {
  putItem(db, t.item)
  db.prepare(
    'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count, subtitle) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(t.id, t.term, t.item.id, t.isNew ?? 0, t.explanation ?? `${t.term} の説明。`, t.detail ?? null, t.questions, t.subtitle ?? null)
  if (t.manualQuestions) return
  for (let i = 0; i < t.questions; i++) {
    filler++
    putQuestion(db, { id: `fill-${filler}`, exam: `fill${Math.floor(filler / 1000)}`, examLabel: '補いの回', number: (filler % 1000) + 1 }, t.id)
  }
}

/**
 * 本人の理解度の記録（上書き）を置く。
 * @implements REQ-570
 */
export function putProgress(db: DatabaseSync, userId: string, topicId: number, status: number, updatedAt = 1_700_000_000): void {
  db.prepare('INSERT INTO progress (user_id, topic_id, status, updated_at) VALUES (?, ?, ?, ?)').run(userId, topicId, status, updatedAt)
}

/**
 * テストの行を置く。
 * @implements REQ-570
 */
export function putSession(
  db: DatabaseSync,
  s: {
    id: string
    userId: string
    kind: string
    status: 'in_progress' | 'completed'
    scopeLabel: string
    questionCount: number
    sourceExam?: string | null
    timeLimitSec?: number | null
    correctCount?: number | null
    startedAt?: number
    finishedAt?: number | null
  },
): void {
  db.prepare(
    'INSERT INTO sessions (id, user_id, kind, status, source_exam, scope_label, time_limit_sec, question_count, correct_count, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    s.id,
    s.userId,
    s.kind,
    s.status,
    s.sourceExam ?? null,
    s.scopeLabel,
    s.timeLimitSec ?? null,
    s.questionCount,
    s.correctCount ?? null,
    s.startedAt ?? 1_700_000_000,
    s.finishedAt ?? null,
  )
}

/**
 * テストの出題の行を置く（snapshot は出題の時点の問題の写し。result は 0 未回答 / 1 正答 / 2 誤答）。
 * @implements REQ-570
 */
export function putSessionQuestion(
  db: DatabaseSync,
  q: { sessionId: string; questionId: string; idx: number; snapshot: Record<string, unknown>; userAnswer?: string | null; result?: 0 | 1 | 2; answeredAt?: number | null },
): void {
  db.prepare(
    'INSERT INTO session_questions (id, session_id, question_id, idx, snapshot, user_answer, result, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`${q.sessionId}-${q.idx}`, q.sessionId, q.questionId, q.idx, JSON.stringify(q.snapshot), q.userAnswer ?? null, q.result ?? 0, q.answeredAt ?? null)
}
