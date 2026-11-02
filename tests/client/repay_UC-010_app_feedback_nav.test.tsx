// @vitest-environment jsdom
/** App の外枠から見た添え先。まだ学びの画面を開いていない状態でフィードバックの画面へ移っても、
 *  フィードバックの画面自身が添え先にならないことを見る。
 *
 *  立ち上げ方は tests/client/update_bar.test.tsx と同じ（1 件ごとに resetModules、fetch は偽物）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

let container: HTMLElement | null = null
let root: Root | null = null

let appMod!: typeof import('../../src/client/App')
let lastPageMod!: typeof import('../../src/client/lib/lastPage')

const STAMP = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
const SSO_CONFIG = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
const ME = {
  user: { id: 'u-1', name: '寺田テスト', role: 'MEMBER' },
  topics: { total: 0, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

/** 画面が取りに行く一覧は空で返す（中身はこの検査の対象ではない）。 */
function apiBody(url: string): unknown {
  if (url.includes('version.json')) return STAMP
  if (url.includes('/auth/config')) return SSO_CONFIG
  if (url.includes('/me')) return ME
  if (url.includes('/glossary')) return { glossary: [] }
  if (url.includes('/fields')) return { fields: [] }
  if (url.includes('/categories')) return { categories: [] }
  if (url.includes('/exams')) return { exams: [] }
  if (url.includes('/sessions/current')) return { session: null }
  if (url.includes('/sessions')) return { sessions: [] }
  if (url.includes('/topics')) return { topics: [] }
  return {}
}

/** name を持つトークン（署名は読まない）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

async function start() {
  vi.stubGlobal('fetch', async (url: string) => {
    const body = apiBody(String(url))
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
  vi.resetModules()
  appMod = await import('../../src/client/App')
  lastPageMod = await import('../../src/client/lib/lastPage')
  const { setToken } = await import('../../src/client/lib/api')
  setToken(jwtWith({ sub: 'u-1', name: '寺田テスト', role: 'MEMBER' }))
}

async function teardown() {
  if (root) {
    const r = root
    root = null
    await act(async () => {
      r.unmount()
    })
  }
  container?.remove()
  container = null
}

/** 画面を開く（MemoryRouter は初期の場所しか見ないので、根ごと作り直して描く）。 */
async function open(entry: string) {
  await teardown()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(appMod.App)))
  })
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  await teardown()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('添え先を覚えていない状態での移動（UC-010）', () => {
  // @covers REQ-147#keep-none
  it('何も覚えていない状態でフィードバックの画面へ移っても、添え先はできない', async () => {
    await start()
    expect(lastPageMod.getLastPage()).toBeNull()

    await open('/feedback')
    expect(container!.querySelector('textarea'), 'フィードバックの画面が描かれていない').not.toBeNull()
    // フィードバックの画面自身は添え先にならない
    expect(lastPageMod.getLastPage()).toBeNull()
  })
})
