/** 中断したテストの破棄（UC-006 discardCurrentSession ＝ DELETE /api/sessions/current）の境界。
 *
 *  叩くのは契約の操作の入口だけ（破棄のあとの状態は、同じ偽の D1 への getCurrentSession ＝
 *  GET /api/sessions/current と、偽の D1 に残った行で見る）。
 *
 *  偽の D1 は列名で持った行を返し、DELETE をその行に当てる（状態を持つ）。sessions の行を消すと
 *  session_questions の行も消える（migrations の DDL: session_id の外部キーが ON DELETE cascade）。
 *  実装が回答の行を自分で消しても、連鎖に任せても、残っていないことだけを見る。 */

import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'

type Row = Record<string, unknown>
/** 行の束。`name` は from／delete の表の名前、`match` は SQL の目印（名前より優先）。 */
type Table = { name: string; match?: RegExp; rows: Row[] }
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

/** where 句の条件（`列 = ?`・`列 <> ?`・`列 = 'x'`・`列 is null` …）を、束ねた値と組にして取り出す。
 *  `?` の番号は SQL 全体の並びで数える。 */
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
      return ((ka ? Number(a[ka]) : 0) - (kb ? Number(b[kb]) : 0)) * dir
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

/** 集計の select（`COUNT(*)`・`SUM(CASE WHEN 列 = 値 THEN 1 ELSE 0 END)`）を、絞った行から数えた 1 行。 */
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

/** `delete from <表> where …` を表の行に当てる。sessions の行が消えたら、その session_id を持つ
 *  session_questions の行も消す（DDL の ON DELETE cascade）。 */
function applyDelete(tables: Table[], sql: string, params: unknown[]) {
  const del = /^\s*delete\s+from\s+"?(\w+)"?/i.exec(sql)
  if (!del) return
  const table = tables.find((t) => t.name === del[1])
  if (!table) return
  const conds = whereOf(sql, params)
  const gone = table.rows.filter((row) => conds.every((c) => passes(row, c)))
  table.rows.splice(0, table.rows.length, ...table.rows.filter((row) => !gone.includes(row)))
  if (table.name !== 'sessions') return
  const ids = new Set(gone.map((row) => String(row.id)))
  const answers = tables.find((t) => t.name === 'session_questions')
  if (!answers) return
  answers.rows.splice(0, answers.rows.length, ...answers.rows.filter((row) => !ids.has(String(row.session_id))))
}

/** 列名で持った行を返し、DELETE を行に当てる偽の D1（prepare → bind → raw/all/first/run、batch は順に run）。 */
function fakeD1(tables: Table[], executed: Executed[]) {
  const rowsFor = (sql: string, params: unknown[]) => {
    const primary = /\bfrom\s+"?(\w+)"?/i.exec(sql)?.[1]
    const table = tables.find((t) => t.match?.test(sql)) ?? tables.find((t) => t.name === primary)
    if (!table) return []
    const rows = select(table.rows, sql, params)
    return /\bcount\s*\(/i.test(sql) ? [aggregate(rows, sql)] : rows
  }
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
        applyDelete(tables, sql, params)
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
  const batch = async (stmts: { run: () => Promise<unknown> }[]) => {
    const out: unknown[] = []
    for (const s of stmts) out.push(await s.run())
    return out
  }
  return { prepare, batch, exec: async () => ({ count: 0, duration: 0 }) }
}

const USER = 'u-1'
const SID = '7b1e3d50-9c42-4a8f-bd21-6e0f5a39c714'
const DONE_SID = '8f14e45f-ea2b-4f1c-9a3e-6b1d2c7f4a90'
const STARTED = 1759276800

/** 1 つの偽の D1 に続けて要求を送るための世界（表と記録を共有する）。 */
type World = { tables: Table[]; executed: Executed[] }
const env = (w: World) => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(w.tables, w.executed) }) as unknown as Bindings

async function request(w: World, method: 'GET' | 'DELETE') {
  const token = await issueToken(SECRET, { id: USER, name: '検査', role: 'MEMBER' })
  return app.request('/api/sessions/current', { method, headers: { Authorization: `Bearer ${token}` } }, env(w))
}

