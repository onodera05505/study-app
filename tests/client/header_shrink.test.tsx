// @vitest-environment jsdom
/** 上部のヘッダー（src/client/App.tsx）の縮みと戻り（BR-046）。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、対象ごとに読み込み直して描く。
 *  資格対策とロードマップ型の対象の集合は登録簿（src/shared/targets.json の kind）だけから作る。
 *  見た目の大きさ（px）は見ない。縮んだかどうかは、観測できる形（要素が無い・hidden・aria-hidden・inert・
 *  インラインの display / visibility）で、タブの段の外の文字と導線が見えなくなることで見る。
 *  ヘッダーは banner の目印（header か role="banner"）、タブの段はその中の navigation の目印で探す。
 *  読み位置は window の scrollY を変えて scroll を起こすことで与える。
 *  画面の幅は、タブの段が別の段に並ぶか（ヘッダーの中の要素の上端の位置 getBoundingClientRect）と、
 *  window.innerWidth と、その幅で評価する matchMedia（min-width / max-width）と、resize の知らせで与える。
 *  jsdom にはレイアウトが無いので位置は差し替え、狭い画面は 360、広い画面は 1440 の両端の幅で与える。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import targets from '../../src/shared/targets.json'

const REGISTRY = targets as unknown as Record<string, { kind?: string; brand?: string }>
const kindOf = (kind: string) =>
  Object.entries(REGISTRY)
    .filter(([id, v]) => !id.startsWith('_') && v && v.kind === kind)
    .map(([id]) => id)
const EXAM_TARGETS = kindOf('exam')
const ROADMAP_TARGETS = kindOf('roadmap')

/** 状態になるまで待つ上限（並行して別の検査が走って遅い時も足りる長さ）。 */
const WAIT = { timeout: 5000, interval: 20 }
/** 1 本のテストの上限（対象の全画面を読み込み直して描くので既定の 5 秒では足りないことがある）。 */
const TEST_TIMEOUT = 60_000

const NARROW = 360
const WIDE = 1440
const USER_NAME = '学ぶ人'

const ME = {
  user: { id: 'u-1', name: USER_NAME, role: 'MEMBER' },
  topics: { total: 1, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-11-09', streak: 1, longest: 1, total: 1 },
}

const UNITS = [
  {
    id: 101,
    term: '1 日目の単位の名前',
    subtitle: null,
    questionCount: 2,
    status: null,
    field: '業界と仕事',
    middle: 'コンサルの仕事',
    itemName: 'コンサルの仕事',
    isNew: 0,
    sortOrder: 1,
    round: null,
    roundLabel: null,
    tier: null,
  },
]

function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    let body: unknown = {}
    if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://portal.example', app: 'ip' }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/topics')) body = { topics: UNITS }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

/** 端末の条件（画面の幅と動きを減らす設定）。matchMedia はこれで評価する。 */
const device = { width: NARROW, reduce: false }
type Mql = {
  matches: boolean
  media: string
  onchange: ((e: { matches: boolean; media: string }) => void) | null
  listeners: Set<(e: { matches: boolean; media: string }) => void>
}
let mqls: Mql[] = []

/** 1 つの条件（括弧 1 組）を今の端末で評価する。知らない条件は一致しないとする。 */
function evalFeature(f: string): boolean {
  const m = f.match(/^\(\s*(min|max)-width\s*:\s*([\d.]+)\s*(px|em|rem)?\s*\)$/)
  if (m) {
    const px = Number(m[2]) * (m[3] === 'em' || m[3] === 'rem' ? 16 : 1)
    return m[1] === 'min' ? device.width >= px : device.width <= px
  }
  const r = f.match(/^\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)$/)
  if (r) return r[1] === 'reduce' ? device.reduce : !device.reduce
  return false
}

/** メディア問い合わせ（「,」は または、「and」は かつ、先頭の not は否定）を今の端末で評価する。 */
function evalQuery(q: string): boolean {
  return q.split(',').some((part) => {
    let s = part.trim()
    const neg = /^not\s+/i.test(s)
    s = s.replace(/^not\s+/i, '').replace(/^(only\s+)?(screen|all)\s*(and\s*)?/i, '')
    const ok = s === '' ? true : s.split(/\s+and\s+/i).every((f) => evalFeature(f.trim()))
    return neg ? !ok : ok
  })
}

function stubDevice() {
  mqls = []
  vi.stubGlobal('matchMedia', (query: string) => {
    const mql: Mql & Record<string, unknown> = {
      matches: evalQuery(query),
      media: query,
      onchange: null,
      listeners: new Set(),
      addListener: (fn: Mql['onchange']) => fn && mql.listeners.add(fn),
      removeListener: (fn: Mql['onchange']) => fn && mql.listeners.delete(fn),
      addEventListener: (_: string, fn: Mql['onchange']) => fn && mql.listeners.add(fn),
      removeEventListener: (_: string, fn: Mql['onchange']) => fn && mql.listeners.delete(fn),
      dispatchEvent: () => false,
    }
    mqls.push(mql)
    return mql
  })
  Object.defineProperty(window, 'innerWidth', { value: device.width, configurable: true })
  stubLayout()
}

