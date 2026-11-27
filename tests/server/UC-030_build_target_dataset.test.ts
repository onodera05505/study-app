/** 投入データを組み立てる入口（buildTargetDataset ＝ `python3 scripts/build_target_dataset.py --data <学びの置き場>`）。UC-030
 *
 *  学びの置き場は、日で束ねて補足の論点を持つ学び（itc）と、章で束ねて印を持つ学び（eng）の今のデータを一時の作業場へ写し、
 *  写しの上で変える（ロードマップのデータ roadmap.json・教材の束 materials/・確認問題の束 roadmap_questions/・論点の候補）。
 *  写しのままで組み立てが通ることを先に確かめ、止まったときに仕込みの側の理由と見分ける。
 *  観測するのは終了コード・標準出力と、置き場の状態（止めたときは組み立ての前のまま）と、書き出した投入データ
 *  （topics.json の topics と questions/）だけ。登録簿の補足の分野・補足の回・印の段は src/shared/targets.json から読む。 */

import fs from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type DatasetRun,
  type DatasetWs,
  type Json,
  buildDataset,
  bundleRows,
  cleanup,
  datasetWorkspace,
  editBundles,
  registry,
  tierLevels,
} from './UC-030_roadmap_fixture'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 })

afterEach(cleanup)

/** 写しのままの組み立て（仕込みの確かめ）。 */
const baseline: Record<string, DatasetRun> = {}
beforeAll(() => {
  for (const key of ['itc', 'eng']) baseline[key] = buildDataset(datasetWorkspace(key))
  cleanup()
})

function copyOf(key: string): DatasetWs {
  const b = baseline[key]
  expect(b.status, `仕込み: ${key} の写しのままで組み立てが通らない:\n${b.out}`).toBe(0)
  return datasetWorkspace(key)
}

/** ロードマップの単位を学ぶ順に並べたもの。 */
const unitsOf = (d: DatasetWs): Json[] => [...(d.read('roadmap.json').units as Json[])].sort((a, b) => a.order - b.order)

/** 止まり、置き場の状態が組み立ての前のままで、標準出力に shown の名前を示したこと。 */
function expectStopped(r: DatasetRun, shown: string, where: string) {
  expect(r.status, `${where}: 終了 1 で止まらない:\n${r.out}`).toBe(1)
  expect(r.after, `${where}: 投入データが書き出されているか、置き場が書き換わった`).toEqual(r.before)
  expect(r.stdout, `${where}: 標準出力に単位の名前「${shown}」を示していない:\n${r.out}`).toContain(shown)
}

/** 教材の束からその論点の教材を外す。 */
function dropMaterial(d: DatasetWs, id: number) {
  expect(bundleRows(d, 'materials', 'materials').some((m) => m.topic_id === id), `仕込み: 論点 ${id} の教材が無い`).toBe(true)
  editBundles(d, 'materials', 'materials', (rows) => rows.filter((m) => m.topic_id !== id))
}

/** 確認問題の束でその論点の確認問題を 1 つ減らす（delta = -1）か、1 つ増やす（delta = 1）。 */
function shiftQuestions(d: DatasetWs, id: number, delta: -1 | 1) {
  const own = bundleRows(d, 'roadmap_questions', 'questions').filter((q) => q.topic_id === id)
  expect(own.length, `仕込み: 論点 ${id} の確認問題が無い`).toBeGreaterThan(0)
  let done = false
  editBundles(d, 'roadmap_questions', 'questions', (rows) => {
    if (done) return rows
    const i = rows.findIndex((q) => q.topic_id === id)
    if (i < 0) return rows
    done = true
    if (delta < 0) return rows.filter((_, j) => j !== i)
    return [...rows.slice(0, i + 1), { ...rows[i], qid: `${rows[i].qid}-added` }, ...rows.slice(i + 1)]
  })
}

/** ロードマップのデータのその単位の欄を変える（value が undefined なら欄を外す）。 */
function setUnitField(d: DatasetWs, id: number, field: string, value: unknown) {
  const roadmap = d.read('roadmap.json')
  const u = (roadmap.units as Json[]).find((x) => x.topic_id === id)!
  if (value === undefined) delete u[field]
  else u[field] = value
  d.write('roadmap.json', roadmap)
}

