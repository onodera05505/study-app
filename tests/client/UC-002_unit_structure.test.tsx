// @vitest-environment jsdom
/** 論点の一覧（src/client/pages/Topics.tsx）の、単元の構成に沿った示し方（UC-002）。
 *  本物の React で描き、単元の一覧から単元を選んで論点の一覧に入る。
 *
 *  サーバの応答は fetch を偽物にして与える（形は contract.yaml の listFields・listCategories・listTopics の response。
 *  値は listTopics の examples に寄せる）。学びの種類は資格対策。理解度は 0=未・1=未理解・2=やや理解・3=理解。
 *  画面は見える文字か読み上げに届く名前で引き、並びは画面の文字の中の出現の順で見る。出題回数の印は BR-051 の ★ で読む。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Topics } from '../../src/client/pages/Topics'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

const FIELDS = {
  fields: [{ field: 'テクノロジ系', topics: 9, questions: 31, understood: 2, partly: 1, untouched: 2, unanswered: 4 }],
}

const CATEGORIES = {
  categories: [
    { middleNo: 12, middle: 'セキュリティ', major: '技術要素', field: 'テクノロジ系', topics: 5, questions: 16, understood: 1 },
    { middleNo: 7, middle: 'ソフトウェア', major: 'コンピュータシステム', field: 'テクノロジ系', topics: 4, questions: 9, understood: 1 },
    { middleNo: 13, middle: 'ネットワーク', major: '技術要素', field: 'テクノロジ系', topics: 2, questions: 5, understood: 0 },
  ],
}

type Status = 0 | 1 | 2 | 3

/** listTopics の topics の 1 行（契約の形）。 */
const row = (o: {
  id: number
  term: string
  questionCount: number
  frequencyTier: 1 | 2 | 3 | null
  status: Status
  middle: string
  itemNo: number
  itemName: string
  groupNo: number | null
}) => ({
  subtitle: null,
  statusSource: o.status === 0 ? 'auto' : 'override',
  field: 'テクノロジ系',
  isNew: 0,
  sortOrder: null,
  round: null,
  roundLabel: null,
  tier: null,
  ...o,
})