/** ヘッダーの段の高さ（位置の差し替えに使う。どちらの判定にも曖昧でない値）。 */
const ROW = 48

const rect = (top: number, height: number, width: number) =>
  ({ x: 0, y: top, top, left: 0, right: width, bottom: top + height, width, height, toJSON: () => ({}) }) as DOMRect

/** jsdom は位置を持たないので、ヘッダーの中の要素の上端の位置を差し替える。
 *  狭い画面: タブの段（navigation）はヘッダーの上端から ROW 下（ヘッダーの高さ 2 ROW の半分）の別の段。
 *  広い画面: タブの段も学びの名前・アカウントも同じ上端（同じ段）。ヘッダーの外の要素は 0。 */
function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const w = device.width
    const banner = this.closest('header, [role="banner"]')
    if (!banner) return rect(0, 0, 0)
    const twoRows = w < 768
    if (this === banner) return rect(0, twoRows ? 2 * ROW : ROW, w)
    const nav = banner.querySelector('nav, [role="navigation"]')
    if (nav && (nav === this || nav.contains(this))) return rect(twoRows ? ROW : 0, ROW, nav === this ? w : 80)
    return rect(0, ROW, this.contains(nav as Node) ? w : 120)
  })
}

/** 端末の条件を変え、変わった問い合わせに change を、幅が変われば resize を送る。 */
function applyDevice() {
  Object.defineProperty(window, 'innerWidth', { value: device.width, configurable: true })
  for (const m of mqls) {
    const now = evalQuery(m.media)
    if (now === m.matches) continue
    m.matches = now
    const e = { matches: now, media: m.media }
    m.onchange?.(e)
    for (const fn of m.listeners) fn(e)
  }
  window.dispatchEvent(new Event('resize'))
}

/** name を持つトークン（画面は中身だけを見る）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** 観測できる形で隠れているか（文書に無い・hidden・aria-hidden・inert・インラインの display / visibility）。 */
function isHidden(el: Element, host: Element): boolean {
  if (!host.contains(el)) return true
  for (let e: Element | null = el; e && e !== host.parentElement; e = e.parentElement) {
    if (e.hasAttribute('hidden') || e.hasAttribute('inert')) return true
    if (e.getAttribute('aria-hidden') === 'true') return true
    const st = (e as HTMLElement).style
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return true
  }
  return false
}

type View = Awaited<ReturnType<typeof drawApp>>

/** 開いている描画。テストが途中で落ちても afterEach で必ず片付ける（古い描画が window の知らせを拾い続けないように）。 */
const openViews = new Set<{ close: () => Promise<void> }>()

/** 読み位置を 0 に戻す。 */
function resetScroll() {
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
  Object.defineProperty(window, 'pageYOffset', { value: 0, configurable: true })
  document.documentElement.scrollTop = 0
}

/** 対象を決めて App を描く。 */
/** いま走っているテストの印。afterEach で取り替える。上限時間で打ち切られたテストの続き（非同期の残り）が
 *  次のテストの最中に対象の差し替え・読み込み直し・描画・読み位置や幅の変更をしないよう、印が古ければ止める。 */
let currentRun = {}

function guardOf(run: object) {
  return () => {
    if (run !== currentRun) throw new Error('打ち切られたテストの続きなので止める')
  }
}

