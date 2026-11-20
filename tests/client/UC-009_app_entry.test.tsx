// @vitest-environment jsdom
/** 画面の起動の入口（index.html が読み込む src/client/main.tsx）を通して、ブラウザの場所から画面を出す。
 *  ほかの画面のテストは画面全体の部品を経路の器に入れて描くので、起動の入口そのものは通らない。
 *  ここでは index.html と同じ根（#root）を置き、ブラウザの場所を資格対策だけの画面の場所にしてから入口を読み込む。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、ロードマップ型（itc）にしてから読み込む。
 *  API は fetch の偽物で答える（形は tests/client/app_nav.test.tsx と同じ）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** ロードマップ型の単位（ロードマップの画面が出たことの目印）。 */
const UNIT_TERM = '1 日目の単位の名前'

function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const p = new URL(String(raw), 'http://localhost').pathname
    let body: unknown = {}
    if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://portal.example', app: 'itc' }
    else if (p.endsWith('/me')) body = { user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }, topics: { total: 1, understood: 0, partly: 0 }, recentSessions: [], nextTopics: [], visits: { today: '2026-11-20', streak: 1, longest: 1, total: 1 } }
    else if (p.endsWith('/topics')) {
      body = { topics: [{ id: 101, term: UNIT_TERM, questionCount: 2, status: null, field: '業界と仕事', middle: 'コンサルの仕事', itemName: 'コンサルの仕事', isNew: 0, sortOrder: 1 }] }
    } else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

/** name を持つトークン（画面は中身だけを見る）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** 画面に text が出るまで待つ（起動の入口は描く完了を知らせないので、少しずつ待つ）。 */
async function waitFor(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false
  localStorage.clear()
  sessionStorage.clear()
  stubApi()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('UC-009 画面の起動の入口から、ロードマップ型の行ける先を限る', () => {
  // @covers REQ-128#cert-only-location
  it('ロードマップ型で、ブラウザの場所が資格対策だけの画面（練習テスト）のまま起動すると、ロードマップが出る', async () => {
    vi.stubEnv('VITE_EXAM', 'itc')
    vi.resetModules()
    const api = await import('../../src/client/lib/api')
    api.setToken(jwtWith({ sub: 'u-1', name: '学ぶ人', role: 'MEMBER' }))
    window.history.replaceState(null, '', '/practice')
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)

    await import('../../src/client/main')
    await waitFor(() => (root.textContent ?? '').includes(UNIT_TERM))

    expect(root.textContent ?? '', '起動の入口から練習テストの場所を開いてもロードマップが出ない').toContain(UNIT_TERM)
  })
})
