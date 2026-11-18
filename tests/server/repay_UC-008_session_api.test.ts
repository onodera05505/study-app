/** UC-008 模試（通し受験）の進行と結果の境界
 *  （UC-004 の契約 getCurrentQuestion ＝ GET /api/sessions/:id/current、answerQuestion ＝ POST /api/sessions/:id/answer、
 *  getSessionResult ＝ GET /api/sessions/:id。模試も同じ経路）。
 *
 *  偽の D1 は列名で持った行を返し（finished_session.test.ts の作法）、ORDER BY と LIMIT を守る。
 *  回答の経路だけは書き込みを状態に反映する（回答した行が未回答から外れ、件数が動く）。
 *  時刻はサーバの時計なので、制限時間つきの模試は時計を止めて叩く。 */

import { describe, expect, it, vi } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import targets from '../../src/shared/targets.json'

const SECRET = 'test-secret'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

type Row = Record<string, unknown>
type Table = { match: RegExp; rows: Row[] | (() => Row[]) }
type Write = { sql: string; params: unknown[] }

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
    const text = item.trim()
    const alias = /\bas\s+"?(\w+)"?\s*$/i.exec(text)
    if (alias) return alias[1]
    const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    return quoted.length > 0 ? quoted[quoted.length - 1] : text
  })
}

function conditions(sql: string, params: unknown[]): { column: string; equal: boolean; value: unknown }[] {
  const found: { column: string; equal: boolean; value: unknown }[] = []
  let index = 0
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== '?') continue
    const before = sql.slice(Math.max(0, i - 48), i)
    const match = /"?(\w+)"?\s*(=|<>|!=)\s*$/.exec(before)
    if (match) found.push({ column: match[1], equal: match[2] === '=', value: params[index] })
    index++
  }
  return found
}

/** ORDER BY（先頭の 1 列）と数の LIMIT を行に適用する。 */
function orderAndLimit(sql: string, rows: Row[]): Row[] {
  let out = [...rows]
  const order = /order by\s+(?:"?\w+"?\.)?"?(\w+)"?\s*(asc|desc)?/i.exec(sql)
  if (order) {
    const col = order[1]
    const sign = (order[2] ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
    out.sort((a, b) => {
      const x = a[col]
      const y = b[col]
      if (x === y) return 0
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
      return (String(x) < String(y) ? -1 : 1) * sign
    })
  }
  const limit = /limit\s+(\d+)/i.exec(sql)
  if (limit) out = out.slice(0, Number(limit[1]))
  return out
}

/** 列名で持った行を返す偽の D1。書き込みは `writes` に SQL と値を記録し、`onWrite` で状態に反映できる。 */
function fakeD1(tables: Table[], writes: Write[] = [], onWrite?: (w: Write) => void) {
  const rowsFor = (sql: string, params: unknown[]) => {
    const table = tables.find((t) => t.match.test(sql))
    const rows = typeof table?.rows === 'function' ? table.rows() : (table?.rows ?? [])
    const where = conditions(sql, params)
    const matched = rows.filter((row) =>
      where.every(({ column, equal, value }) => {
        if (!(column in row)) return true
        const same = String(row[column]) === String(value)
        return equal ? same : !same
      }),
    )
    return orderAndLimit(sql, matched)
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
        const w = { sql, params }
        writes.push(w)
        onWrite?.(w)
        return { success: true, results: [], meta: {} }
      },
      all: async () => ({ success: true, results: rowsFor(sql, params), meta: {} }),
      first: async () => rowsFor(sql, params)[0] ?? null,
      raw: async () => {
        const names = selectNames(sql)
        return rowsFor(sql, params).map((row) => names.map((name) => (name in row ? row[name] : null)))
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

type Registered = { kind: string; fieldThreshold: boolean }
const REGISTRY = targets as unknown as Record<string, Registered>
const learnings = Object.entries(REGISTRY).filter(([k, v]) => !k.startsWith('_') && v.kind === 'exam')
/** 分野ごとの基準点を置く学びと、置かない学び（どちらも登録簿から選ぶ。値は持たない）。 */
const WITH_FIELD_THRESHOLD = learnings.find(([, v]) => v.fieldThreshold)?.[0]
const WITHOUT_FIELD_THRESHOLD = learnings.find(([, v]) => !v.fieldThreshold)?.[0]

const env = (learning: string, tables: Table[], writes: Write[] = [], onWrite?: (w: Write) => void) =>
  ({ EXAM: learning, JWT_SECRET: SECRET, DB: fakeD1(tables, writes, onWrite) } as unknown as Bindings)

async function request(
  method: string,
  path: string,
  body: unknown,
  tables: Table[],
  opts: { learning?: string; writes?: Write[]; onWrite?: (w: Write) => void } = {},
) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(opts.learning ?? WITH_FIELD_THRESHOLD ?? 'ip', tables, opts.writes, opts.onWrite),
  )
}

const SID = '3f2a7c1e-5b84-4d6a-9e10-2c7b8a4f0d55'
/** 制限時間つきの模試の時刻の基点（UC-004 の契約 getSessionResult の例 ok の startedAt と timeLimitSec）。 */
const START = 1759276800
const LIMIT = 7200

/** sessions の行（列名は schema のまま）。 */
const mockSession = (over: Row): Row => ({
  id: SID,
  user_id: 'u-1',
  kind: 'mock',
  source_exam: '2024r06',
  scope_label: '令和6年度 を通しで受験',
  time_limit_sec: LIMIT,
  question_count: 100,
  correct_count: null,
  started_at: START,
  finished_at: null,
  status: 'in_progress',
  ...over,
})
const sessions = (rows: Row[]): Table => ({ match: /from "sessions"/i, rows })

/** 開始から elapsed 秒の「いま」で叩く（時計を止める）。 */
async function atElapsed<T>(elapsed: number, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime((START + elapsed) * 1000)
    return await body()
  } finally {
    vi.useRealTimers()
  }
}

