// @vitest-environment jsdom
/** 論点の画面（UC-002）の、過去問の図の書き起こし・過去問の図の切り替え・論点ドリルを始める。
 *  本物の React で描く。
 *
 *  サーバの応答は fetch を偽物にして与える（形は UC-002 の getTopicDetail の response と、
 *  UC-004 の startSession の response）。図の切り替えは、切り替える手段の名前（原寸へ／画面幅へ）が
 *  入れ替わることで観測する（実際の寸法は BR-035 が持たない）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

const TOPIC_ID = 231
const FIGURE_SRC = '/figures/ip/2024r06-q1.png'

type Over = Record<string, unknown>

const question = (n: number, over: Over = {}) => ({
  id: `2024r06-q${n}`,
  number: n,
  examLabel: '令和6年度',
  text: `過去問 ${n} の本文です。`,
  choices: { ア: `${n} のア`, イ: `${n} のイ`, ウ: `${n} のウ`, エ: `${n} のエ` },
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `出典：令和6年度 ITパスポート試験 問${n}`,
  modified: 0,
  timesAsked: 1,
  otherCitations: [],
  explanation: null,
  ...over,
})

const detail = (questions: unknown[]) => ({
  topic: {
    id: TOPIC_ID,
    term: 'LTV',
    subtitle: null,
    explanation: '短い説明の本文です。',
    detail: '詳しい解説の本文です。',
    questionCount: questions.length,
    frequencyTier: questions.length === 0 ? null : questions.length >= 3 ? 3 : questions.length,
    isNew: 0,
    status: 3,
    statusSource: 'override',
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '事業の指標',
    middleNo: 4,
    itemName: '会計と財務',
    tier: null,
  },
  questions,
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
})

let container: HTMLElement
let root: Root
let posted: { path: string; body: unknown }[] = []

/** 応答を決める偽の fetch。POST は経路と本文を `posted` に残す。 */
function stubApi(questions: unknown[]) {
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = init?.method ?? 'GET'
    if (method === 'POST') {
      posted.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.pathname.endsWith('/sessions'))
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              id: '8f14e45f-ea2b-4f1c-9a3e-6b1d2c7f4a90',
              kind: 'drill',
              scopeLabel: '論点「LTV」',
              questionCount: 1,
              timeLimitSec: null,
            }),
        }
    }
    if (url.pathname.endsWith('/glossary'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: [] }) }
    if (/\/topics\/\d+$/.test(url.pathname))
      return { ok: true, status: 200, text: async () => JSON.stringify(detail(questions)) }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) }
  })
}

async function draw() {
  invalidateCached()
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/topics/${TOPIC_ID}`]}>
        <Routes>
          <Route path="/topics/:id" element={<TopicDetail />} />
          <Route path="*" element={<div>別の画面</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

const text = () => container.textContent ?? ''

/** 過去問の図の表示を切り替える手段（原寸へ・画面幅へ）。名前で引く。 */
const toFullSize = () => container.querySelector<HTMLElement>('[aria-label="図を原寸で表示する"]')
const toFitWidth = () =>
  [...container.querySelectorAll<HTMLElement>('[aria-label]')].find((el) =>
    (el.getAttribute('aria-label') ?? '').includes('画面幅'),
  ) ?? null

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  posted = []
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

/* ---------- 過去問の図の書き起こし（REQ-266） ---------- */

/** 画像の無い図（書き起こしが本体として出る）を 1 問だけ持つ論点を描く。 */
async function drawTranscript(src: string) {
  stubApi([question(1, { hasFigure: 1, figureImage: null, figureDescription: src })])
  await draw()
}

describe('過去問の図の書き起こし（UC-002）', () => {
  // @covers REQ-266#table-head-and-rows
  it('表の記法で書かれたまとまりは、見出しの行と中身の行に分かれた表として示す', async () => {
    await drawTranscript(['| 品名 | 価格 |', '| --- | --- |', '| ガム | 100 |', '| せんべい | 250 |'].join('\n'))
    const tables = container.querySelectorAll('table')
    expect(tables, '表の記法が表として示されていない').toHaveLength(1)
    const heads = [...tables[0].querySelectorAll('th')].map((th) => th.textContent?.trim())
    expect(heads, '見出しが表の見出しとして示されていない').toEqual(['品名', '価格'])
    const rows = [...tables[0].querySelectorAll('tr')]
      .filter((tr) => tr.querySelector('td'))
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim()))
    expect(rows).toEqual([
      ['ガム', '100'],
      ['せんべい', '250'],
    ])
    // 記法の区切り（| や ---）は文字のまま出ない
    expect(text()).not.toContain('| ---')
  })

  // @covers REQ-266#code-lines-kept
  it('囲みの記法で書かれたまとまりは、行の並びと字下げを崩さない 1 つの囲みとして示す', async () => {
    const lines = ['x ← 1', 'while x < 10', '  x ← x × 2', 'endwhile']
    await drawTranscript(['```', ...lines, '```'].join('\n'))
    const holders = [...container.querySelectorAll<HTMLElement>('*')].filter((el) =>
      (el.textContent ?? '').includes(lines.join('\n')),
    )
    expect(holders.length, '囲みの中身が、行の並びと字下げを保ったひと続きで示されていない').toBeGreaterThan(0)
    // 4 行すべてを持つ最も内側の要素が 1 つの囲みで、その中身は書かれた行そのもの
    const inner = holders.filter((el) => !holders.some((o) => o !== el && el.contains(o)))
    expect(inner, '囲みが 1 つにまとまっていない').toHaveLength(1)
    expect((inner[0].textContent ?? '').replace(/\n$/, '')).toBe(lines.join('\n'))
    // 囲みの記法（```）は文字のまま出ない
    expect(text()).not.toContain('```')
  })
})

