/** ロードマップのデータを組み立て直す入口（buildRoadmap ＝ `python3 scripts/build_roadmap.py --data <学びの置き場> [--max] [--per-day] [--min-per-goal]`）。
 *  UC-030
 *
 *  仕込みは足場（UC-030_roadmap_fixture.ts）が一時の作業場の学びの置き場に書く。契約の例が指す fixture（tests/fixtures/roadmap-build-*）は
 *  同じ相対パスのまま作業場へ写して呼ぶ。学びの鍵は、日で束ねる学びとして itc、章で束ねて印を持つ学びとして eng を登録簿から借りる。
 *  候補の重み（source_count）を ID の順に下げてあるので、設定が何も効かなければ重みの上位から上限の数だけが単位になる。
 *  断ったときの理由は標準出力、警告は標準出力か標準エラーのどちらかで見る（契約の先頭の決まり）。 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type Built,
  type Candidate,
  CHAPTER,
  ID,
  TERM,
  buildRoadmap,
  chapterCandidates,
  chapterConfig,
  cleanup,
  dayCandidates,
  outsideUnits,
  roadmapConfig,
  tierLevels,
  unitIds,
  unitsOf,
} from './UC-030_roadmap_fixture'

vi.setConfig({ testTimeout: 120_000 })

afterEach(cleanup)

/** 止まり、何も書き出さず（置き場の状態が組み立ての前のまま）、標準出力に shown を示したこと。 */
function expectStopped(b: Built, shown: string[], where: string) {
  expect(b.status, `${where}: 終了 1 で止まらない:\n${b.out}`).toBe(1)
  expect(b.after, `${where}: 置き場に書き出しか書き換えがある`).toEqual(b.before)
  for (const s of shown) expect(b.stdout, `${where}: 標準出力に「${s}」を示していない:\n${b.out}`).toContain(s)
}

/** 止まらずに書き出したこと。 */
function expectBuilt(b: Built, where: string) {
  expect(b.status, `${where}: 組み立てが終了 0 で終わらない:\n${b.out}`).toBe(0)
  expect(b.roadmap, `${where}: ロードマップのデータが書き出されていない`).not.toBeNull()
  return b
}

describe('UC-030 回の束ね方が日でも章でもなければ止める', () => {
  // @covers REQ-532#other-word-stops
  it('回の束ね方が日・章を表す値と違う語なら、ロードマップのデータを書き出さずに止め、その束ね方を示す', () => {
    expectStopped(
      buildRoadmap('itc', null, null, { fixture: 'tests/fixtures/roadmap-build-unknown-grouping/itc' }),
      ['week'],
      '契約の例 unknownGrouping',
    )
    for (const word of ['chapters', '日ごと', 'weekly']) {
      expectStopped(buildRoadmap('itc', dayCandidates(8), roadmapConfig({ group_by: word })), [word], `語 ${word}`)
    }
  })

  // @covers REQ-532#non-string-stops
  it('回の束ね方が文字列でない値（数・真偽・配列）なら、ロードマップのデータを書き出さずに止める', () => {
    expectStopped(buildRoadmap('itc', dayCandidates(8), roadmapConfig({ group_by: 7 })), ['7'], '数の 7')
    for (const [where, value] of [
      ['真偽の true', true],
      ['配列', ['chapter']],
    ] as [string, unknown][]) {
      expectStopped(buildRoadmap('itc', dayCandidates(8), roadmapConfig({ group_by: value })), [], where)
    }
  })

  // @covers REQ-532#duplicate-term-before-unknown-grouping
  it('候補に名前が同じ単位があり、回の束ね方も日でも章でもないときは、名前の重なりを示して止め、束ね方は示さない', () => {
    const cands = dayCandidates(8)
    cands[2].term = cands[0].term
    const b = buildRoadmap('itc', cands, roadmapConfig({ group_by: 'weekly' }))
    expectStopped(b, [cands[0].term], '名前の重なりと束ね方')
    expect(b.stdout, '後の条件の束ね方を示している').not.toContain('weekly')
  })
})

