/** 資格対策の学びで出題頻度が同じ論点どうしの並び（分野の順 → シラバスの項目の順 → 論点の ID の順。BR-031）が、
 *  一覧のおすすめ順（GET /api/topics?sort=recommended）と次に学ぶの候補（GET /api/me の nextTopics）の両方に
 *  出ること。UC-003
 *
 *  並びは空の偽の D1 では観測できないので、Node 標準の SQLite（node:sqlite）に `migrations/*.sql` を当てた実体を
 *  D1 の口で包んで渡す。観測はすべて HTTP の境界で行う。
 *  シラバスの項目は、分野と項目の順の値の正本 `data/<学びの key>/syllabus.json` の項目をそのまま仕込む
 *  （項目の ID はその number）。分野の順はシラバスに分野が初めて現れる順、項目の順は number の順として期待値を組む。
 *  分野の順が学びごとに違う 2 つの学び（ip はストラテジ系が先、ap はテクノロジ系が先）で同じ検査を回し、
 *  分野の名前の文字の順・登録簿の分野の並び・どちらか一方の学びの順の決め打ちのどれでも緑にならないようにする。
 *  論点は、ID の順・名前の順が期待の順と一致しないように置く。 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const ROOT = new URL('../../', import.meta.url)
const MIGRATIONS_DIR = fileURLToPath(new URL('migrations/', ROOT))

type Row = Record<string, unknown>

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

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(MIGRATIONS_DIR + file, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) db.exec(stmt)
    }
  }
  return db
}

type SyllabusItem = {
  number: number
  name: string
  field: string
  major_no: number
  major: string
  middle_no: number
  middle: string
}

/** 学びのシラバス（分野と項目の順の値の正本）。 */
function syllabusOf(key: string): SyllabusItem[] {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`data/${key}/syllabus.json`, ROOT)), 'utf8'))
  return raw.items as SyllabusItem[]
}

/** シラバスに分野が初めて現れる順。 */
const fieldsInOrder = (items: SyllabusItem[]) => [...new Set(items.map((i) => i.field))]

const SECRET = 'test-secret'
const ME = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }

/** 仕込む論点。item はシラバスの項目の number。 */
type Topic = { id: number; term: string; item: number; questions: number }

type Ctx = { db: DatabaseSync; env: Bindings; items: SyllabusItem[] }
const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function setup(key: string, topics: (items: SyllabusItem[]) => Topic[]): Ctx & { topics: Topic[] } {
  const db = migrated()
  opened.push(db)
  const items = syllabusOf(key)
  db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
    ME.id,
    `${ME.id}@example.com`,
    ME.name,
    '-',
    ME.role,
  )
  for (const i of items) {
    db.prepare(
      'INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(i.number, i.name, i.field, i.major_no, i.major, i.middle_no, i.middle)
  }
  const ts = topics(items)
  let number = 0
  for (const t of ts) {
    db.prepare(
      'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count) VALUES (?, ?, ?, 0, ?, NULL, ?)',
    ).run(t.id, t.term, t.item, `${t.term} の短い説明です。`, t.questions)
    for (let q = 0; q < t.questions; q++) {
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
  }
  const env = { EXAM: key, JWT_SECRET: SECRET, DB: d1Of(db) } as unknown as Bindings
  return { db, env, items, topics: ts }
}

async function getJson<T>(env: Bindings, p: string): Promise<T> {
  const token = await issueToken(SECRET, ME)
  const res = await app.request(p, { headers: { Authorization: `Bearer ${token}` } }, env)
  expect(res.status, `GET ${p} が ${res.status}: ${await res.clone().text()}`).toBe(200)
  return (await res.json()) as T
}

async function recordUnderstood(env: Bindings, topicId: number) {
  const token = await issueToken(SECRET, ME)
  const res = await app.request(
    `/api/topics/${topicId}/progress`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 3 }),
    },
    env,
  )
  expect(res.status, `論点 ${topicId} を理解にできない: ${await res.clone().text()}`).toBe(200)
}

const recommendedIds = async (env: Bindings) =>
  (await getJson<{ topics: { id: number }[] }>(env, '/api/topics?sort=recommended')).topics.map((t) => t.id)
const nextIds = async (env: Bindings) =>
  (await getJson<{ nextTopics: { id: number }[] }>(env, '/api/me')).nextTopics.map((t) => t.id)

/** 期待の並びの位置を 1 つずつ取り、ID は期待の逆の順、名前は期待の順とも ID の順とも違う順になるように論点を作る。
 *  最も頻度の高い論点は期待の最後の位置の項目に、最も低い論点は先頭の位置の項目に置き、頻度が先に効くことも見る。 */
function tied(itemsInExpectedOrder: number[], baseId: number): Topic[] {
  const n = itemsInExpectedOrder.length
  // 名前の順: 2 番目 → 先頭 → 最後 → 3 番目 …（期待とも ID の逆順とも一致しない）
  const kana = ['い', 'あ', 'え', 'う', 'か', 'お']
  const tiedTopics = itemsInExpectedOrder.map((item, pos) => ({
    id: baseId + (n - pos) * 10,
    term: `${kana[pos]}の論点${baseId + pos}`,
    item,
    questions: 4,
  }))
  const top: Topic = { id: baseId + 1, term: `ん頻度の高い論点${baseId}`, item: itemsInExpectedOrder[n - 1], questions: 9 }
  const low: Topic = { id: baseId + 2, term: `あ頻度の低い論点${baseId}`, item: itemsInExpectedOrder[0], questions: 1 }
  return [low, ...tiedTopics, top]
}
/** tied() の論点の期待の並び。頻度の降順で、同頻度の塊は ID を期待の逆に振ってあるので ID の降順が期待の順。 */
const expectedIds = (ts: Topic[]) =>
  [...ts].sort((a, b) => b.questions - a.questions || b.id - a.id).map((t) => t.id)