async function drawApp(exam: string, entry: string) {
  const guard = guardOf(currentRun)
  guard()
  vi.stubEnv('VITE_EXAM', exam)
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const api = await import('../../src/client/lib/api')
  api.setToken(jwtWith({ sub: 'u-1', name: USER_NAME, role: 'MEMBER' }))
  const { App } = await import('../../src/client/App')
  guard()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(App)))
  })

  const banner = () => host.querySelector('header, [role="banner"]')
  const tabRow = () => banner()?.querySelector('nav, [role="navigation"]') ?? null
  const inTabRow = (el: Element) => {
    const nav = tabRow()
    return !!nav && (nav === el || nav.contains(el) || el.contains(nav))
  }
  /** タブの段の項目（文字と行き先）のうち見えているもの。 */
  const tabs = () =>
    [...(tabRow()?.querySelectorAll('a') ?? [])]
      .filter((a) => !isHidden(a, host))
      .map((a) => `${(a.textContent ?? '').trim()} -> ${a.getAttribute('href') ?? ''}`)
  /** タブの段の外にある、ヘッダーの見えている文字と導線。 */
  const outsideTabs = () => {
    const b = banner()
    if (!b) return []
    return [...b.querySelectorAll('*')]
      .filter((el) => !inTabRow(el))
      .filter((el) => el.tagName === 'A' || (el.children.length === 0 && (el.textContent ?? '').trim() !== ''))
      .filter((el) => !isHidden(el, host))
      .map((el) => (el.tagName === 'A' ? `導線 ${el.getAttribute('href') ?? ''} ` : '') + (el.textContent ?? '').trim())
  }
  /** タブの段の外の、フォーカスを受けられる部品。 */
  const outsideFocusables = () =>
    [...(banner()?.querySelectorAll<HTMLElement>('a[href], button, summary, input, select, [tabindex]') ?? [])].filter(
      (el) => !inTabRow(el) && !isHidden(el, host) && el.getAttribute('tabindex') !== '-1',
    )
  /** アカウントのメニューを開く操作（タブの段の外で、利用者の名前を持つか、メニューを開くと名乗る押せる部品）。 */
  const accountOpener = () =>
    [...(banner()?.querySelectorAll<HTMLElement>('button, summary, [role="button"]') ?? [])].find(
      (el) =>
        !inTabRow(el) &&
        ((el.textContent ?? '').includes(USER_NAME) ||
          (el.getAttribute('aria-label') ?? '').includes('アカウント') ||
          el.hasAttribute('aria-haspopup')),
    ) ?? null
  /** アカウントのメニューが開いているか（押した部品の aria-expanded か、包む details の open で見る）。 */
  const accountOpen = () => {
    const o = accountOpener()
    if (!o) return false
    if (o.getAttribute('aria-expanded') === 'true') return true
    const d = o.closest('details')
    return !!d && d.hasAttribute('open')
  }

  /** 起こした知らせの処理が終わるまで待つ。時間ではなく順番で待つ（次の 2 フレームと、その後のタスク）。
   *  間引きにフレームやタスクを使う作りでも、知らせの後に予約された処理はこの間に必ず走る。 */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0))
    if (typeof window.requestAnimationFrame === 'function')
      await new Promise((r) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => r(null))))
    await new Promise((r) => setTimeout(r, 0))
  }
  const act = async (fn: () => void) => {
    guard()
    await React.act(async () => {
      fn()
      await settle()
    })
  }

  /** 読み位置を y にする（window の scrollY を変えて scroll を起こし、反映を待つ）。 */
  const scrollTo = async (y: number) => {
    guard()
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
    Object.defineProperty(window, 'pageYOffset', { value: y, configurable: true })
    document.documentElement.scrollTop = y
    await act(() => {
      window.dispatchEvent(new Event('scroll'))
      document.dispatchEvent(new Event('scroll'))
    })
  }

  /** 下へ読み進める（少しずつ下げて 600 まで）。 */
  const readDown = async () => {
    for (const y of [100, 200, 400, 600]) await scrollTo(y)
  }

  /** 画面の幅を変える。 */
  const resize = async (width: number) => {
    guard()
    device.width = width
    await act(() => applyDevice())
  }

  const view = {
    host,
    banner,
    tabRow,
    tabs,
    outsideTabs,
    outsideFocusables,
    accountOpener,
    accountOpen,
    act,
    scrollTo,
    readDown,
    resize,
    close: async () => {
      if (!openViews.has(view)) return
      openViews.delete(view)
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
  openViews.add(view)
  return view
}

/** 描いた直後のヘッダーが、縮む前の姿（学びの名前とタブの段が見える）になっていることを確かめる。 */
async function expectFull(v: View, where: string, target: string) {
  await vi.waitFor(() => expectFullNow(v, where, target), WAIT)
}

function expectFullNow(v: View, where: string, target: string) {
  expect(v.banner(), `${where} にヘッダー（header か role="banner"）が無い`).toBeTruthy()
  expect(v.tabRow(), `${where} のヘッダーにタブの段（navigation）が無い`).toBeTruthy()
  expect(v.tabs().length, `${where} のタブの段に項目が無い`).toBeGreaterThan(0)
  const brand = REGISTRY[target].brand ?? ''
  expect(v.outsideTabs().join(' / '), `${where} の縮む前のヘッダーに学びの名前「${brand}」が無い`).toContain(brand)
}

/** 縮んだ姿（タブの段の外が見えず、タブの段の項目と行き先は縮む前と同じ）になっていることを確かめる。 */
async function expectShrunk(v: View, where: string, tabsBefore: string[]) {
  await vi.waitFor(() => expectShrunkNow(v, where, tabsBefore), WAIT)
}

function expectShrunkNow(v: View, where: string, tabsBefore: string[]) {
  expect(v.outsideTabs(), `${where} で縮んでいない（タブの段の外が見えている）`).toEqual([])
  expect(v.tabs(), `${where} で縮んだあとのタブの段の項目か行き先が縮む前と違う`).toEqual(tabsBefore)
}

/** 縮む前の姿のままか、元の姿に戻っていることを確かめる。 */
async function expectFullAgain(v: View, where: string, full: string[], tabsBefore: string[]) {
  await vi.waitFor(() => expectFullAgainNow(v, where, full, tabsBefore), WAIT)
}

function expectFullAgainNow(v: View, where: string, full: string[], tabsBefore: string[]) {
  expect(v.outsideTabs(), `${where} で元の姿になっていない`).toEqual(full)
  expect(v.tabs(), `${where} でタブの段の項目か行き先が縮む前と違う`).toEqual(tabsBefore)
}

/** タブの段の行き先を、確かめる画面の集合にする（どの画面でも）。 */
async function screensOf(target: string): Promise<string[]> {
  const v = await drawApp(target, '/')
  const hrefs = [...(v.tabRow()?.querySelectorAll('a') ?? [])]
    .map((a) => a.getAttribute('href') ?? '')
    .filter((h) => h.startsWith('/'))
  await v.close()
  return [...new Set(['/', ...hrefs])]
}

/** 対象と画面を描き、縮む前の姿を確かめて、その姿を返す。 */
async function open(target: string, entry: string) {
  const v = await drawApp(target, entry)
  const where = `幅 ${device.width}${device.reduce ? '・動きを減らす設定' : ''} の ${target} の ${entry}`
  await expectFull(v, where, target)
  return { v, where, full: v.outsideTabs(), before: v.tabs() }
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  device.width = NARROW
  device.reduce = false
  resetScroll()
  stubApi()
  stubDevice()
})

