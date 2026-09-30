// @vitest-environment jsdom
/** UC-016「利用者が前回開いていた論点・画面にすぐ戻れる」の基本の流れを 1 本で実行する写し
 *  （正常系のみ。覚えた値が壊れているときは REQ-158 のテストが見る）。
 *
 *  step 4 の「ホーム（ロードマップ型はロードマップの先頭）」は資格版とロードマップ型で
 *  別の画面になるので、同じ流れ（単位を開いて覚えさせる → 先頭の導線を見る）を
 *  対象を替えてもう一度辿る。
 *  画面の文字は要件（REQ-040・REQ-156・REQ-157）の文面から採る。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

/** 最後に開く論点（単位）。ID・名前・単元名・単元の番号を覚える決まり（REQ-040）。 */
const TOPIC = { id: 231, term: '前回開いた論点', middle: '事業の指標', middleNo: 4 }

const DETAIL = {
  topic: {
    id: TOPIC.id,
    term: TOPIC.term,
    explanation: `${TOPIC.term} の短い説明です。`,
    detail: null,
    questionCount: 0,
    isNew: 0,
    status: null,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: TOPIC.middle,
    middleNo: TOPIC.middleNo,
    itemName: '会計と財務',
    syllabusItemId: 3,
  },
  questions: [],
  siblings: [],
  nextTopic: null,
  neighbors: { prev: null, next: null },
}

/** ロードマップ型の単位の一覧（覚えた単位を含む）。 */
const UNITS = [
  { id: TOPIC.id, term: TOPIC.term, questionCount: 2, status: null, field: '業界と仕事', middle: 'コンサルの仕事', itemName: 'コンサルの仕事', isNew: 0, sortOrder: 1 },
  { id: 232, term: '次の単位', questionCount: 2, status: null, field: '業界と仕事', middle: 'コンサルの仕事', itemName: 'コンサルの仕事', isNew: 0, sortOrder: 2 },
]

/** おすすめは空にしておく（「次に学ぶ」と「前回の続き」を混ぜないため）。 */
const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 2, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 3, longest: 3, total: 3 },
}

function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (/\/topics\/\d+$/.test(p)) body = DETAIL
    else if (p.endsWith('/topics')) body = { topics: UNITS }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

/** 端末に入っている値（鍵の名前は仕様ではないので値だけを見る）。 */
const storedValues = (s: Storage) =>
  Array.from({ length: s.length }, (_, i) => s.getItem(s.key(i)!) ?? '').join(' ')

let host: HTMLElement
let root: Root | null = null

const text = () => (host.textContent ?? '').replace(/\s+/g, ' ')
const hrefs = () => [...host.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')

/** 資格版（既定の対象）で App を描く（毎回根を作り直す）。 */
async function openShikaku(entry: string) {
  await closeShikaku()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.history.replaceState({}, '', entry)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(App)))
  })
}
async function closeShikaku() {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
}

type View = { text: () => string; hrefs: () => string[]; close: () => Promise<void> }
let view: View | null = null

/** ロードマップ型（VITE_EXAM=itc）で読み込み直して App を描く。 */
async function openRoadmap(entry: string): Promise<View> {
  if (view) await view.close()
  vi.stubEnv('VITE_EXAM', 'itc')
  vi.resetModules()
  const React = await import('react')
  const { createRoot: create } = await import('react-dom/client')
  const { MemoryRouter: Router } = await import('react-router-dom')
  const api = await import('../../src/client/lib/api')
  api.setToken('token-for-scenario')
  const { App: RoadmapApp } = await import('../../src/client/App')
  const el = document.createElement('div')
  document.body.appendChild(el)
  const r = create(el)
  window.history.replaceState({}, '', entry)
  await React.act(async () => {
    r.render(React.createElement(Router, { initialEntries: [entry] }, React.createElement(RoadmapApp)))
  })
  view = {
    text: () => (el.textContent ?? '').replace(/\s+/g, ' '),
    hrefs: () => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? ''),
    close: async () => {
      await React.act(async () => r.unmount())
      el.remove()
    },
  }
  return view
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  stubApi()
  setToken('token-for-scenario')
})

afterEach(async () => {
  await closeShikaku()
  if (view) {
    await view.close()
    view = null
  }
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('UC-016 前回の続きに戻る', () => {
  // @scenario UC-016
  it('論点の画面を開くと端末が覚え、資格版のホームとロードマップの先頭が前回の続きの導線になる', async () => {
    // 1. 利用者が論点の画面を開く。画面はその論点を「前回の続き」として覚える
    await openShikaku(`/topics/${TOPIC.id}`)
    expect(text(), '論点の画面が出ていない').toContain(`${TOPIC.term} の短い説明です。`)

    // 2. 画面は最後に開いた論点（ID・名前・単元）を端末に保存する
    const stored = storedValues(localStorage)
    expect(stored, '論点の名前を端末に覚えていない').toContain(TOPIC.term)
    expect(stored, '論点の ID を端末に覚えていない').toContain(String(TOPIC.id))
    expect(stored, '単元名を端末に覚えていない').toContain(TOPIC.middle)
    expect(stored, '単元の番号を端末に覚えていない').toContain(String(TOPIC.middleNo))

    // 3. 画面は覚えた論点を読み出す（開き直しても端末の値から組み立てる）
    // 4. 利用者がホーム（ロードマップ型はロードマップの先頭）を開く。画面は覚えた論点があれば
    //    「前回の続き」の導線を出す（まず資格版のホームで見る）
    await openShikaku('/')
    expect(text(), 'ホームに「前回の続き」が出ていない').toContain('前回の続き')
    expect(text()).toContain(TOPIC.term)
    expect(text(), '前回の続きに単元が出ていない').toContain(TOPIC.middle)
    expect(hrefs()).toContain(`/topics/${TOPIC.id}`)

    // 4. 同じ step を、ロードマップ型のロードマップの先頭でもう一度辿る
    //    （1・2 と同じように、まず単位を開いて覚えさせる）
    await closeShikaku()
    await openRoadmap(`/topics/${TOPIC.id}`)
    const map = await openRoadmap('/topics')
    expect(map.text(), 'ロードマップの先頭に「前回の続きから」が出ていない').toContain('前回の続きから')
    expect(map.text()).toContain(TOPIC.term)
    expect(map.hrefs()).toContain(`/topics/${TOPIC.id}`)

    // 事後条件: 端末に最後に開いた論点が残り、次に開いたときの導線になっている
    expect(storedValues(localStorage), '覚えた論点が端末から消えている').toContain(TOPIC.term)
  })
})
