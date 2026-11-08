// @vitest-environment jsdom
/** UC-013 すでにトークンがある端末が学びの入口へ戻ったときの扱い（REQ-406・REQ-407）。
 *
 *  App を本物の React で /sso/callback に描き、学び側サーバとまなびばは偽の fetch が受け持つ。
 *  観測は端末の記憶（readToken に当たる getToken）・ヘッダーの名前・以後の API 呼び出しに添えるトークン。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { getToken, setToken } from '../../src/client/lib/api'

const CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }

/** 本人を指す値・名前・役割を持つトークン（画面は中身だけを見る。署名は読まない）。 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600
const PAST = Math.floor(Date.now() / 1000) - 3600

/** 前の本人（端末に残っているトークン）と、戻ってきたコードの本人。 */
const BEFORE_NAME = '前の本人'
const AFTER_NAME = '後の本人'
const AFTER_TOKEN = jwt({ sub: 'u-after', name: AFTER_NAME, role: 'MEMBER', exp: FUTURE })
const BEFORE_VALID = jwt({ sub: 'u-before', name: BEFORE_NAME, role: 'MEMBER', exp: FUTURE })
const BEFORE_EXPIRED = jwt({ sub: 'u-before', name: BEFORE_NAME, role: 'MEMBER', exp: PAST })
const BEFORE_BROKEN = 'not-a-token'

/** ホームが読む応答（名前はトークンから出す決まりなので、ここには別の名前を入れておく）。 */
const ME = {
  user: { id: 'u', name: 'サーバの名前', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: 1, streak: 1, longest: 1, total: 1 },
}

type Call = { path: string; method: string; authorization: string | null }
let calls: Call[] = []

/** 学び側サーバの代わり。交換の応答だけを差し替えられる。添えた Authorization を集める。 */
function stubServers(exchange: () => { status: number; body: unknown }) {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? {})
    calls.push({ path: url.pathname, method: (init?.method ?? 'GET').toUpperCase(), authorization: headers.get('Authorization') })
    const p = url.pathname
    let status = 200
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-11-07T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = CONFIG
    else if (p.endsWith('/auth/sso')) ({ status, body } = exchange())
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

async function open(entry: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.history.replaceState({}, '', entry)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(App)))
  })
}

const headerText = () => host.querySelector('header')?.textContent ?? ''
const exchanged = () => calls.some((c) => c.path.endsWith('/api/auth/sso'))
/** 交換のあとの、学び側の本人の要求（/api/auth/* を除く）。 */
const authorizedAfterExchange = () => {
  const at = calls.findIndex((c) => c.path.endsWith('/api/auth/sso'))
  return calls.slice(at + 1).filter((c) => c.path.startsWith('/api/') && !c.path.startsWith('/api/auth/'))
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

/** 換えられたときの観測: 端末のトークン・ヘッダーの名前・以後の要求が、すべてコードの本人のものになる。 */
async function expectReplaced(before: string) {
  expect(exchanged(), '戻ってきたコードを換えに行っていない').toBe(true)
  expect(getToken(), '端末のトークンがコードの本人のものに入れ替わっていない').toBe(AFTER_TOKEN)
  expect(Object.values({ ...localStorage }), '前のトークンが端末に残っている').not.toContain(before)
  expect(headerText(), 'ヘッダーの名前がコードの本人になっていない').toContain(AFTER_NAME)
  expect(headerText(), 'ヘッダーに前の本人の名前が残っている').not.toContain(BEFORE_NAME)
  const later = authorizedAfterExchange()
  expect(later.length, '入れ替えのあとに学び側の API を呼んでいない').toBeGreaterThan(0)
  for (const c of later) expect(c.authorization, `${c.method} ${c.path} に添えたトークンがコードの本人のものでない`).toBe(`Bearer ${AFTER_TOKEN}`)
}

describe('UC-013 トークンがある端末が使えるコードを持って戻る（REQ-406）', () => {
  // @covers REQ-406#valid-token-replaced
  it('通るトークンがあるまま別の本人のコードで戻ると、そのコードの本人のトークンに入れ替わる', async () => {
    setToken(BEFORE_VALID)
    stubServers(() => ({ status: 200, body: { token: AFTER_TOKEN, user: { id: 'u-after', name: AFTER_NAME, role: 'MEMBER' } } }))
    await open('/sso/callback?code=3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40')
    await expectReplaced(BEFORE_VALID)
  })

  // @covers REQ-406#invalid-token-replaced
  it.each([
    ['期限の過ぎたトークン', BEFORE_EXPIRED],
    ['形を成さないトークン', BEFORE_BROKEN],
  ])('%s があるままコードで戻っても、そのコードの本人のトークンに入れ替わる', async (_label, before) => {
    setToken(before)
    stubServers(() => ({ status: 200, body: { token: AFTER_TOKEN, user: { id: 'u-after', name: AFTER_NAME, role: 'MEMBER' } } }))
    await open('/sso/callback?code=3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40')
    await expectReplaced(before)
  })
})

describe('UC-013 トークンがある端末がコード無し・換えられないまま戻る（REQ-407）', () => {
  // @covers REQ-407#no-code-keeps-token
  it('コードを持たずに入口へ戻っても、端末のトークンは捨ても入れ替えもされない', async () => {
    setToken(BEFORE_VALID)
    stubServers(() => ({ status: 200, body: { token: AFTER_TOKEN, user: { id: 'u-after', name: AFTER_NAME, role: 'MEMBER' } } }))
    await open('/sso/callback')
    expect(exchanged(), 'コードが無いのに換えに行っている').toBe(false)
    expect(getToken()).toBe(BEFORE_VALID)
  })

  // @covers REQ-407#exchange-refused-keeps-token
  it('換えられないコード（使用済み・権限無し・まなびばに届かない）で戻っても、端末のトークンは捨ても入れ替えもされない', async () => {
    const refusals: Array<[string, number, unknown]> = [
      ['使用済みのコード', 401, { error: 'コードが無効です' }],
      ['権限の無いコード', 403, { error: 'この学びの権限がありません' }],
      ['まなびばに届かない', 502, { error: 'まなびばに接続できません' }],
    ]
    for (const [label, status, body] of refusals) {
      localStorage.clear()
      setToken(BEFORE_VALID)
      stubServers(() => ({ status, body }))
      await open('/sso/callback?code=5b7e0c14-2a93-4de6-8f21-0c4ab9e35d77')
      expect(exchanged(), `${label}: 戻ってきたコードを換えに行っていない`).toBe(true)
      expect(getToken(), `${label}: 端末のトークンが変わった`).toBe(BEFORE_VALID)
      await act(async () => root!.unmount())
      host.remove()
      root = null
    }
  })
})
