/** UC-043「手元のクローンにコミットの件名の検査を入れる」の主シナリオを 1 本で実行する写し（正常系のみ）。
 *  道具は git の設定を書き換えるので、一時の置き場に git init した別のクローン（tests/server/UC-043_fixture.ts）で回す。 */

import { afterAll, describe, expect, it } from 'vitest'
import { HOOKS, gitConfig, makeClone, removeTemps, runInstall } from '../server/UC-043_fixture'

afterAll(async () => {
  await removeTemps()
})

describe('UC-043 手元のクローンにコミットの件名の検査を入れる', () => {
  // @scenario UC-043
  it('運用者が検査を入れると、このクローンのフックの置き場がリポジトリの中の置き場に向き、向けた先が示される', () => {
    const c = makeClone()
    // 1. 運用者が、コミットの件名の検査を入れる
    const r = runInstall(c)
    // 2. システムが、フックの置き場を向け、向けた先と試し方を示す
    expect(r.status, r.out).toBe(0)
    expect(gitConfig(c, 'core.hooksPath')).toBe(HOOKS)
    expect(r.out).toContain(HOOKS)
  })
})
