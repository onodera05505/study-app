/** UC-036「配る前に手元の配備に API と画面を当てて、契約と食い違う応答と崩れた画面を見つける」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。食い違いと登録簿に無い学びは各要件のテストが見る）。
 *  運用者は、手元の保存先がそろった作業の場所（影の根。tests/server/UC-036_fixture.local.ts）で、学びの API の検査・まなびばの API の検査・
 *  画面の採取を順に回す。学びは契約の実例どおり ip。 */

import { existsSync, readdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { auditScreens, checkApi, checkPortalApi, crashed, removeTemps, toolShadow } from '../server/UC-036_fixture.local'

afterAll(async () => {
  await removeTemps()
})

describe('UC-036 配る前に手元の配備に API と画面を当てる', () => {
  // @scenario UC-036
  it('運用者が学びとまなびばの API の検査と画面の採取を回すと、食い違いが無く、画面の写しの一覧が書き出される', async () => {
    const shadow = toolShadow()

    // 1〜2. 運用者が学び ip を指定して API の検査を回し、システムが手元に配備を起こして応答を契約と登録簿に照らして終える
    const api = await checkApi(shadow, 'ip')
    expect(crashed(api), api.out).toBe(false)
    expect(api.status, `学びの API の検査で食い違いが挙がった: ${api.out.slice(-4000)}`).toBe(0)

    // 3〜4. 運用者がまなびばの API の検査を回し、システムが手元にまなびばの配備を起こして応答を要件に照らして終える
    const portal = await checkPortalApi(shadow)
    expect(crashed(portal), portal.out).toBe(false)
    expect(portal.status, `まなびばの API の検査で食い違いが挙がった: ${portal.out.slice(-4000)}`).toBe(0)

    // 5〜6. 運用者が学び ip を指定して画面の採取を回し、システムが検査用のアカウントを用意して画面の組ごとに写しを撮って書き出す
    const out = shadow.path('screens')
    const screens = await auditScreens(shadow, ['ip', '--out', out, '--limit', '2'])
    expect(crashed(screens), screens.out).toBe(false)
    expect(screens.status, screens.out.slice(-4000)).toBe(0)

    // 7. 運用者が、食い違いが無いことと、撮れた写しを見る（成功時: 写しの一覧）
    expect(existsSync(out), '写しの書き出し先が無い').toBe(true)
    const files = readdirSync(out)
    expect(files.filter((n) => n.endsWith('.png')).length, '撮れた写しが無い').toBeGreaterThan(0)
    expect(files.filter((n) => n.endsWith('.json')).length, '写しの一覧が無い').toBeGreaterThan(0)
  }, 1_800_000)
})
