// @vitest-environment jsdom
/** UC-003「論点の理解度を記録して次に学ぶ論点を辿る」の主シナリオを
 *  1 本で実行する写し（正常系のみ。失敗系・境界は要件のテストが見る）。
 *
 *  事前条件（ログインして論点の画面を開いている）は、トークンを置いて単元の一覧から
 *  論点の画面まで辿ることで作る。
 *  画面の文字は用語集から採り、理解度の 3 段階は段階の名前「未理解／やや理解／理解」で探す。
 *  選ばれている段階は、色ではなく読み上げに届く選択の状態（押されている・選ばれている）で読む。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

const FIELDS = {
  fields: [
    { field: 'ストラテジ系', topics: 4, questions: 24, understood: 2, partly: 1, untouched: 1 },
  ],
}
const CATEGORIES = [
  { middleNo: 1, middle: '企業活動', major: '企業と法務', field: 'ストラテジ系', topics: 4, questions: 24, understood: 2 },
]

/** 記録した理解度（サーバの代わり。記録の後はこの段階を返す）。「やや理解」は 3 段階の 2 段目。 */
let recorded: number | null = null
const PARTLY = 2

/** 同じ単元の論点 2 つ。記録するのは損益分岐点で、もう 1 つは理解のまま（一覧の行を見分けるため）。 */
const OTHER_TERM = '固定費と変動費'
const TOPICS = [
  { id: 11, term: '損益分岐点', subtitle: null, questionCount: 9, status: recorded as number | null, field: 'ストラテジ系', middle: '企業活動', itemName: '会計と財務', isNew: 0, sortOrder: null },
  { id: 12, term: OTHER_TERM, subtitle: null, questionCount: 5, status: 3 as number | null, field: 'ストラテジ系', middle: '企業活動', itemName: '会計と財務', isNew: 0, sortOrder: null },
]

const detail = (id: number, term: string, next: unknown) => ({
  topic: {
    id,
    term,
    subtitle: null,
    explanation: `${term} の短い説明です。`,
    detail: `${term} の詳しい解説です。`,
    questionCount: 1,
    isNew: 0,
    status: recorded,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '企業活動',
    middleNo: 1,
    itemName: '会計と財務',
    syllabusItemId: 1,
  },
  questions: [],
  siblings: [],
  nextTopic: next,
  neighbors: { prev: null, next: null },
})

/** ホームのおすすめ（出題頻度が高く、まだ理解していない論点）。 */
const NEXT_TOPIC = { id: 555, term: '頻出の未理解の論点', questionCount: 88, field: 'ストラテジ系' }
const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 500, understood: 20, partly: 5 },
  recentSessions: [],
  nextTopics: [NEXT_TOPIC],
  visits: { today: '2026-09-29', streak: 7, longest: 9, total: 42 },
}

type Call = { url: string; method: string; body?: string }
let calls: Call[] = []
const countOf = (part: string) => calls.filter((c) => c.url.includes(part)).length

function stubApi() {
  calls = []
  recorded = null
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: url.pathname + url.search, method, body: init?.body ? String(init.body) : undefined })
    const p = url.pathname
    // 理解度の記録（PUT /api/topics/:id/progress）。以後はその段階を返す（上書き）
    if (method === 'PUT' && p.includes('/progress')) {
      recorded = PARTLY
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) }
    }
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/fields')) body = FIELDS
    else if (p.endsWith('/categories')) body = { categories: CATEGORIES }
    else if (p.endsWith('/topics/11')) body = detail(11, '損益分岐点', null)
    else if (p.endsWith('/topics/555'))
      body = detail(555, '頻出の未理解の論点', { id: 556, term: 'その次に学ぶ論点', questionCount: 6, field: 'ストラテジ系' })
    else if (p.endsWith('/topics')) body = { topics: TOPICS.map((t) => (t.id === 11 ? { ...t, status: recorded } : t)) }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

