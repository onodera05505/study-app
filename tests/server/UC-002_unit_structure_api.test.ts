/** 論点の一覧（listTopics ＝ GET /api/topics）と論点の教材（getTopicDetail ＝ GET /api/topics/{id}）の、
 *  単元の構成に沿った並び・まとまり・前提の論点・出題回数の印（UC-002）。
 *
 *  学びの写しは UC-002_sqlite_fixture.ts。学びの種類は資格対策（EXAM=ip）、ロードマップ型は itc。
 *  並びは論点の ID の列で比べる（ID の順・出題頻度の順・小項目の順と、期待する並びが違うように置いてある）。 */

import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PLAN12, PREREQUISITES, envOf, getOk, migrated, seed, termOf, type Json } from './UC-002_sqlite_fixture'

let db: DatabaseSync

beforeEach(() => {
  db = migrated()
})

afterEach(() => {
  db.close()
})

const ids = (rows: Json[]) => rows.map((r) => r.id)

describe('単元を選んだときの論点の並び（GET /api/topics。UC-002）', () => {
  // @covers REQ-474#structured-order
  it('単元の構成を持つ単元では、まとまりの順に、まとまりの中は学ぶ順に並べる', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics?middleNo=12&sort=structure')
    expect(ids(body.topics), '単元の構成の順（まとまり 1 の 430・410・420 → まとまり 2 の 405・440）でない').toEqual([
      430, 410, 420, 405, 440,
    ])
    // 既定の並べ替えも同じ並び
    const byDefault = await getOk(envOf(db), '/api/topics?middleNo=12')
    expect(ids(byDefault.topics), '並べ替えを省いた求めが単元の構成の順でない').toEqual([430, 410, 420, 405, 440])
  })

  // @covers REQ-474#unstructured-order
  it('単元の構成を持たない単元では、小項目の番号の順に、小項目の中は出題頻度の降順、同じ頻度は論点の ID の順に並べる', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics?middleNo=7&sort=structure')
    // 小項目 1: 502（4）→ 501（2）→ 503（2。501 と同じ頻度で ID が後）、小項目 2: 499（9）
    expect(ids(body.topics)).toEqual([502, 501, 503, 499])
  })
})

describe('理解度の絞り込みを選び直したときの並び（GET /api/topics。UC-002）', () => {
  // @covers REQ-021#order-kept
  it('理解度で絞った一覧も、残った論点を単元の構成の順のまま返す', async () => {
    // 410 を理解（3）と記録する。ほかは未（回答も記録も無い）
    seed(db, { 410: 3 })
    const body = await getOk(envOf(db), '/api/topics?middleNo=12&sort=structure&status=0,1,2')
    expect(ids(body.topics), '理解の 410 を除いた残りが単元の構成の順でない').toEqual([430, 420, 405, 440])
    const onlyUnderstood = await getOk(envOf(db), '/api/topics?middleNo=12&sort=structure&status=3')
    expect(ids(onlyUnderstood.topics)).toEqual([410])
  })
})

describe('単元の構成を持つ単元の一覧の構成（GET /api/topics。UC-002）', () => {
  // @covers REQ-475#structure-returned
  it('全体像と、まとまりの番号・名前・説明をまとまりの順に返し、各論点に属するまとまりの番号を添える', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics?middleNo=12&sort=structure')
    expect(body.structure, '単元の構成が返っていない').not.toBeNull()
    expect(body.structure.overview).toBe(PLAN12.overview)
    expect(body.structure.groups).toEqual(PLAN12.groups.map(({ no, name, description }) => ({ no, name, description })))
    const groupOf = Object.fromEntries(PLAN12.groups.flatMap((g) => g.topics.map((t) => [t, g.no])))
    for (const t of body.topics) expect(t.groupNo, `論点 ${t.id} のまとまりの番号が違う`).toBe(groupOf[t.id])
  })
})

describe('おすすめ順の一覧（GET /api/topics。UC-002）', () => {
  // @covers REQ-475#recommended-without-structure
  it('単元の構成を持つ単元でも、おすすめ順を求めたときは単元の構成を返さず、まとまりの番号も添えない', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics?middleNo=12&sort=recommended')
    expect(body.structure, 'おすすめ順の一覧に単元の構成が返っている').toBeNull()
    expect(body.topics.length, 'おすすめ順の一覧が空で観測できない').toBe(5)
    for (const t of body.topics) expect(t.groupNo, `論点 ${t.id} にまとまりの番号が付いている`).toBeNull()
  })
})