afterEach(async () => {
  currentRun = {}
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  for (const v of [...openViews]) await v.close()
  resetScroll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** 狭い画面で下へ読み進めると縮む。タブの段の中にフォーカスがあっても縮む（D-2）。 */
async function checkNarrowShrinks(target: string) {
  for (const entry of await screensOf(target)) {
    const { v, where, before } = await open(target, entry)
    await v.readDown()
    await expectShrunk(v, where, before)
    await v.close()
  }
  const { v, where, before } = await open(target, '/')
  const tab = v.tabRow()!.querySelector<HTMLElement>('a')!
  await v.act(() => tab.focus())
  expect(document.activeElement, 'タブの段のリンクにフォーカスを置けていない（この検査は空振りになる）').toBe(tab)
  await v.readDown()
  await expectShrunk(v, `${where}（タブの段のリンクにフォーカス）`, before)
  await v.close()
}

/** 縮んだあと、直前の読み位置から少しでも上へ動くと戻る（600→595、D-1 の 600→604→601）。 */
async function checkNarrowRestores(target: string) {
  for (const entry of await screensOf(target)) {
    const { v, where, full, before } = await open(target, entry)
    await v.readDown()
    await expectShrunk(v, where, before)
    await v.scrollTo(595)
    await expectFullAgain(v, `${where}（600 から 595 へ上へ）`, full, before)
    await v.close()
  }
  const { v, where, full, before } = await open(target, '/')
  await v.readDown()
  await v.scrollTo(604)
  await expectShrunk(v, `${where}（600 から 604 へ下へ）`, before)
  await v.scrollTo(601)
  await expectFullAgain(v, `${where}（604 から 601 へ上へ）`, full, before)
  await v.close()
}

/** 広い画面では下へ読み進めても縮まない。 */
async function checkWideKeeps(target: string) {
  device.width = WIDE
  stubDevice()
  const { v, where, full, before } = await open(target, '/')
  await v.readDown()
  await expectFullAgain(v, `${where}（下へ読み進めた）`, full, before)
  await v.close()
}

/** 縮んでいる間に画面が広がると戻る。 */
async function checkWideningRestores(target: string) {
  const { v, where, full, before } = await open(target, '/')
  await v.readDown()
  await expectShrunk(v, where, before)
  await v.resize(WIDE)
  await expectFullAgain(v, `${where}（縮んだまま幅 ${WIDE} へ広がった）`, full, before)
  await v.close()
}

/** アカウントのメニューを開いている間は、下へ読み進めても縮まない。 */
async function checkAccountMenuKeeps(target: string) {
  const { v, where } = await open(target, '/')
  const opener = v.accountOpener()
  expect(opener, `${where} のヘッダーにアカウントのメニューを開く操作が無い`).toBeTruthy()
  await v.act(() => opener!.click())
  await vi.waitFor(
    () =>
      expect(v.accountOpen(), `${where} でアカウントのメニューが開いた形（aria-expanded か details の open）にならない`).toBe(
        true,
      ),
    WAIT,
  )
  const opened = v.outsideTabs()
  await v.readDown()
  expect(v.accountOpen(), `${where} で読み進めるとアカウントのメニューが閉じた`).toBe(true)
  expect(v.outsideTabs(), `${where} でアカウントのメニューを開いたまま読み進めると縮んだ`).toEqual(opened)
  await v.close()
}

/** タブの段の外の部品にフォーカスがある間は、下へ読み進めても縮まない。 */
async function checkOutsideFocusKeeps(target: string) {
  const { v, where, full, before } = await open(target, '/')
  const parts = v.outsideFocusables()
  expect(parts.length, `${where} のタブの段の外にフォーカスを受ける部品が無い（この検査は空振りになる）`).toBeGreaterThan(0)
  for (const part of parts) {
    await v.scrollTo(0)
    await v.act(() => part.focus())
    expect(document.activeElement, 'タブの段の外の部品にフォーカスを置けていない').toBe(part)
    await v.readDown()
    const name = (part.textContent ?? '').trim() || part.getAttribute('href') || part.tagName
    await expectFullAgain(v, `${where}（タブの段の外の「${name}」にフォーカスを置いて読み進めた）`, full, before)
    await v.act(() => part.blur())
  }
  await v.close()
}

/** 動きを減らす設定でも、狭い画面で縮みと戻りが切り替わる。 */
async function checkReducedMotion(target: string) {
  device.reduce = true
  stubDevice()
  const { v, where, full, before } = await open(target, '/')
  await v.readDown()
  await expectShrunk(v, where, before)
  await v.scrollTo(595)
  await expectFullAgain(v, `${where}（上へ）`, full, before)
  await v.close()
}

/** アカウントのメニューを開く。開いた形になるまで待つ。 */
async function openAccountMenu(v: View, where: string) {
  const opener = v.accountOpener()
  expect(opener, `${where} のヘッダーにアカウントのメニューを開く操作が無い`).toBeTruthy()
  await v.act(() => opener!.click())
  await vi.waitFor(
    () =>
      expect(v.accountOpen(), `${where} でアカウントのメニューが開いた形（aria-expanded か details の open）にならない`).toBe(
        true,
      ),
    WAIT,
  )
}

/** アカウントのメニューを閉じる。閉じ方は作りによるので、開く操作をもう一度押す・Esc・メニューの外を押す の順に試し、
 *  閉じた形になったところで止める。どれでも閉じなければ落とす（この検査が空振りにならないように）。 */
async function closeAccountMenu(v: View, where: string) {
  const tries: (() => void)[] = [
    () => v.accountOpener()?.click(),
    () => {
      const t = (document.activeElement as HTMLElement | null) ?? document.body
      for (const el of [t, document.body]) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }))
      }
    },
    () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
        document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    },
  ]
  for (const t of tries) {
    if (!v.accountOpen()) break
    await v.act(t)
  }
  expect(v.accountOpen(), `${where} でアカウントのメニューを閉じられない（この検査は空振りになる）`).toBe(false)
}

