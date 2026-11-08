/** 演習のテスト（UC-004）の、出題を組む・現在の問題・回答・締め の境界。
 *
 *  叩くのは契約の操作の入口だけ（startSession ＝ POST /api/sessions、getCurrentQuestion ＝
 *  GET /api/sessions/:id/current、answerQuestion ＝ POST /api/sessions/:id/answer、
 *  finishSession ＝ POST /api/sessions/:id/finish、getSessionResult ＝ GET /api/sessions/:id）。
 *
 *  偽の D1 は列名で持った行を返し、UPDATE をその行に当てる（状態を持つ）。回答のあとの件数・
 *  2 回目の回答・2 回目の締め のように「前の要求が残した状態」で決まる振る舞いを、
 *  同じ偽の D1 への続けた要求で見るため。走らせた SQL と束ねた値を `executed` に残し、
 *  断られた要求が何も書いていないことを見る。 */

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
const OTHER = 'u-2'
const SID = '8f14e45f-ea2b-4f1c-9a3e-6b1d2c7f4a90'
const NOBODY = '00000000-0000-4000-8000-000000000000'
const STARTED = 1759276800
const FINISHED = 1759280000

/** 1 つの偽の D1 に続けて要求を送るための世界（表と記録を共有する）。 */
type World = { tables: Table[]; executed: Executed[] }
const world = (tables: Table[]): World => ({ tables, executed: [] })
const env = (w: World) => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(w.tables, w.executed) }) as unknown as Bindings

async function get(w: World, path: string, user = USER) {
  const token = await issueToken(SECRET, { id: user, name: '検査', role: 'MEMBER' })
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env(w))
}

