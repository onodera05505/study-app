// @vitest-environment jsdom
/** UC-008 模試（通し受験）の入口の画面（公開回の一覧・ランダム構成の入口・受験前の確認）。 */

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

/** label を含み other を含まない、いちばん外側のかたまり（＝その回の行）。 */
function rowOf(label: string, other: string): string {
  const cands = els('*').filter((e) => (e.textContent ?? '').includes(label) && !(e.textContent ?? '').includes(other))
  return cands.sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length)[0]?.textContent ?? ''
}

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
const CREATED = { id: 's-1', kind: 'mock', scopeLabel: '令和6年度', questionCount: 100, timeLimitSec: 7200 }

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

describe('模擬試験の画面', () => {
  // @covers REQ-102#exam-row-figures
  it('回の名前・問題数・受験回数・最高正答数を出し、未受験の回には受験回数を出さない', async () => {
    stubApi(replies())
    await draw()
    expect(text()).toContain('令和6年度')
    expect(text()).toContain('令和5年度 秋期')
    expect(text()).toContain('100')
    const done = rowOf('令和6年度', '令和5年度 秋期')
    expect(done, '受験ずみの回に受験回数が出ていない').toMatch(/3\s*回/)
    expect(done, '受験ずみの回に最高正答数が出ていない').toContain('87')
    expect(rowOf('令和5年度 秋期', '令和6年度'), '未受験の回に受験回数が出ている').not.toMatch(/\d+\s*回/)
  })

  // @covers REQ-103#not-loaded-vs-empty
  it('取得前は読み込み中と分かり、結果が空のときだけ一覧が空として描かれる', async () => {
    stubApi(replies({ 'GET /api/exams': { body: EXAMS, wait: new Promise(() => {}) } }))
    await draw()
    expect(text(), '取得前に読み込み中と分からない').toMatch(/読み込み/)
    expect(text()).not.toContain('令和6年度')

    stubApi(replies({ 'GET /api/exams': { body: { exams: [] } } }))
    await draw()
    expect(text(), '結果が空のときに読み込み中のままになっている').not.toMatch(/読み込み/)
    expect(text()).not.toContain('令和6年度')
  })

  // @covers REQ-104#start-confirmation
  it('制限時間が始まることを確認し、取り消したらセッションを作らない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const calls = stubApi(replies())
    await draw()
    const buttons = els('button')
    expect(buttons.length, '受験を始める導線が無い').toBeGreaterThan(0)
    for (const b of buttons) await click(b, '受験の開始')
    expect(confirm, '制限時間の確認を取っていない').toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/sessions'), '取り消したのにセッションを作っている').toBe(false)

    confirm.mockReturnValue(true)
    await click(els('button')[0], '受験の開始')
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/sessions'), '確認が取れてもセッションを作らない').toBe(true)
  })

  // @covers REQ-110#conflict-guides-to-resume
  it('進行中のテストがあって作れないときだけ、練習テストで再開か破棄をするよう案内する', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    stubApi(
      replies({
        'POST /api/sessions': {
          status: 409,
          // 断りの本文は契約の ErrorBody だけ（進行中のテストの行は載らない）
          body: { error: '進行中のテストがあります' },
        },
      }),
    )
    await draw()
    await click(els('button')[0], '受験の開始')
    expect(text(), '進行中の案内が出ない').toMatch(/練習テスト/)

    // 別の理由で作れなかったときは、進行中の案内にしない
    stubApi(replies({ 'POST /api/sessions': { status: 404, body: { error: '出題できる過去問がありません' } } }))
    await draw()
    await click(els('button')[0], '受験の開始')
    expect(text()).toContain('出題できる過去問がありません')
    expect(text(), '409 でないのに進行中の案内が出ている').not.toMatch(/練習テスト/)
  })
})