/** その場で何も動かさずに、知らせの処理が何巡か済むのを待つ（閉じた瞬間・外れた瞬間に遅れて縮む作りを拾う）。 */
async function idle(v: View) {
  for (let i = 0; i < 3; i++) await v.act(() => {})
}

/** 次に下へ読み進める（読み位置 600 から、さらに下へ）。 */
async function readFurtherDown(v: View) {
  for (const y of [700, 800]) await v.scrollTo(y)
}

/** Esc でアカウントのメニューを閉じる（フォーカスのある部品と文書の両方に送る）。閉じなければ落とす。 */
async function closeAccountMenuByEscape(v: View, where: string) {
  await v.act(() => {
    const t = (document.activeElement as HTMLElement | null) ?? document.body
    for (const el of t === document.body ? [document.body] : [t, document.body]) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }))
    }
  })
  expect(v.accountOpen(), `${where} で Esc を押してもアカウントのメニューが閉じない`).toBe(false)
}

/** メニューを開く部品にフォーカスを置いて開き、Esc で閉じて、フォーカスがその部品に残った状態にする。
 *  ブラウザでは押した部品にフォーカスが残るので、閉じたあとフォーカスがどこにも無ければ（メニューの項目が消えて
 *  body に落ちた）その部品へ戻して同じ状態を作る。ヘッダーの別の部品へ移っていれば落とす（この状態が作れない）。 */
async function openThenEscapeWithFocusOnOpener(v: View, where: string) {
  const opener = v.accountOpener()
  expect(opener, `${where} のヘッダーにアカウントのメニューを開く操作が無い`).toBeTruthy()
  await v.act(() => opener!.focus())
  expect(document.activeElement, `${where} でメニューを開く部品にフォーカスを置けていない`).toBe(opener)
  await openAccountMenu(v, where)
  await v.readDown()
  await closeAccountMenuByEscape(v, where)
  const now = v.accountOpener()!
  if (document.activeElement === document.body || document.activeElement === null) await v.act(() => now.focus())
  expect(document.activeElement, `${where} でメニューを閉じたあと、フォーカスがメニューを開く部品に無い`).toBe(now)
  return now
}

/** 狭い画面で、メニューを開いたまま読み進めたあとに閉じても、その瞬間には縮まず、次に下へ読み進めたときに縮む。
 *  閉じ方は、フォーカスを動かさずに閉じる（値の変種 1）と、メニューを開く部品にフォーカスを置いて開き Esc で閉じ、
 *  フォーカスがその部品に残る（値の変種 2。残ったフォーカスは縮むのを止めない）と、メニューの項目にフォーカスを
 *  移して Esc で閉じ、項目が消えてフォーカスがどこにも無くなる（値の変種 3。フォーカスを開く部品へ戻さない）。 */
