// @vitest-environment jsdom
/** UC-018「利用者が API の失敗を、画面に出せる形で受け取る」の基本の流れを 1 本で実行する写し
 *  （正常系のみ。通信そのものが成立しないときは REQ-098 のテストが見る）。
 *
 *  画面が呼ぶのと同じ道（api()）で失敗を受け取り、その本文 {error} が画面に出ることまで見る。
 *  画面の文字はサーバが返した {error} の日本語そのもの（REQ-051）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { ApiError, api, invalidateCached, setToken } from '../../src/client/lib/api'

/** サーバが返す失敗（本文は日本語の {error}）。 */
const REASON = '集計を取得できませんでした'
const STATUS = 400

function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    if (p.endsWith('/fields')) {
      const body = { error: REASON }
      return { ok: false, status: STATUS, text: async () => JSON.stringify(body), json: async () => body }
    }
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

const text = () => (host.textContent ?? '').replace(/\s+/g, ' ')

async function open(entry: string) {
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
  invalidateCached()
  stubApi()
  setToken('token-for-scenario')
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

describe('BR-014 API の失敗を画面に出せる形で受け取る', () => {
  // 横断の決まり（BR-014 失敗の見せ方・API の失敗の形）のシナリオ。UC のシナリオではないので @scenario は付けない
  it('失敗を message・status・body の 1 つの型で受け取り、その日本語を画面に出す', async () => {
    // 1. 利用者が画面を操作し、画面が API を呼ぶ。画面は失敗を message・status・body を持つ 1 つの型で受け取る
    const thrown = await api('/fields').then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown, '失敗が投げられていない').not.toBeNull()
    expect(thrown, '失敗が 1 つの型（ApiError）で投げられていない').toBeInstanceOf(ApiError)
    const err = thrown as InstanceType<typeof ApiError>
    expect(typeof err.message).toBe('string')
    expect(err.status, 'HTTP のステータスが読めない').toBe(STATUS)
    expect(err.body, '応答の本文が読めない').toEqual({ error: REASON })

    // 2. API が失敗を返す。画面は本文の {error}（日本語）を message にして、そのまま画面に出せるようにする
    expect(err.message, '本文の {error} が message になっていない').toBe(REASON)
    invalidateCached()
    await open('/topics')
    expect(text(), '失敗の理由が画面に出ていない').toContain(REASON)

    // 事後条件: 画面は失敗の理由を日本語で出せ、status で場合分けできる
    expect(err.message, '画面に出す文が日本語になっていない').toMatch(/[ぁ-んァ-ヶ一-龥]/)
    expect(typeof err.status).toBe('number')
  })
})
