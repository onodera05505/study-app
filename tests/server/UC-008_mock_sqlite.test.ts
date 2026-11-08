/** UC-008 模試の、回答の応答・残り時間の秒の丸め・ランダム構成で問題数に届かないときの出題。
 *
 *  叩くのは契約の操作の入口だけ（UC-004 の startSession ＝ POST /api/sessions、getCurrentQuestion ＝
 *  GET /api/sessions/:id/current、answerQuestion ＝ POST /api/sessions/:id/answer。模試も同じ経路）。
 *  D1 は migrations を当てた本物の SQLite（sessions_sqlite_fixture.ts）。学びごとの値（1 回の問題数・
 *  制限時間・分野）は登録簿から引き、テストは値を持たない（BR-005）。 */

import { describe, expect, it } from 'vitest'
import {
  CORRECT,
  WRONG,
  as,
  atMs,
  currentOk,
  openWorld,
  seedQuestions,
  setStartedAt,
  startOk,
  topicOf,
  type World,
} from './sessions_sqlite_fixture'
import targets from '../../src/shared/targets.json'

type Registered = { mockSize: number; mockMinutes: number; fields: string[] }
const REGISTRY = targets as unknown as Record<string, Registered>
const LEARNING = 'ip'
const REG = REGISTRY[LEARNING]
const LIMIT = REG.mockMinutes * 60
const EXAM = '2024r06'

/** 回 EXAM に count 問を持つ学びと、その回の模試。 */
async function mockOf(count: number) {
  const w = await openWorld(LEARNING)
  seedQuestions(w, EXAM, count, REG.fields[0])
  const created = await startOk(w, { kind: 'mock', exam: EXAM })
  return { w, created }
}

describe('模試の回答の応答（POST /api/sessions/:id/answer。UC-008）', () => {
  // @covers REQ-343#no-verdict-in-answer
  it('模試で回答を受け付けた応答には、正解を選んでも誤答を選んでも、正誤・正解・問題解説が入らない', async () => {
    // 空振り対策: 同じ学びの演習の応答には正誤と正解が入る（この経路が採点の結果を返せる）
    const drill = await openWorld(LEARNING)
    seedQuestions(drill, EXAM, 2, REG.fields[0])
    const d = await startOk(drill, { kind: 'drill', topicId: topicOf(drill, REG.fields[0]) })
    const dc = await currentOk(drill, d.id)
    const dr = await (await as(drill)).answer(d.id, dc.question!.idx, CORRECT)
    expect(Object.keys((await dr.json()) as object), '演習の応答に正誤が無い（この検査は空振りになる）').toContain('correct')

    for (const choice of [CORRECT, WRONG]) {
      const { w, created } = await mockOf(3)
      const cur = await currentOk(w, created.id)
      const res = await (await as(w)).answer(created.id, cur.question!.idx, choice)
      expect(res.status, `選択肢 ${choice}`).toBe(200)
      const text = await res.text()
      const body = JSON.parse(text) as Record<string, unknown>
      expect(Object.keys(body).sort(), `選択肢 ${choice}: 応答の鍵が「残りと終わったか」だけでない`).toEqual(['finished', 'remaining'])
      expect(text, `選択肢 ${choice}: 応答に正誤・正解・解説の語が載っている`).not.toMatch(/"(correct|correctAnswer|explanation|answer|correctReason)"\s*:/)
    }
  })

  // @covers REQ-343#remaining-and-finished
  it('模試の回答の応答は、その回答を含めた残りの未回答の件数と、終わったか（最後の回答で true）を返す', async () => {
    const { w, created } = await mockOf(3)
    const api = await as(w)
    const seen: { remaining: number; finished: boolean }[] = []
    for (let i = 0; i < 3; i++) {
      const cur = await currentOk(w, created.id)
      const res = await api.answer(created.id, cur.question!.idx, i % 2 === 0 ? CORRECT : WRONG)
      expect(res.status, `${i + 1} 問目`).toBe(200)
      seen.push((await res.json()) as { remaining: number; finished: boolean })
    }
    expect(seen).toEqual([
      { remaining: 2, finished: false },
      { remaining: 1, finished: false },
      { remaining: 0, finished: true },
    ])
  })
})

