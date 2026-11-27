/** UC-008 ランダム構成の模試の出題の組み立て（REQ-107・REQ-108）。
 *  session-builder.test.ts と同じく、DB は触らず buildQuestions が受け取る db の all/get を差し替える。 */

import type { SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import type { Db } from '../../src/server/lib/db'
import { buildQuestions, type QuestionRow } from '../../src/server/lib/session-builder'

function row(over: Partial<QuestionRow> & { id: string; exam: string }): QuestionRow {
  return {
    text: `${over.id} の本文`,
    choices: JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
    answer: 'ア',
    hasFigure: 0,
    figureDescription: null,
    figureImage: null,
    citation: `出典：${over.exam} 問${over.number ?? 1}`,
    modified: 0,
    examLabel: over.exam,
    number: 1,
    field: null,
    contentKey: over.id,
    ...over,
  }
}

type Handler = { match: RegExp; rows: unknown[] }

/** 定着した問題（連続正解）を引く SQL。 */
const MASTERED = /ROW_NUMBER\(\) OVER/
/** 範囲の過去問を引く SQL。 */
const FETCH = /SELECT DISTINCT q\.id/

/** SQL の本文で応答を切り替える偽の db。範囲の過去問は、分野の名前が束ねられていればその分野だけを返す。 */
function fakeDb(questions: QuestionRow[], handlers: Handler[] = []) {
  const dialect = new SQLiteSyncDialect()
  const calls: { sql: string; params: unknown[] }[] = []
  const fields = [...new Set(questions.map((q) => q.field).filter((f): f is string => !!f))]
  const answer = (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    calls.push({ sql: text, params })
    if (FETCH.test(text)) {
      const f = params.find((p) => typeof p === 'string' && fields.includes(p))
      return f ? questions.filter((x) => x.field === f) : questions
    }
    return handlers.find((h) => h.match.test(text))?.rows ?? []
  }
  const db = { all: async (q: SQL) => answer(q), get: async (q: SQL) => answer(q)[0] } as unknown as Db
  return { db, calls, find: (re: RegExp) => calls.filter((c) => re.test(c.sql)) }
}

const FIELD = 'テクノロジ系'
const tech = (n: number) => row({ id: `t-${n}`, exam: '2024r06', number: n, contentKey: `ck-t${n}`, field: FIELD })
const unclassified = (n: number) => row({ id: `n-${n}`, exam: '2024r06', number: n, contentKey: `ck-n${n}`, field: null })

/** ランダム構成（回を指定しない模試）。連続正解の回数は呼び出し側の設定値。 */
const random = (size: number) => ({ kind: 'mock' as const, size, masteredStreak: 3, fieldRatio: { [FIELD]: size } })

describe('ランダム構成の模試の出題（buildQuestions。UC-008）', () => {
  // @covers REQ-107#mastered-excluded
  it('ランダム構成では連続して正解した問題を出題から外す（BR-019）', async () => {
    const questions = [1, 2, 3, 4].map(tech)
    const { db, find } = fakeDb(questions, [{ match: MASTERED, rows: [{ qkey: 'ck-t2' }] }])
    const built = await buildQuestions(db, 'u-1', random(3))
    expect(find(MASTERED), '定着した問題を引いていない').toHaveLength(1)
    expect(find(MASTERED)[0].params).toContain(3)
    const ids = built.questions.map((q) => q.id)
    expect(ids).toHaveLength(3)
    expect(ids, '連続して正解した問題が出題に残っている').not.toContain('t-2')
  })

  // @covers REQ-107#shuffled-order
  it('同じ範囲で作り直しても出題の並びが毎回同じにならない', async () => {
    const questions = [1, 2, 3, 4, 5, 6, 7, 8].map(tech)
    const orders = new Set<string>()
    for (let i = 0; i < 25; i++) {
      const { db } = fakeDb(questions)
      const built = await buildQuestions(db, 'u-1', random(8))
      expect(built.questions, `${i + 1} 回目`).toHaveLength(8)
      orders.add(built.questions.map((q) => q.id).join(','))
    }
    expect(orders.size, '25 回作り直しても出題の並びが毎回同じ').toBeGreaterThan(1)
  })

  // @covers REQ-108#no-fill-when-enough
  it('分野比率に沿って選ぶだけで 1 回の問題数にちょうど届くときは、分野の付いていない過去問で埋めない', async () => {
    const { db } = fakeDb([tech(1), tech(2), tech(3), unclassified(1), unclassified(2)])
    const built = await buildQuestions(db, 'u-1', random(3))
    const ids = built.questions.map((q) => q.id)
    expect(ids).toHaveLength(3)
    expect(ids.filter((id) => id.startsWith('n-')), '届いているのに分野の付いていない過去問で埋めている').toEqual([])
  })
})
