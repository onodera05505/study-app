/** UC-044「手元に依らない検査を共有の置き場で回し、手元に依る検査を手元の入口に受け持たせる」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。回さない物の跡・落ちたテスト・名前の食い違い・振り分けの形は各要件のテストが見る）。
 *
 *  共有の置き場（GitHub）の検査の環境は、手元の物を持たない影の根の小さな作業ツリーで代える（tests/server/UC-044_fixture.local.ts の makeShadow）。
 *  影の根は、手元に依らないテストのファイル 1 つと、手元の物の土台を読み込む手元だけのテストのファイル 1 つと、
 *  受け持ちが手元の物の土台を読み込む手元だけの UC 1 つを持つ。
 *  運用者が出した変更に対して共有の置き場が回す入口は runPortableChecks（操作 → 入口の規則で scripts/run_portable_checks.*）。
 *  土台の runPortableChecks が、影の根の中の写しを、影の根を作業の置き場にし、親のテストの組の環境を外した環境の子のプロセスで回す。
 *  本番の保存先・配備の道具には触れない。 */

import { afterAll, describe, expect, it } from 'vitest'
import { makeShadow, removeTemps, runPortableChecks } from '../server/UC-044_fixture.local'

/** 実行の記録の門は、原本 harness の `lint coverage`。名前として示されるのはその語。 */
const RECORD_GATE = 'coverage'

afterAll(async () => {
  await removeTemps()
})

describe('UC-044 手元に依らない検査を共有の置き場で回し、手元に依る検査を手元の入口に受け持たせる', () => {
  // @scenario UC-044
  it('変更を共有の置き場に出すと、手元に依らない検査がすべて通り、手元の入口が受け持つテストのファイル・契約の実例の UC・実行の記録の門の名前が示される', () => {
    const shadow = makeShadow()
    // 1. 運用者が、変更を共有の置き場に出す（共有の置き場が手元に依らない検査の入口を回す）
    // 2〜4. システムが振り分け、手元に依らない検査を回し、手元の入口が受け持つ物の名前を示して結果を返す
    const r = runPortableChecks(shadow)
    // 5. 運用者が、通ったことと、手元の入口が受け持つ物の名前を見る
    expect(r.status, r.out).toBe(0)
    expect(r.out, '手元だけのテストのファイルの名前が示されていない').toContain(shadow.localTest)
    expect(r.out, '手元だけの UC の名前が示されていない').toContain(shadow.localUc)
    expect(r.out, '実行の記録の門の名前が示されていない').toContain(RECORD_GATE)
  }, 600_000)
})
