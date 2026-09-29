// @vitest-environment jsdom
/** 画面を実際に描いて、出典・一部改変（結果画面）と SSO のログイン・コード受け取り・ヘッダーの名前を見る。
 *
 *  純粋な関数に切り出せない振る舞い（サーバの応答をそのまま出す所）なので、
 *  fetch を偽物にして本物の React で描く。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { App } from '../../src/client/App'
import { Login } from '../../src/client/pages/Login'
import { SsoCallback } from '../../src/client/pages/SsoCallback'
import { Result } from '../../src/client/pages/Result'
import { api, getToken, setToken } from '../../src/client/lib/api'
import { portal } from '../../src/shared/exam'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

const SSO_CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }

/** path ごとに返す JSON を決める偽の fetch。 */
function stubApi(bodyOf: (url: string) => unknown) {
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(bodyOf(String(url))),
  }))
}

/** 呼ばれた (url, init) を集める偽の fetch。status を返せば失敗も作れる。 */
function stubApiCalls(replyOf: (url: string) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const { status = 200, body } = replyOf(String(url))
    return { ok: status < 400, status, text: async () => JSON.stringify(body) }
  })
  return calls
}

/** name を持つトークン（署名は読まない。画面は中身だけを見る）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** 期限切れの印は「トークン付きの 401」でしか立たない（鍵の名前に頼らずに立てる）。 */
async function markSessionExpired() {
  stubApiCalls(() => ({ status: 401, body: { error: '認証が必要です' } }))
  setToken('expired-token')
  await api('/whatever').catch(() => {})
  vi.unstubAllGlobals()
}

