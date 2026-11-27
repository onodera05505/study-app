/** 受験履歴（UC-007）の境界。叩くのは契約の操作の入口だけ
 *  （listExamHistory ＝ GET /api/sessions。破棄は UC-006 の discardCurrentSession ＝ DELETE /api/sessions/current）。
 *
 *  偽の D1 は列名で持った行を返し、where・order by・limit を当て、update／delete を行に当てる
 *  （tests/server/repay_UC-004_sessions.test.ts の作法）。並びと件数の上限を SQL で決めても
 *  取り出したあとで決めても、同じ応答になるようにするため。
 *  一覧の上限の値は契約（contract.yaml の listExamHistory の maxItems）から読む（R-102）。 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'

type Row = Record<string, unknown>
/** 行の束。`name` は from／update／delete の表の名前、`match` は SQL の目印（名前より優先）。 */
type Table = { name?: string; match?: RegExp; rows: Row[] }
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

/** where・order by（複数の鍵）・limit を当てた行。 */
function select(rows: Row[], sql: string, params: unknown[]): Row[] {
  const conds = whereOf(sql, params)
  let out = rows.filter((row) => conds.every((c) => passes(row, c)))
  const orderClause = /\border\s+by\s+([\s\S]*?)(?=\blimit\b|$)/i.exec(sql)
  if (orderClause) {
    const keys = [...orderClause[1].matchAll(/(?:"?\w+"?\.)?"?(\w+)"?\s*(asc|desc)?/gi)].map((m) => ({
      column: m[1],
      dir: /desc/i.test(m[2] ?? '') ? -1 : 1,
    }))
    out = [...out].sort((a, b) => {
      for (const k of keys) {
        const ka = keyOf(a, k.column)
        const kb = keyOf(b, k.column)
        const va = ka ? Number(a[ka]) : 0
        const vb = kb ? Number(b[kb]) : 0
        if (va !== vb) return (va - vb) * k.dir
      }
      return 0
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
  for (const part of up[2].split(',')) {
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

/** `delete from <表> where …` を store の行に当てる（当たった行を取り除く）。 */
function applyDelete(stores: Record<string, Row[]>, sql: string, params: unknown[]) {
  const del = /^\s*delete\s+from\s+"?(\w+)"?/i.exec(sql)
  if (!del) return
  const rows = stores[del[1]]
  if (!rows) return
  const conds = whereOf(sql, params)
  for (let i = rows.length - 1; i >= 0; i--) {
    if (conds.every((c) => passes(rows[i], c))) rows.splice(i, 1)
  }
}

/** 列名で持った行を返し、UPDATE／DELETE を行に当てる偽の D1（prepare → bind → raw/all/first/run）。 */
function fakeD1(tables: Table[], executed: Executed[]) {
  const stores: Record<string, Row[]> = {}
  for (const t of tables) if (t.name) stores[t.name] = t.rows
  const rowsFor = (sql: string, params: unknown[]) => {
    const primary = /\bfrom\s+"?(\w+)"?/i.exec(sql)?.[1]
    const table = tables.find((t) => t.match?.test(sql)) ?? tables.find((t) => t.name === primary)
    if (!table) return []
    const rows = select(table.rows, sql, params)
    if (/\bcount\s*\(/i.test(sql)) {
      const name = selectNames(sql)[0] ?? 'count'
      return [{ [name]: rows.length, count: rows.length, n: rows.length }]
    }
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
        applyDelete(stores, sql, params)
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
  return {
    prepare,
    batch: async (stmts: { run: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async () => ({ count: 0, duration: 0 }),
  }
}

/* ---------- 世界と要求 ---------- */

const USER = 'u-1'
const OTHER = 'u-2'
const STARTED = 1759276800

type World = { tables: Table[]; executed: Executed[] }
const world = (sessions: Row[]): World => ({
  tables: [
    { name: 'sessions', rows: sessions },
    { name: 'session_questions', rows: [] },
  ],
  executed: [],
})
const env = (w: World) => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(w.tables, w.executed) }) as unknown as Bindings

async function call(w: World, method: 'GET' | 'DELETE', path: string, user = USER) {
  const token = await issueToken(SECRET, { id: user, name: '検査', role: 'MEMBER' })
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}` } }, env(w))
}

type Listed = { id: string; finishedAt: number | null }

/** 受験履歴を開く（listExamHistory）。200 であることと、応答の形（sessions の配列）を確かめて返す。 */
async function history(w: World, user = USER): Promise<Listed[]> {
  const res = await call(w, 'GET', '/api/sessions', user)
  expect(res.status, '受験履歴が開けない').toBe(200)
  const body = (await res.json()) as { sessions?: unknown }
  expect(Array.isArray(body.sessions), '応答に sessions の配列が無い').toBe(true)
  return body.sessions as Listed[]
}
const ids = (list: Listed[]) => list.map((s) => s.id)

/** 本人の締めたテストの行。`n` で ID と締めた時刻をずらす（n が大きいほど新しい）。
 *  始めた時刻は全部同じにして、並びが締めた時刻で決まることを見分けられるようにする。 */
const finished = (n: number, over: Row = {}): Row => ({
  id: `done-${String(n).padStart(3, '0')}`,
  user_id: USER,
  kind: 'drill',
  status: 'completed',
  source_exam: null,
  scope_label: '論点「RAID」',
  time_limit_sec: null,
  question_count: 10,
  correct_count: 8,
  started_at: STARTED,
  finished_at: STARTED + 600 + n * 60,
  ...over,
})

/** 本人の進行中のテストの行（締めていない）。 */
const inProgress = (id: string, over: Row = {}): Row => ({
  id,
  user_id: USER,
  kind: 'field',
  status: 'in_progress',
  source_exam: null,
  scope_label: '分野「テクノロジ系」',
  time_limit_sec: null,
  question_count: 20,
  correct_count: null,
  started_at: STARTED + 100000,
  finished_at: null,
  ...over,
})

/** 一覧の上限（契約の listExamHistory の応答の sessions.maxItems）。 */
function maxItemsFromContract(): number {
  const yaml = readFileSync(
    new URL('../../docs/goals/GOAL-02-mock-exam/UC-007-review-exam-history/contract.yaml', import.meta.url),
    'utf8',
  )
  const m = /maxItems:\s*(\d+)/.exec(yaml)
  if (!m) throw new Error('契約に一覧の上限（maxItems）が無い')
  return Number(m[1])
}

describe('受験履歴（GET /api/sessions。UC-007）', () => {
  // @covers REQ-095#newest-first
  it('締めた時刻の違う締めたテストが複数あるとき、表に入れた順でも始めた順でもなく、締めた時刻の新しい順に返す', async () => {
    // 表には古い→新しい→中間の順で入れ、始めた時刻は締めた順と逆にする
    const rows = [
      finished(1, { started_at: STARTED + 300 }),
      finished(3, { started_at: STARTED + 100 }),
      finished(2, { started_at: STARTED + 200 }),
    ]
    const list = await history(world(rows))
    expect(ids(list)).toEqual(['done-003', 'done-002', 'done-001'])
    // 応答の finishedAt 自体も新しい順に並んでいる（ID の並びだけが偶然合っている可能性を外す）
    const times = list.map((s) => Number(s.finishedAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  // @covers REQ-096#within-limit
  it('締めたテストが上限ちょうど（と 1 件）のとき、すべてを一覧する', async () => {
    const limit = maxItemsFromContract()
    for (const count of [1, limit]) {
      const rows = Array.from({ length: count }, (_, i) => finished(i + 1))
      const list = await history(world(rows))
      expect(list, `${count} 件のとき`).toHaveLength(count)
      expect(new Set(ids(list)), `${count} 件のとき欠けている`).toEqual(new Set(rows.map((r) => r.id)))
    }
  })

  // @covers REQ-096#over-limit
  it('締めたテストが上限＋1 件以上あるとき、上限の件数だけを返し、超える古いものを出さない', async () => {
    const limit = maxItemsFromContract()
    for (const count of [limit + 1, limit + 25]) {
      // 古い順に並べて入れる（表の順に先頭から切っても緑にならないよう、新しい方を後ろに置く）
      const rows = Array.from({ length: count }, (_, i) => finished(i + 1))
      const list = await history(world(rows))
      expect(list, `${count} 件のとき上限を超えて返している`).toHaveLength(limit)
      const newest = rows.slice(count - limit).map((r) => r.id)
      expect(new Set(ids(list)), `${count} 件のとき古いものが残っている`).toEqual(new Set(newest))
    }
  })

  // @covers REQ-097#only-own-sessions
  it('他の人の締めたテストがあっても、要求した本人の分だけを一覧する', async () => {
    const mine = [finished(1), finished(2)]
    const theirs = [
      finished(3, { id: 'other-003', user_id: OTHER }),
      finished(4, { id: 'other-004', user_id: OTHER }),
    ]
    const w = world([...theirs, ...mine])
    expect(new Set(ids(await history(w, USER)))).toEqual(new Set(['done-001', 'done-002']))
    // 相手から見れば相手の分だけ（持ち主の軸が ID の固定ではなく要求した本人で決まる）
    expect(new Set(ids(await history(w, OTHER)))).toEqual(new Set(['other-003', 'other-004']))
  })

  // @covers REQ-097#excludes-unfinished
  it('進行中のテストと破棄したテストは一覧に出ず、締めたテストだけが出る', async () => {
    // 進行中（締めていない）が混ざっていても出ない
    const w = world([finished(1), inProgress('cur-1')])
    expect(ids(await history(w))).toEqual(['done-001'])

    // 進行中を破棄（UC-006 discardCurrentSession）したあとも、その回は出ない
    const discarded = await call(w, 'DELETE', '/api/sessions/current')
    expect(discarded.status, '進行中の破棄が通らない（この検査は空振りになる）').toBe(200)
    expect(ids(await history(w))).toEqual(['done-001'])
  })
})
