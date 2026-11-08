/** UC-008 模試（通し受験）の、断る回答と 2 回目の締めの境界
 *  （UC-004 の契約 answerQuestion ＝ POST /api/sessions/:id/answer、finishSession ＝ POST /api/sessions/:id/finish。模試も同じ経路）。
 *
 *  偽の D1 は列名で持った行を返し、UPDATE をその行に当てる（状態を持つ。repay_UC-004_sessions.test.ts の作法）。
 *  走らせた SQL と束ねた値を `executed` に残し、断られた要求が何も書いていないことを見る。
 *  模試の行は制限時間を持ち、始めた時刻は「いま」から数えるので、時間切れでない模試は実時間で時間切れにならない。 */

import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

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

/** 列名で持った行を返し、UPDATE を行に当てる偽の D1（prepare → bind → raw/all/first/run、batch）。 */
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
      sql,
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
  /** D1 の batch（1 つのトランザクション）。渡された文を順に、run と同じく記録して当てる。
   *  読み出しの文は all と同じ行を返す。 */
  const batch = async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => {
    const out: unknown[] = []
    for (const s of stmts) out.push(/^\s*(select|with)\b/i.test(s.sql) ? await s.all() : await s.run())
    return out
  }
  return { prepare, batch, exec: async () => ({ count: 0, duration: 0 }) }
}


const USER = 'u-1'
const SID = '3f2a7c1e-5b84-4d6a-9e10-2c7b8a4f0d55'
const TIME_LIMIT = 7200
/** 時間切れでない模試の始めた時刻（いまから 10 分前）。 */
const RECENT = () => Math.floor(Date.now() / 1000) - 600
/** 時間切れの模試の始めた時刻（制限時間より 1 時間前）。 */
const LONG_AGO = () => Math.floor(Date.now() / 1000) - TIME_LIMIT - 3600
const FINISHED = 1759283500

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

const writes = (w: World, table: RegExp) =>
  w.executed.filter((e) => /^\s*(insert|update|delete)\b/i.test(e.sql) && table.test(e.sql))
const sessionWrites = (w: World) => writes(w, /"?sessions"?\b/i)
const answerWrites = (w: World) => writes(w, /"?session_questions"?\b/i)

/** 契約の ErrorBody（鍵は error だけで、日本語の 1 文）。 */
async function errorBody(res: Response) {
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body)).toEqual(['error'])
  expect(String(body.error)).toMatch(JAPANESE)
  return body
}

/** 過去問 1 問ぶんの行（今の過去問データ。正解は出題時の控えと違う「エ」）。 */
const question = (n: number): Row => ({
  id: `q-${n}`,
  exam: '2024r06',
  examLabel: '令和6年度',
  number: n + 1,
  text: `問${n + 1} の本文`,
  choices: JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
  answer: 'エ',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `出典：令和6年度 ITパスポート試験 問${n + 1}`,
  modified: 0,
  contentKey: `ck-${n}`,
  field: 'テクノロジ系',
})

/** 模試の sessions の行（列名は schema のまま。UC-004 の契約 getSessionResult の例 ok の値）。 */
const mockSession = (over: Row): Row => ({
  id: SID,
  user_id: USER,
  kind: 'mock',
  status: 'in_progress',
  source_exam: '2024r06',
  scope_label: '令和6年度 を通しで受験',
  time_limit_sec: TIME_LIMIT,
  question_count: 10,
  correct_count: null,
  started_at: RECENT(),
  finished_at: null,
  ...over,
})

/** 出題時スナップショット。控えの正解はどの問題も「ア」。 */
const snapshot = (idx: number) => ({
  idx,
  text: `模試の問題文その${idx}`,
  choices: { ア: 'DNS', イ: 'RSS', ウ: 'SEO', エ: 'SNS' },
  answer: 'ア',
  citation: `出典：令和6年度 ITパスポート試験 問${idx + 1}`,
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 1,
  otherCitations: [] as string[],
})