async function draw(node: ReactNode, entry = '/') {
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

/** 結果画面が受け取る応答。1 問だけ、間違えた問題（既定の「間違えた問題だけ」に出る）。 */
const RESULT = {
  session: { kind: 'mock', scopeLabel: '令和6年度', questionCount: 1, sourceExam: '2024r06' },
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
      citation: '出典：令和6年度 ITパスポート試験 問8',
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

describe('結果画面の出典', () => {
  // @verifies REQ-027
  it('問題ごとに「出典：<年度ラベル> <試験名> 問N」が出る', async () => {
    stubApi(() => RESULT)
    await draw(
      h(Routes, null, h(Route, { path: '/sessions/:id/result', element: h(Result) })),
      '/sessions/s1/result',
    )
    expect(text()).toContain('出典：令和6年度 ITパスポート試験 問8')
    // 年度ラベルが内部コード（2024r06）のまま出ていない
    expect(text()).not.toContain('2024r06')
  })

  // @verifies REQ-028
  it('原文を書き換えた問題には「一部改変」が併記される', async () => {
    stubApi(() => RESULT)
    await draw(
      h(Routes, null, h(Route, { path: '/sessions/:id/result', element: h(Result) })),
      '/sessions/s1/result',
    )
    const note = container.querySelector('.citation .modified-note')
    expect(note?.textContent).toBe('（一部改変）')
  })

  // @verifies REQ-028
  it('書き換えていない問題には「一部改変」を出さない', async () => {
    stubApi(() => ({ ...RESULT, items: [{ ...RESULT.items[0], modified: false }] }))
    await draw(
      h(Routes, null, h(Route, { path: '/sessions/:id/result', element: h(Result) })),
      '/sessions/s1/result',
    )
    expect(container.querySelector('.modified-note')).toBeNull()
    expect(text()).toContain('出典：令和6年度 ITパスポート試験 問8')
  })
})

describe('ログイン画面', () => {
  // @verifies REQ-006
  it('SSO の環境ではパスワード欄を出さず、まなびばへ送る', async () => {
    stubApi(() => SSO_CONFIG)
    await draw(h(Login, { onDone: () => {} }))
    expect(container.querySelector('input[type="password"]')).toBeNull()
    const link = container.querySelector<HTMLAnchorElement>('a.btn')
    expect(link?.getAttribute('href')).toBe('https://manabiba.example/sso/start?app=ip')
  })

  // @verifies REQ-006
  it('SSO でない環境（ローカルの検査用）ではパスワードのフォームを出す', async () => {
    stubApi(() => ({ sso: false, portal: null, app: 'ip' }))
    await draw(h(Login, { onDone: () => {} }))
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })

  // @verifies REQ-068
  it('期限切れの印があるときは「有効期限が切れました」の案内を出す', async () => {
    await markSessionExpired()
    stubApi(() => SSO_CONFIG)
    await draw(h(Login, { onDone: () => {} }))
    expect(text()).toContain('有効期限が切れました')
  })

  // @verifies REQ-068
  it('印が無いとき（自分でログアウトしたとき）は期限切れの案内を出さない', async () => {
    stubApi(() => SSO_CONFIG)
    await draw(h(Login, { onDone: () => {} }))
    expect(text()).not.toContain('有効期限が切れ')
  })
})

describe('まなびばから戻ってくる画面（/sso/callback）', () => {
  /** 交換が済んだ合図（onDone）を受けてホームへ移る所は親の担当なので、App と同じ配線で包んで描く。 */
  async function drawCallback(entry: string) {
    const done = vi.fn()
    window.history.replaceState({}, '', entry)
    const Callback = () => {
      const navigate = useNavigate()
      return h(SsoCallback, { onDone: () => { done(); navigate('/', { replace: true }) } })
    }
    await draw(
      h(
        Routes,
        null,
        h(Route, { path: '/sso/callback', element: h(Callback) }),
        h(Route, { path: '/', element: h('div', null, 'ホーム画面') }),
      ),
      entry,
    )
    return done
  }

  /** 失敗の画面に要るもの: ログインできなかった旨・理由・まなびばへ戻る導線（登録簿の portal.url へ）。 */
  function expectFailureScreen(reason: string) {
    expect(text(), 'ログインできなかった旨が無い').toMatch(/ログイン[^。]*でき|失敗/)
    expect(text(), '理由が出ていない').toContain(reason)
    const back = container.querySelector<HTMLAnchorElement>(`a[href*="${portal.url}"]`)
    expect(back, `${portal.name}へ戻る導線が無い`).not.toBeNull()
    expect(back!.textContent ?? '', '導線に戻り先の名前が無い').toContain(portal.name)
  }

  // @verifies REQ-058
  it('code を /api/auth/sso に渡し、返ったトークンを保存してホームへ移る', async () => {
    const calls = stubApiCalls((url) =>
      url.includes('/api/auth/sso') ? { body: { token: 'tok-from-portal' } } : { body: SSO_CONFIG },
    )
    const done = await drawCallback('/sso/callback?code=abc123')
    const call = calls.find((c) => c.url.includes('/api/auth/sso'))
    expect(call, '/api/auth/sso が呼ばれていない').toBeTruthy()
    expect(call!.init?.method).toBe('POST')
    expect(String(call!.init?.body)).toContain('abc123')
    expect(getToken()).toBe('tok-from-portal')
    expect(done).toHaveBeenCalled()
    expect(text()).toContain('ホーム画面')
  })

  // @verifies REQ-058
  it('交換に失敗したらトークンを保存せず、旨と理由とまなびばへ戻る導線を出す', async () => {
    stubApiCalls((url) =>
      url.includes('/api/auth/sso')
        ? { status: 401, body: { error: 'コードが無効です' } }
        : { body: SSO_CONFIG },
    )
    const done = await drawCallback('/sso/callback?code=used')
    expect(getToken()).toBeNull()
    expect(done).not.toHaveBeenCalled()
    expectFailureScreen('コードが無効です')
  })

  // @verifies REQ-058
  it('code が無いときは交換せず、旨と理由とまなびばへ戻る導線を出す', async () => {
    const calls = stubApiCalls(() => ({ body: SSO_CONFIG }))
    const done = await drawCallback('/sso/callback')
    expect(calls.some((c) => c.url.includes('/api/auth/sso'))).toBe(false)
    expect(getToken()).toBeNull()
    expect(done).not.toHaveBeenCalled()
    expectFailureScreen('コード')
  })
})

describe('ヘッダーの本人の名前', () => {
  /** ホームが読む /api/me の応答。名前はトークンから出す決まりなので、ここには別の名前を入れておく。 */
  const ME = {
    user: { id: 'u-1', name: 'サーバの名前', role: 'MEMBER' },
    topics: { total: 10, understood: 3, partly: 2 },
    recentSessions: [],
    nextTopics: [],
    visits: { today: 1, streak: 2, longest: 5, total: 7 },
  }

  const stubHome = () =>
    stubApi((url) => (url.includes('/api/me') ? ME : url.includes('/auth/config') ? SSO_CONFIG : []))

  // @verifies REQ-064
  it('name を持つトークンがあるとヘッダーに名前が出る', async () => {
    stubHome()
    setToken(jwtWith({ sub: 'u-1', name: '寺田テスト', role: 'MEMBER' }))
    await draw(h(App))
    const header = container.querySelector('header')
    expect(header, 'ヘッダー（header 要素）が無い').not.toBeNull()
    expect(header!.textContent ?? '').toContain('寺田テスト')
  })

  // @verifies REQ-064
  it('トークンが無いときは名前を出さない', async () => {
    stubHome()
    await draw(h(App))
    expect(text()).not.toContain('寺田テスト')
  })
})
