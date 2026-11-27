// @vitest-environment jsdom
/** UC-008 模試（通し受験）の入口の画面（両方の入口・出題できる問題が無いときの表示・進行中の案内の中身）。
 *  fetch を偽物にして本物の React で描く（exams.test.tsx の作法）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Exams } from '../../src/client/pages/Exams'
import { invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown; wait?: Promise<unknown> }
type Call = { url: string; method: string; body: Record<string, unknown> | undefined }

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

const EXAMS = {
  exams: [
    { exam: '2024r06', examLabel: '令和6年度', questions: 100, attempts: 3, bestScore: 87 },
    { exam: '2023r05a', examLabel: '令和5年度 秋期', questions: 100, attempts: 0, bestScore: null },
  ],
}
const CREATED = { id: 's-1', kind: 'mock', scopeLabel: '令和6年度 を通しで受験', questionCount: 100, timeLimitSec: 7200 }

/** 進行中のテスト（契約 UC-006 getCurrentSession の例 okInProgress の値）。 */
const IN_PROGRESS = {
  session: {
    id: '7b1e3d50-9c42-4a8f-bd21-6e0f5a39c714',
    userId: 'u_01HQ8Z3K5M',
    kind: 'drill',
    status: 'in_progress',
    sourceExam: null,
    scopeLabel: '論点: RAID',
    timeLimitSec: null,
    questionCount: 10,
    correctCount: null,
    startedAt: 1759276800,
    finishedAt: null,
    answered: 4,
  },
}

function replies(over: Record<string, Reply> = {}): (key: string) => Reply {
  const base: Record<string, Reply> = {
    'GET /api/exams': { body: EXAMS },
    'GET /api/sessions/current': { body: { session: null } },
    'POST /api/sessions': { body: CREATED, status: 201 },
    ...over,
  }
  return (key) => base[key] ?? { body: EMPTY }
}

/** 一覧は [] ・進行中は null。どの一覧を引かれても「空」で返す。 */
const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

const Where = () => h('div', null, `PATH:${useLocation().pathname}`)

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
        { initialEntries: ['/exams'] },
        h(
          Routes,
          null,
          h(Route, { path: '/exams', element: h(Exams) }),
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

const starts = (calls: Call[]) =>
  calls.filter((c) => c.method === 'POST' && c.url === '/api/sessions' && c.body?.kind === 'mock').map((c) => c.body!)

describe('模擬試験の入口の画面（UC-008）', () => {
  // @covers REQ-103#both-entries
  it('回の一覧の各回とランダム構成の入口のどちらからも、その範囲で受験を始められる', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    stubApi(replies())
    await draw()
    const count = els('button').length
    expect(count, '受験を始める導線が無い').toBeGreaterThan(0)
    // 押すと画面を離れるので、導線を 1 つずつ、描き直しては押す
    const bodies: Record<string, unknown>[] = []
    for (let i = 0; i < count; i++) {
      const calls = stubApi(replies())
      await draw()
      await click(els('button')[i], `${i + 1} 番目の導線`)
      bodies.push(...starts(calls))
    }
    expect(bodies.some((b) => b.exam === '2024r06'), '令和6年度の回から始められない').toBe(true)
    expect(bodies.some((b) => b.exam === '2023r05a'), '令和5年度 秋期の回から始められない').toBe(true)
    expect(bodies.some((b) => b.exam == null), 'ランダム構成の入口から始められない').toBe(true)
  })

  // @covers REQ-109#empty-scope-message
  it('出題できる問題が無くて作れなかったときは、始めようとした画面にその旨が出て、画面を離れない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const REASON = '出題できる過去問がありません'
    // UC-004 の契約 startSession の NOT_FOUND（選んだ範囲に出題できる問題が 1 問も無い）
    const calls = stubApi(replies({ 'POST /api/sessions': { status: 404, body: { error: REASON } } }))
    await draw()
    expect(text(), '押す前から出ている（出しっぱなしの文を拾っている）').not.toContain(REASON)
    await click(els('button')[0], '受験の開始')
    expect(starts(calls), '受験を始めに行っていない（この検査は空振りになる）').not.toEqual([])
    expect(text(), '出題できる問題が無い旨が出ない').toContain(REASON)
    expect(text(), '作れなかったのに画面を離れている').not.toContain('PATH:')
    expect(text(), '作れなかったのに回の一覧が消えている').toContain('令和6年度')
  })

  // @covers REQ-110#in-progress-detail
  it('進行中のテストで作れなかったときの案内に、進行中のテストの範囲と回答の進み具合が添う（BR-017）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    stubApi(
      replies({
        // 断りの本文は契約の ErrorBody だけ。進行中のテストは getCurrentSession で取り直す
        'POST /api/sessions': { status: 409, body: { error: '進行中のテストがあります' } },
        'GET /api/sessions/current': { body: IN_PROGRESS },
      }),
    )
    await draw()
    await click(els('button')[0], '受験の開始')
    expect(text(), '進行中の案内が出ない').toMatch(/練習テスト/)
    expect(text(), '進行中のテストの範囲が案内に無い').toContain('論点: RAID')
    expect(text(), '回答の進み具合（4／10）が案内に無い').toMatch(/4\s*[／/]\s*10|4\s*問/)
  })

  // @covers REQ-110#in-progress-fetch-failed
  it('進行中のテストで作れなかったあとに進行中のテストそのものを取れなかったら、範囲と進み具合の代わりに練習テストで再開か破棄をする案内と取れなかった理由が出る（BR-017）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const REASON = '進行中のテストを取得できませんでした'
    const calls = stubApi(
      replies({
        'POST /api/sessions': { status: 409, body: { error: '進行中のテストがあります' } },
        'GET /api/sessions/current': { status: 500, body: { error: REASON } },
      }),
    )
    await draw()
    expect(text(), '押す前から理由が出ている（出しっぱなしの文を拾っている）').not.toContain(REASON)
    await click(els('button')[0], '受験の開始')
    expect(starts(calls), '受験を始めに行っていない（この検査は空振りになる）').not.toEqual([])
    expect(text(), '練習テストへの案内が出ない').toMatch(/練習テスト/)
    expect(text(), '再開か破棄をする案内になっていない').toMatch(/再開|破棄/)
    expect(text(), '進行中のテストを取れなかった理由が出ない').toContain(REASON)
    expect(text(), '作れなかったのに画面を離れている').not.toContain('PATH:')
    expect(text(), '作れなかったのに回の一覧が消えている').toContain('令和6年度')
  })
})