/** session_questions の行。result は 0 未回答／1 正答／2 誤答。 */
const sq = (idx: number, result: 0 | 1 | 2, userAnswer: string | null = null): Row => ({
  id: `sq-${idx}`,
  session_id: SID,
  question_id: `q-${idx}`,
  idx,
  snapshot: JSON.stringify(snapshot(idx)),
  answer: 'ア',
  user_answer: userAnswer,
  result,
  answered_at: result === 0 ? null : RECENT() + idx,
})

/** 10 問の模試。先頭 `correct` 問が正答、続く `wrong` 問が誤答、残りが未回答。 */
function tenQuestions(correct: number, wrong: number): Row[] {
  return Array.from({ length: 10 }, (_, idx) =>
    idx < correct ? sq(idx, 1, 'ア') : idx < correct + wrong ? sq(idx, 2, 'イ') : sq(idx, 0),
  )
}

function mockWorld(over: Row, rows: Row[]): World {
  return world([
    { name: 'sessions', rows: [mockSession(over)] },
    { name: 'session_questions', rows },
    { name: 'session_questions', rows, count: true },
    { name: 'questions', rows: rows.map((r) => ({ ...question(Number(r.idx)), id: r.question_id })) },
  ])
}

/** 進行中・制限時間内で 8 問回答済み（5 正答・3 誤答）。現在の問題は位置 8。 */
const inProgress = () => mockWorld({}, tenQuestions(5, 3))
const CURRENT = 8

const rowsOf = (w: World) => w.tables.find((t) => t.name === 'session_questions' && !t.count)!.rows as Row[]
const row = (w: World, idx: number) => rowsOf(w).find((r) => r.idx === idx)!
const sessionRow = (w: World) => (w.tables.find((t) => t.name === 'sessions')!.rows as Row[])[0]

const answer = (w: World, idx: number, choice: string) => post(w, `/api/sessions/${SID}/answer`, { idx, answer: choice })
const finish = (w: World) => post(w, `/api/sessions/${SID}/finish`, {})

type Finished = { ok: boolean; correct: number; total: number }

describe('模試への回答を断る（POST /api/sessions/:id/answer。UC-008）', () => {
  // @covers REQ-250#stale-idx-not-scored
  it('送られた位置が現在の問題の位置と違う回答は、前でも先でも、採点も記録もせず 409 の {error} で断る', async () => {
    // 空振り対策: 同じ世界で現在の位置なら受け付けられる
    const ok = await answer(inProgress(), CURRENT, 'ア')
    expect(ok.status, '現在の位置の回答が通らない（この検査は空振りになる）').toBe(200)

    for (const idx of [0, CURRENT - 1, CURRENT + 1]) {
      const w = inProgress()
      const before = rowsOf(w).map((r) => ({ ...r }))
      const res = await answer(w, idx, 'ア')
      expect(res.status, `位置 ${idx}`).toBe(409)
      await errorBody(res)
      expect(answerWrites(w), `位置 ${idx} で回答の記録が書かれている`).toEqual([])
      expect(sessionWrites(w), `位置 ${idx} で模試の行が書かれている`).toEqual([])
      expect(rowsOf(w), `位置 ${idx} で 1 問ごとの記録が変わっている`).toEqual(before)
    }
  })
})

