// @vitest-environment jsdom
/** UC-033 の REQ-573（画面側）: 断りの応答が種類の名前（`code`）を持っても、画面が示す理由の文は応答の `error` の文のまま。
 *  失敗を受ける画面の 1 つとして学習の画面（分野の集計 listFields を取る画面）を本物の React で描き、
 *  分野の集計の取得を、名前を持つ断り（ErrorBody の `error` と `code`）で返す。サーバの応答は fetch を偽物にして与える。
 *  名前は、どの経路にも立つ断り（ADR-0011）のうち、画面がログインへ戻さない 2 つ（INTERNAL・NOT_CONFIGURED）を取る。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Topics } from '../../src/client/pages/Topics'
import { invalidateCached } from '../../src/client/lib/api'

/** 断りの応答（状態の番号・理由の文・名前）。 */
const REFUSALS = [
  { status: 500, error: 'サーバで処理できませんでした。時間をおいてやり直してください。', code: 'INTERNAL' },
  { status: 503, error: 'この配備ではまだ使えません。', code: 'NOT_CONFIGURED' },
] as const

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 分野の集計だけを名前を持つ断りで返す偽の fetch。ほかの取得は空の成功。 */
function stubApi(refusal: (typeof REFUSALS)[number]) {
  vi.stubGlobal('fetch', async (raw: string) => {
    const p = new URL(String(raw), 'http://localhost').pathname
    if (p.endsWith('/fields')) return json({ error: refusal.error, code: refusal.code }, refusal.status)
    if (p.endsWith('/categories')) return json({ categories: [] })
    if (p.endsWith('/topics')) return json({ structure: null, topics: [] })
    if (p.endsWith('/glossary')) return json({ glossary: [] })
    return json({})
  })
}

let container: HTMLElement
let root: Root

const text = () => (container.textContent ?? '').replace(/\s+/g, ' ')

async function draw() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/topics']}>
        <Routes>
          <Route path="/topics" element={<Topics />} />
        </Routes>
      </MemoryRouter>,
    )
  })
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
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('UC-033 REQ-573 断りの種類の名前（画面）', () => {
  // @covers REQ-573#unchanged-screen
  it('名前を持つ断りを受けた画面は、応答の error の文を理由として示し、名前そのものは示さない', async () => {
    for (const refusal of REFUSALS) {
      invalidateCached()
      stubApi(refusal)
      await draw()
      expect(text(), `${refusal.code}: 応答の理由の文が画面に出ていない`).toContain(refusal.error)
      expect(text(), `${refusal.code}: 断りの種類の名前が画面に出ている`).not.toContain(refusal.code)
      await act(async () => {
        root.render(null)
      })
      vi.unstubAllGlobals()
    }
  })
})
