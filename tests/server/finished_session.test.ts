/** 終わったテスト（締めた・破棄した・残り時間が 0 に達した）に出題や再開を求めたときの境界
 *  （BR-034・残り時間は UC-008 の REQ-117・REQ-119・REQ-123）。
 *
 *  叩くのは契約の操作の入口だけ（UC-004 getCurrentQuestion ＝ GET /api/sessions/:id/current（模試も同じ経路）、
 *  UC-006 getCurrentSession ＝ GET /api/sessions/current）。
 *
 *  この経路は DB を引くので、列名で持った行を返す偽の D1 を渡す（catalog.test.ts・
 *  session-builder.test.ts の作法）。本物のデータが要る件数・並びは scripts/check_api.py が
 *  本番相当で見る。ここで見るのは「終わったテストの問題文が渡らないこと」だけ。 */

import { describe, expect, it, vi } from 'vitest'
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

/** 列名で持った行を返す偽の D1（prepare → bind → raw/all/first/run、batch）。
 *  走らせた SQL を `executed` に記録する。断られた要求が何も書いていないことを見るのに使う。 */
function fakeD1(tables: Table[], executed: string[] = []) {
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
      sql,
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
  /** D1 の batch（1 つのトランザクション）。渡された文を順に、run と同じく記録して当てる。
   *  読み出しの文は all と同じ行を返す。 */
  const batch = async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => {
    const out: unknown[] = []
    for (const s of stmts) out.push(/^\s*(select|with)\b/i.test(s.sql) ? await s.all() : await s.run())
    return out
  }
  return { prepare, batch, exec: async () => ({ count: 0, duration: 0 }) }
}

const env = (tables: Table[], executed: string[] = []) =>
  ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(tables, executed) } as unknown as Bindings)

/** 回答の記録（session_questions）とテストの行（sessions）への書き込みだけを取り出す。 */
const answerWrites = (executed: string[]) =>
  executed.filter((sql) => /^\s*(insert|update|delete)\b/i.test(sql) && /"(session_questions|sessions)"/i.test(sql))

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

/** 制限時間つきの模試の時刻の基点（UC-004 の契約 getSessionResult の例 ok の startedAt と timeLimitSec）。 */
const START = 1759276800
const LIMIT = 7200

/** 制限時間つきで始まった模試の行（進行中か完了かは over で与える）。 */
const mockSession = (over: Row): Row =>
  session({
    id: MOCK_SID,
    kind: 'mock',
    source_exam: '2024r06',
    scope_label: '令和6年度 を通しで受験',
    time_limit_sec: LIMIT,
    question_count: 100,
    started_at: START,
    ...over,
  })

/** 開始から elapsed 秒の「いま」で叩く。時刻はサーバの時計なので、境界（残りちょうど 0・
 *  締めた時刻がちょうど制限時間）と「いまが期限の後でも締めた時刻で決まる」を揺れなく測るために
 *  時計を止める。 */
async function atElapsed<T>(elapsed: number, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime((START + elapsed) * 1000)
    return await body()
  } finally {
    vi.useRealTimers()
  }
}

async function get(path: string, tables: Table[], executed: string[] = []) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env(tables, executed))
}

async function post(path: string, body: unknown, tables: Table[], executed: string[] = []) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env(tables, executed),
  )
}

