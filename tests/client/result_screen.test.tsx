// @vitest-environment jsdom
/** UC-008 模試（通し受験）の結果の画面（合否の目安と基準・分野別の表・間違えた問題の振り返り・時間切れの案内・同一内容の印）。
 *  出典と「一部改変」は tests/client/screens.test.tsx が見る。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Result } from '../../src/client/pages/Result'
import { invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const btn = (re: RegExp) =>
  els('button,a,label,[role="button"]').find((b) => re.test(b.textContent ?? ''))

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function stubApi(body: unknown) {
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }))
}

const EXPL = {
  correctReason: 'アが正解の根拠です。',
  choices: [
    { label: 'ア', term: null, note: '正解。均衡点の定義そのもの。' },
    { label: 'イ', term: '損益分岐点', note: '売上と費用が等しくなる点の説明。' },
  ],
}

const ITEM = (over: Record<string, unknown> = {}) => ({
  idx: 0,
  text: '問題文その1',
  choices: { ア: '固定費を限界利益率で割った売上高', イ: '売上高から変動費を差し引いた額' },
  answer: 'ア',
  userAnswer: 'イ',
  result: 2,
  citation: '出典：令和6年度 ITパスポート試験 問8',
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 1,
  otherCitations: [] as string[],
  topicId: 12,
  topicTerm: '損益分岐点',
  explanation: EXPL,
  ...over,
})

const RESULT = (over: Record<string, unknown> = {}) => ({
  session: { kind: 'mock', scopeLabel: '令和6年度', questionCount: 2, sourceExam: '2024r06' },
  overall: { total: 2, correct: 1, pct: 50 },
  fields: [
    { field: 'テクノロジ系', total: 1, correct: 0, pct: 0 },
    { field: 'ストラテジ系', total: 1, correct: 1, pct: 100 },
  ],
  passed: false,
  expired: false,
  criteria: { overallPct: 60, fieldPct: 30 },
  approximation: '本番は IRT のため公式スコアとは一致しません。',
  items: [ITEM(), ITEM({ idx: 1, text: '問題文その2', result: 1, userAnswer: 'ア', topicId: null, topicTerm: null })],
  ...over,
})

const DRILL = (over: Record<string, unknown> = {}) =>
  RESULT({
    session: { kind: 'drill', scopeLabel: '論点「損益分岐点」', questionCount: 2, sourceExam: null },
    ...over,
  })

/** 1 件のテストの中で応答を替えて描き直すので、毎回根を捨てて作り直す（描き直しで取り直させる）。 */
async function draw() {
  await act(async () => {
    root.unmount()
  })
  container.innerHTML = ''
  root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/sessions/s-1/result'] },
        h(
          Routes,
          null,
          h(Route, { path: '/sessions/:id/result', element: h(Result) }),
          h(Route, { path: '/result/:id', element: h(Result) }),
        ),
      ),
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
  sessionStorage.clear()
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('結果の画面', () => {
  // @covers REQ-120#mock-result-sections
  it('模擬試験では合否の目安・基準・分野別の表・断り書きを出し、演習では出さない', async () => {
    stubApi(RESULT())
    await draw()
    expect(text(), '合否の目安が出ていない').toMatch(/未達|合格ライン/)
    expect(text(), '総合の基準が出ていない').toContain('60')
    expect(text(), '分野の基準が出ていない').toContain('30')
    expect(text()).toContain('本番は IRT のため公式スコアとは一致しません。')
    expect(text()).toContain('テクノロジ系')
    expect(text()).toContain('ストラテジ系')
    expect(text(), '分野別の正答率が出ていない').toContain('100')

    stubApi(DRILL())
    await draw()
    expect(text(), '演習の結果に合否の目安が出ている').not.toMatch(/未達|合格ライン/)
    expect(text(), '演習の結果に断り書きが出ている').not.toContain('本番は IRT のため公式スコアとは一致しません。')
  })

  // @covers REQ-125#wrong-first-and-review-links
  it('はじめは間違えた問題だけを出し、自分の解答と正解・論点への導線・畳んだ解説を持つ', async () => {
    stubApi(RESULT())
    await draw()
    expect(text()).toContain('問題文その1')
    expect(text(), 'はじめから正解した問題も出ている').not.toContain('問題文その2')
    // 自分の解答（イ）と正解（ア）
    expect(text()).toContain('ア')
    expect(text()).toContain('イ')
    expect(els('a').map((a) => a.getAttribute('href')), '論点への導線が無い').toContain('/topics/12')
    expect(text(), '解説が畳まれていない').not.toContain('アが正解の根拠です。')
    await click(btn(/解説/), '解説を開く')
    expect(text(), '解説が開かない').toContain('アが正解の根拠です。')
    await click(btn(/すべて/), 'すべてに切り替え')
    expect(text(), 'すべてに切り替えても正解した問題が出ない').toContain('問題文その2')
  })

  // @covers REQ-124#expired-notice
  it('時間切れで締められた回にだけ、そこまでの回答で採点した旨を出す', async () => {
    stubApi(RESULT({ expired: true }))
    await draw()
    expect(text(), '時間切れの案内が出ていない').toMatch(/制限時間/)

    stubApi(RESULT({ expired: false }))
    await draw()
    expect(text(), '時間切れでないのに案内が出ている').not.toMatch(/制限時間/)
  })

  // @covers REQ-249#sourced-exam-result-no-marks
  it('公開回の通し受験では同一内容の印を出さず、演習では出す', async () => {
    const asked2 = { timesAsked: 2, otherCitations: ['出典：平成28年度 春期 ITパスポート試験 問1'] }
    // 印に出る他の出典は、先頭の「出典：」を外した形で並ぶ
    const OTHER = '平成28年度 春期 ITパスポート試験 問1'
    stubApi(RESULT({ items: [ITEM(asked2)] }))
    await draw()
    expect(text(), '通し受験で同一内容の印が出ている').not.toMatch(/他の出典/)

    stubApi(DRILL({ items: [ITEM(asked2)] }))
    await draw()
    expect(text()).toContain(OTHER)
    expect(text()).toMatch(/2\s*回/)
  })
})
