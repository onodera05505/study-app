/** 弱点復習の出題の組み方（間違えた過去問を先に、残りを理解度の低い論点の過去問で埋める）。UC-004
 *
 *  どの過去問を出すかは回答の履歴と理解度の記録の時刻で決まる（BR-049・BR-050）ので、Node 標準の SQLite（node:sqlite）に
 *  `migrations/*.sql` を当てた実体を D1 の口で包んで渡す。叩くのは契約の startSession（POST /api/sessions、kind=review）だけで、
 *  組んだ出題の並びは表の定義の正本 `src/server/db/schema.ts` の session_questions を idx の順に読む。
 *  回答の履歴は時刻を決めて sessions・session_questions に直に置く（演習の回答の時刻は answered_at、模試は締めた finished_at）。
 *  理解度の記録は UC-003 の recordUnderstanding で残し、記録の時刻（progress.updated_at）を置き直す。
 *  学びは資格対策（ip）とロードマップ型（itc）。理解度の低い論点の側は、定着した問題の除外（REQ-052）に掛からないよう、
 *  まだ回答していない過去問で見る。 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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

const SECRET = 'test-secret'
const ME = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }
const OTHER = { id: 'u-2', name: '別の人', role: 'MEMBER' }
type Who = typeof ME

const NOT_YET = 1
const PARTLY = 2
const UNDERSTOOD = 3

const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi) / 1000
const D1 = jst(2026, 10, 1)
const D2 = jst(2026, 10, 2)
const D3 = jst(2026, 10, 3)
const D4 = jst(2026, 10, 4)
const D5 = jst(2026, 10, 5)

type World = {
  db: DatabaseSync
  env: Bindings
  questions: Map<number, string[]>
  topicOf: Map<string, number>
  number: number
  seq: number
  roadmap: boolean
}
const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function world(exam: 'ip' | 'itc'): World {
  const db = new DatabaseSync(':memory:')
  opened.push(db)
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(MIGRATIONS_DIR + file, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) db.exec(stmt)
    }
  }
  for (const u of [ME, OTHER])
    db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(u.id, `${u.id}@example.com`, u.name, '-', u.role)
  db.prepare(
    'INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, ?, ?, 1, ?, 4, ?)',
  ).run('会計と財務', 'ストラテジ系', '企業と法務', '事業の指標')
  const env = { EXAM: exam, JWT_SECRET: SECRET, DB: d1Of(db) } as unknown as Bindings
  return { db, env, questions: new Map(), topicOf: new Map(), number: 0, seq: 0, roadmap: exam === 'itc' }
}

/** 論点を置き、過去問を n 問紐づける（出題頻度＝n）。学ぶ順（sort_order）はロードマップ型だけが持つ。 */
function topic(w: World, id: number, n: number) {
  w.db.prepare(
    'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count, sort_order) VALUES (?, ?, 1, 0, ?, NULL, ?, ?)',
  ).run(id, `論点${id}`, `論点${id} の説明です。`, n, w.roadmap ? id : null)
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    w.number++
    const qid = `2024r06-q${w.number}`
    w.db.prepare(
      'INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, has_figure, figure_description, citation, modified, figure_image, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NULL, ?)',
    ).run(qid, '2024r06', '令和6年度', w.number, `問${w.number} の本文`, JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }), 'ア', `令和6年度 問${w.number}`, `ck-${w.number}`)
    w.db.prepare('INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)').run(id, qid)
    w.topicOf.set(qid, id)
    ids.push(qid)
  }
  w.questions.set(id, ids)
}
const q = (w: World, topicId: number, i = 0) => w.questions.get(topicId)![i]

type Answer = { question: string; correct: boolean; at: number }
const ok = (question: string, at: number): Answer => ({ question, correct: true, at })
const ng = (question: string, at: number): Answer => ({ question, correct: false, at })

