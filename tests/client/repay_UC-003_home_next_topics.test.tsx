// @vitest-environment jsdom
/** ホーム（src/client/pages/Home.tsx）の次に学ぶ（UC-003）。候補の順・取得が届かないとき・
 *  理解度の記録のあとに候補を取り直すこと。本物の React で描く。
 *
 *  サーバの応答は fetch を偽物にして与える（形は contract.yaml の getHomeSummary の response）。
 *  記録のあとの取り直しは、論点の画面（TopicDetail）で記録してからホームを描き直し、
 *  記録の後の候補が出ることで見る。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Home } from '../../src/client/pages/Home'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

type Over = Record<string, unknown>
type Candidate = { id: number; term: string; questionCount: number; field: string }

const me = (over: Over = {}) => ({
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 500, understood: 20, partly: 5 },
  recentSessions: [],
  nextTopics: [{ id: 231, term: '頻出の未理解の論点', questionCount: 8, field: 'ストラテジ系' }],
  visits: { today: '2026-10-01', streak: 4, longest: 11, total: 37 },
  ...over,
})

/** 論点の画面の応答（記録する論点 231。記録なし）。 */
const detail = () => ({
  topic: {
    id: 231,
    term: '記録する論点',
    explanation: '短い説明の本文です。',
    detail: null,
    questionCount: 8,
    isNew: 0,
    status: null,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '事業の指標',
    middleNo: 4,
    itemName: '会計と財務',
    tier: null,
  },
  questions: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
})

const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
})

let container: HTMLElement
let root: Root
let calls: Array<{ path: string; method: string }>

const text = () => container.textContent ?? ''
const hrefs = () => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
const countOf = (path: string, method = 'GET') =>
  calls.filter((c) => c.path.endsWith(path) && c.method === method).length

/** 応答を決める偽の fetch。`meBody` は呼ばれるたびに評価する（記録の前後で変えられる）。 */
function stubApi(meBody: () => unknown, onRecord: () => void = () => {}) {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ path: url.pathname, method })
    if (method === 'PUT' && url.pathname.includes('/progress')) {
      onRecord()
      return json({ ok: true, status: 3 })
    }
    if (url.pathname.endsWith('/me')) return meBody()
    if (/\/topics\/\d+$/.test(url.pathname)) return json(detail())
    if (url.pathname.endsWith('/sessions/current')) return json({ session: null })
    if (url.pathname.endsWith('/glossary')) return json({ glossary: [] })
    if (url.pathname.endsWith('/exams')) return json({ exams: [] })
    return json({})
  })
}

/** 画面を描き直す（前の画面は閉じる。MemoryRouter は描いたときの場所で始まる）。 */
async function draw(node: ReactNode, entry: string) {
  await act(async () => {
    root.render(null)
  })
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={node} />
          <Route path="/topics/:id" element={node} />
          <Route path="/topics" element={<div>論点の一覧</div>} />
          <Route path="/practice" element={<div>練習テスト</div>} />
          <Route path="/sessions/:id" element={<div>出題の画面</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

/** 理解度の 3 段階のうち、段階の文字がちょうど一致する操作を押す。 */
async function pressStage(label: string) {
  const b = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (x) => (x.textContent ?? '').trim() === label,
  )
  if (!b) throw new Error(`理解度「${label}」の操作が画面に無い`)
  await act(async () => {
    b.click()
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
  sessionStorage.clear()
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('ホームの次に学ぶ（UC-003）', () => {
  /** 返った順。ID の昇順でも名前の順でもなく、出題回数は同じ（画面が並べ直せない）。 */
  const ORDERED: Candidate[] = [
    { id: 52, term: '甲の論点', questionCount: 6, field: 'ストラテジ系' },
    { id: 17, term: '乙の論点', questionCount: 6, field: 'マネジメント系' },
    { id: 88, term: '丙の論点', questionCount: 6, field: 'テクノロジ系' },
  ]

  // @covers REQ-044#home-keeps-candidate-order
  it('候補が複数あるとき、返った候補の順のまま上から出す', async () => {
    stubApi(() => json(me({ nextTopics: ORDERED })))
    await draw(<Home />, '/')
    const positions = ORDERED.map((c) => text().indexOf(c.term))
    expect(positions.every((p) => p >= 0), `候補が全部出ていない: ${positions.join(',')}`).toBe(true)
    expect(positions, '候補の順が返った順と違う').toEqual([...positions].sort((a, b) => a - b))
    const links = hrefs().filter((h) => ORDERED.some((c) => h === `/topics/${c.id}`))
    expect(links).toEqual(ORDERED.map((c) => `/topics/${c.id}`))
  })

  // @covers REQ-047#fetch-failure-not-shown-as-empty
  it('候補の取得が届かなかったときは、候補が無いときの示し方にせず、取れていないことを示す', async () => {
    const REASON = 'ホームの集計を取得できませんでした'
    stubApi(() => json({ error: REASON }, 500))
    await draw(<Home />, '/')
    // 候補が無いときは次に学ぶの節ごと出さない（REQ-046）。届かなかったときは同じ姿にしない
    expect(text(), '取得の失敗の理由が示されていない（空のときと見分けがつかない）').toContain(REASON)
    expect(hrefs().some((h) => /^\/topics\/\d+$/.test(h)), '取れていないのに候補の導線が出ている').toBe(false)
  })

  // @covers REQ-040#next-topics-refetched-after-record
  it('理解度を記録したあとに開いたホームは、候補を取り直して記録を反映した値を出す', async () => {
    const BEFORE: Candidate = { id: 231, term: '記録する論点', questionCount: 8, field: 'ストラテジ系' }
    const AFTER: Candidate = { id: 555, term: '記録のあとの候補', questionCount: 6, field: 'ストラテジ系' }
    let recorded = false
    stubApi(
      () => json(me({ nextTopics: recorded ? [AFTER] : [BEFORE] })),
      () => {
        recorded = true
      },
    )
    await draw(<Home />, '/')
    expect(text()).toContain(BEFORE.term)
    expect(text()).not.toContain(AFTER.term)
    const fetched = countOf('/me')

    await draw(<TopicDetail />, '/topics/231')
    await pressStage('理解')
    expect(countOf('/progress', 'PUT'), '理解度が記録されていない').toBe(1)

    await draw(<Home />, '/')
    expect(countOf('/me'), '記録のあとにホームが候補を取り直していない').toBeGreaterThan(fetched)
    expect(text(), '記録のあとの候補が出ていない（記録の前の候補のまま）').toContain(AFTER.term)
    expect(hrefs()).toContain(`/topics/${AFTER.id}`)
  })
})
