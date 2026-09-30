// @vitest-environment jsdom
/** UC-013「デプロイ後、開いたままの画面に『新しい版があります』の帯が出て、押したときだけ読み直す」の
 *  基本の流れを 1 本で実行する写し（正常系のみ。取れないときは REQ-283・REQ-284 のテストが見る）。
 *
 *  版の印（version.json）は偽の fetch が呼ばれた順に返す。1 回目が今の版、2 回目が配信後の版。
 *  画面の文字は要件（REQ-281・REQ-282）の文面から採る。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

type Stamp = { build: string; at: string }
/** 開いたときの版と、配信された新しい版。 */
const NOW: Stamp = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
const RELEASED: Stamp = { build: 'def5678', at: '2026-09-28T09:00:00Z' }

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

let versionCalls = 0

/** version.json は stamps の順に返す（尽きたら最後の値）。API の一覧は空で返す。 */
function stubApi(stamps: Stamp[]) {
  versionCalls = 0
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    let body: unknown = {}
    if (p.includes('version.json')) body = stamps[Math.min(versionCalls++, stamps.length - 1)]
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
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

let host: HTMLElement
let root: Root | null = null

const text = () => (host.textContent ?? '').replace(/\s+/g, ' ')

const CONTROLS = 'button, [role="button"], summary, a'
const trimmed = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()
const controls = (name: string | RegExp) =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) =>
    typeof name === 'string' ? trimmed(el).includes(name) : name.test(trimmed(el)),
  )
async function press(name: string | RegExp) {
  const els = controls(name)
  const target =
    (typeof name === 'string' ? els.find((el) => trimmed(el) === String(name)) : undefined) ?? els[0]
  if (!target) throw new Error(`「${name}」の操作が画面に無い`)
  await act(async () => {
    target.click()
  })
}

async function open(entry: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(App)))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  setToken('token-for-scenario')
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('UC-013 新しい版の帯', () => {
  // @scenario UC-013
  it('画面を開いて版の印を覚え、移ったときに見比べて帯を出し、「更新」を押して読み直す', async () => {
    // 1. 開発側が新しい版を配信する。システムはビルドのたびに版の印を静的ファイルとして出す
    //    （ビルドの出力そのものは REQ-278 のテストが見る。ここでは 2 回目に取れる印が配信後の版）
    stubApi([NOW, RELEASED])
    const reloads = countReloads()

    // 2. 利用者が画面を開く。システムは版の印を 1 回だけ取りに行って最初の印として覚え、
    //    この時点では見比べない
    await open('/')
    expect(versionCalls, '画面を開いたときに版の印を取りに行っていない').toBe(1)
    expect(text(), '開いた時点で帯が出ている（この時点では見比べない）').not.toContain('新しい版があります。')

    // 3. 利用者が画面を移る。システムは版の印を取り直して最初の印と見比べ、5 分おきにも同じ見比べをする
    //    （5 分おきの間隔は REQ-280 のテストが見る）
    await press('学習')
    expect(versionCalls, '画面を移っても版の印を見比べていない').toBeGreaterThan(1)

    // 4. 版が違っている。画面は上部に「新しい版があります。」の帯と「更新」ボタンを出し、自動では読み直さない
    expect(text(), '版が違うのに帯が出ていない').toContain('新しい版があります。')
    const update = controls(/^更新$/)
    expect(update.length, '帯に「更新」ボタンが無い').toBeGreaterThan(0)
    expect(reloads.n, '押していないのに読み直している').toBe(0)

    // 5. 利用者が「更新」を押す。画面は読み直して新しい版になる
    await press(/^更新$/)
    expect(reloads.n, '「更新」を押しても読み直していない').toBe(1)

    // 事後条件: 読み直すまで利用者の入力は失われない（読み直しは押したときの 1 回だけ）
    expect(reloads.n).toBe(1)
  })
})
