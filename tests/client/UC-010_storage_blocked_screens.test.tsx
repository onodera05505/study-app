// @vitest-environment jsdom
/** UC-010 端末の記憶が使えないときの画面（REQ-242・REQ-153。BR-011）。
 *
 *  端末の記憶の操作（setLastPage・annotateLastPage・readLastPage・saveFeedbackDraft）は、書けない・読めないとき
 *  名前を持つ失敗を呼んだ側に渡す（契約）。ここではそれを受けた画面が止まらないことを、本物の React で描いて見る。
 *  端末の記憶が使えないことは Storage の読み書きが例外を投げることで作り、鍵の名前には頼らない。fetch は偽物。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App } from '../../src/client/App'
import { Feedback } from '../../src/client/pages/Feedback'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { Session } from '../../src/client/pages/Session'
import { invalidateCached, setToken } from '../../src/client/lib/api'
import { annotateLastPage, setLastPage } from '../../src/client/lib/lastPage'

const TYPED = 'この論点の説明が分かりにくいです。'
const LABEL = '学習の単位「LTV」'
const SSO_CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
const PORTAL_LINK = `a[href="${SSO_CONFIG.portal}/sso/start?app=${SSO_CONFIG.app}"]`

const ME = {
  user: { id: 'u-1', name: '寺田テスト', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: 1, streak: 1, longest: 1, total: 1 },
}

/** 論点の画面が読む応答（契約 UC-002 getTopicDetail の形。過去問は持たない）。 */
const TOPIC_DETAIL = {
  topic: {
    id: 231,
    term: 'LTV',
    subtitle: null,
    explanation: '短い説明の本文です。',
    detail: '詳しい解説の本文です。',
    questionCount: 0,
    frequencyTier: 3,
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
  questions: [],
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
}

function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

type Call = { url: string; init?: RequestInit }

/** 問題の画面が読む応答（契約 UC-004 getCurrentQuestion の形）。選択肢の本文には記号を入れない。 */
const CHOICES = {
  ア: '固定費を限界利益率で割った売上高',
  イ: '売上高から変動費を差し引いた額',
  ウ: '在庫の平均残高を売上原価で割った値',
  エ: '総資産を売上高で割った値',
}
const CURRENT = {
  session: { id: 's-1', kind: 'drill', scopeLabel: '論点「損益分岐点」', questionCount: 3, sourceExam: null },
  question: {
    idx: 1,
    text: '問題文その1',
    choices: CHOICES,
    citation: '出典：令和6年度 ITパスポート試験 問11',
    modified: false,
    hasFigure: false,
    figureDescription: null,
    figureImage: null,
    timesAsked: 1,
    otherCitations: [],
  },
  answered: 1,
  remainingSec: null,
  finished: false,
}
/** 契約 UC-004 answerQuestion の応答の形。 */
const ANSWERED = {
  correct: true,
  correctAnswer: 'ア',
  explanation: { correctReason: 'アが正解の根拠です。', choices: [] },
  remaining: 1,
  finished: false,
}

/** 呼ばれた (url, init) を集める偽の fetch。送信は受け付け、ほかは画面が読む形の空の応答。 */
function stubApi() {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = String(raw)
    calls.push({ url, init })
    let status = 200
    let body: unknown = {}
    if (url.includes('version.json')) body = { build: 'abc1234', at: '2026-11-18T00:00:00Z' }
    else if (url.includes('/auth/config')) body = SSO_CONFIG
    else if (url.includes('/feedback') && init?.method === 'POST') ({ status, body } = { status: 201, body: { id: 'f-1' } })
    else if (/\/topics\/\d+$/.test(new URL(url, 'http://localhost').pathname)) body = TOPIC_DETAIL
    else if (url.includes('/sessions/s-1/current')) body = CURRENT
    else if (url.includes('/sessions/s-1/answer') && init?.method === 'POST') body = ANSWERED
    else if (url.includes('/api/me')) body = ME
    else if (url.includes('/glossary')) body = { glossary: [] }
    else if (url.includes('/fields')) body = { fields: [] }
    else if (url.includes('/categories')) body = { categories: [] }
    else if (url.includes('/sessions/current')) body = { session: null }
    else if (url.includes('/topics')) body = { structure: null, topics: [] }
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
  })
  return calls
}

const posts = (calls: Call[]) => calls.filter((c) => c.url.includes('/feedback') && c.init?.method === 'POST')
const sentBody = (call: Call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>

const blocked = (name: string) => () => {
  throw new DOMException('端末の記憶が使えない', name)
}
/** 端末の記憶に書けない。 */
const blockWrites = () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked('QuotaExceededError'))
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked('QuotaExceededError'))
}
/** 端末の記憶が読めない。 */
const blockReads = () => vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked('SecurityError'))

let container: HTMLElement | null = null
let root: Root | null = null

const text = () => container?.textContent ?? ''

/** 根ごと作り直して描く（MemoryRouter は初期の場所しか見ないので、画面の移りは描き直しで表す）。 */
async function draw(node: ReactNode, entry: string) {
  await teardown()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, node))
  })
}

