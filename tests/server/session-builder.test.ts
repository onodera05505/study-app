import type { SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import type { Db } from '../../src/server/lib/db'
import { buildQuestions, compareExam, dedupe, type QuestionRow } from '../../src/server/lib/session-builder'

/** 偽の行。DB は触らず、buildQuestions が受け取る db の all/get を差し替える。 */
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

/** SQL の本文で応答を切り替える偽の db。発行された SQL も記録する。 */
function fakeDb(handlers: Handler[]) {
  const dialect = new SQLiteSyncDialect()
  const calls: { sql: string; params: unknown[] }[] = []
  const answer = (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    calls.push({ sql: text, params })
    return handlers.find((h) => h.match.test(text))?.rows ?? []
  }
  const db = {
    all: async (q: SQL) => answer(q),
    get: async (q: SQL) => answer(q)[0],
  } as unknown as Db
  return { db, calls, find: (re: RegExp) => calls.filter((c) => re.test(c.sql)) }
}

const MASTERED = /ROW_NUMBER\(\) OVER/
const FETCH = /SELECT DISTINCT q\.id/
const REVIEW = /MAX\(sq\.answered_at\)/
const TIMES = /SELECT id, content_key AS contentKey/

const base = { size: 20, masteredStreak: 3, fieldRatio: { テクノロジ系: 45 } }

describe('compareExam（回の新旧）', () => {
  // @verifies REQ-021
  it('古い回が小さく、新しい回が大きい', () => {
    expect(compareExam('2016h28h', '2024r06')).toBeLessThan(0)
    expect(compareExam('2024r06', '2016h28h')).toBeGreaterThan(0)
    expect(compareExam('2020r02o', '2020r02o')).toBe(0)
  })

  // @verifies REQ-021
  it('同じ年は 春(h) → 10月(o) → 秋(a) の順で、時期の無い回は年内で最後', () => {
    expect(compareExam('2016h28h', '2016h28a')).toBeLessThan(0)
    expect(compareExam('2020r02h', '2020r02o')).toBeLessThan(0)
    expect(compareExam('2020r02o', '2020r02a')).toBeLessThan(0)
    expect(compareExam('2024r06a', '2024r06')).toBeLessThan(0)
  })

  // @verifies REQ-021
  it('並べ替えに使うと古い順に揃う', () => {
    const sorted = ['2024r06', '2016h28a', '2020r02o', '2016h28h'].sort(compareExam)
    expect(sorted).toEqual(['2016h28h', '2016h28a', '2020r02o', '2024r06'])
  })
})

describe('dedupe（同一内容を1問にまとめる）', () => {
  // @verifies REQ-021
  it('同じ content_key を1問に畳み、代表は最新の回になる', () => {
    const rows = [
      { id: 'q-old', exam: '2016h28h', contentKey: 'ck-1', citation: '出典：平成28年春 問1' },
      { id: 'q-new', exam: '2020r02o', contentKey: 'ck-1', citation: '出典：令和2年10月 問9' },
      { id: 'q-other', exam: '2024r06', contentKey: 'ck-2', citation: '出典：令和6年 問3' },
    ]
    const got = dedupe(rows)
    expect(got).toHaveLength(2)
    expect(got[0].id).toBe('q-new')
    expect(got[0].timesAsked).toBe(2)
    expect(got[0].otherCitations).toEqual(['出典：平成28年春 問1'])
    expect(got[1].id).toBe('q-other')
    expect(got[1].timesAsked).toBe(1)
    expect(got[1].otherCitations).toEqual([])
  })

  // @verifies REQ-021
  it('JOIN で増えた同じ id の行を「2回出題」と数えない', () => {
    const r = { id: 'q-1', exam: '2024r06', contentKey: 'ck-1', citation: '出典：令和6年 問1' }
    const got = dedupe([r, { ...r }])
    expect(got).toHaveLength(1)
    expect(got[0].timesAsked).toBe(1)
  })

  // @verifies REQ-021
  it('content_key が無い問題は id ごとに別の問題として残る', () => {
    const got = dedupe([
      { id: 'q-1', exam: '2024r06', contentKey: null, citation: 'c1' },
      { id: 'q-2', exam: '2024r06', contentKey: null, citation: 'c2' },
    ])
    expect(got.map((q) => q.id)).toEqual(['q-1', 'q-2'])
  })
})

describe('buildQuestions（出題の組み立て）', () => {
  // @verifies REQ-019
  it('drill は担当の論点だけを SQL で絞る', async () => {
    const { db, find } = fakeDb([
      { match: FETCH, rows: [row({ id: 'q-1', exam: '2024r06' })] },
      { match: /SELECT term FROM topics/, rows: [{ term: '損益分岐点' }] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'drill', topicId: 42 })
    const fetches = find(FETCH)
    expect(fetches).toHaveLength(1)
    expect(fetches[0].sql).toContain('tq.topic_id')
    expect(fetches[0].params).toContain(42)
    expect(built.scopeLabel).toBe('論点「損益分岐点」')
    expect(built.sourceExam).toBeNull()
  })

  // @verifies REQ-019
  it('field は分野、middle は中分類で絞る', async () => {
    const f = fakeDb([{ match: FETCH, rows: [row({ id: 'q-1', exam: '2024r06', field: 'テクノロジ系' })] }])
    await buildQuestions(f.db, 'u-1', { ...base, kind: 'field', field: 'テクノロジ系' })
    expect(f.find(FETCH)[0].sql).toContain('s.field')
    expect(f.find(FETCH)[0].params).toContain('テクノロジ系')

    const m = fakeDb([
      { match: FETCH, rows: [row({ id: 'q-1', exam: '2024r06' })] },
      { match: /SELECT middle FROM syllabus_items/, rows: [{ middle: '基礎理論' }] },
    ])
    const built = await buildQuestions(m.db, 'u-1', { ...base, kind: 'middle', middleNo: 7 })
    expect(m.find(FETCH)[0].sql).toContain('s.middle_no')
    expect(m.find(FETCH)[0].params).toContain(7)
    expect(built.scopeLabel).toBe('中分類「基礎理論」')
  })

  // @verifies REQ-019, REQ-021
  it('drill は同じ content_key を2度出さない', async () => {
    const rows = [
      row({ id: 'q-old', exam: '2016h28h', contentKey: 'ck-1' }),
      row({ id: 'q-new', exam: '2020r02o', contentKey: 'ck-1' }),
      row({ id: 'q-alone', exam: '2024r06', contentKey: 'ck-2' }),
    ]
    const { db } = fakeDb([
      { match: FETCH, rows },
      { match: /SELECT term FROM topics/, rows: [{ term: '損益分岐点' }] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'drill', topicId: 1 })
    expect(built.questions).toHaveLength(2)
    expect(built.questions.map((q) => q.id).sort()).toEqual(['q-alone', 'q-new'])
    expect(built.questions.find((q) => q.id === 'q-new')!.timesAsked).toBe(2)
  })

  // @verifies REQ-019
  it('size を超える数は出さない', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ id: `q-${n}`, exam: '2024r06', contentKey: `ck-${n}` }))
    const { db } = fakeDb([
      { match: FETCH, rows },
      { match: /SELECT term FROM topics/, rows: [{ term: '論点' }] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'drill', topicId: 1, size: 2 })
    expect(built.questions).toHaveLength(2)
  })

  // @verifies REQ-021
  it('回を指定した模試は畳まず、原本どおり問番号の順に出す', async () => {
    const rows = [
      row({ id: 'q-3', exam: '2024r06', number: 3, contentKey: 'ck-same' }),
      row({ id: 'q-1', exam: '2024r06', number: 1, contentKey: 'ck-same' }),
      row({ id: 'q-2', exam: '2024r06', number: 2, contentKey: 'ck-2' }),
    ]
    const { db, find } = fakeDb([{ match: FETCH, rows }])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'mock', exam: '2024r06', size: 100 })
    expect(built.questions.map((q) => q.number)).toEqual([1, 2, 3])
    expect(built.sourceExam).toBe('2024r06')
    expect(find(FETCH)[0].params).toContain('2024r06')
  })

  // @verifies REQ-020
  it('直近 N 回連続で正解した問題は出さない', async () => {
    const rows = [
      row({ id: 'q-1', exam: '2024r06', contentKey: 'ck-1', field: 'テクノロジ系' }),
      row({ id: 'q-2', exam: '2024r06', contentKey: 'ck-2', field: 'テクノロジ系' }),
      row({ id: 'q-3', exam: '2024r06', contentKey: 'ck-3', field: 'テクノロジ系' }),
    ]
    const { db, find } = fakeDb([
      { match: MASTERED, rows: [{ qkey: 'ck-2' }] },
      { match: FETCH, rows },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'field', field: 'テクノロジ系' })
    expect(built.questions.map((q) => q.id).sort()).toEqual(['q-1', 'q-3'])
    // 連続正解の回数は呼び出し側の設定値を使う
    expect(find(MASTERED)[0].params).toContain(3)
  })

  // @verifies REQ-020
  it('全部が定着済みなら除外せず復習として出す', async () => {
    const rows = [row({ id: 'q-1', exam: '2024r06', contentKey: 'ck-1', field: 'テクノロジ系' })]
    const { db } = fakeDb([
      { match: MASTERED, rows: [{ qkey: 'ck-1' }] },
      { match: FETCH, rows },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'field', field: 'テクノロジ系' })
    expect(built.questions.map((q) => q.id)).toEqual(['q-1'])
  })

  // @verifies REQ-020
  it('弱点復習は誤答（result = 2）だけを直近に間違えた順で集める', async () => {
    const rows = [row({ id: 'q-1', exam: '2024r06', contentKey: 'ck-1' })]
    const { db, find } = fakeDb([
      { match: REVIEW, rows },
      { match: TIMES, rows: [] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review', size: 20 })
    const q = find(REVIEW)[0]
    expect(q.sql).toContain('sq.result = 2')
    expect(q.sql).toContain('ORDER BY MAX(sq.answered_at) DESC')
    expect(q.params).toContain('u-1')
    expect(built.scopeLabel).toBe('間違えた問題の復習')
    expect(built.questions.map((q2) => q2.id)).toEqual(['q-1'])
  })

  // @verifies REQ-021
  it('弱点復習の出題回数は過去問全体から数え直す', async () => {
    const rows = [row({ id: 'q-new', exam: '2020r02o', contentKey: 'ck-1' })]
    const { db } = fakeDb([
      { match: REVIEW, rows },
      {
        match: TIMES,
        rows: [
          { id: 'q-new', contentKey: 'ck-1', citation: '出典：令和2年10月 問9', exam: '2020r02o' },
          { id: 'q-old', contentKey: 'ck-1', citation: '出典：平成28年春 問1', exam: '2016h28h' },
        ],
      },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review' })
    expect(built.questions[0].timesAsked).toBe(2)
    expect(built.questions[0].otherCitations).toEqual(['出典：平成28年春 問1'])
  })
})
