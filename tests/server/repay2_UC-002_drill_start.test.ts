/** 論点の教材からドリルを始める経路（UC-002 REQ-273。契約の正本は UC-004 の startSession ＝ POST /api/sessions）。
 *
 *  叩くのは契約の操作の入口だけ。D1 は migrations を当てた本物の SQLite（sessions_sqlite_fixture.ts）なので、
 *  作られたテストの行と出題の行を、実装の SQL の書き方（1 文ずつか batch か）に依らずに読み戻して観測する。 */

import { describe, expect, it } from 'vitest'
import { countOf, openWorld, seedQuestions, startOk, topicOf, USER, type World } from './sessions_sqlite_fixture'

const EXAM = '2024r06'
const FIELD = 'ストラテジ系'
const OTHER_FIELD = 'テクノロジ系'

/** この論点に 3 問、別の論点に 5 問の過去問がある学び。進行中のテストは無い。 */
async function drillWorld(): Promise<{ w: World; topicId: number; term: string; ids: string[] }> {
  const w = await openWorld()
  const ids = seedQuestions(w, EXAM, 3, FIELD)
  seedQuestions(w, EXAM, 5, OTHER_FIELD)
  const topicId = topicOf(w, FIELD)
  const { term } = w.db.prepare(`SELECT term FROM topics WHERE id = ?`).get(topicId) as { term: string }
  return { w, topicId, term, ids }
}

type SessionRow = { id: string; user_id: string; kind: string; status: string; scope_label: string }

describe('論点の教材からドリルを始める（POST /api/sessions。UC-002）', () => {
  // @covers REQ-273#one-in-progress-drill-created
  it('論点を範囲にした種別ドリルの求めで、進行中のテストを 1 つだけ作り、その種別を返す', async () => {
    const { w, topicId } = await drillWorld()
    const created = await startOk(w, { kind: 'drill', topicId })
    expect(created.kind).toBe('drill')
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
    const rows = w.db.prepare(`SELECT id, user_id, kind, status, scope_label FROM sessions`).all() as SessionRow[]
    expect(rows, 'テストの行が 1 つだけ書かれていない').toHaveLength(1)
    expect(rows[0].id, '書かれたテストの ID が返した ID と違う').toBe(created.id)
    expect(rows[0].user_id, '書かれたテストが求めた利用者の物でない').toBe(USER)
    expect(rows[0].kind, '書かれたテストが種別ドリルでない').toBe('drill')
    expect(rows[0].status, '書かれたテストが進行中でない').toBe('in_progress')
  })

  // @covers REQ-273#scope-limited-to-topic
  it('作ったテストの範囲はその論点だけで、他の論点の過去問を混ぜず、範囲の名前にその論点の名前を持つ', async () => {
    const { w, topicId, term, ids } = await drillWorld()
    const created = await startOk(w, { kind: 'drill', topicId })
    expect(created.questionCount, 'その論点の 3 問ではなく、他の論点の過去問まで組んでいる').toBe(ids.length)
    const asked = (
      w.db.prepare(`SELECT question_id FROM session_questions WHERE session_id = ?`).all(created.id) as {
        question_id: string
      }[]
    ).map((r) => r.question_id)
    expect([...asked].sort(), '出題がその論点の過去問だけになっていない').toEqual([...ids].sort())
    expect(countOf(w, 'session_questions', 'session_id = ?', created.id)).toBe(ids.length)
    expect(created.scopeLabel).toContain(term)
    const stored = w.db.prepare(`SELECT scope_label FROM sessions WHERE id = ?`).get(created.id) as { scope_label: string }
    expect(stored.scope_label, '保存した範囲の名前に論点の名前が無い').toContain(term)
  })
})