describe('締めた模試・未回答の無い模試への回答（POST /api/sessions/:id/answer。UC-008）', () => {
  // @covers REQ-253#answer-to-finished
  it('締めた模試への回答は、未回答の行が残っていて制限時間内でも、採点も記録もせず 409 の {error} で理由を示す', async () => {
    // 空振り対策: 同じ行の並びで進行中なら受け付けられる
    const ok = await answer(inProgress(), CURRENT, 'ア')
    expect(ok.status, '進行中なら通る回答が通らない（この検査は空振りになる）').toBe(200)

    const w = mockWorld({ status: 'completed', correct_count: 5, finished_at: FINISHED }, tenQuestions(5, 3))
    const before = rowsOf(w).map((r) => ({ ...r }))
    const res = await answer(w, CURRENT, 'ア')
    expect(res.status).toBe(409)
    await errorBody(res)
    expect(answerWrites(w), '締めた模試に回答の記録が書かれている').toEqual([])
    expect(sessionWrites(w), '締めた模試の行が書かれている').toEqual([])
    expect(rowsOf(w)).toEqual(before)
    expect(Number(sessionRow(w).correct_count), '締めた模試の正答数が変わっている').toBe(5)
  })

  // @covers REQ-253#answer-with-no-unanswered
  it('未回答が 1 問も残っていない進行中の模試への回答は、どの位置を指しても採点も記録もせず 409 の {error} で理由を示す', async () => {
    for (const idx of [0, 9, 10]) {
      const w = mockWorld({}, tenQuestions(6, 4))
      const before = rowsOf(w).map((r) => ({ ...r }))
      const res = await answer(w, idx, 'ア')
      expect(res.status, `位置 ${idx}`).toBe(409)
      await errorBody(res)
      expect(answerWrites(w), `位置 ${idx} で回答の記録が書かれている`).toEqual([])
      expect(sessionWrites(w), `位置 ${idx} で模試の行が書かれている`).toEqual([])
      expect(rowsOf(w), `位置 ${idx} で回答済みの記録が書き換わっている`).toEqual(before)
    }
  })
})

describe('完了した模試をもう一度締める（POST /api/sessions/:id/finish。UC-008）', () => {
  // @covers REQ-254#second-finish-returns-first-result
  it('完了した模試を再び締めても、正答数と締めた時刻は最初に確定した値のまま返る（記録から数え直さない）', async () => {
    // 記録から数え直すと 5 になる行の並びで、最初の締めは 7 で確定している
    for (const [label, startedAt] of [
      ['制限時間内に締めた模試', RECENT()],
      ['制限時間を過ぎて自動で締まった模試', LONG_AGO()],
    ] as [string, number][]) {
      const w = mockWorld({ status: 'completed', correct_count: 7, finished_at: FINISHED, started_at: startedAt }, tenQuestions(5, 3))
      for (const n of [2, 3]) {
        const res = await finish(w)
        expect(res.status, `${label}（${n} 回目）`).toBe(200)
        expect((await res.json()) as Finished, `${label}（${n} 回目）の結果が最初の確定と違う`).toEqual({ ok: true, correct: 7, total: 10 })
      }
      const s = sessionRow(w)
      expect(s.status, label).toBe('completed')
      expect(Number(s.correct_count), `${label}: 正答数が変わった`).toBe(7)
      expect(Number(s.finished_at), `${label}: 締めた時刻が変わった`).toBe(FINISHED)
      expect(sessionWrites(w), `${label}: 再びの締めが模試の行を書いている`).toEqual([])
    }
  })

  // @covers REQ-254#second-finish-returns-first-result
  it('進行中の模試を締めたあとにもう一度締めると、1 回目と同じ正答数が返り、締めた時刻は 1 回目の値のまま', async () => {
    const w = inProgress()
    const first = await finish(w)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as Finished
    expect(firstBody, '1 回目の締め（この検査の前提）').toEqual({ ok: true, correct: 5, total: 10 })
    const confirmedAt = sessionRow(w).finished_at
    expect(confirmedAt, '1 回目の締めで締めた時刻が残っていない（この検査の前提）').not.toBeNull()
    // 1 回目のあとに記録が増えても、2 回目は数え直さない
    row(w, CURRENT).result = 1
    row(w, CURRENT).user_answer = 'ア'
    const writesAfterFirst = sessionWrites(w).length

    const second = await finish(w)
    expect(second.status).toBe(200)
    expect((await second.json()) as Finished, '2 回目の締めの結果が 1 回目と違う').toEqual(firstBody)
    expect(Number(sessionRow(w).correct_count), '2 回目の締めで正答数が変わった').toBe(5)
    expect(sessionRow(w).finished_at, '2 回目の締めで締めた時刻が変わった').toBe(confirmedAt)
    expect(sessionWrites(w).length, '2 回目の締めが模試の行を書いている').toBe(writesAfterFirst)
  })
})