describe('単元の構成を持たない単元の一覧（GET /api/topics。UC-002）', () => {
  // @covers REQ-476#structure-null-topics-kept
  it('単元の構成を null で返し、論点を空にせず、各論点に小項目の番号と名前を添える', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics?middleNo=7&sort=structure')
    expect(body.structure, '構成を持たない単元に単元の構成が返っている').toBeNull()
    expect(body.topics.length, '構成を持たない単元の論点が空').toBe(4)
    for (const t of body.topics) {
      expect(t.groupNo, `論点 ${t.id} にまとまりの番号が付いている`).toBeNull()
      expect(t.itemNo, `論点 ${t.id} に小項目の番号が無い`).toBe(t.id === 499 ? 2 : 1)
      expect(t.itemName).toBe(t.id === 499 ? 'ファイルシステム' : 'オペレーティングシステム')
    }
  })
})

describe('出題回数の印（UC-002）', () => {
  // @covers REQ-478#tier-boundaries
  it('論点の一覧の各論点に、出題頻度 1 は 1 段・2 は 2 段・3 以上は 3 段の印を添え、0 には添えない', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics?middleNo=12&sort=structure')
    const tierOf = Object.fromEntries(body.topics.map((t: Json) => [t.id, [t.questionCount, t.frequencyTier]]))
    expect(tierOf[440], '出題頻度 0').toEqual([0, null])
    expect(tierOf[430], '出題頻度 1').toEqual([1, 1])
    expect(tierOf[420], '出題頻度 2').toEqual([2, 2])
    expect(tierOf[405], '出題頻度 3（最も高い段の境目）').toEqual([3, 3])
    expect(tierOf[410], '出題頻度 5').toEqual([5, 3])
  })

  // @covers REQ-478#tier-on-detail
  it('論点の教材の論点と、前提の論点・同じまとまりの他の論点にも、出題頻度から求めた印を添える', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics/420')
    expect([body.topic.questionCount, body.topic.frequencyTier], '論点の教材の論点').toEqual([2, 2])
    const links = [...body.prerequisites, ...body.siblings]
    expect(links.length, '前提の論点も同じまとまりの他の論点も返っていない').toBeGreaterThan(0)
    const expected: Record<number, number | null> = { 430: 1, 410: 3, 420: 2, 405: 3, 440: null }
    for (const l of links) expect(l.frequencyTier, `論点 ${l.id} の印の段`).toBe(expected[l.id])
  })

  // @covers REQ-478#no-tier-for-roadmap
  it('ロードマップ型の学びでは、出題頻度があっても出題回数の印を添えない', async () => {
    seed(db)
    const body = await getOk(envOf(db, 'itc'), '/api/topics?limit=500')
    expect(body.topics.length, 'ロードマップ型の一覧が空で観測できない').toBeGreaterThan(0)
    const counted = body.topics.filter((t: Json) => t.questionCount > 0)
    expect(counted.length, '出題頻度を持つ論点が無く観測できない').toBeGreaterThan(0)
    for (const t of body.topics) expect(t.frequencyTier, `論点 ${t.id} に出題回数の印が付いている`).toBeNull()
  })
})

describe('前提の論点（GET /api/topics/{id}。UC-002）', () => {
  // @covers REQ-479#prerequisites-in-plan-order
  it('前提の論点を、単元の構成に書かれた順に、名前と行き先の ID つきで返す', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics/420')
    expect(
      body.prerequisites.map((p: Json) => [p.id, p.term]),
      '前提の論点が単元の構成に書かれた順（430 → 410）でない',
    ).toEqual(PREREQUISITES[420].map((id) => [id, termOf(id)]))
    // 別の単元の論点を前提に持つ論点
    const other = await getOk(envOf(db), '/api/topics/405')
    expect(other.prerequisites.map((p: Json) => [p.id, p.term])).toEqual([[502, termOf(502)]])
  })
})

describe('論点を選んだときの他の論点（GET /api/topics/{id}。UC-002）', () => {
  // @covers REQ-023#siblings-same-group
  it('単元の構成を持つ単元では、同じまとまりの他の論点を学ぶ順に返し、同じ小項目でも別のまとまりの論点は返さない', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics/410')
    // 410 はまとまり 1（430・410・420）。440 は 410 と同じ小項目 3 だがまとまり 2
    expect(ids(body.siblings)).toEqual([430, 420])
  })

  // @covers REQ-023#siblings-same-item
  it('単元の構成を持たない単元では、同じ小項目の他の論点を出題頻度の降順、同じ頻度は ID の順に返す', async () => {
    seed(db)
    const body = await getOk(envOf(db), '/api/topics/503')
    // 503 の小項目 1 には 502（4）・501（2）・503（2）。499 は小項目 2
    expect(ids(body.siblings)).toEqual([502, 501])
  })
})
