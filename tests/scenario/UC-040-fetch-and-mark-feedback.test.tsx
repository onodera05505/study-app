/** UC-040「届いたフィードバックを取り出し、処理の状態を付ける」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。見つからないフィードバックと保存先の失敗は各要件のテストが見る）。
 *  運用者はフィードバックの道具（feedback ＝ `python3 scripts/feedback.py`）を、影の根の偽の保存先（tests/server/UC-040_fixture.ts）で回す。 */

import { afterAll, describe, expect, it } from 'vitest'
import { crashed, removeTemps, shadow } from '../server/UC-040_fixture'

afterAll(removeTemps)

describe('UC-040 届いたフィードバックを取り出し、処理の状態を付ける', () => {
  // @scenario UC-040
  it('運用者が未処理のフィードバックを取り出し、直したものに処理の状態と注記を付け、未処理の件数を確かめる', () => {
    const s = shadow()
    s.put('mkt', [
      { id: 'fb-scn-1', body: '次へと戻るの場所が分かりにくい' },
      { id: 'fb-scn-2', body: '図の文字が小さい' },
    ])

    // 1〜2. 運用者が学びを指定して未処理のフィードバックを取り出し、システムが示して手元の受け箱に保存する
    const fetched = s.run(['fetch', 'mkt'])
    expect(crashed(fetched), fetched.out).toBe(false)
    expect(fetched.status, fetched.out).toBe(0)
    expect(fetched.stdout).toContain('次へと戻るの場所が分かりにくい')
    expect(Object.values(s.inbox('mkt')).join('\n')).toContain('fb-scn-1')

    // 3〜4. 運用者が直したフィードバックに処理の状態と注記を付け、システムがその状態を書き換える
    const marked = s.run(['mark', 'mkt', 'fb-scn-1', '--status', 'done', '--note', '次へと戻るを大きくした'])
    expect(marked.status, marked.out).toBe(0)
    const rows = Object.fromEntries(s.rows('mkt').map((x) => [x.id, x]))
    expect(rows['fb-scn-1']).toMatchObject({ status: 'done', note: '次へと戻るを大きくした' })
    expect(rows['fb-scn-2'].status).toBe('new')

    // 5. 運用者が未処理の件数を確かめる（直した 1 件が減り、mkt の未処理は 1 件）
    const summary = s.run(['summary'])
    expect(summary.status, summary.out).toBe(0)
    const lines = summary.stdout.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/mkt\D{0,4}1(?!\d)|(?<!\d)1\D{0,6}mkt/)
  }, 120_000)
})