describe('UC-030 章で束ねるのに章の名前か印を欠く候補があれば止める', () => {
  const COUNT = 6
  const levels = tierLevels('eng')

  // @covers REQ-533#chapter-missing-stops
  it('章の名前の欄を欠く候補があれば、ロードマップのデータを書き出さずに止め、その候補の名前を示す', () => {
    expectStopped(
      buildRoadmap('eng', null, null, { fixture: 'tests/fixtures/roadmap-build-chapter-missing/eng' }),
      [TERM(5)],
      '契約の例 chapterMissing',
    )
    const cands = chapterCandidates(COUNT)
    delete cands[1].chapter
    expectStopped(buildRoadmap('eng', cands, chapterConfig(COUNT)), [TERM(2)], '先頭の章の候補')
  })

  // @covers REQ-533#tier-missing-stops
  it('印の欄を欠く候補があれば、ロードマップのデータを書き出さずに止め、その候補の名前を示す', () => {
    const cands = chapterCandidates(COUNT)
    delete cands[3].tier
    expectStopped(buildRoadmap('eng', cands, chapterConfig(COUNT)), [TERM(4)], '印の欄が無い')
  })

  // @covers REQ-533#tier-outside-registry-stops
  it('登録簿のその学びの印の段に無い印（段の下の外・上の外）の候補があれば、書き出さずに止め、その候補の名前を示す', () => {
    expectStopped(
      buildRoadmap('eng', null, null, { fixture: 'tests/fixtures/roadmap-build-tier-outside/eng' }),
      [TERM(5)],
      '契約の例 tierOutsideRegistry',
    )
    for (const value of [Math.min(...levels) - 1, Math.max(...levels) + 1]) {
      const cands = chapterCandidates(COUNT)
      cands[2].tier = value
      expectStopped(buildRoadmap('eng', cands, chapterConfig(COUNT)), [TERM(3)], `印 ${value}`)
    }
  })

  // @covers REQ-533#outside-selection-also-stops
  it('欠けた候補が除く一覧にあっても、到達基準を持たずに単位にならない候補でも、書き出さずに止め、その候補の名前を示す', () => {
    const excluded = chapterCandidates(COUNT)
    delete excluded[5].chapter
    expectStopped(buildRoadmap('eng', excluded, chapterConfig(COUNT, { exclude: [ID(6)] })), [TERM(6)], '除く一覧の候補')
    const noGoal = chapterCandidates(COUNT)
    noGoal[5].goals = []
    noGoal[5].tier = Math.max(...levels) + 1
    expectStopped(buildRoadmap('eng', noGoal, chapterConfig(COUNT)), [TERM(6)], '到達基準の無い候補')
  })

  // @covers REQ-533#all-present-built
  it('どの候補も章の名前と登録簿の段にある印（段の両端を含む）を持てば、止めずに書き出す', () => {
    const cands = chapterCandidates(COUNT)
    cands[0].tier = Math.min(...levels)
    cands[1].tier = Math.max(...levels)
    const b = expectBuilt(buildRoadmap('eng', cands, chapterConfig(COUNT)), '欠けの無い候補')
    expect(unitIds(b).sort()).toEqual(cands.map((c) => c.id).sort())
  })

  // @covers REQ-533#chapter-missing-before-tier-outside
  it('章の名前を欠く候補と段に無い印の候補が両方あれば、章の名前を欠く候補の名前を示して止め、印の候補の名前は示さない', () => {
    const cands = chapterCandidates(COUNT)
    // 印の候補を候補の並びで先に置き、候補の順ではなく条件の順で決まることを見る
    cands[1].tier = Math.max(...levels) + 1
    delete cands[4].chapter
    const b = buildRoadmap('eng', cands, chapterConfig(COUNT))
    expectStopped(b, [TERM(5)], '章の名前の欠けと段に無い印')
    expect(b.stdout, '後の条件の候補の名前を示している').not.toContain(TERM(2))
  })

  // @covers REQ-533#tier-outside-before-included-and-excluded
  it('段に無い印の候補と、含める一覧と除く一覧の両方にある ID が両方あれば、その候補の名前を示して止め、その ID は示さない', () => {
    const cands = chapterCandidates(COUNT)
    cands[4].tier = Math.max(...levels) + 1
    const b = buildRoadmap('eng', cands, chapterConfig(COUNT, { must_include: [ID(2)], exclude: [ID(2)] }))
    expectStopped(b, [TERM(5)], '段に無い印と一覧の重なり')
    expect(b.stdout, '後の条件の ID を示している').not.toContain(String(ID(2)))
  })
})

