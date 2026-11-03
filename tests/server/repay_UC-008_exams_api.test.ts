/** UC-008 模試（通し受験）の入口と開始の境界
 *  （listExams ＝ GET /api/exams、startMockExam ＝ POST /api/sessions）。
 *
 *  偽の D1 は列名で持った行を返し（finished_session.test.ts の作法）、ORDER BY と LIMIT を守る。
 *  並びを SQL に任せる実装も、取ってから並べ替える実装も、同じ検査で読めるようにするため。
 *  学びごとの値（1 回の問題数・制限時間・分野）は登録簿から引き、テストは値を持たない（BR-005）。 */

import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import targets from '../../src/shared/targets.json'
import examLabels from '../../data/ip/exam_labels.json'
import apExamLabels from '../../data/ap/exam_labels.json'
import feExamLabels from '../../data/fe/exam_labels.json'
import itcExamLabels from '../../data/itc/exam_labels.json'

type Row = Record<string, unknown>
type Table = { match: RegExp; rows: Row[] }

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

/** `"列" = ?` の形の条件を、束ねられた値と組にして取り出す（行が持たない列の条件は素通り）。 */
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

/** 列名で持った行を返す偽の D1（prepare → bind → raw/all/first）。
 *  走らせた書き込みの SQL を `executed` に記録する。テストが作られていないことを
 *  「sessions への INSERT が 1 件も無い」で見るのに使う。 */
function fakeD1(tables: Table[], executed: string[] = []) {
  const rowsFor = (sql: string, params: unknown[]) => {
    const rows = tables.find((t) => t.match.test(sql))?.rows ?? []
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
      bind: (...bound: unknown[]) => {
        params = bound
        return stmt
      },
      run: async () => {
        executed.push(sql)
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
  return { prepare, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) }
}

type Registered = { kind: string; mockSize: number; mockMinutes: number; fields: string[] }
const REGISTRY = targets as unknown as Record<string, Registered>
/** この検査が使う学び（資格型）。値はすべて登録簿から引く。 */
const LEARNING = 'ip'
const REG = REGISTRY[LEARNING]
/** 回の名前の登録（`data/ip/exam_labels.json`）。名前を引くのに使い、並びの正解には使わない。 */
const EXAM_LABELS = examLabels as Record<string, string>
/** 学びごとの回の名前の登録（回の並びの検査で、学びを切り替えて使う）。 */
const LABELS_BY_LEARNING: Record<string, Record<string, string>> = {
  ip: EXAM_LABELS,
  ap: apExamLabels as Record<string, string>,
  fe: feExamLabels as Record<string, string>,
  itc: itcExamLabels as Record<string, string>,
}

const SECRET = 'test-secret'
const env = (tables: Table[], executed: string[] = [], learning = LEARNING) =>
  ({ EXAM: learning, JWT_SECRET: SECRET, DB: fakeD1(tables, executed) } as unknown as Bindings)

async function request(
  method: string,
  path: string,
  body: unknown,
  tables: Table[],
  executed: string[] = [],
  learning = LEARNING,
) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(tables, executed, learning),
  )
}

/** 偽の D1 が過去問を持つ回。 */
const EXAM_ID = '2024r06'
/** 回の登録にはあるが、過去問が 1 問も投入されていない回。 */
const EMPTY_EXAM = '2009h21a'

/** 範囲に合う過去問 1 問ぶんの行（列の別名は出題の組み立ての QuestionRow のまま）。 */
const question = (n: number, over: Row = {}): Row => ({
  id: `q-${n}`,
  exam: EXAM_ID,
  examLabel: EXAM_LABELS[EXAM_ID],
  number: n,
  text: `問${n} の本文`,
  choices: JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `出典：${EXAM_LABELS[EXAM_ID]} ITパスポート試験 問${n}`,
  modified: 0,
  contentKey: `ck-${n}`,
  field: null,
  ...over,
})

