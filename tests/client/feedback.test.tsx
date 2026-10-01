// @vitest-environment jsdom
/** フィードバックの画面（UC-010 の主シナリオ #4・#6）。本文と、添え先を送ることと、
 *  送ったあとに受付文だけが出ることを見る。
 *
 *  送信先（サーバ）は偽物にして、呼ばれた URL と送信の本体を読む。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Feedback } from '../../src/client/pages/Feedback'
import { annotateLastPage, setLastPage } from '../../src/client/lib/lastPage'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

/** 受付文（要件の文言そのまま）。 */
const THANKS = 'フィードバックありがとうございます。改善に活かします。'
const TYPED = 'この論点の説明が分かりにくいです。'

/** 呼ばれた (url, init) を集める偽の fetch。 */
function stubApiCalls(replyOf: (url: string) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const { status = 200, body } = replyOf(String(url))
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
  })
  return calls
}

async function draw(node: ReactNode, entry: string) {
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: [entry] }, node))
  })
}

/** 見えているボタンを文字で探す（「送信」「送る」など言い回しに幅があるので部分一致）。 */
function button(re: RegExp): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) => re.test(b.textContent ?? '')) ?? null
  ) as HTMLButtonElement | null
}

/** 本文の入力欄（textarea か 1 行の入力欄）。 */
function input(): HTMLTextAreaElement | HTMLInputElement | null {
  return (
    container.querySelector('textarea') ??
    container.querySelector<HTMLInputElement>('input[type="text"]')
  )
}

/** React の制御された入力欄に文字を入れる（React は value を差し替えているので
 *  prototype の setter で入れてから input を投げる）。 */
async function type(value: string) {
  const el = input()
  expect(el, '本文の入力欄が無い').not.toBeNull()
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(el!, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 種類の選択がある作りでは 1 つ選ばないと送れないので、あれば先頭を選ぶ。 */
async function chooseKindIfAny() {
  const radio = container.querySelector<HTMLInputElement>('input[type="radio"]')
  if (!radio) return
  await act(async () => {
    radio.click()
  })
}

async function send() {
  const btn = button(/送/)
  expect(btn, '送信のボタンが無い').not.toBeNull()
  await act(async () => {
    btn!.click()
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

describe('フィードバックの送信（UC-010）', () => {
  // @covers REQ-152#attach-included
  it('本文と、直前に開いていた画面（パス・論点 ID）を送る', async () => {
    setLastPage({ path: '/topics/12', label: '学習の単位' })
    annotateLastPage({ topicId: 12, label: '学習の単位「LTV」' })
    const calls = stubApiCalls(() => ({ status: 201, body: { id: 'f-1' } }))

    await draw(h(Routes, null, h(Route, { path: '/feedback', element: h(Feedback) })), '/feedback')
    await chooseKindIfAny()
    await type(TYPED)
    await send()

    const call = calls.find((c) => c.url.includes('/feedback') && c.init?.method === 'POST')
    expect(call, 'POST /api/feedback が呼ばれていない').toBeTruthy()
    const raw = String(call!.init?.body)
    // 本文（どの鍵名で送るかは契約側の決め。文字が本体に入っていることを見る）
    expect(raw).toContain(TYPED)
    const sent = JSON.parse(raw) as Record<string, unknown>
    expect(sent.page).toBe('/topics/12')
    expect(sent.topicId).toBe(12)
  })

  // @covers REQ-151#send-without-attachment
  it('直前に開いていた画面が無くても本文だけで送れる', async () => {
    const calls = stubApiCalls(() => ({ status: 201, body: { id: 'f-2' } }))

    await draw(h(Routes, null, h(Route, { path: '/feedback', element: h(Feedback) })), '/feedback')
    await chooseKindIfAny()
    await type(TYPED)
    await send()

    const call = calls.find((c) => c.url.includes('/feedback') && c.init?.method === 'POST')
    expect(call, '添える画面が無いと送れなくなっている').toBeTruthy()
    expect(String(call!.init?.body)).toContain(TYPED)
  })

  // @covers REQ-155#accepted-shows-thanks
  it('送信に成功すると受付文が出て、書いた本文は残らない', async () => {
    setLastPage({ path: '/topics/12', label: '学習の単位「LTV」' })
    stubApiCalls(() => ({ status: 201, body: { id: 'f-3' } }))

    await draw(h(Routes, null, h(Route, { path: '/feedback', element: h(Feedback) })), '/feedback')
    await chooseKindIfAny()
    await type(TYPED)
    await send()

    expect(text()).toContain(THANKS)
    // 入力欄が残っていても本文は空。画面にも書いた文が残らない
    expect(input()?.value ?? '').toBe('')
    expect(text()).not.toContain(TYPED)
  })
})