/** 単元 12 の単元の構成（契約の examples.ok）。 */
const STRUCTURE = {
  overview: '情報を守る考え方と、それを支える暗号・認証の仕組みを学ぶ。',
  groups: [
    { no: 1, name: '暗号と証明書', description: '鍵の持ち方で暗号を分け、署名と証明書で相手を確かめる。' },
    { no: 2, name: '攻撃と対策', description: 'よくある攻撃の手口と、それぞれを防ぐ仕組み。' },
  ],
}
/** 単元 12 の論点。配列の順がサーバの返す単元の構成の順で、出題頻度の順ではない。 */
const SECURITY = [
  row({ id: 419, term: '共通鍵暗号方式', questionCount: 1, frequencyTier: 1, status: 1, middle: 'セキュリティ', itemNo: 3, itemName: '暗号技術', groupNo: 1 }),
  row({ id: 418, term: '公開鍵暗号方式', questionCount: 9, frequencyTier: 3, status: 2, middle: 'セキュリティ', itemNo: 3, itemName: '暗号技術', groupNo: 1 }),
  row({ id: 421, term: 'ディジタル署名', questionCount: 2, frequencyTier: 2, status: 3, middle: 'セキュリティ', itemNo: 4, itemName: '認証技術', groupNo: 1 }),
  row({ id: 433, term: 'SQL インジェクション', questionCount: 4, frequencyTier: 3, status: 0, middle: 'セキュリティ', itemNo: 5, itemName: '情報セキュリティ対策', groupNo: 2 }),
  row({ id: 440, term: 'ファイアウォール', questionCount: 0, frequencyTier: null, status: 0, middle: 'セキュリティ', itemNo: 3, itemName: '暗号技術', groupNo: 2 }),
]
/** 単元 7 の論点（単元の構成を持たない）。配列の順がサーバの返す並び（小項目の番号の順）。 */
const SOFTWARE = [
  row({ id: 502, term: 'インタプリタ', questionCount: 4, frequencyTier: 3, status: 0, middle: 'ソフトウェア', itemNo: 1, itemName: 'オペレーティングシステム', groupNo: null }),
  row({ id: 501, term: 'コンパイラ', questionCount: 2, frequencyTier: 2, status: 1, middle: 'ソフトウェア', itemNo: 1, itemName: 'オペレーティングシステム', groupNo: null }),
  row({ id: 503, term: 'リンカ', questionCount: 2, frequencyTier: 2, status: 0, middle: 'ソフトウェア', itemNo: 1, itemName: 'オペレーティングシステム', groupNo: null }),
  row({ id: 499, term: 'ジャーナリング', questionCount: 1, frequencyTier: 1, status: 3, middle: 'ソフトウェア', itemNo: 2, itemName: 'ファイルシステム', groupNo: null }),
]
/** 単元 13 の単元の構成と論点。論点は未と未理解だけで、理解だけに絞ると全部のまとまりで論点が残らない。 */
const NETWORK_STRUCTURE = {
  overview: '通信の決まりごとと、データが相手に届くまでの流れを学ぶ。',
  groups: [
    { no: 1, name: '通信の階層', description: '役割ごとに分けた通信の層と、層ごとの決まりごと。' },
    { no: 2, name: '住所と経路', description: '相手を指す番号と、そこまでの道筋の選び方。' },
  ],
}
const NETWORK = [
  row({ id: 601, term: 'プロトコル', questionCount: 3, frequencyTier: 3, status: 0, middle: 'ネットワーク', itemNo: 6, itemName: '通信プロトコル', groupNo: 1 }),
  row({ id: 602, term: 'ルーティング', questionCount: 2, frequencyTier: 2, status: 1, middle: 'ネットワーク', itemNo: 7, itemName: 'ネットワーク方式', groupNo: 2 }),
]
const ALL = [...SECURITY, ...SOFTWARE, ...NETWORK]
const TERMS = ALL.map((t) => t.term)
const STAGE_NAME: Record<Status, string> = { 0: '未', 1: '未理解', 2: 'やや理解', 3: '理解' }

let container: HTMLElement
let root: Root
let calls: string[]

const squash = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
const text = () => squash(container.textContent)
const topicRequests = () => calls.filter((u) => /\/topics\?/.test(u) || /\/topics$/.test(u))