/** 登録簿の分野それぞれに、1 回の問題数ぶんの過去問を持たせる（分野比率がどう切っても足りる）。 */
const POOL: Row[] = REG.fields.flatMap((field, f) =>
  Array.from({ length: REG.mockSize }, (_, i) => question(f * 1000 + i + 1, { field })),
)
/** 出題の組み立てが過去問を引く SQL（範囲の列で絞る）。 */
const FETCH = /SELECT DISTINCT q\.id/i
/** 回の一覧（回ごとの件数・受験回数・最高正答数を past_questions から集計する SQL）。 */
const EXAM_LIST = /past_questions[\s\S]*GROUP BY q\.exam/i
/** 回の登録（名前の表）。過去問の無い回も載っている。一覧をここから作ると過去問の無い回が出る。 */
const EXAM_REGISTRY: Table = {
  match: /exam_labels|from "?exams"?\b/i,
  rows: Object.entries(EXAM_LABELS).map(([exam, examLabel]) => ({ exam, examLabel })),
}

/** 過去問の行から、回ごとの一覧の行（件数つき）を組む。過去問の無い回は行にならない。 */
function examRows(questions: Row[]): Row[] {
  const byExam = new Map<string, Row>()
  for (const q of questions) {
    const exam = String(q.exam)
    const row = byExam.get(exam) ?? { exam, examLabel: EXAM_LABELS[exam], questions: 0, attempts: 0, bestScore: null }
    row.questions = Number(row.questions) + 1
    byExam.set(exam, row)
  }
  return [...byExam.values()]
}

const sessionInserts = (executed: string[]) => executed.filter((sql) => /insert into "sessions"/i.test(sql))
const anyInsert = (executed: string[]) => executed.filter((sql) => /^\s*insert\b/i.test(sql) && !/daily_visits/i.test(sql))

describe('模試の入口の回の一覧（GET /api/exams。UC-008）', () => {
  // @covers REQ-102#exam-order
  it.each([
    {
      label: 'ip: 同じ年度に春期と秋期を持つ回（年 1 回の回もまぜる）',
      learning: 'ip',
      given: ['2016h28h', '2018h30h', '2024r06', '2016h28a', '2018h30a'],
      expected: ['2024r06', '2018h30a', '2018h30h', '2016h28a', '2016h28h'],
    },
    {
      label: 'ap: 同じ年度の春期と秋期（鍵の順は春期が先でも秋期が先）と 10 月の回',
      learning: 'ap',
      given: ['2024r06h', '2018h30h', '2025r07h', '2020r02o', '2025r07a', '2018h30a', '2024r06a'],
      expected: ['2025r07a', '2025r07h', '2024r06a', '2024r06h', '2020r02o', '2018h30a', '2018h30h'],
    },
    {
      label: 'ip: 10 月の回と、年度の境目（平成 31 年度春期・令和元年度秋期は同じ年度）',
      learning: 'ip',
      given: ['2019h31h', '2020r02o', '2021r03', '2019r01a'],
      expected: ['2021r03', '2020r02o', '2019r01a', '2019h31h'],
    },
    {
      label: 'fe: 同じ年度の春期と秋期が並ぶ回の集まり',
      learning: 'fe',
      given: ['2017h29a', '2019h31h', '2018h30h', '2019r01a', '2018h30a'],
      expected: ['2019r01a', '2019h31h', '2018h30a', '2018h30h', '2017h29a'],
    },
    {
      label: 'ip: 特別回は同じ年度の秋期の後（その年度に春期は無い）、前後の年度の春期・秋期とまぜる',
      learning: 'ip',
      given: ['2010h22h', '2011h23tokubetsu', '2012h24h', '2011h23a', '2010h22a', '2012h24a'],
      expected: ['2012h24a', '2012h24h', '2011h23a', '2011h23tokubetsu', '2010h22a', '2010h22h'],
    },
    {
      label: 'ロードマップ型（itc）: 最初の回から学ぶ順',
      learning: 'itc',
      given: ['itc-d10', 'itc-d02', 'itc-d14', 'itc-d01', 'itc-d09'],
      expected: ['itc-d01', 'itc-d02', 'itc-d09', 'itc-d10', 'itc-d14'],
    },
  ])('一覧は BR-038 の並び（実施の時期の順）で、持ち込んだ順にも鍵の順にも依らない — $label', async ({ learning, given, expected }) => {
    const labels = LABELS_BY_LEARNING[learning]
    for (const exam of given) expect(labels[exam], `${exam} が ${learning} の回の登録に無い（この検査の前提が崩れる）`).toBeDefined()
    expect(REGISTRY[learning], `${learning} が登録簿に無い`).toBeDefined()
    const rows = given.map((exam) => ({ exam, examLabel: labels[exam], questions: 2, attempts: 0, bestScore: null }))
    const registry: Table = {
      match: EXAM_REGISTRY.match,
      rows: Object.entries(labels).map(([exam, examLabel]) => ({ exam, examLabel })),
    }
    const res = await request('GET', '/api/exams', undefined, [{ match: EXAM_LIST, rows }, registry], [], learning)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exams: { exam: string }[] }
    expect(body.exams.map((e) => e.exam)).toEqual(expected)
  })

  // @covers REQ-102#only-answerable-exams
  it('出題できる過去問が 1 問も無い回は、回の登録にあっても一覧に出ない', async () => {
    expect(EXAM_LABELS[EMPTY_EXAM], `${EMPTY_EXAM} が回の登録に無い（この検査の前提が崩れる）`).toBeDefined()
    const rows = examRows([question(1), question(2), question(3, { exam: '2016h28h' })])
    const res = await request('GET', '/api/exams', undefined, [{ match: EXAM_LIST, rows }, EXAM_REGISTRY])
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exams: { exam: string; questions: number }[] }
    const ids = body.exams.map((e) => e.exam)
    expect(ids, '過去問のある回が出ていない（この検査は空振りになる）').toContain(EXAM_ID)
    expect(ids).toContain('2016h28h')
    expect(ids, '過去問の無い回が一覧に出ている').not.toContain(EMPTY_EXAM)
    for (const e of body.exams) expect(e.questions, `${e.exam} の問題数`).toBeGreaterThanOrEqual(1)
  })
})

