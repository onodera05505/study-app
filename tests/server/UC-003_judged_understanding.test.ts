/** 資格対策の学びの理解度（回答の履歴からの判定と本人の上書き。BR-049・BR-050・BR-029）が、
 *  論点の画面・論点の一覧の行・理解度の絞り込み・分野と単元の集計・次に学ぶの候補に出ること。UC-003
 *
 *  判定は回答の履歴と理解度の記録の時刻で決まるので、空の偽の D1 では観測できない。Node 標準の SQLite
 *  （node:sqlite）に `migrations/*.sql` を当てた実体を D1 の口で包んで渡す。観測はすべて HTTP の境界で行う
 *  （UC-003 の recordUnderstanding・getHomeSummary、UC-002 の listTopics・getTopicDetail・listFields・listCategories、
 *  UC-004 の startSession・getCurrentQuestion・answerQuestion）。
 *
 *  回答の履歴は、時刻を決めて置くため、表の定義の正本 `src/server/db/schema.ts` の sessions・session_questions に
 *  直に置く（演習の回答の時刻は answered_at、模試の回答の時刻は締めた sessions.finished_at。BR-049）。
 *  理解度の記録は recordUnderstanding で残し、記録の時刻（progress.updated_at）だけを決めた時刻に置き直す。
 *  時刻は日本時間の暦日の境目（23:59:59 と 00:00:00、UTC の日付が変わる 09:00）を跨ぐ・跨がないように置く。
 *  学びは資格対策（EXAM=ip）。 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

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

const SECRET = 'test-secret'
const ME = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }
const OTHER = { id: 'u-2', name: '別の人', role: 'MEMBER' }
type Who = typeof ME

const FIELD = 'ストラテジ系'
const MIDDLE_NO = 4

/** 段階の番号（契約の listTopics の status）。 */
const UNANSWERED = 0
const NOT_YET = 1
const PARTLY = 2
const UNDERSTOOD = 3

/** 日本時間の時刻（epoch 秒）。 */
const jst = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, s) / 1000

let db: DatabaseSync
let env: Bindings
/** 論点ごとの過去問の ID。 */
let questionsOf: Map<number, string[]>
let questionNumber = 0
let sessionSeq = 0

beforeEach(() => {
  db = migrated()
  for (const u of [ME, OTHER]) {
    db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
      u.id,
      `${u.id}@example.com`,
      u.name,
      '-',
      u.role,
    )
  }
  db.prepare(
    'INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, ?, ?, 1, ?, ?, ?)',
  ).run('会計と財務', FIELD, '企業と法務', MIDDLE_NO, '事業の指標')
  questionsOf = new Map()
  questionNumber = 0
  sessionSeq = 0
  env = { EXAM: 'ip', JWT_SECRET: SECRET, DB: d1Of(db) } as unknown as Bindings
})

afterEach(() => {
  db.close()
})

/** 論点を 1 つ置き、過去問を questions 問紐づける（出題頻度＝questions）。 */
function addTopic(id: number, term: string, questions: number) {
  db.prepare(
    'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count) VALUES (?, ?, 1, 0, ?, NULL, ?)',
  ).run(id, term, `${term} の短い説明です。`, questions)
  const ids: string[] = []
  for (let i = 0; i < questions; i++) {
    questionNumber++
    const qid = `2024r06-q${questionNumber}`
    db.prepare(
      'INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, has_figure, figure_description, citation, modified, figure_image, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NULL, ?)',
    ).run(
      qid,
      '2024r06',
      '令和6年度',
      questionNumber,
      `問${questionNumber} の本文`,
      JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
      'ア',
      `令和6年度 問${questionNumber}`,
      `ck-${questionNumber}`,
    )
    db.prepare('INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)').run(id, qid)
    ids.push(qid)
  }
  questionsOf.set(id, ids)
}

/** 過去問 of と同一内容（content_key が同じ）の別の回の過去問を、どの論点にも紐づけずに置く。 */
function sameContentAs(of: string): string {
  const { k } = db.prepare('SELECT content_key AS k FROM past_questions WHERE id = ?').get(of) as { k: string }
  questionNumber++
  const qid = `2019h31h-q${questionNumber}`
  db.prepare(
    'INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, has_figure, figure_description, citation, modified, figure_image, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NULL, ?)',
  ).run(qid, '2019h31h', '平成31年度', questionNumber, `問${questionNumber} の本文`, JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }), 'ア', `平成31年度 問${questionNumber}`, k)
  return qid
}

/** 論点の i 番目の過去問の ID。 */
const q = (topicId: number, i = 0) => {
  const ids = questionsOf.get(topicId)
  if (!ids || !ids[i]) throw new Error(`論点 ${topicId} に ${i} 番目の過去問が無い`)
  return ids[i]
}

/** 1 問の回答。correct が null なら未回答の行（出題されたがまだ回答していない）。 */
type Answer = { question: string; correct: boolean | null; at: number | null }
const ok = (question: string, at: number): Answer => ({ question, correct: true, at })
const ng = (question: string, at: number): Answer => ({ question, correct: false, at })
const blank = (question: string): Answer => ({ question, correct: null, at: null })