/** 出題を渡していない応答か（問題は null で、スナップショットの本文・選択肢が本文に現れない）。 */
async function noQuestion(res: Response) {
  const text = await res.text()
  expect(text).not.toContain(SNAPSHOT.text)
  expect(text).not.toContain(SNAPSHOT.choices.ウ)
  const body = JSON.parse(text) as Record<string, unknown>
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

/** 制限時間つきで進行中の模試（締めても破棄してもいない）。 */
const RUNNING_MOCK = [
  sessions([mockSession({ status: 'in_progress', correct_count: null, finished_at: null })]),
  ANSWERED_COUNT,
  UNANSWERED,
]

describe('残り時間が 0 に達した進行中の模試の現在の問題（GET /api/sessions/:id/current。UC-008）', () => {
  const currentAt = (elapsed: number) =>
    atElapsed(elapsed, () => get(`/api/sessions/${MOCK_SID}/current`, RUNNING_MOCK))

  // @covers REQ-117#expired-finished
  it('残り時間が 0 に達した進行中の模試は、未回答が残っていても問題を渡さず時間切れの終了として返る（境界は残り 0 ちょうど）', async () => {
    // 0 に達する前（残り 1 秒）では同じ偽の D1 が問題を渡す
    // ＝下の question: null は時間切れだけが出している（出題が届いていないのではない）
    const beforeZero = await currentAt(LIMIT - 1)
    expect(beforeZero.status).toBe(200)
    const open = (await beforeZero.json()) as Record<string, unknown>
    expect(open.question, '残り 1 秒で出題が渡っていない（この検査は空振りになる）').not.toBeNull()
    expect(open.finished).toBe(false)
    expect(open.remainingSec).toBe(1)

    for (const elapsed of [LIMIT, LIMIT + 800]) {
      const res = await currentAt(elapsed)
      expect(res.status, `経過 ${elapsed} 秒`).toBe(200)
      const body = await noQuestion(res)
      expect(body.finished, `経過 ${elapsed} 秒`).toBe(true)
      expect(body.expired, `経過 ${elapsed} 秒`).toBe(true)
      expect(body.remainingSec, `経過 ${elapsed} 秒`).toBe(0)
    }
  })
})

describe('完了した模試を時間切れとして扱うかは締めた時刻で決まる（UC-008）', () => {
  /** 締めた時刻だけを変えた完了の模試。 */
  const completedAfter = (afterStart: number) => [
    sessions([mockSession({ status: 'completed', correct_count: 1, finished_at: START + afterStart })]),
    ANSWERED_COUNT,
    UNANSWERED,
  ]

  /** 残り時間が 0 に達する時刻をとうに過ぎた「いま」で開き直す。時間切れの扱いが「いま」で
   *  決まるならここで true に倒れる＝締めた時刻で決まっていることをこの 1 点が見分ける。 */
  const reopenedLongAfter = <T>(body: () => Promise<T>) => atElapsed(LIMIT + 100_000, body)

  const expiredOf = async (res: Response, label: string) => {
    expect(res.status, label).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    return body.expired
  }

  // @covers REQ-123#in-time-not-expired
  it('残り時間が 0 に達する前に締めた模試は、0 に達する時刻を過ぎてから開き直しても時間切れにならない（現在の問題の取得）', async () => {
    // 達する前の側の端は残り 1 秒で締めた回（ちょうど 0 で締めた回は時間切れの側。
    // REQ-117・REQ-119 と同じ切り方）
    for (const afterStart of [100, LIMIT - 1]) {
      const res = await reopenedLongAfter(() => get(`/api/sessions/${MOCK_SID}/current`, completedAfter(afterStart)))
      expect(await expiredOf(res, `締めたのは開始から ${afterStart} 秒後`), `締めたのは開始から ${afterStart} 秒後`).toBe(
        false,
      )
    }
  })

  // @covers REQ-123#in-time-not-expired
  it('残り時間が 0 に達する前に締めた模試は、0 に達する時刻を過ぎてから開き直しても時間切れにならない（結果）', async () => {
    for (const afterStart of [100, LIMIT - 1]) {
      const res = await reopenedLongAfter(() => get(`/api/sessions/${MOCK_SID}`, completedAfter(afterStart)))
      expect(await expiredOf(res, `締めたのは開始から ${afterStart} 秒後`), `締めたのは開始から ${afterStart} 秒後`).toBe(
        false,
      )
    }
  })

  // @covers REQ-123#expired-by-finished-at
  it('締めた時刻までに残り時間が 0 に達していた模試は、締めた直後に開いても時間切れになる（現在の問題の取得）', async () => {
    // 境界はちょうど 0 で締めた回（REQ-118 の自動の締めが落ちる点）で、こちらが時間切れの側
    for (const afterStart of [LIMIT, LIMIT + 900]) {
      const res = await atElapsed(afterStart + 1, () =>
        get(`/api/sessions/${MOCK_SID}/current`, completedAfter(afterStart)),
      )
      expect(await expiredOf(res, `締めたのは開始から ${afterStart} 秒後`), `締めたのは開始から ${afterStart} 秒後`).toBe(
        true,
      )
    }
  })

  // @covers REQ-123#expired-by-finished-at
  it('締めた時刻までに残り時間が 0 に達していた模試は、締めた直後に開いても時間切れになる（結果）', async () => {
    for (const afterStart of [LIMIT, LIMIT + 900]) {
      const res = await atElapsed(afterStart + 1, () => get(`/api/sessions/${MOCK_SID}`, completedAfter(afterStart)))
      expect(await expiredOf(res, `締めたのは開始から ${afterStart} 秒後`), `締めたのは開始から ${afterStart} 秒後`).toBe(
        true,
      )
    }
  })
})

describe('残り時間が 0 に達した模試への回答（POST /api/sessions/:id/answer。UC-008）', () => {
  /** 回答の経路が要る列（行の id・問題の id・正解）まで持たせた未回答の行。 */
  const UNANSWERED_ROW: Table = {
    match: UNANSWERED.match,
    rows: [{ ...UNANSWERED.rows[0], id: 'sq-1', question_id: 'q-1', answer: 'ア' }],
  }
  const RUNNING = [
    sessions([mockSession({ status: 'in_progress', correct_count: null, finished_at: null })]),
    ANSWERED_COUNT,
    UNANSWERED_ROW,
  ]
  /** 現在の問題（未回答の行）への回答。選択肢は契約の enum の値。 */
  const ANSWER = { idx: SNAPSHOT.idx, answer: 'ア' }
  const answer = (elapsed: number, executed: string[]) =>
    atElapsed(elapsed, () => post(`/api/sessions/${MOCK_SID}/answer`, ANSWER, RUNNING, executed))

  // @covers REQ-119#expired-answer-rejected
  it('残り時間が 0 に達した進行中の模試への回答は、正誤も記録も残さず断られる（境界は残り 0 ちょうど）', async () => {
    // 0 に達する前（残り 1 秒）では同じ偽の D1 が回答を記録する
    // ＝下の「書き込みが無い」は時間切れだけが出している（回答の経路が届いていないのではない）
    const kept: string[] = []
    const beforeZero = await answer(LIMIT - 1, kept)
    expect(beforeZero.status, '残り 1 秒の回答が通らない（この検査は空振りになる）').toBe(200)
    expect(answerWrites(kept), '残り 1 秒の回答が記録されていない（この検査は空振りになる）').not.toEqual([])

    for (const elapsed of [LIMIT, LIMIT + 900]) {
      const executed: string[] = []
      const res = await answer(elapsed, executed)
      expect(res.status, `経過 ${elapsed} 秒`).toBe(409)
      // 本文は契約の ErrorBody だけ（正誤も正解も解説も入らない）
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body), `経過 ${elapsed} 秒`).toEqual(['error'])
      expect(String(body.error), `経過 ${elapsed} 秒`).toMatch(JAPANESE)
      expect(answerWrites(executed), `経過 ${elapsed} 秒で回答か締めが書かれている`).toEqual([])
    }
  })
})

