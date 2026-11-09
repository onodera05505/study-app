// @vitest-environment jsdom
/** ロードマップ型の論点の画面（src/client/pages/TopicDetail.tsx）の、論点の見出しと副題。UC-009
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、描くたびに差し替えて読み込み直す。
 *  サーバの応答は fetch を偽物にして与える（形は UC-002 の契約 getTopicDetail の response。subtitle を含む）。
 *  見出しは見出しの要素（h1〜h6 か role="heading"）のうち論点の名前を含むもの。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Target = 'itc' | 'eng'
type Over = Record<string, unknown>

const BODY = '短い説明の本文です。'

const detail = (topic: Over) => ({
  topic: {
    id: 231,
    term: '単位 231 の名前',
    subtitle: null,
    explanation: BODY,
    detail: '詳しい解説の本文です。',
    questionCount: 0,
    isNew: 0,
    status: 1,
    field: '業界と仕事',
    major: '業界と仕事',
    middle: 'コンサルの仕事',
    middleNo: 1,
    itemName: 'コンサルの仕事',
    syllabusItemId: 1,
    tier: null,
    ...topic,
  },
  questions: [],
  siblings: [],
  nextTopic: null,
  neighbors: { prev: { id: 230, term: '前の単位の名前' }, next: { id: 232, term: '次の単位の名前' } },
})

function stubApi(topic: Over) {
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    if ((init?.method ?? 'GET') === 'PUT')
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    if (url.pathname.endsWith('/glossary'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: [] }) }
    if (/\/topics\/\d+$/.test(url.pathname))
      return { ok: true, status: 200, text: async () => JSON.stringify(detail(topic)) }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) }
  })
}

async function drawTopic(target: Target) {
  vi.stubEnv('VITE_EXAM', target)
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter, Route, Routes } = await import('react-router-dom')
  const { TopicDetail } = await import('../../src/client/pages/TopicDetail')
  const h = React.createElement
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/topics/231'] },
        h(
          Routes,
          null,
          h(Route, { path: '/topics/:id', element: h(TopicDetail) }),
          h(Route, { path: '/topics', element: h('div', null, 'ロードマップの画面') }),
        ),
      ),
    )
  })
  return {
    host,
    text: () => host.textContent ?? '',
    close: async () => {
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** 論点の名前を含む見出しの要素。 */
function headingOf(host: HTMLElement, term: string) {
  const hs = [...host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter((el) =>
    norm(el.textContent).includes(norm(term)),
  )
  if (!hs.length) throw new Error(`名前「${term}」を含む見出しが無い`)
  return hs[0]
}

/** 文字 needle を含む最も内側の要素。 */
function innermost(host: HTMLElement, needle: string) {
  const all = [...host.querySelectorAll<HTMLElement>('*')].filter((el) => norm(el.textContent).includes(needle))
  return all.find((el) => ![...el.children].some((c) => norm(c.textContent).includes(needle))) ?? null
}

const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('論点の見出しと副題（UC-009）', () => {
  // @covers REQ-416#heading-name-subtitle-beside
  it('副題を持つ論点で、見出しの文字が名前だけになり、副題は見出しの外で、見出しの後ろかつ教材の本文より前に出る', async () => {
    const cases: Array<{ target: Target; topic: Over }> = [
      { target: 'itc', topic: { term: '単位 231 の名前', subtitle: '名前に添える言葉' } },
      { target: 'eng', topic: { term: '章の単位 231', subtitle: '章の単位に添える言葉', tier: 1 } },
    ]
    for (const c of cases) {
      stubApi(c.topic)
      const v = await drawTopic(c.target)
      const term = String(c.topic.term)
      const sub = String(c.topic.subtitle)
      const head = headingOf(v.host, term)
      expect(norm(head.textContent), `${c.target}: 見出しの文字が名前だけでない`).toBe(term)
      const subEl = innermost(v.host, sub)
      expect(subEl, `${c.target}: 副題が画面に無い`).not.toBeNull()
      expect(head.contains(subEl!), `${c.target}: 副題が見出しの中にある`).toBe(false)
      expect(follows(head, subEl!), `${c.target}: 副題が見出しの後ろに出ていない`).toBe(true)
      const bodyEl = innermost(v.host, BODY)
      expect(bodyEl, `${c.target}: 教材の本文が描けていない（この検査は空振りになる）`).not.toBeNull()
      expect(follows(subEl!, bodyEl!), `${c.target}: 副題が教材の本文より後ろにあり、見出しに添えられていない`).toBe(true)
      await v.close()
    }
  })

  // @covers REQ-416#heading-name-only
  it('副題を持たない論点で、見出しの文字が名前だけ（括弧書きを含む名前はそのまま）になり、副題の代わりの文字が出ない', async () => {
    const cases: Array<{ target: Target; term: string }> = [
      { target: 'itc', term: '単位 231 の名前' },
      { target: 'itc', term: '単位 231 の名前（括弧の中も名前）' },
      { target: 'eng', term: '章の単位 231' },
    ]
    for (const c of cases) {
      stubApi({ term: c.term, subtitle: null, tier: c.target === 'eng' ? 1 : null })
      const v = await drawTopic(c.target)
      expect(norm(headingOf(v.host, c.term).textContent), `${c.target}「${c.term}」: 見出しの文字が名前のままでない`).toBe(c.term)
      for (const bad of ['null', 'undefined'])
        expect(v.text(), `${c.target}「${c.term}」: 副題の代わりに「${bad}」が出ている`).not.toContain(bad)
      await v.close()
    }
  })
})
