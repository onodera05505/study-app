// @vitest-environment jsdom
/** App の外枠から見た新しい版の知らせ（UC-016）。
 *
 *  - 画面を移ったとき・見比べの間隔が過ぎたときに版の印を取り直して見比べる
 *  - 出た知らせは画面を移っても残り、間隔ごとの見比べを重ねても自動では読み直さない
 *  - 「更新」で読み直すと、読み直す前に覚えていた集計は捨てられて新しい版で取り直される
 *
 *  立ち上げ方は tests/client/update_bar.test.tsx と同じ（1 件ごとに resetModules、fetch は偽物）。
 *  version.json は「配信物に今置かれている印」を返し、テストの途中で差し替えると次の取得から効く
 *  （取得の回数に依らず、配信の前後を並べられる）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

let container: HTMLElement | null = null
let root: Root | null = null

/** 1 件ごとに読み直す（module が覚えている最初の印・集計・トークンを持ち越さない）。 */
let appMod!: typeof import('../../src/client/App')
let apiMod!: typeof import('../../src/client/lib/api')
let versionMod!: typeof import('../../src/client/lib/version')

const text = () => container?.textContent ?? ''

type Stamp = { build: string; at: string }
/** 開いたときの印と、配信された新しい版の印。 */
const A: Stamp = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
const B: Stamp = { build: 'def5678', at: '2026-09-28T09:00:00Z' }

const NOTICE = '新しい版があります。'

const SSO_CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
const ME = {
  user: { id: 'u-1', name: '寺田テスト', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

/** 配信物と API の今の中身。差し替えると次の取得から効く。 */
type World = { stamp: Stamp; fields: unknown }

/** 画面が取りに行く一覧は空で返す（中身はこの検査の対象ではない）。分野の集計だけ world から返す。 */
function apiBody(url: string, world: World): unknown {
  if (url.includes('/auth/config')) return SSO_CONFIG
  if (url.includes('/me')) return ME
  if (url.includes('/glossary')) return { glossary: [] }
  if (url.includes('/fields')) return world.fields
  if (url.includes('/categories')) return { categories: [] }
  if (url.includes('/exams')) return { exams: [] }
  if (url.includes('/sessions/current')) return { session: null }
  if (url.includes('/sessions')) return { sessions: [] }
  if (url.includes('/topics')) return { topics: [] }
  return {}
}

function stubFetch(world: World) {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    urls.push(u)
    const body = u.includes('version.json') ? world.stamp : apiBody(u, world)
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
  return {
    versionCalls: () => urls.filter((u) => u.includes('version.json')).length,
    fieldsCalls: () => urls.filter((u) => u.includes('/fields')).length,
  }
}

/** name を持つトークン（署名は読まない）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** 1 件ごとの立ち上げ。偽の fetch を置き、module を作り直して App と lib を読み直し、
 *  ログイン済みのトークンを入れる。返り値で取得の回数を数える。 */
async function start(world: World) {
  const stub = stubFetch(world)
  await loadModules()
  return stub
}

/** 画面の読み直し（module を作り直す）。App と同じ実体の lib を持つ。 */
async function loadModules() {
  vi.resetModules()
  appMod = await import('../../src/client/App')
  apiMod = await import('../../src/client/lib/api')
  versionMod = await import('../../src/client/lib/version')
  apiMod.setToken(jwtWith({ sub: 'u-1', name: '寺田テスト', role: 'MEMBER' }))
}

/** 描いたものを片付ける。 */
async function teardown() {
  if (root) {
    const r = root
    root = null
    await act(async () => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
}

/** 画面を開く（MemoryRouter は初期の場所しか見ないので、根ごと作り直して描く）。 */
async function open(entry: string) {
  await teardown()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(appMod.App)))
  })
}

/** 文字でリンクを探す。 */
function link(re: RegExp): HTMLAnchorElement | null {
  return ([...(container?.querySelectorAll('a') ?? [])].find((a) =>
    re.test((a.textContent ?? '').trim()),
  ) ?? null) as HTMLAnchorElement | null
}

/** 文字でボタンを探す。 */
function button(re: RegExp): HTMLButtonElement | null {
  return ([...(container?.querySelectorAll('button') ?? [])].find((b) =>
    re.test((b.textContent ?? '').trim()),
  ) ?? null) as HTMLButtonElement | null
}

async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** 画面を移る（上部メニューのリンクを押す）。 */
async function navigate(re: RegExp) {
  const nav = link(re)
  expect(nav, `上部メニューに ${re} のリンクが無い`).not.toBeNull()
  await click(nav!)
}