/** 渡ってはいけない問題解説の文（出題中の応答に現れたら漏れ）。 */
const LEAK = '正解はウ。この文が出題中に見えたら答えが漏れている。'

/** 出題時スナップショット（正解を含む。出題中の応答には正解を落として渡す）。 */
const snapshot = (idx: number) => ({
  idx,
  text: `位置 ${idx} の問題文`,
  choices: { ア: `${idx}-a`, イ: `${idx}-b`, ウ: `${idx}-c`, エ: `${idx}-d` },
  answer: 'ウ',
  explanation: { correctReason: LEAK, choices: [] },
  citation: `出典：令和6年度 ITパスポート試験 問${idx + 1}`,
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 1,
  otherCitations: [],
})

/** 未回答の行（session_questions。result = 0）。回答の経路が要る列（行の id・問題の id）まで持つ。 */
const unansweredRow = (idx: number): Row => ({
  id: `sq-${idx}`,
  idx,
  result: 0,
  snapshot: JSON.stringify(snapshot(idx)),
  question_id: `q-${idx}`,
  user_answer: null,
})

/** 進行中の模試の状態。回答の UPDATE で未回答が 1 行減り、回答済みが 1 増える。 */
function running(unanswered: number[], answered: number, over: Row = {}) {
  const state = { unanswered: unanswered.map(unansweredRow), answered }
  const tables: Table[] = [
    sessions([mockSession(over)]),
    { match: /COUNT\(\*\)[\s\S]*result\s*<>\s*0/i, rows: () => [{ n: state.answered }] },
    { match: /COUNT\(\*\)[\s\S]*result\s*=\s*0/i, rows: () => [{ n: state.unanswered.length }] },
    { match: /session_questions[\s\S]*result\s*=\s*0/i, rows: () => state.unanswered },
  ]
  const onWrite = ({ sql, params }: Write) => {
    if (!/update "session_questions"/i.test(sql)) return
    const i = state.unanswered.findIndex((row) => params.includes(row.id))
    if (i < 0) return
    state.unanswered.splice(i, 1)
    state.answered += 1
  }
  return { tables, onWrite, state }
}

const current = (elapsed: number, r: ReturnType<typeof running>) =>
  atElapsed(elapsed, () => request('GET', `/api/sessions/${SID}/current`, undefined, r.tables))

