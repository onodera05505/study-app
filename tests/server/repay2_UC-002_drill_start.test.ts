/** 論点の教材からドリルを始める経路（UC-002 REQ-273。契約の正本は UC-004 の startSession ＝ POST /api/sessions）。
 *
 *  叩くのは契約の操作の入口だけ。偽の D1 は列名で持った行を返し、where 句の `列 = ?` を行に当てる
 *  （過去問の行に論点の列を持たせ、範囲の絞りが効いたかを組めた問題数で観測するため）。
 *  走らせた SQL と束ねた値を `executed` に残し、書き込みの数を見る。 */

import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'

type Row = Record<string, unknown>
/** 行の束。`name` は from／update の表の名前、`match` は SQL の目印（名前より優先）。
 *  `count` の表は、絞った行の件数だけを返す。 */
type Table = { name?: string; match?: RegExp; rows: Row[]; count?: boolean }
type Executed = { sql: string; params: unknown[] }

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())

/** 行が持つ鍵のうち、列名（別名の camelCase でも DB の snake_case でも）に当たるもの。 */
function keyOf(row: Row, name: string): string | undefined {
  for (const k of [name, snake(name), camel(name)]) if (k in row) return k
  return undefined
}

/** SQL の select の並び（別名があれば別名、無ければ最後の識別子）。
 *  drizzle は値を位置で読むので、行を列名から並べ直すのに使う。 */
function selectNames(sql: string): string[] {
  const head = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(sql)
  if (!head) return []
  const items: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of head[1]) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      items.push(cur)
      cur = ''
    } else cur += ch
  }
  items.push(cur)
  return items.map((item) => {
    const text = item.trim().replace(/^distinct\s+/i, '')
    const alias = /\bas\s+"?(\w+)"?\s*$/i.exec(text)
    if (alias) return alias[1]
    const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    if (quoted.length > 0) return quoted[quoted.length - 1]
    const dotted = /(\w+)\s*$/.exec(text)
    return dotted ? dotted[1] : text
  })
}

type Cond = { column: string; op: string; value: unknown }

/** where 句の条件（`列 = ?`・`列 <> ?`・`列 = 0`・`列 is null` …）を、束ねた値と組にして取り出す。
 *  `?` の番号は SQL 全体の並びで数える（update の set 句の分だけずれるため）。 */
function whereOf(sql: string, params: unknown[]): Cond[] {
  const m = /\bwhere\b([\s\S]*?)(?=\border\s+by\b|\blimit\b|\bgroup\s+by\b|\breturning\b|$)/i.exec(sql)
  if (!m) return []
  const where = m[1]
  const start = m.index + m[0].indexOf(where)
  let q = (sql.slice(0, start).match(/\?/g) ?? []).length
  const conds: Cond[] = []
  const re = /(?:"?\w+"?\.)?"?(\w+)"?\s*(?:(=|<>|!=|>=|<=|>|<)\s*(\?|-?\d+(?:\.\d+)?|'(?:[^']|'')*')|(is\s+not\s+null|is\s+null))/gi
  let pos = 0
  for (const hit of where.matchAll(re)) {
    q += (where.slice(pos, hit.index).match(/\?/g) ?? []).length
    pos = (hit.index ?? 0) + hit[0].length
    if (hit[4]) {
      conds.push({ column: hit[1], op: /not/i.test(hit[4]) ? 'notnull' : 'isnull', value: null })
      continue
    }
    let value: unknown
    if (hit[3] === '?') value = params[q++]
    else if (hit[3].startsWith("'")) value = hit[3].slice(1, -1).replace(/''/g, "'")
    else value = Number(hit[3])
    conds.push({ column: hit[1], op: hit[2] === '!=' ? '<>' : hit[2], value })
  }
  return conds
}

function passes(row: Row, c: Cond): boolean {
  const key = keyOf(row, c.column)
  if (key === undefined) return true
  const v = row[key]
  switch (c.op) {
    case '=':
      return String(v) === String(c.value)
    case '<>':
      return String(v) !== String(c.value)
    case '>':
      return Number(v) > Number(c.value)
    case '<':
      return Number(v) < Number(c.value)
    case '>=':
      return Number(v) >= Number(c.value)
    case '<=':
      return Number(v) <= Number(c.value)
    case 'isnull':
      return v === null || v === undefined
    case 'notnull':
      return v !== null && v !== undefined
    default:
      return true
  }
}