describe('制限時間のあるテストの残り時間の秒（GET /api/sessions/:id/current。UC-008）', () => {
  const START = 1_759_276_800

  /** 開始から elapsedMs ミリ秒の「いま」で現在の問題を取る。 */
  async function remainingAt(elapsedMs: number) {
    const { w, created } = await mockOf(3)
    setStartedAt(w, created.id, START)
    return atMs(START * 1000 + elapsedMs, () => currentOk(w, created.id))
  }

  // @covers REQ-344#fraction-rounded-up
  it('残り時間に 1 秒に満たない端数があるときは切り上げた秒で渡し、端数が無いときはその秒のまま渡す', async () => {
    const cases: { elapsedMs: number; expected: number }[] = [
      { elapsedMs: 100_000, expected: LIMIT - 100 },
      { elapsedMs: 100_250, expected: LIMIT - 100 },
      { elapsedMs: 100_999, expected: LIMIT - 100 },
      { elapsedMs: 101_000, expected: LIMIT - 101 },
      { elapsedMs: 500, expected: LIMIT },
    ]
    for (const { elapsedMs, expected } of cases) {
      const cur = await remainingAt(elapsedMs)
      expect(cur.remainingSec, `開始から ${elapsedMs} ms`).toBe(expected)
    }
  })

  // @covers REQ-344#not-zero-before-limit
  it('残り時間が 0 に達する前は、残りが 1 秒に満たなくても 0 を渡さず 1 を渡し、問題も渡す', async () => {
    for (const leftMs of [999, 500, 1]) {
      const cur = await remainingAt(LIMIT * 1000 - leftMs)
      expect(cur.remainingSec, `残り ${leftMs} ms`).toBe(1)
      expect(cur.finished, `残り ${leftMs} ms で終わりとして返っている`).toBe(false)
      expect(cur.question, `残り ${leftMs} ms で問題が渡らない`).not.toBeNull()
    }
  })
})

/** 登録簿の分野と分野の付いていない過去問の数を与えた、ランダム構成の模試の学び。入れた過去問の ID を返す。 */
async function randomPool(perField: number[], unclassified: number): Promise<{ w: World; ids: string[] }> {
  const w = await openWorld(LEARNING)
  const ids: string[] = []
  perField.forEach((n, i) => ids.push(...seedQuestions(w, `2023r05`, n, REG.fields[i])))
  ids.push(...seedQuestions(w, `2022r04`, unclassified, null))
  return { w, ids }
}

const POOLS: { label: string; perField: number[]; unclassified: number }[] = [
  { label: '分野の付いた過去問だけ（各分野 2 問）', perField: [2, 2, 2], unclassified: 0 },
  { label: '分野の付いた過去問 4 問と分野の付いていない過去問 3 問', perField: [2, 1, 1], unclassified: 3 },
  { label: '集まったのが 1 問だけ', perField: [1, 0, 0], unclassified: 0 },
]

describe('ランダム構成で 1 回の問題数に届かないとき（POST /api/sessions。UC-008）', () => {
  // @covers REQ-345#collected-only
  it('分野の付いていない過去問で埋めても届かないときは、集まった過去問すべてだけでテストを作る（同じ問題を 2 度入れない）', async () => {
    for (const { label, perField, unclassified } of POOLS) {
      const { w, ids } = await randomPool(perField, unclassified)
      expect(ids.length, `${label}: 1 回の問題数に届いている（この検査は空振りになる）`).toBeLessThan(REG.mockSize)
      const created = await startOk(w, { kind: 'mock' })
      const got = (
        w.db.prepare(`SELECT question_id AS id FROM session_questions WHERE session_id = ?`).all(created.id) as { id: string }[]
      ).map((r) => r.id)
      expect([...got].sort(), `${label}: 出題が集まった過去問のすべてと一致しない`).toEqual([...ids].sort())
    }
  })

  // @covers REQ-345#count-shown
  it('作ったテストの問題数として、集まった過去問の数を示す（作った応答と現在の問題の記録の両方）', async () => {
    for (const { label, perField, unclassified } of POOLS) {
      const { w, ids } = await randomPool(perField, unclassified)
      const created = await startOk(w, { kind: 'mock' })
      expect(created.questionCount, `${label}: 作った応答の問題数`).toBe(ids.length)
      expect(created.timeLimitSec, `${label}: 制限時間が登録簿の値でない`).toBe(LIMIT)
      const cur = await currentOk(w, created.id)
      expect(cur.session.questionCount, `${label}: 現在の問題の記録の問題数`).toBe(ids.length)
    }
  })
})
