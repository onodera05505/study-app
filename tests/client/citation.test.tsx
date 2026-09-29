// @vitest-environment jsdom
/** 過去問を出す 3 つの画面（論点の学習・出題・結果）に出典が出て、改変した問題に
 *  「一部改変」が併記されることを見る（UC-010）。
 *
 *  サーバの応答をそのまま出す所なので、fetch を偽物にして本物の React で描く。
 *  出典は API が組み立てた文字列（citation）として来て、改変の印は modified。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { Session } from '../../src/client/pages/Session'
import { Result } from '../../src/client/pages/Result'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

/** 出典の文字列。年度ラベル「令和6年度」・試験名「ITパスポート試験」・問番号 8。 */
const CITATION = '出典：令和6年度 ITパスポート試験 問8'
/** 年度ラベルの内部コード。画面にこれが出たら年度ラベルが素通しになっている。 */
const EXAM_CODE = '2024r06'

/** path ごとに返す JSON を決める偽の fetch（screens.test.tsx と同じ作法）。 */
function stubApi(bodyOf: (url: string) => unknown) {
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(bodyOf(String(url))),
    json: async () => bodyOf(String(url)),
  }))
}

/** 1 件のテストの中で応答を替えて描き直すので、毎回捨ててから描く（描き直しでは取り直さない）。 */
async function draw(node: ReactNode, entry: string) {
  await act(async () => {
    root.render(null)
  })
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: [entry] }, node))
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
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- 応答の偽物

/** GET /api/topics/:id の応答（過去問 1 件）。modified は 0/1。 */
const topicDetail = (modified: 0 | 1) => ({
  topic: {
    id: 12,
    term: '損益分岐点',
    explanation: null,
    detail: null,
    questionCount: 1,
    isNew: 0,
    status: null,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '企業活動',
    middleNo: 1,
    itemName: '経営・組織論',
    syllabusItemId: 1,
  },
  questions: [
    {
      id: 'q-1',
      number: 8,
      examLabel: '令和6年度',
      exam: EXAM_CODE,
      text: '次のうち正しいものはどれか。',
      choices: { ア: '正しい', イ: '誤り' },
      answer: 'ア',
      hasFigure: 0,
      figureDescription: null,
      figureImage: null,
      citation: CITATION,
      modified,
      timesAsked: 1,
      otherCitations: [],
      explanation: null,
      contentKey: 'ck-1',
    },
  ],
  siblings: [],
  neighbors: [],
  nextTopic: null,
})

/** 出題中の 1 問（GET /api/sessions/:id/current 相当）。modified は真偽値。 */
const sessionQuestion = (modified: boolean) => ({
  session: {
    id: 's1',
    kind: 'drill',
    scopeLabel: '論点「損益分岐点」',
    questionCount: 1,
    sourceExam: null,
  },
  question: {
    idx: 0,
    text: '次のうち正しいものはどれか。',
    choices: { ア: '正しい', イ: '誤り' },
    citation: CITATION,
    modified,
    hasFigure: false,
    figureDescription: null,
    figureImage: null,
    timesAsked: 1,
    otherCitations: [],
  },
  answered: 0,
  remainingSec: null,
  finished: false,
})

/** 結果（GET /api/sessions/:id 相当）。既定で「間違えた問題だけ」に出る 1 問。 */
const result = (modified: boolean) => ({
  session: { kind: 'mock', scopeLabel: '令和6年度', questionCount: 1, sourceExam: EXAM_CODE },
  overall: { total: 1, correct: 0, pct: 0 },
  fields: [{ field: 'ストラテジ系', total: 1, correct: 0, pct: 0 }],
  passed: false,
  expired: false,
  criteria: { overallPct: 60, fieldPct: 30 },
  approximation: '本番は IRT のため公式スコアとは一致しません。',
  items: [
    {
      idx: 0,
      text: '次のうち正しいものはどれか。',
      choices: { ア: '正しい', イ: '誤り' },
      answer: 'ア',
      userAnswer: 'イ',
      result: 2,
      citation: CITATION,
      modified,
      hasFigure: false,
      figureDescription: null,
      figureImage: null,
      timesAsked: 1,
      otherCitations: [],
      topicId: null,
      topicTerm: null,
      explanation: null,
    },
  ],
})

/** 用語集だけ別に返し、あとは画面が見ている本体を返す（画面ごとに 1 種類しか取りに行かない）。 */
const only = (body: unknown) => (url: string) =>
  url.includes('/glossary') ? { glossary: [] } : body

describe('論点の学習画面の出典（UC-010#2）', () => {
  const drawTopic = (modified: 0 | 1) => {
    stubApi(only(topicDetail(modified)))
    return draw(h(Routes, null, h(Route, { path: '/topics/:id', element: h(TopicDetail) })), '/topics/12')
  }

  // @verifies REQ-262
  it('紐づく過去問ごとに「出典：<年度ラベル> <試験名> 問N」が出る', async () => {
    await drawTopic(0)
    expect(text()).toContain(CITATION)
    // 年度ラベルが内部コード（2024r06）のまま出ていない
    expect(text()).not.toContain(EXAM_CODE)
  })

  // @verifies REQ-263
  it('改変の印が立つ過去問には「一部改変」を併記し、立っていない過去問には出さない', async () => {
    await drawTopic(1)
    expect(text()).toContain(CITATION)
    expect(text()).toContain('（一部改変）')

    await drawTopic(0)
    expect(text()).toContain(CITATION)
    expect(text()).not.toContain('一部改変')
  })
})

describe('出題画面の出典（UC-010#4）', () => {
  const drawSession = (modified: boolean) => {
    stubApi(only(sessionQuestion(modified)))
    return draw(h(Routes, null, h(Route, { path: '/sessions/:id', element: h(Session) })), '/sessions/s1')
  }

  // @verifies REQ-265
  it('出題中の問題に「出典：<年度ラベル> <試験名> 問N」が出る', async () => {
    await drawSession(false)
    expect(text()).toContain(CITATION)
    expect(text()).not.toContain(EXAM_CODE)
  })

  // @verifies REQ-266
  it('改変の印が立つ出題には「一部改変」を併記し、立っていない出題には出さない', async () => {
    await drawSession(true)
    expect(text()).toContain('（一部改変）')

    await drawSession(false)
    expect(text()).toContain(CITATION)
    expect(text()).not.toContain('一部改変')
  })
})

describe('結果画面の出典（UC-010#5）', () => {
  const drawResult = (modified: boolean) => {
    stubApi(only(result(modified)))
    return draw(
      h(Routes, null, h(Route, { path: '/sessions/:id/result', element: h(Result) })),
      '/sessions/s1/result',
    )
  }

  // @verifies REQ-027
  it('振り返る問題ごとに「出典：<年度ラベル> <試験名> 問N」が出る', async () => {
    await drawResult(false)
    expect(text()).toContain(CITATION)
    expect(text()).not.toContain(EXAM_CODE)
  })

  // @verifies REQ-028
  it('改変の印が立つ問題には「一部改変」を併記し、立っていない問題には出さない', async () => {
    await drawResult(true)
    expect(text()).toContain('（一部改変）')

    await drawResult(false)
    expect(text()).toContain(CITATION)
    expect(text()).not.toContain('一部改変')
  })
})
