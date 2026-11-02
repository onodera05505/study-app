// @vitest-environment jsdom
/** 練習テストの画面（UC-004）の、単元の一覧が取れないとき と 進行中があるのに始めようとして断られたとき。
 *  fetch を偽物にして本物の React で描く（tests/client/practice.test.tsx の作法）。 */

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

type Reply = { status?: number; body?: unknown; queue?: unknown[] }
type Call = { url: string; method: string; body: Record<string, unknown> | undefined }

/** 「<メソッド> <path>」ごとに応答を決める偽の fetch。queue は呼ばれた順に返す（最後の値は繰り返す）。 */
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
    const status = reply.status ?? 200
    const payload = reply.queue ? (reply.queue.length > 1 ? reply.queue.shift() : reply.queue[0]) : (reply.body ?? {})
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) }
  })
  return calls
}

const FIELDS = {
  fields: [
    { field: 'テクノロジ系', topics: 12, questions: 120, understood: 3, partly: 2, untouched: 7 },
    { field: 'マネジメント系', topics: 5, questions: 40, understood: 1, partly: 1, untouched: 3 },
  ],
}
const CATEGORIES = {
  categories: [
    { middleNo: 14, middle: 'ハードウェア', field: 'テクノロジ系', topics: 6, questions: 48, understood: 2 },
    { middleNo: 15, middle: 'ソフトウェア', field: 'テクノロジ系', topics: 4, questions: 30, understood: 0 },
  ],
}
/** 進行中のテスト（UC-006 getCurrentSession の応答の形。範囲と回答済み／全体）。 */
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

/** 1 件のテストの中で応答を替えて描き直すので、毎回根を捨てて作り直す。 */
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

const categoryGets = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.url.split('?')[0] === '/api/categories').length
const sessionPosts = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/sessions').length

/** 失敗の案内のあとの「読み直す手段」を、単元が出るはずだった場所（カテゴリ別の節）の中から探し、その文を返す。
 *  押して単元の一覧の取得が実際に増えるものだけを手段と見なす（在るだけのものは手段にしない）。
 *  節の中の分野のボタンそのものも候補に入る（分野を押し直して取り直すのも読み直し）。
 *  節の外の開始のボタン（分野別演習・弱点復習）は演習を始めてしまうので候補にしない。 */
async function findReload(calls: Call[]): Promise<string | undefined> {
  const inSection = () =>
    section(/カテゴリ別/).filter((el) => el.matches('button,a,[role="button"]')) as HTMLButtonElement[]
  const labels = inSection().map((b) => (b.textContent ?? '').trim()).filter((t) => t !== '')
  for (const label of labels) {
    const el = inSection().find((b) => (b.textContent ?? '').trim() === label)
    if (!el || el.disabled) continue
    const got = categoryGets(calls)
    await click(el, label)
    if (categoryGets(calls) > got) return label
  }
  return undefined
}

describe('練習テストの画面（UC-004。単元の一覧の失敗と、進行中があるのに始めようとしたとき）', () => {
  // @covers REQ-244#categories-failed
  it('分野を選んだあとの単元の一覧が取れないときは、単元の場所に取れなかったことと理由を出し、読み直す手段を添え、分野の一覧は残す', async () => {
    const REASON = '単元の一覧を取得できませんでした'
    const FAILED = /取得できません|取れません|失敗/
    // 最初の単元の一覧の取得だけが落ち、読み直しは通る偽のサーバ
    let gets = 0
    const base = replies()
    const calls = stubApi((key) => {
      if (key !== 'GET /api/categories') return base(key)
      gets += 1
      return gets === 1 ? { status: 500, body: { error: REASON } } : { body: CATEGORIES }
    })
    await draw()
    // 空振り対策: 分野を選ぶ前は失敗の案内が出ていない
    expect(text(), '分野を選ぶ前から失敗の案内が出ている').not.toMatch(FAILED)

    await click(sectionBtn(/カテゴリ別/, /テクノロジ系/), 'カテゴリ別の分野')
    expect(categoryGets(calls), '単元の一覧を取りに行っていない').toBe(1)
    // 取れなかったことと理由が、単元が出るはずだった場所（カテゴリ別の節の中）に出る
    expect(text(), '取れなかったことが出ていない').toMatch(FAILED)
    expect(text(), '理由が出ていない').toContain(REASON)
    expect(
      section(/カテゴリ別/).map((el) => el.textContent ?? '').join(' '),
      'カテゴリ別の節の中に失敗の案内が無い',
    ).toMatch(FAILED)
    expect(text(), '取れていない単元が出ている').not.toContain('ハードウェア')
    // 分野の一覧は残る
    expect(sectionBtn(/カテゴリ別/, /テクノロジ系/), '分野の一覧が消えている').toBeTruthy()
    expect(sectionBtn(/カテゴリ別/, /マネジメント系/), '分野の一覧が消えている').toBeTruthy()
    expect(sessionPosts(calls), '単元が取れていないのにテストが始まっている').toBe(0)
    // 読み直す手段（押すと単元の一覧の取得が走る）。通れば単元が出て失敗の案内は消える
    const reload = await findReload(calls)
    expect(reload, '読み直す手段が添えられていない').toBeDefined()
    expect(text(), '読み直して取れたのに単元が出ない').toContain('ハードウェア')
    expect(text(), '読み直して取れたのに失敗の案内が残っている').not.toMatch(FAILED)
  })

  // @covers REQ-057#conflict-when-in-progress
  it('進行中があって作成が断られたら、新しいテストへは移らず、進行中のテストの範囲と回答の進み具合を示す', async () => {
    const calls = stubApi(
      replies({
        'POST /api/sessions': { status: 409, body: { error: '進行中のテストがあります' } },
        // 画面を開いた時点では進行中が無く（別の画面で始まった直後）、断られたあとの取り直しで進行中が返る
        'GET /api/sessions/current': { queue: [{ session: null }, IN_PROGRESS] },
      }),
    )
    await draw()
    expect(text(), '描いた直後から進行中の知らせが出ている（この検査は空振りになる）').not.toContain('分野「テクノロジ系」')

    await click(btnOutsideCategories(/テクノロジ系/), '分野別の開始')
    expect(sessionPosts(calls), '作成を頼んでいない').toBe(1)
    // 新しいテストの出題の画面へ移らない
    expect(text()).not.toMatch(/PATH:\/sessions?\//)
    // 進行中のテストの範囲と回答の進み具合（回答済み／全体）
    expect(text(), '進行中のテストの範囲が出ていない').toContain('分野「テクノロジ系」')
    expect(text(), '回答の進み具合（7 · 20）が出ていない').toMatch(/7\s*·\s*20/)
    expect(btn(/再開/), '進行中のテストへ戻る導線が無い').toBeTruthy()
  })
})
