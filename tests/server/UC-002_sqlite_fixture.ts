/** UC-002 の境界のテスト（listTopics・getTopicDetail）が使う、実 SQLite の学びの写しと入口の呼び方。
 *
 *  Node 標準の SQLite（node:sqlite）に `migrations/*.sql` を全部当てた実体を D1 の口
 *  （prepare → bind → run / all / first / raw、batch、exec）で包んで渡し、観測は HTTP の境界で行う。
 *  単元の構成の置き場は `unit_plans`・`unit_groups`・`unit_group_topics`・`topic_prerequisites`（定義の正本は schema.ts）。
 *
 *  単元 12「セキュリティ」は単元の構成を持ち、単元 7「ソフトウェア」は持たない。
 *  論点の ID の順・出題頻度の順・小項目の順・単元の構成の順がどれも違うように置く。 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

type Row = Record<string, unknown>
export type Json = any

/** D1 に束ねられる値を node:sqlite が受ける形にする（真偽値は 0/1、undefined は NULL）。 */
const toParam = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)

/** 実 SQLite を D1 の口で包む。 */
export function d1Of(db: DatabaseSync) {
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
export function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(MIGRATIONS_DIR + file, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) db.exec(stmt)
    }
  }
  return db
}

export const SECRET = 'test-secret'
export const ME = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }
const FIELD = 'テクノロジ系'

/** 小項目（syllabus_items の id が小項目の番号）。単元 7 は小項目 1・2、単元 12 は 3・4・5。 */
const ITEMS = [
  { id: 1, name: 'オペレーティングシステム', majorNo: 2, major: 'コンピュータシステム', middleNo: 7, middle: 'ソフトウェア' },
  { id: 2, name: 'ファイルシステム', majorNo: 2, major: 'コンピュータシステム', middleNo: 7, middle: 'ソフトウェア' },
  { id: 3, name: '暗号技術', majorNo: 3, major: '技術要素', middleNo: 12, middle: 'セキュリティ' },
  { id: 4, name: '認証技術', majorNo: 3, major: '技術要素', middleNo: 12, middle: 'セキュリティ' },
  { id: 5, name: '情報セキュリティ対策', majorNo: 3, major: '技術要素', middleNo: 12, middle: 'セキュリティ' },
]

export type SeedTopic = { id: number; term: string; item: number; questions: number }

/** 単元 12 の論点（並びは単元の構成の順）。ファイアウォールは小項目 3（暗号技術）だが、まとまり 2 に入る。 */
export const UNIT12: SeedTopic[] = [
  { id: 430, term: '共通鍵暗号方式', item: 3, questions: 1 },
  { id: 410, term: '公開鍵暗号方式', item: 3, questions: 5 },
  { id: 420, term: 'ディジタル署名', item: 4, questions: 2 },
  { id: 405, term: 'SQL インジェクション', item: 5, questions: 3 },
  { id: 440, term: 'ファイアウォール', item: 3, questions: 0 },
]
/** 単元 12 の単元の構成。まとまりごとに、学ぶ順の論点。 */
export const PLAN12 = {
  overview: '情報を守る考え方と、それを支える暗号・認証の仕組みを学ぶ。',
  groups: [
    { no: 1, name: '暗号と証明書', description: '鍵の持ち方で暗号を分け、署名と証明書で相手を確かめる。', topics: [430, 410, 420] },
    { no: 2, name: '攻撃と対策', description: 'よくある攻撃の手口と、それぞれを防ぐ仕組み。', topics: [405, 440] },
  ],
}
/** 前提の論点（論点 → 単元の構成に書かれた順の前提）。405 の前提は別の単元の論点。 */
export const PREREQUISITES: Record<number, number[]> = { 420: [430, 410], 405: [502] }

/** 単元 7 の論点（単元の構成を持たない）。 */
export const UNIT7: SeedTopic[] = [
  { id: 499, term: 'ジャーナリング', item: 2, questions: 9 },
  { id: 503, term: 'リンカ', item: 1, questions: 2 },
  { id: 501, term: 'コンパイラ', item: 1, questions: 2 },
  { id: 502, term: 'インタプリタ', item: 1, questions: 4 },
]

let questionNo = 0

function insertTopic(db: DatabaseSync, t: SeedTopic) {
  db.prepare(
    'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count) VALUES (?, ?, ?, 0, ?, NULL, ?)',
  ).run(t.id, t.term, t.item, `${t.term} の短い説明です。`, t.questions)
  for (let i = 0; i < t.questions; i++) {
    questionNo++
    const qid = `2024r06-q${questionNo}`
    db.prepare(
      'INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, has_figure, figure_description, citation, modified, figure_image, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NULL, ?)',
    ).run(
      qid,
      '2024r06',
      '令和6年度',
      questionNo,
      `問${questionNo} の本文`,
      JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
      'ア',
      `令和6年度 問${questionNo}`,
      `ck-${questionNo}`,
    )
    db.prepare('INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)').run(t.id, qid)
  }
}

/** 学びの写しを入れる。理解度の記録は渡したものだけ（回答は入れない）。 */
export function seed(db: DatabaseSync, records: Record<number, number> = {}) {
  questionNo = 0
  db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
    ME.id,
    `${ME.id}@example.com`,
    ME.name,
    '-',
    ME.role,
  )
  for (const i of ITEMS) {
    db.prepare(
      'INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(i.id, i.name, FIELD, i.majorNo, i.major, i.middleNo, i.middle)
  }
  for (const t of [...UNIT12, ...UNIT7]) insertTopic(db, t)
  db.prepare('INSERT INTO unit_plans (middle_no, overview) VALUES (12, ?)').run(PLAN12.overview)
  for (const g of PLAN12.groups) {
    db.prepare('INSERT INTO unit_groups (middle_no, group_no, name, description) VALUES (12, ?, ?, ?)').run(
      g.no,
      g.name,
      g.description,
    )
    g.topics.forEach((topicId, i) =>
      db
        .prepare('INSERT INTO unit_group_topics (topic_id, middle_no, group_no, position) VALUES (?, 12, ?, ?)')
        .run(topicId, g.no, i + 1),
    )
  }
  for (const [topicId, pres] of Object.entries(PREREQUISITES)) {
    pres.forEach((pre, i) =>
      db
        .prepare('INSERT INTO topic_prerequisites (topic_id, prerequisite_topic_id, position) VALUES (?, ?, ?)')
        .run(Number(topicId), pre, i + 1),
    )
  }
  for (const [topicId, status] of Object.entries(records)) {
    db.prepare('INSERT INTO progress (user_id, topic_id, status) VALUES (?, ?, ?)').run(ME.id, Number(topicId), status)
  }
}

/** 学びの key を渡して、その学びとして応える配備の束縛を作る。 */
export const envOf = (db: DatabaseSync, exam = 'ip') =>
  ({ EXAM: exam, JWT_SECRET: SECRET, DB: d1Of(db) }) as unknown as Bindings

/** 本人のトークンで GET し、200 の本文を返す。 */
export async function getOk(env: Bindings, path: string): Promise<Json> {
  const token = await issueToken(SECRET, ME)
  const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env)
  expect(res.status, `GET ${path} が ${res.status}: ${await res.clone().text()}`).toBe(200)
  return res.json()
}

export const termOf = (id: number) => [...UNIT12, ...UNIT7].find((t) => t.id === id)!.term
