// @vitest-environment jsdom
/** 過去問を出す 3 つの画面（論点の学習・出題・結果）の出典と「一部改変」（BR-027）を、
 *  アプリの入口（App）から画面の道筋で開いて見る。
 *
 *  サーバの応答は fetch の偽物で返し、出典は API が組み立てた文字列（citation）、改変の印は modified で渡す。
 *  画面の文字は決まりと要件の文面から採る。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

/** 出典の文字列（年度ラベル「令和6年度」・試験名「ITパスポート試験」・問番号 8）。 */
const CITATION = '出典：令和6年度 ITパスポート試験 問8'
/** 年度ラベルの内部コード。画面にこれが出たら年度ラベルが素通しになっている。 */
const EXAM_CODE = '2024r06'
const QUESTION_TEXT = '次のうち正しいものはどれか。'
const CHOICES = { ア: '正しい', イ: '誤り' }

/** GET /api/topics/12（論点の学習画面）。過去問 1 件。modified は 0/1。 */
const topicDetail = (modified: 0 | 1) => ({
  topic: {
    id: 12,
    term: '損益分岐点',
    subtitle: null,
    explanation: '短い説明の本文です。',
    detail: null,
    questionCount: 1,
    frequencyTier: 1,
    isNew: 0,
    status: 0,
    statusSource: 'auto',
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '企業活動',
    middleNo: 1,
    itemName: '経営・組織論',
    tier: null,
  },
  questions: [
    {
      id: 'q-1',
      number: 8,
      examLabel: '令和6年度',
      exam: EXAM_CODE,
      text: QUESTION_TEXT,
      choices: CHOICES,
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
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
})

/** GET /api/sessions/s1/current（出題画面）。出題時のスナップショットの出典と改変の印。 */
const current = (modified: boolean) => ({
  session: { id: 's1', kind: 'drill', scopeLabel: '論点「損益分岐点」', questionCount: 1, sourceExam: null },
  question: {
    idx: 0,
    text: QUESTION_TEXT,
    choices: CHOICES,
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

/** GET /api/sessions/s1（結果画面）。間違えた 1 問を振り返る。 */
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
      text: QUESTION_TEXT,
      choices: CHOICES,
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

/** 改変の印を 1 つに揃えて応答を返す偽の fetch。 */
function stubApi(modified: boolean) {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/sessions/s1/current')) body = current(modified)
    else if (p.endsWith('/sessions/s1')) body = result(modified)
    else if (/\/topics\/\d+$/.test(p)) body = topicDetail(modified ? 1 : 0)
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

const text = () => (host.textContent ?? '').replace(/\s+/g, ' ')

/** 改変の印を決めてアプリの入口から画面を開く（毎回根を作り直す）。 */
async function open(entry: string, modified: boolean) {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
  }
  vi.unstubAllGlobals()
  stubApi(modified)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.history.replaceState({}, '', entry)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(App)))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  setToken('token-for-citation')
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

describe('入口から開いた論点の学習画面の出典（UC-002）', () => {
  // @covers REQ-023#citation-per-question
  it('原本から変えていない過去問に出典が出て、年度ラベルが内部コードのまま出ない', async () => {
    await open('/topics/12', false)
    expect(text(), '論点の学習画面に出典が出ていない').toContain(CITATION)
    expect(text(), '年度ラベルが内部コードのまま出ている').not.toContain(EXAM_CODE)
  })

  // @covers REQ-023#modified-question
  it('改変の印が立つ過去問には「一部改変」を併記し、立っていない過去問には出さない', async () => {
    await open('/topics/12', true)
    expect(text(), '論点の学習画面に出典が出ていない').toContain(CITATION)
    expect(text(), '改変した過去問に「一部改変」が併記されていない').toContain('一部改変')

    await open('/topics/12', false)
    expect(text()).toContain(CITATION)
    expect(text(), '改変していない過去問に「一部改変」が出ている').not.toContain('一部改変')
  })
})

describe('入口から開いた出題画面の出典（UC-004）', () => {
  // @covers REQ-245#citation-in-question
  it('出題中の問題に出典が出て、年度ラベルが内部コードのまま出ない', async () => {
    await open('/sessions/s1', false)
    expect(text(), '出題画面に出典が出ていない').toContain(CITATION)
    expect(text(), '年度ラベルが内部コードのまま出ている').not.toContain(EXAM_CODE)
  })

  // @covers REQ-245#modified-in-question
  it('改変の印が立つ出題には「一部改変」を併記し、立っていない出題には出さない', async () => {
    await open('/sessions/s1', true)
    expect(text(), '出題中の改変した問題に「一部改変」が併記されていない').toContain('一部改変')

    await open('/sessions/s1', false)
    expect(text()).toContain(CITATION)
    expect(text(), '改変していない出題に「一部改変」が出ている').not.toContain('一部改変')
  })
})

describe('入口から開いた結果画面の出典（UC-008）', () => {
  // @covers REQ-252#citation-per-item
  it('振り返る問題に出典が出て、年度ラベルが内部コードのまま出ない', async () => {
    await open('/sessions/s1/result', false)
    expect(text(), '結果画面に出典が出ていない').toContain(CITATION)
    expect(text(), '年度ラベルが内部コードのまま出ている').not.toContain(EXAM_CODE)
  })

  // @covers REQ-252#modified-item
  it('改変の印が立つ問題には「一部改変」を併記し、立っていない問題には出さない', async () => {
    await open('/sessions/s1/result', true)
    expect(text(), '結果の改変した問題に「一部改変」が併記されていない').toContain('一部改変')

    await open('/sessions/s1/result', false)
    expect(text()).toContain(CITATION)
    expect(text(), '改変していない問題に「一部改変」が出ている').not.toContain('一部改変')
  })
})