describe('UC-030 含める一覧と除く一覧の両方にある ID があれば止める', () => {
  // @covers REQ-534#overlap-stops
  it('含める一覧の論点の ID が除く一覧にもあれば（ほかの ID が混ざっていても）、書き出さずに止め、その ID を示す', () => {
    expectStopped(
      buildRoadmap('itc', null, null, { fixture: 'tests/fixtures/roadmap-build-included-and-excluded/itc' }),
      [String(ID(7))],
      '契約の例 includedAndExcluded',
    )
    const b = buildRoadmap('itc', dayCandidates(8), roadmapConfig({ must_include: [ID(7), ID(8)], exclude: [ID(1), ID(8)] }))
    expectStopped(b, [String(ID(8))], 'ほかの ID と混ざった重なり')
  })

  // @covers REQ-534#disjoint-built
  it('含める一覧と除く一覧に同じ ID が無ければ、止めずに書き出す', () => {
    const b = expectBuilt(
      buildRoadmap('itc', dayCandidates(8), roadmapConfig({ must_include: [ID(7), ID(8)], exclude: [ID(1)] })),
      '重ならない一覧',
    )
    expect(unitIds(b)).toEqual(expect.arrayContaining([ID(7), ID(8)]))
    expect(unitIds(b)).not.toContain(ID(1))
  })
})

describe('UC-030 到達基準に繋がらない候補を落とした候補として残す', () => {
  // @covers REQ-535#no-goal-dropped
  it('到達基準を 1 つも持たない候補（空の一覧・欄が無い）は、重みが一番でも単位にならず、その名前がロードマップのデータの単位の外に残る', () => {
    const cands = dayCandidates(8)
    cands[0].goals = []
    delete cands[1].goals
    const b = expectBuilt(buildRoadmap('itc', cands, roadmapConfig()), '到達基準の無い候補')
    for (const c of [cands[0], cands[1]]) {
      expect(unitIds(b), `${c.term} が単位になっている`).not.toContain(c.id)
      expect(outsideUnits(b), `${c.term} が落とした候補として残っていない`).toContain(c.term)
    }
  })

  // @covers REQ-535#included-no-goal-dropped
  it('到達基準を持たない候補は、含める一覧にあっても単位にならず、その名前がロードマップのデータの単位の外に残る', () => {
    const cands = dayCandidates(8)
    cands[2].goals = []
    const b = expectBuilt(buildRoadmap('itc', cands, roadmapConfig({ must_include: [ID(3)] })), '含める一覧の候補')
    expect(unitIds(b)).not.toContain(ID(3))
    expect(outsideUnits(b)).toContain(TERM(3))
  })
})

describe('UC-030 単位の前提の候補は上限を超えても単位に含める', () => {
  const COUNT = 12
  const LOW = ID(COUNT)

  function baseline() {
    const b = expectBuilt(buildRoadmap('itc', dayCandidates(COUNT), roadmapConfig()), '仕込み')
    expect(unitIds(b), '仕込み: 前提が無くても重みの低い候補が単位になっている').not.toContain(LOW)
    expect(unitIds(b), '仕込み: 前提が無くても上限の数を超えている').toHaveLength(6)
  }

  // @covers REQ-536#prereq-beyond-max
  it('単位に選んだ候補が前提に挙げる候補は、重みで上限から落ちる候補でも単位に含まれる', () => {
    baseline()
    const cands = dayCandidates(COUNT)
    cands[0].prereq = [LOW]
    const b = expectBuilt(buildRoadmap('itc', cands, roadmapConfig()), '前提の候補')
    expect(unitIds(b)).toContain(LOW)
  })

  // @covers REQ-536#prereq-of-prereq-beyond-max
  it('前提として単位に含めた候補がさらに前提に挙げる候補も、上限を超えて単位に含まれる', () => {
    const cands = dayCandidates(COUNT)
    cands[0].prereq = [ID(COUNT - 1)]
    cands[COUNT - 2].prereq = [LOW]
    const b = expectBuilt(buildRoadmap('itc', cands, roadmapConfig()), '前提の前提')
    expect(unitIds(b)).toEqual(expect.arrayContaining([ID(COUNT - 1), LOW]))
  })

  // @covers REQ-536#excluded-prereq-not-added
  it('前提の候補が除く一覧にあれば、単位に含まれない', () => {
    const cands = dayCandidates(COUNT)
    cands[0].prereq = [LOW]
    const b = expectBuilt(buildRoadmap('itc', cands, roadmapConfig({ exclude: [LOW] })), '除く一覧の前提')
    expect(unitIds(b)).not.toContain(LOW)
  })

  // @covers REQ-536#no-goal-prereq-not-added
  it('前提の候補が到達基準を持たなければ、単位に含まれない', () => {
    const cands = dayCandidates(COUNT)
    cands[0].prereq = [LOW]
    cands[COUNT - 1].goals = []
    const b = expectBuilt(buildRoadmap('itc', cands, roadmapConfig()), '到達基準の無い前提')
    expect(unitIds(b)).not.toContain(LOW)
  })
})

