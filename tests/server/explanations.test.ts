import { describe, expect, it } from 'vitest'
import { explanationOf } from '../../src/server/lib/explanations'

const choices = [
  { label: 'ア', term: null, note: '正解。需要と供給が釣り合う点。' },
  { label: 'イ', term: '損益分岐点', note: '売上と費用が等しくなる点の説明。' },
]

describe('explanationOf（問題ごとの解説）', () => {
  // @verifies REQ-022
  it('列から正解の根拠と誤答の note を組む', () => {
    const got = explanationOf({
      explCorrectReason: '正解はア。均衡点の定義そのもの。',
      explChoicesJson: JSON.stringify(choices),
    })
    expect(got).not.toBeNull()
    expect(got!.correctReason).toBe('正解はア。均衡点の定義そのもの。')
    expect(got!.choices).toHaveLength(2)
    expect(got!.choices[1]).toEqual({ label: 'イ', term: '損益分岐点', note: '売上と費用が等しくなる点の説明。' })
  })

  // @verifies REQ-022
  it('根拠か選択肢が欠けていれば null', () => {
    expect(explanationOf({ explCorrectReason: null, explChoicesJson: JSON.stringify(choices) })).toBeNull()
    expect(explanationOf({ explCorrectReason: '正解はア。', explChoicesJson: null })).toBeNull()
  })

  // @verifies REQ-022
  it('選択肢の JSON が壊れていても配列でなくても null', () => {
    expect(explanationOf({ explCorrectReason: '正解はア。', explChoicesJson: '{壊れた' })).toBeNull()
    expect(explanationOf({ explCorrectReason: '正解はア。', explChoicesJson: '{"label":"ア"}' })).toBeNull()
  })
})