describe('進行中の模試の現在の問題（GET /api/sessions/:id/current。UC-008）', () => {
  // @covers REQ-111#lowest-unanswered
  it('未回答が飛び飛びでも、未回答のうち最も小さい位置の問題が渡る（未回答が 1 問だけでも同じ）', async () => {
    // 行は位置の順に並んでいない（並べるのはサーバの仕事）
    const res = await current(100, running([7, 2, 5], 97))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: { idx: number; text: string } | null; finished: boolean }
    expect(body.question, '出題が渡っていない').not.toBeNull()
    expect(body.question!.idx).toBe(2)
    expect(body.question!.text).toBe(snapshot(2).text)
    expect(body.finished).toBe(false)

    const last = await current(100, running([9], 99))
    const only = (await last.json()) as { question: { idx: number } | null }
    expect(only.question?.idx, '未回答が 1 問だけのときにその問題が渡らない').toBe(9)
  })

  // @covers REQ-111#progress-and-remaining
  it('回答済みの件数と残り時間（制限時間から経過ぶんを引いた秒）が添う', async () => {
    const res = await current(100, running([42, 43], 42))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { answered: number; remainingSec: number }
    expect(body.answered).toBe(42)
    expect(body.remainingSec).toBe(LIMIT - 100)
  })

  // @covers REQ-111#no-answer-leak
  it('出題中の応答に正解と問題解説が入らない（BR-021）', async () => {
    const res = await current(100, running([0], 0))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text, '出題が渡っていない（この検査は空振りになる）').toContain(snapshot(0).text)
    expect(text, '問題解説が出題中に渡っている').not.toContain(LEAK)
    const body = JSON.parse(text) as { question: Record<string, unknown> }
    for (const key of ['answer', 'correctAnswer', 'explanation']) {
      expect(body.question, `question.${key} が出題中に渡っている`).not.toHaveProperty(key)
      expect(body, `${key} が出題中に渡っている`).not.toHaveProperty(key)
    }
  })

  // @covers REQ-116#no-unanswered-finished
  it('未回答が 1 問も無い進行中の模試では、問題を渡さず終了として返る（時間切れではない）', async () => {
    // 同じ偽の D1 で未回答が 1 問あれば出題が渡る（下の question: null は未回答が無いことだけが出している）
    const open = (await (await current(100, running([4], 4, { question_count: 5 }))).json()) as { question: unknown }
    expect(open.question, '未回答があるのに出題が渡らない（この検査は空振りになる）').not.toBeNull()

    const res = await current(100, running([], 5, { question_count: 5 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.question ?? null).toBeNull()
    expect(body.finished).toBe(true)
    expect(body.expired).toBe(false)
    expect(body.answered).toBe(5)
  })
})

describe('模試の回答（POST /api/sessions/:id/answer。UC-008）', () => {
  // @covers REQ-113#answer-recorded
  it('選んだ記号がその位置の回答として記録され、残りの問数が 1 減る', async () => {
    const r = running([3, 4], 3, { question_count: 5 })
    const writes: Write[] = []
    const res = await atElapsed(100, () =>
      request('POST', `/api/sessions/${SID}/answer`, { idx: 3, answer: 'イ' }, r.tables, { writes, onWrite: r.onWrite }),
    )
    expect(res.status).toBe(200)
    const recorded = writes.filter((w) => /session_questions/i.test(w.sql) && /^\s*(update|insert)\b/i.test(w.sql))
    expect(recorded, '回答が記録されていない').toHaveLength(1)
    expect(recorded[0].params, '選んだ記号が記録に入っていない').toContain('イ')
    expect(recorded[0].params, '位置 3 の行に記録されていない').toContain('sq-3')
    const body = (await res.json()) as { remaining: number; finished: boolean }
    expect(body.remaining, '残りの問数が 1 減っていない').toBe(1)
    expect(body.finished).toBe(false)
  })
})

/** 合否の基準（app_settings の行。運用で変える設定値の正本）。検査の入力はこの値から組む。 */
const OVERALL_PCT = 60
const FIELD_PCT = 30
const SETTINGS: Table = {
  match: /from "app_settings"/i,
  rows: [
    {
      id: 1,
      drill_size: 10,
      mock_size: null,
      mock_time_limit_sec: null,
      pass_overall_pct: OVERALL_PCT,
      pass_field_pct: FIELD_PCT,
      mastered_streak: 3,
      updated_at: START,
    },
  ],
}

type FieldRow = { field: string; total: number; correct: number }

/** 締めた模試の結果の表（分野別の集計・総合の集計・問題ごとの行）。 */
function completed(fields: FieldRow[]): Table[] {
  const total = fields.reduce((n, f) => n + f.total, 0)
  const correct = fields.reduce((n, f) => n + f.correct, 0)
  return [
    sessions([mockSession({ status: 'completed', correct_count: correct, finished_at: START + 3000, question_count: total })]),
    SETTINGS,
    { match: /GROUP BY s\.field/i, rows: fields },
    { match: /SELECT COUNT\(\*\) AS total/i, rows: [{ total, correct }] },
    {
      match: /explCorrectReason[\s\S]*ORDER BY sq\.idx/i,
      rows: [
        {
          idx: 0,
          snapshot: JSON.stringify(snapshot(0)),
          userAnswer: 'ア',
          result: 2,
          topicId: null,
          topicTerm: null,
          explCorrectReason: null,
          explChoicesJson: null,
        },
      ],
    },
  ]
}

