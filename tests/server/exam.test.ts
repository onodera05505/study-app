import { describe, expect, it } from 'vitest'
import targets from '../../src/shared/targets.json'
import { EXAMS, examOf } from '../../src/shared/exam'

describe('examOf（対象の登録簿）', () => {
  // @verifies REQ-039
  it('登録簿（targets.json）の対象をすべて持ち、コードは対象名を列挙しない', () => {
    const registered = Object.keys(targets as Record<string, unknown>).filter((k) => !k.startsWith('_'))
    expect(registered.length).toBeGreaterThan(1)
    expect(Object.keys(EXAMS).sort()).toEqual(registered.sort())
  })

  // @verifies REQ-039
  it('key を登録簿の値で解決する', () => {
    const raw = (targets as unknown as Record<string, { brand: string; mockSize: number; roadmap: boolean }>).ip
    const ip = examOf('ip')
    expect(ip.key).toBe('ip')
    expect(ip.brand).toBe(raw.brand)
    expect(ip.mockSize).toBe(raw.mockSize)
    expect(ip.roadmap).toBe(raw.roadmap)
  })

  // @verifies REQ-096
  it('未知の key と未指定は既定（ip）に倒れる', () => {
    expect(examOf('no-such-target').key).toBe('ip')
    expect(examOf(undefined).key).toBe('ip')
  })
})