/* ---------- 過去問の図を押す（REQ-267 / BR-035） ---------- */

describe('過去問の図の切り替え（UC-002）', () => {
  const withImage = () =>
    stubApi([question(1, { hasFigure: 1, figureImage: FIGURE_SRC, figureDescription: '図の書き起こしです。' })])

  // @covers REQ-267#toggle-to-natural-size
  it('画面幅で出ている過去問の図を押すと原寸に変わる', async () => {
    withImage()
    await draw()
    expect(container.querySelector(`img[src="${FIGURE_SRC}"]`), '前提: 過去問の図が出ていない').not.toBeNull()
    const press = toFullSize()
    expect(press, '原寸に切り替える手段が無い').not.toBeNull()
    expect(toFitWidth(), '押す前から原寸になっている').toBeNull()
    await act(async () => {
      press!.click()
    })
    expect(toFitWidth(), '押しても原寸に変わらない（画面幅へ戻す手段が出ない）').not.toBeNull()
    expect(toFullSize(), '原寸に変わったのに、まだ原寸へ切り替える手段が出ている').toBeNull()
    expect(container.querySelector(`img[src="${FIGURE_SRC}"]`)).not.toBeNull()
  })

  // @covers REQ-267#toggle-back-to-fit-width
  it('原寸で出ている過去問の図をもう一度押すと画面幅に戻る', async () => {
    withImage()
    await draw()
    await act(async () => {
      toFullSize()!.click()
    })
    const back = toFitWidth()
    expect(back, '前提: 原寸になっていない').not.toBeNull()
    await act(async () => {
      back!.click()
    })
    expect(toFullSize(), 'もう一度押しても画面幅に戻らない').not.toBeNull()
    expect(toFitWidth(), '画面幅に戻ったのに、まだ画面幅へ戻す手段が出ている').toBeNull()
    expect(container.querySelector(`img[src="${FIGURE_SRC}"]`)).not.toBeNull()
  })
})

/* ---------- 論点ドリルを始める（REQ-273） ---------- */

describe('論点の教材から論点ドリルを始める（UC-002）', () => {
  // @covers REQ-273#start-from-material-sends-this-topic
  it('論点の教材で論点ドリルを始めると、その論点を範囲にした種別ドリルのテストを 1 つだけ作りに行く', async () => {
    stubApi([question(1), question(2)])
    await draw()
    expect(text()).toContain('LTV')
    const start = [...container.querySelectorAll<HTMLElement>('button, a, [role="button"]')].filter((el) =>
      /ドリル/.test(el.textContent ?? ''),
    )
    expect(start.length, '論点ドリルを始める手段が無い').toBeGreaterThan(0)
    expect(posted, '押す前からテストを作りに行っている').toEqual([])
    await act(async () => {
      start[0].click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const creates = posted.filter((p) => p.path.endsWith('/api/sessions'))
    expect(creates, 'テストを 1 つだけ作りに行っていない').toHaveLength(1)
    expect(creates[0].body).toMatchObject({ kind: 'drill', topicId: TOPIC_ID })
  })
})
