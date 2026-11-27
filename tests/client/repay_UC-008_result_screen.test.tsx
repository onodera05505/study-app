// @vitest-environment jsdom
/** UC-008 模試（通し受験）の結果の画面（問題解説も論点も無い問題の振り返り）。
 *  fetch を偽物にして本物の React で描く（result_screen.test.tsx の作法）。 */

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
const btn = (re: RegExp) => els('button,a,label,[role="button"]').find((b) => re.test(b.textContent ?? ''))
const topicLinks = () => els('a').map((a) => a.getAttribute('href') ?? '').filter((href) => href.includes('/topics/'))

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

const RESULT = (items: unknown[]) => ({
  session: { kind: 'mock', scopeLabel: '令和6年度 を通しで受験', questionCount: items.length, sourceExam: '2024r06' },
  overall: { total: items.length, correct: 0, pct: 0 },
  fields: [{ field: 'ストラテジ系', total: items.length, correct: 0, pct: 0 }],
  passed: false,
  expired: false,
  criteria: { overallPct: 60, fieldPct: 30 },
  approximation: '本番は IRT のため公式スコアとは一致しません。',
  items,
})

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

describe('模擬試験の結果の画面（UC-008）', () => {
  // @covers REQ-125#item-without-explanation
  it('問題解説も論点も無い問題でも振り返りに出て、解説と論点への導線だけが落ちる', async () => {
    // 問題解説と論点のある問題では、導線が両方出る（下の「落ちる」が無いものを探せていないのではない）
    stubApi(RESULT([ITEM()]))
    await draw()
    expect(btn(/解説/), '問題解説のある問題に解説の導線が無い（この検査は空振りになる）').toBeDefined()
    expect(topicLinks(), '論点のある問題に論点への導線が無い（この検査は空振りになる）').toContain('/topics/12')

    stubApi(RESULT([ITEM({ explanation: null, topicId: null, topicTerm: null })]))
    await draw()
    expect(text(), '問題解説の無い問題が振り返りに出ない').toContain('問題文その1')
    expect(text(), '自分の回答が出ない').toContain('イ')
    expect(text(), '正解が出ない').toContain('ア')
    expect(topicLinks(), '論点が無いのに論点への導線が出ている').toEqual([])
    expect(btn(/解説/), '問題解説が無いのに解説の導線が出ている').toBeUndefined()
  })
})