async function post(w: World, path: string, body: unknown, user = USER) {
  const token = await issueToken(SECRET, { id: user, name: '検査', role: 'MEMBER' })
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

/** 表への書き込み（insert／update／delete）だけを取り出す。 */
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

/* ---------- 出題を組む（startSession） ---------- */

/** 範囲に合う過去問 1 問ぶんの行（列の別名は session-builder の QuestionRow のまま）。
 *  範囲を絞る列（論点・分野・単元）は持たせず、形が正しければ当ての無い範囲でも引ける。 */
const question = (n: number): Row => ({
  id: `q-${n}`,
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
  contentKey: `ck-${n}`,
})
const questions = (n: number) => Array.from({ length: n }, (_, i) => question(i + 1))

const TOPIC_TERM = 'オープンソースソフトウェア'
const MIDDLE = '基礎理論'

/** 出題を組む経路の表。`available` 問の過去問と、進行中の確認に使う sessions の行。
 *  弱点復習（review）は誤答の記録と理解度の記録から組むので、その 2 本にも行を持たせる
 *  （SQL の目印は tests/server/sessions.test.ts と同じ）。 */
function startTables(available: number, sessions: Row[] = []): Table[] {
  return [
    { match: /SELECT DISTINCT q\.id/i, rows: questions(available) },
    { match: /MAX\(sq\.answered_at\)/i, rows: questions(available) },
    { match: /SELECT id, content_key AS contentKey/i, rows: [] },
    { match: /(progress[\s\S]*status)|(status[\s\S]*progress)/i, rows: questions(available).map((q) => ({ ...q, id: `${q.id}-p` })) },
    { match: /SELECT term FROM topics/i, rows: [{ term: TOPIC_TERM }] },
    { match: /SELECT middle FROM syllabus_items/i, rows: [{ middle: MIDDLE }] },
    { name: 'sessions', rows: sessions },
  ]
}

/** sessions の行（列名は schema のまま）。 */
const session = (over: Row): Row => ({
  id: SID,
  user_id: USER,
  kind: 'drill',
  status: 'in_progress',
  source_exam: null,
  scope_label: `論点「${TOPIC_TERM}」`,
  time_limit_sec: null,
  question_count: 10,
  correct_count: null,
  started_at: STARTED,
  finished_at: null,
  ...over,
})

type Created = { id: string; kind: string; scopeLabel: string; questionCount: number }

describe('演習の開始（POST /api/sessions。UC-004）', () => {
  // @covers REQ-050#scope-label-and-count
  it('作ったテストは、種別ごとの範囲の名前（論点・分野・単元の名前を含む）と、組んだ問題数を返す', async () => {
    const cases: { body: Record<string, unknown>; name: RegExp }[] = [
      { body: { kind: 'drill', topicId: 2, size: 10 }, name: new RegExp(TOPIC_TERM) },
      { body: { kind: 'field', field: 'テクノロジ系', size: 20 }, name: /テクノロジ系/ },
      { body: { kind: 'middle', middleNo: 23, size: 20 }, name: new RegExp(MIDDLE) },
      { body: { kind: 'review', size: 20 }, name: /./ },
    ]
    for (const { body, name } of cases) {
      const w = world(startTables(100))
      const res = await post(w, '/api/sessions', body)
      expect(res.status, JSON.stringify(body)).toBe(201)
      const created = (await res.json()) as Created
      expect(created.kind, JSON.stringify(body)).toBe(body.kind)
      expect(created.scopeLabel, `${JSON.stringify(body)} の範囲の名前`).toMatch(name)
      expect(created.questionCount, `${JSON.stringify(body)} の問題数`).toBe(body.size)
    }
    // 範囲の過去問が頼んだ問題数より少ないときは、実際に組めた数を問題数として返す
    const w = world(startTables(7))
    const res = await post(w, '/api/sessions', { kind: 'field', field: 'テクノロジ系', size: 20 })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Created).questionCount).toBe(7)
  })

  // @covers REQ-055#empty-scope
  it('選んだ範囲に出題できる過去問が 1 問も無いときは、テストを作らず 404 の {error}', async () => {
    const body = { kind: 'drill', topicId: 9999 }
    // 空振り対策: 同じ要求は過去問が 1 問でもあれば作れる（下の 404 は 0 問だけが出している）
    const ok = await post(world(startTables(1)), '/api/sessions', body)
    expect(ok.status, '過去問が 1 問ある範囲で作れない（この検査は空振りになる）').toBe(201)

    const w = world(startTables(0))
    const res = await post(w, '/api/sessions', body)
    expect(res.status).toBe(404)
    await errorBody(res)
    expect(sessionWrites(w), '0 問なのにテストの行が書かれている').toEqual([])
  })

  // @covers REQ-057#conflict-when-in-progress
  it('進行中のテストがあるのに始めようとしたら、過去問があっても新しいテストを作らず 409 の {error}', async () => {
    const body = { kind: 'middle', middleNo: 23 }
    // 空振り対策: 完了したテストしか無ければ作れる（下の 409 は「進行中」だけが出している）
    const done = await post(world(startTables(100, [session({ status: 'completed', correct_count: 7, finished_at: FINISHED })])), '/api/sessions', body)
    expect(done.status, '完了したテストがあるだけで始められない').toBe(201)

    const w = world(startTables(100, [session({})]))
    const res = await post(w, '/api/sessions', body)
    expect(res.status).toBe(409)
    await errorBody(res)
    expect(sessionWrites(w), '進行中があるのにテストの行が書かれている').toEqual([])
  })
})

/* ---------- 現在の問題・回答・締め ---------- */

/** 出題時スナップショット（契約 UC-004 の例 okInProgress の形）。控えは正解も持つ（REQ-058）。 */
const snapshot = (idx: number) => ({
  idx,
  text: `問題文その${idx}（検索順位を上げる技法の総称はどれか）`,
  choices: { ア: 'DNS', イ: 'RSS', ウ: 'SEO', エ: 'SNS' },
  answer: 'ア',
  citation: `出典：平成30年度 秋期 ITパスポート試験 問${idx + 1}`,
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 1,
  otherCitations: [] as string[],
})

/** session_questions の行。result は 0 未回答／1 正答／2 誤答（契約 ResultItem の result）。
 *  正解（出題時の控え）はどの問題も「ア」。 */
const sq = (idx: number, result: 0 | 1 | 2, userAnswer: string | null = null): Row => ({
  id: `sq-${idx}`,
  session_id: SID,
  question_id: `q-${idx}`,
  idx,
  snapshot: JSON.stringify(snapshot(idx)),
  answer: 'ア',
  user_answer: userAnswer,
  result,
  answered_at: result === 0 ? null : STARTED + idx,
})

