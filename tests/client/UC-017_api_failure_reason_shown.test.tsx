// @vitest-environment jsdom
/** UC-017 学びとまなびばの要求の受け口を一様に守る（画面側）。
 *  失敗を受ける画面の 1 つとして学習の画面（分野の集計 listFields を取る画面）を本物の React で描き、
 *  分野の集計の取得が失敗の応答で返り、本文に理由（ErrorBody の error）が添えられているときに、
 *  画面に出た文を見る。サーバの応答は fetch を偽物にして与える（形は UC-002 の契約の response）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Topics } from '../../src/client/pages/Topics'
import { invalidateCached } from '../../src/client/lib/api'

/** 失敗の応答の本文に添えられた理由（利用者に見える日本語の文）。 */
const REASON = '分野の集計を今は取り出せません。'
/** 理由のほかに本文に入っている項目の値（画面に出てはいけない）。 */
const OTHER_ITEM = 'd1-binding-trace-7f3a'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 分野の集計だけを、理由と別の項目を添えた失敗の応答で返す偽の fetch。ほかの取得は空の成功。 */
function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const p = new URL(String(raw), 'http://localhost').pathname
    if (p.endsWith('/fields')) return json({ error: REASON, detail: OTHER_ITEM }, 400)
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

describe('UC-017 学びとまなびばの要求の受け口を一様に守る', () => {
  // @covers REQ-261#reason-on-screen
  it('失敗の応答の本文に理由が添えられていれば、その理由の文が画面に出て、本文のほかの項目は出ない', async () => {
    stubApi()
    await draw()
    expect(text(), '本文に添えられた理由の文が画面に出ていない').toContain(REASON)
    expect(text(), '本文の理由でない項目が画面に出ている').not.toContain(OTHER_ITEM)
    expect(text(), '本文の項目の名前が画面に出ている').not.toMatch(/\bdetail\b|\berror\b/)
  })
})