/** 章で束ねる学び（eng）に、ロードマップに無い論点（補足の論点）を 1 つ足す。教材と確認問題は図の無い単位の写しで、印は tier。 */
const EXTRA_ID = 9001
const EXTRA_TERM = '仕込みの補足の論点'
function addExtra(d: DatasetWs, tier: unknown) {
  const units = unitsOf(d)
  const src = units.find((u) => !fs.existsSync(d.path(`material_figures/${u.topic_id}.json`)))
  if (!src) throw new Error('仕込み: 図の無い単位が無い')
  const id = src.topic_id as number
  const material = bundleRows(d, 'materials', 'materials').find((m) => m.topic_id === id)!
  const questions = bundleRows(d, 'roadmap_questions', 'questions').filter((q) => q.topic_id === id)
  let added = false
  editBundles(d, 'materials', 'materials', (rows) => {
    if (added) return rows
    added = true
    return [...rows, { ...material, topic_id: EXTRA_ID, term: EXTRA_TERM }]
  })
  let qAdded = false
  editBundles(d, 'roadmap_questions', 'questions', (rows) => {
    if (qAdded) return rows
    qAdded = true
    return [
      ...rows,
      ...questions.map((q, i) => ({ ...q, qid: `extra-${EXTRA_ID}-${i + 1}`, topic_id: EXTRA_ID, term: EXTRA_TERM })),
    ]
  })
  const cands = d.read('topics_candidates.json')
  const cand: Json = { ...(cands.candidates as Json[]).find((c) => c.id === id)!, id: EXTRA_ID, term: EXTRA_TERM, prereq: [] }
  if (tier === undefined) delete cand.tier
  else cand.tier = tier
  cands.candidates.push(cand)
  d.write('topics_candidates.json', cands)
}

describe('UC-030 教材・確認問題の数・印が欠けた単位があれば投入データを書き出さない', () => {
  // @covers REQ-539#material-missing-stops
  it('ロードマップに教材の無い単位があれば、投入データを書き出さずに止め、その単位の名前を示す', () => {
    const d = copyOf('itc')
    const u = unitsOf(d)[4]
    dropMaterial(d, u.topic_id)
    expectStopped(buildDataset(d), u.term, '教材の無い単位')
  })

  // @covers REQ-539#question-count-short-stops
  it('確認問題の数が 1 単位あたりの数より少ない単位があれば、投入データを書き出さずに止め、その単位の名前を示す', () => {
    const d = copyOf('itc')
    const u = unitsOf(d)[7]
    shiftQuestions(d, u.topic_id, -1)
    expectStopped(buildDataset(d), u.term, '確認問題が少ない単位')
  })

  // @covers REQ-539#question-count-over-stops
  it('確認問題の数が 1 単位あたりの数より多い単位があれば、投入データを書き出さずに止め、その単位の名前を示す', () => {
    const d = copyOf('itc')
    const u = unitsOf(d)[7]
    shiftQuestions(d, u.topic_id, 1)
    expectStopped(buildDataset(d), u.term, '確認問題が多い単位')
  })

  // @covers REQ-539#tier-outside-registry-stops
  it('印を持つ学びで、登録簿の印の段に無い印（段の下の外・上の外）の単位があれば、投入データを書き出さずに止め、その単位の名前を示す', () => {
    const levels = tierLevels('eng')
    for (const value of [Math.min(...levels) - 1, Math.max(...levels) + 1]) {
      const d = copyOf('eng')
      const u = unitsOf(d)[3]
      setUnitField(d, u.topic_id, 'tier', value)
      expectStopped(buildDataset(d), u.term, `印 ${value}`)
    }
  })

  // @covers REQ-539#tier-missing-stops
  it('印を持つ学びで、印の欄を欠く単位があれば、投入データを書き出さずに止め、その単位の名前を示す', () => {
    const d = copyOf('eng')
    const u = unitsOf(d)[3]
    setUnitField(d, u.topic_id, 'tier', undefined)
    expectStopped(buildDataset(d), u.term, '印の欄が無い')
  })

  // @covers REQ-539#extra-tier-outside-stops
  it('印を持つ学びで、補足の論点の印が登録簿の段に無いか欠けていれば、投入データを書き出さずに止め、その論点の名前を示す', () => {
    const levels = tierLevels('eng')
    const control = copyOf('eng')
    addExtra(control, levels[0])
    const ok = buildDataset(control)
    expect(ok.status, `仕込み: 段にある印の補足の論点を足しただけで組み立てが通らない:\n${ok.out}`).toBe(0)
    for (const [where, tier] of [
      ['段の上の外', Math.max(...levels) + 1],
      ['印の欄が無い', undefined],
    ] as [string, unknown][]) {
      const d = copyOf('eng')
      addExtra(d, tier)
      expectStopped(buildDataset(d), EXTRA_TERM, where)
    }
  })

  // @covers REQ-539#material-missing-before-question-count
  it('教材の無い単位と確認問題の数が違う単位が両方あれば、教材の無い単位の名前を示して止め、もう一方の名前は示さない', () => {
    const d = copyOf('itc')
    const [counted, missing] = [unitsOf(d)[2], unitsOf(d)[9]]
    shiftQuestions(d, counted.topic_id, -1)
    dropMaterial(d, missing.topic_id)
    const r = buildDataset(d)
    expectStopped(r, missing.term, '教材の欠けと確認問題の数')
    expect(r.stdout, '後の条件の単位の名前を示している').not.toContain(counted.term)
  })

  // @covers REQ-539#question-count-before-tier-outside
  it('確認問題の数が違う単位と段に無い印の単位が両方あれば、確認問題の数が違う単位の名前を示して止め、もう一方の名前は示さない', () => {
    const d = copyOf('eng')
    const [tiered, counted] = [unitsOf(d)[2], unitsOf(d)[9]]
    setUnitField(d, tiered.topic_id, 'tier', Math.max(...tierLevels('eng')) + 1)
    shiftQuestions(d, counted.topic_id, -1)
    const r = buildDataset(d)
    expectStopped(r, counted.term, '確認問題の数と段に無い印')
    expect(r.stdout, '後の条件の単位の名前を示している').not.toContain(tiered.term)
  })

  // @covers REQ-539#tier-outside-before-blank-subtitle
  it('段に無い印の単位と副題の欄が空の単位が両方あれば、段に無い印の単位の名前を示して止め、もう一方の名前は示さない', () => {
    const d = copyOf('eng')
    const [blank, tiered] = [unitsOf(d)[2], unitsOf(d)[9]]
    setUnitField(d, blank.topic_id, 'subtitle', '')
    setUnitField(d, tiered.topic_id, 'tier', Math.max(...tierLevels('eng')) + 1)
    const r = buildDataset(d)
    expectStopped(r, tiered.term, '段に無い印と空の副題')
    expect(r.stdout, '後の条件の単位の名前を示している').not.toContain(blank.term)
  })
})