type SessionOpts = {
  who?: Who
  kind?: 'drill' | 'field' | 'middle' | 'review' | 'mock'
  /** 締めた時刻。null なら進行中。 */
  finishedAt: number | null
  /** 模試の回。null はランダム構成。 */
  sourceExam?: string | null
}

/** テストを 1 つと、その回答を置く（表の正本は schema の sessions・session_questions）。 */
function session(answers: Answer[], opts: SessionOpts): string {
  sessionSeq++
  const id = `s-${String(sessionSeq).padStart(4, '0')}`
  const kind = opts.kind ?? 'drill'
  const answeredAts = answers.map((a) => a.at).filter((x): x is number => x !== null)
  const startedAt = Math.min(...answeredAts, opts.finishedAt ?? Infinity) - 60
  const correctCount = opts.finishedAt === null ? null : answers.filter((a) => a.correct === true).length
  db.prepare(
    'INSERT INTO sessions (id, user_id, kind, status, source_exam, scope_label, time_limit_sec, question_count, correct_count, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
  ).run(
    id,
    (opts.who ?? ME).id,
    kind,
    opts.finishedAt === null ? 'in_progress' : 'completed',
    kind === 'mock' ? (opts.sourceExam === undefined ? '2024r06' : opts.sourceExam) : null,
    kind === 'mock' ? '令和6年度' : '論点「仕込みの論点」',
    answers.length,
    correctCount,
    Number.isFinite(startedAt) ? startedAt : jst(2026, 9, 1),
    opts.finishedAt,
  )
  answers.forEach((a, idx) => {
    db.prepare(
      'INSERT INTO session_questions (id, session_id, question_id, idx, snapshot, user_answer, result, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `${id}-${idx}`,
      id,
      a.question,
      idx,
      JSON.stringify({ text: '本文', choices: { ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }, answer: 'ア', citation: '令和6年度 問1' }),
      a.correct === null ? null : a.correct ? 'ア' : 'イ',
      a.correct === null ? 0 : a.correct ? 1 : 2,
      a.at,
    )
  })
  return id
}

/** 締めた演習の回答（締めた時刻は最後の回答の 1 分後）。 */
const drill = (answers: Answer[], who: Who = ME) =>
  session(answers, { who, finishedAt: Math.max(...answers.map((a) => a.at ?? 0)) + 60 })
/** 模試の回答。finishedAt が null なら締める前。 */
const mock = (answers: Answer[], finishedAt: number | null, sourceExam: string | null = '2024r06', who: Who = ME) =>
  session(answers, { who, kind: 'mock', finishedAt, sourceExam })

/** 進行中の模試を締める（締めた時刻を置く）。 */
function finishAt(sessionId: string, at: number) {
  db.prepare("UPDATE sessions SET status = 'completed', finished_at = ?, correct_count = 0 WHERE id = ?").run(at, sessionId)
}

