// @vitest-environment jsdom
/** 練習テストの画面（UC-006）の、進行中のテストの案内の有無・再開・破棄の了承と取り消し・有無の取得の失敗。
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

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown }
type Call = { url: string; method: string }

/** 「<メソッド> <path>」ごとに応答を決める偽の fetch。呼ばれた (url, method) を集める。 */
function stubApi(replyOf: (key: string) => Reply) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method })
    const reply = replyOf(`${method} ${u.split('?')[0]}`)
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
/** 進行中のテスト（契約 getCurrentSession の例 okInProgress の値）。 */
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

/** 一覧は [] ・進行中は null。どの一覧を引かれても「空」で返す（未取得と空を混ぜない）。 */
const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

/** 画面が引きうる一覧の既定。テストごとに要る「<メソッド> <path>」だけ上書きする。 */
function replies(over: Record<string, Reply> = {}): (key: string) => Reply {
  const base: Record<string, Reply> = {
    'GET /api/fields': { body: FIELDS },
    'GET /api/categories': { body: { categories: [] } },
    'GET /api/topics': { body: { topics: [] } },
    'GET /api/sessions/current': { body: { session: null } },
    'DELETE /api/sessions/current': { body: { ok: true } },
    ...over,
  }
  return (key) => base[key] ?? { body: EMPTY }
}

const Where = () => h('div', null, `PATH:${useLocation().pathname}`)
const path = () => (text().match(/PATH:(\/\S*)/) ?? [])[1] ?? ''

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

const discards = (calls: Call[]) => calls.filter((c) => c.method === 'DELETE' && c.url === '/api/sessions/current')

describe('練習テストの画面（UC-006。進行中のテストの案内・再開・破棄）', () => {
  // @covers REQ-084#practice-no-notice
  it('進行中のテストが無いと取れたときは、進行中の案内も再開・破棄の導線も出さない', async () => {
    stubApi(replies({ 'GET /api/sessions/current': { body: { session: null } } }))
    await draw()
    expect(text(), '範囲の一覧が出ていない（画面が描けていない）').toContain('テクノロジ系')
    expect(text()).not.toContain(IN_PROGRESS.session.scopeLabel)
    expect(text()).not.toMatch(/進行中のテスト/)
    expect(btn(/再開/), '進行中が無いのに再開の導線がある').toBeUndefined()
    expect(btn(/破棄/), '進行中が無いのに破棄の導線がある').toBeUndefined()
  })

  // @covers REQ-088#resume-moves-to-session
  it('再開を選ぶと、その進行中のテストの出題へ移る', async () => {
    stubApi(replies({ 'GET /api/sessions/current': { body: IN_PROGRESS } }))
    await draw()
    await click(btn(/再開/), '「再開する」')
    expect(path()).toMatch(new RegExp(`^/sessions?/${IN_PROGRESS.session.id}(/|$)`))
  })

  // @covers REQ-090#discard-on-consent
  it('破棄の確認を了承すると、破棄が頼まれる', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const calls = stubApi(replies({ 'GET /api/sessions/current': { body: IN_PROGRESS } }))
    await draw()
    expect(discards(calls), '押す前から破棄が頼まれている').toEqual([])
    await click(btn(/破棄/), '「破棄する」')
    expect(discards(calls).length, '了承したのに破棄が頼まれていない').toBe(1)
  })

  // @covers REQ-091#cancel-keeps-session
  it('破棄の確認を取り消すと、破棄は頼まれず、進行中の案内と再開・破棄の導線が残る', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const calls = stubApi(replies({ 'GET /api/sessions/current': { body: IN_PROGRESS } }))
    await draw()
    await click(btn(/破棄/), '「破棄する」')
    expect(confirm, '確認を取っていない（取り消す機会が無い）').toHaveBeenCalled()
    expect(discards(calls), '取り消したのに破棄が頼まれている').toEqual([])
    expect(text(), '進行中の案内が消えている').toContain(IN_PROGRESS.session.scopeLabel)
    expect(btn(/再開/), '再開の導線が消えている').toBeTruthy()
    expect(btn(/破棄/), '破棄の導線が消えている').toBeTruthy()
  })

  // @covers REQ-094#current-failed-on-practice
  it('進行中のテストの有無の取得に失敗したときは、失敗したことを示し、読み直す手段を添える', async () => {
    stubApi(
      replies({
        'GET /api/sessions/current': { status: 500, body: { error: '進行中のテストを確認できませんでした' } },
      }),
    )
    await draw()
    expect(text()).toMatch(/確認できていません|確認できません|取得できません|取れません|失敗/)
    expect(btn(/再読み込み|読み直/), '読み直す手段が無い').toBeTruthy()
    // 取れていないのに「無い」と見せない（再開・破棄の導線は出ないが、進行中が無いという案内にもならない）
    expect(btn(/再開/), '取れていないのに再開の導線がある').toBeUndefined()
    expect(btn(/破棄/), '取れていないのに破棄の導線がある').toBeUndefined()
  })
})
