// @vitest-environment jsdom
/** 次に学ぶの候補が無いときの論点の画面（UC-003）。本物の React で描く。
 *  サーバの応答は fetch を偽物にして与える（形は UC-002 の契約の getTopicDetail の response。
 *  候補が無いことは nextTopic が null であることで表す）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

const DETAIL = {
  topic: {
    id: 231,
    term: 'LTV',
    explanation: '短い説明の本文です。',
    detail: null,
    questionCount: 1,
    isNew: 0,
    status: 3,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '事業の指標',
    middleNo: 4,
    itemName: '会計と財務',
    tier: null,
  },
  questions: [
    {
      id: '2024r06-q1',
      number: 1,
      examLabel: '令和6年度',
      text: '過去問 1 の本文です。',
      choices: { ア: 'ア', イ: 'イ', ウ: 'ウ', エ: 'エ' },
      answer: 'ア',
      hasFigure: 0,
      figureDescription: null,
      figureImage: null,
      citation: '出典：令和6年度 ITパスポート試験 問1',
      modified: 0,
      timesAsked: 1,
      otherCitations: [],
      explanation: null,
    },
  ],
  siblings: [],
  nextTopic: null,
  neighbors: null,
}

let container: HTMLElement
let root: Root

const text = () => (container.textContent ?? '').replace(/\s+/g, ' ')

function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    let body: unknown = {}
    if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    else if (/\/topics\/\d+$/.test(url.pathname)) body = DETAIL
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
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
})

describe('次に学ぶの候補が無い論点の画面（UC-003）', () => {
  // @covers REQ-269#detail-tells-finished
  it('候補が無いときは、頻出の論点をひととおり学び終えたことを示す', async () => {
    stubApi()
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/topics/231']}>
          <Routes>
            <Route path="/topics/:id" element={<TopicDetail />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    expect(text(), '論点の画面が出ていない').toContain('短い説明の本文です。')
    expect(text(), '学び終えたことが示されていない').toMatch(/学び終え|ひととおり|一通り|すべて学ん|全部学ん/)
  })
})
