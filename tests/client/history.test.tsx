// @vitest-environment jsdom
/** 履歴の画面（完了したテストの一覧と結果への導線・取得前と空と失敗の区別）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { History } from '../../src/client/pages/History'
import { invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const btn = (re: RegExp) => els('button,a,[role="button"]').find((b) => re.test(b.textContent ?? ''))
/** その文字列を持つ、いちばん内側の要素（＝一覧の行）。 */
const innermost = (s: string) =>
  els('*')
    .filter((e) => (e.textContent ?? '').includes(s))
    .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown; wait?: Promise<unknown> }

function stubApi(reply: Reply) {
  vi.stubGlobal('fetch', async () => {
    if (reply.wait) await reply.wait
    const status = reply.status ?? 200
    return { ok: status < 400, status, text: async () => JSON.stringify(reply.body ?? {}) }
  })
}

const HISTORY = {
  sessions: [
    {
      id: 's-1',
      kind: 'field',
      scopeLabel: '分野「テクノロジ系」',
      questionCount: 20,
      correctCount: 15,
      startedAt: 1789000000000,
      finishedAt: 1789003600000,
      sourceExam: null,
    },
  ],
}

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
        { initialEntries: ['/history'] },
        h(
          Routes,
          null,
          h(Route, { path: '/history', element: h(History) }),
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

describe('履歴の画面', () => {
  // @verifies REQ-233
  it('種別の表示名・範囲・正答率・日時を一覧し、押すと結果の画面へ移る', async () => {
    stubApi({ body: HISTORY })
    await draw()
    expect(text()).toContain('分野「テクノロジ系」')
    expect(text(), '種別が内部の値のまま出ている').not.toContain('field')
    expect(text(), '正答率が割合の単位つきで出ていない').toMatch(/75\s*%/)
    expect(text()).toContain('15')
    expect(text()).toContain('20')
    expect(text(), '日時が出ていない').toMatch(/\d{4}[-/年]/)
    await click(innermost('分野「テクノロジ系」'), '履歴の行')
    expect(path()).toMatch(/result/)
    expect(path()).toContain('s-1')
  })

  // @verifies REQ-235
  it('取得前は読み込み中とし、完了したテストが無いときだけ履歴が無いことを伝える', async () => {
    stubApi({ body: HISTORY, wait: new Promise(() => {}) })
    await draw()
    expect(text(), '取得前に読み込み中と分からない').toMatch(/読み込み/)
    expect(text()).not.toContain('分野「テクノロジ系」')

    stubApi({ body: { sessions: [] } })
    await draw()
    expect(text(), '空のときに読み込み中のままになっている').not.toMatch(/読み込み/)
    expect(text(), '空のときに何も伝えていない').not.toBe('')
  })

  // @verifies REQ-235
  it('取得に失敗したときは理由と読み直しを出す', async () => {
    stubApi({ status: 500, body: { error: '履歴を取得できませんでした' } })
    await draw()
    expect(text()).toMatch(/取得できません|取れません|失敗/)
    expect(btn(/再読み込み|読み直/), '読み直しの導線が無い').toBeTruthy()
  })
})
