// @vitest-environment jsdom
/** 学習の画面（分野 → 単元 → 論点）の、UC-002 の未返済の分割クラス。
 *  src/client/pages/Topics.tsx を本物の React で描き、戻る導線の試験では
 *  論点の画面（TopicDetail）も同じ経路に載せる。
 *
 *  サーバの応答は fetch を偽物にして与える（形は contract.yaml の listFields・
 *  listCategories・listTopics・getTopicDetail の response）。学びの種類は資格対策。
 *  理解度は 0=未・1=未理解・2=やや理解・3=理解（契約の status）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Topics } from '../../src/client/pages/Topics'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

/** 分野の集計。内訳（理解・やや理解・未理解・未）の和が論点数に等しい。 */
const FIELDS = {
  fields: [
    { field: 'ストラテジ系', topics: 40, questions: 243, understood: 15, partly: 9, untouched: 6, unanswered: 10 },
    { field: 'テクノロジ系', topics: 53, questions: 377, understood: 11, partly: 8, untouched: 5, unanswered: 29 },
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
  subtitle: null,
  questionCount: 0,
  frequencyTier: null as number | null,
  status: 0 as number | null,
  statusSource: 'auto',
  field: 'ストラテジ系',
  middle: '企業活動',
  itemNo: 1,
  itemName: '企業活動',
  groupNo: null,
  isNew: 0,
  sortOrder: null,
  round: null,
  roundLabel: null,
  tier: null,
  ...over,
})