/** 10 問のテスト。先頭 `correct` 問が正答、続く `wrong` 問が誤答、残りが未回答。 */
function tenQuestions(correct: number, wrong: number): Row[] {
  return Array.from({ length: 10 }, (_, idx) =>
    idx < correct ? sq(idx, 1, 'ア') : idx < correct + wrong ? sq(idx, 2, 'イ') : sq(idx, 0),
  )
}

/** 1 つのテストの世界（sessions の行 1 つと、その 10 問）。
 *  過去問の表（questions）は出題時と違う正解「エ」を持つ: 採点が控えでなく今のデータで
 *  行われていたら、正解が「エ」として返る。 */
function sessionWorld(over: Row, rows: Row[]): World {
  return world([
    { name: 'sessions', rows: [session(over)] },
    { name: 'session_questions', rows },
    { name: 'session_questions', rows, count: true },
    { name: 'questions', rows: rows.map((r) => ({ ...question(Number(r.idx)), id: r.question_id, answer: 'エ' })) },
  ])
}

/** 進行中で、8 問回答済み（5 正答・3 誤答）、位置 8・9 が未回答。現在の問題は位置 8。 */
const inProgress = () => sessionWorld({}, tenQuestions(5, 3))
const CURRENT = 8

const row = (w: World, idx: number) => (w.tables.find((t) => t.name === 'session_questions' && !t.count)!.rows as Row[]).find((r) => r.idx === idx)!
const sessionRow = (w: World) => (w.tables.find((t) => t.name === 'sessions')!.rows as Row[])[0]

const current = (w: World, user = USER) => get(w, `/api/sessions/${SID}/current`, user)
const answer = (w: World, idx: number, choice: string, user = USER) =>
  post(w, `/api/sessions/${SID}/answer`, { idx, answer: choice }, user)
const finish = (w: World, user = USER) => post(w, `/api/sessions/${SID}/finish`, {}, user)

type Current = { session: Record<string, unknown>; question: Record<string, unknown> | null; answered: number; finished: boolean }
type Answered = { correct: boolean; correctAnswer: string; explanation: unknown; remaining: number; finished: boolean }
type Finished = { ok: boolean; correct: number; total: number }

/** 契約 QuestionSnapshot の鍵（これ以外、とくに正解と解説は現在の問題に載らない）。 */
const SNAPSHOT_KEYS = ['idx', 'text', 'choices', 'citation', 'modified', 'hasFigure', 'figureDescription', 'figureImage', 'timesAsked', 'otherCitations']

describe('現在の問題（GET /api/sessions/:id/current。UC-004）', () => {
  // @covers REQ-060#no-answer-before-reply
  it('回答する前の現在の問題には、正解も問題解説も載らない（控えが正解を持っていても）', async () => {
    const w = inProgress()
    const res = await current(w)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as Current
    expect(body.question, '現在の問題が渡っていない（この検査は空振りになる）').not.toBeNull()
    expect(body.question!.text).toBe(snapshot(CURRENT).text)
    for (const key of Object.keys(body.question!)) {
      expect(SNAPSHOT_KEYS, `現在の問題に契約に無い鍵 ${key} が載っている`).toContain(key)
    }
    expect(text).not.toMatch(/"(answer|correctAnswer|correct|explanation|correctReason)"\s*:/)
  })

  // @covers REQ-058#smallest-unanswered
  it('未回答が飛び飛びに残っていても、現在の問題は未回答のうち最も小さい位置（行の並びに依らない）', async () => {
    // 未回答は位置 3・6・9。行は位置の降順で持たせ、先頭の行や最後の行を取っていれば違う位置になる
    const rows = tenQuestions(10, 0).map((r) => ([3, 6, 9].includes(Number(r.idx)) ? sq(Number(r.idx), 0) : r)).reverse()
    const w = sessionWorld({}, rows)
    const res = await current(w)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Current
    expect(body.question, '現在の問題が渡っていない').not.toBeNull()
    expect(body.question!.idx).toBe(3)
    expect(body.question!.text).toBe(snapshot(3).text)
    expect(body.answered).toBe(7)
    expect(body.finished).toBe(false)
  })

  // @covers REQ-071#no-current-when-all-answered
  it('未回答が 1 問も残っていない進行中のテストは、問題を渡さず finished で締めへ進ませる', async () => {
    const w = sessionWorld({}, tenQuestions(6, 4))
    const res = await current(w)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as Current
    expect(body.question).toBeNull()
    expect(body.finished).toBe(true)
    expect(body.answered).toBe(10)
    expect(text, '回答済みの問題の本文が渡っている').not.toContain('問題文その')
  })
})

