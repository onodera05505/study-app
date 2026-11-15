// @vitest-environment jsdom
/** 回答が数える回答に加わったあとの、分野・単元の集計の取り直し（UC-003）。
 *  単元の一覧が覚える集計（apiCached）を先に取り、出題の画面で回答を送る／模試を締めたあとに
 *  同じ集計を求めて、取り直したかを fetch の回数と返る値で見る。fetch を偽物にして本物の React で描く。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Session } from '../../src/client/pages/Session'
import { apiCached, invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const btn = (re: RegExp) => els('button,a,[role="button"]').find((b) => re.test(b.textContent ?? ''))

const CHOICES = {
  ア: '固定費を限界利益率で割った売上高',
  イ: '売上高から変動費を差し引いた額',
  ウ: '在庫の平均残高を売上原価で割った値',
  エ: '総資産を売上高で割った値',
}
const choiceBtn = (label: keyof typeof CHOICES) =>
  els('button').find((b) => (b.textContent ?? '').includes(CHOICES[label]))

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown }
type Call = { url: string; method: string }

/** 「<メソッド> <path>」ごとに応答を決める偽の fetch。集計は求められた回ごとに理解の数を 1 つずつ増やして返す。 */
function stubApi(base: Record<string, Reply>) {
  const calls: Call[] = []
  let aggregateServed = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method })
    const key = `${method} ${u.split('?')[0]}`
    let body: unknown
    if (key === 'GET /api/fields') {
      aggregateServed++
      body = { fields: [{ field: 'ストラテジ系', understood: aggregateServed }] }
    } else if (key === 'GET /api/categories') {
      aggregateServed++
      body = { categories: [{ category: '企業活動', understood: aggregateServed }] }
    } else {
      const reply = base[key] ?? { body: EMPTY }
      body = reply.body
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body ?? {}) }
  })
  return calls
}

const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

const Q = () => ({
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
})

const DRILL = { id: 's-1', kind: 'drill', scopeLabel: '論点「損益分岐点」', questionCount: 3, sourceExam: null }
const MOCK = { id: 's-1', kind: 'mock', scopeLabel: '令和6年度 を通しで受験', questionCount: 3, sourceExam: '2024r06' }

const EXPL = {
  correctReason: 'アが正解の根拠です。',
  choices: [
    { label: 'ア', term: null, note: '正解。均衡点の定義そのもの。' },
    { label: 'イ', term: '損益分岐点', note: '売上と費用が等しくなる点の説明。' },
    { label: 'ウ', term: 'ABC 分析', note: '重点管理の手法の説明。' },
    { label: 'エ', term: '在庫回転率', note: '在庫の回り方を見る指標の説明。' },
  ],
}

const RESULT = {
  session: MOCK,
  overall: { total: 3, correct: 1, pct: 33 },
  fields: [],
  passed: false,
  expired: false,
  criteria: { overallPct: 60, fieldPct: 30 },
  approximation: '公式スコアとは一致しません。',
  items: [],
}

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

const aggregateGets = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && /^\/api\/(fields|categories)(\?|$)/.test(c.url)).length

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

describe('回答が加わったあとの分野・単元の集計（UC-003）', () => {
  // @covers REQ-484#aggregate-refetched-after-answer
  it('演習で回答を送ったあとに単元の一覧へ入り直すと、覚えていた集計ではなく取り直した集計を示す', async () => {
    const calls = stubApi({
      'GET /api/sessions/s-1/current': { body: { session: DRILL, question: Q(), answered: 0, remainingSec: null, finished: false } },
      'POST /api/sessions/s-1/answer': {
        body: { correct: true, correctAnswer: 'ア', explanation: EXPL, remaining: 2, finished: false },
      },
    })
    const fieldsBefore = await apiCached('/fields')
    const categoriesBefore = await apiCached('/categories')
    expect(aggregateGets(calls)).toBe(2)

    await draw()
    await click(choiceBtn('ア'), '選択肢ア')
    expect(calls.filter((c) => c.url === '/api/sessions/s-1/answer'), '回答を送っていない').toHaveLength(1)

    const fieldsAfter = await apiCached('/fields')
    const categoriesAfter = await apiCached('/categories')
    expect(aggregateGets(calls), '回答のあとに分野・単元の集計を取り直していない').toBe(4)
    expect(fieldsAfter).not.toEqual(fieldsBefore)
    expect(categoriesAfter).not.toEqual(categoriesBefore)
  })

  // @covers REQ-484#aggregate-refetched-after-answer
  it('模試を締めたあとに単元の一覧へ入り直すと、覚えていた集計ではなく取り直した集計を示す', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const calls = stubApi({
      'GET /api/sessions/s-1/current': { body: { session: MOCK, question: Q(), answered: 1, remainingSec: 125, finished: false } },
      'POST /api/sessions/s-1/answer': { body: { remaining: 2, finished: false } },
      'POST /api/sessions/s-1/finish': { body: { ok: true, correct: 1, total: 3 } },
      'GET /api/sessions/s-1': { body: RESULT },
    })
    const fieldsBefore = await apiCached('/fields')
    const categoriesBefore = await apiCached('/categories')
    expect(aggregateGets(calls)).toBe(2)

    await draw()
    await click(btn(/採点|締め/), '締める導線')
    expect(calls.filter((c) => c.url === '/api/sessions/s-1/finish'), '模試を締めていない').toHaveLength(1)

    const fieldsAfter = await apiCached('/fields')
    const categoriesAfter = await apiCached('/categories')
    expect(aggregateGets(calls), '模試を締めたあとに分野・単元の集計を取り直していない').toBe(4)
    expect(fieldsAfter).not.toEqual(fieldsBefore)
    expect(categoriesAfter).not.toEqual(categoriesBefore)
  })
})
