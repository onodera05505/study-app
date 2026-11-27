/** UC-004 テストの経路の、書き込みの成否と読み戻しで決まる振る舞い
 *  （出題の件数の既定・出題の保存の失敗・現在の問題に添えるテストの記録・同じ問題への同時の回答）。
 *
 *  叩くのは契約の操作の入口だけ（UC-004 の startSession ＝ POST /api/sessions、getCurrentQuestion ＝
 *  GET /api/sessions/:id/current、answerQuestion ＝ POST /api/sessions/:id/answer、finishSession ＝
 *  POST /api/sessions/:id/finish）。D1 は migrations を当てた本物の SQLite（sessions_sqlite_fixture.ts）。 */

import { describe, expect, it } from 'vitest'
import {
  CORRECT,
  WRONG,
  answerCurrent,
  as,
  atMs,
  countOf,
  currentOk,
  errorBodyOf,
  interleaved,
  openWorld,
  seedQuestions,
  setSettings,
  setStartedAt,
  startOk,
  topicOf,
  type World,
} from './sessions_sqlite_fixture'
import targets from '../../src/shared/targets.json'

const FIELD = 'テクノロジ系'
const EXAM = '2024r06'
const REGISTRY = targets as unknown as Record<string, { mockMinutes: number }>

/** 論点ドリルの範囲に count 問の過去問を持つ学び。 */
async function drillWorld(count: number): Promise<{ w: World; topicId: number; ids: string[] }> {
  const w = await openWorld()
  const ids = seedQuestions(w, EXAM, count, FIELD)
  return { w, topicId: topicOf(w, FIELD), ids }
}

describe('演習の出題の件数（POST /api/sessions。UC-004）', () => {
  // @covers REQ-051#size-default-cap
  it('要求が問題数を指定しないときは、範囲の過去問が多くても app_settings の既定の問題数で止まる', async () => {
    for (const drillSize of [4, 5]) {
      const { w, topicId, ids } = await drillWorld(8)
      setSettings(w, { drill_size: drillSize })
      expect(ids.length, '範囲の過去問が既定の問題数より多くない（この検査は空振りになる）').toBeGreaterThan(drillSize)
      const created = await startOk(w, { kind: 'drill', topicId })
      expect(created.questionCount, `既定の問題数 ${drillSize} で止まっていない`).toBe(drillSize)
      expect(countOf(w, 'session_questions', 'session_id = ?', created.id), `出題の行が既定の問題数 ${drillSize} でない`).toBe(drillSize)
    }
  })
})

/** session_questions への行の追加を、位置 idx の行で失敗させる（実装が 1 行ずつ足しても一括で足しても同じ所で落ちる）。 */
function failQuestionsAt(w: World, idx: number) {
  w.db.exec(
    `CREATE TRIGGER fail_sq BEFORE INSERT ON session_questions WHEN NEW.idx = ${idx} BEGIN SELECT RAISE(ABORT, '出題の保存に失敗した'); END;`,
  )
}

describe('テストを作る途中で出題の保存に失敗したとき（POST /api/sessions。UC-004）', () => {
  // @covers REQ-347#save-failed-leaves-nothing
  it('出題の保存が途中で落ちたら、テストの行も出題の行も残さず、始められなかった理由を {error} で返し、続けて始め直せる', async () => {
    const cases: { label: string; body: (w: World) => Record<string, unknown>; failAt: number }[] = [
      { label: '演習で最初の出題の保存が落ちる', body: (w) => ({ kind: 'drill', topicId: topicOf(w, FIELD) }), failAt: 0 },
      { label: '演習で 3 問目の出題の保存が落ちる', body: (w) => ({ kind: 'drill', topicId: topicOf(w, FIELD) }), failAt: 2 },
      { label: '模試（回を指定）で 3 問目の出題の保存が落ちる', body: () => ({ kind: 'mock', exam: EXAM }), failAt: 2 },
    ]
    for (const { label, body, failAt } of cases) {
      // 空振り対策: 仕込みの無い同じ学びでは作れる
      const { w: plain } = await drillWorld(5)
      await startOk(plain, body(plain))

      const { w } = await drillWorld(5)
      failQuestionsAt(w, failAt)
      const res = await (await as(w)).start(body(w))
      expect(res.ok, `${label}: 保存が落ちたのに作れたことになっている`).toBe(false)
      await errorBodyOf(res)
      expect(countOf(w, 'sessions'), `${label}: テストの行が残っている`).toBe(0)
      expect(countOf(w, 'session_questions'), `${label}: 出題の行が残っている`).toBe(0)

      // 残っていないので、進行中のテストに阻まれずに始め直せる
      w.db.exec('DROP TRIGGER fail_sq')
      const again = await (await as(w)).start(body(w))
      expect(again.status, `${label}: 落ちたあとに始め直せない（テストが残っている）`).toBe(201)
    }
  })
})

/** 契約 getCurrentQuestion の session が持つ鍵（テストが終わっていてもこの 5 つだけ）。 */
const SESSION_KEYS = ['id', 'kind', 'questionCount', 'scopeLabel', 'sourceExam']

