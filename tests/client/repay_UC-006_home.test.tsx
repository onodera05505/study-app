// @vitest-environment jsdom
/** ホーム（UC-006）の、進行中のテストの有無が取れていないときの案内の落とし方。
 *  fetch を偽物にして本物の React で描く（tests/client/home.test.tsx の作法）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Home } from '../../src/client/pages/Home'
import { invalidateCached } from '../../src/client/lib/api'

const ME = {
  user: { id: 'u-1', name: '小野寺', role: 'MEMBER' },
  topics: { total: 500, understood: 20, partly: 5 },
  recentSessions: [],
  nextTopics: [{ id: 231, term: '頻出の未理解の論点', questionCount: 8, field: 'ストラテジ系' }],
  visits: { today: '2026-09-29', streak: 7, longest: 9, total: 42 },
}

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const hrefs = () => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')

/** 進行中のテストの有無だけが取れない（他の応答は成功）偽の fetch。 */
function stubApiCurrentFails() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    if (url.pathname.endsWith('/sessions/current')) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: '進行中のテストを確認できませんでした' }),
      }
    }
    let body: unknown = {}
    if (url.pathname.endsWith('/me')) body = ME
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    else if (url.pathname.endsWith('/exams')) body = { exams: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

async function draw() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
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
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

describe('ホームの進行中のテストの案内（UC-006）', () => {
  // @covers REQ-093#home-notice-omitted-only
  it('進行中の有無が取れていないときは、進行中の案内だけを落とし、ホームの他の部分は出す', async () => {
    stubApiCurrentFails()
    await draw()
    expect(text()).not.toContain('進行中のテストがあります')
    expect(hrefs().some((h) => h.startsWith('/sessions/')), '取れていないのに戻る導線がある').toBe(false)
    expect(text(), '次に学ぶが落ちている').toContain('次に学ぶ')
    expect(text(), '次に学ぶの候補が落ちている').toContain('頻出の未理解の論点')
    expect(hrefs(), '学習の一覧への導線が落ちている').toContain('/topics')
  })
})
