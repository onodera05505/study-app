// @vitest-environment jsdom
/** UC-013 端末の記憶が使えないときのトークン（REQ-574・REQ-575・REQ-576）。
 *
 *  画面は本物の React で描き、学び側サーバは偽の fetch が受け持つ。端末の記憶が使えないことは
 *  Storage の読み書きが例外を投げることで作り、鍵の名前には頼らない。
 *  ログイン画面の印は、まなびばへの導線（契約 startSso の経路 `/sso/start?app=<key>`）。
 *  まなびばへ戻る導線の行き先は登録簿のまなびばの場所（src/shared/exam の portal）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { App } from '../../src/client/App'
import { SsoCallback } from '../../src/client/pages/SsoCallback'
import { api, clearToken, getToken, setToken } from '../../src/client/lib/api'
import { portal } from '../../src/shared/exam'

/** 契約 getAuthConfig の examples（まなびばの場所がある配備）。 */
const SSO_CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
const PORTAL_LINK = `a[href="${SSO_CONFIG.portal}/sso/start?app=${SSO_CONFIG.app}"]`
/** 学びの場所。ホーム・一覧・テスト・履歴。 */
const ROUTES = ['/', '/topics', '/exams', '/history']
/** 契約 signInWithCode の examples の使い捨てコード。 */
const CODE = '3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600
const BEFORE_NAME = '前の本人'
const AFTER_NAME = '後の本人'
const BEFORE_TOKEN = jwtWith({ sub: 'u-before', name: BEFORE_NAME, role: 'MEMBER', exp: FUTURE })
const AFTER_TOKEN = jwtWith({ sub: 'u-after', name: AFTER_NAME, role: 'MEMBER', exp: FUTURE })

/** ホームが読む /api/me の応答。 */
const ME = {
  user: { id: 'u-1', name: 'サーバの名前', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: 1, streak: 1, longest: 1, total: 1 },
}
const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

type Call = { url: string; init?: RequestInit }

/** 呼ばれた (url, init) を集める偽の fetch。 */
function stubApi(replyOf: (url: string) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const { status = 200, body } = replyOf(String(url))
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
  })
  return calls
}

const replyOk = (url: string) => ({
  body: url.includes('version.json')
    ? { build: 'abc1234', at: '2026-11-18T00:00:00Z' }
    : url.includes('/auth/config')
      ? SSO_CONFIG
      : url.includes('/api/me')
        ? ME
        : EMPTY,
})
/** 交換は契約 signInWithCode の ok の形で通し、ほかは replyOk。 */
const replyExchanged = (url: string) =>
  url.includes('/api/auth/sso') ? { body: { token: AFTER_TOKEN, user: { id: 'u-after', name: AFTER_NAME, role: 'MEMBER' } } } : replyOk(url)
const contentCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/api/') && !c.url.includes('/auth/config'))

const domError = (message: string, name: string) => () => {
  throw new DOMException(message, name)
}

/** 端末の記憶に書けない（書く・消す・空にするが例外）。 */
const blockWrites = (message = '端末の記憶が使えない', name = 'QuotaExceededError') => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(domError(message, name))
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(domError(message, name))
  vi.spyOn(Storage.prototype, 'clear').mockImplementation(domError(message, name))
}
/** 端末の記憶が読めない。 */
const blockReads = () => vi.spyOn(Storage.prototype, 'getItem').mockImplementation(domError('端末の記憶が使えない', 'SecurityError'))
/** 端末の記憶からトークンを捨てられない（消す・空にするが例外。書くことはできる）。 */
const blockRemoval = () => {
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(domError('端末の記憶が使えない', 'SecurityError'))
  vi.spyOn(Storage.prototype, 'clear').mockImplementation(domError('端末の記憶が使えない', 'SecurityError'))
}

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

async function draw(node: ReactNode, entry = '/') {
  window.history.replaceState({}, '', entry)
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: [entry] }, node))
  })
}

async function clear() {
  await act(async () => {
    root.render(null)
  })
}