async function checkMenuCloseWaits(target: string) {
  {
    const { v, where, full, before } = await open(target, '/')
    await openAccountMenu(v, where)
    await v.readDown()
    await closeAccountMenu(v, where)
    await idle(v)
    expectFullAgainNow(v, `${where}（メニューを開いたまま読み進め、閉じた瞬間）`, full, before)
    await readFurtherDown(v)
    await expectShrunk(v, `${where}（メニューを閉じたあと次に下へ読み進めた）`, before)
    await v.close()
  }
  {
    const { v, where, full, before } = await open(target, '/')
    await openThenEscapeWithFocusOnOpener(v, where)
    await idle(v)
    expectFullAgainNow(v, `${where}（メニューを開く部品から開いて Esc で閉じた瞬間）`, full, before)
    await readFurtherDown(v)
    await expectShrunk(v, `${where}（Esc で閉じ、メニューを開く部品にフォーカスが残ったまま次に下へ読み進めた）`, before)
    await v.close()
  }
  {
    const { v, where, full, before } = await open(target, '/')
    await openAccountMenu(v, where)
    const item = v.host.querySelector<HTMLElement>('[role="menuitem"]') ?? document.querySelector<HTMLElement>('[role="menuitem"]')
    expect(item, `${where} の開いたアカウントのメニューに項目（role="menuitem"）が無い（この変種は空振りになる）`).toBeTruthy()
    const itemName = (item!.textContent ?? '').trim() || item!.tagName
    await v.act(() => item!.focus())
    expect(document.activeElement, `${where} でメニューの項目「${itemName}」にフォーカスを置けていない`).toBe(item)
    await v.readDown()
    await closeAccountMenuByEscape(v, where)
    // フォーカスは開く部品へ戻さない（項目が消えてどこにも無くなった状態のまま見る）
    await idle(v)
    expectFullAgainNow(v, `${where}（メニューの項目「${itemName}」にフォーカスを置いて読み進め、Esc で閉じた瞬間）`, full, before)
    const active = document.activeElement
    const focusNote =
      active && active !== document.body
        ? `（閉じたあとフォーカスは「${(active.textContent ?? '').trim() || active.tagName}」にある）`
        : '（閉じたあとフォーカスはどこにも無い）'
    await readFurtherDown(v)
    await expectShrunk(v, `${where}（メニューの項目から Esc で閉じたあと次に下へ読み進めた）${focusNote}`, before)
    await v.close()
  }
}

/** 本文（画面の main の目印）の先頭にフォーカスがあるか。main そのものか、main の中で、それより前に
 *  見えている文字もフォーカスを受ける部品も無い要素なら先頭とする。 */
function focusAtBodyStart(v: View): { ok: boolean; why: string } {
  const main = v.host.querySelector<HTMLElement>('main, [role="main"]')
  if (!main) return { ok: false, why: '画面に本文の目印（main か role="main"）が無い' }
  const a = document.activeElement
  if (!a || a === document.body) return { ok: false, why: 'フォーカスがどこにも無い（失われた）' }
  if (a === main) return { ok: true, why: '' }
  if (!main.contains(a)) {
    const name = (a.textContent ?? '').trim() || a.tagName
    return { ok: false, why: `フォーカスが本文の外の「${name}」にある` }
  }
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n && n !== a; n = walker.nextNode()) {
    if (n.contains(a)) continue
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '' && !isHidden(n.parentElement!, v.host))
      return { ok: false, why: `フォーカスより前に本文の文字「${(n.textContent ?? '').trim().slice(0, 20)}」がある` }
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches('a[href], button, summary, input, select, textarea'))
      return { ok: false, why: 'フォーカスより前に本文のフォーカスを受ける部品がある' }
  }
  return { ok: true, why: '' }
}

/** 狭い画面で、メニューを閉じた後にメニューを開く部品に残ったフォーカスのまま次に下へ読み進めて縮むと、
 *  縮むと操作できなくなるその部品にあったフォーカスは本文の先頭へ移り、失われない。 */
async function checkFocusMovedToBodyStart(target: string) {
  const { v, where, before } = await open(target, '/')
  await openThenEscapeWithFocusOnOpener(v, where)
  await readFurtherDown(v)
  await expectShrunk(v, `${where}（メニューを開く部品にフォーカスが残ったまま下へ読み進めた）`, before)
  await vi.waitFor(() => {
    const r = focusAtBodyStart(v)
    expect(r.ok, `${where} で縮んだあと、フォーカスが本文の先頭に移っていない: ${r.why}`).toBe(true)
  }, WAIT)
  await v.close()
}

/** 狭い画面で、タブの段の外の部品にフォーカスを置いて読み進めたあとにフォーカスが外れても、その瞬間には縮まず、
 *  次に下へ読み進めたときに縮む。外れ方は、どこにもフォーカスが無くなる（全部品）と、タブの段の中へ移る（先頭の部品）。 */
