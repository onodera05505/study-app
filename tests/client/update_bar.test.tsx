// @vitest-environment jsdom
/** App の外枠（UC-012#1・#3 と UC-013#3〜#5）。
 *
 *  - 画面を移るたびに「直前に開いていた画面」を記録する（フィードバックの画面自身は記録しない）
 *  - 上部メニューの「フィードバック」からフィードバックの画面へ行ける
 *  - 画面を移るたびに版の印を見比べ、違えば帯と「更新」を出す。押したときだけ読み直す
 *
 *  fetch は偽物。version.json は呼ばれた順に印を返し、API は path ごとの本文を返す。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { getLastPage } from '../../src/client/lib/lastPage'
import { setToken } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

type Stamp = { build: string; at: string }
/** 最初に取れる印と、配信後の印。 */
const A: Stamp = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
const B: Stamp = { build: 'def5678', at: '2026-09-28T09:00:00Z' }

const SSO_CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
const ME = {
  user: { id: 'u-1', name: '寺田テスト', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

/** 画面が取りに行く一覧は空で返す（中身はこの検査の対象ではない）。 */
function apiBody(url: string): unknown {
  if (url.includes('/auth/config')) return SSO_CONFIG
  if (url.includes('/me')) return ME
  if (url.includes('/glossary')) return { glossary: [] }
  if (url.includes('/fields')) return { fields: [] }
  if (url.includes('/categories')) return { categories: [] }
  if (url.includes('/exams')) return { exams: [] }
  if (url.includes('/sessions/current')) return { session: null }
  if (url.includes('/sessions')) return { sessions: [] }
  if (url.includes('/topics')) return { topics: [] }
  return {}
}

/** version.json は stamps の順（尽きたら最後の値）、それ以外は apiBody。 */
function stubFetch(stamps: Stamp[]) {
  const urls: string[] = []
  let i = 0
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    urls.push(u)
    const body = u.includes('version.json') ? stamps[Math.min(i++, stamps.length - 1)] : apiBody(u)
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
  return { versionCalls: () => urls.filter((u) => u.includes('version.json')).length }
}

/** name を持つトークン（署名は読まない）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** 画面を開き直す（MemoryRouter は初期の場所しか見ないので、必ず捨ててから描く）。 */
async function open(entry: string) {
  await act(async () => {
    root.render(null)
  })
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: [entry] }, h(App)))
  })
}

/** 文字でリンクを探す。 */
function link(re: RegExp): HTMLAnchorElement | null {
  return ([...container.querySelectorAll('a')].find((a) => re.test(a.textContent ?? '')) ??
    null) as HTMLAnchorElement | null
}

/** 文字でボタンを探す。 */
function button(re: RegExp): HTMLButtonElement | null {
  return ([...container.querySelectorAll('button')].find((b) => re.test(b.textContent ?? '')) ??
    null) as HTMLButtonElement | null
}

async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  setToken(jwtWith({ sub: 'u-1', name: '寺田テスト', role: 'MEMBER' }))
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('直前に開いていた画面の記録（UC-012#1）', () => {
  // @verifies REQ-267
  it('移った先の画面を記録し、フィードバックの画面自身は記録しない', async () => {
    stubFetch([A])
    await open('/topics')
    expect(getLastPage()?.path).toBe('/topics')

    await open('/feedback')
    // フィードバックの画面は記録しないので、記録は前の画面のまま
    expect(getLastPage()?.path).toBe('/topics')
  })
})

describe('上部メニューのフィードバック（UC-012#3）', () => {
  // @verifies REQ-270
  it('上部メニューの「フィードバック」からフィードバックの画面へ行ける', async () => {
    stubFetch([A])
    await open('/')
    const nav = link(/フィードバック/)
    expect(nav, '上部メニューに「フィードバック」が無い').not.toBeNull()
    expect(nav!.getAttribute('href')).toBe('/feedback')

    await click(nav!)
    // 行き先はフィードバックの画面（本文を書く欄がある）
    expect(container.querySelector('textarea'), 'フィードバックの画面が描かれていない').not.toBeNull()
    expect(text()).toContain('フィードバック')
  })
})

describe('新しい版の帯（UC-013#3〜#5）', () => {
  // @verifies REQ-280
  it('画面を移るたびに版の印を見比べる', async () => {
    const { versionCalls } = stubFetch([A])
    await open('/')
    const before = versionCalls()
    expect(before, '画面を開いたときに版の印を見に行っていない').toBeGreaterThan(0)

    const nav = link(/フィードバック/)
    expect(nav).not.toBeNull()
    await click(nav!)
    expect(versionCalls(), '画面を移っても版の印を見比べていない').toBeGreaterThan(before)
  })

  // @verifies REQ-281
  it('版が変わっていなければ帯を出さない', async () => {
    stubFetch([A])
    await open('/')
    const nav = link(/フィードバック/)
    if (nav) await click(nav)
    expect(text()).not.toContain('新しい版があります')
    expect(button(/^更新$/)).toBeNull()
  })

  // @verifies REQ-281
  it('版が変わっていれば「新しい版があります。」の帯と「更新」を出す', async () => {
    stubFetch([A, B])
    await open('/')
    const nav = link(/フィードバック/)
    expect(nav).not.toBeNull()
    await click(nav!)
    expect(text()).toContain('新しい版があります。')
    expect(button(/^更新$/), '「更新」のボタンが無い').not.toBeNull()
  })

  // @verifies REQ-282
  it('「更新」を押したときだけ読み直す', async () => {
    stubFetch([A, B])
    const reloads = countReloads()
    await open('/')
    const nav = link(/フィードバック/)
    expect(nav).not.toBeNull()
    await click(nav!)
    const btn = button(/^更新$/)
    expect(btn, '帯の「更新」が出ていない').not.toBeNull()
    // 帯が出ただけでは読み直さない
    expect(reloads.n).toBe(0)

    await click(btn!)
    expect(reloads.n).toBe(1)
  })
})