describe('UC-030 前提が後ろに来る単位を警告として示す', () => {
  // @covers REQ-537#prereq-behind-warned
  it('並べ終えた学ぶ順で前提の単位が自分より後ろにある単位があれば、ロードマップのデータを書き出し、その単位と前提の単位の名前を示す', () => {
    // 互いを前提にし合う 2 つの単位は、どう並べてもどちらかの前提が後ろに来る
    const cands = dayCandidates(8)
    cands[1].prereq = [ID(3)]
    cands[2].prereq = [ID(2)]
    const b = expectBuilt(buildRoadmap('itc', cands, roadmapConfig()), '前提が後ろに来る単位')
    expect(unitIds(b)).toEqual(expect.arrayContaining([ID(2), ID(3)]))
    for (const t of [TERM(2), TERM(3)]) expect(b.out, `警告に「${t}」が無い`).toContain(t)
  })
})

describe('UC-030 書き手の教材の束があれば束の割り当てを作り直さない', () => {
  /** 書き手の教材の束と、前からある束の割り当て（ロードマップに載らない名前を持たせて、作り直しと見分ける）。 */
  const files = {
    'materials/bundle_01.json': {
      bundle: 'bundle_01',
      materials: [{ topic_id: ID(1), term: TERM(1), explanation: '仕込みの教材', detail: '仕込みの詳細', sources: [] }],
    },
    'material_bundles/bundle_01.json': { bundle: 'bundle_01', topics: [{ topic_id: ID(1), term: '前からの割り当ての名前' }] },
    'material_bundles/bundle_02.json': { bundle: 'bundle_02', topics: [{ topic_id: ID(2), term: '前からの割り当ての名前その二' }] },
  }
  const bundleState = (b: Built, s: Record<string, string>) =>
    Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith(`material_bundles${path.sep}`)))

  // @covers REQ-538#assignment-kept
  it('書き手の教材の束がある置き場で組み立て直しても、束の割り当てのファイルの並びと中身は組み立ての前のまま', () => {
    const b = expectBuilt(buildRoadmap('itc', dayCandidates(8), roadmapConfig(), { files }), '書き手の教材の束がある')
    expect(bundleState(b, b.after)).toEqual(bundleState(b, b.before))
    expect(Object.keys(bundleState(b, b.before)), '仕込み: 割り当てが置けていない').toHaveLength(2)
  })

  // @covers REQ-538#roadmap-still-written
  it('書き手の教材の束がある置き場で組み立て直すと、ロードマップのデータは候補から組み立て直して書き出す', () => {
    const old = { target: '前からのロードマップ', unit_count: 1, units: [{ order: 1, day: 1, topic_id: ID(9), term: '前からの単位' }] }
    const b = expectBuilt(
      buildRoadmap('itc', dayCandidates(8), roadmapConfig(), { files: { ...files, 'roadmap.json': old } }),
      '書き手の教材の束がある',
    )
    expect(unitIds(b)).not.toContain(ID(9))
    expect(unitIds(b)).toEqual(expect.arrayContaining([ID(1), ID(2), ID(3)]))
    expect(fs.existsSync(path.join(b.dir, 'roadmap.json'))).toBe(true)
  })
})

