import { beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import targets from '../../src/shared/targets.json'

/** ロードマップ型の学びで、ある回を範囲に始めたテスト（UC-008 の契約 startMockExam に回の ID を渡す）。
 *  回の範囲と範囲の名前は、どの行がどの回に属するかの絞り込みそのものなので、SQL の形を真似る偽物ではなく
 *  migrations を当てた本物の SQLite（node:sqlite）を D1 の口で包んで叩く。
 *  データは投入の門（BR-037）を通る形にそろえる: 確認問題の回は、その問題が紐づく単位の属する回と同じ。
 *  日で束ねる学びの手本は itc（1 日 3 単位）、章で束ねる学びの手本は eng（章ごとに単位の数が違う）。 */

const SECRET = 'test-secret'
const USER = 'u-1'

type Registry = Record<string, { roadmapSpec?: { extraRoundId?: string; extraRoundLabel?: string } }>
const REGISTRY = targets as unknown as Registry

/** node:sqlite の同期 API のうち、ここで使う形だけ（プロジェクトの型は Workers 向けで node の型を持たない）。 */
type Statement = {
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
  run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint }
  setReturnArrays: (on: boolean) => void
}
type DatabaseSync = { exec: (sql: string) => void; prepare: (sql: string) => Statement }

/** node の組み込みは実行時に読む（型の解決を通さない）。 */
const nodeModule = (name: string) => import(/* @vite-ignore */ name) as Promise<any>
let openDb: () => DatabaseSync
let migrations: string[] = []

beforeAll(async () => {
  const sqlite = await nodeModule('node:sqlite')
  const fs = await nodeModule('node:fs')
  const dir = new URL('../../migrations/', import.meta.url)
  migrations = (fs.readdirSync(dir) as string[])
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(new URL(f, dir), 'utf8') as string)
  openDb = () => new sqlite.DatabaseSync(':memory:') as DatabaseSync
})

/** migrations/ の SQL を番号順に当てた空の DB。 */
function freshDb() {
  const db = openDb()
  for (const sql of migrations) db.exec(sql)
  return db
}

/** node:sqlite を D1 の口（prepare → bind → all/first/raw/run と batch）で包む。 */
function asD1(db: DatabaseSync) {
  const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind: (...bound: unknown[]) => {
        params = bound.map(norm)
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

type RoundUnit = { id: number; sortOrder: number | null; round: string; roundLabel: string; tier: number | null }

/** 単位と、単位ごとに 2 問の確認問題を入れる。確認問題の回（exam）は単位の属する回。
 *  入れた確認問題の ID と回を返す（期待値はこの側から作る）。 */
function seed(db: DatabaseSync, units: RoundUnit[]) {
  const seeded: { id: string; exam: string }[] = []
  db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run(USER, 'a@example.com', '学ぶ人', 'x')
  db.prepare(
    `INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, '項目', '分野', 1, '大分類', 1, '中分類')`,
  ).run()
  const numberIn: Record<string, number> = {}
  for (const u of units) {
    db.prepare(
      `INSERT INTO topics (id, term, syllabus_item_id, question_count, sort_order, round, round_label, tier) VALUES (?, ?, 1, 2, ?, ?, ?, ?)`,
    ).run(u.id, `単位 ${u.id}`, u.sortOrder, u.round, u.roundLabel, u.tier)
    for (let k = 0; k < 2; k++) {
      const n = (numberIn[u.round] = (numberIn[u.round] ?? 0) + 1)
      const qid = `${u.round}-q${n}`
      db.prepare(
        `INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, citation, content_key) VALUES (?, ?, ?, ?, ?, ?, 'ア', '', ?)`,
      ).run(qid, u.round, u.roundLabel, n, `${qid} の本文`, JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }), `ck-${qid}`)
      db.prepare(`INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)`).run(u.id, qid)
      seeded.push({ id: qid, exam: u.round })
    }
  }
  return seeded
}

/** 回の確認問題の ID（期待値）。投入した確認問題のうち、回（exam）がその回の物。 */
const questionsOf = (seeded: { id: string; exam: string }[], round: string) =>
  seeded
    .filter((q) => q.exam === round)
    .map((q) => q.id)
    .sort()

/** 回を範囲にテストを始め、応答と作られたテストの問題の ID を返す。 */
async function startRound(target: string, db: DatabaseSync, round: string) {
  const token = await issueToken(SECRET, { id: USER, name: '学ぶ人', role: 'MEMBER' })
  const res = await app.request(
    '/api/sessions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'mock', exam: round }),
    },
    { EXAM: target, JWT_SECRET: SECRET, DB: asD1(db) } as unknown as Bindings,
  )
  const payload = (await res.json()) as { id?: string; scopeLabel?: string; questionCount?: number; error?: string }
  expect(res.status, `回 ${round} のテストを作れない: ${JSON.stringify(payload)}`).toBe(201)
  const ids = (
    db.prepare(`SELECT question_id AS id FROM session_questions WHERE session_id = ?`).all(String(payload.id)) as {
      id: string
    }[]
  )
    .map((r) => r.id)
    .sort()
  return { payload, ids }
}

