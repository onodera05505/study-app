/** 用語集の API（UC-001 の契約 getGlossary: GET /api/glossary）の、UC-001 の未返済の分割クラス。
 *
 *  全語が用語の順に並ぶこと・語ごとに 1 行の説明と紐づく論点が付くこと・1 語も無ければ空であることは
 *  表の中身と並びそのものなので、SQL の形を真似る偽物ではなく migrations を当てた本物の
 *  SQLite（node:sqlite）を D1 の口で包んで叩く。期待値は投入した側から作る。 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'
const USER = 'u-1'

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url)
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
const openDb = () => new DatabaseSync(':memory:')

/** migrations/ の SQL を番号順に当てた空の DB。来訪の記録が指す本人だけ入れる。 */
function freshDb() {
  const db = openDb()
  for (const sql of migrations) db.exec(sql)
  db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run(USER, 'a@example.com', '学ぶ人', 'x')
  return db
}

/** node:sqlite を D1 の口（prepare → bind → all/first/raw/run と batch）で包む。 */
function asD1(db: DatabaseSync) {
  const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
  const prepare = (sql: string) => {
    let params: SQLInputValue[] = []
    const stmt = {
      bind: (...bound: unknown[]) => {
        params = bound.map(norm) as SQLInputValue[]
        return stmt
      },
      all: async () => ({ success: true, results: db.prepare(sql).all(...params), meta: {} }),
      first: async (col?: string) => {
        const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined
        if (!row) return null
        return col ? row[col] : row
      },
      raw: async () => {
        const s = db.prepare(sql)
        s.setReturnArrays(true)
        return s.all(...params)
      },
      run: async () => {
        const r = db.prepare(sql).run(...params)
        return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
      },
    }
    return stmt
  }
  return {
    prepare,
    batch: async (stmts: Array<{ all: () => Promise<unknown> }>) => {
      db.exec('BEGIN')
      try {
        const out: unknown[] = []
        for (const s of stmts) out.push(await s.all())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    exec: async (sql: string) => {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
}

type Entry = { term: string; brief: string; topicId: number | null }

/** 用語集に語を入れる（入れた順は用語の順と一致させない）。 */
function seedGlossary(db: DatabaseSync, entries: Entry[]) {
  for (const e of entries) {
    db.prepare(`INSERT INTO glossary (term, brief, topic_id) VALUES (?, ?, ?)`).run(e.term, e.brief, e.topicId)
  }
}

/** 本人として用語集を求め、応答を返す。 */
async function getGlossary(db: DatabaseSync) {
  const token = await issueToken(SECRET, { id: USER, name: '学ぶ人', role: 'MEMBER' })
  const res = await app.request(
    '/api/glossary',
    { headers: { Authorization: `Bearer ${token}` } },
    { EXAM: 'ip', JWT_SECRET: SECRET, DB: asD1(db) } as unknown as Bindings,
  )
  const payload = (await res.json()) as { glossary?: Entry[]; error?: string }
  expect(res.status, `用語集が返らない: ${JSON.stringify(payload)}`).toBe(200)
  return payload.glossary
}

/** 用語の順に並べ替える（期待値）。 */
const byTerm = (entries: Entry[]) => [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))

/** 投入する語。用語の順とは違う順で並べてある。紐づく論点のある語と無い語を混ぜる。 */
const ENTRIES: Entry[] = [
  { term: 'CSRF', brief: '他人の権限で操作させる攻撃。', topicId: null },
  { term: 'リスク対応（リスク回避，リスク共有，リスク保有）', brief: 'リスクへの向き合い方の総称。', topicId: 77 },
  { term: 'ARP（アドレス解決プロトコル）', brief: 'IP アドレスから MAC アドレスを調べる仕組み。', topicId: 418 },
  { term: 'アローダイアグラム', brief: '作業の順序と所要日数を矢印で表した図。', topicId: null },
]

describe('用語集（GET /api/glossary）（UC-001）', () => {
  // @covers REQ-002#all-terms-in-term-order
  it('投入した全語が、用語の順に並んで返る', async () => {
    const db = freshDb()
    seedGlossary(db, ENTRIES)
    const glossary = await getGlossary(db)
    expect(glossary, '用語集が配列で返らない').toBeInstanceOf(Array)
    expect(glossary!.map((g) => g.term), '全語が用語の順に並んでいない').toEqual(byTerm(ENTRIES).map((e) => e.term))
  })

  // @covers REQ-002#brief-and-topic-per-term
  it('語ごとに 1 行の説明が付き、紐づく論点は有る語にはその ID・無い語には null が付く', async () => {
    const db = freshDb()
    seedGlossary(db, ENTRIES)
    const glossary = await getGlossary(db)
    for (const e of ENTRIES) {
      const got = glossary!.find((g) => g.term === e.term)
      expect(got, `「${e.term}」が返っていない`).toBeDefined()
      expect(got!.brief, `「${e.term}」の 1 行の説明が違う`).toBe(e.brief)
      expect(got!.topicId, `「${e.term}」の紐づく論点が違う`).toBe(e.topicId)
    }
  })

  // @covers REQ-002#empty-glossary
  it('1 語も投入されていなければ、空の配列で返る', async () => {
    const db = freshDb()
    const glossary = await getGlossary(db)
    expect(glossary).toEqual([])
  })
})