async function checkOutsideBlurWaits(target: string) {
  const { v, where, full, before } = await open(target, '/')
  const count = v.outsideFocusables().length
  expect(count, `${where} のタブの段の外にフォーカスを受ける部品が無い（この検査は空振りになる）`).toBeGreaterThan(0)
  const ways: { label: string; leave: (part: HTMLElement) => void }[] = [
    { label: 'フォーカスを外した', leave: (part) => part.blur() },
    { label: 'タブの段のリンクへフォーカスを移した', leave: () => v.tabRow()?.querySelector<HTMLElement>('a')?.focus() },
  ]
  const cases = [
    ...Array.from({ length: count }, (_, i) => ({ i, way: ways[0] })),
    { i: 0, way: ways[1] },
  ]
  for (const { i, way } of cases) {
    await v.scrollTo(0)
    await expectFullAgain(v, `${where}（読み位置を先頭に戻した）`, full, before)
    const part = v.outsideFocusables()[i]
    expect(part, `${where} のタブの段の外の ${i + 1} 番目の部品が見つからない`).toBeTruthy()
    const name = (part.textContent ?? '').trim() || part.getAttribute('href') || part.tagName
    await v.act(() => part.focus())
    expect(document.activeElement, `タブの段の外の「${name}」にフォーカスを置けていない`).toBe(part)
    await v.readDown()
    await v.act(() => way.leave(part))
    expect(document.activeElement, `「${name}」から${way.label}つもりがフォーカスが残っている`).not.toBe(part)
    await idle(v)
    expectFullAgainNow(v, `${where}（「${name}」にフォーカスを置いて読み進め、${way.label}瞬間）`, full, before)
    await readFurtherDown(v)
    await expectShrunk(v, `${where}（「${name}」から${way.label}あと次に下へ読み進めた）`, before)
    await v.act(() => (document.activeElement as HTMLElement | null)?.blur?.())
  }
  await v.close()
}

/** 広い画面では、メニューを閉じても、タブの段の外の部品からフォーカスが外れても、次に下へ読み進めても縮まない。 */
async function checkWideCloseOrBlurKeeps(target: string) {
  device.width = WIDE
  stubDevice()
  const { v, where, full, before } = await open(target, '/')
  await openAccountMenu(v, where)
  await v.readDown()
  await closeAccountMenu(v, where)
  await idle(v)
  expectFullAgainNow(v, `${where}（メニューを閉じた瞬間）`, full, before)
  await readFurtherDown(v)
  await expectFullAgain(v, `${where}（メニューを閉じたあと下へ読み進めた）`, full, before)

  await v.scrollTo(0)
  const part = v.outsideFocusables()[0]
  expect(part, `${where} のタブの段の外にフォーカスを受ける部品が無い（この検査は空振りになる）`).toBeTruthy()
  await v.act(() => part.focus())
  await v.readDown()
  await v.act(() => part.blur())
  await idle(v)
  expectFullAgainNow(v, `${where}（タブの段の外の部品からフォーカスが外れた瞬間）`, full, before)
  await readFurtherDown(v)
  await expectFullAgain(v, `${where}（フォーカスが外れたあと下へ読み進めた）`, full, before)
  await v.close()
}

describe('資格対策の上部のヘッダーの縮みと戻り（UC-001）', () => {
  // 対象が無ければ下の検査が 1 本も作られず空振りになる
  if (!EXAM_TARGETS.length) throw new Error('登録簿に資格対策の対象が無い')

  for (const target of EXAM_TARGETS) {
    // @covers REQ-425#narrow-shrinks-on-reading-down
    it(`${target} の狭い画面では、どの画面でも下へ読み進めるとタブの段だけを残して縮み、タブの段の中のフォーカスは止めない`, async () => {
      await checkNarrowShrinks(target)
    }, TEST_TIMEOUT)

    // @covers REQ-425#narrow-restores-on-any-upward-move
    it(`${target} の狭い画面では、縮んだあと直前の読み位置から少しでも上へ動くと元に戻る`, async () => {
      await checkNarrowRestores(target)
    }, TEST_TIMEOUT)

    // @covers REQ-425#wide-does-not-shrink
    it(`${target} の広い画面では、下へ読み進めても縮まない`, async () => {
      await checkWideKeeps(target)
    }, TEST_TIMEOUT)

    // @covers REQ-425#widening-restores
    it(`${target} で縮んでいる間に画面が広がると元に戻る`, async () => {
      await checkWideningRestores(target)
    }, TEST_TIMEOUT)

    // @covers REQ-425#account-menu-open-keeps
    it(`${target} でアカウントのメニューを開いている間は、下へ読み進めても縮まない`, async () => {
      await checkAccountMenuKeeps(target)
    }, TEST_TIMEOUT)

    // @covers REQ-425#outside-focus-keeps
    it(`${target} でタブの段の外の部品にフォーカスがある間は、下へ読み進めても縮まない`, async () => {
      await checkOutsideFocusKeeps(target)
    }, TEST_TIMEOUT)

    // @covers REQ-425#reduced-motion-still-switches
    it(`${target} で動きを減らす設定でも、縮みと戻りが切り替わる`, async () => {
      await checkReducedMotion(target)
    }, TEST_TIMEOUT)

    // @covers REQ-431#menu-close-waits-for-next-read-down
    it(`${target} の狭い画面では、アカウントのメニューを閉じた瞬間には縮まず、次に下へ読み進めたときに縮む`, async () => {
      await checkMenuCloseWaits(target)
    }, TEST_TIMEOUT)

    // @covers REQ-431#focus-moved-to-body-start
    it(`${target} の狭い画面では、メニューを閉じた後に開く部品に残ったフォーカスのまま縮むと、フォーカスが本文の先頭へ移る`, async () => {
      await checkFocusMovedToBodyStart(target)
    }, TEST_TIMEOUT)

    // @covers REQ-431#outside-blur-waits-for-next-read-down
    it(`${target} の狭い画面では、タブの段の外の部品からフォーカスが外れた瞬間には縮まず、次に下へ読み進めたときに縮む`, async () => {
      await checkOutsideBlurWaits(target)
    }, TEST_TIMEOUT)

    // @covers REQ-431#wide-close-or-blur-keeps
    it(`${target} の広い画面では、メニューを閉じてもタブの段の外からフォーカスが外れても、そのあと下へ読み進めても縮まない`, async () => {
      await checkWideCloseOrBlurKeeps(target)
    }, TEST_TIMEOUT)
  }
})