describe('模試の開始（POST /api/sessions。UC-008）', () => {
  // @covers REQ-105#created-with-registry-values
  it('ランダム構成は登録簿の 1 回の問題数と制限時間で作られ、回を選んだときも制限時間は登録簿の値になる', async () => {
    const random = await request('POST', '/api/sessions', { kind: 'mock' }, [{ match: FETCH, rows: POOL }])
    expect(random.status).toBe(201)
    const created = (await random.json()) as { questionCount: number; timeLimitSec: number }
    expect(created.questionCount, '問題数が登録簿の値でない').toBe(REG.mockSize)
    expect(created.timeLimitSec, '制限時間が登録簿の値でない').toBe(REG.mockMinutes * 60)

    const byExam = await request('POST', '/api/sessions', { kind: 'mock', exam: EXAM_ID }, [{ match: FETCH, rows: POOL }])
    expect(byExam.status).toBe(201)
    const fromExam = (await byExam.json()) as { timeLimitSec: number }
    expect(fromExam.timeLimitSec, '回を選んだ模試の制限時間が登録簿の値でない').toBe(REG.mockMinutes * 60)
  })

  // @covers REQ-109#empty-scope-no-session
  it('出題できる問題が 1 問も無い範囲（過去問の無い回・過去問が 1 問も無いランダム構成）ではテストを作らず 400 の {error}', async () => {
    // 同じ偽の D1 で、過去問のある回は作れる（下の 400 が「出題できる問題が無い」だけで出ていることの裏づけ）
    const kept: string[] = []
    const ok = await request('POST', '/api/sessions', { kind: 'mock', exam: EXAM_ID }, [{ match: FETCH, rows: POOL }], kept)
    expect(ok.status, '過去問のある回が作れない（この検査は空振りになる）').toBe(201)
    expect(sessionInserts(kept)).toHaveLength(1)

    for (const [label, body, tables] of [
      ['過去問の無い回', { kind: 'mock', exam: EMPTY_EXAM }, [{ match: FETCH, rows: POOL }]],
      ['過去問が 1 問も無いランダム構成', { kind: 'mock' }, [{ match: FETCH, rows: [] }]],
    ] as [string, unknown, Table[]][]) {
      const executed: string[] = []
      const res = await request('POST', '/api/sessions', body, tables, executed)
      expect(res.status, label).toBe(400)
      const payload = (await res.json()) as Record<string, unknown>
      expect(Object.keys(payload), `${label}: 本文は {error} だけ`).toEqual(['error'])
      expect(String(payload.error), label).toMatch(/[ぁ-んァ-ヶ一-龥]/)
      expect(anyInsert(executed), `${label}: テストか出題の行が書かれている`).toEqual([])
    }
  })
})
