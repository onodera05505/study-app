// @vitest-environment jsdom
/** 学習の画面（分野 → 単元 → 論点）。src/client/pages/Topics.tsx を本物の React で描く。
 *
 *  サーバの応答は fetch を偽物にして与える（形は scripts/check_api.py の
 *  FIELDS・CATEGORIES・TOPICS と同じ）。論点の一覧はサーバが middleNo で絞った物を
 *  そのまま出すので、偽の fetch も middleNo で返す配列を分ける。
 *  学びの種類は資格対策。理解度は 0=未・1=未理解・2=やや理解・3=理解（契約の status）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Topics } from '../../src/client/pages/Topics'
import { invalidateCached } from '../../src/client/lib/api'

const FIELDS = {
  fields: [
    { field: 'ストラテジ系', topics: 4, questions: 24, understood: 2, partly: 1, untouched: 0, unanswered: 1 },
    { field: 'テクノロジ系', topics: 4, questions: 20, understood: 1, partly: 0, untouched: 1, unanswered: 2 },
  ],
}

const CATEGORIES = {
  categories: [
    { middleNo: 1, middle: '企業活動', major: '企業と法務', field: 'ストラテジ系', topics: 4, questions: 24, understood: 2 },
    { middleNo: 11, middle: 'セキュリティ', major: '技術要素', field: 'テクノロジ系', topics: 4, questions: 20, understood: 1 },
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

/** サーバが単元で絞って返す論点。 */
const BY_MIDDLE: Record<string, ReturnType<typeof topic>[]> = {
  企業活動: [
    topic({ id: 11, term: '損益分岐点', questionCount: 9, frequencyTier: 3, status: 3, statusSource: 'override', itemName: '会計と財務' }),
    topic({ id: 12, term: 'PDCA', questionCount: 4, frequencyTier: 3, status: 0, itemNo: 2, itemName: '業務分析' }),
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

let container: HTMLElement
let root: Root
let calls: string[]

const text = () => container.textContent ?? ''
const countOf = (part: string) => calls.filter((u) => u.includes(part)).length

/** path ごとに応答を決める偽の fetch。呼ばれた URL は calls に溜める。 */
function stubApi(fail: Set<string> = new Set()) {
  calls = []
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    calls.push(url.pathname + url.search)
    for (const f of fail) {
      if (url.pathname.includes(f)) {
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: '集計を取得できませんでした' }),
        }
      }
    }
    // 分野は「ストラテジ」でも「ストラテジ系」でも同じ分野として扱う
    const field = url.searchParams.get('field')
    const sameField = (f: string) => !field || f.startsWith(field) || field.startsWith(f)
    // 論点の一覧は単元の番号（middleNo）で絞って返す
    const middleNo = url.searchParams.get('middleNo')
    let body: unknown = {}
    if (url.pathname.endsWith('/fields')) body = FIELDS
    else if (url.pathname.endsWith('/categories'))
      body = { categories: CATEGORIES.categories.filter((c) => sameField(c.field)) }
    else if (url.pathname.endsWith('/topics')) {
      const rows = middleNo
        ? BY_MIDDLE[MIDDLE_OF_NO[middleNo] ?? ''] ?? []
        : Object.values(BY_MIDDLE).flat().filter((t) => sameField(t.field))
      body = { structure: null, topics: rows }
    } else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

