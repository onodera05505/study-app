// @vitest-environment jsdom
/** 練習テストの画面（演習の範囲の一覧・カテゴリ別の単元選び・進行中のテストの知らせ・再開・破棄）。
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

const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]'
const depth = (el: HTMLElement) =>
  Number(/^H(\d)$/.exec(el.tagName)?.[1] ?? el.getAttribute('aria-level') ?? 2)

/** 見出しが <head> の節の中身（その見出しから、同じか浅い次の見出しまで）。 */
function section(head: RegExp): HTMLElement[] {
  const all = els('*')
  const start = all.find((el) => el.matches(HEADINGS) && head.test(el.textContent ?? ''))
  if (!start) return []
  const rest = all.slice(all.indexOf(start) + 1)
  const end = rest.findIndex((el) => el.matches(HEADINGS) && depth(el) <= depth(start))
  return end < 0 ? rest : rest.slice(0, end)
}

/** 見出しが <head> の節の中の、文字が <re> の押せるもの。 */
const sectionBtn = (head: RegExp, re: RegExp) =>
  section(head)
    .filter((el) => el.matches('button,a,[role="button"]'))
    .find((b) => re.test(b.textContent ?? ''))

/** カテゴリ別の節の外にある <re> のボタン（＝分野別演習を始める側）。 */
function btnOutsideCategories(re: RegExp) {
  const inCategories = new Set(section(/カテゴリ別/))
  return els('button,a,[role="button"]')
    .filter((b) => !inCategories.has(b))
    .find((b) => re.test(b.textContent ?? ''))
}

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
    { field: 'マネジメント系', topics: 5, questions: 40, understood: 1, partly: 1, untouched: 3 },
  ],
}
/** テクノロジ系の単元（中分類）。2 件目を押させて middleNo の写し違いを見る。 */
const CATEGORIES = {
  categories: [
    { middleNo: 14, middle: 'ハードウェア', field: 'テクノロジ系', topics: 6, questions: 48, understood: 2 },
    { middleNo: 15, middle: 'ソフトウェア', field: 'テクノロジ系', topics: 4, questions: 30, understood: 0 },
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

  // @verifies REQ-190
  it('範囲の一覧はカテゴリ別の節を持ち、その節で分野を選べる', async () => {
    stubApi(replies())
    await draw()
    expect(section(/カテゴリ別/).length, 'カテゴリ別の節が無い').toBeGreaterThan(0)
    expect(sectionBtn(/カテゴリ別/, /テクノロジ系/), 'カテゴリ別の節に分野のボタンが無い').toBeTruthy()
    expect(sectionBtn(/カテゴリ別/, /マネジメント系/), 'カテゴリ別の節に出ない分野がある').toBeTruthy()
  })

  // @verifies REQ-192
  it('カテゴリ別で分野を選ぶと、その分野の単元の一覧が出る（選んだだけでは始まらない）', async () => {
    const calls = stubApi(replies({ 'GET /api/categories': { body: CATEGORIES } }))
    await draw()
    expect(text(), '分野を選ぶ前から単元が出ている').not.toContain('ハードウェア')

    await click(sectionBtn(/カテゴリ別/, /テクノロジ系/), 'カテゴリ別の分野')
    const asked = calls.filter((c) => c.method === 'GET' && c.url.split('?')[0] === '/api/categories')
    expect(asked.length, '単元の一覧を取りに行っていない').toBeGreaterThan(0)
    expect(decodeURIComponent(asked[asked.length - 1].url)).toContain('field=テクノロジ系')
    expect(text()).toContain('ハードウェア')
    expect(text()).toContain('ソフトウェア')
    expect(btn(/ソフトウェア/), '単元が押せる形になっていない').toBeTruthy()
    expect(
      calls.some((c) => c.method === 'POST' && c.url === '/api/sessions'),
      '分野を選んだだけでテストが始まっている',
    ).toBe(false)

    // 別の分野を選ぶと、その分野で取り直す
    const calls2 = stubApi(replies({ 'GET /api/categories': { body: { categories: [] } } }))
    await draw()
    await click(sectionBtn(/カテゴリ別/, /マネジメント系/), 'カテゴリ別の分野')
    const asked2 = calls2.filter((c) => c.method === 'GET' && c.url.split('?')[0] === '/api/categories')
    expect(asked2.length, '単元の一覧を取りに行っていない').toBeGreaterThan(0)
    expect(decodeURIComponent(asked2[asked2.length - 1].url)).toContain('field=マネジメント系')
  })

  // @verifies REQ-192
  it('単元を押すと kind=middle・その単元の middleNo で作成が頼まれる', async () => {
    const calls = stubApi(replies({ 'GET /api/categories': { body: CATEGORIES } }))
    await draw()
    await click(sectionBtn(/カテゴリ別/, /テクノロジ系/), 'カテゴリ別の分野')
    await click(btn(/ソフトウェア/), '単元の開始')
    const created = calls.find((c) => c.method === 'POST' && c.url === '/api/sessions')
    expect(created, 'POST /api/sessions が呼ばれていない').toBeTruthy()
    expect(created!.body?.kind).toBe('middle')
    expect(created!.body?.middleNo).toBe(15)
    expect(typeof created!.body?.size).toBe('number')
  })

  // @verifies REQ-191, REQ-192
  it('進行中のテストがあるあいだは単元のボタンも押せない', async () => {
    stubApi(
      replies({
        'GET /api/categories': { body: CATEGORIES },
        'GET /api/sessions/current': { body: IN_PROGRESS },
      }),
    )
    await draw()
    const field = sectionBtn(/カテゴリ別/, /テクノロジ系/) as HTMLButtonElement | undefined
    expect(field, 'カテゴリ別の節に分野のボタンが無い').toBeTruthy()
    expect(field!.disabled, '分野を選ぶだけの操作まで止めている').toBeFalsy()
    await click(field, 'カテゴリ別の分野')
    const unit = btn(/ソフトウェア/) as HTMLButtonElement | undefined
    expect(unit, '単元のボタンが無い').toBeTruthy()
    expect(unit!.disabled).toBe(true)
  })

  // @verifies REQ-191
  it('分野を押すと分野別演習、弱点復習を押すと弱点復習が範囲と問題数つきで始まる', async () => {
    const calls = stubApi(replies())
    await draw()
    await click(btnOutsideCategories(/テクノロジ系/), '分野別の開始')
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
    expect((btnOutsideCategories(/テクノロジ系/) as HTMLButtonElement | undefined)?.disabled).toBe(true)
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