const text = () => (host.textContent ?? '').replace(/\s+/g, ' ')
const hrefs = () => [...host.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')

const CONTROLS = 'button, [role="button"], summary, a'
const hit = (el: Element, name: string | RegExp) => {
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return typeof name === 'string' ? t.includes(name) : name.test(t)
}
const controls = (name: string | RegExp) =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => hit(el, name))
async function press(name: string | RegExp) {
  const same = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === String(name)
  const els = controls(name)
  const target = (typeof name === 'string' ? els.find(same) : undefined) ?? els[0]
  if (!target) throw new Error(`「${name}」の操作が画面に無い`)
  await act(async () => {
    target.click()
  })
}

/** 理解度の 3 段階（用語集の段階の名前）。「理解」は他の 2 つに含まれるので、長いものから当てる。 */
const STAGES = ['未理解', 'やや理解', '理解']
const squash = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
const stageIn = (t: string) =>
  t.includes('やや理解') && !t.replace(/やや理解/g, '').includes('理解')
    ? 'やや理解'
    : t.includes('未理解') && !t.replace(/未理解/g, '').includes('理解')
      ? '未理解'
      : t.includes('理解') && !t.includes('未理解') && !t.includes('やや理解')
        ? '理解'
        : null
/** 操作の名前（読み上げで分かる名前を先に、無ければ見えている文字）。 */
const nameOf = (el: Element) => {
  const aria = el.getAttribute('aria-label')
  if (aria) return squash(aria)
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) return squash([...labels].map((l) => l.textContent).join(' '))
  return squash(el.textContent)
}
/** 理解度の操作: 選ぶと記録される段階の名前を持つ選択肢。 */
const STAGE_CONTROLS = 'button, [role="button"], [role="radio"], input[type="radio"]'
const stageButtons = () =>
  [...host.querySelectorAll<HTMLElement>(STAGE_CONTROLS)].filter((b) => stageIn(nameOf(b)) !== null)
async function pressStage(label: string) {
  const b = stageButtons().find((x) => stageIn(nameOf(x)) === label)
  if (!b) throw new Error(`理解度「${label}」の操作が画面に無い`)
  await act(async () => {
    b.click()
  })
}
/** 選ばれていることが色によらず分かる形（読み上げに届く選択の状態）を持つ選択肢か。 */
const isChosen = (el: HTMLElement) =>
  el.getAttribute('aria-pressed') === 'true' ||
  el.getAttribute('aria-checked') === 'true' ||
  el.getAttribute('aria-selected') === 'true' ||
  (el.getAttribute('aria-current') ?? 'false') !== 'false' ||
  (el instanceof HTMLInputElement && el.checked)
/** 今記録されている段階として示されている選択肢の段階の名前（いつも 1 つ）。 */
function selectedStage(): string {
  const els = stageButtons()
  if (els.length < STAGES.length)
    throw new Error('理解度の 3 段階（未理解・やや理解・理解）の操作が画面に無い')
  const marked = els.filter(isChosen)
  if (marked.length !== 1)
    throw new Error(
      `選ばれている段階が色によらず分かる形で ${marked.length} 個ある（1 個のはず）: ` +
        els.map((e) => `${nameOf(e)}=${isChosen(e)}`).join(' / '),
    )
  return stageIn(nameOf(marked[0]))!
}

/** 論点の一覧の 1 行: 論点名を持つ最も内側の要素から、ほかの論点名を含まない限り外へ広げた範囲。 */
function rowOf(term: string): HTMLElement {
  const others = TOPICS.map((t) => t.term).filter((t) => t !== term)
  const els = [...host.querySelectorAll<HTMLElement>('*')].filter(
    (el) => squash(el.textContent).includes(term) && ![...el.children].some((c) => squash(c.textContent).includes(term)),
  )
  let el = els[els.length - 1]
  if (!el) throw new Error(`論点「${term}」が一覧に出ていない`)
  while (el.parentElement && el.parentElement !== host) {
    if (others.some((o) => squash(el.parentElement!.textContent).includes(o))) break
    el = el.parentElement
  }
  return el
}