describe('UC-030 上限・1 回の論点数・到達基準ごとの数・回の束ね方の決め方', () => {
  /** 到達基準 1 の重い候補 9 つと、到達基準 2 の軽い候補 3 つ。 */
  function twoGoals(): Candidate[] {
    const cands = dayCandidates(12)
    for (const c of cands.slice(9)) c.goals = [2]
    return cands
  }
  const goal2 = (b: Built) => unitsOf(b).filter((u) => (u.goals as number[]).includes(2)).length
  /** 学ぶ順と 1 回の論点数から決まる日に、各単位の日が一致すること。 */
  const expectPerDay = (b: Built, perDay: number, where: string) => {
    for (const u of unitsOf(b))
      expect(u.day, `${where}: 学ぶ順 ${u.order} の日が 1 回 ${perDay} 論点の日でない`).toBe(Math.ceil(u.order / perDay))
  }
  const ARGS = (max: number, perDay: number, minPerGoal: number) => [
    '--max',
    String(max),
    '--per-day',
    String(perDay),
    '--min-per-goal',
    String(minPerGoal),
  ]
  const NUMBERS = ['max', 'per_day', 'min_per_goal']
  const withoutNumbers = () => Object.fromEntries(Object.entries(roadmapConfig()).filter(([k]) => !NUMBERS.includes(k)))

  // @covers REQ-563#config-value-over-argument
  it('ロードマップの設定に値があれば、引数で別の値を渡しても設定の値で決める', () => {
    const b = expectBuilt(
      buildRoadmap('itc', dayCandidates(12), roadmapConfig({ max: 5, per_day: 2, min_per_goal: 1 }), { args: ARGS(8, 4, 0) }),
      '上限と 1 回の論点数',
    )
    expect(unitsOf(b)).toHaveLength(5)
    expectPerDay(b, 2, '設定の 1 回の論点数')
    const kept = expectBuilt(
      buildRoadmap('itc', twoGoals(), roadmapConfig({ min_per_goal: 2 }), { args: ARGS(6, 3, 0) }),
      '設定の到達基準ごとの数 2',
    )
    expect(goal2(kept), '設定の到達基準ごとの数で確保していない').toBeGreaterThanOrEqual(2)
    const none = expectBuilt(
      buildRoadmap('itc', twoGoals(), roadmapConfig({ min_per_goal: 0 }), { args: ARGS(6, 3, 2) }),
      '設定の到達基準ごとの数 0',
    )
    expect(goal2(none), '引数の到達基準ごとの数で確保している').toBe(0)
  })

  // @covers REQ-563#argument-when-config-lacks-value
  it('ロードマップの設定にその値が無ければ、渡した引数の値で決める', () => {
    const b = expectBuilt(buildRoadmap('itc', dayCandidates(12), withoutNumbers(), { args: ARGS(5, 2, 1) }), '上限と 1 回の論点数')
    expect(unitsOf(b)).toHaveLength(5)
    expectPerDay(b, 2, '引数の 1 回の論点数')
    const kept = expectBuilt(buildRoadmap('itc', twoGoals(), withoutNumbers(), { args: ARGS(6, 3, 2) }), '引数の到達基準ごとの数 2')
    expect(goal2(kept)).toBeGreaterThanOrEqual(2)
    const none = expectBuilt(buildRoadmap('itc', twoGoals(), withoutNumbers(), { args: ARGS(6, 3, 0) }), '引数の到達基準ごとの数 0')
    expect(goal2(none)).toBe(0)
  })

  // @covers REQ-563#argument-when-no-config
  it('ロードマップの設定が無ければ、渡した引数の値で決める', () => {
    const b = expectBuilt(buildRoadmap('itc', dayCandidates(12), null, { args: ARGS(5, 2, 1) }), '上限と 1 回の論点数')
    expect(unitsOf(b)).toHaveLength(5)
    expectPerDay(b, 2, '引数の 1 回の論点数')
    const kept = expectBuilt(buildRoadmap('itc', twoGoals(), null, { args: ARGS(6, 3, 2) }), '引数の到達基準ごとの数 2')
    expect(goal2(kept)).toBeGreaterThanOrEqual(2)
    const none = expectBuilt(buildRoadmap('itc', twoGoals(), null, { args: ARGS(6, 3, 0) }), '引数の到達基準ごとの数 0')
    expect(goal2(none)).toBe(0)
  })

  // @covers REQ-563#grouping-chapter-from-config
  it('ロードマップの設定の回の束ね方が章なら、章で束ねて書き出す', () => {
    const cands = chapterCandidates(6)
    const b = expectBuilt(buildRoadmap('eng', cands, chapterConfig(6)), '章で束ねる設定')
    expect(b.roadmap!.group_by).toBe('chapter')
    for (const u of unitsOf(b)) {
      const c = cands.find((x) => x.id === u.topic_id)!
      expect(u.chapter, `${u.term} の章の名前`).toBe(c.chapter)
      expect(u.round, `${u.term} の章の番号`).toBe(c.chapter === CHAPTER(1) ? 1 : 2)
      expect(u, `${u.term} が日を持つ`).not.toHaveProperty('day')
    }
  })

  // @covers REQ-563#grouping-day-when-unset
  it('ロードマップの設定に回の束ね方が無いか、設定が無ければ、日で束ねて書き出す', () => {
    for (const [where, cfg] of [
      ['設定に束ね方が無い', roadmapConfig()],
      ['設定が無い', null],
    ] as [string, Record<string, unknown> | null][]) {
      const b = expectBuilt(buildRoadmap('itc', dayCandidates(8), cfg, { args: ARGS(6, 3, 1) }), where)
      expect(b.roadmap!.group_by, `${where}: 章で束ねている`).not.toBe('chapter')
      expectPerDay(b, 3, where)
      for (const u of unitsOf(b)) expect(u, `${where}: ${u.term} が章を持つ`).not.toHaveProperty('chapter')
    }
  })
})

