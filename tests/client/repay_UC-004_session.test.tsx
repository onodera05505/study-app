// @vitest-environment jsdom
/** 出題の画面（UC-004）の、未回答が無くなったときの締め と 締めたあとの結果。
 *  fetch を偽物にして本物の React で描く（tests/client/session.test.tsx の作法）。 */

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
/** 選択肢のボタン（選択肢の本文を持つボタン）。 */
const choiceBtns = () =>
  els('button').filter((b) => Object.values(CHOICES).some((v) => (b.textContent ?? '').includes(v))) as HTMLButtonElement[]

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown }
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

const Q = () => ({
  idx: 1,
  text: '問題文その1',
  choices: CHOICES,
  citation: '出典：令和6年度 ITパスポート試験 問11',
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 1,
  otherCitations: [] as string[],
})

const SESSION = () => ({ id: 's-1', kind: 'drill', scopeLabel: '論点「損益分岐点」', questionCount: 3, sourceExam: null })

/** 未回答が残る現在の問題（位置 1、回答済み 1／3）。 */
const CUR = () => ({ session: SESSION(), question: Q(), answered: 1, remainingSec: null, finished: false })
/** 未回答が 1 問も残っていない（契約 getCurrentQuestion の例 okNoUnanswered の形）。 */
const ALL_ANSWERED = () => ({ session: SESSION(), question: null, answered: 3, remainingSec: null, finished: true, expired: false })

const FINISHED = { ok: true, correct: 2, total: 3 }

function replies(over: Record<string, Reply> = {}): (key: string) => Reply {
  const base: Record<string, Reply> = {
    'GET /api/sessions/s-1/current': { body: CUR() },
    'POST /api/sessions/s-1/finish': { body: FINISHED },
    'GET /api/sessions/s-1': {
      body: {
        session: SESSION(),
        overall: { total: 3, correct: 2, pct: 67 },
        fields: [],
        passed: false,
        expired: false,
        criteria: { overallPct: 60, fieldPct: 30 },
        approximation: '公式スコアとは一致しません。',
        items: [],
      },
    },
    ...over,
  }
  return (key) => base[key] ?? { body: EMPTY }
}

/** 一覧は [] ・進行中は null。どの一覧を引かれても「空」で返す。 */
const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

const Where = () => h('div', null, `PATH:${useLocation().pathname}`)
const path = () => (text().match(/PATH:(\/\S*)/) ?? [])[1] ?? ''

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

const finishes = (calls: Call[]) => calls.filter((c) => c.url === '/api/sessions/s-1/finish').length
const answers = (calls: Call[]) => calls.filter((c) => c.url === '/api/sessions/s-1/answer').length

describe('出題の画面（UC-004。未回答が無くなったときの締めと、締めたあとの結果）', () => {
  // @covers REQ-071#no-current-when-all-answered
  it('未回答が 1 問も残っていなければ、問題も選択肢も出さずに締めを頼み、締めが通ったら結果へ移る', async () => {
    // 空振り対策: 未回答が残る側では問題を出し、締めを頼まない
    const open = stubApi(replies())
    await draw()
    expect(text(), '未回答が残るのに問題が出ない（この検査は空振りになる）').toContain('問題文その1')
    expect(finishes(open), '未回答が残るのに締めを頼んでいる').toBe(0)

    const calls = stubApi(replies({ 'GET /api/sessions/s-1/current': { body: ALL_ANSWERED() } }))
    await draw()
    expect(text(), '未回答が無いのに問題文が出ている').not.toContain('問題文その1')
    expect(choiceBtns(), '未回答が無いのに選択肢が出ている').toHaveLength(0)
    expect(answers(calls), '未回答が無いのに回答を送っている').toBe(0)
    expect(finishes(calls), '未回答が無いのに締めを頼んでいない').toBeGreaterThan(0)
    expect(path(), '締めが通ったのに結果へ移らない').toMatch(/result/)
    expect(path()).toContain('s-1')
  })

  // @covers REQ-069#correct-count-confirmed
  it('未回答を残して締めると、締めの応答のあとに結果へ移り、確定した正答数が読める', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const calls = stubApi(replies())
    await draw()
    expect(text()).toContain('問題文その1')
    await click(btn(/ここまでで採点/), '「ここまでで採点する」')
    expect(finishes(calls), '締めを頼んでいない').toBe(1)
    expect(path(), '締めたのに結果へ移らない').toMatch(/result/)
    expect(path()).toContain('s-1')
    // 締めた画面に出題は残らない（締めたあとに回答を送る口が無い）
    expect(choiceBtns(), '締めたあとも選択肢が押せる').toHaveLength(0)
    expect(answers(calls)).toBe(0)
  })
})