describe('回答（POST /api/sessions/:id/answer。UC-004）', () => {
  // @covers REQ-061#grade-against-snapshot
  it('選んだ選択肢を出題時の控えの正解と比べて正誤を決め、選んだ選択肢と正誤を残す（今の過去問データの正解は使わない）', async () => {
    // 誤答（控えの正解は「ア」、今の過去問データは「エ」）
    const wrong = inProgress()
    const res = await answer(wrong, CURRENT, 'イ')
    expect(res.status).toBe(200)
    const got = (await res.json()) as Answered
    expect(got.correct).toBe(false)
    expect(got.correctAnswer, '正解が出題時の控えでなく今の過去問データになっている').toBe('ア')
    expect(answerWrites(wrong), '回答が記録されていない').not.toEqual([])
    expect(answerWrites(wrong).some((e) => e.params.includes('イ')), '選んだ選択肢が記録に入っていない').toBe(true)
    expect(row(wrong, CURRENT).result, '誤答の正誤が残っていない').toBe(2)

    // 正答
    const right = inProgress()
    const res2 = await answer(right, CURRENT, 'ア')
    expect(res2.status).toBe(200)
    const got2 = (await res2.json()) as Answered
    expect(got2.correct).toBe(true)
    expect(got2.correctAnswer).toBe('ア')
    expect(row(right, CURRENT).result, '正答の正誤が残っていない').toBe(1)
    expect(answerWrites(right).some((e) => e.params.includes('ア')), '選んだ選択肢が記録に入っていない').toBe(true)
  })

  // @covers REQ-064#counts-updated-after-answer
  it('回答を受け付けたあとの残りの未回答と回答済みの数は、その回答を含めた値になる', async () => {
    const w = inProgress()
    const before = (await (await current(w)).json()) as Current
    expect(before.answered, '回答前の回答済みの数（この検査の前提）').toBe(8)

    const res = await answer(w, CURRENT, 'ウ')
    expect(res.status).toBe(200)
    const got = (await res.json()) as Answered
    expect(got.remaining, '残りの未回答にいまの回答が数えられていない').toBe(1)
    expect(got.finished).toBe(false)

    const after = (await (await current(w)).json()) as Current
    expect(after.answered, '回答済みの数にいまの回答が数えられていない').toBe(9)
    expect(after.question?.idx, '次の現在の問題に進んでいない').toBe(CURRENT + 1)
  })

  // @covers REQ-066#duplicate-answer-kept-once
  it('同じ問題への回答が続けて 2 回送られたら、最初の 1 件だけを残し、2 回目は受け付けずに 409 の {error} で断る', async () => {
    const w = inProgress()
    const first = await answer(w, CURRENT, 'イ')
    expect(first.status).toBe(200)
    const second = await answer(w, CURRENT, 'ウ')
    expect(second.status, '2 回目の同じ問題への回答が 409 で断られていない').toBe(409)
    await errorBody(second)
    expect(answerWrites(w), '同じ問題の回答が 2 件書かれている').toHaveLength(1)
    const kept = row(w, CURRENT)
    expect(kept.result).toBe(2)
    expect(kept.user_answer, '2 回目の選択肢で上書きされている').toBe('イ')
    expect(
      (w.tables.find((t) => t.name === 'session_questions' && !t.count)!.rows as Row[]).filter((r) => r.idx === CURRENT),
    ).toHaveLength(1)
  })

  // @covers REQ-067#stale-idx-rejected
  it('送られた位置が現在の問題の位置と違うときは、前でも先でも、採点も記録もせず 409 の {error}', async () => {
    // 空振り対策: 現在の位置なら同じ世界で受け付けられる
    const ok = await answer(inProgress(), CURRENT, 'ア')
    expect(ok.status, '現在の位置の回答が通らない（この検査は空振りになる）').toBe(200)

    for (const idx of [CURRENT - 7, CURRENT - 1, CURRENT + 1]) {
      const w = inProgress()
      const res = await answer(w, idx, 'ア')
      expect(res.status, `位置 ${idx}`).toBe(409)
      await errorBody(res)
      expect(answerWrites(w), `位置 ${idx} で記録が書かれている`).toEqual([])
      expect(sessionWrites(w), `位置 ${idx} でテストの行が書かれている`).toEqual([])
      expect(row(w, CURRENT).result, `位置 ${idx} で現在の問題が採点されている`).toBe(0)
      expect(row(w, idx).user_answer, `位置 ${idx} の記録が書き換わっている`).toBe(idx < CURRENT ? (idx < 5 ? 'ア' : 'イ') : null)
    }
  })

  // @covers REQ-072#answer-when-no-unanswered
  it('未回答が 1 問も残っていない進行中のテストへの回答は、採点も記録もせず 409 の {error}', async () => {
    const w = sessionWorld({}, tenQuestions(6, 4))
    const res = await answer(w, 9, 'ア')
    expect(res.status).toBe(409)
    await errorBody(res)
    expect(answerWrites(w)).toEqual([])
    expect(sessionWrites(w)).toEqual([])
    expect(row(w, 9).user_answer, '回答済みの記録が書き換わっている').toBe('イ')
  })

  // @covers REQ-072#answer-after-completed
  it('完了したテストへの回答は、未回答の行が残っていても採点も記録もせず 409 の {error}', async () => {
    // 空振り対策: 同じ行の並びで進行中なら受け付けられる
    const ok = await answer(inProgress(), CURRENT, 'ア')
    expect(ok.status, '進行中なら通る回答が通らない（この検査は空振りになる）').toBe(200)

    const w = sessionWorld({ status: 'completed', correct_count: 5, finished_at: FINISHED }, tenQuestions(5, 3))
    const res = await answer(w, CURRENT, 'ア')
    expect(res.status).toBe(409)
    await errorBody(res)
    expect(answerWrites(w)).toEqual([])
    expect(sessionWrites(w)).toEqual([])
    expect(row(w, CURRENT).result).toBe(0)
  })
})

