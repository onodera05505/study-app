// @vitest-environment jsdom
/** UC-013 ログインした学び側の画面で、認証の形の問い合わせ（契約 getAuthConfig）が失敗したときの画面。
 *
 *  資格版の App をトークンのある端末で描き、getAuthConfig の応答だけを偽の fetch で失敗させる。
 *  まなびばへの導線は、登録簿（src/shared/targets.json の _portal）にあるまなびばの場所へ href の origin が向いた導線と、
 *  可視の文言に用語集の語「まなびば」を持つ導線の 2 つの見え方で探す。
 *  画面のほかの部分は、ホームのおすすめの論点と本人の名前と上部メニューが出ていることで見る。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import targets from '../../src/shared/targets.json'

/** 登録簿にあるまなびばの場所。 */
const REGISTRY_PORTAL = (targets as unknown as { _portal: { url: string } })._portal.url
/** 本人の名前（トークンと /me の両方に入れる）。 */
const NAME = '寺田テスト'
/** 資格版のホームに出るおすすめの論点（ホームが出たことの目印）。 */
const NEXT_TOPIC_TERM = '頻出の未理解の論点'
/** 失敗の応答の本文に添えた理由。 */
const REASON = '認証の形を今は答えられません。'

const ME = {
  user: { id: 'u-1', name: NAME, role: 'MEMBER' },
  topics: { total: 7, understood: 1, partly: 0 },
  recentSessions: [],
  nextTopics: [{ id: 231, term: NEXT_TOPIC_TERM, questionCount: 8, field: 'ストラテジ系' }],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

type Reply = { status: number; body: string } | 'unreachable'

/** 答えの返らない失敗の実例（届かない・失敗の状態で本文が読めない・本文に理由が無い）。 */
const NO_ANSWER: [string, Reply][] = [
  ['問い合わせが届かない', 'unreachable'],
  ['失敗の状態で中継機の HTML が返る', { status: 502, body: '<html><body>502 Bad Gateway</body></html>' }],
  ['失敗の状態で空の本文が返る', { status: 503, body: '' }],
]

/** 認証の形の問い合わせにだけ reply を返し、ほかの取得はホームを描ける中身で返す偽の fetch。 */
function stubApi(reply: Reply): { asked: number } {
  const seen = { asked: 0 }
  vi.stubGlobal('fetch', async (raw: string) => {
    const p = new URL(String(raw), 'http://localhost').pathname
    if (p.endsWith('/auth/config')) {
      seen.asked++
      if (reply === 'unreachable') throw new TypeError('Failed to fetch')
      const parsed = (() => {
        try {
          return JSON.parse(reply.body)
        } catch {
          return undefined
        }
      })()
      return {
        ok: false,
        status: reply.status,
        text: async () => reply.body,
        json: async () => {
          if (parsed === undefined) throw new SyntaxError('Unexpected token')
          return parsed
        },
      }
    }
    let body: unknown = {}
    if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
  return seen
}

/** name を持つトークン（画面は中身だけを見る）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** 資格版の App をトークンのある端末でホームから描く。 */
async function drawLoggedIn() {
  vi.stubEnv('VITE_EXAM', 'ip')
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const api = await import('../../src/client/lib/api')
  api.setToken(jwtWith({ sub: 'u-1', name: NAME, role: 'MEMBER' }))
  const { App } = await import('../../src/client/App')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(App)))
  })
  // 問い合わせの失敗と応答の反映を待つ
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const anchors = () => [...host.querySelectorAll('a')] as HTMLAnchorElement[]
  return {
    text: () => (host.textContent ?? '').replace(/\s+/g, ' '),
    menuHrefs: () =>
      [...(host.querySelector('nav') ?? host.querySelector('header') ?? host).querySelectorAll('a')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((href) => href.startsWith('/') && href !== '/'),
    /** まなびばへの導線（登録簿のまなびばの場所に向いた導線と、文言に「まなびば」を持つ導線）。 */
    portalLinks: () => {
      const origin = new URL(REGISTRY_PORTAL).origin
      return anchors().filter((a) => {
        if ((a.textContent ?? '').includes('まなびば')) return true
        const href = a.getAttribute('href')
        if (!href) return false
        try {
          return new URL(href, 'http://localhost').origin === origin
        } catch {
          return false
        }
      })
    },
    close: async () => {
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
}

/** 画面のほかの部分が出ていることを見て、欠けを返す。 */
function missingParts(v: Awaited<ReturnType<typeof drawLoggedIn>>, label: string): string[] {
  const problems: string[] = []
  if (!v.text().includes(NEXT_TOPIC_TERM)) problems.push(`${label}: ホームのおすすめの論点が出ていない`)
  if (!v.text().includes(NAME)) problems.push(`${label}: 本人の名前が出ていない`)
  if (v.menuHrefs().length === 0) problems.push(`${label}: 上部メニューの行き先が出ていない`)
  return problems
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('UC-013 ログインした画面で認証の形の問い合わせが失敗したとき', () => {
  // @covers REQ-566#reason-failure
  it('理由つきの失敗の応答が返ったとき、まなびばへの導線を出さず、その理由も出さず、画面のほかの部分は出す', async () => {
    const seen = stubApi({ status: 500, body: JSON.stringify({ error: REASON }) })
    const v = await drawLoggedIn()
    expect(seen.asked, '画面が認証の形を問い合わせていない（この検査は空振りになる）').toBeGreaterThan(0)
    const problems = missingParts(v, '理由つきの失敗')
    if (v.portalLinks().length > 0) problems.push('理由つきの失敗: まなびばへの導線が出ている')
    if (v.text().includes(REASON)) problems.push('理由つきの失敗: 認証の形の失敗の理由が画面に出ている')
    await v.close()
    expect(problems).toEqual([])
  })

  // @covers REQ-566#no-answer-failure
  it('答えの返らない失敗のとき（届かない・失敗の状態で本文が読めない）、まなびばへの導線を出さず、画面のほかの部分は出す', async () => {
    const problems: string[] = []
    for (const [label, reply] of NO_ANSWER) {
      const seen = stubApi(reply)
      const v = await drawLoggedIn()
      if (seen.asked === 0) problems.push(`${label}: 画面が認証の形を問い合わせていない（この検査は空振りになる）`)
      problems.push(...missingParts(v, label))
      if (v.portalLinks().length > 0) problems.push(`${label}: まなびばへの導線が出ている`)
      await v.close()
      vi.unstubAllGlobals()
    }
    expect(problems).toEqual([])
  })
})