describe('UC-030 ロードマップに無い論点の教材を補足の論点として末尾に置く', () => {
  const spec = registry('itc').roadmapSpec as Json
  let d: DatasetWs
  let topics: Json[]
  let roadmapIds: Set<number>
  let extraIds: number[]

  function built() {
    d = copyOf('itc')
    roadmapIds = new Set(unitsOf(d).map((u) => u.topic_id as number))
    extraIds = [...new Set(bundleRows(d, 'materials', 'materials').map((m) => m.topic_id as number))].filter(
      (id) => !roadmapIds.has(id),
    )
    expect(extraIds.length, '仕込み: ロードマップに無い論点の教材が写しに無い').toBeGreaterThan(0)
    // 前の組み立ての投入データを外し、今回書き出した物だけを見る
    fs.rmSync(d.path('topics.json'), { force: true })
    fs.rmSync(d.path('questions'), { recursive: true, force: true })
    const r = buildDataset(d)
    expect(r.status, `組み立てが終了 0 で終わらない:\n${r.out}`).toBe(0)
    topics = d.read('topics.json').topics as Json[]
  }
  const topicOf = (id: number) => {
    const t = topics.filter((x) => x.id === id)
    expect(t, `投入データに論点 ${id} がちょうど 1 つない`).toHaveLength(1)
    return t[0]
  }

  // @covers REQ-540#extra-in-extra-field-and-round
  it('ロードマップの単位に無い論点の教材は、登録簿の補足の分野と補足の回に入る', () => {
    built()
    for (const id of extraIds) {
      const t = topicOf(id)
      expect(t.field, `論点 ${id} の分野`).toBe(spec.extraField)
      expect(t.round, `論点 ${id} の回`).toBe(spec.extraRoundId)
    }
  })

  // @covers REQ-540#extra-after-roadmap-units
  it('補足の論点は、学ぶ順でロードマップのどの単位よりも後ろに置かれる', () => {
    built()
    const last = Math.max(...[...roadmapIds].map((id) => topicOf(id).sort_order as number))
    for (const id of extraIds) expect(topicOf(id).sort_order, `論点 ${id} の学ぶ順`).toBeGreaterThan(last)
  })

  // @covers REQ-540#extra-questions-in-extra-round
  it('補足の論点の確認問題は、補足の回に入る', () => {
    built()
    const extraFile = d.path(`questions/${spec.extraRoundId}.json`)
    expect(fs.existsSync(extraFile), '補足の回の確認問題が書き出されていない').toBe(true)
    const expected = bundleRows(d, 'roadmap_questions', 'questions').filter((q) => extraIds.includes(q.topic_id)).length
    expect(JSON.parse(fs.readFileSync(extraFile, 'utf8')).questions).toHaveLength(expected)
    for (const id of extraIds) {
      const qs = topicOf(id).questions as Json[]
      expect(qs.length, `論点 ${id} の確認問題が投入データに無い`).toBeGreaterThan(0)
      for (const q of qs) expect(q.exam, `論点 ${id} の確認問題の回`).toBe(spec.extraRoundId)
    }
  })

  // @covers REQ-540#roadmap-units-not-extra
  it('ロードマップの単位の論点は、補足の分野にも補足の回にも入らない', () => {
    built()
    for (const id of roadmapIds) {
      const t = topicOf(id)
      expect(t.field, `論点 ${id} の分野`).not.toBe(spec.extraField)
      expect(t.round, `論点 ${id} の回`).not.toBe(spec.extraRoundId)
      for (const q of t.questions as Json[]) expect(q.exam, `論点 ${id} の確認問題の回`).not.toBe(spec.extraRoundId)
    }
  })
})
