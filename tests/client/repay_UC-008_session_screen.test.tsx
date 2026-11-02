// @vitest-environment jsdom
/** UC-008 模試（通し受験）の出題の画面（始めた直後の範囲の名前・問題数・制限時間、未回答を残した締めの確かめ）。
 *  fetch を偽物にして本物の React で描く（session.test.tsx の作法）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Session } from '../../src/client/pages/Session'
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

type Reply = { status?: number; body?: unknown }
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
    const status = reply.status ?? 200
    return { ok: status < 400, status, text: async () => JSON.stringify(reply.body ?? {}) }
  })
  return calls
}

const CHOICES = {
  ア: '固定費を限界利益率で割った売上高',
  イ: '売上高から変動費を差し引いた額',
  ウ: '在庫の平均残高を売上原価で割った値',
  エ: '総資産を売上高で割った値',
}

const Q = (over: Record<string, unknown> = {}) => ({
  idx: 0,
  text: '問題文その1',
  choices: CHOICES,
  citation: '出典：令和6年度 ITパスポート試験 問1',
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 1,
  otherCitations: [] as string[],
  ...over,
})

/** 模試のテスト（契約 getMockCurrentQuestion の session は先頭 5 鍵）。 */
const MOCK = (over: Record<string, unknown> = {}) => ({
  id: 's-1',
  kind: 'mock',
  scopeLabel: '令和6年度 を通しで受験',
  questionCount: 100,
  sourceExam: '2024r06',
  ...over,
})

const CUR = (over: Record<string, unknown> = {}) => ({
  session: MOCK(),
  question: Q(),
  answered: 0,
  remainingSec: 125,
  finished: false,
  ...over,
})

function replies(over: Record<string, Reply> = {}): (key: string) => Reply {
  const base: Record<string, Reply> = {
    'GET /api/sessions/s-1/current': { body: CUR() },
    'POST /api/sessions/s-1/answer': { body: { correct: true, correctAnswer: 'ア', explanation: null, remaining: 99, finished: false } },
    'POST /api/sessions/s-1/finish': { body: { ok: true, correct: 1, total: 3 } },
    ...over,
  }
  return (key) => base[key] ?? { body: EMPTY }
}

const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

const Where = () => h('div', null, `PATH:${useLocation().pathname}`)

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
        { initialEntries: ['/sessions/s-1'] },
        h(
          Routes,
          null,
          h(Route, { path: '/sessions/:id', element: h(Session) }),
          h(Route, { path: '/session/:id', element: h(Session) }),
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('模擬試験の出題の画面（UC-008）', () => {
  // @covers REQ-105#scope-summary-shown
  it('受験を始めた直後の画面に、範囲の名前・問題数（0／全体）・制限時間（残り時間）が出る', async () => {
    stubApi(replies())
    await draw()
    expect(text(), '範囲の名前が出ていない').toContain('令和6年度 を通しで受験')
    expect(text(), '問題数（0／100）が出ていない').toMatch(/0\s*[／/]\s*100/)
    expect(text(), '制限時間（残り 2 分 5 秒）が出ていない').toMatch(/2\s*[:分]\s*0?5/)
  })

  // @covers REQ-114#confirm-with-unanswered-count
  it('未回答を残したまま締めようとしたら、未回答の残りの問数を示して確かめ、了承したときだけ締める', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const calls = stubApi(
      replies({ 'GET /api/sessions/s-1/current': { body: CUR({ session: MOCK({ questionCount: 3 }), answered: 1 }) } }),
    )
    await draw()
    const finishes = () => calls.filter((c) => c.url === '/api/sessions/s-1/finish').length
    const closer = () => btn(/採点|締め/)
    expect(closer(), '締める導線が無い').toBeDefined()
    await click(closer(), '締める導線')
    expect(confirm, '確かめを取っていない').toHaveBeenCalled()
    expect(confirm.mock.calls.map((c) => String(c[0])).join(' '), '未回答の残りの問数（2）が確かめに入っていない').toContain('2')
    expect(finishes(), '取り消したのに締めている').toBe(0)
    confirm.mockReturnValue(true)
    await click(closer(), '締める導線')
    expect(finishes(), '了承したのに締めない').toBeGreaterThan(0)
  })
})
