/** 演習の出題の組み立てのうち、作ったテストの範囲の名前と問題数、定着した問題の除外、同一内容の件数を、
 *  契約 UC-004 の startSession（POST /api/sessions）と getCurrentQuestion（GET /api/sessions/:id/current）の境界で見る。UC-004
 *
 *  D1 は migrations を当てた本物の SQLite（sessions_sqlite_fixture.ts）。回答の履歴は時刻を決めて
 *  表の定義の正本 `src/server/db/schema.ts` の sessions・session_questions に直に置き、組んだ出題の並びは
 *  session_questions を idx の順に読む。定着の連続正解の回数は app_settings に置いた値を使う。 */

import { afterEach, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import {
  SECRET,
  OTHER,
  USER,
  as,
  currentOk,
  openWorld,
  seedQuestions,
  setSettings,
  startOk,
  topicOf,
  type World,
} from './sessions_sqlite_fixture'

const FIELD = 'テクノロジ系'
const EXAM = '2024r06'
/** 定着とみなす連続正解の回数（app_settings.mastered_streak に置く値）。 */
const STREAK = 2

const jst = (d: number, h = 12) => Date.UTC(2026, 9, d, h - 9) / 1000

const worlds: World[] = []
afterEach(() => {
  for (const w of worlds.splice(0)) w.db.close()
})
async function world(): Promise<World> {
  const w = await openWorld('ip')
  worlds.push(w)
  setSettings(w, { mastered_streak: STREAK })
  return w
}

let seq = 0
/** 締めた演習を 1 つ置き、回答を並べる（correct が false なら誤答）。 */
function answered(w: World, answers: { q: string; correct: boolean; at: number }[], user = USER) {
  seq++
  const id = `done-${seq}`
  w.db
    .prepare(
      "INSERT INTO sessions (id, user_id, kind, status, source_exam, scope_label, time_limit_sec, question_count, correct_count, started_at, finished_at) VALUES (?, ?, 'drill', 'completed', NULL, '論点「仕込み」', NULL, ?, ?, ?, ?)",
    )
    .run(id, user, answers.length, answers.filter((a) => a.correct).length, Math.min(...answers.map((a) => a.at)) - 60, Math.max(...answers.map((a) => a.at)) + 60)
  answers.forEach((a, idx) =>
    w.db
      .prepare(
        'INSERT INTO session_questions (id, session_id, question_id, idx, snapshot, user_answer, result, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(`${id}-${idx}`, id, a.q, idx, JSON.stringify({ text: '本文', choices: { ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }, answer: 'ア', citation: '出典' }), a.correct ? 'ア' : 'イ', a.correct ? 1 : 2, a.at),
  )
}
/** 過去問 q を STREAK 回続けて正解し、定着した問題にする。 */
const master = (w: World, q: string, fromDay = 1) =>
  answered(w, Array.from({ length: STREAK }, (_, i) => ({ q, correct: true, at: jst(fromDay + i) })))

/** 理解度の記録を残し（UC-003 の recordUnderstanding）、記録の時刻を at に置き直す。 */
async function recordAt(w: World, topicId: number, status: number, at: number) {
  const token = await issueToken(SECRET, { id: USER, name: '検査', role: 'MEMBER' })
  const res = await app.request(
    `/api/topics/${topicId}/progress`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status }) },
    { EXAM: w.learning, JWT_SECRET: SECRET, DB: w.d1 } as unknown as Bindings,
  )
  expect(res.status, `論点 ${topicId} に記録できない: ${await res.clone().text()}`).toBe(200)
  w.db.prepare('UPDATE progress SET updated_at = ? WHERE user_id = ? AND topic_id = ?').run(at, USER, topicId)
}

/** テストを作り、組んだ出題の過去問を出題の順に返す。 */
async function built(w: World, body: Record<string, unknown>): Promise<string[]> {
  const { id } = await startOk(w, body)
  return (w.db.prepare('SELECT question_id AS q FROM session_questions WHERE session_id = ? ORDER BY idx').all(id) as { q: string }[]).map((r) => r.q)
}

const middleOf = (w: World) =>
  Number((w.db.prepare('SELECT middle_no AS n FROM syllabus_items WHERE field = ?').get(FIELD) as { n: number }).n)
const nameOf = (w: World, sql: string, ...p: (string | number)[]) =>
  String(Object.values(w.db.prepare(sql).get(...p) as Record<string, unknown>)[0])

