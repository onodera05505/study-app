// @vitest-environment jsdom
/** UC-013 学び側のログイン画面が、認証の形の問い合わせ（契約 getAuthConfig）からまなびばの場所を得られないときの導線。
 *
 *  App をトークンの無い端末で描き、getAuthConfig の応答だけを偽の fetch で変える。
 *  導線の行き先は、登録簿（src/shared/targets.json の _portal）にあるまなびばの場所と、href の origin で照らす。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import targets from '../../src/shared/targets.json'

/** 登録簿にあるまなびばの場所。 */
const REGISTRY_PORTAL = (targets as unknown as { _portal: { url: string } })._portal.url
/** 契約 getAuthConfig の examples.noPortal。 */
const NO_PORTAL = { sso: false, portal: null, app: 'ip' }

type Reply = { status: number; body: unknown } | 'unreachable'

/** 答えの無い失敗の実例（届かない・失敗の状態で返る）。 */
const NO_ANSWER: [string, Reply][] = [
  ['問い合わせが届かない', 'unreachable'],
  ['問い合わせが失敗の状態で返る', { status: 500, body: { error: '内部エラーです' } }],
]

let container: HTMLElement
let root: Root

/** 認証の形の問い合わせにだけ reply を返し、他の問い合わせは中身の無い 200 を返す偽の fetch。 */
function stubAuthConfig(reply: Reply): { asked: number } {
  const seen = { asked: 0 }
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('/auth/config')) {
      seen.asked++
      if (reply === 'unreachable') throw new TypeError('Failed to fetch')
      return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body), json: async () => reply.body }
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
  })
  return seen
}

/** href の origin が登録簿のまなびばの場所と同じ導線。 */
function linksToRegistryPortal(): HTMLAnchorElement[] {
  const origin = new URL(REGISTRY_PORTAL).origin
  return ([...container.querySelectorAll('a')] as HTMLAnchorElement[]).filter((a) => {
    const href = a.getAttribute('href')
    if (!href) return false
    try {
      return new URL(href, 'http://localhost').origin === origin
    } catch {
      return false
    }
  })
}

async function drawLogin() {
  window.history.replaceState({}, '', '/')
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: ['/'] }, h(App)))
  })
  // 問い合わせの失敗と応答の反映を待つ
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
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

describe('UC-013 まなびばの場所を得られないときのログイン画面の導線', () => {
  // @covers REQ-525#no-portal-answer
  it('認証の形の問い合わせが「まなびばの場所が無い」と答えたとき、ログイン画面はまなびばへの導線を登録簿のまなびばの場所に向けて出す', async () => {
    const seen = stubAuthConfig({ status: 200, body: NO_PORTAL })
    await drawLogin()
    expect(seen.asked, '画面が認証の形を問い合わせていない（この検査は空振りになる）').toBeGreaterThan(0)
    expect(linksToRegistryPortal().length, '登録簿のまなびばの場所に向いた導線が無い').toBeGreaterThan(0)
  })

  // @covers REQ-525#no-answer-failure
  it('認証の形の問い合わせが答えを返さずに失敗したとき（届かない・失敗の状態で返る）、ログイン画面はまなびばへの導線を登録簿のまなびばの場所に向けて出す', async () => {
    for (const [label, reply] of NO_ANSWER) {
      const seen = stubAuthConfig(reply)
      await drawLogin()
      expect(seen.asked, `${label}: 画面が認証の形を問い合わせていない（この検査は空振りになる）`).toBeGreaterThan(0)
      expect(linksToRegistryPortal().length, `${label}: 登録簿のまなびばの場所に向いた導線が無い`).toBeGreaterThan(0)
      await act(async () => {
        root.render(null)
      })
      vi.unstubAllGlobals()
    }
  })
})
