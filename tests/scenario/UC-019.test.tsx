// @vitest-environment jsdom
/** UC-019「ロードマップ型で、論点の詳細から学ぶ順の前後の単位へ移る」の基本の流れを
 *  1 本で実行する写し（正常系のみ。端の単位は REQ-153 のテストが見る）。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、ロードマップ型にしてから読み込み直して描く。
 *  ロードマップ型ではロードマップが /topics に載る。
 *  画面の文字は要件（REQ-150〜REQ-152）の文面から採る。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 4 単位（学ぶ順）。真ん中の「単位 乙」から前後へ移る。 */
const UNIT = [
  { id: 101, term: '単位 甲' },
  { id: 102, term: '単位 乙' },
  { id: 103, term: '単位 丙' },
  { id: 104, term: '単位 丁' },
]

const unitRow = (i: number) => ({
  id: UNIT[i].id,
  term: UNIT[i].term,
  questionCount: 2,
  status: null,
  field: '業界と仕事',
  middle: 'コンサルの仕事',
  itemName: 'コンサルの仕事',
  isNew: 0,
  sortOrder: i + 1,
})

/** ロードマップ型でも同じ小項目の他の論点・次に学ぶは応答に入れておく（画面が出さないことを見る）。 */
const SIBLING = '同じ小項目の他の論点'
const NEXT_TOPIC = '次に学ぶ論点の候補'

const detail = (i: number) => ({
  topic: {
    id: UNIT[i].id,
    term: UNIT[i].term,
    explanation: `${UNIT[i].term} の短い説明です。`,
    detail: null,
    questionCount: 0,
    isNew: 0,
    status: null,
    field: '業界と仕事',
    major: '業界と仕事',
    middle: 'コンサルの仕事',
    middleNo: 1,
    itemName: 'コンサルの仕事',
    syllabusItemId: 1,
  },
  questions: [],
  siblings: [{ id: 999, term: SIBLING, questionCount: 3 }],
  nextTopic: { id: 998, term: NEXT_TOPIC, questionCount: 5, field: '業界と仕事' },
  // 学ぶ順の隣の単位（ID と名前）
  neighbors: {
    prev: i > 0 ? { id: UNIT[i - 1].id, term: UNIT[i - 1].term } : null,
    next: i < UNIT.length - 1 ? { id: UNIT[i + 1].id, term: UNIT[i + 1].term } : null,
  },
})

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 4, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 2, longest: 2, total: 2 },
}

let calls: string[] = []
const countOf = (part: string) => calls.filter((u) => u.includes(part)).length

function stubApi() {
  calls = []
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    calls.push(p + url.search)
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'itc' }
    else if (/\/topics\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop())
      const i = UNIT.findIndex((u) => u.id === id)
      body = detail(i < 0 ? 0 : i)
    } else if (p.endsWith('/topics')) body = { topics: UNIT.map((_, i) => unitRow(i)) }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

const CONTROLS = 'button, [role="button"], summary, a'
const trimmed = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

type View = {
  text: () => string
  anchors: () => HTMLAnchorElement[]
  press: (name: string | RegExp) => Promise<void>
  close: () => Promise<void>
}
let view: View | null = null

/** ロードマップ型（VITE_EXAM=itc）で読み込み直して App を描く。 */
async function open(entry: string): Promise<View> {
  if (view) await view.close()
  vi.stubEnv('VITE_EXAM', 'itc')
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const api = await import('../../src/client/lib/api')
  api.setToken('token-for-scenario')
  const { App } = await import('../../src/client/App')
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  window.history.replaceState({}, '', entry)
  await React.act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(App)))
  })
  view = {
    text: () => (el.textContent ?? '').replace(/\s+/g, ' '),
    anchors: () => [...el.querySelectorAll('a')] as HTMLAnchorElement[],
    press: async (name) => {
      const els = [...el.querySelectorAll<HTMLElement>(CONTROLS)].filter((x) =>
        typeof name === 'string' ? trimmed(x).includes(name) : name.test(trimmed(x)),
      )
      const target =
        (typeof name === 'string' ? els.find((x) => trimmed(x) === String(name)) : undefined) ?? els[0]
      if (!target) throw new Error(`「${name}」の操作が画面に無い`)
      await React.act(async () => {
        target.click()
      })
    },
    close: async () => {
      await React.act(async () => root.unmount())
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
})

afterEach(async () => {
  if (view) {
    await view.close()
    view = null
  }
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('UC-019 ロードマップ型で前後の単位へ移る', () => {
  // @scenario UC-019
  it('ロードマップから単位を開き、末尾の「次の単位 →」で学ぶ順の隣へ進む', async () => {
    // 1. 利用者がロードマップから単位を開く。システムは学ぶ順の前後の単位を添えて返す
    const v = await open('/topics')
    await v.press(UNIT[1].term)
    expect(countOf(`/api/topics/${UNIT[1].id}`), '開いた単位を取りに行っていない').toBe(1)
    expect(v.text(), '単位の画面が出ていない').toContain(`${UNIT[1].term} の短い説明です。`)

    // 2. 画面は本文の末尾に「← 前の単位」「次の単位 →」を単位名つきで出し、押すとその単位の詳細へ移す
    const body = v.text()
    expect(body, '前の単位の案内が無い').toContain('前の単位')
    expect(body, '次の単位の案内が無い').toContain('次の単位')
    expect(body, '前の単位の名前が出ていない').toContain(UNIT[0].term)
    expect(body, '次の単位の名前が出ていない').toContain(UNIT[2].term)
    expect(body.indexOf('次の単位'), '前後の導線が本文の末尾に無い').toBeGreaterThan(
      body.indexOf(`${UNIT[1].term} の短い説明です。`),
    )
    expect(v.anchors().map((a) => a.getAttribute('href'))).toContain(`/topics/${UNIT[2].id}`)
    await v.press(/次の単位/)
    expect(v.text(), '次の単位へ移っていない').toContain(`${UNIT[2].term} の短い説明です。`)

    // 3. 画面は「他の論点」と「次に学ぶ」の箱を出さず、戻り先をロードマップにする
    expect(v.text(), 'ロードマップ型で「他の論点」が出ている').not.toContain(SIBLING)
    expect(v.text(), 'ロードマップ型で「次に学ぶ」が出ている').not.toContain('次に学ぶ')
    const back = v.anchors().find((a) => /ロードマップに戻る/.test(a.textContent ?? ''))
    expect(back, '「ロードマップに戻る」の戻るリンクが無い').toBeTruthy()
    expect(back!.getAttribute('href'), '戻り先がロードマップ（/topics）になっていない').toBe('/topics')

    // 事後条件: 一覧に戻らずに、学ぶ順のとおり隣の単位へ進めている
    expect(countOf(`/api/topics/${UNIT[2].id}`), '隣の単位を取りに行っていない').toBe(1)
  })
})