/** 締めたテストと回答を置く。kind=mock は finishedAt が回答の時刻になる。 */
function session(w: World, answers: Answer[], opts: { kind?: 'drill' | 'mock'; finishedAt?: number; who?: Who } = {}) {
  w.seq++
  const id = `s-${w.seq}`
  const kind = opts.kind ?? 'drill'
  const finishedAt = opts.finishedAt ?? Math.max(...answers.map((a) => a.at)) + 60
  w.db.prepare(
    "INSERT INTO sessions (id, user_id, kind, status, source_exam, scope_label, time_limit_sec, question_count, correct_count, started_at, finished_at) VALUES (?, ?, ?, 'completed', ?, ?, NULL, ?, ?, ?, ?)",
  ).run(
    id,
    (opts.who ?? ME).id,
    kind,
    kind === 'mock' ? '2024r06' : null,
    kind === 'mock' ? '令和6年度' : '論点「仕込み」',
    answers.length,
    answers.filter((a) => a.correct).length,
    Math.min(...answers.map((a) => a.at)) - 60,
    finishedAt,
  )
  answers.forEach((a, idx) =>
    w.db.prepare(
      'INSERT INTO session_questions (id, session_id, question_id, idx, snapshot, user_answer, result, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(`${id}-${idx}`, id, a.question, idx, JSON.stringify({ text: '本文', choices: { ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }, answer: 'ア', citation: '令和6年度' }), a.correct ? 'ア' : 'イ', a.correct ? 1 : 2, a.at),
  )
}

async function headers(who: Who = ME) {
  return { Authorization: `Bearer ${await issueToken(SECRET, who)}`, 'Content-Type': 'application/json' }
}

/** 理解度の記録を残し（recordUnderstanding）、記録の時刻を at に置き直す。 */
async function recordAt(w: World, topicId: number, status: number, at: number) {
  const res = await app.request(`/api/topics/${topicId}/progress`, { method: 'PUT', headers: await headers(), body: JSON.stringify({ status }) }, w.env)
  expect(res.status, `論点 ${topicId} に記録できない: ${await res.clone().text()}`).toBe(200)
  w.db.prepare('UPDATE progress SET updated_at = ? WHERE user_id = ? AND topic_id = ?').run(at, ME.id, topicId)
}

/** 弱点復習を始め（startSession）、組んだ出題の過去問を出題の順に返す。 */
async function review(w: World, size: number): Promise<string[]> {
  const res = await app.request('/api/sessions', { method: 'POST', headers: await headers(), body: JSON.stringify({ kind: 'review', size }) }, w.env)
  expect(res.status, `弱点復習を始められない: ${await res.clone().text()}`).toBe(201)
  const { id } = (await res.json()) as { id: string }
  return (w.db.prepare('SELECT question_id AS q FROM session_questions WHERE session_id = ? ORDER BY idx').all(id) as { q: string }[]).map((r) => r.q)
}

describe('弱点復習の出題（POST /api/sessions。UC-004）', () => {
  // @covers REQ-054#wrong-recent-first
  it('間違えた過去問を、最後に間違えた時刻の新しい順に先へ詰める（2 回間違えた問題は後の誤答の時刻で）', async () => {
    const w = world('ip')
    for (const id of [101, 102, 103]) topic(w, id, 1)
    session(w, [ng(q(w, 101), D1)])
    session(w, [ng(q(w, 102), D3)])
    session(w, [ng(q(w, 103), D2)])
    session(w, [ng(q(w, 103), D4)])
    expect(await review(w, 3)).toEqual([q(w, 103), q(w, 102), q(w, 101)])
  })

  // @covers REQ-054#wrong-time-mock-finish
  it('模試で間違えた過去問の時刻は模試を締めた時刻で、回答した時刻ではない', async () => {
    const w = world('ip')
    for (const id of [111, 112]) topic(w, id, 1)
    // 模試の誤答は D1 に回答して D3 に締めた。演習の誤答は D2
    session(w, [ng(q(w, 111), D1)], { kind: 'mock', finishedAt: D3 })
    session(w, [ng(q(w, 112), D2)])
    expect(await review(w, 2)).toEqual([q(w, 111), q(w, 112)])
  })

  // @covers REQ-054#wrong-same-time-by-question-order
  it('同じ時刻に間違えた過去問どうし（同じ模試の誤答）は、出題の順で後に間違えた過去問を先にする', async () => {
    const w = world('ip')
    for (const id of [115, 116, 117]) topic(w, id, 1)
    // 1 つの模試で 115 → 116 → 117 の順に誤答し、同じ時刻に締めた
    session(w, [ng(q(w, 115), D1), ng(q(w, 116), D1 + 60), ng(q(w, 117), D1 + 120)], { kind: 'mock', finishedAt: D2 })
    expect(await review(w, 3)).toEqual([q(w, 117), q(w, 116), q(w, 115)])
  })

  // @covers REQ-054#wrong-same-time-by-question-order
  it('同じ模試の誤答どうしは、過去問の ID の順ではなく出題の順で後に間違えた過去問を先にする', async () => {
    const w = world('ip')
    for (const id of [118, 119, 120]) topic(w, id, 1)
    // 過去問の ID は論点 118・119・120 の順に小さい。模試では ID の大きい方から 120 → 119 → 118 の順に出題して誤答し、同じ時刻に締めた
    session(w, [ng(q(w, 120), D1), ng(q(w, 119), D1 + 60), ng(q(w, 118), D1 + 120)], { kind: 'mock', finishedAt: D2 })
    expect(await review(w, 3)).toEqual([q(w, 118), q(w, 119), q(w, 120)])
  })

  // @covers REQ-054#wrong-same-time-by-question-order
  it('同じ模試の誤答どうしは、回答した時刻の順ではなく出題の順で後に間違えた過去問を先にする', async () => {
    const w = world('ip')
    for (const id of [125, 126, 127]) topic(w, id, 1)
    // 出題の順は 126 → 125 → 127。回答した時刻は出題の順と逆（126 が最も遅い）。過去問の ID の順（125・126・127）とも違う
    session(w, [ng(q(w, 126), D1 + 120), ng(q(w, 125), D1 + 60), ng(q(w, 127), D1)], { kind: 'mock', finishedAt: D2 })
    expect(await review(w, 3)).toEqual([q(w, 127), q(w, 125), q(w, 126)])
  })

  // @covers REQ-054#wrong-only-incorrect
  it('間違えた側には、正解しかしていない過去問は入らない（他の利用者の誤答も入らない）', async () => {
    const w = world('ip')
    topic(w, 121, 1)
    topic(w, 122, 1)
    topic(w, 123, 1)
    session(w, [ng(q(w, 121), D1)])
    // 122 は正解した日が 2 日で理解（理解度の側にも入らない）
    session(w, [ok(q(w, 122), D1), ok(q(w, 122), D2)])
    session(w, [ng(q(w, 123), D2)], { who: OTHER })
    expect(await review(w, 10)).toEqual([q(w, 121)])
  })

  // @covers REQ-054#wrong-then-weak-fill
  it('間違えた過去問で問題数に余りがあるときは、そのあとを理解度の低い論点の過去問で埋める', async () => {
    const w = world('ip')
    topic(w, 131, 1)
    topic(w, 132, 2)
    session(w, [ng(q(w, 131), D1)])
    await recordAt(w, 132, NOT_YET, D2)
    const built = await review(w, 10)
    expect(built[0], '間違えた過去問が先頭に無い').toBe(q(w, 131))
    expect(new Set(built.slice(1)), 'そのあとが理解度の低い論点の過去問でない').toEqual(new Set(w.questions.get(132)))
  })

  // @covers REQ-054#wrong-fills-size
  it('間違えた過去問だけで問題数に達するときは、理解度の低い論点の過去問を足さない', async () => {
    const w = world('ip')
    for (const id of [141, 142]) topic(w, id, 1)
    topic(w, 143, 2)
    session(w, [ng(q(w, 141), D1), ng(q(w, 142), D2)])
    await recordAt(w, 143, NOT_YET, D3)
    expect(await review(w, 2)).toEqual([q(w, 142), q(w, 141)])
  })

  // @covers REQ-054#weak-by-frequency
  it('埋める側は、出題頻度の高い論点の過去問から取る', async () => {
    const w = world('ip')
    // 出題頻度は 152(5) > 151(3) > 153(1)。ID の順とも記録した順とも違う
    topic(w, 151, 3)
    topic(w, 152, 5)
    topic(w, 153, 1)
    await recordAt(w, 153, NOT_YET, D1)
    await recordAt(w, 151, PARTLY, D1)
    await recordAt(w, 152, NOT_YET, D1)
    const topics = (await review(w, 20)).map((x) => w.topicOf.get(x))
    const order = topics.filter((t, i) => t !== topics[i - 1])
    expect(order, '論点の塊が出題頻度の降順になっていない').toEqual([152, 151, 153])
  })

  // @covers REQ-054#weak-exam-judged-stage
  it('資格対策では、埋める側に入る論点を回答の履歴からの判定と本人の上書きで求めた段階（未理解・やや理解）で選ぶ', async () => {
    const w = world('ip')
    // どの論点も 2 問で、0 番目に回答し、1 番目（未回答）が埋める側に入るかを見る
    const cases = [
      { id: 161, label: '判定で未理解（誤答）', weak: true },
      { id: 162, label: '判定でやや理解（正解 1 日）', weak: true },
      { id: 163, label: '判定で理解（正解 2 日）', weak: false },
      { id: 164, label: '理解の判定をやや理解に上書き', weak: true },
      { id: 165, label: '未理解の判定を理解に上書き', weak: false },
      { id: 166, label: '未理解の記録の後に 2 日正解して判定で理解', weak: false },
    ]
    for (const c of cases) topic(w, c.id, 2)
    session(w, [ng(q(w, 161), D1)])
    session(w, [ok(q(w, 162), D1)])
    session(w, [ok(q(w, 163), D1), ok(q(w, 163), D2)])
    session(w, [ok(q(w, 164), D1), ok(q(w, 164), D2)])
    await recordAt(w, 164, PARTLY, D3)
    session(w, [ng(q(w, 165), D1)])
    await recordAt(w, 165, UNDERSTOOD, D3)
    await recordAt(w, 166, NOT_YET, D1)
    session(w, [ok(q(w, 166), D2), ok(q(w, 166), D3)])
    const built = new Set(await review(w, 50))
    for (const c of cases) expect(built.has(q(w, c.id, 1)), c.label).toBe(c.weak)
  })

  // @covers REQ-054#weak-exam-excludes-unanswered
  it('資格対策では、未の論点（自分の回答も記録も無い。他の利用者だけが回答した論点を含む）の過去問は埋める側に入らない', async () => {
    const w = world('ip')
    topic(w, 171, 2)
    topic(w, 172, 2)
    topic(w, 173, 1)
    session(w, [ng(q(w, 172), D1)], { who: OTHER })
    await recordAt(w, 173, NOT_YET, D1)
    expect(await review(w, 20)).toEqual([q(w, 173)])
  })

  // @covers REQ-054#weak-roadmap-recorded
  it('ロードマップ型では、理解度を記録して未理解・やや理解にした論点の過去問だけで埋め、回答の履歴では選ばない', async () => {
    const w = world('itc')
    const cases = [
      { id: 181, label: '未理解と記録', weak: true },
      { id: 182, label: 'やや理解と記録して後に 2 日正解', weak: true },
      { id: 183, label: '理解と記録', weak: false },
      { id: 184, label: '記録なしで誤答', weak: false },
    ]
    for (const c of cases) topic(w, c.id, 2)
    await recordAt(w, 181, NOT_YET, D1)
    await recordAt(w, 182, PARTLY, D1)
    session(w, [ok(q(w, 182), D2), ok(q(w, 182), D3)])
    await recordAt(w, 183, UNDERSTOOD, D1)
    session(w, [ng(q(w, 184), D5)])
    const built = new Set(await review(w, 50))
    for (const c of cases) expect(built.has(q(w, c.id, 1)), c.label).toBe(c.weak)
  })
})
