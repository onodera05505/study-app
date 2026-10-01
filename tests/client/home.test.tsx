// @vitest-environment jsdom
/** ホーム（src/client/pages/Home.tsx）。おすすめ・前回の続き・進行中のテストの案内。
 *
 *  応答の形は scripts/check_api.py の ME・SESSION_CURRENT_SOME と同じ。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Home } from '../../src/client/pages/Home'
import { invalidateCached, setLastTopic } from '../../src/client/lib/api'

type Over = Record<string, unknown>

const me = (over: Over = {}) => ({
  user: { id: 'u-1', name: '小野寺', role: 'MEMBER' },
  topics: { total: 500, understood: 20, partly: 5 },
  recentSessions: [],
  nextTopics: [{ id: 231, term: '頻出の未理解の論点', questionCount: 8, field: 'ストラテジ系' }],
  visits: { today: '2026-09-29', streak: 7, longest: 9, total: 42 },
  ...over,
})

/** 進行中のテスト。問数は他の数字とぶつからない値にしておく。 */
const IN_PROGRESS = {
  session: {
    id: 's-1',
    kind: 'drill',
    scopeLabel: '弱点復習',
    questionCount: 91,
    answered: 37,
    status: 'active',
  },
}

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const hrefs = () => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')

function stubApi(opts: { me?: Over; current?: unknown } = {}) {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    let body: unknown = {}
    if (url.pathname.endsWith('/me')) body = me(opts.me ?? {})
    else if (url.pathname.endsWith('/sessions/current')) body = opts.current ?? { session: null }
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    else if (url.pathname.endsWith('/exams')) body = { exams: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

async function draw(node: ReactNode) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={node} />
          <Route path="/topics" element={<div>論点の一覧</div>} />
          <Route path="/topics/:id" element={<div>論点の画面</div>} />
          <Route path="/practice" element={<div>練習テスト</div>} />
          <Route path="/sessions/:id" element={<div>出題の画面</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('次に学ぶ（UC-003）', () => {
  // @covers REQ-044#home-shows-candidate-with-count-and-field
  it('候補を出題回数と分野つきで出す', async () => {
    stubApi()
    await draw(<Home />)
    expect(text()).toContain('次に学ぶ')
    expect(text()).toContain('頻出の未理解の論点')
    expect(text()).toContain('8')
    expect(text()).toContain('ストラテジ系')
    expect(hrefs()).toContain('/topics/231')
  })

  // @covers REQ-046#home-hides-next-section
  it('候補が無いときはその節ごと出さない', async () => {
    stubApi({ me: { nextTopics: [] } })
    await draw(<Home />)
    expect(text()).not.toContain('次に学ぶ')
  })
})

describe('前回の続き', () => {
  // @verifies REQ-156
  it('覚えた論点があれば、論点名と単元つきの導線を出す', async () => {
    stubApi()
    setLastTopic({ id: 777, term: '前回開いた論点', middle: '事業の指標', middleNo: 4 })
    await draw(<Home />)
    expect(text()).toContain('前回の続き')
    expect(text()).toContain('前回開いた論点')
    expect(text()).toContain('事業の指標')
    expect(hrefs()).toContain('/topics/777')
  })

  // @verifies REQ-156
  it('覚えていないときは前回の続きを出さず、学習の一覧への導線を出す', async () => {
    stubApi()
    await draw(<Home />)
    expect(text()).not.toContain('前回の続き')
    expect(hrefs()).toContain('/topics')
  })
})

describe('進行中のテストの案内', () => {
  // @verifies REQ-244
  it('進行中のテストがあれば、範囲の名前と回答済み／全体を案内し、そのセッションへ戻す', async () => {
    stubApi({ current: IN_PROGRESS })
    await draw(<Home />)
    expect(text()).toContain('進行中のテストがあります')
    expect(text()).toContain('弱点復習')
    expect(text()).toContain('37/91')
    expect(hrefs()).toContain('/sessions/s-1')
  })

  // @verifies REQ-244
  it('進行中のテストが無ければ案内を出さない', async () => {
    stubApi({ current: { session: null } })
    await draw(<Home />)
    expect(text()).not.toContain('進行中のテストがあります')
    expect(text()).not.toContain('37/91')
    expect(hrefs().some((h) => h.startsWith('/sessions/'))).toBe(false)
  })
})
