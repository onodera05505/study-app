/** 新しい版の検知（src/client/lib/version.ts）。
 *
 *  version.json は fetch で取るので偽物に差し替える。module の中に「最初の印」を
 *  持っているため、1 件ごとに resetModules して読み直す。 */

import { afterEach, describe, expect, it, vi } from 'vitest'

type Stamp = { build: string; at: string }

/** version.json を返す偽の fetch。配列の順に返し、尽きたら最後の値を返し続ける。
 *  null は「取れなかった」（ok: false）。 */
function stubFetch(stamps: (Stamp | null)[]): { urls: string[] } {
  const urls: string[] = []
  let i = 0
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url))
    const s = stamps[Math.min(i++, stamps.length - 1)]
    if (!s) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => s }
  })
  return { urls }
}

async function load() {
  vi.resetModules()
  return await import('../../src/client/lib/version')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('新しい版の検知', () => {
  // @verifies REQ-032
  it('版が同じなら更新の合図は立たない', async () => {
    stubFetch([{ build: 'abc1234', at: '2026-09-28T00:00:00Z' }])
    const v = await load()
    expect(await v.checkForUpdate()).toBe(false)
  })

  // @verifies REQ-032
  it('版が違えば更新の合図が立つ', async () => {
    stubFetch([
      { build: 'abc1234', at: '2026-09-28T00:00:00Z' },
      { build: 'def5678', at: '2026-09-28T01:00:00Z' },
    ])
    const v = await load()
    expect(await v.checkForUpdate()).toBe(true)
  })

  // @verifies REQ-032
  it('同じコミットを出し直しても時刻が変われば合図が立つ', async () => {
    stubFetch([
      { build: 'abc1234', at: '2026-09-28T00:00:00Z' },
      { build: 'abc1234', at: '2026-09-28T09:00:00Z' },
    ])
    const v = await load()
    expect(await v.checkForUpdate()).toBe(true)
  })

  // @verifies REQ-032
  it('version.json が取れないときは合図を立てない（帯を誤って出さない）', async () => {
    stubFetch([null])
    const v = await load()
    expect(await v.checkForUpdate()).toBe(false)
  })

  // @verifies REQ-032
  it('最初の印が取れなかったときは、次に取れた値を最初の印にする', async () => {
    stubFetch([
      null,
      { build: 'abc1234', at: '2026-09-28T00:00:00Z' },
      { build: 'abc1234', at: '2026-09-28T00:00:00Z' },
    ])
    const v = await load()
    // 1 回目: 最初の印が無いので合図は立てず、取れた値を最初の印にする
    expect(await v.checkForUpdate()).toBe(false)
    // 2 回目: その印と同じなので、まだ立たない
    expect(await v.checkForUpdate()).toBe(false)
  })

  // @verifies REQ-032
  it('最初の印を取りに行くのは何度呼んでも 1 回', async () => {
    const { urls } = stubFetch([{ build: 'abc1234', at: '2026-09-28T00:00:00Z' }])
    const v = await load()
    await Promise.all([v.rememberBuild(), v.rememberBuild(), v.rememberBuild()])
    expect(urls).toEqual(['/version.json'])
  })

  // @verifies REQ-032
  it('版が違っても自動では読み直さない（更新は押されたときだけ）', async () => {
    stubFetch([
      { build: 'abc1234', at: '2026-09-28T00:00:00Z' },
      { build: 'def5678', at: '2026-09-28T01:00:00Z' },
    ])
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const v = await load()
    expect(await v.checkForUpdate()).toBe(true)
    expect(reload).not.toHaveBeenCalled()
  })

  // @verifies REQ-032
  it('見比べる間隔は 5 分', async () => {
    stubFetch([{ build: 'abc1234', at: '2026-09-28T00:00:00Z' }])
    const v = await load()
    expect(v.CHECK_INTERVAL_MS).toBe(5 * 60 * 1000)
  })
})
