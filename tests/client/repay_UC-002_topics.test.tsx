// @vitest-environment jsdom
/** 学習の画面（分野 → 単元 → 論点）の、UC-002 の未返済の分割クラス。
 *  src/client/pages/Topics.tsx を本物の React で描き、戻る導線の試験では
 *  論点の画面（TopicDetail）も同じ経路に載せる。
 *
 *  サーバの応答は fetch を偽物にして与える（形は contract.yaml の listFields・
 *  listCategories・listTopics・getTopicDetail の response）。
 *  理解度は 1=未理解・2=やや理解・3=理解、記録なしは null（用語集: 未理解として扱う）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Topics } from '../../src/client/pages/Topics'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

/** 分野の集計。内訳（理解・やや理解・未理解）の和が論点数に等しい。 */
const FIELDS = {
  fields: [
    { field: 'ストラテジ系', topics: 40, questions: 243, understood: 21, partly: 12, untouched: 7 },
    { field: 'テクノロジ系', topics: 53, questions: 377, understood: 15, partly: 9, untouched: 29 },
  ],
}

const CATEGORIES = {
  categories: [
    { middleNo: 1, middle: '企業活動', major: '企業と法務', field: 'ストラテジ系', topics: 3, questions: 15, understood: 1 },
    { middleNo: 11, middle: 'セキュリティ', major: '技術要素', field: 'テクノロジ系', topics: 1, questions: 7, understood: 0 },
  ],
}

const topic = (over: Record<string, unknown>) => ({
  id: 0,
  term: '',
  questionCount: 0,
  status: null as number | null,
  field: 'ストラテジ系',
  middle: '企業活動',
  itemName: '企業活動',
  isNew: 0,
  sortOrder: null,
  round: null,
  roundLabel: null,
  tier: null,
  ...over,
})

/** サーバが単元で絞って返す論点（出題頻度の降順で持つ）。 */
const BY_MIDDLE: Record<string, ReturnType<typeof topic>[]> = {
  企業活動: [
    topic({ id: 11, term: '損益分岐点', questionCount: 9, status: 3, itemName: '会計と財務' }),
    topic({ id: 12, term: 'PDCA', questionCount: 4, status: 2, itemName: '業務分析' }),
    topic({ id: 13, term: 'SWOT分析', questionCount: 2, status: null, itemName: '経営戦略手法' }),
  ],
  セキュリティ: [
    topic({
      id: 91,
      term: 'クロスサイトスクリプティング',
      questionCount: 7,
      status: 2,
      field: 'テクノロジ系',
      middle: 'セキュリティ',
      itemName: '攻撃手法',
    }),
  ],
}
const MIDDLE_OF_NO: Record<string, string> = { '1': '企業活動', '11': 'セキュリティ' }
const NO_OF_MIDDLE: Record<string, number> = { 企業活動: 1, セキュリティ: 11 }

/** 論点の画面の応答（getTopicDetail）。一覧の論点から引く。 */
function detailOf(id: number) {
  const t = Object.values(BY_MIDDLE)
    .flat()
    .find((x) => x.id === id)!
  return {
    topic: {
      id: t.id,
      term: t.term,
      explanation: `${t.term} の短い説明です。`,
      detail: null,
      questionCount: 1,
      isNew: 0,
      status: t.status,
      field: t.field,
      major: '企業と法務',
      middle: t.middle,
      middleNo: NO_OF_MIDDLE[t.middle],
      itemName: t.itemName,
      tier: null,
    },
    questions: [
      {
        id: '2024r06-q1',
        number: 1,
        examLabel: '令和6年度',
        text: `${t.term} の過去問の本文です。`,
        choices: { ア: 'ア', イ: 'イ', ウ: 'ウ', エ: 'エ' },
        answer: 'ア',
        hasFigure: 0,
        figureDescription: null,
        figureImage: null,
        citation: '令和6年度 問1',
        modified: 0,
        timesAsked: 1,
        otherCitations: [],
        explanation: null,
      },
    ],
    siblings: [],
    nextTopic: null,
    neighbors: null,
  }
}

let container: HTMLElement
let root: Root
let calls: string[]

const text = () => container.textContent ?? ''
const countOf = (part: string) => calls.filter((u) => u.includes(part)).length

