// @vitest-environment jsdom
/** 論点の教材の画面（src/client/pages/TopicDetail.tsx）の、出題回数の印と前提の論点への導線（UC-002）。
 *  本物の React で描く。
 *
 *  サーバの応答は fetch を偽物にして与える（形と値は contract.yaml の getTopicDetail の examples.ok）。
 *  学びの種類は資格対策。出題回数の印は BR-051 の ★ で読む。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

type Over = Record<string, unknown>

const QUESTION = {
  id: '2018h30a-38',
  number: 38,
  examLabel: '平成30年度秋期',
  text: '公開鍵暗号方式を用いて送信者が受信者宛てのメッセージを暗号化するとき、暗号化に使う鍵はどれか。',
  choices: { ア: '受信者の公開鍵', イ: '受信者の秘密鍵', ウ: '送信者の公開鍵', エ: '送信者の秘密鍵' },
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: '平成30年度秋期 問38',
  modified: 0,
  timesAsked: 1,
  otherCitations: [],
  explanation: null,
}

const EXPLANATION = '暗号化する鍵と復号する鍵を分け、暗号化する側の鍵を公開してよい方式。'

const detail = (over: Over = {}) => {
  const { topic: topicOver, ...rest } = over
  return {
    topic: {
      id: 418,
      term: '公開鍵暗号方式',
      subtitle: null,
      explanation: EXPLANATION,
      detail: null,
      questionCount: 9,
      frequencyTier: 3,
      isNew: 0,
      status: 2,
      statusSource: 'override',
      field: 'テクノロジ系',
      major: '技術要素',
      middle: 'セキュリティ',
      middleNo: 12,
      itemName: '暗号技術',
      tier: null,
      ...((topicOver as Over | undefined) ?? {}),
    },
    questions: [QUESTION],
    prerequisites: [],
    siblings: [],
    nextTopic: null,
    neighbors: null,
    ...rest,
  }
}

let container: HTMLElement
let root: Root

const squash = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
const text = () => squash(container.textContent)
const anchors = () => [...container.querySelectorAll<HTMLAnchorElement>('a')]

function stubApi(body: unknown) {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const payload = /\/topics\/\d+$/.test(url.pathname) ? body : url.pathname.endsWith('/glossary') ? { glossary: [] } : {}
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
  })
}

async function draw(body: unknown) {
  await act(async () => {
    root.render(null)
  })
  invalidateCached()
  stubApi(body)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/topics/418']}>
        <Routes>
          <Route path="/topics/:id" element={<TopicDetail />} />
          <Route path="/topics" element={<div>論点の一覧</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

/** 画面に出た出題回数の印の段（★ の連なりの最長。無ければ 0）。 */
const tierIn = (t: string) => Math.max(0, ...(t.match(/★+/g) ?? []).map((s) => s.length))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('論点の教材の出題回数の印（UC-002）', () => {
  // @covers REQ-478#mark-on-material
  it('論点の教材の画面に、論点の出題頻度とともに印の段の数だけ ★ を添え、段の無い論点には添えない', async () => {
    // 前提の論点・他の論点を持たせず、画面に出る ★ を論点自身の印だけにする
    for (const [questionCount, frequencyTier] of [
      [9, 3],
      [2, 2],
      [1, 1],
      [0, null],
    ] as const) {
      await draw(detail({ topic: { questionCount, frequencyTier } }))
      expect(text()).toContain(EXPLANATION)
      expect(text(), `出題頻度 ${questionCount} が示されていない`).toMatch(new RegExp(`(^|\\D)${questionCount}(\\D|$)`))
      expect(tierIn(text()), `出題頻度 ${questionCount} の論点の印の段が違う`).toBe(frequencyTier ?? 0)
    }
  })
})

describe('前提の論点への導線（UC-002）', () => {
  // @covers REQ-479#prerequisite-links
  it('前提の論点を、教材とともに、渡された順に名前つきで、その論点の教材へ移る導線として示す', async () => {
    // 渡された順（単元の構成に書かれた順）は ID の順とも名前の順とも違う
    const prerequisites = [
      { id: 425, term: 'ハッシュ関数', questionCount: 3, frequencyTier: 3 },
      { id: 419, term: '共通鍵暗号方式', questionCount: 7, frequencyTier: 3 },
    ]
    await draw(detail({ prerequisites }))
    expect(text(), '教材が示されていない').toContain(EXPLANATION)
    for (const p of prerequisites) {
      const link = anchors().find((a) => a.getAttribute('href') === `/topics/${p.id}`)
      expect(link, `前提の論点「${p.term}」の教材へ移る導線が無い`).toBeTruthy()
      expect(squash(`${link!.textContent ?? ''} ${link!.getAttribute('aria-label') ?? ''}`), '導線に前提の論点の名前が無い').toContain(
        p.term,
      )
    }
    const order = anchors()
      .map((a) => a.getAttribute('href'))
      .filter((h) => prerequisites.some((p) => h === `/topics/${p.id}`))
    expect([...new Set(order)], '前提の論点が渡された順に示されていない').toEqual(prerequisites.map((p) => `/topics/${p.id}`))
  })
})

describe('同じまとまりの他の論点が無いとき（UC-002）', () => {
  // @covers REQ-023#no-siblings-no-section
  it('他の論点が無い論点では、他の論点の欄を示さない', async () => {
    // 他の論点がある論点では、その名前と行き先が出ることを先に確かめ、無いことの照合が空振りしないようにする
    const sibling = { id: 421, term: 'ディジタル署名', questionCount: 6, frequencyTier: 3 }
    await draw(detail({ siblings: [sibling] }))
    expect(text()).toContain(sibling.term)
    expect(anchors().some((a) => a.getAttribute('href') === `/topics/${sibling.id}`)).toBe(true)
    // 他の論点が無い論点
    await draw(detail({ siblings: [] }))
    expect(text(), '教材が示されていない').toContain(EXPLANATION)
    expect(text(), '他の論点が無いのに他の論点の名前が出ている').not.toContain(sibling.term)
    expect(
      anchors().some((a) => a.getAttribute('href') === `/topics/${sibling.id}`),
      '他の論点が無いのに他の論点への導線が出ている',
    ).toBe(false)
  })
})

describe('前提の論点を持たない論点（UC-002）', () => {
  // @covers REQ-479#no-prerequisites-no-section
  it('前提の論点を持たない論点では、教材を示し、前提の論点の欄を示さない', async () => {
    // 前提の論点を持つ論点では欄が出ること（「前提の論点」の語）を先に確かめ、語の照合が空振りしないようにする
    await draw(detail({ prerequisites: [{ id: 419, term: '共通鍵暗号方式', questionCount: 7, frequencyTier: 3 }] }))
    expect(text(), '前提の論点を持つ論点に「前提の論点」の欄が無い').toContain('前提の論点')
    await draw(detail({ prerequisites: [] }))
    expect(text(), '教材が示されていない').toContain(EXPLANATION)
    expect(text(), '前提の論点を持たない論点に前提の論点の欄が出ている').not.toContain('前提の論点')
  })
})
