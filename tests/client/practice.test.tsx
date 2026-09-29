// @vitest-environment jsdom
/** 練習テストの画面（演習の範囲の一覧・進行中のテストの知らせ・再開・破棄）。
 *  fetch を偽物にして本物の React で描く。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Practice } from '../../src/client/pages/Practice'
import { invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const btn = (re: RegExp) => els('button,a,[role="button"]').find((b) => re.test(b.textContent ?? ''))

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown; wait?: Promise<unknown> }
type Call = { url: string; method: string; body: Record<string, unknown> | undefined }

/** 「<メソッド> <path>」ごとに応答を決める偽の fetch。呼ばれた (url, method, body) を集める。 */
function stubApi(replyOf: (key: string) => Reply) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> | undefined
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      body = undefined
    }
    calls.push({ url: u, method, body })
    const reply = replyOf(`${method} ${u.split('?')[0]}`)
    if (reply.wait) await reply.wait
    const status = reply.status ?? 200
    return { ok: status < 400, status, text: async () => JSON.stringify(reply.body ?? {}) }
  })
  return calls
}

const FIELDS = {
  fields: [
    { field: 'テクノロジ系', topics: 12, questions: 120, understood: 3, partly: 2, untouched: 7 },
  ],
}
const IN_PROGRESS = {
  session: {
    id: 's-9',
    kind: 'field',
    scopeLabel: '分野「テクノロジ系」',
    questionCount: 20,
    answered: 7,
    status: 'in_progress',
  },
}
const CREATED = { id: 's-1', kind: 'field', scopeLabel: '分野「テクノロジ系」', questionCount: 20, timeLimitSec: null }

/** 画面が引きうる一覧の既定。テストごとに要る「<メソッド> <path>」だけ上書きする。 */
function replies(over: Record<string, Reply> = {}): (key: string) => Reply {
  const base: Record<string, Reply> = {
    'GET /api/fields': { body: FIELDS },
    'GET /api/categories': { body: { categories: [] } },
    'GET /api/topics': { body: { topics: [] } },
    'GET /api/sessions/current': { body: { session: null } },
    'DELETE /api/sessions/current': { body: { ok: true } },
    'POST /api/sessions': { body: CREATED, status: 201 },
    ...over,
  }
  return (key) => base[key] ?? { body: EMPTY }
}

/** 一覧は [] ・進行中は null。どの一覧を引かれても「空」で返す（未取得と空を混ぜない）。 */
const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

const Where = () => h('div', null, `PATH:${useLocation().pathname}`)
const path = () => (text().match(/PATH:(\/\S*)/) ?? [])[1] ?? ''

/** 1 件のテストの中で応答を替えて描き直すので、毎回根を捨てて作り直す（描き直しで取り直させる）。 */
async function draw() {
  await act(async () => {
    root.unmount()
  })
  container.innerHTML = ''
  root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/practice'] },
        h(
          Routes,
          null,
          h(Route, { path: '/practice', element: h(Practice) }),
          h(Route, { path: '*', element: h(Where) }),
        ),
      ),
    )
  })
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
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('練習テストの画面', () => {
  // @verifies REQ-190
  it('分野の一覧が取れないときは、分野側の理由と読み直しだけを出す', async () => {
    stubApi(replies({ 'GET /api/fields': { status: 500, body: { error: '分野の一覧を取得できませんでした' } } }))
    await draw()
    expect(text()).toMatch(/取得できません|取れません|失敗/)
    expect(btn(/再読み込み|読み直/), '読み直しの導線が無い').toBeTruthy()
    // 進行中の取得は成功しているので、そちらの文言は出さない
    expect(text()).not.toContain('確認できていません')
  })

  // @verifies REQ-190
  it('進行中の確認が取れないときは「確認できていません」を出し、分野の一覧は出す', async () => {
    stubApi(replies({ 'GET /api/sessions/current': { status: 500, body: { error: '進行中を確認できませんでした' } } }))
    await draw()
    expect(text()).toContain('確認できていません')
    expect(text()).toContain('テクノロジ系')
    expect(btn(/再読み込み|読み直/), '読み直しの導線が無い').toBeTruthy()
  })

  // @verifies REQ-191
  it('分野を押すと分野別演習、弱点復習を押すと弱点復習が範囲と問題数つきで始まる', async () => {
    const calls = stubApi(replies())
    await draw()
    await click(btn(/テクノロジ系/), '分野の開始')
    const byField = calls.find((c) => c.method === 'POST' && c.url === '/api/sessions')
    expect(byField, 'POST /api/sessions が呼ばれていない').toBeTruthy()
    expect(byField!.body?.kind).toBe('field')
    expect(byField!.body?.field).toBe('テクノロジ系')
    expect(typeof byField!.body?.size).toBe('number')

    const calls2 = stubApi(replies())
    await draw()
    await click(btn(/復習/), '弱点復習の開始')
    const review = calls2.find((c) => c.method === 'POST' && c.url === '/api/sessions')
    expect(review, '弱点復習で POST /api/sessions が呼ばれていない').toBeTruthy()
    expect(review!.body?.kind).toBe('review')
    expect(typeof review!.body?.size).toBe('number')
  })

  // @verifies REQ-191
  it('進行中のテストがあるあいだは開始のボタンを押せない', async () => {
    stubApi(replies({ 'GET /api/sessions/current': { body: IN_PROGRESS } }))
    await draw()
    expect((btn(/テクノロジ系/) as HTMLButtonElement | undefined)?.disabled).toBe(true)
    expect((btn(/復習/) as HTMLButtonElement | undefined)?.disabled).toBe(true)
  })

  // @verifies REQ-229
  it('進行中のテストの範囲と回答済み／全体を知らせ、「再開する」でその出題の画面へ移る', async () => {
    stubApi(replies({ 'GET /api/sessions/current': { body: IN_PROGRESS } }))
    await draw()
    expect(text()).toContain('分野「テクノロジ系」')
    expect(text(), '回答済みと全体が出ていない').toMatch(/7\s*·\s*20/)
    await click(btn(/再開/), '「再開する」')
    expect(path()).toMatch(/^\/sessions?\/s-9/)
  })

  // @verifies REQ-230
  it('「破棄する」は回答済みの問数を示して確認し、了承したときだけ破棄を頼む', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const calls = stubApi(replies({ 'GET /api/sessions/current': { body: IN_PROGRESS } }))
    await draw()
    await click(btn(/破棄/), '「破棄する」')
    expect(confirm, '確認を取っていない').toHaveBeenCalled()
    expect(confirm.mock.calls.map((c) => String(c[0])).join(' ')).toContain('7')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)

    confirm.mockReturnValue(true)
    await click(btn(/破棄/), '「破棄する」')
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/sessions/current')).toBe(true)
  })

  // @verifies REQ-234
  it('破棄に失敗したときは理由を出し、進行中の知らせと再開・破棄を残す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    stubApi(
      replies({
        'GET /api/sessions/current': { body: IN_PROGRESS },
        'DELETE /api/sessions/current': { status: 500, body: { error: '破棄できませんでした' } },
      }),
    )
    await draw()
    await click(btn(/破棄/), '「破棄する」')
    expect(text()).toContain('破棄できませんでした')
    expect(text()).toContain('分野「テクノロジ系」')
    expect(btn(/再開/), '進行中の知らせが消えている').toBeTruthy()
  })
})