async function headersFor(who: Who) {
  const token = await issueToken(SECRET, who)
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function getJson<T>(path: string, who: Who = ME): Promise<T> {
  const res = await app.request(path, { headers: await headersFor(who) }, env)
  expect(res.status, `GET ${path} が ${res.status}: ${await res.clone().text()}`).toBe(200)
  return (await res.json()) as T
}

async function send<T>(method: string, path: string, body: unknown, who: Who = ME): Promise<{ status: number; body: T }> {
  const res = await app.request(path, { method, headers: await headersFor(who), body: JSON.stringify(body) }, env)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

/** 理解度の記録を残し（recordUnderstanding）、記録の時刻を at に置き直す。 */
async function recordAt(topicId: number, status: number, at: number, who: Who = ME) {
  const res = await send('PUT', `/api/topics/${topicId}/progress`, { status }, who)
  expect(res.status, `論点 ${topicId} に ${status} を記録できない: ${JSON.stringify(res.body)}`).toBe(200)
  const r = db.prepare('UPDATE progress SET updated_at = ? WHERE user_id = ? AND topic_id = ?').run(at, who.id, topicId)
  expect(Number(r.changes), `論点 ${topicId} の記録の行が無い`).toBe(1)
}

type Shown = { status: number | null; statusSource: string | null }
type Detail = { topic: Shown & { id: number }; nextTopic: { id: number } | null }
type Listed = Shown & { id: number }

/** 論点の画面が示す理解度（getTopicDetail の topic）。 */
async function onDetail(topicId: number, who: Who = ME): Promise<Shown> {
  const { topic } = await getJson<Detail>(`/api/topics/${topicId}`, who)
  return { status: topic.status, statusSource: topic.statusSource }
}
/** 論点の一覧（listTopics）の行。 */
async function listed(query = '', who: Who = ME): Promise<Listed[]> {
  return (await getJson<{ topics: Listed[] }>(`/api/topics${query}`, who)).topics
}
async function onRow(topicId: number, who: Who = ME): Promise<Shown> {
  const row = (await listed('', who)).find((t) => t.id === topicId)
  expect(row, `論点 ${topicId} が一覧に無い`).toBeDefined()
  return { status: row!.status, statusSource: row!.statusSource }
}
/** 論点の画面と一覧の行の段階（両方が同じであることも見る）。 */
async function stageOf(topicId: number, who: Who = ME): Promise<number | null> {
  const d = await onDetail(topicId, who)
  const r = await onRow(topicId, who)
  expect(r.status, `論点 ${topicId} の一覧の行（${r.status}）と論点の画面（${d.status}）の段階が違う`).toBe(d.status)
  return d.status
}
async function sourceOf(topicId: number, who: Who = ME): Promise<string | null> {
  const d = await onDetail(topicId, who)
  const r = await onRow(topicId, who)
  expect(r.statusSource, `論点 ${topicId} の一覧の行と論点の画面の別が違う`).toBe(d.statusSource)
  return d.statusSource
}

type FieldRow = { field: string; topics: number; understood: number; partly: number; untouched: number; unanswered: number }
type CategoryRow = { middleNo: number; topics: number; understood: number }
type Me = { topics: { total: number; understood: number; partly: number }; nextTopics: { id: number }[] }

const fieldRow = async () => {
  const { fields } = await getJson<{ fields: FieldRow[] }>('/api/fields')
  const row = fields.find((f) => f.field === FIELD)
  expect(row, `分野「${FIELD}」の集計が無い`).toBeDefined()
  return row!
}
const categoryRow = async () => {
  const { categories } = await getJson<{ categories: CategoryRow[] }>('/api/categories')
  const row = categories.find((c) => c.middleNo === MIDDLE_NO)
  expect(row, `単元 ${MIDDLE_NO} の集計が無い`).toBeDefined()
  return row!
}
const home = () => getJson<Me>('/api/me')

/* 日（日本時間）。どれも過去の日。 */
const D1 = [2026, 10, 1] as const
const D2 = [2026, 10, 2] as const
const D3 = [2026, 10, 3] as const
const D4 = [2026, 10, 4] as const
const at = (d: readonly [number, number, number], h = 12, mi = 0, s = 0) => jst(d[0], d[1], d[2], h, mi, s)

/* ---------- REQ-484: 回答が数える回答に加わったあとに示す段階（BR-049 の判定） ---------- */

describe('回答の履歴からの判定（UC-003）', () => {
  // @covers REQ-484#latest-wrong-is-unlearned
  it('最新の回答が誤答なら、それより前に何日正解していても未理解になる', async () => {
    addTopic(401, '前に 2 日正解して最後に誤答した論点', 2)
    addTopic(402, '誤答だけの論点', 1)
    drill([ok(q(401, 0), at(D1)), ok(q(401, 1), at(D2))])
    drill([ng(q(401, 0), at(D3))])
    drill([ng(q(402), at(D1))])
    expect(await stageOf(401)).toBe(NOT_YET)
    expect(await stageOf(402)).toBe(NOT_YET)
  })

  // @covers REQ-484#correct-one-day-is-partly
  it('正解した日が日本時間で 1 日だけなら、何回正解しても、UTC の日付が変わる時刻を跨いでも、やや理解になる', async () => {
    addTopic(403, '同じ日に何度も正解した論点', 2)
    // 00:00:00・08:59・09:00（UTC の日付が変わる）・23:59:59 はどれも日本時間の D2
    drill([ok(q(403, 0), at(D2, 0, 0, 0)), ok(q(403, 0), at(D2, 8, 59))])
    drill([ok(q(403, 1), at(D2, 9, 0)), ok(q(403, 0), at(D2, 23, 59, 59))])
    expect(await stageOf(403)).toBe(PARTLY)
  })

  // @covers REQ-484#correct-two-days-is-understood
  it('正解した日が日本時間で 2 日あれば、1 秒違い（UTC では同じ日）でも理解になる', async () => {
    addTopic(404, '日本時間の日を跨いで正解した論点', 1)
    // D1 23:59:59 と D2 00:00:00 は UTC ではどちらも D1 の 14:59:59 と 15:00:00
    drill([ok(q(404), at(D1, 23, 59, 59)), ok(q(404), at(D2, 0, 0, 0))])
    expect(await stageOf(404)).toBe(UNDERSTOOD)
  })

  // @covers REQ-484#days-counted-after-last-wrong
  it('最後の誤答より前の正解の日は数えず、同じ日でも誤答より前の正解は数えない', async () => {
    addTopic(405, '誤答の前に 2 日正解した論点', 1)
    addTopic(406, '誤答と同じ日の前後に正解した論点', 1)
    // 405: D1・D2 に正解、D3 に誤答、D3 のそのあとに正解 → 誤答より後の正解は D3 の 1 日
    drill([ok(q(405), at(D1)), ok(q(405), at(D2)), ng(q(405), at(D3, 10)), ok(q(405), at(D3, 11))])
    // 406: D3 の 09:00 に正解、10:00 に誤答、11:00 に正解 → 誤答より後の正解は D3 の 1 日
    drill([ok(q(406), at(D3, 9)), ng(q(406), at(D3, 10)), ok(q(406), at(D3, 11))])
    expect(await stageOf(405)).toBe(PARTLY)
    expect(await stageOf(406)).toBe(PARTLY)
  })

  // @covers REQ-484#no-decay-by-elapsed-days
  it('最後の正解から日が経っても段階を下げない（2 年前に 2 日正解した論点は理解のまま）', async () => {
    addTopic(407, '昔に覚えた論点', 1)
    drill([ok(q(407), jst(2024, 1, 10)), ok(q(407), jst(2024, 1, 11))])
    expect(await stageOf(407)).toBe(UNDERSTOOD)
  })

  // @covers REQ-484#drill-counted-before-finish
  it('演習の回答は、締める前でも回答した時刻で数える', async () => {
    addTopic(408, '進行中の演習で誤答した論点', 1)
    drill([ok(q(408), at(D1)), ok(q(408), at(D2))])
    session([ng(q(408), at(D3))], { finishedAt: null })
    expect(await stageOf(408)).toBe(NOT_YET)
  })

  // @covers REQ-484#every-test-kind-counted
  it('分野別演習・単元演習・弱点復習・回を指定した模試・ランダム構成の模試のどの回答も数える', async () => {
    const kinds = [
      { id: 411, label: '分野別演習', put: (a: Answer[]) => session(a, { kind: 'field', finishedAt: at(D1, 13) }) },
      { id: 412, label: '単元演習', put: (a: Answer[]) => session(a, { kind: 'middle', finishedAt: at(D1, 13) }) },
      { id: 413, label: '弱点復習', put: (a: Answer[]) => session(a, { kind: 'review', finishedAt: at(D1, 13) }) },
      { id: 414, label: '回を指定した模試', put: (a: Answer[]) => mock(a, at(D1, 13), '2024r06') },
      { id: 415, label: 'ランダム構成の模試', put: (a: Answer[]) => mock(a, at(D1, 13), null) },
    ]
    for (const k of kinds) {
      addTopic(k.id, `${k.label}で誤答した論点`, 1)
      k.put([ng(q(k.id), at(D1, 12))])
    }
    for (const k of kinds) expect(await stageOf(k.id), `${k.label}の回答が数えられていない`).toBe(NOT_YET)
  })

  // @covers REQ-484#mock-counted-after-finish
  it('模試の回答は締めるまで数えず、締めたあとは数える', async () => {
    addTopic(416, '模試で誤答した論点', 1)
    drill([ok(q(416), at(D1)), ok(q(416), at(D2))])
    const m = mock([ng(q(416), at(D3, 10))], null)
    expect(await stageOf(416), '締める前の模試の誤答が数えられている').toBe(UNDERSTOOD)
    finishAt(m, at(D3, 11))
    expect(await stageOf(416), '締めた模試の誤答が数えられていない').toBe(NOT_YET)
  })

  // @covers REQ-484#mock-time-is-finish-time
  it('模試の回答の時刻は締めた時刻で、回答した時刻より後の演習の正解よりも新しい回答になる', async () => {
    for (const [id, exam] of [
      [417, '2024r06'],
      [418, null],
    ] as const) {
      addTopic(id, `模試の誤答を後で締めた論点${id}`, 1)
      // 模試の誤答は D1 に回答し D4 に締める。演習の正解は D2・D3
      mock([ng(q(id), at(D1))], at(D4), exam)
      drill([ok(q(id), at(D2)), ok(q(id), at(D3))])
    }
    expect(await stageOf(417), '回を指定した模試の回答を、回答した時刻で並べている').toBe(NOT_YET)
    expect(await stageOf(418), 'ランダム構成の模試の回答を、回答した時刻で並べている').toBe(NOT_YET)
  })

  // @covers REQ-484#own-answers-only
  it('判定に数えるのは本人の回答だけで、他の利用者の回答は本人の段階を変えない', async () => {
    addTopic(419, '本人は理解で他の人は誤答の論点', 1)
    addTopic(420, '他の人だけが回答した論点', 1)
    drill([ok(q(419), at(D1)), ok(q(419), at(D2))])
    drill([ng(q(419), at(D3)), ng(q(420), at(D3))], OTHER)
    expect(await stageOf(419)).toBe(UNDERSTOOD)
    expect(await stageOf(420)).toBe(UNANSWERED)
    expect(await stageOf(419, OTHER)).toBe(NOT_YET)
  })

  // @covers REQ-484#same-content-answer-counted
  it('論点に紐づく過去問と同一内容の、どの論点にも紐づかない過去問への回答も、その論点の回答として数える', async () => {
    addTopic(431, '同一内容の過去問で最後に誤答した論点', 1)
    addTopic(432, '同一内容の過去問で別の日に正解した論点', 1)
    addTopic(433, '同一内容の過去問にだけ回答した論点', 1)
    drill([ok(q(431), at(D1)), ok(q(431), at(D2))])
    drill([ng(sameContentAs(q(431)), at(D3))])
    drill([ok(q(432), at(D1))])
    drill([ok(sameContentAs(q(432)), at(D2))])
    drill([ng(sameContentAs(q(433)), at(D1))])
    expect(await stageOf(431), '同一内容の過去問への誤答が最新の回答になっていない').toBe(NOT_YET)
    expect(await stageOf(432), '同一内容の過去問に正解した日が数えられていない').toBe(UNDERSTOOD)
    expect(await stageOf(433), '同一内容の過去問への回答だけで未のまま').toBe(NOT_YET)
  })

  // @covers REQ-484#same-time-by-question-order
  it('同じ時刻の回答どうし（同じ模試の回答・同じ秒の演習の回答）は、出題の順で後の回答を後とする', async () => {
    addTopic(434, '模試で正解のあとの問題を誤答した論点', 2)
    addTopic(435, '模試で誤答のあとの問題を正解した論点', 2)
    addTopic(436, '同じ秒に正解と誤答の順で回答した論点', 2)
    addTopic(437, '同じ秒に誤答と正解の順で回答した論点', 2)
    mock([ok(q(434, 0), at(D1, 10)), ng(q(434, 1), at(D1, 11))], at(D1, 12))
    mock([ng(q(435, 0), at(D1, 10)), ok(q(435, 1), at(D1, 11))], at(D1, 12))
    drill([ok(q(436, 0), at(D2)), ng(q(436, 1), at(D2))])
    drill([ng(q(437, 0), at(D2)), ok(q(437, 1), at(D2))])
    expect(await stageOf(434), '模試の後の問題の誤答が最新の回答になっていない').toBe(NOT_YET)
    expect(await stageOf(435), '模試の後の問題の正解が最後の誤答より後と数えられていない').toBe(PARTLY)
    expect(await stageOf(436), '同じ秒の後の誤答が最新の回答になっていない').toBe(NOT_YET)
    expect(await stageOf(437), '同じ秒の後の正解が最後の誤答より後と数えられていない').toBe(PARTLY)
  })

  // @covers REQ-484#same-time-by-question-order
  it('同じ模試で前の問題に誤答し後の問題に正解した論点は、締めた日の正解も誤答より後の正解の日に数え、翌日の正解と合わせて 2 日で理解になる', async () => {
    addTopic(438, '模試で誤答のあとの問題を正解し、翌日に演習で正解した論点', 2)
    mock([ng(q(438, 0), at(D1, 10)), ok(q(438, 1), at(D1, 11))], at(D1, 12))
    drill([ok(q(438, 0), at(D2))])
    expect(await stageOf(438), '模試の後の問題の正解の日が、最後の誤答より後の正解の日に数えられていない').toBe(UNDERSTOOD)
  })

  // @covers REQ-484#same-time-by-question-order
  it('同じ模試の回答どうしは、回答した時刻ではなく出題の順で後の回答を後とする（後の問題の正解を先に回答した論点も、翌日の正解と合わせて 2 日で理解になる）', async () => {
    addTopic(439, '模試で後の問題に先に正解し、前の問題にあとから誤答して、翌日に演習で正解した論点', 2)
    // 出題の順は 1 問目（誤答）→ 2 問目（正解）。回答した時刻は 2 問目が先
    mock([ng(q(439, 0), at(D1, 11)), ok(q(439, 1), at(D1, 10))], at(D1, 12))
    drill([ok(q(439, 0), at(D2))])
    expect(await stageOf(439), '模試の回答の前後が出題の順でなく回答した時刻で決まっている').toBe(UNDERSTOOD)
  })

  // @covers REQ-484#reflected-after-answer-request
  it('演習で回答を送ったあとに示す論点の理解度・分野と単元の集計・次に学ぶの候補が、その回答を反映している', async () => {
    addTopic(421, '誤答する論点', 3)
    addTopic(422, '正解する論点', 2)
    addTopic(423, '回答しない論点', 1)

    const before = { field: await fieldRow(), category: await categoryRow(), home: await home() }
    expect(await stageOf(421)).toBe(UNANSWERED)
    expect(await stageOf(422)).toBe(UNANSWERED)
    expect(before.field).toMatchObject({ understood: 0, partly: 0, untouched: 0, unanswered: 3 })

    // 論点ドリルで 1 問ずつ回答する（正解は「ア」）
    async function answerDrill(topicId: number, choice: string) {
      const started = await send<{ id: string }>('POST', '/api/sessions', { kind: 'drill', topicId })
      expect(started.status, `論点 ${topicId} の論点ドリルを始められない: ${JSON.stringify(started.body)}`).toBe(201)
      const current = await getJson<{ question: { idx: number } }>(`/api/sessions/${started.body.id}/current`)
      const res = await send('POST', `/api/sessions/${started.body.id}/answer`, { idx: current.question.idx, answer: choice })
      expect(res.status, `回答を送れない: ${JSON.stringify(res.body)}`).toBe(200)
      const fin = await send('POST', `/api/sessions/${started.body.id}/finish`, {})
      expect(fin.status, `締められない: ${JSON.stringify(fin.body)}`).toBe(200)
    }
    await answerDrill(421, 'イ')
    await answerDrill(422, 'ア')

    expect(await stageOf(421), '誤答のあとの論点の理解度が未理解でない').toBe(NOT_YET)
    expect(await stageOf(422), '正解のあとの論点の理解度がやや理解でない').toBe(PARTLY)
    expect(await stageOf(423)).toBe(UNANSWERED)
    expect(await fieldRow(), '分野の集計が回答を反映していない').toMatchObject({ understood: 0, partly: 1, untouched: 1, unanswered: 1 })
    expect((await categoryRow()).understood).toBe(0)
    const after = await home()
    expect(after.topics, 'ホームの集計が回答を反映していない').toMatchObject({ understood: 0, partly: 1 })
    expect(after.nextTopics.map((t) => t.id), '次に学ぶの候補が回答を反映していない').toEqual([421, 422, 423])
  })
})

/* ---------- REQ-481: 回答も記録も無い論点は未 ---------- */

describe('回答も記録も無い論点の理解度（UC-003）', () => {
  // @covers REQ-481#no-counted-answer-is-unanswered
  it('数える回答も理解度の記録も無い論点は、未理解ではなく未（回答の履歴からの判定）として示す', async () => {
    addTopic(301, '何もしていない論点', 2)
    addTopic(302, '他の人だけが回答し記録した論点', 1)
    addTopic(303, '締める前の模試でだけ誤答した論点', 1)
    addTopic(304, '出題されたが回答していない論点', 1)
    addTopic(305, '過去問の無い論点', 0)
    drill([ng(q(302), at(D1))], OTHER)
    await recordAt(302, NOT_YET, at(D2), OTHER)
    mock([ng(q(303), at(D1))], null)
    session([blank(q(304))], { finishedAt: null })

    for (const id of [301, 302, 303, 304, 305]) {
      for (const [where, shown] of [
        ['論点の画面', await onDetail(id)],
        ['一覧の行', await onRow(id)],
      ] as const) {
        expect(shown.status, `論点 ${id} の${where}が未でない（未理解=${NOT_YET}・記録なし=null と区別する）`).toBe(UNANSWERED)
        expect(shown.statusSource, `論点 ${id} の${where}の未が回答の履歴からの判定でない`).toBe('auto')
      }
    }
  })
})

/* ---------- REQ-482: 理解度の記録がある論点の段階（BR-050） ---------- */

describe('理解度の記録と回答の前後（UC-003）', () => {
  const T = at(D3, 12)

  // @covers REQ-482#no-later-answer-keeps-record
  it('記録より後に回答が無ければ、判定より低くても高くても、回答が 1 件も無くても、記録した段階を示す', async () => {
    addTopic(501, '理解の判定を未理解に下げた論点', 1)
    addTopic(502, '未理解の判定を理解に上げた論点', 1)
    addTopic(503, '回答せずに記録した論点', 1)
    drill([ok(q(501), at(D1)), ok(q(501), at(D2))])
    drill([ng(q(502), at(D2))])
    await recordAt(501, NOT_YET, T)
    await recordAt(502, UNDERSTOOD, T)
    await recordAt(503, PARTLY, T)
    expect(await stageOf(501)).toBe(NOT_YET)
    expect(await stageOf(502)).toBe(UNDERSTOOD)
    expect(await stageOf(503)).toBe(PARTLY)
  })

  // @covers REQ-482#later-answer-reverts-to-judgment
  it('記録より 1 秒でも後に回答があれば、記録の前の回答も含めた回答の履歴からの判定を示す', async () => {
    addTopic(504, '記録の 1 秒後に誤答した論点', 1)
    addTopic(505, '記録の前と後の日に正解した論点', 1)
    await recordAt(504, UNDERSTOOD, T)
    drill([ng(q(504), T + 1)])
    // 505: D1 に正解、D3 の記録（未理解）、D4 に正解 → 判定は正解した日が 2 日で理解
    drill([ok(q(505), at(D1))])
    await recordAt(505, NOT_YET, T)
    drill([ok(q(505), at(D4))])
    expect(await stageOf(504)).toBe(NOT_YET)
    expect(await stageOf(505)).toBe(UNDERSTOOD)
  })

  // @covers REQ-482#same-time-answer-keeps-record
  it('記録と同じ時刻の回答（演習の回答・模試の締め）は記録より後と数えず、記録した段階を示す', async () => {
    addTopic(506, '記録と同じ時刻に演習で正解した論点', 1)
    addTopic(507, '記録と同じ時刻に模試を締めた論点', 1)
    drill([ok(q(506), at(D1)), ok(q(506), T)])
    await recordAt(506, NOT_YET, T)
    mock([ng(q(507), at(D2))], T)
    await recordAt(507, UNDERSTOOD, T)
    expect(await stageOf(506), '記録と同じ時刻の演習の回答で上書きが効かなくなった').toBe(NOT_YET)
    expect(await stageOf(507), '記録と同じ時刻に締めた模試の回答で上書きが効かなくなった').toBe(UNDERSTOOD)
  })

  // @covers REQ-482#uncounted-later-answer-keeps-record
  it('記録より後の回答が、別の論点・他の利用者・締める前の模試・未回答の行だけなら、記録した段階を示す', async () => {
    addTopic(508, '記録した論点', 1)
    addTopic(509, '別の論点', 1)
    await recordAt(508, PARTLY, T)
    drill([ng(q(509), T + 60)])
    drill([ng(q(508), T + 60)], OTHER)
    mock([ng(q(508), T + 60)], null)
    session([blank(q(508))], { finishedAt: null })
    expect(await stageOf(508)).toBe(PARTLY)
  })

  // @covers REQ-482#mock-finish-after-record-reverts
  it('記録より前に模試で回答していても、記録より後に締めたら判定を示し、締める前は記録を示す', async () => {
    addTopic(510, '記録を挟んで模試を締めた論点', 1)
    const m = mock([ng(q(510), T - 600)], null)
    await recordAt(510, UNDERSTOOD, T)
    expect(await stageOf(510), '締める前の模試の回答で上書きが効かなくなった').toBe(UNDERSTOOD)
    finishAt(m, T + 600)
    expect(await stageOf(510), '記録より後に締めた模試の回答が記録より後と数えられていない').toBe(NOT_YET)
  })
})

/* ---------- REQ-483: 判定か上書きかの別 ---------- */

describe('回答の履歴からの判定か本人の上書きかの別（UC-003）', () => {
  const T = at(D3, 12)

  // @covers REQ-483#source-judged
  it('記録が無い論点（未を含む）と、記録より後に回答がある論点は、回答の履歴からの判定（auto）として示す', async () => {
    addTopic(601, '何もしていない論点', 1)
    addTopic(602, '回答だけの論点', 1)
    addTopic(603, '記録の後に回答した論点', 1)
    drill([ok(q(602), at(D1))])
    await recordAt(603, UNDERSTOOD, T)
    drill([ng(q(603), T + 1)])
    for (const id of [601, 602, 603]) expect(await sourceOf(id), `論点 ${id}`).toBe('auto')
  })

  // @covers REQ-483#source-override
  it('記録より後に回答が無い論点（同じ時刻の回答を含む）は、本人の上書き（override）として示す', async () => {
    addTopic(604, '記録だけの論点', 1)
    addTopic(605, '回答の後に記録した論点', 1)
    addTopic(606, '記録と同じ時刻に回答した論点', 1)
    await recordAt(604, PARTLY, T)
    drill([ok(q(605), at(D1))])
    await recordAt(605, NOT_YET, T)
    drill([ng(q(606), T)])
    await recordAt(606, UNDERSTOOD, T)
    for (const id of [604, 605, 606]) expect(await sourceOf(id), `論点 ${id}`).toBe('override')
  })
})

/* ---------- REQ-480: どこでも同じ段階 ---------- */

describe('理解度はどこでも同じ段階（UC-003）', () => {
  const T = at(D3, 12)

  /** 判定・上書き・上書きの失効・締める前の模試が混ざった論点。値は期待の段階。
   *  出題頻度はどれも違い、ID の順・名前の順と一致しない。 */
  const MIXED = [
    { id: 201, term: 'あ未の論点', questions: 2, stage: UNANSWERED },
    { id: 202, term: 'い判定で未理解', questions: 6, stage: NOT_YET },
    { id: 203, term: 'う判定でやや理解', questions: 5, stage: PARTLY },
    { id: 204, term: 'え判定で理解', questions: 8, stage: UNDERSTOOD },
    { id: 205, term: 'お未理解の判定を理解に上書き', questions: 4, stage: UNDERSTOOD },
    { id: 206, term: 'か理解の上書きの後に誤答', questions: 7, stage: NOT_YET },
    { id: 207, term: 'き理解の判定を未理解に上書き', questions: 3, stage: NOT_YET },
    { id: 208, term: 'く締める前の模試で誤答', questions: 9, stage: UNDERSTOOD },
  ]

  async function seedMixed() {
    for (const t of MIXED) addTopic(t.id, t.term, t.questions)
    drill([ng(q(202), at(D1))])
    drill([ok(q(203), at(D1))])
    drill([ok(q(204), at(D1)), ok(q(204), at(D2))])
    drill([ng(q(205), at(D1))])
    await recordAt(205, UNDERSTOOD, T)
    await recordAt(206, UNDERSTOOD, T)
    drill([ng(q(206), at(D4))])
    drill([ok(q(207), at(D1)), ok(q(207), at(D2))])
    await recordAt(207, NOT_YET, T)
    drill([ok(q(208), at(D1)), ok(q(208), at(D2))])
    mock([ng(q(208), at(D4))], null)
    // 他の利用者の回答と記録は本人の段階に混ざらない
    drill([ok(q(201), at(D1)), ok(q(201), at(D2)), ng(q(204), at(D4))], OTHER)
    await recordAt(202, UNDERSTOOD, T, OTHER)
  }
  const ids = (stages: number[]) => MIXED.filter((t) => stages.includes(t.stage)).map((t) => t.id)
  const count = (stage: number) => ids([stage]).length
  /** 次に学ぶの並び（理解でない論点を出題頻度の降順に。BR-030）。 */
  const notUnderstoodInOrder = () =>
    MIXED.filter((t) => t.stage !== UNDERSTOOD)
      .sort((a, b) => b.questions - a.questions)
      .map((t) => t.id)

  // @covers REQ-480#list-row-same-as-detail
  it('論点の画面と論点の一覧の行が、どの論点でも同じ段階を示す', async () => {
    await seedMixed()
    const rows = new Map((await listed()).map((r) => [r.id, r.status]))
    for (const t of MIXED) {
      expect((await onDetail(t.id)).status, `論点の画面: ${t.term}`).toBe(t.stage)
      expect(rows.get(t.id), `一覧の行: ${t.term}`).toBe(t.stage)
    }
  })

  // @covers REQ-480#filter-same-stage
  it('理解度の絞り込みは、論点の画面と同じ段階で論点を選ぶ', async () => {
    await seedMixed()
    for (const chosen of [[UNANSWERED], [NOT_YET], [PARTLY], [UNDERSTOOD], [UNANSWERED, NOT_YET, PARTLY]]) {
      const got = (await listed(`?status=${chosen.join(',')}`)).map((t) => t.id).sort((a, b) => a - b)
      expect(got, `status=${chosen.join(',')} の絞り込み`).toEqual(ids(chosen))
    }
  })

  // @covers REQ-480#aggregate-same-stage
  it('分野と単元の集計とホームの集計が、論点の画面と同じ段階で数える', async () => {
    await seedMixed()
    expect(await fieldRow(), '分野の集計').toMatchObject({
      topics: MIXED.length,
      understood: count(UNDERSTOOD),
      partly: count(PARTLY),
      untouched: count(NOT_YET),
      unanswered: count(UNANSWERED),
    })
    expect(await categoryRow(), '単元の集計').toMatchObject({ topics: MIXED.length, understood: count(UNDERSTOOD) })
    expect((await home()).topics, 'ホームの集計').toMatchObject({ understood: count(UNDERSTOOD), partly: count(PARTLY) })
  })

  // @covers REQ-480#next-candidates-same-stage
  it('次に学ぶの候補・論点の画面の次に学ぶ・おすすめ順が、論点の画面と同じ段階で理解の論点を分ける', async () => {
    await seedMixed()
    const expected = notUnderstoodInOrder()
    expect((await home()).nextTopics.map((t) => t.id), 'ホームの次に学ぶ').toEqual(expected)
    const onFirst = await getJson<Detail>(`/api/topics/${expected[0]}`)
    expect(onFirst.nextTopic?.id, '先頭の論点の画面の次に学ぶ').toBe(expected[1])
    const onUnderstood = await getJson<Detail>(`/api/topics/${ids([UNDERSTOOD])[0]}`)
    expect(onUnderstood.nextTopic?.id, '理解の論点の画面の次に学ぶ').toBe(expected[0])
    const recommended = (await listed('?sort=recommended')).map((t) => t.id)
    expect(recommended.slice(0, expected.length), 'おすすめ順でまだ理解していない論点が先に並んでいない').toEqual(expected)
    expect(new Set(recommended.slice(expected.length)), 'おすすめ順の最後が理解の論点でない').toEqual(new Set(ids([UNDERSTOOD])))
  })
})

/* ---------- REQ-034: 記録し直すと記録が新しくなる ---------- */

describe('理解度の記録し直し（UC-003）', () => {
  // @covers REQ-034#rerecord-after-answer-takes-effect
  it('記録より後の回答で判定に戻った論点に記録し直すと、記録は 1 件のまま最後に選んだ段階になり、再び効く', async () => {
    addTopic(701, '記録し直す論点', 1)
    await recordAt(701, UNDERSTOOD, at(D1))
    drill([ng(q(701), at(D2))])
    expect(await stageOf(701)).toBe(NOT_YET)
    const res = await send('PUT', '/api/topics/701/progress', { status: PARTLY })
    expect(res.status).toBe(200)
    expect(await stageOf(701), '記録し直した段階が効いていない（以前の記録の時刻のまま）').toBe(PARTLY)
    expect(await sourceOf(701)).toBe('override')
    const rows = db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND topic_id = ?').get(ME.id, 701) as { n: number }
    expect(rows.n, '同じ論点の記録が 2 件以上残っている').toBe(1)
  })
})