async function open(entry: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.history.replaceState({}, '', entry)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(App)))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  stubApi()
  setToken('token-for-scenario')
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

describe('UC-003 理解度を記録して、おすすめ順に学ぶ', () => {
  // @scenario UC-003
  it('論点の画面で理解度を記録し、集計を数え直させ、ホームと論点の画面のおすすめを辿る', async () => {
    // 事前条件: ログインしていて、単元の一覧から論点の画面を開いている（辿る導線は UC-002 の範囲）
    await open('/topics')
    await press('企業活動')
    await press('損益分岐点')
    expect(text(), '論点の画面が出ていない').toContain('損益分岐点 の短い説明です。')

    // step 1・3: 利用者が理解度（未理解／やや理解／理解）を選ぶ。システムは 3 段階のいずれかとして記録する
    await pressStage('やや理解')
    const puts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/progress'))
    expect(puts, '理解度が記録されていない（PUT /api/topics/:id/progress が無い）').toHaveLength(1)
    expect(puts[0].url).toContain('/api/topics/11/progress')
    expect(puts[0].body ?? '', '記録に理解度が入っていない').not.toBe('')

    // step 2: 記録の完了を待たずに、選ばれた段階を選ばれているものとして示す
    expect(selectedStage(), '押した段階が選ばれていない').toBe('やや理解')

    // step 4: 画面は覚えていた分野・単元の集計を捨て、次に一覧を開いたときに数え直させる
    const before = countOf('/api/fields')
    await press(/戻る/)
    expect(countOf('/api/fields'), '理解度を変えたのに集計を数え直していない').toBeGreaterThan(before)

    // step 4: 記録した理解度を論点の一覧の行で段階の名前で示す
    //（戻り先が単元の一覧のときは単元をもう一度選ぶ。UC はどちらの一覧に戻るかを決めていない）
    if (!controls('損益分岐点').length) await press('企業活動')
    expect(stageIn(squash(rowOf('損益分岐点').textContent)), '論点の一覧の行に記録した段階の名前が出ていない').toBe(
      'やや理解',
    )

    // step 4: 論点の画面で、理解度の操作は今記録されている段階の選択肢を色によらず見分けられる形で示す
    await press('損益分岐点')
    expect(
      stageButtons().map((b) => stageIn(nameOf(b))),
      '理解度の操作の選択肢が段階の名前（未理解・やや理解・理解）を持っていない',
    ).toEqual(STAGES)
    expect(selectedStage(), '今記録されている段階の選択肢が色によらず見分けられる形で示されていない').toBe('やや理解')

    // step 5・6: 利用者がホームを開く。システムは「出題頻度が高く、まだ理解していない論点」を返す
    await press('ホーム')
    expect(countOf('/api/me'), 'ホームがおすすめを取りに行っていない').toBeGreaterThan(0)

    // step 6: 画面はホームに「次に学ぶ」としてその候補を出す（論点名・出題回数・分野）
    expect(text()).toContain('次に学ぶ')
    expect(text()).toContain(NEXT_TOPIC.term)
    expect(text(), 'おすすめに出題回数が出ていない').toContain(String(NEXT_TOPIC.questionCount))
    expect(text(), 'おすすめに分野が出ていない').toContain(NEXT_TOPIC.field)
    expect(hrefs()).toContain(`/topics/${NEXT_TOPIC.id}`)

    // step 7・8: 利用者が示された論点を開く。画面はその論点の末尾にも次に学ぶ論点を出す
    await press(NEXT_TOPIC.term)
    expect(text(), 'おすすめの論点の画面へ移れていない').toContain('頻出の未理解の論点 の短い説明です。')
    expect(text()).toContain('次に学ぶ')
    expect(text()).toContain('その次に学ぶ論点')
    expect(hrefs()).toContain('/topics/556')

    // 事後条件: 理解度が本人の記録として残り、論点の画面に反映されている
    expect(recorded, '記録が残っていない').toBe(PARTLY)
  })
})
