/** UC-035「テストを回して実行の記録を書き出し、どのテストからも動かないコードを門で見つけられるようにする」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。写しの置き場・道具の出す物・前の実行の分・環境を作れない・読めない記録は各要件のテストが見る）。
 *  運用者は記録つきの実行の入口（`node tests/support/coverage/run.mjs`）を回す。リポジトリ全体は数分かかるので、
 *  小さな置き場（`TEST_RECORD_ROOT`。tests/server/UC-035_fixture.ts）で回す。門が読む記録の置き場は harness.config.json の coverage.report。 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ROOT, hitsOf, lineOf, placeRecord, recordPlace, removeTemps, runRecorded, sectionsOf } from '../server/UC-035_fixture'

afterAll(async () => {
  await removeTemps()
})

describe('UC-035 テストを回して実行の記録を書き出す', () => {
  // @scenario UC-035
  it('運用者がテストを回すと、テストから動いた道具の行と関数が写し元のファイルとして載った実行の記録が、門の読む置き場に書き出される', () => {
    const place = recordPlace()
    // 1〜3. 運用者がテストを回し、システムが動いた行と関数を記録して、1 つの実行の記録に書き出す
    const r = runRecorded(place)
    expect(r.status, r.out).toBe(0)
    // 4. 運用者が、書き出された実行の記録を門に渡す（門が読む置き場に記録がある）
    const report = (JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8')) as { coverage: { report: string } }).coverage.report
    const records = placeRecord(place)
    expect(report, '門が読む置き場が coverage/lcov.info でない').toBe('coverage/lcov.info')
    expect(records, '実行の記録が書き出されていない').not.toBeNull()
    const py = 'scripts/uc035_tool.py'
    expect(hitsOf(sectionsOf(place, records!, py), lineOf(py, "print('python from copy')")), '写しで動いた道具が写し元として載っていない').toBeGreaterThan(0)
  }, 300_000)
})
