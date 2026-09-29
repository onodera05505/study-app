import { describe, expect, it } from 'vitest'
import { snapshotOf, type QuestionRow } from '../../src/server/lib/session-builder'

/** 偽の行（tests/server/session-builder.test.ts の row と同じ形）。 */
function row(over: Partial<QuestionRow> & { id: string; exam: string }): QuestionRow {
  return {
    text: `${over.id} の本文`,
    choices: JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
    answer: 'ア',
    hasFigure: 0,
    figureDescription: null,
    figureImage: null,
    citation: `出典：${over.exam} 問${over.number ?? 1}`,
    modified: 0,
    examLabel: over.exam,
    number: 1,
    field: null,
    contentKey: over.id,
    ...over,
  } as QuestionRow
}

/** スナップショットは保存のための JSON。物で返っても文字列で返っても同じに読む。 */
function snap(q: QuestionRow): Record<string, unknown> {
  const s = snapshotOf(q) as unknown
  return (typeof s === 'string' ? JSON.parse(s) : s) as Record<string, unknown>
}

const CITATION = '出典：令和6年度 ITパスポート試験 問8'

describe('出題時のスナップショット（UC-010#3）', () => {
  // @verifies REQ-264
  it('渡した過去問の出典がそのまま入る（後から教材を直しても当時の出典で出せる）', () => {
    const got = snap(row({ id: 'q-1', exam: '2024r06', number: 8, citation: CITATION }))
    expect(got.citation).toBe(CITATION)
  })

  // @verifies REQ-264
  it('改変の印も入り、印の無い問題では立たない', () => {
    const on = snap(row({ id: 'q-1', exam: '2024r06', citation: CITATION, modified: 1 }))
    const off = snap(row({ id: 'q-2', exam: '2024r06', citation: CITATION, modified: 0 }))
    expect(Boolean(on.modified), 'modified の印がスナップショットに入っていない').toBe(true)
    expect(Boolean(off.modified), '改変していない問題に印が立っている').toBe(false)
  })
})
