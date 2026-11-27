import type { SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import type { Db } from '../../src/server/lib/db'
import { buildQuestions, compareExam, dedupe, snapshotOf, type QuestionRow } from '../../src/server/lib/session-builder'

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
/** 理解度の表（progress）とその段階（status）を引く SQL ＝ 理解度が低い論点の過去問。 */
const WEAK = /(progress[\s\S]*status)|(status[\s\S]*progress)/

const base = { size: 20, masteredStreak: 3, fieldRatio: { テクノロジ系: 45 } }

/** 分野の指定（SQL のパラメータに入った分野名）で絞って返す偽の db。
 *  ランダム構成の模試は分野ごとに引くので、分野で絞られた結果を返す必要がある。 */
function fakeDbByField(rows: QuestionRow[]) {
  const dialect = new SQLiteSyncDialect()
  const names = [...new Set(rows.map((x) => x.field).filter((f): f is string => !!f))]
  const answer = (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    if (!FETCH.test(text)) return []
    const f = params.find((p) => typeof p === 'string' && names.includes(p))
    return f ? rows.filter((x) => x.field === f) : rows
  }
  return {
    db: { all: async (q: SQL) => answer(q), get: async (q: SQL) => answer(q)[0] } as unknown as Db,
  }
}

describe('compareExam（回の新旧）', () => {
  // @covers REQ-053#exam-recency-order
  it('古い回が小さく、新しい回が大きい', () => {
    expect(compareExam('2016h28h', '2024r06')).toBeLessThan(0)
    expect(compareExam('2024r06', '2016h28h')).toBeGreaterThan(0)
    expect(compareExam('2020r02o', '2020r02o')).toBe(0)
  })

  // @covers REQ-053#exam-recency-order
  it('同じ年は 春(h) → 10月(o) → 秋(a) の順で、時期の無い回は年内で最後', () => {
    expect(compareExam('2016h28h', '2016h28a')).toBeLessThan(0)
    expect(compareExam('2020r02h', '2020r02o')).toBeLessThan(0)
    expect(compareExam('2020r02o', '2020r02a')).toBeLessThan(0)
    expect(compareExam('2024r06a', '2024r06')).toBeLessThan(0)
  })

  // @covers REQ-053#exam-recency-order
  it('並べ替えに使うと古い順に揃う', () => {
    const sorted = ['2024r06', '2016h28a', '2020r02o', '2016h28h'].sort(compareExam)
    expect(sorted).toEqual(['2016h28h', '2016h28a', '2020r02o', '2024r06'])
  })
})

describe('dedupe（同一内容を1問にまとめる）', () => {
  // @covers REQ-053#fold-same-content
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

  // @covers REQ-053#duplicate-row-not-counted
  it('JOIN で増えた同じ id の行を「2回出題」と数えない', () => {
    const r = { id: 'q-1', exam: '2024r06', contentKey: 'ck-1', citation: '出典：令和6年 問1' }
    const got = dedupe([r, { ...r }])
    expect(got).toHaveLength(1)
    expect(got[0].timesAsked).toBe(1)
  })

  // @covers REQ-053#no-content-key
  it('content_key が無い問題は id ごとに別の問題として残る', () => {
    const got = dedupe([
      { id: 'q-1', exam: '2024r06', contentKey: null, citation: 'c1' },
      { id: 'q-2', exam: '2024r06', contentKey: null, citation: 'c2' },
    ])
    expect(got.map((q) => q.id)).toEqual(['q-1', 'q-2'])
    expect(got.map((q) => q.timesAsked)).toEqual([1, 1])
  })
})

describe('buildQuestions（出題の組み立て）', () => {
  // @covers REQ-051#scope-drill
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

  // @covers REQ-051#scope-field-middle
  it('field は分野、middle は単元で絞り、単元の範囲の名前は 単元「<単元名>」（契約の例 okMiddle の形）', async () => {
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
    expect(built.scopeLabel).toBe('単元「基礎理論」')
  })

  // @covers REQ-053#fold-in-drill
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

  // @covers REQ-051#size-requested-cap
  it('要求が指定した問題数（size）を超える数は出さない', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ id: `q-${n}`, exam: '2024r06', contentKey: `ck-${n}` }))
    const { db } = fakeDb([
      { match: FETCH, rows },
      { match: /SELECT term FROM topics/, rows: [{ term: '論点' }] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'drill', topicId: 1, size: 2 })
    expect(built.questions).toHaveLength(2)
  })

  // @covers REQ-106#exam-as-printed
  it('回を指定した模試は畳まず、原本どおり問番号の順に出す', async () => {
    const rows = [
      row({ id: 'q-3', exam: '2024r06', number: 3, contentKey: 'ck-same' }),
      row({ id: 'q-1', exam: '2024r06', number: 1, contentKey: 'ck-same' }),
      row({ id: 'q-2', exam: '2024r06', number: 2, contentKey: 'ck-2' }),
    ]
    const { db, find } = fakeDb([{ match: FETCH, rows }])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'mock', exam: '2024r06', size: 100 })
    // 同じ content_key が 2 問あっても畳まないので、その回の過去問の件数（3 問）がそのまま出る
    expect(built.questions).toHaveLength(rows.length)
    expect(built.questions.map((q) => q.number)).toEqual([1, 2, 3])
    expect(built.sourceExam).toBe('2024r06')
    expect(find(FETCH)[0].params).toContain('2024r06')
  })

  // @covers REQ-106#no-mastered-exclusion
  it('回を指定した模試（公開回の通し受験）では連続正解した問題も原本どおり出す', async () => {
    const rows = [1, 2].map((n) => row({ id: `q-${n}`, exam: '2024r06', number: n, contentKey: `ck-${n}` }))
    const { db } = fakeDb([
      { match: MASTERED, rows: [{ qkey: 'ck-1' }, { qkey: 'ck-2' }] },
      { match: FETCH, rows },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'mock', exam: '2024r06', size: 100 })
    expect(built.questions.map((q) => q.id)).toEqual(['q-1', 'q-2'])
  })

  // @covers REQ-053#fold-across-review-sources
  it('誤答と同じ内容の過去問が理解度由来にも来たときは 1 問にまとめる', async () => {
    const same = () => row({ id: 'w-1', exam: '2024r06', contentKey: 'ck-1' })
    const { db } = fakeDb([
      { match: REVIEW, rows: [same()] },
      { match: WEAK, rows: [same(), row({ id: 'k-1', exam: '2024r06', contentKey: 'ck-k1' })] },
      { match: TIMES, rows: [] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review', size: 20 })
    expect(built.questions.map((q) => q.id)).toEqual(['w-1', 'k-1'])
  })

  // @covers REQ-107#field-ratio
  it('回を指定しない模試は分野ごとの出題数を分野比率に寄せ、合計を設定値の問題数にする', async () => {
    const rows = [
      ...[1, 2, 3].map((n) => row({ id: `t-${n}`, exam: '2024r06', contentKey: `ck-t${n}`, field: 'テクノロジ系' })),
      ...[1, 2].map((n) => row({ id: `m-${n}`, exam: '2024r06', contentKey: `ck-m${n}`, field: 'マネジメント系' })),
      ...[1, 2].map((n) => row({ id: `s-${n}`, exam: '2024r06', contentKey: `ck-s${n}`, field: 'ストラテジ系' })),
    ]
    const { db } = fakeDbByField(rows)
    const built = await buildQuestions(db, 'u-1', {
      ...base,
      kind: 'mock',
      size: 4,
      fieldRatio: { テクノロジ系: 2, マネジメント系: 1, ストラテジ系: 1 },
    })
    const per = (prefix: string) => built.questions.filter((q) => q.id.startsWith(prefix)).length
    expect(built.questions).toHaveLength(4)
    expect(per('t-')).toBeLessThanOrEqual(2)
    expect(per('m-')).toBeLessThanOrEqual(1)
    expect(per('s-')).toBeLessThanOrEqual(1)
    expect(built.sourceExam).toBeNull()
  })

  // @covers REQ-108#fill-with-unclassified
  it('分野比率に沿って選ぶだけでは足りないときは分野の付いていない過去問で埋める', async () => {
    const rows = [
      row({ id: 't-1', exam: '2024r06', contentKey: 'ck-t1', field: 'テクノロジ系' }),
      row({ id: 'n-1', exam: '2024r06', contentKey: 'ck-n1', field: null }),
      row({ id: 'n-2', exam: '2024r06', contentKey: 'ck-n2', field: null }),
    ]
    const { db } = fakeDbByField(rows)
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'mock', size: 3, fieldRatio: { テクノロジ系: 3 } })
    expect(built.questions).toHaveLength(3)
    expect(built.questions.filter((q) => q.id.startsWith('n-')).length).toBe(2)
  })

})

describe('snapshotOf（出題時の内容）', () => {
  // @covers REQ-058#snapshot-content
  it('問題文・選択肢・正解・出典を出題時の内容として持つ', () => {
    const q = row({
      id: 'q-1',
      exam: '2024r06',
      text: '出題時の問題文',
      choices: JSON.stringify({ ア: '選択肢アの本文', イ: '選択肢イの本文', ウ: '選択肢ウの本文', エ: '選択肢エの本文' }),
      answer: 'ウ',
      citation: '出典：令和6年度 ITパスポート試験 問7',
    })
    const snap = snapshotOf({ ...q, timesAsked: 1, otherCitations: [] } as unknown as Parameters<typeof snapshotOf>[0])
    const flat = typeof snap === 'string' ? snap : JSON.stringify(snap)
    expect(flat).toContain('出題時の問題文')
    expect(flat).toContain('選択肢ウの本文')
    expect(flat).toContain('出典：令和6年度 ITパスポート試験 問7')
    // 正解は「値」として入る（選択肢の記号は鍵なので、値としての一致を見る）
    expect(flat).toMatch(/:\s*\\?"ウ\\?"/)
  })
})
