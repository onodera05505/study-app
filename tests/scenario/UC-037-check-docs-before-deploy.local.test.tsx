/** UC-037「配備の前に、文書の索引と門の対応表と決定の記録が現物と食い違っていないことを確かめる」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。食い違いの種類ごとと審議台帳の形は各要件のテストが見る）。
 *  運用者は文書の検査（checkDocs ＝ `python3 scripts/check_docs.py`）を手元の作業ツリーで 1 回回す。 */

import { describe, expect, it } from 'vitest'
import { crashed, runReal } from '../server/UC-037_fixture.local'

describe('UC-037 配備の前に、文書が現物と食い違っていないことを確かめる', () => {
  // @scenario UC-037
  it('運用者が文書の検査を回すと、文書と記録が現物と一致したことが示され、配備に進める', () => {
    // 1〜3. 運用者が文書の検査を回し、システムが確かめて、一致したことを示して終える
    const r = runReal('check_docs.py')
    expect(crashed(r), r.out).toBe(false)
    // 4. 運用者が、一致したことを見る（成功で終わり、示した文がある）
    expect(r.status, r.out).toBe(0)
    expect(r.stdout.trim().length, '一致したことが示されていない').toBeGreaterThan(0)
  }, 300_000)
})