/** where・order by・limit を当てた行。 */
function select(rows: Row[], sql: string, params: unknown[]): Row[] {
  const conds = whereOf(sql, params)
  let out = rows.filter((row) => conds.every((c) => passes(row, c)))
  const order = /\border\s+by\s+(?:"?\w+"?\.)?"?(\w+)"?\s*(asc|desc)?/i.exec(sql)
  if (order) {
    const dir = /desc/i.test(order[2] ?? '') ? -1 : 1
    out = [...out].sort((a, b) => {
      const ka = keyOf(a, order[1])
      const kb = keyOf(b, order[1])
      const va = ka ? Number(a[ka]) : 0
      const vb = kb ? Number(b[kb]) : 0
      return (va - vb) * dir
    })
  }
  const limit = /\blimit\s+(\?|\d+)/i.exec(sql)
  if (limit) {
    const n =
      limit[1] === '?' ? Number(params[(sql.slice(0, limit.index).match(/\?/g) ?? []).length]) : Number(limit[1])
    if (Number.isFinite(n)) out = out.slice(0, n)
  }
  return out
}

/** `update <表> set 列 = ?, … where …` を store の行に当てる。 */
function applyUpdate(stores: Record<string, Row[]>, sql: string, params: unknown[]) {
  const up = /^\s*update\s+"?(\w+)"?\s+set\s+([\s\S]*?)(\bwhere\b[\s\S]*)?$/i.exec(sql)
  if (!up) return
  const rows = stores[up[1]]
  if (!rows) return
  const sets: { column: string; value: unknown }[] = []
  let q = 0
  let depth = 0
  let cur = ''
  const parts: string[] = []
  for (const ch of up[2]) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  for (const part of parts) {
    const m = /^\s*(?:"?\w+"?\.)?"?(\w+)"?\s*=\s*([\s\S]+?)\s*$/.exec(part)
    if (!m) continue
    const holes = (m[2].match(/\?/g) ?? []).length
    const value = m[2].trim() === '?' ? params[q] : m[2].trim()
    q += holes
    sets.push({ column: m[1], value })
  }
  const conds = whereOf(sql, params)
  for (const row of rows) {
    if (!conds.every((c) => passes(row, c))) continue
    for (const s of sets) row[keyOf(row, s.column) ?? s.column] = s.value
  }
}

/** 集計の select（`COUNT(*)`・`SUM(CASE WHEN 列 = 値 THEN 1 ELSE 0 END)`）を、絞った行から数えた 1 行。
 *  件数以外の項目は null。 */
function aggregate(rows: Row[], sql: string): Row {
  const head = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(sql)?.[1] ?? ''
  const out: Row = { n: rows.length, count: rows.length }
  const items: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of head) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      items.push(cur)
      cur = ''
    } else cur += ch
  }
  items.push(cur)
  for (const item of items) {
    const name = selectNames(`select ${item} from x`)[0]
    if (/\bcount\s*\(\s*\*\s*\)/i.test(item)) out[name] = rows.length
    else if (/\bsum\s*\(\s*case\s+when\b/i.test(item)) {
      const cond = /case\s+when\s+(?:"?\w+"?\.)?"?(\w+)"?\s*=\s*(\?|-?\d+|'[^']*')\s+then/i.exec(item)
      if (!cond) continue
      const value = cond[2].startsWith("'") ? cond[2].slice(1, -1) : Number(cond[2])
      out[name] = rows.filter((row) => passes(row, { column: cond[1], op: '=', value })).length
    } else out[name] = null
  }
  return out
}

/** 列名で持った行を返し、UPDATE を行に当てる偽の D1（prepare → bind → raw/all/first/run）。 */
function fakeD1(tables: Table[], executed: Executed[]) {
  const stores: Record<string, Row[]> = {}
  for (const t of tables) if (t.name && !t.count) stores[t.name] = t.rows
  const rowsFor = (sql: string, params: unknown[]) => {
    const primary = /\bfrom\s+"?(\w+)"?/i.exec(sql)?.[1]
    const isCount = /\bcount\s*\(/i.test(sql)
    const table =
      tables.find((t) => t.match?.test(sql) && (t.count ?? false) === isCount) ??
      tables.find((t) => t.name === primary && (t.count ?? false) === isCount) ??
      tables.find((t) => t.name === primary)
    if (!table) return []
    const rows = select(table.rows, sql, params)
    if (table.count || isCount) return [aggregate(rows, sql)]
    return rows
  }
  /** select の並びに合わせて鍵を別名に付け替えた行（all／first は別名の物で返るため）。 */
  const named = (sql: string, row: Row): Row => {
    const out: Row = { ...row }
    for (const name of selectNames(sql)) {
      const key = keyOf(row, name)
      if (key !== undefined) out[name] = row[key]
    }
    return out
  }
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind: (...bound: unknown[]) => {
        params = bound
        return stmt
      },
      run: async () => {
        executed.push({ sql, params })
        applyUpdate(stores, sql, params)
        return { success: true, results: [], meta: {} }
      },
      all: async () => ({ success: true, results: rowsFor(sql, params).map((row) => named(sql, row)), meta: {} }),
      first: async () => {
        const row = rowsFor(sql, params)[0]
        return row ? named(sql, row) : null
      },
      raw: async () => {
        const names = selectNames(sql)
        return rowsFor(sql, params).map((row) =>
          names.map((name) => {
            const key = keyOf(row, name)
            return key === undefined ? null : row[key]
          }),
        )
      },
    }
    return stmt
  }
  return { prepare, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) }
}

