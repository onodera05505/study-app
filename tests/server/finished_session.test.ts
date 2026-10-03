/** 終わったテスト（締めた・破棄した）に出題や再開を求めたときの境界（BR-034）。
 *
 *  叩くのは契約の操作の入口だけ（UC-004 getCurrentQuestion・UC-008 getMockCurrentQuestion ＝
 *  GET /api/sessions/:id/current、UC-006 getCurrentSession ＝ GET /api/sessions/current）。
 *
 *  この経路は DB を引くので、列名で持った行を返す偽の D1 を渡す（catalog.test.ts・
 *  session-builder.test.ts の作法）。本物のデータが要る件数・並びは scripts/check_api.py が
 *  本番相当で見る。ここで見るのは「終わったテストの問題文が渡らないこと」だけ。 */

import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const SECRET = 'test-secret'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

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
    const text = item.trim()
    const alias = /\bas\s+"?(\w+)"?\s*$/i.exec(text)
    if (alias) return alias[1]
    const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    return quoted.length > 0 ? quoted[quoted.length - 1] : text
  })
}

/** `"列" = ?` の形の条件を、束ねられた値と組にして取り出す（`limit ?` などは組にならない）。
 *  絞りを素通りさせると、進行中だけを返す問い合わせに終わった行を混ぜてしまう。 */
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

/** 列名で持った行を返す偽の D1（prepare → bind → raw/all/first）。 */
function fakeD1(tables: Table[]) {
  const rowsFor = (sql: string, params: unknown[]) => {
    const rows = tables.find((t) => t.match.test(sql))?.rows ?? []
    const where = conditions(sql, params)
    return rows.filter((row) =>
      where.every(({ column, equal, value }) => {
        if (!(column in row)) return true
        const same = String(row[column]) === String(value)
        return equal ? same : !same
      }),
    )
  }
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind: (...bound: unknown[]) => {
        params = bound
        return stmt
      },
      run: async () => ({ success: true, results: [], meta: {} }),
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

const env = (tables: Table[]) => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(tables) } as unknown as Bindings)

/** sessions の行（列名は schema のまま）。終わった行は status と finished_at を持つ。 */
const session = (over: Row): Row => ({
  user_id: 'u-1',
  kind: 'drill',
  source_exam: null,
  scope_label: '論点「オープンソースソフトウェア」',
  time_limit_sec: null,
  question_count: 10,
  correct_count: 7,
  started_at: 1759276800,
  finished_at: 1759280000,
  ...over,
})

/** 出題時スナップショット（契約 UC-004 の例 okInProgress の値）。渡ってはいけない問題文。 */
const SNAPSHOT = {
  idx: 3,
  text: 'インターネットの検索エンジンの検索結果において，自社のホームページの表示順位を，より上位にしようとするための技法や手法の総称はどれか。',
  choices: { ア: 'DNS', イ: 'RSS', ウ: 'SEO', エ: 'SNS' },
  citation: '出典：平成30年度 秋期 ITパスポート試験 問3',
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 2,
  otherCitations: [],
}

/** 未回答の行が残っている（締めても消えない）。締めた判断を未回答の有無に任せていると渡ってしまう。 */
const UNANSWERED: Table = {
  match: /session_questions[\s\S]*result\s*=\s*0/i,
  rows: [{ idx: SNAPSHOT.idx, snapshot: JSON.stringify(SNAPSHOT) }],
}
const ANSWERED_COUNT: Table = { match: /COUNT\(\*\)[\s\S]*session_questions/i, rows: [{ n: 3 }] }
const sessions = (rows: Row[]): Table => ({ match: /from "sessions"/, rows })

const SID = '8f14e45f-ea2b-4f1c-9a3e-6b1d2c7f4a90'
const MOCK_SID = '3f2a7c1e-5b84-4d6a-9e10-2c7b8a4f0d55'

async function get(path: string, tables: Table[]) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env(tables))
}

/** 出題を渡していない応答か（問題は null で、スナップショットの本文・選択肢が本文に現れない）。 */
async function noQuestion(res: Response) {
  const text = await res.text()
  expect(text).not.toContain(SNAPSHOT.text)
  expect(text).not.toContain(SNAPSHOT.choices.ウ)
  const body = JSON.parse(text) as { question?: unknown; finished?: unknown }
  expect(body.question ?? null).toBeNull()
  return body
}