/** 偽の時計を ms だけ進める（間隔ごとの見比べが起き、取り直しの結果が画面に反映されるまで待つ）。 */
async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** 読み直し（location.reload）を数える。差し替え方は環境によるので通る手を順に試す。 */
function countReloads(): { n: number } {
  const state = { n: 0 }
  const reload = () => {
    state.n++
  }
  const fake = {
    href: 'http://localhost/',
    origin: 'http://localhost',
    pathname: '/',
    search: '',
    hash: '',
    reload,
    assign: () => {},
    replace: () => {},
    toString: () => 'http://localhost/',
  }
  vi.stubGlobal('location', fake)
  try {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: fake })
  } catch {
    try {
      vi.spyOn(window.location, 'reload').mockImplementation(reload)
    } catch {
      /* どちらも差し替えられない環境では、押しても数えられない */
    }
  }
  return state
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  await teardown()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('新しい版の帯（UC-016）', () => {
  // @covers REQ-229#on-navigate
  it('画面を移ったとき、版の印を取り直して覚えている印と見比べる', async () => {
    const world: World = { stamp: A, fields: { fields: [] } }
    const { versionCalls } = await start(world)
    await open('/')
    const before = versionCalls()
    expect(text()).not.toContain(NOTICE)

    // 配信後に画面を移る。取り直し（取得が増える）と見比べ（違いが知らせになる）の両方を見る
    world.stamp = B
    await navigate(/^学習$/)
    expect(versionCalls(), '画面を移っても版の印を取り直していない').toBeGreaterThan(before)
    expect(text(), '取り直した印を覚えている印と見比べていない').toContain(NOTICE)
  })

  // @covers REQ-230#interval-recheck
  it('画面を開いたまま見比べの間隔が過ぎると、版の印を取り直して覚えている印と見比べる', async () => {
    vi.useFakeTimers()
    const world: World = { stamp: A, fields: { fields: [] } }
    const { versionCalls } = await start(world)
    await open('/')
    const before = versionCalls()
    world.stamp = B

    // 間隔が過ぎる前は取り直さない
    await elapse(versionMod.CHECK_INTERVAL_MS - 1)
    expect(versionCalls(), '間隔が過ぎる前に取り直している').toBe(before)
    expect(text()).not.toContain(NOTICE)

    // 間隔が過ぎたら取り直して見比べる
    await elapse(1)
    expect(versionCalls(), '間隔が過ぎても版の印を取り直していない').toBeGreaterThan(before)
    expect(text(), '取り直した印を覚えている印と見比べていない').toContain(NOTICE)
  })

  // @covers REQ-234#notice-persists-across-navigation
  it('知らせが出たまま画面を移っても、読み直しを選ぶまで知らせは残る', async () => {
    const world: World = { stamp: A, fields: { fields: [] } }
    await start(world)
    await open('/')
    world.stamp = B
    await navigate(/^学習$/)
    expect(text()).toContain(NOTICE)

    // 次に移ったときの取り直しが開いたときの印と同じでも、出た知らせは消えない
    world.stamp = A
    await navigate(/フィードバック/)
    expect(text(), '画面を移ると知らせが消える').toContain(NOTICE)
    expect(button(/^更新$/), '画面を移ると「更新」が消える').not.toBeNull()
  })

  // @covers REQ-235#stay-without-reload
  it('知らせが出たまま見比べの間隔が過ぎても、読み直しを選ばないかぎり画面を読み直さない', async () => {
    vi.useFakeTimers()
    const world: World = { stamp: A, fields: { fields: [] } }
    const { versionCalls } = await start(world)
    const reloads = countReloads()
    await open('/')
    world.stamp = B
    await navigate(/^学習$/)
    expect(text()).toContain(NOTICE)
    const shown = versionCalls()

    // 間隔ごとの見比べを 2 回重ねる（取り直しは続くが、読み直しは起きない）
    await elapse(versionMod.CHECK_INTERVAL_MS * 2)
    expect(versionCalls(), '知らせが出たあと間隔ごとの取り直しが止まっている').toBeGreaterThan(shown)
    expect(reloads.n, '読み直しを選んでいないのに読み直している').toBe(0)
    expect(text()).toContain(NOTICE)
  })

  // @covers REQ-236#drop-cached-aggregates
  it('読み直すと、読み直す前に画面が覚えていた集計は捨てられ、新しい版で取り直される', async () => {
    const OLD = { fields: [{ field: '前の版の集計' }] }
    const NEW = { fields: [{ field: '新しい版の集計' }] }
    const world: World = { stamp: A, fields: OLD }
    const { fieldsCalls } = await start(world)
    const reloads = countReloads()
    await open('/')
    // 画面が分野の集計を覚える
    expect(await apiMod.apiCached('/fields')).toEqual(OLD)
    const remembered = fieldsCalls()
    expect(await apiMod.apiCached('/fields')).toEqual(OLD)
    expect(fieldsCalls(), '集計を覚えていない').toBe(remembered)

    // 新しい版を配信し、知らせの「更新」で読み直す
    world.stamp = B
    world.fields = NEW
    await navigate(/^学習$/)
    const btn = button(/^更新$/)
    expect(btn, '帯の「更新」が出ていない').not.toBeNull()
    await click(btn!)
    expect(reloads.n).toBe(1)

    // 読み直した画面（module を作り直す）では、覚えていた集計は残らず新しい版で取り直す
    await teardown()
    await loadModules()
    await open('/')
    expect(await apiMod.apiCached('/fields'), '読み直す前の集計が残っている').toEqual(NEW)
    expect(fieldsCalls(), '読み直したあとに集計を取り直していない').toBeGreaterThan(remembered)
  })
})
