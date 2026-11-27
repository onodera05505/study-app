// @vitest-environment jsdom
/** UC-017 学びとまなびばの要求の受け口を一様に守る（画面側）。
 *  失敗を受ける画面の 1 つとして学習の画面（分野の集計 listFields を取る画面）を本物の React で描き、
 *  分野の集計の取得が失敗の応答で返り、本文に理由（ErrorBody の error）が無いときに、画面に出た文を見る。
 *  「理由が無い」は、本文に error の項目が無い場合と、本文が読めない場合（中継機の HTML・空）の両方。
 *  倒した 1 文の語そのものと、それを出す場所は画面のコードが正本なので、語も場所も固定しない。
 *  同じ取得の失敗に目印の理由を添えて描いた画面には無く、理由の無い失敗で描いた画面にだけある文を、
 *  要素ごとの文字の集まりの差として取り出し、その中に日本語の 1 文があることを見る。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Topics } from '../../src/client/pages/Topics'
import { invalidateCached } from '../../src/client/lib/api'

/** 理由が出る場所を決めるための目印の理由。 */
const MARKER = '目印の理由ここまで'

/** 理由の無い失敗の応答と、その本文に入っていて画面に出てはいけない文字。 */
const REASONLESS: Array<{ label: string; response: () => Response; leaks: string[] }> = [
  {
    label: '本文に error の項目が無い（ほかの項目だけ）',
    response: () =>
      new Response(JSON.stringify({ detail: 'upstream-timeout-91c2' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    leaks: ['upstream-timeout-91c2', 'detail'],
  },
  {
    label: '本文が中継機の HTML',
    response: () =>
      new Response('<html><body><h1>502 Bad Gateway</h1>cloudflare</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    leaks: ['Bad Gateway', 'cloudflare', '<html', '502'],
  },
  {
    label: '本文が空',
    response: () => new Response('', { status: 503 }),
    leaks: ['503', 'Service Unavailable'],
  },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 分野の集計だけを fieldsFailure の応答で返す偽の fetch。ほかの取得は空の成功。 */
function stubApi(fieldsFailure: () => Response) {
  vi.stubGlobal('fetch', async (raw: string) => {
    const p = new URL(String(raw), 'http://localhost').pathname
    if (p.endsWith('/fields')) return fieldsFailure()
    if (p.endsWith('/categories')) return json({ categories: [] })
    if (p.endsWith('/topics')) return json({ structure: null, topics: [] })
    if (p.endsWith('/glossary')) return json({ glossary: [] })
    return json({})
  })
}

let container: HTMLElement
let root: Root

const text = () => (container.textContent ?? '').replace(/\s+/g, ' ')

async function drawWith(fieldsFailure: () => Response): Promise<string> {
  await act(async () => {
    root.render(null)
  })
  invalidateCached()
  stubApi(fieldsFailure)
  await act(async () => {
    root.render(
      h(MemoryRouter, { initialEntries: ['/topics'] }, h(Routes, null, h(Route, { path: '/topics', element: h(Topics) }))),
    )
  })
  return text()
}

/** 描いた画面の、要素ごとの文字（空白を詰めたもの）の集まり。 */
function segments(): Set<string> {
  const out = new Set<string>()
  for (const el of container.querySelectorAll('*')) {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (t !== '') out.add(t)
  }
  return out
}

const JAPANESE = /[ぁ-んァ-ヶ一-龥]/
/** 文の終わりの記号が、あっても末尾の 1 つだけ（1 文）。 */
const ONE_SENTENCE = /^[^。！？!?\n]*[。！？!?]?$/

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
  // @covers REQ-261#fallback-on-screen
  it('失敗の応答の本文に理由が無ければ、日本語の 1 文が画面に出て、本文の中身は出ない', async () => {
    const marked = await drawWith(() => json({ error: MARKER }, 500))
    expect(marked, '失敗の理由を画面に出す画面になっていない（目印の理由が画面に出ていない）').toContain(MARKER)
    const markedSegments = segments()

    const problems: string[] = []
    const fallbacks: string[] = []
    for (const { label, response, leaks } of REASONLESS) {
      const shown = await drawWith(response)
      for (const leak of leaks) if (shown.includes(leak)) problems.push(`${label}: 本文の中身「${leak}」が画面に出ている`)
      // 理由の無い失敗の画面にだけある文のうち、日本語の 1 文であるもの
      const sentences = [...segments()]
        .filter((t) => !markedSegments.has(t))
        .filter((t) => JAPANESE.test(t) && ONE_SENTENCE.test(t))
        .sort()
      if (sentences.length === 0) problems.push(`${label}: 日本語の 1 文が出ていない（${shown}）`)
      fallbacks.push(JSON.stringify(sentences))
    }
    expect(problems).toEqual([])
    expect(new Set(fallbacks).size, '理由の無い失敗ごとに出る文が違う（同じ 1 文に倒れていない）').toBe(1)
  })
})
