// @vitest-environment jsdom
/** 横断の決まり BR-027（出典の併記）・BR-028（同一内容のまとめ）を、過去問を出す 3 つの画面で
 *  1 本で実行する写し（正常系のみ。投入の側の門は既定のテストが見る）。
 *
 *  操作で辿るのは画面の側だけ。投入と出題時のスナップショットはサーバ側なので、
 *  3 つの画面に同じ出典・同じ改変の印を返すことで表す。
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

/** GET /api/topics/12（論点の学習画面）。改変の印が立った過去問 1 件。 */
const TOPIC_DETAIL = {
  topic: {
    id: 12,
    term: '損益分岐点',
    explanation: '短い説明の本文です。',
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
      text: QUESTION_TEXT,
      choices: CHOICES,
      answer: 'ア',
      hasFigure: 0,
      figureDescription: null,
      figureImage: null,
      citation: CITATION,
      modified: 1,
      timesAsked: 1,
      otherCitations: [],
      explanation: null,
      contentKey: 'ck-1',
    },
  ],
  siblings: [],
  nextTopic: null,
  neighbors: { prev: null, next: null },
}

/** GET /api/sessions/s1/current（出題画面）。出題時のスナップショットの出典と改変の印。 */
const CURRENT = {
  session: { id: 's1', kind: 'drill', scopeLabel: '論点「損益分岐点」', questionCount: 1, sourceExam: null },
  question: {
    idx: 0,
    text: QUESTION_TEXT,
    choices: CHOICES,
    citation: CITATION,
    modified: true,
    hasFigure: false,
    figureDescription: null,
    figureImage: null,
    timesAsked: 1,
    otherCitations: [],
  },
  answered: 0,
  remainingSec: null,
  finished: false,
}

/** GET /api/sessions/s1（結果画面）。間違えた 1 問を振り返る。 */
const RESULT = {
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
      modified: true,
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
}

function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/sessions/s1/current')) body = CURRENT
    else if (p.endsWith('/sessions/s1')) body = RESULT
    else if (/\/topics\/\d+$/.test(p)) body = TOPIC_DETAIL
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

/** 画面を開く（毎回根を作り直す）。 */
async function open(entry: string) {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
  }
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
  stubApi()
  setToken('token-for-scenario')
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

describe('BR-027/028 過去問を出す画面の出典と「一部改変」', () => {
  // 横断の決まり（BR-027 出典・BR-028 同一内容）のシナリオ。UC のシナリオではないので @scenario は付けない
  it('論点の学習画面・出題画面・結果画面のどこでも、同じ出典と「一部改変」が出る', async () => {
    // 開発側が過去問を本番のデータへ入れる。システムは過去問ごとに出典を組み立てて列に持たせる
    //（投入の SQL はサーバ側。この写しでは 3 つの画面に同じ出典を返すことで表す）

    // 利用者が論点の学習画面を開く。画面は過去問ごとに出典を出し、改変の印が立つ問題には「一部改変」を併記する
    await open('/topics/12')
    expect(text(), '論点の学習画面に出典が出ていない').toContain(CITATION)
    expect(text(), '改変した過去問に「一部改変」が併記されていない').toContain('一部改変')
    expect(text(), '年度ラベルが内部コードのまま出ている').not.toContain(EXAM_CODE)

    // 利用者が演習・模試を始める。システムは出題時のスナップショットに出典と改変の印を入れる

    // 利用者が演習・模試の問題を解く。画面は出題中の問題に出典を出し、「一部改変」を併記する
    await open('/sessions/s1')
    expect(text(), '出題画面に出典が出ていない').toContain(CITATION)
    expect(text(), '出題中の改変した問題に「一部改変」が併記されていない').toContain('一部改変')
    expect(text(), '年度ラベルが内部コードのまま出ている').not.toContain(EXAM_CODE)

    // 利用者が結果画面を開く。画面は問題ごとに出典を出し、「一部改変」を併記する
    await open('/sessions/s1/result')
    expect(text(), '結果画面に出典が出ていない').toContain(CITATION)
    expect(text(), '結果の改変した問題に「一部改変」が併記されていない').toContain('一部改変')

    // 事後条件: 過去問を出すどの画面にも出典があり、出題済みの問題には当時の出典が出る
    expect(text(), '年度ラベルが内部コードのまま出ている').not.toContain(EXAM_CODE)
  })
})