/** path ごとに応答を決める偽の fetch。単元の構成は理解度の絞り込みに依らず返す（契約の structure）。 */
function stubApi() {
  calls = []
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    calls.push(url.pathname + url.search)
    const q = url.searchParams
    let body: unknown = {}
    if (url.pathname.endsWith('/fields')) body = FIELDS
    else if (url.pathname.endsWith('/categories')) body = CATEGORIES
    else if (url.pathname.endsWith('/topics')) {
      const middleNo = q.get('middleNo')
      const sort = q.get('sort') ?? 'structure'
      let rows = middleNo === '12' ? SECURITY : middleNo === '7' ? SOFTWARE : middleNo === '13' ? NETWORK : ALL
      const status = q.get('status')
      if (status !== null) {
        const chosen = new Set(status.split(',').filter(Boolean).map(Number))
        rows = rows.filter((t) => chosen.has(t.status))
      }
      const structure =
        sort !== 'structure' ? null : middleNo === '12' ? STRUCTURE : middleNo === '13' ? NETWORK_STRUCTURE : null
      body = { structure, topics: rows }
    } else if (/\/topics\/\d+$/.test(url.pathname)) body = {}
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

async function draw() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/topics']}>
        <Routes>
          <Route path="/topics" element={<Topics />} />
          <Route path="/topics/:id" element={<TopicDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

const CONTROLS = 'button, [role="button"], [role="checkbox"], [role="radio"], a, input[type="checkbox"], input[type="radio"]'
/** 読み上げに届く名前（aria-label、結び付いたラベル、無ければ見える文字）。 */
const nameOf = (el: Element) => {
  const aria = el.getAttribute('aria-label')
  if (aria) return squash(aria)
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) return squash([...labels].map((l) => l.textContent).join(' '))
  return squash(el.textContent)
}
const controls = () => [...container.querySelectorAll<HTMLElement>(CONTROLS)]

/** 名前が一致する操作を先に選び、無ければ含む操作を押す。 */
async function press(name: string | RegExp) {
  const hit = (el: Element) => (typeof name === 'string' ? nameOf(el).includes(name) : name.test(nameOf(el)))
  const els = controls().filter(hit)
  const target = (typeof name === 'string' ? els.find((el) => nameOf(el) === name) : undefined) ?? els[0]
  if (!target) throw new Error(`「${name}」の操作が画面に無い`)
  await act(async () => {
    target.click()
  })
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

/** 理解度の絞り込みの選択肢（名前が段階の名前だけを指し、論点の名前を含まない押せる物）。 */
const filterOf = (stage: string) =>
  controls().find((el) => stageIn(nameOf(el)) === stage && !TERMS.some((t) => nameOf(el).includes(t)))
async function toggle(stage: string) {
  const el = filterOf(stage)
  if (!el) throw new Error(`理解度の絞り込みに「${stage}」の選択肢が無い`)
  await act(async () => {
    el.click()
  })
}

/** 見出しに使う語（まとまりの名前と説明、全体像）。論点の行を広げるときの止まり所。 */
const HEADINGS = [STRUCTURE.overview, ...STRUCTURE.groups.flatMap((g) => [g.name, g.description])]

/** 該当する論点が無いことを示す文（REQ-028 のテストと同じ語の幅で読む）。 */
const NO_TOPICS = /該当する論点|論点が(ありません|無い|ない|見つかりません)/

/** 論点の一覧の 1 行: 論点名を持つ最も内側の要素から、ほかの論点名と見出しを含まない限り外へ広げた範囲。 */
function rowOf(term: string): string {
  const others = TERMS.filter((t) => t !== term)
  const els = [...container.querySelectorAll<HTMLElement>('*')].filter(
    (el) => squash(el.textContent).includes(term) && ![...el.children].some((c) => squash(c.textContent).includes(term)),
  )
  let el = els[els.length - 1]
  if (!el) throw new Error(`論点「${term}」が一覧に出ていない`)
  while (el.parentElement && el.parentElement !== container) {
    const up = squash(el.parentElement.textContent)
    if (others.some((o) => up.includes(o)) || HEADINGS.some((h) => up.includes(h))) break
    el = el.parentElement
  }
  const labels = [el, ...el.querySelectorAll('[aria-label], [title]')]
    .map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`)
    .join(' ')
  return squash(`${el.textContent ?? ''} ${labels}`)
}
/** 行に添えた出題回数の印の段（★ の連なりの最長。無ければ 0）。 */
const tierIn = (t: string) => Math.max(0, ...(t.match(/★+/g) ?? []).map((s) => s.length))

/** 画面の文字の中で、前の語より後ろに次の語が現れる（並びの確認）。 */
function expectInOrder(words: string[], message: string) {
  const t = text()
  let from = -1
  for (const w of words) {
    const at = t.indexOf(w, from + 1)
    expect(at, `${message}: 「${w}」が前の語より後ろに無い`).toBeGreaterThan(from)
    from = at
  }
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  invalidateCached()
  stubApi()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('単元を選んだときの論点の一覧（UC-002）', () => {
  // @covers REQ-474#shown-as-received
  it('単元を選ぶと、単元の構成の並びを求め、返った並びのまま示して出題頻度の順に並べ替えない', async () => {
    await draw()
    await press('セキュリティ')
    const last = topicRequests().at(-1)
    expect(last, '単元の論点を取りに行っていない').toBeTruthy()
    const params = new URL(last!, 'http://localhost').searchParams
    expect(params.get('middleNo')).toBe('12')
    const sort = params.get('sort')
    expect(sort === null || sort === 'structure', `単元の構成の並びでない並べ替えを求めている（sort=${sort}）`).toBe(true)
    expectInOrder(
      SECURITY.map((t) => t.term),
      '論点が返った並び（単元の構成の順）で示されていない',
    )
  })

  // @covers REQ-474#frequency-and-status-shown
  it('論点ごとに、出題頻度の数と、理解度の段階の名前（資格対策は未を含む）を添える', async () => {
    await draw()
    await press('セキュリティ')
    for (const t of SECURITY) {
      const r = rowOf(t.term)
      expect(r, `「${t.term}」の行に出題頻度 ${t.questionCount} が出ていない`).toMatch(
        new RegExp(`(^|\\D)${t.questionCount}(\\D|$)`),
      )
      expect(stageIn(r), `「${t.term}」の行の理解度が「${STAGE_NAME[t.status]}」でない（行: ${r}）`).toBe(STAGE_NAME[t.status])
    }
  })
})

describe('理解度の絞り込みを選び直したとき（UC-002）', () => {
  // @covers REQ-021#order-kept
  it('絞り込みを選び直しても、単元の構成の並びを求めたまま、残った論点を返った並びで示す', async () => {
    await draw()
    await press('セキュリティ')
    await toggle('理解')
    const last = topicRequests().at(-1)!
    const sort = new URL(last, 'http://localhost').searchParams.get('sort')
    expect(sort === null || sort === 'structure', `選び直したあと並べ替えが変わった（sort=${sort}）`).toBe(true)
    expect(text(), '外した理解の論点が残っている').not.toContain('ディジタル署名')
    expectInOrder(['共通鍵暗号方式', '公開鍵暗号方式', 'SQL インジェクション', 'ファイアウォール'], '残った論点の並びが崩れた')
  })

  // @covers REQ-021#unanswered-selectable
  it('理解度の絞り込みで未だけを選ぶと、未の論点だけを求めて示す', async () => {
    await draw()
    await press('セキュリティ')
    for (const stage of ['未理解', 'やや理解', '理解']) await toggle(stage)
    const status = new URL(topicRequests().at(-1)!, 'http://localhost').searchParams.get('status') ?? ''
    expect(new Set(status.split(',').filter(Boolean).map(Number)), `未だけを求めていない（status=${status}）`).toEqual(new Set([0]))
    expect(text()).toContain('SQL インジェクション')
    expect(text()).toContain('ファイアウォール')
    for (const term of ['共通鍵暗号方式', '公開鍵暗号方式', 'ディジタル署名'])
      expect(text(), `未でない「${term}」が残っている`).not.toContain(term)
  })
})

describe('単元の構成を持つ単元の論点の一覧（UC-002）', () => {
  // @covers REQ-475#overview-first
  it('一覧の先頭に、その単元の全体像を示す', async () => {
    await draw()
    await press('セキュリティ')
    expectInOrder(
      [STRUCTURE.overview, STRUCTURE.groups[0].name, SECURITY[0].term],
      '全体像がまとまりの見出しと論点より前に示されていない',
    )
  })

  // @covers REQ-475#group-headings
  it('論点をまとまりごとに束ね、まとまりの名前と説明を各まとまりの見出しとして、その論点より前に示す', async () => {
    await draw()
    await press('セキュリティ')
    const [g1, g2] = STRUCTURE.groups
    expectInOrder(
      [g1.name, g1.description, '共通鍵暗号方式', '公開鍵暗号方式', 'ディジタル署名', g2.name, g2.description, 'SQL インジェクション', 'ファイアウォール'],
      'まとまりの見出しの下に、そのまとまりの論点が束ねられていない',
    )
  })
})

describe('単元の構成を持たない単元の論点の一覧（UC-002）', () => {
  // @covers REQ-476#item-headings
  it('論点の一覧を空にせず、論点を小項目ごとに束ねて、小項目の名前を各見出しとしてその論点より前に示す', async () => {
    await draw()
    await press('ソフトウェア')
    expectInOrder(
      ['オペレーティングシステム', 'インタプリタ', 'コンパイラ', 'リンカ', 'ファイルシステム', 'ジャーナリング'],
      '小項目の見出しの下に、その小項目の論点が束ねられていない',
    )
  })

  // @covers REQ-476#no-overview
  it('構成を持つ単元から戻って構成を持たない単元を選ぶと、前の単元の全体像とまとまりの見出しを示さない', async () => {
    await draw()
    await press('セキュリティ')
    expect(text()).toContain(STRUCTURE.overview)
    await press(/戻る/)
    await press('ソフトウェア')
    expect(text()).toContain('インタプリタ')
    expect(text(), '構成を持たない単元に全体像が出ている').not.toContain(STRUCTURE.overview)
    for (const g of STRUCTURE.groups) expect(text(), `構成を持たない単元にまとまり「${g.name}」が出ている`).not.toContain(g.name)
  })
})

describe('絞り込みで論点が残らない見出し（UC-002）', () => {
  // @covers REQ-477#empty-group-hidden
  it('理解度の絞り込みで論点が 1 つも残らないまとまりは、名前と説明の見出しを示さない', async () => {
    await draw()
    await press('セキュリティ')
    // まとまり 2 の論点はどちらも未。未を外すとまとまり 2 に論点が残らない
    await toggle('未')
    const [g1, g2] = STRUCTURE.groups
    expect(text(), '論点の残るまとまりの見出しが消えた').toContain(g1.name)
    expect(text(), '論点の残らないまとまりの名前が出ている').not.toContain(g2.name)
    expect(text(), '論点の残らないまとまりの説明が出ている').not.toContain(g2.description)
  })

  // @covers REQ-477#empty-item-hidden
  it('単元の構成を持たない単元では、論点が 1 つも残らない小項目の名前の見出しを示さない', async () => {
    await draw()
    await press('ソフトウェア')
    expect(text()).toContain('ファイルシステム')
    // 小項目「ファイルシステム」の論点は理解だけ。理解を外すとその小項目に論点が残らない
    await toggle('理解')
    expect(text(), '論点の残る小項目の見出しが消えた').toContain('オペレーティングシステム')
    expect(text(), '論点の残らない小項目の見出しが出ている').not.toContain('ファイルシステム')
  })
})

describe('絞り込みですべての見出しに論点が残らないとき（UC-002）', () => {
  // @covers REQ-477#all-groups-empty-overview-kept
  it('単元の構成を持つ単元で、すべてのまとまりで論点が残らないときは、全体像を残し、まとまりの見出しを示さず、該当する論点が無いことを示す', async () => {
    await draw()
    await press('ネットワーク')
    expect(text()).toContain('プロトコル')
    expect(text(), '絞り込む前から該当する論点が無い旨が出ている').not.toMatch(NO_TOPICS)
    // 理解だけを残す（この単元に理解の論点は無い）
    for (const stage of ['未', '未理解', 'やや理解']) await toggle(stage)
    const status = new URL(topicRequests().at(-1)!, 'http://localhost').searchParams.get('status') ?? ''
    expect(new Set(status.split(',').filter(Boolean).map(Number)), `理解だけを求めていない（status=${status}）`).toEqual(new Set([3]))
    expect(text(), '全体像が残っていない').toContain(NETWORK_STRUCTURE.overview)
    for (const g of NETWORK_STRUCTURE.groups) expect(text(), `論点の残らないまとまり「${g.name}」の見出しが出ている`).not.toContain(g.name)
    expect(text(), '該当する論点が無いことが示されていない').toMatch(NO_TOPICS)
  })

  // @covers REQ-477#all-items-empty-no-topics-shown
  it('単元の構成を持たない単元で、すべての小項目で論点が残らないときは、小項目の見出しを示さず、該当する論点が無いことを示す', async () => {
    await draw()
    await press('ソフトウェア')
    expect(text(), '絞り込む前から該当する論点が無い旨が出ている').not.toMatch(NO_TOPICS)
    // やや理解だけを残す（この単元にやや理解の論点は無い）
    for (const stage of ['未', '未理解', '理解']) await toggle(stage)
    expect(text(), '論点の残らない小項目の見出しが出ている').not.toContain('オペレーティングシステム')
    expect(text(), '論点の残らない小項目の見出しが出ている').not.toContain('ファイルシステム')
    expect(text(), '該当する論点が無いことが示されていない').toMatch(NO_TOPICS)
  })
})

describe('論点の一覧の出題回数の印（UC-002）', () => {
  // @covers REQ-478#mark-on-list-row
  it('論点の一覧の行の出題頻度に、印の段の数だけ ★ を添え、段の無い論点には添えない', async () => {
    await draw()
    await press('セキュリティ')
    for (const t of SECURITY)
      expect(tierIn(rowOf(t.term)), `「${t.term}」の行の出題回数の印の段が違う`).toBe(t.frequencyTier ?? 0)
  })
})

/** 単元 middleNo の論点の一覧の応答だけを、release を呼ぶまで返さない偽の fetch（ほかは stubApi のまま）。 */
function holdTopicsOf(middleNo: string) {
  const inner = fetch
  let release: () => void = () => {
    throw new Error(`単元 ${middleNo} の論点の一覧を取りに行っていない`)
  }
  let held = false
  let delivered = false
  vi.stubGlobal('fetch', (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const res = inner(raw)
    if (held || !url.pathname.endsWith('/topics') || url.searchParams.get('middleNo') !== middleNo) return res
    held = true
    return new Promise((resolve) => {
      release = () => {
        delivered = true
        resolve(res)
      }
    })
  })
  return async () => {
    await act(async () => {
      release()
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
    expect(delivered, `単元 ${middleNo} の保留の応答を返せていない`).toBe(true)
  }
}

/** 構成を持つ単元（セキュリティ）の応答を保留にしたまま戻り、構成を持たない単元（ソフトウェア）を開いて示させたあと、保留の応答を返す。 */
async function lateResponseOfStructuredUnit() {
  const releaseSecurity = holdTopicsOf('12')
  await draw()
  await press('セキュリティ')
  expect(text(), '保留にした応答の全体像が、返す前から出ている').not.toContain(STRUCTURE.overview)
  await press(/戻る/)
  await press('ソフトウェア')
  expect(text(), '後から開いた単元の論点が示されていない').toContain('インタプリタ')
  await releaseSecurity()
}

describe('前の単元の応答が、次の単元へ移ったあとに遅れて返ったとき（UC-002）', () => {
  // @covers REQ-476#no-overview-after-late-response
  it('構成を持つ単元の応答が、構成を持たない単元を示したあとに返っても、全体像とまとまりの見出しを示さない', async () => {
    await lateResponseOfStructuredUnit()
    expect(text(), '構成を持たない単元に前の単元の全体像が出ている').not.toContain(STRUCTURE.overview)
    for (const g of STRUCTURE.groups) expect(text(), `構成を持たない単元にまとまり「${g.name}」が出ている`).not.toContain(g.name)
  })

  // @covers REQ-474#selected-unit-only-after-late-response
  it('前の単元の応答が遅れて返っても、後から選んだ単元に属する論点だけを示し続ける', async () => {
    await lateResponseOfStructuredUnit()
    for (const t of SOFTWARE) expect(text(), `後から選んだ単元の論点「${t.term}」が消えた`).toContain(t.term)
    for (const t of SECURITY) expect(text(), `前の単元の論点「${t.term}」が出ている`).not.toContain(t.term)
  })
})
