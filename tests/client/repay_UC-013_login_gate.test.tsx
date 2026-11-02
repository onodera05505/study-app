// @vitest-environment jsdom
/** UC-013 まなびばから権限のある学びに入る — 学び側の画面がトークンの有無で何を出すか（REQ-190・194・195・198）。
 *
 *  App をそのまま描き、トークンが無い端末では学びのどの場所でもログイン画面（まなびばへの導線だけ）になること、
 *  トークンがある端末ではその場所が出ることを、まなびばへの導線（契約 startSso の経路 `/sso/start?app=<key>`）の
 *  有無で見る。fetch は偽物。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { api, clearToken, getToken, setToken } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

/** 契約 getAuthConfig の examples（まなびばの場所がある配備）。 */
const SSO_CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
/** ログイン画面の印: まなびばへの導線（契約 startSso の経路に受け持つ学びの key を付けた href）。 */
const PORTAL_LINK = `a[href="${SSO_CONFIG.portal}/sso/start?app=${SSO_CONFIG.app}"]`
/** 契約 UC-013 の学びの場所。ホーム・一覧・テスト・履歴。 */
const ROUTES = ['/', '/topics', '/exams', '/history']

/** ホームが読む /api/me の応答。 */
const ME = {
  user: { id: 'u-1', name: '寺田テスト', role: 'MEMBER' },
  topics: { total: 10, understood: 3, partly: 2 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: 1, streak: 2, longest: 5, total: 7 },
}

/** 呼ばれた url を集める偽の fetch。path ごとの応答を決める。 */
function stubApiCalls(replyOf: (url: string) => { status?: number; body: unknown }) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    void init
    calls.push(String(url))
    const { status = 200, body } = replyOf(String(url))
    return { ok: status < 400, status, text: async () => JSON.stringify(body) }
  })
  return calls
}

/** 中身の無い応答（どの場所の問い合わせにも形だけ合う）。 */
const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }
/** 設定と /api/me は答え、他は中身の無い応答を返す（トークンがある端末の通常の応答）。 */
const replyOk = (url: string) => ({ body: url.includes('/auth/config') ? SSO_CONFIG : url.includes('/api/me') ? ME : EMPTY })
/** その場所の中身の問い合わせ（学び側の API のうち、認証の形の問い合わせを除く）。 */
const contentCalls = (calls: string[]) => calls.filter((u) => u.includes('/api/') && !u.includes('/auth/config'))
/** 設定だけ答え、他はすべて 401 で断る。 */
const replyRefused = (url: string) => (url.includes('/auth/config') ? { body: SSO_CONFIG } : { status: 401, body: { error: '認証が必要です' } })

function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

async function draw(node: ReactNode, entry = '/') {
  window.history.replaceState({}, '', entry)
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

describe('UC-013 学び側の画面とトークン', () => {
  describe('REQ-190 トークンが無い間はどの場所でもログイン画面', () => {
    // @covers REQ-190#any-route-shows-login
    it.each(ROUTES)('トークンが無い端末が %s を開くと、まなびばへの導線を置いたログイン画面になり、その場所の中身を取りに行かない', async (route) => {
      const calls = stubApiCalls(replyOk)
      await draw(h(App), route)
      expect(container.querySelector(PORTAL_LINK), `${route}: まなびばへの導線が無い`).not.toBeNull()
      expect(contentCalls(calls), `${route}: ログイン画面なのに学びの中身を取りに行った`).toEqual([])
      expect(text()).not.toContain(ME.user.name)
    })
  })

  describe('REQ-194 トークンを添えない要求が断られたとき', () => {
    // @covers REQ-194#login-screen
    it('トークンが無い端末の要求が 401 で断られたあと、画面はログイン画面で、期限切れとは知らせない', async () => {
      stubApiCalls(replyRefused)
      await api('/me').catch(() => {})
      await draw(h(App), '/')
      expect(container.querySelector(PORTAL_LINK), 'ログイン画面になっていない').not.toBeNull()
      expect(text()).not.toContain('有効期限が切れ')
    })
  })

  describe('REQ-195 トークンがある間はどの場所でもその場所を出す', () => {
    // @covers REQ-195#route-shown-not-login
    it.each(ROUTES)('トークンがある端末が %s を開くと、ログイン画面に置き換わらず、その場所の中身を取りに行く', async (route) => {
      setToken(jwtWith({ sub: 'u-1', name: ME.user.name, role: 'MEMBER' }))
      const calls = stubApiCalls(replyOk)
      await draw(h(App), route)
      expect(container.querySelector(PORTAL_LINK), `${route}: ログイン画面に置き換わった`).toBeNull()
      expect(contentCalls(calls).length, `${route}: その場所の中身を取りに行っていない`).toBeGreaterThan(0)
    })
  })

  describe('REQ-198 学び側のログアウト', () => {
    // @covers REQ-198#other-devices-untouched
    it('トークンを捨てる操作はこの端末の記憶だけに閉じ、サーバへも他の端末へも何も送らない', async () => {
      setToken('tok-this-device')
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      clearToken()
      expect(getToken()).toBeNull()
      expect(fetchSpy, 'ログアウトがサーバを呼んだ（他の端末に届きうる）').not.toHaveBeenCalled()
    })
  })
})