function expectSessionRecord(session: Record<string, unknown>, created: { id: string; kind: string; scopeLabel: string; questionCount: number }, sourceExam: string | null, label: string) {
  expect(Object.keys(session).sort(), `${label}: 添えたテストの記録の鍵が 5 つでない`).toEqual(SESSION_KEYS)
  expect(session, label).toEqual({
    id: created.id,
    kind: created.kind,
    scopeLabel: created.scopeLabel,
    questionCount: created.questionCount,
    sourceExam,
  })
}

describe('現在の問題の応答に添えるテストの記録（GET /api/sessions/:id/current。UC-004）', () => {
  // @covers REQ-346#in-progress-record
  it('進行中のテストの現在の問題には、テストの識別子・種別・範囲の名前・問題数・回の識別子だけが添う（演習も模試も）', async () => {
    const drill = await drillWorld(3)
    const d = await startOk(drill.w, { kind: 'drill', topicId: drill.topicId })
    const dc = await currentOk(drill.w, d.id)
    expect(dc.finished, '演習が進行中でない（この検査の前提）').toBe(false)
    expectSessionRecord(dc.session, d, null, '演習')

    const mock = await drillWorld(3)
    const m = await startOk(mock.w, { kind: 'mock', exam: EXAM })
    const mc = await currentOk(mock.w, m.id)
    expect(mc.finished, '模試が進行中でない（この検査の前提）').toBe(false)
    expectSessionRecord(mc.session, m, EXAM, '模試')
  })

  // @covers REQ-346#finished-record
  it('終わっているテスト（未回答なし・締めた・時間切れ）の応答に添う記録も、同じ 5 つの鍵だけ', async () => {
    // 未回答が無い進行中の演習
    const all = await drillWorld(2)
    const a = await startOk(all.w, { kind: 'drill', topicId: all.topicId })
    await answerCurrent(all.w, a.id)
    await answerCurrent(all.w, a.id)
    const ac = await currentOk(all.w, a.id)
    expect(ac.finished, '未回答なしが終わりとして返らない（この検査の前提）').toBe(true)
    expectSessionRecord(ac.session, a, null, '未回答なし')

    // 締めた演習
    const done = await drillWorld(3)
    const f = await startOk(done.w, { kind: 'drill', topicId: done.topicId })
    expect((await (await as(done.w)).finish(f.id)).status).toBe(200)
    const fc = await currentOk(done.w, f.id)
    expect(fc.finished, '締めたテストが終わりとして返らない（この検査の前提）').toBe(true)
    expectSessionRecord(fc.session, f, null, '締めた')

    // 残り時間が 0 に達した模試
    const late = await drillWorld(3)
    const m = await startOk(late.w, { kind: 'mock', exam: EXAM })
    const START = 1_759_276_800
    setStartedAt(late.w, m.id, START)
    const limitSec = REGISTRY[late.w.learning].mockMinutes * 60
    const mc = await atMs((START + limitSec + 10) * 1000, () => currentOk(late.w, m.id))
    expect(mc.expired, '時間切れが返らない（この検査の前提）').toBe(true)
    expectSessionRecord(mc.session, m, EXAM, '時間切れ')
  })
})

describe('同じ問題への同時の回答（POST /api/sessions/:id/answer。UC-004）', () => {
  // @covers REQ-066#concurrent-answer-first-only
  it('同じ問題への回答が同時に 2 つ届いたら、最初に記録した 1 件だけを受け付け、ほかは 409 の {error} で断る（演習も模試も）', async () => {
    const cases: { label: string; body: (w: World) => Record<string, unknown> }[] = [
      { label: '演習', body: (w) => ({ kind: 'drill', topicId: topicOf(w, FIELD) }) },
      { label: '模試', body: () => ({ kind: 'mock', exam: EXAM }) },
    ]
    for (const { label, body } of cases) {
      const { w } = await drillWorld(3)
      const created = await startOk(w, body(w))
      const cur = await currentOk(w, created.id)
      const idx = cur.question!.idx
      // 2 つの要求の D1 への読み書きを 1 回ずつ交互に通す。両方が「まだ答えていない」を読んでから書き込む順になる
      const [first, second] = await interleaved(w, [
        async (view) => (await as(view)).answer(created.id, idx, CORRECT),
        async (view) => (await as(view)).answer(created.id, idx, WRONG),
      ])
      const statuses = [first.status, second.status].sort()
      expect(statuses, `${label}: 同時の 2 回答の扱いが「1 件受け付け・1 件 409」でない`).toEqual([200, 409])
      const rejected = first.status === 409 ? first : second
      await errorBodyOf(rejected)
      const kept = first.status === 200 ? CORRECT : WRONG

      const rows = w.db
        .prepare(`SELECT user_answer AS userAnswer FROM session_questions WHERE session_id = ? AND idx = ?`)
        .all(created.id, idx) as { userAnswer: string | null }[]
      expect(rows, `${label}: 同じ位置の行が 1 つでない`).toHaveLength(1)
      expect(rows[0].userAnswer, `${label}: 残った回答が受け付けた側の選択肢でない`).toBe(kept)
      const after = await currentOk(w, created.id)
      expect(after.answered, `${label}: 回答済みの数が 1 でない（2 件数えている）`).toBe(1)
    }
  })
})