const USER = 'u-1'
const TOPIC_ID = 231
const OTHER_TOPIC_ID = 418
const TOPIC_TERM = 'LTV'

type World = { tables: Table[]; executed: Executed[] }
const world = (tables: Table[]): World => ({ tables, executed: [] })
const env = (w: World) => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(w.tables, w.executed) }) as unknown as Bindings

async function post(w: World, path: string, body: unknown) {
  const token = await issueToken(SECRET, { id: USER, name: '検査', role: 'MEMBER' })
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env(w),
  )
}

const sessionWrites = (w: World) =>
  w.executed.filter((e) => /^\s*insert\b/i.test(e.sql) && /"?sessions"?\s*\(/i.test(e.sql))

/** 論点 `topicId` に紐づく過去問 1 問ぶんの行（列の別名は出題を組む経路の行のまま）。 */
const question = (n: number, topicId: number): Row => ({
  id: `q-${topicId}-${n}`,
  exam: '2024r06',
  examLabel: '令和6年度',
  number: n,
  text: `問${n} の本文`,
  choices: JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `出典：令和6年度 ITパスポート試験 問${n}`,
  modified: 0,
  contentKey: `ck-${topicId}-${n}`,
  topic_id: topicId,
})

/** この論点に 3 問、別の論点に 5 問の過去問がある世界。進行中のテストは無い。 */
function drillWorld(): World {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => question(i + 1, TOPIC_ID)),
    ...Array.from({ length: 5 }, (_, i) => question(i + 1, OTHER_TOPIC_ID)),
  ]
  return world([
    { match: /SELECT DISTINCT q\.id/i, rows },
    { match: /SELECT id, content_key AS contentKey/i, rows: [] },
    { match: /SELECT term FROM topics/i, rows: [{ term: TOPIC_TERM, id: TOPIC_ID }] },
    { name: 'sessions', rows: [] },
  ])
}

type Created = { id: string; kind: string; scopeLabel: string; questionCount: number; timeLimitSec: number | null }

describe('論点の教材からドリルを始める（POST /api/sessions。UC-002）', () => {
  // @covers REQ-273#one-in-progress-drill-created
  it('論点を範囲にした種別ドリルの求めで、進行中のテストを 1 つだけ作り、その種別を返す', async () => {
    const w = drillWorld()
    const res = await post(w, '/api/sessions', { kind: 'drill', topicId: TOPIC_ID })
    expect(res.status).toBe(201)
    const created = (await res.json()) as Created
    expect(created.kind).toBe('drill')
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
    const inserts = sessionWrites(w)
    expect(inserts, 'テストの行が 1 つだけ書かれていない').toHaveLength(1)
    const bound = inserts[0].params.map(String)
    expect(bound, '書かれたテストが種別ドリルでない').toContain('drill')
    expect(bound, '書かれたテストが進行中でない').toContain('in_progress')
    expect(bound, '書かれたテストの ID が返した ID と違う').toContain(created.id)
  })

  // @covers REQ-273#scope-limited-to-topic
  it('作ったテストの範囲はその論点だけで、他の論点の過去問を混ぜず、範囲の名前にその論点の名前を持つ', async () => {
    const w = drillWorld()
    const res = await post(w, '/api/sessions', { kind: 'drill', topicId: TOPIC_ID })
    expect(res.status).toBe(201)
    const created = (await res.json()) as Created
    expect(created.questionCount, 'その論点の 3 問ではなく、他の論点の過去問まで組んでいる').toBe(3)
    expect(created.scopeLabel).toContain(TOPIC_TERM)
  })
})