describe('ロードマップ型の上部のヘッダーの縮みと戻り（UC-009）', () => {
  // 対象が無ければ下の検査が 1 本も作られず空振りになる
  if (!ROADMAP_TARGETS.length) throw new Error('登録簿にロードマップ型の対象が無い')

  for (const target of ROADMAP_TARGETS) {
    // @covers REQ-426#narrow-shrinks-on-reading-down
    it(`${target} の狭い画面では、どの画面でも下へ読み進めるとタブの段だけを残して縮み、タブの段の中のフォーカスは止めない`, async () => {
      await checkNarrowShrinks(target)
    }, TEST_TIMEOUT)

    // @covers REQ-426#narrow-restores-on-any-upward-move
    it(`${target} の狭い画面では、縮んだあと直前の読み位置から少しでも上へ動くと元に戻る`, async () => {
      await checkNarrowRestores(target)
    }, TEST_TIMEOUT)

    // @covers REQ-426#wide-does-not-shrink
    it(`${target} の広い画面では、下へ読み進めても縮まない`, async () => {
      await checkWideKeeps(target)
    }, TEST_TIMEOUT)

    // @covers REQ-426#widening-restores
    it(`${target} で縮んでいる間に画面が広がると元に戻る`, async () => {
      await checkWideningRestores(target)
    }, TEST_TIMEOUT)

    // @covers REQ-426#account-menu-open-keeps
    it(`${target} でアカウントのメニューを開いている間は、下へ読み進めても縮まない`, async () => {
      await checkAccountMenuKeeps(target)
    }, TEST_TIMEOUT)

    // @covers REQ-426#outside-focus-keeps
    it(`${target} でタブの段の外の部品にフォーカスがある間は、下へ読み進めても縮まない`, async () => {
      await checkOutsideFocusKeeps(target)
    }, TEST_TIMEOUT)

    // @covers REQ-426#reduced-motion-still-switches
    it(`${target} で動きを減らす設定でも、縮みと戻りが切り替わる`, async () => {
      await checkReducedMotion(target)
    }, TEST_TIMEOUT)

    // @covers REQ-432#menu-close-waits-for-next-read-down
    it(`${target} の狭い画面では、アカウントのメニューを閉じた瞬間には縮まず、次に下へ読み進めたときに縮む`, async () => {
      await checkMenuCloseWaits(target)
    }, TEST_TIMEOUT)

    // @covers REQ-432#focus-moved-to-body-start
    it(`${target} の狭い画面では、メニューを閉じた後に開く部品に残ったフォーカスのまま縮むと、フォーカスが本文の先頭へ移る`, async () => {
      await checkFocusMovedToBodyStart(target)
    }, TEST_TIMEOUT)

    // @covers REQ-432#outside-blur-waits-for-next-read-down
    it(`${target} の狭い画面では、タブの段の外の部品からフォーカスが外れた瞬間には縮まず、次に下へ読み進めたときに縮む`, async () => {
      await checkOutsideBlurWaits(target)
    }, TEST_TIMEOUT)

    // @covers REQ-432#wide-close-or-blur-keeps
    it(`${target} の広い画面では、メニューを閉じてもタブの段の外からフォーカスが外れても、そのあと下へ読み進めても縮まない`, async () => {
      await checkWideCloseOrBlurKeeps(target)
    }, TEST_TIMEOUT)
  }
})
