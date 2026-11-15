// @vitest-environment jsdom
/** UC-005「前回の続きから論点へ戻る」の主シナリオ 1〜6 を 1 本で実行する写し
 *  （正常系のみ。事前条件どおり資格版の学びで辿る。覚えた値が壊れているとき・論点がもう無いときは要件のテストが見る）。
 *  導線は用語集の「前回の続き」の語と論点名で探す。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

/** 最後に開く論点。ID・名前・単元名・単元の番号を端末に覚える（BR-012）。 */
const TOPIC = { id: 231, term: '前回開いた論点', middle: '事業の指標', middleNo: 4 }

const DETAIL = {
  topic: {
    id: TOPIC.id,
    term: TOPIC.term,
    subtitle: null,
    explanation: `${TOPIC.term} の短い説明です。`,
    detail: null,
    questionCount: 0,
    frequencyTier: null,
    isNew: 0,
    status: 0,
    statusSource: 'auto',
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: TOPIC.middle,
    middleNo: TOPIC.middleNo,
    itemName: '会計と財務',
    tier: null,
  },
  questions: [],
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
}

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
    else if (p.endsWith('/topics')) body = { topics: [] }
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

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  stubApi()
  setToken('token-for-scenario')
})

afterEach(async () => {
  await closeShikaku()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** 「前回の続き」の語と覚えた論点名を持つ導線（用語集の語で探す）。 */
const resumeLink = () =>
  [...host.querySelectorAll('a')].find((a) => {
    const t = a.textContent ?? ''
    return t.includes('前回の続き') && t.includes(TOPIC.term)
  })

describe('UC-005 前回の続きに戻る', () => {
  // @scenario UC-005
  it('論点の画面を開くと端末が覚え、開き直したホームの前回の続きの導線を選ぶとその論点の画面が開く', async () => {
    // step 1: 利用者が論点の画面を開く
    await openShikaku(`/topics/${TOPIC.id}`)
    expect(text(), '論点の画面が出ていない').toContain(`${TOPIC.term} の短い説明です。`)

    // step 2: システムが、その論点（ID・名前・単元）を前回の続きとして端末に覚える
    const stored = storedValues(localStorage)
    expect(stored, '論点の名前を端末に覚えていない').toContain(TOPIC.term)
    expect(stored, '論点の ID を端末に覚えていない').toContain(String(TOPIC.id))
    expect(stored, '単元名を端末に覚えていない').toContain(TOPIC.middle)
    expect(stored, '単元の番号を端末に覚えていない').toContain(String(TOPIC.middleNo))

    // step 3: 利用者が学びを開き直し、ホームを開く
    await openShikaku('/')
    expect(text(), 'ホームの論点の画面の説明が出たまま（ホームが開いていない）').not.toContain(`${TOPIC.term} の短い説明です。`)

    // step 4: システムが、覚えた論点名と単元を添えた前回の続きの導線を出す
    expect(text(), 'ホームに「前回の続き」が出ていない').toContain('前回の続き')
    expect(text(), '前回の続きに単元が出ていない').toContain(TOPIC.middle)
    const link = resumeLink()
    expect(link, '覚えた論点名を持つ前回の続きの導線が無い').toBeTruthy()

    // step 5: 利用者がその導線を選ぶ
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })

    // step 6: システムが、覚えた論点の画面を開く
    expect(text(), '前回の続きの導線を選んでも、覚えた論点の画面が開かない').toContain(`${TOPIC.term} の短い説明です。`)

    // 事後条件: 最後に開いた論点が端末に残っている
    expect(storedValues(localStorage), '覚えた論点が端末から消えている').toContain(TOPIC.term)
  })
})
