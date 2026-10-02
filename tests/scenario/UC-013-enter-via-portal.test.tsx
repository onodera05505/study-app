// @vitest-environment jsdom
/** UC-001「利用者がまなびばでログインし、権限のある学びに入る（SSO）」の基本の流れを
 *  1 本で実行する写し（正常系のみ。失敗系・境界は REQ のテストが見る）。
 *
 *  操作で辿るのは画面側の step 1・5・8・9。まなびばの画面とサーバ（step 2〜4）と
 *  学び側サーバの交換（step 6・7）は偽の fetch が受け持つ。
 *  画面の文字は要件（REQ-006・REQ-002・REQ-058・REQ-050・REQ-063・REQ-064）の文面から採る。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'

/** GET /api/auth/config が返す設定（sso・portal・app の 3 つだけ。REQ-066）。 */
const PORTAL = 'https://manabiba.example'
const APP_KEY = 'ip'
const CONFIG = { sso: true, portal: PORTAL, app: APP_KEY }

/** まなびばが発行する使い捨てコードと、学び側サーバが返すトークン（本人の名前を持つ）。 */
const CODE = 'one-time-code'
const NAME = '小野寺'

/** 本人を指す値・名前・役割を持つトークン（画面は中身だけを見る）。 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}
const TOKEN = jwt({ sub: 'u-1', name: NAME, role: 'MEMBER' })

/** ホームが読む応答。名前はトークンから読む決まりなので、ここには別の名前を入れておく。 */
const ME = {
  user: { id: 'u-1', name: 'サーバの名前', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }
let calls: Call[] = []

/** まなびばと学び側サーバの代わり。呼ばれた (path, method, ヘッダ, 本体) を集める。 */
function stubServers() {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    calls.push({
      url: url.pathname + url.search,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: init?.body ? String(init.body) : undefined,
    })
    const p = url.pathname
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = CONFIG
    // step 6・7: 学び側サーバがまなびばでコードを交換し、トークンを発行して返す
    else if (p.endsWith('/auth/sso')) body = { token: TOKEN }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

const anchors = () => [...host.querySelectorAll('a')] as HTMLAnchorElement[]
/** パスワードの入力欄（REQ-006 の「パスワードの入力欄」）。 */
const passwordFields = () =>
  [...host.querySelectorAll('input')].filter((i) => i.getAttribute('type') === 'password')
/** 端末に入っている値（鍵の名前は仕様ではないので値だけを見る）。 */
const storedValues = (s: Storage) =>
  Array.from({ length: s.length }, (_, i) => s.getItem(s.key(i)!) ?? '')

/** 画面を開く（毎回根を作り直す。MemoryRouter は初めの場所しか見ない）。 */
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
  stubServers()
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

describe('UC-013 まなびばでログインして権限のある学びに入る', () => {
  // @scenario UC-013
  it('学び側を開く → まなびばへ誘導 → 戻ってきたコードを渡す → トークンを持って本人として通る', async () => {
    // 1. 利用者が学び側の画面を開く。端末にトークンが無いので、画面はどの画面の代わりにも
    //    ログイン画面を出し、まなびばへ誘導する（パスワード欄は無い）
    //    「どの画面でも」は draft の REQ-305 なので、ここでは入口（/）を開いたときだけを見る
    // REQ-305 が active になったら、どの場所を開いてもログイン画面が出ることを断言する
    await open('/')
    expect(passwordFields(), 'SSO の環境なのにパスワードの入力欄がある').toHaveLength(0)
    const toPortal = anchors().find((a) => (a.getAttribute('href') ?? '').includes('/sso/start'))
    expect(toPortal, 'まなびばの /sso/start への導線が無い').toBeTruthy()
    expect(toPortal!.getAttribute('href')).toBe(`${PORTAL}/sso/start?app=${APP_KEY}`)

    // 2. 利用者がまなびばのログイン画面でメールとパスワードを入れる。まなびばは認証し Cookie を発行する
    // 3. まなびばは学びの一覧を出し、権限のある学びだけ「開く」にする
    // 4. 利用者が「開く」を押す。まなびばはコードを発行し、学び側へリダイレクトする
    //    （2〜4 はまなびばの画面とサーバ。この写しでは「コード付きで戻ってきた」ことで表す）

    // 5. 学び側の画面がコードを受け取り、学び側サーバに渡す
    await open(`/sso/callback?code=${CODE}`)
    const exchange = calls.filter((c) => c.url.startsWith('/api/auth/sso'))
    expect(exchange, '受け取ったコードを学び側サーバへ渡していない').toHaveLength(1)
    expect(exchange[0].method).toBe('POST')
    expect(exchange[0].body ?? '', '渡した本体にコードが入っていない').toContain(CODE)

    // 6. 学び側サーバはまなびばでコードを交換する（偽の fetch が受け持つ）
    // 7. 学び側サーバは users を見つけるか作り、学び側のトークンを発行して返す（同上）

    // 8. 画面はトークンを端末に保存し、以後の API 呼び出しに付ける
    expect(storedValues(localStorage), 'トークンが端末に残っていない').toContain(TOKEN)

    // 9. 画面はヘッダーに、保存したトークンから読んだ本人の名前を出す（画面の読み直しを待たない）
    //    （保存のあと開き直していない、この描画のまま見る）
    const header = host.querySelector('header')
    expect(header, 'ヘッダー（header 要素）が無い').not.toBeNull()
    expect(header!.textContent ?? '', 'ヘッダーに本人の名前が出ていない').toContain(NAME)

    // 事後条件: 端末にトークンがあり、以後の API 呼び出しが本人として通る
    const after = calls.filter((c) => c.url.startsWith('/api/') && !c.url.startsWith('/api/auth/'))
    expect(after.length, 'ログインの後に API を呼んでいない').toBeGreaterThan(0)
    expect(
      after.some((c) => c.headers.Authorization === `Bearer ${TOKEN}`),
      'ログイン後の API 呼び出しに Authorization: Bearer が付いていない',
    ).toBe(true)
  })
})