/** 分野をまたぐ同頻度: 各分野の中ほどの項目を 1 つずつ、シラバスの分野の順に取る。 */
const acrossFields = (items: SyllabusItem[]) =>
  tied(
    fieldsInOrder(items).map((f) => {
      const inField = items.filter((i) => i.field === f)
      return inField[Math.floor(inField.length / 2)].number
    }),
    500,
  )

/** 同じ分野の中で項目が違う同頻度: シラバスで最後に現れる分野の、先頭・中ほど・最後の項目を number の順に取る。 */
const acrossItems = (items: SyllabusItem[]) => {
  const lastField = fieldsInOrder(items).at(-1)!
  const inField = items.filter((i) => i.field === lastField).map((i) => i.number).sort((a, b) => a - b)
  return tied([inField[0], inField[Math.floor(inField.length / 2)], inField[inField.length - 1]], 600)
}

/** 同じ項目の同頻度: 1 つの項目に 3 つ。ID の昇順が期待の順で、名前は ID の逆の順。 */
const sameItem = (items: SyllabusItem[]): Topic[] => {
  const item = items[Math.floor(items.length / 2)].number
  return [
    { id: 701, term: 'う同じ項目の論点', item, questions: 4 },
    { id: 702, term: 'い同じ項目の論点', item, questions: 4 },
    { id: 703, term: 'あ同じ項目の論点', item, questions: 4 },
    { id: 704, term: 'ん頻度の高い論点', item, questions: 9 },
    { id: 700, term: 'あ頻度の低い論点', item, questions: 1 },
  ]
}
const sameItemExpected = [704, 701, 702, 703, 700]

/** 分野の順が学びごとに違う 2 つの資格対策の学び。 */
const KEYS = ['ip', 'ap'] as const

describe('おすすめ順の一覧で出題頻度が同じ論点の並び（UC-003）', () => {
  // @covers REQ-042#tie-by-field
  it('ip と ap のどちらでも、出題頻度が同じで分野が違う論点は、シラバスの分野の順に並ぶ（理解にした塊の中でも）', async () => {
    for (const key of KEYS) {
      const { env, items, topics } = setup(key, acrossFields)
      const fields = fieldsInOrder(items)
      expect(fields.length, '仕込み: 分野が 2 つ以上無い（この検査は空振りになる）').toBeGreaterThanOrEqual(2)
      const expected = expectedIds(topics)
      expect(await recommendedIds(env), `分野の順 ${fields.join('→')} に並んでいない（${key}）`).toEqual(expected)
      for (const t of topics) await recordUnderstood(env, t.id)
      expect(await recommendedIds(env), `理解にした塊の中で分野の順に並んでいない（${key}）`).toEqual(expected)
    }
  })

  // @covers REQ-042#tie-by-item
  it('ip と ap のどちらでも、出題頻度と分野が同じで項目が違う論点は、シラバスの項目の順に並ぶ（理解にした塊の中でも）', async () => {
    for (const key of KEYS) {
      const { env, topics } = setup(key, acrossItems)
      const expected = expectedIds(topics)
      expect(await recommendedIds(env), `シラバスの項目の順に並んでいない（${key}）`).toEqual(expected)
      for (const t of topics) await recordUnderstood(env, t.id)
      expect(await recommendedIds(env), `理解にした塊の中で項目の順に並んでいない（${key}）`).toEqual(expected)
    }
  })

  // @covers REQ-042#tie-by-id
  it('ip と ap のどちらでも、出題頻度と項目が同じ論点は、論点の ID の順に並ぶ（理解にした塊の中でも）', async () => {
    for (const key of KEYS) {
      const { env, topics } = setup(key, sameItem)
      expect(await recommendedIds(env), `論点の ID の順に並んでいない（${key}）`).toEqual(sameItemExpected)
      for (const t of topics) await recordUnderstood(env, t.id)
      expect(await recommendedIds(env), `理解にした塊の中で ID の順に並んでいない（${key}）`).toEqual(sameItemExpected)
    }
  })
})

describe('次に学ぶの候補で出題頻度が同じ論点の並び（UC-003）', () => {
  // @covers REQ-043#tie-by-field
  it('ip と ap のどちらでも、出題頻度が同じで分野が違う論点は、シラバスの分野の順に候補へ並ぶ', async () => {
    for (const key of KEYS) {
      const { env, items, topics } = setup(key, acrossFields)
      expect(await nextIds(env), `分野の順 ${fieldsInOrder(items).join('→')} に並んでいない（${key}）`).toEqual(expectedIds(topics))
    }
  })

  // @covers REQ-043#tie-by-item
  it('ip と ap のどちらでも、出題頻度と分野が同じで項目が違う論点は、シラバスの項目の順に候補へ並ぶ', async () => {
    for (const key of KEYS) {
      const { env, topics } = setup(key, acrossItems)
      expect(await nextIds(env), `シラバスの項目の順に並んでいない（${key}）`).toEqual(expectedIds(topics))
    }
  })

  // @covers REQ-043#tie-by-id
  it('ip と ap のどちらでも、出題頻度と項目が同じ論点は、論点の ID の順に候補へ並ぶ', async () => {
    for (const key of KEYS) {
      const { env } = setup(key, sameItem)
      expect(await nextIds(env), `論点の ID の順に並んでいない（${key}）`).toEqual(sameItemExpected)
    }
  })
})
