// @vitest-environment jsdom
/** 分野・単元の集計の記憶（apiCached / invalidateCached）と
 *  「前回の続き」（getLastTopic / setLastTopic）。
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

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('分野・単元の集計の記憶', () => {
  // @verifies REQ-054
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

  // @verifies REQ-054
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

  // @verifies REQ-129
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

describe('前回の続き（最後に開いた論点）', () => {
  // @verifies REQ-155
  it('覚えていなければ無し、覚えたあとは同じ論点が返る', async () => {
    const m = await load()
    expect(m.getLastTopic()).toBeNull()
    m.setLastTopic(TOPIC)
    expect(m.getLastTopic()).toEqual(TOPIC)
  })

  // @verifies REQ-040
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

  // @verifies REQ-040
  it('端末に保存できないときも例外を投げない（操作を止めない）', async () => {
    const m = await load()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('保存できない端末')
    })
    expect(() => m.setLastTopic(TOPIC)).not.toThrow()
  })

  // @verifies REQ-158
  it('覚えていた値が読めないときは無しを返す（例外を投げない）', async () => {
    const m = await load()
    m.setLastTopic(TOPIC)
    const key = keyHolding(localStorage, 'LTV')!
    localStorage.setItem(key, '{壊れた値')
    expect(() => m.getLastTopic()).not.toThrow()
    expect(m.getLastTopic()).toBeNull()
  })
})
