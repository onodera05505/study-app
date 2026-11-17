/** 論点が小項目と名前の組で 1 つに保たれ、単元の一覧（listTopics ＝ GET /api/topics）で出題頻度が割れないこと（UC-002）。
 *
 *  学びの写しは UC-002_sqlite_fixture.ts（migrations を当てた実 SQLite）。2 つ目の論点の保存は SQLite に直接当て、
 *  観測は保存の成否と、HTTP の境界で返る単元の一覧で行う。 */

import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNIT7, envOf, getOk, migrated, seed, type Json } from './UC-002_sqlite_fixture'

let db: DatabaseSync

beforeEach(() => {
  db = migrated()
})

afterEach(() => {
  db.close()
})

const insertTopic = (id: number, term: string, item: number, questions: number) =>
  db
    .prepare(
      'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count) VALUES (?, ?, ?, 0, ?, NULL, ?)',
    )
    .run(id, term, item, `${term} の短い説明です。`, questions)

describe('同じ小項目に同じ名前の論点を 2 つ目として保存しようとしたとき（UC-002）', () => {
  // @covers REQ-474#topic-not-split
  it('2 つ目は保存されず、単元の一覧にその名前の論点は 1 つだけで、出題頻度はその 1 つに数えられる', async () => {
    seed(db)
    const kept = UNIT7.find((t) => t.term === 'コンパイラ')!
    // 空振り対策: 同じ小項目に違う名前の論点なら同じ文で保存できる
    expect(() => insertTopic(600, 'アセンブラ', kept.item, 0), '同じ文で別の名前の論点が保存できない（この検査は空振りになる）').not.toThrow()

    expect(() => insertTopic(601, kept.term, kept.item, 3), '同じ小項目に同じ名前の論点が 2 つ目として保存された').toThrow()

    const body = await getOk(envOf(db), '/api/topics?middleNo=7&sort=structure')
    const same = (body.topics as Json[]).filter((t) => t.term === kept.term)
    expect(same.map((t) => t.id), `「${kept.term}」が 1 つの論点になっていない`).toEqual([kept.id])
    expect(same[0].questionCount, '出題頻度がその論点に数えられていない').toBe(kept.questions)
  })
})