async function draw(node: ReactNode, entry = '/topics') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/topics" element={node} />
          <Route path="/topics/:id" element={<div>論点の画面</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

/** 要件が決めている文字で操作を探して押す。 */
async function choose(label: string) {
  const cand = [...container.querySelectorAll<HTMLElement>('button, a, [role="button"]')]
  const exact = cand.filter((el) => (el.textContent ?? '').trim() === label)
  const loose = cand.filter((el) => (el.textContent ?? '').includes(label))
  const target = exact[0] ?? loose[0]
  if (!target) throw new Error(`「${label}」を選ぶ操作が画面に無い`)
  await act(async () => {
    target.click()
  })
}

/** 理解度の段階の名前（用語集。資格対策は未を含む）。 */
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

/** 理解度の絞り込みの選択肢（名前が段階の名前だけを指し、論点の名前を含まない押せる物）。 */
const statusChips = () =>
  [...container.querySelectorAll<HTMLElement>('button, [role="button"], [role="checkbox"], input[type="checkbox"]')].filter(
    (el) => stageIn(nameOf(el)) !== null && !TERMS.some((t) => nameOf(el).includes(t)),
  )

/** 選ばれている状態か（押しボタンの aria-pressed・チェックの checked・aria-checked）。 */
const isOn = (el: HTMLElement) =>
  el.getAttribute('aria-pressed') === 'true' ||
  el.getAttribute('aria-checked') === 'true' ||
  (el instanceof HTMLInputElement && el.checked)

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  // 集計は画面を開いている間覚えられるので、テストごとに捨てる
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('単元の一覧（UC-002）', () => {
  // @covers REQ-015#grouped-by-major
  it('大項目ごとに、単元の論点数・過去問数と 理解した数／論点数 を出す', async () => {
    stubApi()
    await draw(<Topics />)
    // 大項目の見出し
    expect(text()).toContain('企業と法務')
    expect(text()).toContain('技術要素')
    // 単元と、その過去問数
    expect(text()).toContain('企業活動')
    expect(text()).toContain('24')
    expect(text()).toContain('20')
    // 理解した数／論点数
    expect(text()).toContain('2/4')
    expect(text()).toContain('1/4')
  })

  // @covers REQ-019#filter-by-field
  it('分野を選ぶとその分野の単元だけが残る', async () => {
    stubApi()
    await draw(<Topics />)
    expect(text()).toContain('セキュリティ')
    await choose('ストラテジ')
    expect(text()).toContain('企業活動')
    expect(text()).not.toContain('セキュリティ')
  })
})

describe('論点の一覧（UC-002）', () => {
  // @covers REQ-022#no-status-selected
  it('理解度を全部外すと取りに行かず、すべて表示に戻す手段を出す', async () => {
    stubApi()
    await draw(<Topics />)
    await choose('企業活動')
    const labels = statusChips()
      .filter(isOn)
      .map((el) => stageIn(nameOf(el))!)
    expect(new Set(labels), '理解度の絞り込みが 4 つの段階すべてを選んだ状態で出ていない').toEqual(new Set(STAGES))
    for (const [i, label] of labels.entries()) {
      const chip = statusChips().find((el) => stageIn(nameOf(el)) === label)!
      const before = countOf('/topics?')
      await act(async () => {
        chip.click()
      })
      if (i === labels.length - 1) {
        // 1 つも選ばれていない状態では取りに行かない
        expect(countOf('/topics?'), '理解度が 0 個でも取りに行っている').toBe(before)
      }
    }
    expect(text()).not.toContain('損益分岐点')
    expect(text()).toContain('すべて表示に戻す')
  })
})

describe('集計が取れないとき（UC-002）', () => {
  // @covers REQ-016#aggregate-failed
  it('失敗の内容と取り直す手段を出し、読み込み中の表示のままにしない', async () => {
    stubApi(new Set(['/fields', '/categories']))
    await draw(<Topics />)
    expect(text()).toContain('集計を取得できませんでした')
    expect(text()).not.toContain('読み込み中')
    // 取り直す手段（押すともう一度取りに行く）
    const before = countOf('/fields') + countOf('/categories')
    let again = before
    for (const b of container.querySelectorAll<HTMLElement>('button')) {
      await act(async () => {
        b.click()
      })
      again = countOf('/fields') + countOf('/categories')
      if (again > before) break
    }
    expect(again, '取り直す手段が無い（押しても取りに行かない）').toBeGreaterThan(before)
  })
})
