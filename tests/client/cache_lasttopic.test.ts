// @vitest-environment jsdom
/** 分野・単元の集計の記憶（apiCached / invalidateCached）と
 *  「前回の続き」（getLastTopic / setLastTopic。覚えられないときは論点の画面 TopicDetail を描いて見る）。
 *
 *  どちらも src/client/lib/api.ts がモジュールの中に状態を持つので、テストごとに読み直す。
 *  端末に置く値は鍵の名前に頼らずに見る（鍵の名前は仕様ではない）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function load() {
  vi.resetModules()
  return await import('../../src/client/lib/api')
}

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 端末の中で needle を含む値を持つ鍵（鍵の名前を仕様にしないための探し方）。 */
function keyHolding(s: Storage, needle: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)!
    if ((s.getItem(k) ?? '').includes(needle)) return k
  }
  return null
}

const TOPIC = { id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 }

/** 論点の画面が読む応答（契約 UC-002 getTopicDetail の形。過去問は持たない）。 */
const TOPIC_DETAIL = {
  topic: {
    ...TOPIC,
    subtitle: null,
    explanation: '短い説明の本文です。',
    detail: '詳しい解説の本文です。',
    questionCount: 0,
    frequencyTier: 3,
    isNew: 0,
    status: 3,
    statusSource: 'override',
    field: 'ストラテジ系',
    major: '企業と法務',
    itemName: '会計と財務',
    tier: null,
  },
  questions: [],
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('分野・単元の集計の記憶', () => {
  // @covers REQ-018#aggregate-remembered
  it('同じ path は画面を開いている間 1 回しか取りに行かない', async () => {
    const m = await load()
    const fetchMock = vi.fn(async () => okJson({ fields: [{ field: 'ストラテジ系' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const first = await m.apiCached('/fields')
    const second = await m.apiCached('/fields')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
    // 別の path は別に取りに行く（記憶は path ごと）
    await m.apiCached('/categories')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // @covers REQ-017#failure-not-cached
  it('失敗した取得は覚えず、次に求めたときに取り直す', async () => {
    const m = await load()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () =>
      ++n === 1 ? okJson({ error: '取得できませんでした' }, 500) : okJson({ fields: [] }),
    ))
    await expect(m.apiCached('/fields')).rejects.toBeTruthy()
    await expect(m.apiCached('/fields')).resolves.toEqual({ fields: [] })
    expect(n).toBe(2)
  })

  // @covers REQ-040#aggregate-refetched-after-record
  it('集計を捨てたあと（invalidateCached）は同じ path でも取り直す', async () => {
    const m = await load()
    const fetchMock = vi.fn(async () => okJson({ fields: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await m.apiCached('/fields')
    await m.apiCached('/categories')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    m.invalidateCached()
    await m.apiCached('/fields')
    await m.apiCached('/categories')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('前回の続き（UC-005）', () => {
  // @covers REQ-077#saved-value-readable
  it('覚えていなければ無し、覚えたあとは同じ論点が返る', async () => {
    const m = await load()
    expect(m.getLastTopic()).toBeNull()
    m.setLastTopic(TOPIC)
    expect(m.getLastTopic()).toEqual(TOPIC)
  })

  // @covers REQ-077#replaces-previous
  it('ID・名前・単元・単元番号を端末に残し、あとから開いた論点で置き換わる', async () => {
    const m = await load()
    m.setLastTopic(TOPIC)
    // モジュールの中の変数ではなく端末に残っている（読み直しても復元できる）
    expect(keyHolding(localStorage, 'LTV')).not.toBeNull()
    const reloaded = await load()
    expect(reloaded.getLastTopic()).toEqual(TOPIC)

    reloaded.setLastTopic({ id: 88, term: 'CSRF', middle: '情報セキュリティ', middleNo: 11 })
    expect(reloaded.getLastTopic()).toEqual({
      id: 88,
      term: 'CSRF',
      middle: '情報セキュリティ',
      middleNo: 11,
    })
  })

  // @covers REQ-078#storage-blocked-keeps-going
  it('端末に保存できない（覚える操作が名前を持つ失敗を渡す）ときも、論点の画面は描かれ、導線が動く', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.resetModules()
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { MemoryRouter, Route, Routes } = await import('react-router-dom')
    const { TopicDetail } = await import('../../src/client/pages/TopicDetail')
    vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
      const path = new URL(String(raw), 'http://localhost').pathname
      if (path.endsWith('/glossary')) return okJson({ glossary: [] })
      if (/\/topics\/\d+$/.test(path)) return okJson(TOPIC_DETAIL)
      return okJson({})
    }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('保存できない端末', 'QuotaExceededError')
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const h = React.createElement
    try {
      await React.act(async () => {
        root.render(
          h(
            MemoryRouter,
            { initialEntries: ['/topics/231'] },
            h(
              Routes,
              null,
              h(Route, { path: '/topics/:id', element: h(TopicDetail) }),
              h(Route, { path: '/topics', element: h('div', null, '論点の一覧の画面') }),
            ),
          ),
        )
      })
      expect(host.textContent, '論点の名前が出ていない').toContain(TOPIC.term)
      expect(host.textContent, '論点の説明が出ていない').toContain('短い説明の本文です。')
      // 画面の操作が止まっていない: 一覧への導線を選ぶと一覧の画面へ移る
      const toList = [...host.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/topics')
      expect(toList, '一覧への導線が無い').toBeTruthy()
      await React.act(async () => {
        toList!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      })
      expect(host.textContent, '導線を選んでも一覧の画面へ移らない').toContain('論点の一覧の画面')
    } finally {
      await React.act(async () => root.unmount())
      host.remove()
    }
  })

  // @covers REQ-082#unreadable-value
  it('覚えていた値が読めないときは無しを返す（例外を投げない）', async () => {
    const m = await load()
    m.setLastTopic(TOPIC)
    const key = keyHolding(localStorage, 'LTV')!
    localStorage.setItem(key, '{壊れた値')
    expect(() => m.getLastTopic()).not.toThrow()
    expect(m.getLastTopic()).toBeNull()
  })
})