describe('演習の開始の範囲の名前と問題数（POST /api/sessions。UC-004）', () => {
  // @covers REQ-050#scope-label-and-count
  it('作ったテストは、種別ごとの範囲の名前（論点・分野・単元の名前を含む）と、組んだ問題数を返す', async () => {
    const w = await world()
    seedQuestions(w, EXAM, 30, FIELD)
    const topicId = topicOf(w, FIELD)
    const term = nameOf(w, 'SELECT term FROM topics WHERE id = ?', topicId)
    const middle = nameOf(w, 'SELECT middle FROM syllabus_items WHERE field = ?', FIELD)
    // 弱点復習の範囲が空にならないよう、論点を未理解と記録しておく
    await recordAt(w, topicId, 1, jst(1))
    const cases: { body: Record<string, unknown>; name: RegExp }[] = [
      { body: { kind: 'drill', topicId, size: 10 }, name: new RegExp(term) },
      { body: { kind: 'field', field: FIELD, size: 20 }, name: new RegExp(FIELD) },
      { body: { kind: 'middle', middleNo: middleOf(w), size: 20 }, name: new RegExp(middle) },
      { body: { kind: 'review', size: 20 }, name: /./ },
    ]
    for (const { body, name } of cases) {
      const created = await startOk(w, body)
      expect(created.kind, JSON.stringify(body)).toBe(body.kind)
      expect(created.scopeLabel, `${JSON.stringify(body)} の範囲の名前`).toMatch(name)
      expect(created.questionCount, `${JSON.stringify(body)} の問題数`).toBe(body.size)
      // 次の種別を始められるよう、作ったテストを締める
      expect((await (await as(w)).finish(created.id)).status).toBe(200)
    }
    // 範囲の過去問が頼んだ問題数より少ないときは、実際に組めた数を問題数として返す
    const few = await world()
    seedQuestions(few, EXAM, 7, FIELD)
    expect((await startOk(few, { kind: 'field', field: FIELD, size: 20 })).questionCount).toBe(7)
  })
})

describe('定着した問題の除外（POST /api/sessions。UC-004）', () => {
  // @covers REQ-052#mastered-excluded
  it('論点ドリル・分野別演習・単元演習・弱点復習・ランダム構成の模試で、定着した問題は出題から外す', async () => {
    /** 1 つの論点に 3 問。0 番目は誤答（弱点復習の間違えた側）、1 番目は定着、2 番目は未回答。論点は判定で未理解。 */
    async function seeded() {
      const w = await world()
      const qs = seedQuestions(w, EXAM, 3, FIELD)
      master(w, qs[1], 1)
      answered(w, [{ q: qs[0], correct: false, at: jst(5) }])
      return { w, qs }
    }
    const bodies: ((w: World) => Record<string, unknown>)[] = [
      (w) => ({ kind: 'drill', topicId: topicOf(w, FIELD), size: 10 }),
      () => ({ kind: 'field', field: FIELD, size: 10 }),
      (w) => ({ kind: 'middle', middleNo: middleOf(w), size: 10 }),
      () => ({ kind: 'review', size: 10 }),
      () => ({ kind: 'mock' }),
    ]
    for (const body of bodies) {
      const { w, qs } = await seeded()
      const got = await built(w, body(w))
      expect(new Set(got), `${JSON.stringify(body(w))} で定着した問題が外れていない`).toEqual(new Set([qs[0], qs[2]]))
    }
  })

  // @covers REQ-052#mastered-all-fallback
  it('範囲の問題が全部定着した問題のときは外さずに出し、弱点復習は間違えた側と理解度の低い論点の側を合わせて見る', async () => {
    const byField = await world()
    const [only] = seedQuestions(byField, EXAM, 1, FIELD)
    master(byField, only)
    expect(await built(byField, { kind: 'field', field: FIELD, size: 10 })).toEqual([only])

    /** 間違えた側の w（誤答のあと定着）と、理解度の低い論点の側の k。 */
    async function review(masterK: boolean) {
      const r = await world()
      const [w] = seedQuestions(r, EXAM, 1, FIELD)
      const [k] = seedQuestions(r, EXAM, 1, 'マネジメント系')
      answered(r, [{ q: w, correct: false, at: jst(1) }])
      master(r, w, 2)
      if (masterK) master(r, k, 2)
      await recordAt(r, topicOf(r, 'マネジメント系'), 1, jst(9))
      return { got: await built(r, { kind: 'review', size: 10 }), w, k }
    }
    const all = await review(true)
    expect(all.got, '両方の側が全部定着しているのに外された').toEqual([all.w, all.k])
    const some = await review(false)
    expect(some.got, '片方が残るのに定着した問題を外していない').toEqual([some.k])
  })
})

describe('同一内容の件数（GET /api/sessions/:id/current。UC-004）', () => {
  // @covers REQ-053#times-asked-recount
  it('弱点復習の出題の同一内容の件数と他の出典は、範囲に入った過去問ではなく過去問の全体から数える', async () => {
    const w = await world()
    const topicId = topicOf(w, FIELD)
    const put = (id: string, exam: string, n: number, citation: string) =>
      w.db
        .prepare('INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, citation, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, exam, exam, n, '同じ本文', JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }), 'ア', citation, 'ck-same')
    put('2020r02o-q9', '2020r02o', 9, '出典：令和2年10月 問9')
    put('2016h28h-q1', '2016h28h', 1, '出典：平成28年春 問1')
    // 範囲に入るのは誤答した新しい回だけ。古い回は論点に紐づかず、範囲に入らない
    w.db.prepare('INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)').run(topicId, '2020r02o-q9')
    answered(w, [{ q: '2020r02o-q9', correct: false, at: jst(1) }])
    answered(w, [{ q: '2016h28h-q1', correct: false, at: jst(1) }], OTHER)
    const { id } = await startOk(w, { kind: 'review', size: 10 })
    const cur = await currentOk(w, id)
    const question = cur.question as unknown as { timesAsked: number; otherCitations: string[] }
    expect(question.timesAsked, '同一内容の件数を範囲の中だけで数えている').toBe(2)
    expect(question.otherCitations).toEqual(['出典：平成28年春 問1'])
  })
})
