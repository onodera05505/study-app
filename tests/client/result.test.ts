/** 結果画面の合否の目安（src/client/pages/Result.tsx）。
 *
 *  判定そのもの（総合 60% かつ各分野 30%）はサーバが passed と criteria で返す。
 *  ここで見るのは画面が決めている部分（文言・色）だけ。 */

import { describe, expect, it } from 'vitest'
import { fieldPctColor, verdict } from '../../src/client/pages/Result'

describe('合否の目安の表示', () => {
  // @verifies REQ-024
  it('合格圏と圏外で文言と色を出し分ける', () => {
    expect(verdict(true)).toEqual({ label: '合格ライン', color: 'var(--ok)' })
    expect(verdict(false)).toEqual({ label: '未達', color: 'var(--ng)' })
  })

  // @verifies REQ-227
  it('分野の基準点（30%）に達していない分野を色で示す', () => {
    expect(fieldPctColor(30, 30, true)).toBe('var(--ok)')
    expect(fieldPctColor(29, 30, true)).toBe('var(--ng)')
    expect(fieldPctColor(100, 30, true)).toBe('var(--ok)')
    expect(fieldPctColor(0, 30, true)).toBe('var(--ng)')
  })

  // @verifies REQ-227
  it('分野ごとの基準点が無い試験では色を付けない（落ちると誤解させない）', () => {
    expect(fieldPctColor(29, 30, false)).toBeUndefined()
    expect(fieldPctColor(100, 30, false)).toBeUndefined()
  })
})