/** サーバが単元で絞って返す論点（単元の構成を持たない単元。配列の順がサーバの返す並び）。 */
const BY_MIDDLE: Record<string, ReturnType<typeof topic>[]> = {
  企業活動: [
    topic({ id: 11, term: '損益分岐点', questionCount: 9, frequencyTier: 3, status: 3, statusSource: 'override', itemNo: 1, itemName: '会計と財務' }),
    topic({ id: 12, term: 'PDCA', questionCount: 4, frequencyTier: 3, status: 2, itemNo: 2, itemName: '業務分析' }),
    topic({ id: 13, term: 'SWOT分析', questionCount: 2, frequencyTier: 2, status: 0, itemNo: 3, itemName: '経営戦略手法' }),
  ],
  セキュリティ: [
    topic({
      id: 91,
      term: 'クロスサイトスクリプティング',
      questionCount: 7,
      frequencyTier: 3,
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
      frequencyTier: 1,
      isNew: 0,
      status: t.status,
      statusSource: t.statusSource,
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
    prerequisites: [],
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

/** 語（用語集の語）の直後に置かれた数を、出てくる順にすべて返す。語と数の間は空白・区切り記号だけを許し、
 *  数の後ろは問わない（「過去問 243」でも「過去問 243問」でも 243）。「理解」は「やや理解」「未理解」の一部としては、
 *  「未」は「未理解」の一部としては数えない。 */
function numbersAfter(text: string, label: string): number[] {
  const flat = text.replace(/\s+/g, ' ')
  const guard = label === '理解' ? '(?<![や未])' : ''
  const tail = label === '未' ? '(?!理解)' : ''
  const re = new RegExp(`${guard}${label}${tail}[\\s:：]*(\\d+)(?!\\d)`, 'g')
  return [...flat.matchAll(re)].map((m) => Number(m[1]))
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
      // 理解度の絞り込み（0=未 を含む番号のカンマ区切り）
      const status = url.searchParams.get('status')
      if (status !== null) {
        const allowed = new Set(status.split(',').filter(Boolean).map((s) => Number(s)))
        rows = rows.filter((t) => t.status !== null && allowed.has(t.status))
      }
      body = { structure: null, topics: rows }
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

/** 理解度の段階の語（用語集。資格対策は未を含む）。 */
const STAGES = ['未', '未理解', 'やや理解', '理解']

/** 読み上げに届く名前（aria-label、結び付いたラベル、無ければ見える文字）。 */
const nameOf = (el: Element) => {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria.replace(/\s+/g, ' ').trim()
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) return [...labels].map((l) => l.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim()
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 名前に現れる理解度の段階の名前（ちょうど 1 つのときだけ返す）。長い名前から先に当てる。 */
function stageIn(t: string): string | null {
  let rest = t.replace(/理解度/g, '')
  const found: string[] = []
  for (const name of ['やや理解', '未理解', '理解', '未']) {
    if (rest.includes(name)) found.push(name)
    rest = rest.split(name).join('')
  }
  return found.length === 1 ? found[0] : null
}

const TERMS = Object.values(BY_MIDDLE)
  .flat()
  .map((t) => t.term)
const FILTER_CONTROLS = 'button, [role="button"], [role="checkbox"], input[type="checkbox"]'

/** 理解度の絞り込みの選択肢（名前が段階の名前だけを指し、論点の名前を含まない押せる物）を段階の名前で引く。 */
const stageChips = () =>
  [...container.querySelectorAll<HTMLElement>(FILTER_CONTROLS)].filter(
    (el) => stageIn(nameOf(el)) !== null && !TERMS.some((t) => nameOf(el).includes(t)),
  )
const chipOf = (stage: string) => stageChips().find((el) => stageIn(nameOf(el)) === stage)

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
  it('分野ごとに、論点・過去問の数と理解度の内訳（理解・やや理解・未理解・未）を、語と数の組で一か所にまとめて出す', async () => {
    stubApi()
    await draw()
    // 分野の名前は末尾の「系」を省いて示してもよい
    const nameOf = (field: string) => field.replace(/系$/, '')
    for (const f of FIELDS.fields) {
      const other = nameOf(FIELDS.fields.find((x) => x !== f)!.field)
      const pairs: [string, number][] = [
        ['論点', f.topics],
        ['過去問', f.questions],
        ['理解', f.understood],
        ['やや理解', f.partly],
        ['未理解', f.untouched],
        ['未', f.unanswered],
      ]
      const blocks = allElements().filter((el) => {
        const t = blockText(el)
        return t.includes(nameOf(f.field)) && !t.includes(other)
      })
      expect(blocks.length, `分野「${f.field}」が出ていない`).toBeGreaterThan(0)
      const hit = blocks.find((el) => pairs.every(([label, n]) => numbersAfter(blockText(el), label).includes(n)))
      expect(
        hit,
        `分野「${f.field}」の名前と一緒に ${pairs.map(([l, n]) => `${l} ${n}`).join('・')} が語と数の組で出ている場所が無い（出ているのは: ${blocks.map((b) => (b.textContent ?? '').trim()).filter((t) => t.length < 80).join(' / ')}）`,
      ).toBeTruthy()
    }
  })
})

describe('論点の一覧（UC-002）', () => {
  // @covers REQ-021#refilter-status
  it('理解度の絞り込みを別の組み合わせに選び直すと、その絞り込みで一覧を示し直す', async () => {
    stubApi()
    await draw()
    await choose('企業活動')
    expect(text()).toContain('損益分岐点')
    expect(text()).toContain('PDCA')
    // 「理解」を外す（未・未理解・やや理解の 3 つが残る）
    const chip = chipOf('理解')
    expect(chip, '理解度の絞り込み「理解」の選択肢が無い').toBeTruthy()
    const before = countOf('/topics?')
    await act(async () => {
      chip!.click()
    })
    const requests = calls.filter((u) => u.includes('/topics?'))
    expect(requests.length, '絞り込みを選び直しても取りに行っていない').toBeGreaterThan(before)
    const status = new URL(requests[requests.length - 1], 'http://localhost').searchParams.get('status') ?? ''
    const asked = new Set(status.split(',').filter(Boolean).map(Number))
    expect(asked, `取りに行った理解度が「未・未理解・やや理解」でない（status=${status}）`).toEqual(new Set([0, 1, 2]))
    // 理解（3）の論点は消え、やや理解（2）と未（0）の論点は残る
    expect(text()).not.toContain('損益分岐点')
    expect(text()).toContain('PDCA')
    expect(text()).toContain('SWOT分析')
  })

  // @covers REQ-027#topic-list-failed
  it('一覧が取れなかったら、読み込み中を残さず、単元と理解度の絞り込みを保ったまま一覧の場所に失敗を示す', async () => {
    stubApi({ fail: new Set(['/topics']) })
    await draw()
    expect(text()).toContain('企業活動')
    await choose('企業活動')
    expect(countOf('/topics?'), '単元の論点を取りに行っていない').toBeGreaterThan(0)
    expect(text()).toContain('/topics を取得できませんでした')
    expect(text()).not.toContain('読み込み中')
    // 選んでいる単元を保つ
    expect(text()).toContain('企業活動')
    // 理解度の絞り込みの手段を、資格対策の 4 つの段階すべてで保つ
    expect(
      new Set(stageChips().map((el) => stageIn(nameOf(el)))),
      '理解度の絞り込みの手段が消えている',
    ).toEqual(new Set(STAGES))
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