describe('締め（POST /api/sessions/:id/finish。UC-004）', () => {
  // @covers REQ-069#correct-count-confirmed
  it('未回答を残して締めたテストは完了になり、正解した問題の数が正答数として確定して返る', async () => {
    const w = inProgress()
    const res = await finish(w)
    expect(res.status).toBe(200)
    const got = (await res.json()) as Finished
    expect(got).toEqual({ ok: true, correct: 5, total: 10 })
    const s = sessionRow(w)
    expect(s.status, 'テストが完了になっていない').toBe('completed')
    expect(Number(s.correct_count), '正答数が確定していない').toBe(5)
    expect(s.finished_at, '締めた時刻が残っていない').not.toBeNull()
  })

  // @covers REQ-073#auto-finish-on-last-answer
  it('最後の未回答に回答すると未回答なしが伝わり、締めでテストが完了になって正答数（その回答を含む）が確定する', async () => {
    const w = sessionWorld({}, [...tenQuestions(5, 4).slice(0, 9), sq(9, 0)])
    const last = await answer(w, 9, 'ア')
    expect(last.status).toBe(200)
    const got = (await last.json()) as Answered
    expect(got.remaining).toBe(0)
    expect(got.finished, '最後の回答で未回答が無くなったことが伝わらない').toBe(true)

    const res = await finish(w)
    expect(res.status).toBe(200)
    expect((await res.json()) as Finished).toEqual({ ok: true, correct: 6, total: 10 })
    const s = sessionRow(w)
    expect(s.status).toBe('completed')
    expect(Number(s.correct_count)).toBe(6)
    expect(s.finished_at).not.toBeNull()
  })

  // @covers REQ-073#result-keeps-per-question
  it('締めても 1 問ごとの正誤と選んだ選択肢は残り、結果にそのまま出る', async () => {
    const w = sessionWorld({}, [...tenQuestions(5, 4).slice(0, 9), sq(9, 0)])
    expect((await answer(w, 9, 'ウ')).status).toBe(200)
    const writesBefore = answerWrites(w).length
    expect((await finish(w)).status).toBe(200)
    expect(answerWrites(w).length, '締めが 1 問ごとの記録を書き換えている').toBe(writesBefore)

    const expected = [
      ...Array.from({ length: 5 }, (_, idx) => ({ idx, userAnswer: 'ア', result: 1 })),
      ...Array.from({ length: 4 }, (_, i) => ({ idx: 5 + i, userAnswer: 'イ', result: 2 })),
      { idx: 9, userAnswer: 'ウ', result: 2 },
    ]
    for (const e of expected) {
      const r = row(w, e.idx)
      expect(r.user_answer, `位置 ${e.idx} の選んだ選択肢`).toBe(e.userAnswer)
      expect(r.result, `位置 ${e.idx} の正誤`).toBe(e.result)
    }

    const res = await get(w, `/api/sessions/${SID}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { idx: number; userAnswer: string | null; result: number; answer: string }[] }
    expect(body.items, '結果に 1 問ごとの項目が無い').toHaveLength(10)
    for (const e of expected) {
      const item = body.items.find((i) => i.idx === e.idx)
      expect(item, `結果に位置 ${e.idx} が無い`).toBeDefined()
      expect(item!.userAnswer, `結果の位置 ${e.idx} の選んだ選択肢`).toBe(e.userAnswer)
      expect(item!.result, `結果の位置 ${e.idx} の正誤`).toBe(e.result)
      expect(item!.answer, `結果の位置 ${e.idx} の正解が出題時の控えでない`).toBe('ア')
    }
  })

  // @covers REQ-075#second-finish-idempotent
  it('完了したテストを再び締めても、正答数と締めた時刻は最初の締めのまま返る（記録から数え直さない）', async () => {
    // 記録から数え直すと 5 になる行の並びで、最初の締めは 7 で確定している
    const w = sessionWorld({ status: 'completed', correct_count: 7, finished_at: FINISHED }, tenQuestions(5, 3))
    const res = await finish(w)
    expect(res.status).toBe(200)
    expect((await res.json()) as Finished).toEqual({ ok: true, correct: 7, total: 10 })
    const s = sessionRow(w)
    expect(Number(s.correct_count), '2 回目の締めで正答数が変わった').toBe(7)
    expect(Number(s.finished_at), '2 回目の締めで締めた時刻が変わった').toBe(FINISHED)
    expect(sessionWrites(w), '2 回目の締めがテストの行を書いている').toEqual([])
  })
})

describe('他人のテスト（UC-004。BR-018）', () => {
  // @covers REQ-076#other-users-session-not-found
  it('他人のテストを指した現在の問題・回答・締めは、在りもしない ID と同じ 404 の {error} で、内容も存在も漏らさず何も書かない', async () => {
    const other = () => sessionWorld({ user_id: OTHER, scope_label: '論点「他人の範囲」' }, tenQuestions(5, 3))
    const nobody = () => sessionWorld({ id: NOBODY, scope_label: '論点「他人の範囲」' }, tenQuestions(5, 3))
    const ops: { label: string; call: (w: World) => Promise<Response> }[] = [
      { label: '現在の問題', call: (w) => current(w) },
      { label: '回答', call: (w) => answer(w, CURRENT, 'ア') },
      { label: '締め', call: (w) => finish(w) },
    ]
    for (const { label, call } of ops) {
      const w = other()
      const res = await call(w)
      expect(res.status, label).toBe(404)
      const text = await res.text()
      expect(text, `${label} で他人のテストの内容が漏れている`).not.toContain('他人の範囲')
      expect(text, `${label} で他人のテストの問題文が漏れている`).not.toContain('問題文その')
      const body = JSON.parse(text) as Record<string, unknown>
      expect(Object.keys(body), label).toEqual(['error'])
      expect(String(body.error), label).toMatch(JAPANESE)

      const missing = await call(nobody())
      expect(missing.status, `${label}（在りもしない ID）`).toBe(404)
      expect(await missing.json(), `${label} で他人のテストと在りもしない ID の断りが違う（存在が分かる）`).toEqual(body)

      expect(answerWrites(w), `${label} で他人の記録が書かれている`).toEqual([])
      expect(sessionWrites(w), `${label} で他人のテストの行が書かれている`).toEqual([])
      expect(row(w, CURRENT).result, `${label} で他人の問題が採点されている`).toBe(0)
      expect(sessionRow(w).status, `${label} で他人のテストが締められている`).toBe('in_progress')
    }
  })
})
