// @vitest-environment jsdom
/** 新しい版の検知（src/client/lib/version.ts）のうち、覚えた最初の印の保ち方を見る。
 *
 *  version.json は fetch で取るので偽物に差し替える。module の中に「最初の印」を
 *  持っているため、1 件ごとに resetModules して読み直す（tests/client/version.test.ts と同じ）。
 *  「画面」は module の実体 1 つ＝ 1 つの窓。読み直しは module を作り直すことで表す。
 *  jsdom で回すのは、窓をまたいで共有される端末の記憶（localStorage）がある環境で
 *  「窓ごとに独立して覚える」ことを見るため。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Stamp = { build: string; at: string }

const A: Stamp = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
const B: Stamp = { build: 'def5678', at: '2026-09-28T09:00:00Z' }

/** 配信物に今置かれている物。`stamp` を差し替えると次の取得から効く。
 *  `null` は取れない（ok: false）、`body` を与えると ok: 200 でその中身をそのまま返す。 */
type Shelf = { stamp: Stamp | null; body?: () => unknown }
function stubFetch(shelf: Shelf): { calls: () => number } {
  let n = 0
  vi.stubGlobal('fetch', async () => {
    n++
    if (shelf.body) return { ok: true, status: 200, json: shelf.body }
    if (!shelf.stamp) return { ok: false, status: 500, json: async () => ({}) }
    const s = shelf.stamp
    return { ok: true, status: 200, json: async () => s }
  })
  return { calls: () => n }
}

/** 1 つの窓を開く（module を作り直す）。 */
async function openWindow() {
  vi.resetModules()
  return await import('../../src/client/lib/version')
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('最初の印の保ち方（UC-016）', () => {
  // @covers REQ-227#keep-until-reload
  it('取り直しを重ねても最初の印は上書きされず、見比べの相手は開いたときの印のまま', async () => {
    const shelf: Shelf = { stamp: A }
    stubFetch(shelf)
    const v = await openWindow()
    expect(await v.checkForUpdate()).toBe(false)

    shelf.stamp = B
    expect(await v.checkForUpdate()).toBe(true)
    // 取り直した B を最初の印として覚え直していれば、ここで合図が消える
    expect(await v.checkForUpdate(), '取り直した印で最初の印が上書きされている').toBe(true)
    // 配信物が開いたときの印に戻れば、見比べの相手は A のままなので合図は立たない
    shelf.stamp = A
    expect(await v.checkForUpdate(), '見比べの相手が開いたときの印でなくなっている').toBe(false)
  })

  // @covers REQ-232#refetch-fails-while-remembered
  it('覚えている状態で取り直しが失敗しても、合図を立てず、覚えている印は保つ', async () => {
    const shelf: Shelf = { stamp: A }
    stubFetch(shelf)
    const v = await openWindow()
    expect(await v.checkForUpdate()).toBe(false)

    shelf.stamp = null
    expect(await v.checkForUpdate(), '取り直せないのに合図を立てている').toBe(false)
    // 覚えている印が失敗で消えていれば、次に取れた B を最初の印にして合図が立たない（REQ-233 の経路に落ちる）
    shelf.stamp = B
    expect(await v.checkForUpdate(), '取り直しの失敗で覚えていた印が消えている').toBe(true)
  })

  // @covers REQ-232#malformed-stamp
  it.each<[string, () => unknown]>([
    ['印が無い（空の本文）', async () => ({})],
    ['版を見分ける値が無い', async () => ({ at: '2026-09-28T09:00:00Z' })],
    ['版を見分ける値が文字列でない', async () => ({ build: 1234567, at: '2026-09-28T09:00:00Z' })],
    ['版を見分ける値が空文字', async () => ({ build: '', at: '2026-09-28T09:00:00Z' })],
    ['印そのものが null', async () => null],
    ['JSON として読めない', async () => { throw new SyntaxError('Unexpected token <') }],
  ])('配信物の印が読めない形（%s）のときは印が無いものとして扱い、合図を立てない', async (_label, body) => {
    const shelf: Shelf = { stamp: A }
    stubFetch(shelf)
    const v = await openWindow()
    expect(await v.checkForUpdate()).toBe(false)

    shelf.body = body
    expect(await v.checkForUpdate(), '読めない印を新しい版として扱っている').toBe(false)
  })

  // @covers REQ-233#adopted-then-changed
  it('開いたときに取れず次に取れた印を覚えたあとは、その印と違う印で合図が立つ', async () => {
    const shelf: Shelf = { stamp: null }
    stubFetch(shelf)
    const v = await openWindow()

    shelf.stamp = A
    // その回は合図を立てず、A を最初の印として覚える
    expect(await v.checkForUpdate()).toBe(false)
    shelf.stamp = B
    expect(await v.checkForUpdate(), '覚え直した印が見比べの相手になっていない').toBe(true)
  })

  // @covers REQ-234#notice-per-window
  it('同じ利用者が 2 つ開いた窓は印を独立して覚え、片方を読み直しても他方の合図は残る', async () => {
    const shelf: Shelf = { stamp: A }
    stubFetch(shelf)
    const w1 = await openWindow()
    const w2 = await openWindow()
    expect(await w1.checkForUpdate()).toBe(false)
    expect(await w2.checkForUpdate()).toBe(false)

    shelf.stamp = B
    expect(await w1.checkForUpdate()).toBe(true)
    expect(await w2.checkForUpdate()).toBe(true)

    // 窓 1 だけ読み直す（新しい版 B で開き直すので、窓 1 の合図は消える）
    const w1Reloaded = await openWindow()
    expect(await w1Reloaded.checkForUpdate(), '読み直した窓が古い印を引き継いでいる').toBe(false)
    // 窓 2 は読み直していないので合図は残る
    expect(await w2.checkForUpdate(), '別の窓の読み直しで合図が消えている').toBe(true)
  })
})