/** sessions の行（列名は schema のまま。契約の例 okInProgress の値）。 */
const session = (over: Row): Row => ({
  id: SID,
  user_id: USER,
  kind: 'drill',
  status: 'in_progress',
  source_exam: null,
  scope_label: '論点: RAID',
  time_limit_sec: null,
  question_count: 10,
  correct_count: null,
  started_at: STARTED,
  finished_at: null,
  ...over,
})

/** テスト <sid> の 10 問の行。先頭 <answered> 問は回答済み。 */
const answers = (sid: string, answered: number): Row[] =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `${sid}-${i}`,
    session_id: sid,
    question_id: `q-${i + 1}`,
    idx: i,
    snapshot: JSON.stringify({ idx: i, text: `問${i + 1} の本文` }),
    user_answer: i < answered ? 'ア' : null,
    result: i < answered ? 1 : 0,
    answered_at: i < answered ? STARTED + 60 * (i + 1) : null,
  }))

const world = (sessions: Row[], questions: Row[]): World => ({
  tables: [
    { name: 'sessions', match: /from "sessions"/i, rows: sessions },
    { name: 'session_questions', match: /session_questions/i, rows: questions },
  ],
  executed: [],
})

const sessionRows = (w: World) => w.tables.find((t) => t.name === 'sessions')!.rows
const answerRows = (w: World) => w.tables.find((t) => t.name === 'session_questions')!.rows

/** 契約の Ok（ok: true だけで、error を持たない）。 */
async function okBody(res: Response, label: string) {
  expect(res.status, label).toBe(200)
  const body = (await res.json()) as Record<string, unknown>
  expect(body.ok, label).toBe(true)
  expect(body, label).not.toHaveProperty('error')
}

async function currentOf(w: World): Promise<unknown> {
  const res = await request(w, 'GET')
  expect(res.status).toBe(200)
  return ((await res.json()) as { session?: unknown }).session ?? null
}

describe('進行中のテストの破棄（DELETE /api/sessions/current。UC-006）', () => {
  // @covers REQ-085#discard-without-current
  it('進行中のテストが無い状態の破棄は、失敗にせず破棄が済んだものとして 200 の {ok: true} で返る', async () => {
    // 進行中も終わったテストも無い
    const empty = world([], [])
    await okBody(await request(empty, 'DELETE'), '進行中が無い')

    // 締めたテストしか無い（進行中は無い）
    const onlyDone = world([session({ id: DONE_SID, status: 'completed', correct_count: 7, finished_at: STARTED + 3600 })], answers(DONE_SID, 10))
    await okBody(await request(onlyDone, 'DELETE'), '締めたテストしか無い')

    // 破棄が済んだ直後の 2 度目の破棄（冪等）
    const twice = world([session({})], answers(SID, 4))
    await okBody(await request(twice, 'DELETE'), '1 度目')
    expect(await currentOf(twice), '1 度目の破棄のあとも進行中が残っている（2 度目が同じ入力にならない）').toBeNull()
    await okBody(await request(twice, 'DELETE'), '2 度目')
  })

  // @covers REQ-090#answers-removed
  it('破棄が済んだあとは、進行中のテストもそのテストの回答も残らない', async () => {
    const w = world([session({})], answers(SID, 4))
    // 空振り対策: 破棄の前は進行中として案内される
    expect((await currentOf(w)) as Row | null, '偽の D1 が進行中を返せていない（この検査は空振りになる）').not.toBeNull()
    expect(answerRows(w).length).toBe(10)

    await okBody(await request(w, 'DELETE'), '破棄')

    expect(await currentOf(w), '破棄のあとも進行中として案内される').toBeNull()
    expect(sessionRows(w).filter((row) => row.id === SID), '破棄したテストの行が残っている').toEqual([])
    expect(answerRows(w).filter((row) => row.session_id === SID), '破棄したテストの回答が残っている').toEqual([])
  })
})
