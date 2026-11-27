// @vitest-environment jsdom
/** UC-008 模試（通し受験）の出題の画面（断られた回答のあとの取り直し、締めの失敗）。
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

/** 選択肢の本文。本文には記号（ア〜エ）を含めない。 */
const CHOICES = {
  ア: '固定費を限界利益率で割った売上高',
  イ: '売上高から変動費を差し引いた額',
  ウ: '在庫の平均残高を売上原価で割った値',
  エ: '総資産を売上高で割った値',
}
const choiceBtn = (label: keyof typeof CHOICES) =>
  els('button').find((b) => (b.textContent ?? '').includes(CHOICES[label]))

const Q = (over: Record<string, unknown> = {}) => ({
  idx: 0,
  text: '模試の問題文その1',
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

/** 模試のテスト（UC-004 の契約 getCurrentQuestion の session は 5 鍵だけ）。 */
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
  remainingSec: 7000,
  finished: false,
  ...over,
})

function replies(over: Record<string, Reply> = {}): (key: string) => Reply {
  const base: Record<string, Reply> = {
    'GET /api/sessions/s-1/current': { body: CUR() },
    // 模試の回答の応答は残りの未回答の件数と終わったかだけ（REQ-343）
    'POST /api/sessions/s-1/answer': { body: { remaining: 99, finished: false } },
    'POST /api/sessions/s-1/finish': { body: { ok: true, correct: 1, total: 100 } },
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 断りの本文は契約の ErrorBody だけで、断られた理由を区別しない（BR-022）。 */
const REJECTED = { status: 409, body: { error: '回答を受け付けられませんでした' } }
const refetches = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url === '/api/sessions/s-1/current').length
const finishes = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/sessions/s-1/finish')

describe('断られた回答の取り直し（UC-008）', () => {
  // @covers REQ-277#stale-idx-refetch
  it('断られて取り直した結果がまだ問題を持つなら、表示がずれていたことを伝え、取り直した問題（位置と進み具合も取り直した値）を示す', async () => {
    const calls = stubApi(
      replies({
        'POST /api/sessions/s-1/answer': REJECTED,
        'GET /api/sessions/s-1/current': {
          // 送った位置は 0。サーバの現在の問題は位置 2（回答済み 2）
          queue: [CUR(), CUR({ question: Q({ idx: 2, text: '模試の問題文その3' }), answered: 2 })],
        },
      }),
    )
    await draw()
    expect(text(), '描いた直後の問題が出ていない（この検査の前提）').toContain('模試の問題文その1')
    expect(text(), '描いた直後からずれを伝えている（この検査は空振りになる）').not.toMatch(/ずれ/)
    const before = refetches(calls)
    await click(choiceBtn('ア'), '選択肢ア')
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/sessions/s-1/answer'), '回答を送っていない（この検査は空振りになる）').toBe(true)
    expect(refetches(calls), '断られたのに現在の問題を取り直していない').toBeGreaterThan(before)
    expect(text(), '取り直した現在の問題を示していない').toContain('模試の問題文その3')
    expect(text(), '断られた問題を出したままにしている').not.toContain('模試の問題文その1')
    expect(text(), '取り直した進み具合（2／100）になっていない').toMatch(/2\s*[／/]\s*100/)
    // 断りの本文（REJECTED）は「ずれ」を含まないので、伝えているのは画面
    expect(text(), '取り直した位置が送った位置と違うのに、表示がずれていたことを伝えていない').toMatch(/ずれ/)
    expect(finishes(calls), '問題が残っているのに締めている').toHaveLength(0)
  })

  // @covers REQ-277#rejected-refetch-finished
  it('断られて取り直した結果が「終わっている」（未回答なし・時間切れ）なら、採点したことにせず締めと結果の流れへ進む', async () => {
    const variants: [string, Record<string, unknown>][] = [
      ['未回答なし', { session: MOCK(), question: null, answered: 100, remainingSec: 3000, finished: true, expired: false }],
      ['時間切れ', { session: MOCK(), question: null, answered: 42, remainingSec: 0, finished: true, expired: true }],
    ]
    for (const [label, finished] of variants) {
      const calls = stubApi(
        replies({
          'POST /api/sessions/s-1/answer': REJECTED,
          'GET /api/sessions/s-1/current': { queue: [CUR(), finished] },
        }),
      )
      await draw()
      expect(finishes(calls), `${label}: 断られる前から締めている（この検査の前提が崩れる）`).toHaveLength(0)
      const before = refetches(calls)
      await click(choiceBtn('ア'), `${label}: 選択肢ア`)
      expect(refetches(calls), `${label}: 断られたのに現在の問題を取り直していない`).toBeGreaterThan(before)
      expect(text(), `${label}: 断られた回答を正解として示している`).not.toMatch(/正解です|正解！|○\s*正解/)
      expect(text(), `${label}: 取り直した結果に位置が無いのにずれを伝えている`).not.toMatch(/ずれ/)
      const movedOn = finishes(calls).length > 0 || /PATH:/.test(text())
      expect(movedOn, `${label}: 取り直した結果が終わっているのに締めと結果の流れへ進まない`).toBe(true)
    }
  })
})

describe('模試の締めの失敗（UC-008）', () => {
  // @covers REQ-251#finish-failed-retryable
  it('締めに失敗したら、まだ採点できていないことと失敗の理由を示し、同じ締めをもう一度行える', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const REASON = 'サーバの都合で締められませんでした'
    const calls = stubApi(
      replies({
        'GET /api/sessions/s-1/current': { body: CUR({ session: MOCK({ questionCount: 3 }), answered: 1 }) },
        'POST /api/sessions/s-1/finish': { status: 500, body: { error: REASON } },
      }),
    )
    await draw()
    // 空振り対策: 押す前は失敗の案内が出ていない
    expect(text(), '押す前から理由が出ている').not.toContain(REASON)
    expect(text(), '押す前から「まだ採点できていない」が出ている').not.toMatch(/まだ採点/)
    await click(btn(/採点|締め/), '締める導線')
    expect(finishes(calls).length, '締めに行っていない（この検査は空振りになる）').toBeGreaterThan(0)
    expect(text(), 'まだ採点できていないことを示していない').toMatch(/まだ採点/)
    expect(text(), '失敗の理由を示していない').toContain(REASON)
    expect(text(), '締めに失敗したのに画面を離れている').not.toContain('PATH:')

    const n = finishes(calls).length
    await click(btn(/採点|締め/), '締め直しの導線')
    const again = finishes(calls)
    expect(again.length, '同じ締めをもう一度行えない').toBeGreaterThan(n)
    expect(again[again.length - 1].body, '押し直した締めが最初の締めと違う').toEqual(again[0].body)
  })
})