/** 偽の D1 が出題を渡せている（＝未回答の行とスナップショットが経路に届く）ことの確認。
 *  渡せていなければ、終わったテストで問題が null でも空振りの緑になる。 */
async function expectDoubleDeliversQuestion() {
  const res = await get(`/api/sessions/${SID}/current`, [
    sessions([session({ id: SID, status: 'in_progress', correct_count: null, finished_at: null })]),
    ANSWERED_COUNT,
    UNANSWERED,
  ])
  expect(await res.text(), '偽の D1 が出題を渡せていない（この検査は空振りになる）').toContain(SNAPSHOT.text)
}

async function errorOf(res: Response) {
  const body = (await res.json()) as { error?: unknown }
  expect(typeof body.error).toBe('string')
  expect(String(body.error)).toMatch(JAPANESE)
}

describe('完了・破棄したテストの現在の問題（GET /api/sessions/:id/current。UC-004）', () => {
  // @covers REQ-237#current-of-completed
  it('完了したテストは、未回答の行が残っていても問題を渡さず終わっていることを示す', async () => {
    await expectDoubleDeliversQuestion()
    const res = await get(`/api/sessions/${SID}/current`, [
      sessions([session({ id: SID, status: 'completed' })]),
      ANSWERED_COUNT,
      UNANSWERED,
    ])
    expect(res.status).toBe(200)
    const body = await noQuestion(res)
    expect(body.finished).toBe(true)
  })

  // @covers REQ-237#current-of-discarded
  it('破棄されて残っていないテストは、問題を渡さず 404 の {error}', async () => {
    const res = await get(`/api/sessions/${SID}/current`, [sessions([]), ANSWERED_COUNT, UNANSWERED])
    expect(res.status).toBe(404)
    await errorOf(res)
  })
})

describe('締めた模試の現在の問題（GET /api/sessions/:id/current。UC-008）', () => {
  // @covers REQ-238#finished-session-no-question
  it('締めた模試は、未回答の行が残っていても問題を渡さず終了として返る', async () => {
    await expectDoubleDeliversQuestion()
    const res = await get(`/api/sessions/${MOCK_SID}/current`, [
      sessions([
        session({
          id: MOCK_SID,
          kind: 'mock',
          status: 'completed',
          source_exam: '2024r06',
          scope_label: '令和6年度 を通しで受験',
          time_limit_sec: 7200,
          question_count: 100,
          correct_count: 42,
        }),
      ]),
      ANSWERED_COUNT,
      UNANSWERED,
    ])
    expect(res.status).toBe(200)
    const body = await noQuestion(res)
    expect(body.finished).toBe(true)
  })
})

describe('終わったテストの再開（GET /api/sessions/current と戻り先の出題。UC-006）', () => {
  // @covers REQ-240#resume-completed
  it('締めたテストは再開先として案内されず、古い案内の ID をたどっても問題を渡さない', async () => {
    await expectDoubleDeliversQuestion()
    const completed = [sessions([session({ id: SID, status: 'completed' })]), ANSWERED_COUNT, UNANSWERED]
    const current = await get('/api/sessions/current', completed)
    expect(current.status).toBe(200)
    expect(((await current.json()) as { session?: unknown }).session ?? null).toBeNull()

    const resumed = await get(`/api/sessions/${SID}/current`, completed)
    expect(resumed.status).toBe(200)
    const body = await noQuestion(resumed)
    expect(body.finished).toBe(true)
  })

  // @covers REQ-240#resume-discarded
  it('破棄されたテストは再開先として案内されず、古い案内の ID をたどると 404 の {error}', async () => {
    const discarded = [sessions([]), ANSWERED_COUNT, UNANSWERED]
    const current = await get('/api/sessions/current', discarded)
    expect(current.status).toBe(200)
    expect(((await current.json()) as { session?: unknown }).session ?? null).toBeNull()

    const resumed = await get(`/api/sessions/${SID}/current`, discarded)
    expect(resumed.status).toBe(404)
    await errorOf(resumed)
  })
})