/** 見出し（h1〜h6）と導線（a・button）の外にある、日本語を含む文字の塊（画面が示す文の候補）。 */
function bodySentences(): string[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const out: string[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = (n.textContent ?? '').trim()
    if (!s || !JAPANESE.test(s)) continue
    if (n.parentElement?.closest('h1, h2, h3, h4, h5, h6, a, button')) continue
    out.push(s)
  }
  return out
}

/** /sso/callback を、交換が済んだ合図（onDone）でホームへ移る App と同じ配線で描く。 */
async function drawCallback(entry: string) {
  const done = vi.fn()
  const Callback = () => {
    const navigate = useNavigate()
    return h(SsoCallback, {
      onDone: () => {
        done()
        navigate('/', { replace: true })
      },
    })
  }
  await draw(
    h(Routes, null, h(Route, { path: '/sso/callback', element: h(Callback) }), h(Route, { path: '/', element: h('div', null, 'ホーム画面') })),
    entry,
  )
  return done
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
})

afterEach(async () => {
  await clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('UC-013 端末の記憶が使えないときのトークン', () => {
  describe('REQ-574 コードを換えたあとトークンを保存できない', () => {
    // @covers REQ-574#fixed-sentence
    it('ログインできなかった旨の見出しとは別に日本語の 1 文を 1 つ示し、その文は保存の失敗の中身で変わらず、ブラウザの例外の文も名前も含まない', async () => {
      const shown: string[] = []
      for (const [message, name] of [
        ['QUOTA-INTERNAL-MESSAGE-7f3a', 'QuotaExceededError'],
        ['SECURITY-INTERNAL-MESSAGE-91c2', 'SecurityError'],
      ]) {
        stubApi(replyExchanged)
        blockWrites(message, name)
        await drawCallback(`/sso/callback?code=${CODE}`)
        expect(text(), `${name}: ログインできなかった旨が無い`).toMatch(/ログイン[^。]*でき|失敗/)
        // 見出しと導線の外に示される文が、日本語の 1 文としてちょうど 1 つある
        const sentences = bodySentences()
        expect(sentences, `${name}: 見出しのほかに示す 1 文が無い、または 2 つ以上ある: ${JSON.stringify(sentences)}`).toHaveLength(1)
        const [sentence] = sentences
        expect(sentence, `${name}: 示す文が日本語でない`).toMatch(JAPANESE)
        expect(sentence, `${name}: 示す文が 1 文でない`).toMatch(/^[^。\n]+。?$/)
        expect(sentence, `${name}: 示す文に例外の文が入っている`).not.toContain(message)
        expect(sentence, `${name}: 示す文に名前が入っている`).not.toContain('STORAGE_UNAVAILABLE')
        expect(text(), `${name}: ブラウザの例外の文が出ている`).not.toContain(message)
        expect(text(), `${name}: 例外の種類が出ている`).not.toContain(name)
        expect(text(), `${name}: 断りの種類の名前が出ている`).not.toContain('STORAGE_UNAVAILABLE')
        shown.push(sentence)
        await clear()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
      }
      expect(shown[1], '保存の失敗の中身で示す 1 文が変わる（固定の 1 文でない）').toBe(shown[0])
    })

    // @covers REQ-574#portal-link
    it('まなびばへ戻る導線を出し、学びのホームへ進まない', async () => {
      stubApi(replyExchanged)
      blockWrites()
      const done = await drawCallback(`/sso/callback?code=${CODE}`)
      const back = container.querySelector<HTMLAnchorElement>(`a[href*="${portal.url}"]`)
      expect(back, `${portal.name}へ戻る導線が無い`).not.toBeNull()
      expect(done, '保存できないのにホームへ進む合図を出した').not.toHaveBeenCalled()
      expect(text()).not.toContain('ホーム画面')
    })
  })

  describe('REQ-575 端末の記憶が使えずトークンを読めない', () => {
    // @covers REQ-575#unreadable-as-no-token
    it('トークンを読む操作は失敗を渡さず、トークン無し（null）を返す', () => {
      setToken(BEFORE_TOKEN)
      blockReads()
      let token: string | null | undefined
      expect(() => {
        token = getToken()
      }, '読めないときに失敗を渡した').not.toThrow()
      expect(token).toBeNull()
    })

    // @covers REQ-575#any-route-shows-login
    it.each(ROUTES)('%s を開くとログイン画面になり、その場所の中身を取りに行かない', async (route) => {
      setToken(BEFORE_TOKEN)
      const calls = stubApi(replyOk)
      blockReads()
      await draw(h(App), route)
      expect(container.querySelector(PORTAL_LINK), `${route}: ログイン画面になっていない`).not.toBeNull()
      expect(contentCalls(calls), `${route}: ログイン画面なのに学びの中身を取りに行った`).toEqual([])
    })
  })

  describe('REQ-576 端末の記憶が使えずトークンを捨てられない', () => {
    // @covers REQ-576#clear-no-failure
    it('トークンを捨てる操作は失敗を渡さない', () => {
      setToken(BEFORE_TOKEN)
      blockWrites()
      expect(() => clearToken(), '捨てられないときに失敗を渡した').not.toThrow()
    })

    // @covers REQ-576#logout-continues
    it('ログアウトするとログイン画面に戻る', async () => {
      setToken(BEFORE_TOKEN)
      stubApi(replyOk)
      await draw(h(App), '/')
      const controls = () => [...container.querySelectorAll<HTMLElement>('a, button')]
      const nameOf = (el: HTMLElement) => `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`
      const findLogout = () => controls().find((el) => nameOf(el).includes('ログアウト'))
      // ログアウトの導線が本人の名前の奥にあるときは、名前を選んで出す
      const me = controls().find((el) => nameOf(el).includes(BEFORE_NAME))
      if (!findLogout() && me) {
        await act(async () => {
          me.click()
        })
      }
      const logout = findLogout()
      expect(logout, `仕込み: ログアウトの導線が無い（画面の導線: ${controls().map(nameOf).join(' / ')}）`).toBeTruthy()
      blockRemoval()
      await act(async () => {
        logout!.click()
      })
      expect(container.querySelector(PORTAL_LINK), 'ログアウトしてもログイン画面に戻らない').not.toBeNull()
    })

    // @covers REQ-576#refused-request-continues
    it('本人と分からないとして断られた要求は、捨てられなくても同じ断りのまま呼んだ側に届く', async () => {
      const refusal = { status: 401, body: { error: '認証が必要です', code: 'UNAUTHENTICATED' } }
      const refusedWith = async () => {
        stubApi(() => refusal)
        try {
          await api('/me')
        } catch (error) {
          return error
        }
        return undefined
      }
      setToken(BEFORE_TOKEN)
      const usable = await refusedWith()
      expect(usable, '仕込み: 記憶が使えるときに断りが届かない').toBeDefined()

      localStorage.clear()
      sessionStorage.clear()
      setToken(BEFORE_TOKEN)
      blockRemoval()
      const blocked = await refusedWith()
      expect(blocked, '捨てられないときに断りが届かない').toBeDefined()
      expect((blocked as { code?: unknown }).code, '断りの代わりに端末の記憶の失敗が届いた').not.toBe('STORAGE_UNAVAILABLE')
      expect(String(blocked), '記憶が使えるときと違う物が届いた').toBe(String(usable))
    })

    // @covers REQ-576#replace-continues
    it('使えるコードを持って戻ると、前のトークンを捨てる所で止まらずに交換したトークンの保存へ進む', async () => {
      setToken(BEFORE_TOKEN)
      const calls = stubApi(replyExchanged)
      blockRemoval()
      const done = await drawCallback(`/sso/callback?code=${CODE}`)
      expect(calls.some((c) => c.url.includes('/api/auth/sso')), '戻ってきたコードを換えに行っていない').toBe(true)
      expect(getToken(), '交換したトークンが保存されていない').toBe(AFTER_TOKEN)
      expect(done, '保存のあとホームへ進む合図が無い').toHaveBeenCalled()
    })
  })
})
