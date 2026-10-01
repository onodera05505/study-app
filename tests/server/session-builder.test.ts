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

/** 論点名・中分類名の引き当て（範囲の名前に使われる）。 */
const TERM: Handler = { match: /SELECT term FROM topics/, rows: [{ term: '損益分岐点' }] }
const MIDDLE: Handler = { match: /SELECT middle FROM syllabus_items/, rows: [{ middle: '基礎理論' }] }

/** 発行された SQL の ? にパラメータを順に埋め、空白と引用符を落とした文字列。
 *  条件の境目の値（理解度の段階・正誤の値）を、書き方の差を越えて見るために使う。 */
function condition(call: { sql: string; params: unknown[] }): string {
  let i = 0
  return call.sql.replace(/\?/g, () => String(call.params[i++])).replace(/["`\s]+/g, '')
}

/** 理解度が「理解」（3 段目）の論点を範囲から外している条件か。
 *  status<3 / status<=2 / status in (1,2) / status<>3 / status not in (3) のいずれかを認める。 */
function excludesUnderstood(cond: string): boolean {
  return (
    /status(<3|<=2|<>3|!=3)/i.test(cond) ||
    /statusin\(1,2\)/i.test(cond) ||
    /statusin\(2,1\)/i.test(cond) ||
    /statusnotin\(3\)/i.test(cond)
  )
}

/** 出題頻度（論点に紐づく過去問の件数）の多い論点から並べているか。
 *  件数の持ち方は要件が決めていないので、列（question_count）でも集計（COUNT(…)）でも認める。 */
function ordersByFrequencyDesc(sql: string): boolean {
  const order = sql.replace(/["`\s]+/g, '').match(/ORDERBY([\s\S]*)/i)?.[1] ?? ''
  return /question_count|COUNT\(/i.test(order) && /DESC/i.test(order)
}

/** 本人が正解した（result=1）記録のある過去問を範囲から外している条件か。
 *  result<>1 / result!=1 / result not in (1) / result=2 / NOT EXISTS(... result=1 ...) を認める。 */
function excludesCorrect(cond: string): boolean {
  return (
    /result(<>1|!=1|=2)/i.test(cond) ||
    /resultnotin\(1\)/i.test(cond) ||
    (/notexists\(/i.test(cond) && /result=1/i.test(cond))
  )
}

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

  // @covers REQ-051#size-cap
  it('size を超える数は出さない', async () => {
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

  // @covers REQ-052#mastered-excluded
  it('drill・field・middle・弱点復習・回を指定しない模試で、直近 N 回連続で正解した問題は出さない', async () => {
    const rows = [1, 2, 3].map((n) => row({ id: `q-${n}`, exam: '2024r06', contentKey: `ck-${n}`, field: 'テクノロジ系' }))
    /** 定着済み（ck-2）を返す偽 db で組み立て、出題に残った id を返す。 */
    const idsOf = async (handlers: Handler[], input: Parameters<typeof buildQuestions>[2]) => {
      const { db, find } = fakeDb([{ match: MASTERED, rows: [{ qkey: 'ck-2' }] }, ...handlers])
      const built = await buildQuestions(db, 'u-1', input)
      // 連続正解の回数は呼び出し側の設定値を使う
      expect(find(MASTERED)[0].params).toContain(3)
      return built.questions.map((q) => q.id).sort()
    }
    const scoped: Handler[] = [{ match: FETCH, rows }]
    expect(await idsOf([...scoped, TERM], { ...base, kind: 'drill', topicId: 42 })).toEqual(['q-1', 'q-3'])
    expect(await idsOf(scoped, { ...base, kind: 'field', field: 'テクノロジ系' })).toEqual(['q-1', 'q-3'])
    expect(await idsOf([...scoped, MIDDLE], { ...base, kind: 'middle', middleNo: 7 })).toEqual(['q-1', 'q-3'])
    // 回を指定しない模試（ランダム構成）も除外する
    expect(await idsOf(scoped, { ...base, kind: 'mock' })).toEqual(['q-1', 'q-3'])
    // 弱点復習は、誤答から来た問題も理解度が低い論点から来た問題も除外の対象
    const review: Handler[] = [
      { match: REVIEW, rows: [rows[0], rows[1]] },
      { match: WEAK, rows: [rows[2]] },
      { match: TIMES, rows: [] },
    ]
    expect(await idsOf(review, { ...base, kind: 'review' })).toEqual(['q-1', 'q-3'])
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

  // @covers REQ-052#mastered-all-fallback
  it('範囲の問題が除外で全部無くなるときは除外しない（弱点復習は誤答と理解度由来を合わせて見る）', async () => {
    const rows = [row({ id: 'q-1', exam: '2024r06', contentKey: 'ck-1', field: 'テクノロジ系' })]
    const f = fakeDb([
      { match: MASTERED, rows: [{ qkey: 'ck-1' }] },
      { match: FETCH, rows },
    ])
    const byField = await buildQuestions(f.db, 'u-1', { ...base, kind: 'field', field: 'テクノロジ系' })
    expect(byField.questions.map((q) => q.id)).toEqual(['q-1'])

    const wrong = row({ id: 'w-1', exam: '2024r06', contentKey: 'ck-w' })
    const weak = row({ id: 'k-1', exam: '2024r06', contentKey: 'ck-k' })
    const reviewDb = (mastered: { qkey: string }[]) =>
      fakeDb([
        { match: MASTERED, rows: mastered },
        { match: REVIEW, rows: [wrong] },
        { match: WEAK, rows: [weak] },
        { match: TIMES, rows: [] },
      ]).db
    // 誤答と理解度由来を合わせて全部が定着済みなら、外さずそのまま出す
    const all = await buildQuestions(reviewDb([{ qkey: 'ck-w' }, { qkey: 'ck-k' }]), 'u-1', { ...base, kind: 'review' })
    expect(all.questions.map((q) => q.id)).toEqual(['w-1', 'k-1'])
    // 片方が残るなら、定着済みの方は外す
    const some = await buildQuestions(reviewDb([{ qkey: 'ck-w' }]), 'u-1', { ...base, kind: 'review' })
    expect(some.questions.map((q) => q.id)).toEqual(['k-1'])
  })

  // @covers REQ-054#wrong-recent-first
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

  // @covers REQ-054#wrong-then-weak-fill
  it('弱点復習は誤答を新しい順に先に詰め、余りを理解度が低い論点の過去問で埋める', async () => {
    const wrong = [1, 2].map((n) => row({ id: `w-${n}`, exam: '2024r06', contentKey: `ck-w${n}` }))
    const weak = [1, 2].map((n) => row({ id: `k-${n}`, exam: '2024r06', contentKey: `ck-k${n}` }))
    const { db, find } = fakeDb([
      { match: REVIEW, rows: wrong },
      { match: WEAK, rows: weak },
      { match: TIMES, rows: [] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review', size: 20 })
    // 誤答（最後に間違えた時刻の新しい順）が先頭、そのあとに理解度が低い論点の過去問
    expect(find(REVIEW)[0].sql).toContain('ORDER BY MAX(sq.answered_at) DESC')
    expect(built.questions.map((q) => q.id)).toEqual(['w-1', 'w-2', 'k-1', 'k-2'])
    // 理解度は本人の記録から引く
    expect(find(WEAK)[0].params).toContain('u-1')
  })

  // @covers REQ-054#weak-by-frequency
  it('理解度が低い論点の過去問は出題頻度の高い論点から取る', async () => {
    const { db, find } = fakeDb([
      { match: REVIEW, rows: [row({ id: 'w-1', exam: '2024r06', contentKey: 'ck-w1' })] },
      { match: WEAK, rows: [row({ id: 'k-1', exam: '2024r06', contentKey: 'ck-k1' })] },
      { match: TIMES, rows: [] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review', size: 20 })
    expect(built.questions.map((q) => q.id)).toEqual(['w-1', 'k-1'])
    // 出題頻度＝その論点に紐づく過去問の件数。多い論点から順に取る
    expect(ordersByFrequencyDesc(find(WEAK)[0].sql)).toBe(true)
  })

  // @covers REQ-054#weak-status-boundary
  it('理解度 3 の論点と、理解度の記録が無い論点の過去問は、誤答でなければ入らない', async () => {
    const { db, find } = fakeDb([
      { match: REVIEW, rows: [row({ id: 'w-1', exam: '2024r06', contentKey: 'ck-w1' })] },
      { match: WEAK, rows: [] },
      { match: TIMES, rows: [] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review', size: 20 })
    // 理解度が低い論点が無ければ、弱点復習は誤答だけになる
    expect(built.questions.map((q) => q.id)).toEqual(['w-1'])
    // 誤答だけでは問題数に足りないので、理解度が低い論点の過去問を引きに行く
    expect(find(WEAK)).toHaveLength(1)
    const cond = condition(find(WEAK)[0])
    // 理解（3 段目）にした論点は範囲に入らない
    expect(excludesUnderstood(cond)).toBe(true)
    // 記録の無い論点も入らない（理解度の表に行がある論点だけを見る）
    expect(cond).not.toMatch(/statusisnull/i)
    // 誤答の側は理解度で絞らない（間違えた問題は理解度に関わらず入る）
    expect(excludesUnderstood(condition(find(REVIEW)[0]))).toBe(false)
  })

  // @covers REQ-054#wrong-only-incorrect
  it('正解した問題を外すのは誤答の側だけで、理解度が低い論点の過去問には正解したことのある問題も入る', async () => {
    const { db, find } = fakeDb([
      { match: REVIEW, rows: [row({ id: 'w-1', exam: '2024r06', contentKey: 'ck-w1' })] },
      { match: WEAK, rows: [row({ id: 'k-1', exam: '2024r06', contentKey: 'ck-k1' })] },
      { match: TIMES, rows: [] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review', size: 20 })
    expect(find(REVIEW)).toHaveLength(1)
    expect(find(WEAK)).toHaveLength(1)
    // 誤答の側は誤答の記録がある過去問だけ
    expect(excludesCorrect(condition(find(REVIEW)[0]))).toBe(true)
    // 理解度由来は正誤で絞らない（掛かるのは定着した問題の除外だけ）
    expect(excludesCorrect(condition(find(WEAK)[0]))).toBe(false)
    expect(built.questions.map((q) => q.id)).toEqual(['w-1', 'k-1'])
  })

  // @covers REQ-054#wrong-fills-size
  it('誤答だけで問題数に達するときは理解度由来を足さない', async () => {
    const wrong = [1, 2].map((n) => row({ id: `w-${n}`, exam: '2024r06', contentKey: `ck-w${n}` }))
    const { db } = fakeDb([
      { match: REVIEW, rows: wrong },
      { match: WEAK, rows: [row({ id: 'k-1', exam: '2024r06', contentKey: 'ck-k1' })] },
      { match: TIMES, rows: [] },
    ])
    const built = await buildQuestions(db, 'u-1', { ...base, kind: 'review', size: 2 })
    expect(built.questions.map((q) => q.id)).toEqual(['w-1', 'w-2'])
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

  // @covers REQ-053#times-asked-recount
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