async function passedOf(fields: FieldRow[], learning: string, label: string): Promise<boolean> {
  const res = await atElapsed(4000, () => request('GET', `/api/sessions/${SID}`, undefined, completed(fields), { learning }))
  expect(res.status, label).toBe(200)
  const body = (await res.json()) as {
    passed: boolean
    overall: { pct: number }
    criteria: { overallPct: number; fieldPct: number }
  }
  expect(body.criteria.overallPct, `${label}: 総合の基準が app_settings の値で運ばれていない（この検査の前提が崩れる）`).toBe(OVERALL_PCT)
  return body.passed
}

describe('合否の目安の判定（GET /api/sessions/:id の passed。UC-008）', () => {
  const FIELD_A = 'ストラテジ系'
  const FIELD_B = 'テクノロジ系'

  // @covers REQ-121#overall-threshold
  it('総合の正答率が基準ちょうどなら届き、1 ポイント下なら届かない（分野は基準を満たしている）', async () => {
    const learning = WITH_FIELD_THRESHOLD!
    expect(learning, '分野ごとの基準点を置く学びが登録簿に無い').toBeDefined()
    expect(await passedOf([{ field: FIELD_A, total: 100, correct: OVERALL_PCT }], learning, '基準ちょうど')).toBe(true)
    expect(await passedOf([{ field: FIELD_A, total: 100, correct: OVERALL_PCT - 1 }], learning, '基準の 1 下')).toBe(false)
  })

  // @covers REQ-121#field-threshold-and
  it('分野ごとの基準点がある学びでは、総合が届いていても 1 つの分野が基準未満なら届かない（基準ちょうどは届く）', async () => {
    const learning = WITH_FIELD_THRESHOLD!
    expect(learning, '分野ごとの基準点を置く学びが登録簿に無い').toBeDefined()
    const atField = FIELD_PCT / 2
    const strong = { field: FIELD_A, total: 50, correct: 50 }
    // 総合は両方の場合で基準以上（分野だけが判定を分ける）
    expect((50 + atField - 1) / 100 >= OVERALL_PCT / 100, '総合が基準を割っている（この検査の前提が崩れる）').toBe(true)
    expect(await passedOf([strong, { field: FIELD_B, total: 50, correct: atField }], learning, '分野が基準ちょうど')).toBe(true)
    expect(await passedOf([strong, { field: FIELD_B, total: 50, correct: atField - 1 }], learning, '分野が基準未満')).toBe(false)
  })

  // @covers REQ-121#no-field-threshold-learning
  it('分野ごとの基準点を置かない学びでは、基準未満の分野があっても総合だけで判定する', async () => {
    expect(WITHOUT_FIELD_THRESHOLD, '分野ごとの基準点を置かない学びが登録簿に無い').toBeDefined()
    expect(WITH_FIELD_THRESHOLD, '分野ごとの基準点を置く学びが登録簿に無い').toBeDefined()
    const weakField = { field: FIELD_B, total: 50, correct: Math.max(0, FIELD_PCT / 2 - 5) }
    const fields = [{ field: FIELD_A, total: 50, correct: OVERALL_PCT - weakField.correct }, weakField]
    expect(await passedOf(fields, WITHOUT_FIELD_THRESHOLD!, '分野の基準点を置かない学び')).toBe(true)
    // 同じ結果でも、分野ごとの基準点を置く学びでは届かない（置く／置かないの差だけが判定を分ける）
    expect(await passedOf(fields, WITH_FIELD_THRESHOLD!, '分野の基準点を置く学び')).toBe(false)
  })
})

describe('完了していないテストの結果（GET /api/sessions/:id。UC-008）', () => {
  // @covers REQ-115#not-finished-not-shown
  it('進行中のテストの結果は示さず、まだ終わっていない旨の 404 の {error, code} だけが返る', async () => {
    // 同じ表で完了なら結果が返る（下の 404 は完了していないことだけが出している）
    const done = await atElapsed(4000, () =>
      request('GET', `/api/sessions/${SID}`, undefined, completed([{ field: 'ストラテジ系', total: 10, correct: 7 }])),
    )
    expect(done.status, '完了した模試の結果が返らない（この検査は空振りになる）').toBe(200)
    expect(((await done.json()) as { overall: { total: number } }).overall.total).toBe(10)

    const tables = completed([{ field: 'ストラテジ系', total: 10, correct: 7 }]).map((t) =>
      t.match.test('from "sessions"') ? sessions([mockSession({ question_count: 10 })]) : t,
    )
    const res = await atElapsed(100, () => request('GET', `/api/sessions/${SID}`, undefined, tables))
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text, '完了していないのに問題の本文が渡っている').not.toContain(snapshot(0).text)
    expect(text, '完了していないのに問題解説が渡っている').not.toContain(LEAK)
    const body = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(body).sort(), '本文は {error, code} だけ').toEqual(['code', 'error'])
    expect(String(body.error)).toMatch(JAPANESE)
  })
})
