/** 分野別演習・単元演習・弱点復習で問題数を省いたときの出題の件数（UC-004 の startSession ＝ POST /api/sessions）。
 *
 *  契約 startSession の size は「省略時は登録簿の値」。登録簿（src/shared/targets.json）の practiceSize を
 *  学びごとに別の 2 つの値に差し替え、値の決め打ちと区別する。期待値も差し替えた登録簿から読む。
 *  D1 は migrations を当てた本物の SQLite（sessions_sqlite_fixture.ts）。 */

import { describe, expect, it, vi } from 'vitest'
import { countOf, openWorld, seedQuestions, startOk, topicOf, USER, type World } from './sessions_sqlite_fixture'
import targets from '../../src/shared/targets.json'

/** 学びごとの、差し替えた 1 回の演習の既定の問題数。 */
const PRACTICE_SIZE: Record<string, number> = { ip: 3, ap: 4 }

vi.mock('../../src/shared/targets.json', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  const base = ('default' in real ? real.default : real) as Record<string, Record<string, unknown>>
  const registry = structuredClone(base)
  registry.ip.practiceSize = 3
  registry.ap.practiceSize = 4
  return { default: registry, ...registry }
})

const REGISTRY = targets as unknown as Record<string, { practiceSize: number }>
const FIELD = 'テクノロジ系'
const EXAM = '2024r06'
/** 範囲に置く過去問の数（差し替えたどの既定の問題数よりも多い）。 */
const POOL = 8

/** 分野 FIELD に POOL 問の過去問を持ち、その論点を利用者が「未理解」と記録した学び。 */
async function worldOf(learning: string): Promise<World> {
  const w = await openWorld(learning)
  seedQuestions(w, EXAM, POOL, FIELD)
  w.db.prepare(`INSERT INTO progress (user_id, topic_id, status) VALUES (?, ?, 1)`).run(USER, topicOf(w, FIELD))
  return w
}

/** 分野 FIELD の論点が載る単元の番号。 */
const middleOf = (w: World) =>
  Number((w.db.prepare(`SELECT middle_no AS n FROM syllabus_items WHERE field = ?`).get(FIELD) as { n: number }).n)

describe('演習の出題の件数（POST /api/sessions。UC-004）', () => {
  // @covers REQ-051#size-default-cap-registry
  it('分野別演習・単元演習・弱点復習で問題数を省くと、範囲の過去問が多くても登録簿の既定の問題数で止まる', async () => {
    expect(REGISTRY.ip.practiceSize, '登録簿の差し替えが効いていない（この検査は空振りになる）').toBe(PRACTICE_SIZE.ip)
    expect(REGISTRY.ap.practiceSize, '登録簿の差し替えが効いていない（この検査は空振りになる）').toBe(PRACTICE_SIZE.ap)
    for (const learning of Object.keys(PRACTICE_SIZE)) {
      const want = REGISTRY[learning].practiceSize
      expect(POOL, '範囲の過去問が既定の問題数より多くない（この検査は空振りになる）').toBeGreaterThan(want)
      const cases: { label: string; body: (w: World) => Record<string, unknown> }[] = [
        { label: '分野別演習', body: () => ({ kind: 'field', field: FIELD }) },
        { label: '単元演習', body: (w) => ({ kind: 'middle', middleNo: middleOf(w) }) },
        { label: '弱点復習', body: () => ({ kind: 'review' }) },
      ]
      for (const { label, body } of cases) {
        const w = await worldOf(learning)
        const created = await startOk(w, body(w))
        expect(created.questionCount, `${learning} の${label}: 既定の問題数 ${want} で止まっていない`).toBe(want)
        expect(
          countOf(w, 'session_questions', 'session_id = ?', created.id),
          `${learning} の${label}: 出題の行が既定の問題数 ${want} でない`,
        ).toBe(want)
      }
    }
  })
})