async function teardown() {
  if (root) {
    const r = root
    root = null
    await act(async () => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
}

const drawFeedback = () => draw(h(Routes, null, h(Route, { path: '/feedback', element: h(Feedback) })), '/feedback')

const input = () => container!.querySelector('textarea') ?? container!.querySelector<HTMLInputElement>('input[type="text"]')
const attachChooser = () => container!.querySelector<HTMLInputElement>('input[type="checkbox"]')

async function type(value: string) {
  const el = input()
  expect(el, '本文の入力欄が無い').not.toBeNull()
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(el!, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 種類を選び、本文を書いて送る（UC の主シナリオ #5・#6）。 */
async function fillAndSend() {
  const radio = container!.querySelector<HTMLInputElement>('input[type="radio"]')
  expect(radio, 'フィードバックの種類を選ぶ操作が無い').toBeTruthy()
  await act(async () => {
    radio!.click()
  })
  await type(TYPED)
  const send = [...container!.querySelectorAll('button')].find((b) => /送/.test(b.textContent ?? ''))
  expect(send, '送信のボタンが無い').toBeTruthy()
  await act(async () => {
    send!.click()
  })
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  invalidateCached()
})

afterEach(async () => {
  await teardown()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('UC-010 端末の記憶が使えないときの添え先（REQ-242）', () => {
  // @covers REQ-242#cannot-remember
  it('端末が添え先を覚えられないとき、学びの画面へもフィードバックの画面へも移れ、フィードバックの画面は添え先を覚えていない扱いになる', async () => {
    stubApi()
    setToken(jwtWith({ sub: 'u-1', name: ME.user.name, role: 'MEMBER' }))
    blockWrites()
    await draw(h(App), '/topics')
    expect(text().trim(), '学びの画面が描かれていない').not.toBe('')
    expect(container!.querySelector(PORTAL_LINK), '学びの画面がログイン画面に置き換わった').toBeNull()
    await draw(h(App), '/feedback')
    expect(input(), 'フィードバックの画面へ移れない').not.toBeNull()
    expect(attachChooser(), '覚えていない添え先を添える選択が出ている').toBeNull()
  })

  // @covers REQ-242#annotate-blocked
  it('論点の画面が論点を読み終えて添え先に足すときに端末の記憶が使えなくても、論点の画面は止まらない', async () => {
    stubApi()
    setLastPage({ path: '/topics/231', label: '学習の単位の詳細' })
    blockWrites()
    blockReads()
    await draw(h(Routes, null, h(Route, { path: '/topics/:id', element: h(TopicDetail) })), '/topics/231')
    expect(text(), '論点の名前が出ていない').toContain('LTV')
    expect(text(), '論点の説明が出ていない').toContain('短い説明の本文です。')
  })

  // @covers REQ-242#annotate-blocked
  it('問題の画面が問題を読み終えて添え先に足すときに端末の記憶が使えなくても、問題の画面は止まらず回答を送れる', async () => {
    const calls = stubApi()
    setLastPage({ path: '/sessions/s-1', label: 'テスト中の問題' })
    blockWrites()
    blockReads()
    await draw(h(Routes, null, h(Route, { path: '/sessions/:id', element: h(Session) })), '/sessions/s-1')
    expect(text(), '問題文が出ていない').toContain(CURRENT.question.text)
    for (const body of Object.values(CHOICES)) expect(text(), `選択肢「${body}」が出ていない`).toContain(body)
    const choice = [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes(CHOICES.ア))
    expect(choice, '選択肢を選ぶ操作が無い').toBeTruthy()
    await act(async () => {
      choice!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const answers = calls.filter((c) => c.url.includes('/sessions/s-1/answer') && c.init?.method === 'POST')
    expect(answers, '回答を送れない（問題の画面が止まった）').toHaveLength(1)
  })

  // @covers REQ-242#read-blocked-feedback
  it('フィードバックの画面が添え先を読めないとき、添え先を示さず、本文と種類をそろえて送れる', async () => {
    const calls = stubApi()
    setLastPage({ path: '/topics/412', label: '学習の単位の詳細' })
    annotateLastPage({ topicId: 412, label: LABEL })
    blockReads()
    await drawFeedback()
    expect(input(), '添え先を読めないと画面が出ない').not.toBeNull()
    expect(text(), '読めない添え先が示されている').not.toContain(LABEL)
    expect(attachChooser(), '読めない添え先を添える選択が出ている').toBeNull()
    await fillAndSend()
    const sent = posts(calls)
    expect(sent, '送ることが止まった').toHaveLength(1)
    const body = sentBody(sent[0])
    expect(body.body).toBe(TYPED)
    expect(body.page).toBeUndefined()
    expect(body.topicId).toBeUndefined()
  })
})

describe('UC-010 下書きを端末に書けないとき（REQ-153）', () => {
  // @covers REQ-153#draft-write-blocked
  it('下書きを端末に書けなくても、本文を書き続けられ、送れる', async () => {
    const calls = stubApi()
    blockWrites()
    await drawFeedback()
    await type(TYPED)
    expect(input()?.value, '書いた本文が入力欄に残らない').toBe(TYPED)
    await type(`${TYPED}続きです。`)
    expect(input()?.value, '書き続けられない').toBe(`${TYPED}続きです。`)
    await fillAndSend()
    const sent = posts(calls)
    expect(sent, '下書きを書けないと送れない').toHaveLength(1)
    expect(sentBody(sent[0]).body).toBe(TYPED)
  })
})