/** 要素の文字と、読み上げ用の属性（aria-label・title）を合わせた文字。 */
function blockText(el: Element): string {
  const labels = [el, ...el.querySelectorAll('[aria-label], [title]')]
    .map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`)
    .join(' ')
  return `${el.textContent ?? ''} ${labels}`
}

const allElements = () => [...container.querySelectorAll<HTMLElement>('*')]

type StubOpts = {
  /** この path の取得を 500 で失敗させる。 */
  fail?: Set<string>
  /** 論点の一覧の取得を返さない（取りに行ったまま）。 */
  topicsPending?: boolean
}

/** path ごとに応答を決める偽の fetch。呼ばれた URL は calls に溜める。 */
function stubApi(opts: StubOpts = {}) {
  calls = []
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    calls.push(url.pathname + url.search)
    for (const f of opts.fail ?? []) {
      if (url.pathname.endsWith(f)) {
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: `${f} を取得できませんでした` }),
        }
      }
    }
    const field = url.searchParams.get('field')
    const sameField = (f: string) => !field || f.startsWith(field) || field.startsWith(f)
    let body: unknown = {}
    if (url.pathname.endsWith('/fields')) body = FIELDS
    else if (url.pathname.endsWith('/categories'))
      body = { categories: CATEGORIES.categories.filter((c) => sameField(c.field)) }
    else if (url.pathname.endsWith('/topics')) {
      if (opts.topicsPending) return new Promise(() => {})
      const middleNo = url.searchParams.get('middleNo')
      let rows = middleNo
        ? BY_MIDDLE[MIDDLE_OF_NO[middleNo] ?? ''] ?? []
        : Object.values(BY_MIDDLE).flat().filter((t) => sameField(t.field))
      // 理解度の絞り込み（記録なしは未理解＝1 として扱う）
      const status = url.searchParams.get('status')
      if (status) {
        const allowed = new Set(status.split(',').map((s) => Number(s)))
        rows = rows.filter((t) => allowed.has(t.status ?? 1))
      }
      // 名前の順を求められたときだけ名前で並べる（既定は出題頻度の降順のまま）
      if (url.searchParams.get('sort') === 'name')
        rows = [...rows].sort((a, b) => a.term.localeCompare(b.term, 'ja'))
      body = { topics: rows }
    } else if (/\/topics\/\d+$/.test(url.pathname)) body = detailOf(Number(url.pathname.split('/').pop()))
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

async function draw(entry = '/topics') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/topics" element={<Topics />} />
          <Route path="/topics/:id" element={<TopicDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

const controls = () => [...container.querySelectorAll<HTMLElement>('button, a, [role="button"]')]

/** 要件が決めている文字で操作を探して押す。 */
async function choose(label: string | RegExp) {
  const match = (s: string) => (typeof label === 'string' ? s.includes(label) : label.test(s))
  const cand = controls()
  const exact = typeof label === 'string' ? cand.filter((el) => (el.textContent ?? '').trim() === label) : []
  const loose = cand.filter((el) => match(el.textContent ?? ''))
  const target = exact[0] ?? loose[0]
  if (!target) throw new Error(`「${label}」を選ぶ操作が画面に無い`)
  await act(async () => {
    target.click()
  })
}

/** 理解度の段階の語（用語集）。 */
const STAGES = ['未理解', 'やや理解', '理解']

/** 理解度の絞り込みの操作（段階の語だけを持つ押しボタン）。 */
const stageChips = () =>
  [...container.querySelectorAll<HTMLElement>('button')].filter((b) => STAGES.includes((b.textContent ?? '').trim()))

/** 論点の行（その論点の名前を含み、隣の論点の名前を含まない、最も小さい要素）。 */
function rowOf(term: string, other: string): HTMLElement {
  const cand = allElements().filter((el) => {
    const t = blockText(el)
    return t.includes(term) && !t.includes(other) && /未理解|やや理解|理解/.test(t)
  })
  if (!cand.length) throw new Error(`論点「${term}」の行に理解度（未理解・やや理解・理解）が添えられていない`)
  return cand.sort((a, b) => blockText(a).length - blockText(b).length)[0]
}

/** 画面の文字の中での出現位置（無ければ -1）。 */
const at = (s: string) => text().indexOf(s)

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('単元の一覧（UC-002）', () => {
  // @covers REQ-014#field-aggregate
  it('分野ごとに、論点数・過去問数と理解度の内訳（理解・やや理解・未理解）を一か所にまとめて出す', async () => {
    stubApi()
    await draw()
    // 分野の名前は末尾の「系」を省いて示してもよい
    const nameOf = (field: string) => field.replace(/系$/, '')
    for (const f of FIELDS.fields) {
      const other = nameOf(FIELDS.fields.find((x) => x !== f)!.field)
      const numbers = [f.topics, f.questions, f.understood, f.partly, f.untouched].map(String)
      const blocks = allElements().filter((el) => {
        const t = blockText(el)
        return t.includes(nameOf(f.field)) && !t.includes(other)
      })
      expect(blocks.length, `分野「${f.field}」が出ていない`).toBeGreaterThan(0)
      const hit = blocks.find((el) => numbers.every((n) => blockText(el).includes(n)))
      expect(
        hit,
        `分野「${f.field}」の名前と一緒に 論点数 ${f.topics}・過去問数 ${f.questions}・理解 ${f.understood}・やや理解 ${f.partly}・未理解 ${f.untouched} がそろって出ている場所が無い（出ているのは: ${blocks.map((b) => (b.textContent ?? '').trim()).filter((t) => t.length < 40).join(' / ')}）`,
      ).toBeTruthy()
    }
  })
})

describe('論点の一覧（UC-002）', () => {
  // @covers REQ-020#frequency-desc
  it('単元を選ぶと、論点を出題頻度の降順に、頻度の数つきで出す', async () => {
    stubApi()
    await draw()
    await choose('企業活動')
    // 既定の並びは出題頻度（名前の順を求めていない）
    const first = calls.find((u) => u.includes('/topics?') && u.includes('middleNo=1'))
    expect(first, '単元の論点を取りに行っていない').toBeTruthy()
    const sort = new URL(first!, 'http://localhost').searchParams.get('sort')
    expect(sort === null || sort === 'frequency', `既定の並べ替えが出題頻度でない（sort=${sort}）`).toBe(true)
    // 9 → 4 → 2 の順に並ぶ
    expect(at('損益分岐点')).toBeGreaterThanOrEqual(0)
    expect(at('損益分岐点')).toBeLessThan(at('PDCA'))
    expect(at('PDCA')).toBeLessThan(at('SWOT分析'))
    // 論点ごとの出題頻度の数
    for (const t of BY_MIDDLE['企業活動']) {
      const others = BY_MIDDLE['企業活動'].filter((x) => x !== t).map((x) => x.term)
      const row = allElements().find((el) => {
        const b = blockText(el)
        return b.includes(t.term) && b.includes(String(t.questionCount)) && !others.some((o) => b.includes(o))
      })
      expect(row, `論点「${t.term}」の行に出題頻度 ${t.questionCount} が添えられていない`).toBeTruthy()
    }
  })

  // @covers REQ-020#status-shown
  it('理解度の記録がある論点にはその段階を、記録が無い論点には未理解を添える', async () => {
    stubApi()
    await draw()
    await choose('企業活動')
    const done = blockText(rowOf('損益分岐点', 'PDCA'))
    expect(done).toContain('理解')
    expect(done).not.toContain('未理解')
    expect(done).not.toContain('やや理解')
    const partly = blockText(rowOf('PDCA', '損益分岐点'))
    expect(partly).toContain('やや理解')
    const untouched = blockText(rowOf('SWOT分析', 'PDCA'))
    expect(untouched).toContain('未理解')
  })

  // @covers REQ-021#refilter-status
  it('理解度の絞り込みを別の組み合わせに選び直すと、その絞り込みで一覧を示し直す', async () => {
    stubApi()
    await draw()
    await choose('企業活動')
    expect(text()).toContain('損益分岐点')
    expect(text()).toContain('PDCA')
    // 「理解」を外す（未理解・やや理解の 2 つが残る）
    const chip = stageChips().find((b) => (b.textContent ?? '').trim() === '理解')
    expect(chip, '理解度の絞り込み「理解」の操作が無い').toBeTruthy()
    const before = countOf('/topics?')
    await act(async () => {
      chip!.click()
    })
    const requests = calls.filter((u) => u.includes('/topics?'))
    expect(requests.length, '絞り込みを選び直しても取りに行っていない').toBeGreaterThan(before)
    const status = new URL(requests[requests.length - 1], 'http://localhost').searchParams.get('status') ?? ''
    const asked = new Set(status.split(',').filter(Boolean).map(Number))
    expect(asked, `取りに行った理解度が「未理解・やや理解」でない（status=${status}）`).toEqual(new Set([1, 2]))
    // 理解（3）の論点は消え、やや理解（2）の論点は残る
    expect(text()).not.toContain('損益分岐点')
    expect(text()).toContain('PDCA')
  })

  // @covers REQ-027#topic-list-failed
  it('一覧が取れなかったら、読み込み中を残さず、単元と並べ替え・絞り込みを保ったまま一覧の場所に失敗を示す', async () => {
    stubApi({ fail: new Set(['/topics']) })
    await draw()
    expect(text()).toContain('企業活動')
    await choose('企業活動')
    expect(countOf('/topics?'), '単元の論点を取りに行っていない').toBeGreaterThan(0)
    expect(text()).toContain('/topics を取得できませんでした')
    expect(text()).not.toContain('読み込み中')
    // 選んでいる単元を保つ
    expect(text()).toContain('企業活動')
    // 並べ替えと理解度の絞り込みの手段を保つ
    expect(
      controls().some((el) => /名前/.test(el.textContent ?? '')),
      '並べ替え（名前の順）の手段が消えている',
    ).toBe(true)
    expect(stageChips().map((b) => (b.textContent ?? '').trim()), '理解度の絞り込みの手段が消えている').toEqual(
      STAGES,
    )
    expect(text()).not.toContain('損益分岐点')
  })

  // @covers REQ-028#not-yet-fetched
  it('一覧をまだ取れていない間は、該当する論点が無い旨を出さない', async () => {
    stubApi({ topicsPending: true })
    await draw()
    await choose('企業活動')
    expect(countOf('/topics?'), '単元の論点を取りに行っていない（取りに行っている状態になっていない）').toBeGreaterThan(0)
    expect(text()).not.toMatch(/該当する論点/)
    expect(text()).not.toMatch(/論点が(ありません|無い|ない)/)
    expect(text()).not.toContain('損益分岐点')
  })

  // @covers REQ-029#back-from-topic-list
  it('論点の一覧の戻る導線は、単元の一覧へ戻す', async () => {
    stubApi()
    await draw()
    const beforeBack = new Set(controls().filter((el) => /戻る/.test(el.textContent ?? '')))
    await choose('企業活動')
    expect(text()).toContain('損益分岐点')
    const back = controls().filter((el) => /戻る/.test(el.textContent ?? '') && !beforeBack.has(el))
    expect(back.length, '論点の一覧に戻る導線が無い').toBeGreaterThan(0)
    await act(async () => {
      back[0].click()
    })
    // 単元の一覧（両方の単元）が示され、論点は示されていない
    expect(text()).toContain('企業活動')
    expect(text()).toContain('セキュリティ')
    expect(text()).not.toContain('損益分岐点')
    expect(text()).not.toContain('PDCA')
  })
})

describe('論点の教材から戻る（UC-002）', () => {
  // @covers REQ-029#back-from-material
  it('論点の教材の戻る導線は、来た単元の論点の一覧へ戻す', async () => {
    stubApi()
    await draw()
    await choose('企業活動')
    await choose('損益分岐点')
    // 論点の教材に入っている
    expect(text()).toContain('損益分岐点 の短い説明です。')
    const back = [...container.querySelectorAll<HTMLAnchorElement>('a')].filter((a) =>
      /戻る/.test(a.textContent ?? ''),
    )
    expect(back.length, '論点の教材に戻る導線が無い').toBeGreaterThan(0)
    await act(async () => {
      back[0].click()
    })
    // 来た論点の一覧（企業活動の論点）に戻っている
    expect(text()).not.toContain('損益分岐点 の短い説明です。')
    expect(text()).toContain('損益分岐点')
    expect(text()).toContain('PDCA')
    expect(text()).toContain('SWOT分析')
    expect(text()).not.toContain('クロスサイトスクリプティング')
  })
})