/** itc: 7 単位を 1 日 3 単位で 3 日（最後の日は 1 単位）。補足の単位 1 つ。 */
const ITC_UNITS: RoundUnit[] = [
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => {
    const day = Math.ceil(n / 3)
    return { id: 100 + n, sortOrder: n, round: `itc-d0${day}`, roundLabel: `${day} 日目`, tier: null }
  }),
  { id: 200, sortOrder: null, round: 'itc-ex', roundLabel: '補足（ロードマップ外）', tier: null },
]

/** eng: 章ごとに単位の数が違う（第 1 章 2・第 2 章 4・第 3 章 1）。補足の単位 1 つ。
 *  回のラベルは章の名前だけ（番号は登録簿の回の見出しの語が付ける）。 */
const ENG_CHAPTERS = [
  { round: 'eng-c01', label: '甲の章', no: 1, size: 2 },
  { round: 'eng-c02', label: '乙の章', no: 2, size: 4 },
  { round: 'eng-c03', label: '丙の章', no: 3, size: 1 },
]
const ENG_UNITS: RoundUnit[] = (() => {
  const out: RoundUnit[] = []
  let order = 1
  for (const c of ENG_CHAPTERS)
    for (let i = 0; i < c.size; i++)
      out.push({ id: 300 + order, sortOrder: order++, round: c.round, roundLabel: c.label, tier: (order % 3) + 1 })
  out.push({ id: 400, sortOrder: null, round: 'eng-ex', roundLabel: '補足（ロードマップ外）', tier: 1 })
  return out
})()

describe('回ごとの確認の範囲（UC-009）', () => {
  // @covers REQ-281#day-round-scope
  it('日で束ねる学びで日を範囲に始めると、その日に属する単位の確認問題だけでテストを作る', async () => {
    const db = freshDb()
    const seeded = seed(db, ITC_UNITS)
    const { payload, ids } = await startRound('itc', db, 'itc-d02')
    const expected = questionsOf(seeded, 'itc-d02')
    expect(expected, '2 日目の確認問題を投入できていない（この検査は空振りになる）').toHaveLength(6)
    expect(ids, '2 日目に属する単位の確認問題だけになっていない').toEqual(expected)
    expect(payload.questionCount).toBe(expected.length)
  })

  // @covers REQ-281#chapter-round-scope
  it('章で束ねる学びで章を範囲に始めると、章ごとに単位の数が違ってもその章の単位の確認問題だけでテストを作る', async () => {
    for (const c of ENG_CHAPTERS) {
      const db = freshDb()
      const seeded = seed(db, ENG_UNITS)
      const { payload, ids } = await startRound('eng', db, c.round)
      const expected = questionsOf(seeded, c.round)
      expect(expected, `第 ${c.no} 章の確認問題を投入できていない（この検査は空振りになる）`).toHaveLength(c.size * 2)
      expect(ids, `第 ${c.no} 章に属する単位の確認問題だけになっていない`).toEqual(expected)
      expect(payload.questionCount).toBe(expected.length)
    }
  })
})

describe('回を範囲にしたテストの範囲の名前（UC-008）', () => {
  // @covers REQ-286#day-round-scope-name
  it('日で束ねる学びの日から作ったテストの範囲の名前は、日の語でその日を指す', async () => {
    const db = freshDb()
    seed(db, ITC_UNITS)
    const { payload } = await startRound('itc', db, 'itc-d02')
    expect(payload.scopeLabel).toContain('2 日目')
    expect(payload.scopeLabel).toContain('この日の確認')
  })

  // @covers REQ-286#chapter-round-scope-name
  it('章で束ねる学びの章から作ったテストの範囲の名前は、章の語と章の名前でその章を指し、日の語を含まない', async () => {
    const db = freshDb()
    seed(db, ENG_UNITS)
    const { payload } = await startRound('eng', db, 'eng-c02')
    expect(payload.scopeLabel).toContain('第 2 章')
    expect(payload.scopeLabel).toContain('乙の章')
    expect(payload.scopeLabel).toContain('この章の確認')
    expect(payload.scopeLabel).not.toMatch(/日目|この日/)
  })

  // @covers REQ-286#extra-round-scope-name
  it('補足の回から作ったテストの範囲の名前には、登録簿の補足の回のラベルを使う', async () => {
    const spec = REGISTRY.itc.roadmapSpec
    expect(spec?.extraRoundId, '登録簿に補足の回が無い（この検査は空振りになる）').toBe('itc-ex')
    const db = freshDb()
    seed(db, ITC_UNITS)
    const { payload } = await startRound('itc', db, String(spec!.extraRoundId))
    expect(payload.scopeLabel).toContain(String(spec!.extraRoundLabel))
  })
})
