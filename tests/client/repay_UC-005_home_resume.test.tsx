// @vitest-environment jsdom
/** ホームの前回の続きの導線（UC-005）。覚えた論点がもう無いとき・導線を選んだとき・端末の記憶が使えないとき。
 *  fetch を偽物にして本物の React で描く（tests/client/home.test.tsx の作法）。
 *  端末に置く値は鍵の名前に頼らずに見る（鍵の名前は仕様ではない）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { Home } from '../../src/client/pages/Home'
import { invalidateCached, setLastTopic } from '../../src/client/lib/api'

const ME = {
  user: { id: 'u-1', name: '小野寺', role: 'MEMBER' },
  topics: { total: 500, understood: 20, partly: 5 },
  recentSessions: [],
  nextTopics: [{ id: 231, term: '頻出の未理解の論点', questionCount: 8, field: 'ストラテジ系' }],
  visits: { today: '2026-09-29', streak: 7, longest: 9, total: 42 },
}

/** 端末に覚えさせる前回の続き（契約 LastTopic の 4 項目）。id は次に学ぶの候補（231）とぶつけない。 */
const REMEMBERED = { id: 777, term: '前回開いた論点', middle: '事業の指標', middleNo: 4 }

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const anchors = () => [...container.querySelectorAll('a')]
const hrefs = () => anchors().map((a) => a.getAttribute('href') ?? '')

/** 端末の中で needle を含む値を持つ鍵（鍵の名前を仕様にしないための探し方）。 */
function keyHolding(s: Storage, needle: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)!
    if ((s.getItem(k) ?? '').includes(needle)) return k
  }
  return null
}

/** 偽の fetch。`goneTopicId` を渡すと、その論点の取得だけは無い（404）と応える。 */
function stubApi(opts: { goneTopicId?: number } = {}) {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    if (opts.goneTopicId !== undefined && url.pathname.endsWith(`/topics/${opts.goneTopicId}`)) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: '論点が見つかりません' }) }
    }
    let body: unknown = {}
    if (url.pathname.endsWith('/me')) body = ME
    else if (url.pathname.endsWith('/sessions/current')) body = { session: null }
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    else if (url.pathname.endsWith('/exams')) body = { exams: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

/** 論点の画面の代わり。どの論点が開いたかを id で見分けられるようにする。 */
const TopicStub = () => <div>論点の画面 id={useParams().id}</div>

async function draw() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/topics" element={<div>論点の一覧</div>} />
          <Route path="/topics/:id" element={<TopicStub />} />
          <Route path="/practice" element={<div>練習テスト</div>} />
          <Route path="/sessions/:id" element={<div>出題の画面</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ホームの前回の続き（UC-005）', () => {
  // @covers REQ-080#remembered-topic-gone
  it('覚えた論点がもう無くても、端末に覚えた値から論点名と単元つきの同じ導線を出す', async () => {
    stubApi({ goneTopicId: REMEMBERED.id })
    setLastTopic(REMEMBERED)
    await draw()
    expect(text()).toContain('前回の続き')
    expect(text(), '覚えた論点の名前が落ちている').toContain('前回開いた論点')
    expect(text(), '覚えた単元が落ちている').toContain('事業の指標')
    expect(hrefs(), '覚えた論点への導線が落ちている').toContain('/topics/777')
  })

  // @covers REQ-081#follow-link-opens-topic
  it('前回の続きの導線を選ぶと、覚えた論点の画面が開く', async () => {
    stubApi()
    setLastTopic(REMEMBERED)
    await draw()
    const link = anchors().find((a) => a.getAttribute('href') === '/topics/777')
    await click(link, '前回の続きの導線')
    expect(text(), '覚えた論点の画面が開いていない').toContain('論点の画面 id=777')
    expect(text()).not.toContain('論点の画面 id=231')
  })

  // @covers REQ-082#storage-unavailable
  it('端末の記憶が読めない（読み取りが例外）ときは、前回の続きの導線を出さないだけにしてホームの他の部分を出す', async () => {
    stubApi()
    setLastTopic(REMEMBERED)
    const key = keyHolding(localStorage, '前回開いた論点')!
    const realGetItem = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (k === key) throw new DOMException('端末の記憶が使えない', 'SecurityError')
      return realGetItem.call(this, k)
    })
    await draw()
    expect(text()).not.toContain('前回の続き')
    expect(text()).not.toContain('前回開いた論点')
    expect(hrefs().some((h) => h === '/topics/777'), '読めないのに覚えた論点への導線がある').toBe(false)
    expect(text(), '次に学ぶが落ちている').toContain('次に学ぶ')
    expect(text(), '次に学ぶの候補が落ちている').toContain('頻出の未理解の論点')
    expect(hrefs(), '論点の一覧への導線が落ちている').toContain('/topics')
  })

  // @covers REQ-082#storage-unavailable
  it('端末が覚えられない（書き込みが例外）端末でホームを開いても、前回の続きを出さないだけにしてホームの他の部分を出す', async () => {
    stubApi()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('端末の記憶が使えない', 'QuotaExceededError')
    })
    await draw()
    expect(text()).not.toContain('前回の続き')
    expect(text(), '次に学ぶが落ちている').toContain('次に学ぶ')
    expect(text(), '次に学ぶの候補が落ちている').toContain('頻出の未理解の論点')
    expect(hrefs(), '論点の一覧への導線が落ちている').toContain('/topics')
  })
})
