/** 分野ごとの集計（UC-002 の listFields ＝ GET /api/fields）の、理解度の内訳の数え方。
 *
 *  内訳は記録の中身に依るので、空の偽の D1 では観測できない。Node 標準の SQLite（node:sqlite）に
 *  `migrations/*.sql` を当てた実体を D1 の口（prepare → bind → run / all / first / raw、batch、exec）で
 *  包んで渡し、観測は HTTP の境界（listFields の応答）で行う。学びの種類は資格対策（EXAM=ip）。
 *  理解度は 1=未理解・2=やや理解・3=理解。記録の無い論点は未理解として数える（用語集「未理解」）。 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

type Row = Record<string, unknown>

/** D1 に束ねられる値を node:sqlite が受ける形にする（真偽値は 0/1、undefined は NULL）。 */
const toParam = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)

/** 実 SQLite を D1 の口で包む。 */
function d1Of(db: DatabaseSync) {
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound.map(toParam)),
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]))
      return { success: true, results: [], meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...(params as never[])), meta: {} }),
    first: async (column?: string) => {
      const row = (db.prepare(sql).get(...(params as never[])) as Row | undefined) ?? null
      return column && row ? row[column] : row
    },
    raw: async () => {
      const s = db.prepare(sql)
      s.setReturnArrays(true)
      return s.all(...(params as never[]))
    },
  })
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: ReturnType<typeof statement>[]) => {
      const out = []
      for (const s of stmts) out.push(await s.all())
      return out
    },
    exec: async (sql: string) => {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
}

/** 空の DB にマイグレーションを当てる（drizzle の区切りで 1 文ずつ）。 */
function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(MIGRATIONS_DIR + file, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) db.exec(stmt)
    }
  }
  return db
}

const SECRET = 'test-secret'
const ME = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }
const FIELD = 'ストラテジ系'

/** 1 つの分野に属する論点 A・B・C。理解度の記録は A が未理解（1）、B が理解（3）、C は記録なし。 */
const TOPICS = [
  { id: 201, term: '論点A', questions: 2, status: 1 },
  { id: 202, term: '論点B', questions: 3, status: 3 },
  { id: 203, term: '論点C', questions: 1, status: null },
] as const

function seed(db: DatabaseSync) {
  db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
    ME.id,
    `${ME.id}@example.com`,
    ME.name,
    '-',
    ME.role,
  )
  db.prepare(
    'INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, ?, ?, 1, ?, 1, ?)',
  ).run('会計と財務', FIELD, '企業と法務', '企業活動')
  let number = 0
  for (const t of TOPICS) {
    db.prepare(
      'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count) VALUES (?, ?, 1, 0, ?, NULL, ?)',
    ).run(t.id, t.term, `${t.term} の短い説明です。`, t.questions)
    for (let i = 0; i < t.questions; i++) {
      number++
      const qid = `2024r06-q${number}`
      db.prepare(
        'INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, has_figure, figure_description, citation, modified, figure_image, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NULL, ?)',
      ).run(
        qid,
        '2024r06',
        '令和6年度',
        number,
        `問${number} の本文`,
        JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
        'ア',
        `令和6年度 問${number}`,
        `ck-${number}`,
      )
      db.prepare('INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)').run(t.id, qid)
    }
    if (t.status !== null) {
      db.prepare('INSERT INTO progress (user_id, topic_id, status) VALUES (?, ?, ?)').run(ME.id, t.id, t.status)
    }
  }
}

let db: DatabaseSync
let env: Bindings

beforeEach(() => {
  db = migrated()
  seed(db)
  env = { EXAM: 'ip', JWT_SECRET: SECRET, DB: d1Of(db) } as unknown as Bindings
})

afterEach(() => {
  db.close()
})

type FieldRow = { field: string; topics: number; questions: number; understood: number; partly: number; untouched: number }

async function listFields(): Promise<FieldRow[]> {
  const token = await issueToken(SECRET, ME)
  const res = await app.request('/api/fields', { headers: { Authorization: `Bearer ${token}` } }, env)
  expect(res.status, `GET /api/fields が ${res.status}: ${await res.clone().text()}`).toBe(200)
  return ((await res.json()) as { fields: FieldRow[] }).fields
}

describe('分野ごとの集計の理解度の内訳（GET /api/fields。UC-002）', () => {
  // @covers REQ-014#explicit-not-understood-counted
  it('自分で未理解と記録した論点も、記録の無い論点と同じく未理解に数え、内訳の和が論点の数に等しい', async () => {
    const row = (await listFields()).find((f) => f.field === FIELD)
    expect(row, `分野「${FIELD}」の集計が無い`).toBeDefined()
    expect(row!.topics, '論点の数').toBe(3)
    expect(
      { understood: row!.understood, partly: row!.partly, untouched: row!.untouched },
      '理解 1（B）・やや理解 0・未理解 2（A＝未理解と記録、C＝記録なし）',
    ).toEqual({ understood: 1, partly: 0, untouched: 2 })
    expect(row!.understood + row!.partly + row!.untouched, '内訳の和が論点の数に等しくない').toBe(row!.topics)
  })
})
