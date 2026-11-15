/** UC-027 書き直した世代の教材と単元の構成を配る本文に組み立てる。契約の入口 5 つ（buildSeed・attachMaterialFigures・
 *  checkFigureSpecs・checkRender・verifySeedRemote）を、資格対策の学び（ip）の写しを置いた一時の作業場を cwd にしたコマンドとして呼ぶ。
 *
 *  仕込み（UC-027_fixture.ts）: 写しの書き直した世代と単元の構成を消したうえで、論点の数が 6〜16 の単元から 2 つを選んで単元の構成を書き、
 *  1 つ目の単元の、図を 2 枚以上持ち前の世代の detail に見出しがある論点 2 つ（R1・R2）と、前の世代の教材を消した論点（R3）を
 *  書き直した世代に書く。前の世代の論点は、最も新しい前の世代が v3 の論点（Q1）、v3 から消して v2 が最も新しくなった論点（Q2）、
 *  v3 の中で後のファイルにもう 1 つ教材を足した論点（Q3）を使う。本文の先頭に世代ごとの目印を置き、配る本文がどの世代から来たかを見分ける。
 *
 *  観測: 終了コード・出力（契約の response か ToolError の形の JSON）、書かれた投入の SQL を migrations を当てた SQLite に流した結果。
 *  配る本文は getTopicDetail（HTTP）で見る。単元の構成は一覧と論点の応答の欄の API 側がまだ無いので、表を SELECT で見る。
 *  流したあとの DB との突き合わせは、wrangler だけを SQLite ファイルに流す偽物に差し替える。 */

import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  PREVIOUS,
  REWRITTEN,
  SEED,
  applySeed,
  attachFigures,
  buildSeed,
  catalog,
  checkFigureSpecs,
  checkRender,
  cleanWorkspaces,
  editEntries,
  entriesOf,
  expectRefused,
  figureFile,
  figureSpec,
  headingsOf,
  isFigure,
  learningOrder,
  loadSeed,
  makeWorkspace,
  mark,
  placement,
  planFile,
  planFor,
  prependMark,
  resultOf,
  rewrittenHeading,
  rewrittenMaterial,
  rows,
  seededDbFile,
  topicDetail,
  verifySeed,
  withDbFile,
  type Catalog,
  type Json,
  type Run,
  type Ws,
} from './UC-027_fixture'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 })

const LEARNING = 'ip'
const [V1, V2, V3] = PREVIOUS
const UNIT_TABLES = ['unit_plans', 'unit_groups', 'unit_group_topics', 'topic_prerequisites'] as const
const LATER_FILE = '目印-後のファイル'

const ok = (r: Run, label: string) => expect(r.status, `${label} が終了 0 で終わらない:\n${r.out}`).toBe(0)
const svgPath = (ws: Ws, topicId: number, figId: number) => ws.abs(`public/figures/materials/${ws.learning}/${topicId}-${figId}.svg`)
/** 図の仕様書の門の表の {where} の形。 */
const where = (topicId: number, figId: number) => `[${topicId}.json] 論点 ${topicId} 図 ${figId}`

/* ---------- 共有の仕込み（書き直した世代と単元の構成がある学び） ---------- */

let ws: Ws
let cat: Catalog
let unitA = 0
let unitB = 0
let planA: Json
let planB: Json
let R1 = 0
let R2 = 0
let R3 = 0
let Q1 = 0
let Q2 = 0
let Q3 = 0
/** 書き直した世代の論点ごとに、図の id と差し込み位置。 */
const rewrittenFigs = new Map<number, { id: number; after: string }[]>()
/** 書き直した世代の束のファイルの、図を差し込む前の中身。 */
const pristineBundles = new Map<string, Json>()
/** 単元の構成が 1 つも無く、書き直した世代も無いときの投入。 */
let baseline: { run: Run; sql: string; d1: D1Database | null; error: string }
/** 図を差し込み、組み立てた投入。 */
let assembled: { attach: Run; run: Run; sql: string; d1: D1Database | null; error: string }
/** 書き直した世代に置き換わる論点の、前の世代の detail の見出し。 */
const previousHeadings = new Map<number, string[]>()

const hasFigures = (id: number, min: number) => {
  const s = figureSpec(ws, id)
  return !!s && (s.figures as Json[]).length >= min && (s.figures as Json[]).every((f) => fs.existsSync(svgPath(ws, id, f.id)))
}
const v3Headings = (id: number) => entriesOf(ws, V3, id).flatMap((m) => headingsOf(m.detail))

async function load(run: Run) {
  if (run.status !== 0) return { sql: '', d1: null, error: `組み立てが終了 0 で終わらない:\n${run.out}` }
  const sql = ws.readText(SEED(ws))
  try {
    return { sql, d1: await loadSeed(sql), error: '' }
  } catch (e) {
    return { sql, d1: null, error: `投入の SQL を流せない: ${String(e)}` }
  }
}
const d1Of = (s: { d1: D1Database | null; error: string }) => {
  if (!s.d1) throw new Error(s.error)
  return s.d1
}
const sqlOf = (s: { sql: string; error: string }) => {
  if (!s.sql) throw new Error(s.error)
  return s.sql
}

/** 学びの置き場の教材の世代と図の仕様と seed.sql を写しておき、f のあとに元へ戻す。 */
async function restoring<T>(f: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string>()
  for (const dir of [...PREVIOUS, REWRITTEN, 'material_figures', 'unit_plans']) {
    const abs = ws.abs(`${ws.data}/${dir}`)
    if (!fs.existsSync(abs)) continue
    for (const n of fs.readdirSync(abs)) saved.set(`${ws.data}/${dir}/${n}`, ws.readText(`${ws.data}/${dir}/${n}`))
  }
  try {
    return await f()
  } finally {
    ws.remove(`${ws.data}/unit_plans`)
    for (const [rel, body] of saved) ws.writeText(rel, body)
  }
}

beforeAll(async () => {
  ws = makeWorkspace(LEARNING)
  cat = catalog(ws)
  const units = [...cat.unitTopics.entries()].filter(([, t]) => t.length >= 6 && t.length <= 16).sort((a, b) => a[1].length - b[1].length)
  const candidate = (ids: number[]) => ids.filter((id) => hasFigures(id, 2) && v3Headings(id).length > 0)
  const a = units.find(([, t]) => candidate(t).length >= 2)
  if (!a) throw new Error('図を 2 枚以上持ち見出しのある論点が 2 つある単元が無い（仕込みを作れない）')
  unitA = a[0]
  const b = units.find(([u]) => u !== unitA)
  if (!b) throw new Error('2 つ目の単元が無い（仕込みを作れない）')
  unitB = b[0]
  planA = planFor(cat, unitA)
  planB = planFor(cat, unitB)
  ;[R1, R2] = candidate(learningOrder(planA))
  const planned = new Set([...learningOrder(planA), ...learningOrder(planB)])
  const all = [...cat.term.keys()]
  const used = () => new Set([R1, R2, R3, Q1, Q2, Q3])
  R3 = learningOrder(planA).find((id) => !used().has(id) && !figureSpec(ws, id)) ?? learningOrder(planA).find((id) => !used().has(id))!
  Q1 =
    all.find((id) => !used().has(id) && cat.unitTopics.get(unitA)!.includes(id) && hasFigures(id, 1) && v3Headings(id).length > 0) ??
    all.find((id) => !planned.has(id) && !used().has(id) && hasFigures(id, 1) && v3Headings(id).length > 0)!
  Q2 = all.find((id) => !planned.has(id) && !used().has(id) && entriesOf(ws, V1, id).length > 0 && entriesOf(ws, V2, id).length > 0)!
  const v3Files = fs.readdirSync(ws.abs(`${ws.data}/${V3}`)).filter((n) => n.endsWith('.json')).sort()
  const lastV3 = `${ws.data}/${V3}/${v3Files[v3Files.length - 1]}`
  const inLast = new Set((ws.readJson(lastV3).materials as Json[]).map((m) => m.topic_id))
  Q3 = all.find((id) => !planned.has(id) && !used().has(id) && !inLast.has(id) && entriesOf(ws, V3, id).length === 1)!
  if (!R3 || !Q1 || !Q2 || !Q3) throw new Error('論点を選べない（仕込みを作れない）')

  for (const id of [R1, R2, Q1, Q3]) for (const g of PREVIOUS) prependMark(ws, g, id)
  for (const g of [V1, V2]) prependMark(ws, g, Q2)
  editEntries(ws, V3, Q2, () => 'remove')
  const last = ws.readJson(lastV3)
  const q3 = entriesOf(ws, V3, Q3)[0]
  last.materials.push({ ...q3, explanation: `${LATER_FILE}-${Q3}\n\n${String(q3.explanation).replace(mark(V3, Q3), '')}` })
  ws.writeJson(lastV3, last)
  for (const id of [R1, R2]) previousHeadings.set(id, v3Headings(id))

  const base = buildSeed(ws)
  baseline = { run: base, ...(await load(base)) }

  // 書き直した世代と単元の構成を書く。R3 は前の世代の教材を消し、書き直した世代にだけ教材がある論点にする
  for (const g of PREVIOUS) editEntries(ws, g, R3, () => 'remove')
  const r3Spec = figureSpec(ws, R3)
  if (r3Spec) {
    for (const f of r3Spec.figures as Json[]) f.after = 'explanation'
    ws.writeJson(figureFile(ws, R3), r3Spec)
  }
  ws.writeJson(planFile(ws, unitA), planA)
  ws.writeJson(planFile(ws, unitB), planB)
  const groupOf = (id: number) => (planA.groups as Json[]).findIndex((g) => g.topics.includes(id)) + 1
  const nn = String(unitA).padStart(2, '0')
  const bundles = new Map<string, Json[]>()
  for (const id of [R1, R2, R3]) {
    const name = `${nn}-${groupOf(id)}`
    bundles.set(name, [...(bundles.get(name) ?? []), rewrittenMaterial(id, cat.term.get(id)!)])
  }
  for (const id of [R1, R2]) {
    const spec = figureSpec(ws, id)!
    ;(spec.figures as Json[]).forEach((f, i) => {
      f.after = i === 0 ? 'explanation' : rewrittenHeading(id, i === 1 ? '乙' : '甲')
    })
    rewrittenFigs.set(id, (spec.figures as Json[]).map((f) => ({ id: f.id, after: f.after })))
    ws.writeJson(figureFile(ws, id), spec)
  }
  for (const [name, materials] of bundles) {
    const body = { bundle: name, materials }
    pristineBundles.set(`${ws.data}/${REWRITTEN}/${name}.json`, body)
    ws.writeJson(`${ws.data}/${REWRITTEN}/${name}.json`, body)
  }

  const attach = attachFigures(ws)
  const run = buildSeed(ws)
  assembled = { attach, run, ...(await load(run)) }
})

afterAll(() => cleanWorkspaces())

const detailIn = async (s: { d1: D1Database | null; error: string }, id: number) => topicDetail(d1Of(s), LEARNING, id)
const bodyText = (t: Json) => `${t.explanation ?? ''}\n${t.detail ?? ''}`
const UNIT_ORDER: Record<(typeof UNIT_TABLES)[number], string> = {
  unit_plans: 'middle_no',
  unit_groups: 'middle_no, group_no',
  unit_group_topics: 'topic_id',
  topic_prerequisites: 'topic_id, prerequisite_topic_id',
}
const unitRows = (d1: D1Database) =>
  Object.fromEntries(UNIT_TABLES.map((t) => [t, rows(d1, `SELECT * FROM ${t} ORDER BY ${UNIT_ORDER[t]}`)]))

/** 単元の構成から作るはずの行。 */
function expectedUnitRows(plans: Json[]) {
  const sorted = [...plans].sort((x, y) => x.unit_no - y.unit_no)
  return {
    unit_plans: sorted.map((p) => ({ middle_no: p.unit_no, overview: p.overview })),
    unit_groups: sorted.flatMap((p) => (p.groups as Json[]).map((g, i) => ({ middle_no: p.unit_no, group_no: i + 1, name: g.name, description: g.description }))),
    unit_group_topics: sorted
      .flatMap((p) => (p.groups as Json[]).flatMap((g, gi) => (g.topics as number[]).map((t, ti) => ({ topic_id: t, middle_no: p.unit_no, group_no: gi + 1, position: ti + 1 }))))
      .sort((x, y) => x.topic_id - y.topic_id),
    topic_prerequisites: sorted
      .flatMap((p) =>
        Object.entries(p.prerequisites as Record<string, number[]>).flatMap(([t, pre]) =>
          pre.map((q, i) => ({ topic_id: Number(t), prerequisite_topic_id: q, position: i + 1 })),
        ),
      )
      .sort((x, y) => x.topic_id - y.topic_id || x.prerequisite_topic_id - y.prerequisite_topic_id),
  }
}

/* ---------- REQ-467 ---------- */

describe('教材の世代を古い順に重ね、論点ごとに最も新しい教材を配る本文にする（UC-027）', () => {
  // @covers REQ-467#rewritten-topic
  it('書き直した世代に教材がある論点は、前の世代にも教材があっても、書き直した世代の教材を配る本文にする', async () => {
    ok(assembled.run, '投入の組み立て')
    for (const id of [R1, R2]) {
      const text = bodyText(await detailIn(assembled, id))
      expect(text, `論点 ${id} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, id))
      for (const g of PREVIOUS) expect(text, `論点 ${id} に ${g} の教材が混ざっている`).not.toContain(mark(g, id))
    }
  })

  // @covers REQ-467#rewritten-only-topic
  it('書き直した世代にだけ教材がある論点も、その教材を配る本文にする', async () => {
    ok(assembled.run, '投入の組み立て')
    expect(bodyText(await detailIn(assembled, R3)), `論点 ${R3} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, R3))
  })

  // @covers REQ-467#unrewritten-topic-latest-previous
  it('書き直した世代に教材が無い論点は、前の世代のうち最も新しい世代の教材を配る本文にする（v3 が最も新しい論点と v2 が最も新しい論点）', async () => {
    for (const s of [baseline, assembled]) {
      ok(s.run, '投入の組み立て')
      const q1 = bodyText(await detailIn(s, Q1))
      expect(q1, `論点 ${Q1} が v3 の教材でない`).toContain(mark(V3, Q1))
      for (const g of [V1, V2]) expect(q1).not.toContain(mark(g, Q1))
      const q2 = bodyText(await detailIn(s, Q2))
      expect(q2, `論点 ${Q2} が v2 の教材でない`).toContain(mark(V2, Q2))
      expect(q2).not.toContain(mark(V1, Q2))
    }
  })

  // @covers REQ-467#later-file-in-generation
  it('同じ世代の中に同じ論点の教材が 2 つあれば、後のファイル（名前の順で後）の教材を配る本文にする', async () => {
    ok(assembled.run, '投入の組み立て')
    const text = bodyText(await detailIn(assembled, Q3))
    expect(text, `論点 ${Q3} が後のファイルの教材でない`).toContain(`${LATER_FILE}-${Q3}`)
    expect(text, `論点 ${Q3} に前のファイルの教材が混ざっている`).not.toContain(mark(V3, Q3))
  })
})

/* ---------- REQ-468 ---------- */

describe('単元の構成を投入に含め、単元の構成を持つ表を今の構成の行だけに入れ替える（UC-027）', () => {
  // @covers REQ-468#overview
  it('単元の構成がある単元ごとに、全体像が投入に入る', () => {
    ok(assembled.run, '投入の組み立て')
    const got = rows(d1Of(assembled), 'SELECT middle_no, overview FROM unit_plans ORDER BY middle_no')
    expect(got).toEqual(expectedUnitRows([planA, planB]).unit_plans)
  })

  // @covers REQ-468#groups-in-order
  it('まとまりの名前と説明が、単元の構成の並びの順を番号として投入に入る', () => {
    ok(assembled.run, '投入の組み立て')
    for (const p of [planA, planB]) {
      const got = rows(d1Of(assembled), `SELECT group_no, name, description FROM unit_groups WHERE middle_no = ${p.unit_no} ORDER BY group_no`)
      expect(got, `単元 ${p.unit_no} のまとまり`).toEqual((p.groups as Json[]).map((g, i) => ({ group_no: i + 1, name: g.name, description: g.description })))
    }
  })

  // @covers REQ-468#topics-in-learning-order
  it('まとまりの中の論点が、単元の構成の並び（論点 ID の順でない）を学ぶ順として投入に入る', () => {
    ok(assembled.run, '投入の組み立て')
    for (const p of [planA, planB]) {
      const got = rows(
        d1Of(assembled),
        `SELECT topic_id, group_no, position FROM unit_group_topics WHERE middle_no = ${p.unit_no} ORDER BY group_no, position`,
      )
      const want = (p.groups as Json[]).flatMap((g, gi) => (g.topics as number[]).map((t, ti) => ({ topic_id: t, group_no: gi + 1, position: ti + 1 })))
      expect(got, `単元 ${p.unit_no} のまとまりの中の学ぶ順`).toEqual(want)
    }
  })

  // @covers REQ-468#prerequisites
  it('論点ごとの前提の論点が、単元の構成の並びを示す順として投入に入り、前提を持たない論点は行を持たない', () => {
    ok(assembled.run, '投入の組み立て')
    const got = rows(d1Of(assembled), 'SELECT topic_id, prerequisite_topic_id, position FROM topic_prerequisites ORDER BY topic_id, position')
    const want = expectedUnitRows([planA, planB]).topic_prerequisites.sort((x, y) => x.topic_id - y.topic_id || x.position - y.position)
    expect(got).toEqual(want)
  })

  // @covers REQ-468#unplanned-unit-absent
  it('単元の構成が無い単元は、全体像もまとまりも論点の学ぶ順も投入に入らない', () => {
    ok(assembled.run, '投入の組み立て')
    const d1 = d1Of(assembled)
    const planned = [unitA, unitB].join(',')
    expect(rows(d1, `SELECT middle_no FROM unit_plans WHERE middle_no NOT IN (${planned})`)).toEqual([])
    expect(rows(d1, `SELECT middle_no FROM unit_groups WHERE middle_no NOT IN (${planned})`)).toEqual([])
    const inPlans = new Set([...learningOrder(planA), ...learningOrder(planB)])
    const grouped = rows(d1, 'SELECT topic_id FROM unit_group_topics').map((r) => r.topic_id as number)
    expect(grouped.filter((t) => !inPlans.has(t))).toEqual([])
  })

  // @covers REQ-468#replace-removed-unit
  it('単元の構成から無くなった単元の行は、新しい投入を同じ DB に流すと残らず、今の単元の構成から作った行だけになる', async () => {
    const d1 = await loadSeed(sqlOf(assembled))
    expect(rows(d1, 'SELECT COUNT(*) AS n FROM unit_plans'), '仕込み: 単元の構成が 2 つ入っていない').toEqual([{ n: 2 }])
    const next = await restoring(() => {
      ws.remove(planFile(ws, unitB))
      const r = buildSeed(ws)
      return { r, sql: r.status === 0 ? ws.readText(SEED(ws)) : '' }
    })
    ok(next.r, '単元の構成を 1 つ減らした投入の組み立て')
    applySeed(d1, next.sql)
    expect(unitRows(d1)).toEqual(expectedUnitRows([planA]))
  })
})

/* ---------- REQ-469 ---------- */

describe('止める理由に当たる単元の構成があれば投入を書き出さずに止める（UC-027）', () => {
  const SENTINEL = '-- 前の投入（組み立てが止まったら書き換わらない）\n'
  let stopWs: Ws
  let good: Json
  let bad: Json
  beforeAll(() => {
    stopWs = makeWorkspace(LEARNING)
    const stopCat = catalog(stopWs)
    const units = [...stopCat.unitTopics.entries()].filter(([, t]) => t.length >= 6 && t.length <= 16).sort((a, b) => a[1].length - b[1].length)
    good = planFor(stopCat, units[0][0])
    bad = planFor(stopCat, units[1][0])
  })
  /** 止める理由の無い単元の構成と、書き換えた単元の構成を置いて組み立てる。 */
  function buildWith(target: Ws, edited: Json | string, data = target.data) {
    target.remove(`${data}/unit_plans`)
    target.writeJson(`${data}/unit_plans/${String(good.unit_no).padStart(2, '0')}.json`, good)
    const rel = `${data}/unit_plans/${String(bad.unit_no).padStart(2, '0')}.json`
    if (typeof edited === 'string') target.writeText(rel, edited)
    else target.writeJson(rel, edited)
    target.writeText(`${data}/seed.sql`, SENTINEL)
    return { run: buildSeed(target, data), seed: target.readText(`${data}/seed.sql`) }
  }
  const badFile = () => `${String(bad.unit_no).padStart(2, '0')}.json`
  const clone = () => JSON.parse(JSON.stringify(bad)) as Json

  const cases: [string, string, () => Json | string][] = [
    ['形として読めない', 'unreadablePlan', () => '{"unit_no": '],
    ['全体像が欠ける', 'missingElement', () => { const p = clone(); delete p.overview; return p }],
    ['まとまりに入っていない論点がある', 'topicNotGrouped', () => { const p = clone(); p.groups[1].topics.pop(); return p }],
    ['実在しない論点がある', 'unknownTopic', () => { const p = clone(); p.groups[1].topics.push(999999); return p }],
    ['前提が自分自身', 'prerequisiteSelf', () => { const p = clone(); const t = p.groups[0].topics[0]; p.prerequisites = { [String(t)]: [t] }; return p }],
  ]

  // @covers REQ-469#stop-without-writing
  it('止める理由に当たる単元の構成が 1 つでもあれば、止める理由の無い単元の構成があっても、投入を書き出さずに CONFLICT で止める', () => {
    for (const [label, , make] of cases) {
      const r = buildWith(stopWs, make())
      expectRefused(r.run, 'CONFLICT', label)
      expect(r.seed, `${label}: 投入が書き換わった`).toBe(SENTINEL)
    }
  })

  // @covers REQ-469#show-unit-and-reason
  it('止めたとき、止める理由に当たる単元（単元の構成のファイル）と理由（単元の構成の門の止める理由の種類）を示す', () => {
    for (const [label, kind, make] of cases) {
      const r = buildWith(stopWs, make())
      expect(r.run.status, `${label}: 止まらずに終了 0 で終わった:\n${r.run.out}`).not.toBe(0)
      expect(r.run.out, `${label}: 単元を示していない`).toContain(badFile())
      expect(r.run.out, `${label}: 理由を示していない`).toContain(kind)
    }
  })

  // @covers REQ-469#warning-only-not-stopped
  it('警告だけが当たる単元の構成（論点が 3 に届かないまとまり）では止めず、投入を書き出して単元の構成を含める', async () => {
    const p = clone()
    const order = learningOrder(p)
    p.groups = [
      { ...p.groups[0], topics: order.slice(0, 2) },
      { ...p.groups[1], topics: order.slice(2) },
    ]
    const r = buildWith(stopWs, p)
    expect(r.run.status, `警告だけで止まった:\n${r.run.out}`).toBe(0)
    expect(r.seed).not.toBe(SENTINEL)
    const d1 = await loadSeed(r.seed)
    expect(rows(d1, `SELECT group_no FROM unit_groups WHERE middle_no = ${p.unit_no} ORDER BY group_no`)).toEqual([{ group_no: 1 }, { group_no: 2 }])
  })

  // @covers REQ-469#unregistered-learning-before-plan-stop
  it('登録簿に無い学びは、止める理由に当たる単元の構成があっても、単元の構成を確かめる前に INVALID_INPUT で断り投入を書き出さない（CONFLICT より先）', () => {
    const zz = makeWorkspace(LEARNING, 'zzz')
    const r = buildWith(zz, '{"unit_no": ')
    expectRefused(r.run, 'INVALID_INPUT', '登録簿に無い学び')
    expect(r.seed).toBe(SENTINEL)
    expect(r.run.out, '単元の構成を確かめている').not.toContain('unreadablePlan')
  })
})

/* ---------- REQ-470 ---------- */

describe('図の仕様に無い図の行を残さず、書き直した世代の論点の図を差し込み位置に入れ、前の世代の論点の図の置き方は変えない（UC-027）', () => {
  // @covers REQ-470#rewritten-after-explanation
  it('書き直した世代から選んだ論点の、差し込み位置が explanation の図は、配る本文の explanation に 1 回だけ入り detail には入らない', async () => {
    ok(assembled.attach, '図の差し込み')
    ok(assembled.run, '投入の組み立て')
    for (const id of [R1, R2]) {
      const fig = rewrittenFigs.get(id)!.find((f) => f.after === 'explanation')!
      const at = placement(await detailIn(assembled, id)).filter(([, p]) => isFigure(p, id, fig.id))
      expect(at.map(([s]) => s), `論点 ${id} の図 ${fig.id} の置き場`).toEqual(['explanation'])
    }
  })

  // @covers REQ-470#rewritten-after-heading
  it('書き直した世代から選んだ論点の、差し込み位置が見出しの図は、学びが IT パスポートでも、配る本文の detail のその見出しの節に 1 回だけ入る', async () => {
    ok(assembled.attach, '図の差し込み')
    ok(assembled.run, '投入の組み立て')
    for (const id of [R1, R2]) {
      const placed = placement(await detailIn(assembled, id))
      for (const fig of rewrittenFigs.get(id)!.filter((f) => f.after !== 'explanation')) {
        const at = placed.filter(([, p]) => isFigure(p, id, fig.id))
        expect(at.map(([s]) => s), `論点 ${id} の図 ${fig.id} の置き場`).toEqual([fig.after])
      }
    }
  })

  // @covers REQ-470#rerun-same-placement
  it('図の差し込みをもう一度かけても、書き直した世代の論点の図は同じ置き場に 1 回だけある', async () => {
    ok(assembled.run, '投入の組み立て')
    const first = new Map<number, [string, string][]>()
    for (const id of [R1, R2]) first.set(id, placement(await detailIn(assembled, id)))
    const again = await restoring(async () => {
      ok(attachFigures(ws), '2 回目の図の差し込み')
      const rerun = buildSeed(ws)
      return { run: rerun, ...(await load(rerun)) }
    })
    for (const id of [R1, R2]) expect(placement(await detailIn(again, id)), `論点 ${id}`).toEqual(first.get(id))
  })

  /* 図の仕様に無い図の行と、前の世代の論点の図の置き方は、この describe の仕込みで自分で作る（写しの実データの中身に寄らない）。
   *  前の世代の論点 P: v3 の教材を 1 つだけ持つ論点の図の仕様を、写しの図 1 枚を型にした 3 枚（id 91〜93）に置き換え、
   *  v3 の本文の図の行を消してから、図の仕様の差し込み位置と違う置き方（explanation に 92、最初の見出しの節に 93・91 の順）で図の行を書く。
   *  図の仕様に無い図の行: 画像だけを置いた id 94 の図の行を、P の v3 の本文と R1 の書き直した世代の本文の explanation と detail に書く。 */
  const P_FIGS = [91, 92, 93] as const
  const STRAY = 94
  /** 図の説明文に角かっこを含む図。図の仕様にある図（BRACKET_FIG）と、図の仕様に無い図の行（BRACKET_STRAY）。 */
  const BRACKET_FIG = 95
  const BRACKET_STRAY = 96
  const BRACKET_CAPTION = '根を A[1] に置き、子の添字を線の上の式（左が 2i、右が 2i＋1）で決めています。'
  let P = 0
  let pHeading = ''
  type Loaded = { sql: string; d1: D1Database | null; error: string }
  let unlisted: {
    before: { run: Run } & Loaded
    attach: Run
    run: Run
    after: Loaded
    attachAgain: Run
    runAgain: Run
    afterAgain: Loaded
  }
  const figLine = (id: number, figId: number) => `![図${figId}の説明です。](/figures/materials/${ws.learning}/${id}-${figId}.svg)`
  const bracketLine = (id: number, figId: number) => `![${BRACKET_CAPTION}](/figures/materials/${ws.learning}/${id}-${figId}.svg)`
  const figPath = (id: number, figId: number) => `/figures/materials/${ws.learning}/${id}-${figId}.svg`
  /** 本文の図の行の置き場を、行の末尾の `](指す先)` で読む（図の説明文の中の角かっこに左右されない）。 */
  const linePlacement = (body: { explanation?: string | null; detail?: string | null }) => {
    const out: [string, string, string][] = []
    const scan = (text: string | null | undefined, first: string) => {
      let section = first
      for (const line of String(text ?? '').split('\n')) {
        if (first !== 'explanation' && line.startsWith('### ')) section = line.trim()
        const m = line.match(/\]\((\/figures\/materials\/[^)\s]+)\)\s*$/)
        if (m && line.trimStart().startsWith('![')) out.push([section, m[1], line])
      }
    }
    scan(body.explanation, 'explanation')
    scan(body.detail, 'detail の先頭')
    return out
  }
  const linesOf = async (s: Loaded, id: number, figId: number) =>
    linePlacement(await detailIn(s, id)).filter(([, p]) => p === figPath(id, figId))
  const isFigLineOf = (line: string, id: number) => new RegExp(`\\]\\(/figures/materials/${ws.learning}/${id}-\\d+\\.svg\\)`).test(line)
  /** 本文から、その論点の図の行を消す。 */
  const stripFigLines = (text: string | null | undefined, id: number) =>
    String(text ?? '')
      .split('\n')
      .filter((l) => !isFigLineOf(l, id))
      .join('\n')
  /** detail のその見出しの行の直後に、図の行を並べて入れる。 */
  const underHeading = (detail: string, heading: string, lines: string[]) => {
    const ls = detail.split('\n')
    const at = ls.findIndex((l) => l.trim() === heading)
    if (at < 0) throw new Error(`仕込み: 見出し ${heading} が detail に無い`)
    ls.splice(at + 1, 0, '', ...lines.flatMap((l) => [l, '']))
    return ls.join('\n')
  }
  const placementOf = async (s: { d1: D1Database | null; error: string }, id: number, figIds: readonly number[]) =>
    placement(await detailIn(s, id)).filter(([, p]) => figIds.some((f) => isFigure(p, id, f)))

  beforeAll(async () => {
    const used = new Set([R1, R2, R3, Q1, Q2, Q3])
    P = [...cat.term.keys()].find((id) => {
      if (used.has(id) || entriesOf(ws, REWRITTEN, id).length > 0 || entriesOf(ws, V3, id).length !== 1 || v3Headings(id).length === 0) return false
      const s = figureSpec(ws, id)
      return !!s && (s.figures as Json[]).some((f) => fs.existsSync(svgPath(ws, id, f.id)))
    })!
    if (!P) throw new Error('仕込み: v3 の教材を 1 つだけ持ち、見出しと画像のある図を持つ前の世代の論点が無い')
    pHeading = v3Headings(P)[0].trim()
    const copied: string[] = []
    unlisted = await restoring(async () => {
      try {
        const spec = figureSpec(ws, P)!
        const template = (spec.figures as Json[]).find((f) => fs.existsSync(svgPath(ws, P, f.id)))!
        const templateSvg = svgPath(ws, P, template.id)
        const afterOf: Record<number, string> = { 91: 'explanation', 92: pHeading, 93: pHeading }
        spec.figures = [
          ...P_FIGS.map((figId) => ({ ...template, id: figId, after: afterOf[figId] })),
          { ...template, id: BRACKET_FIG, after: pHeading, caption: BRACKET_CAPTION },
        ]
        ws.writeJson(figureFile(ws, P), spec)
        const r1Spec = figureSpec(ws, R1)!
        const r1Template = (r1Spec.figures as Json[])[0]
        r1Spec.figures = [...(r1Spec.figures as Json[]), { ...r1Template, id: BRACKET_FIG, after: rewrittenHeading(R1, '甲'), caption: BRACKET_CAPTION }]
        ws.writeJson(figureFile(ws, R1), r1Spec)
        for (const figId of [BRACKET_FIG, BRACKET_STRAY]) {
          const dst = svgPath(ws, R1, figId)
          fs.copyFileSync(svgPath(ws, R1, r1Template.id), dst)
          copied.push(dst)
        }
        for (const [id, figId] of [
          ...P_FIGS.map((f) => [P, f] as const),
          [P, STRAY] as const,
          [R1, STRAY] as const,
          [P, BRACKET_FIG] as const,
          [P, BRACKET_STRAY] as const,
        ]) {
          const dst = svgPath(ws, id, figId)
          fs.copyFileSync(templateSvg, dst)
          copied.push(dst)
        }
        editEntries(ws, V3, P, (m) => {
          m.explanation = `${mark(V3, P)}\n\n${stripFigLines(m.explanation, P)}\n\n${figLine(P, 92)}\n\n${figLine(P, STRAY)}`
          m.detail = underHeading(stripFigLines(m.detail, P), pHeading, [
            figLine(P, 93),
            figLine(P, STRAY),
            figLine(P, 91),
            bracketLine(P, BRACKET_FIG),
            bracketLine(P, BRACKET_STRAY),
          ])
        })
        for (const [rel, body] of pristineBundles) {
          const copy = JSON.parse(JSON.stringify(body)) as Json
          for (const m of copy.materials as Json[]) {
            if (m.topic_id !== R1) continue
            m.explanation = `${m.explanation}\n\n${figLine(R1, STRAY)}\n\n${bracketLine(R1, BRACKET_STRAY)}`
            m.detail = underHeading(m.detail, rewrittenHeading(R1, '甲'), [figLine(R1, STRAY)])
          }
          ws.writeJson(rel, copy)
        }
        const base = buildSeed(ws)
        const before = { run: base, ...(await load(base)) }
        const attach = attachFigures(ws)
        const run = buildSeed(ws)
        const after = await load(run)
        const attachAgain = attachFigures(ws)
        const runAgain = buildSeed(ws)
        return { before, attach, run, after, attachAgain, runAgain, afterAgain: await load(runAgain) }
      } finally {
        for (const f of copied) fs.rmSync(f, { force: true })
      }
    })
  })

  // @covers REQ-470#rewritten-unlisted-figure-dropped
  it('書き直した世代から選んだ論点の本文に図の仕様に無い図の行があれば、図を差し込んだあとの配る本文の explanation にも detail にもその行は残らない', async () => {
    ok(unlisted.before.run, '差し込む前の投入の組み立て')
    ok(unlisted.attach, '図の差し込み')
    ok(unlisted.run, '投入の組み立て')
    const t = await detailIn(unlisted.after, R1)
    expect(bodyText(t), `論点 ${R1} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, R1))
    expect(
      (await placementOf(unlisted.before, R1, [STRAY])).map(([sec]) => sec),
      '仕込み: 差し込む前の配る本文に図の仕様に無い図の行が無い',
    ).toEqual(['explanation', rewrittenHeading(R1, '甲')])
    expect(await placementOf(unlisted.after, R1, [STRAY]), `論点 ${R1} の図の仕様に無い図 ${STRAY} の行`).toEqual([])
  })

  // @covers REQ-470#previous-unlisted-figure-dropped
  it('前の世代から選んだ論点の本文に図の仕様に無い図の行があれば、図を差し込んだあとの配る本文の explanation にも detail にもその行は残らない', async () => {
    ok(unlisted.before.run, '差し込む前の投入の組み立て')
    ok(unlisted.attach, '図の差し込み')
    ok(unlisted.run, '投入の組み立て')
    expect(bodyText(await detailIn(unlisted.after, P)), `論点 ${P} が v3 の教材でない`).toContain(mark(V3, P))
    expect(
      (await placementOf(unlisted.before, P, [STRAY])).map(([sec]) => sec),
      '仕込み: 差し込む前の配る本文に図の仕様に無い図の行が無い',
    ).toEqual(['explanation', pHeading])
    expect(await placementOf(unlisted.after, P, [STRAY]), `論点 ${P} の図の仕様に無い図 ${STRAY} の行`).toEqual([])
  })

  // @covers REQ-470#previous-placement-kept
  it('前の世代から選んだ論点の、図の仕様にある図の置き方（どの図が explanation かどの見出しの節にあるか、その並び）は、図の仕様の差し込み位置と違っても、図を差し込む前の配る本文と同じ', async () => {
    ok(unlisted.before.run, '差し込む前の投入の組み立て')
    ok(unlisted.attach, '図の差し込み')
    ok(unlisted.run, '投入の組み立て')
    const before = await placementOf(unlisted.before, P, P_FIGS)
    const p = (f: number) => `/figures/materials/${ws.learning}/${P}-${f}.svg`
    expect(before, '仕込み: 差し込む前の配る本文の置き方').toEqual([
      ['explanation', p(92)],
      [pHeading, p(93)],
      [pHeading, p(91)],
    ])
    expect(await placementOf(unlisted.after, P, P_FIGS), `論点 ${P} の図の仕様にある図の置き方`).toEqual(before)
  })

  // @covers REQ-470#bracket-caption-unlisted-dropped
  it('図の説明文に角かっこを含む、図の仕様に無い図の行も、図を差し込んだあとの配る本文に残らない（書き直した世代と前の世代の論点）', async () => {
    ok(unlisted.before.run, '差し込む前の投入の組み立て')
    ok(unlisted.attach, '図の差し込み')
    ok(unlisted.run, '投入の組み立て')
    for (const id of [R1, P]) {
      expect((await linesOf(unlisted.before, id, BRACKET_STRAY)).length, `仕込み: 差し込む前の論点 ${id} の本文に図 ${BRACKET_STRAY} の行が無い`).toBe(1)
      expect(
        (await linesOf(unlisted.after, id, BRACKET_STRAY)).map(([sec, , line]) => `${sec}: ${line}`),
        `論点 ${id} の図の仕様に無い図 ${BRACKET_STRAY} の行`,
      ).toEqual([])
    }
  })

  // @covers REQ-470#previous-bracket-caption-placement-kept
  it('前の世代から選んだ論点の、図の説明文に角かっこを含む図の仕様にある図は、図を差し込んでも差し込む前の配る本文と同じ節に同じ数だけある', async () => {
    ok(unlisted.before.run, '差し込む前の投入の組み立て')
    ok(unlisted.attach, '図の差し込み')
    ok(unlisted.run, '投入の組み立て')
    const before = (await linesOf(unlisted.before, P, BRACKET_FIG)).map(([sec]) => sec)
    expect(before, '仕込み: 差し込む前の配る本文の置き方').toEqual([pHeading])
    expect((await linesOf(unlisted.after, P, BRACKET_FIG)).map(([sec]) => sec), `論点 ${P} の図 ${BRACKET_FIG} の置き方`).toEqual(before)
  })

  // @covers REQ-470#rewritten-bracket-caption-rerun-once
  it('書き直した世代から選んだ論点の、図の説明文に角かっこを含む図は、図の差し込みを 2 回かけても差し込み位置に 1 回だけある', async () => {
    ok(unlisted.attach, '図の差し込み')
    ok(unlisted.run, '投入の組み立て')
    ok(unlisted.attachAgain, '2 回目の図の差し込み')
    ok(unlisted.runAgain, '2 回目の投入の組み立て')
    const first = await linesOf(unlisted.after, R1, BRACKET_FIG)
    expect(first.map(([sec]) => sec), `論点 ${R1} の図 ${BRACKET_FIG} の置き場（1 回目）`).toEqual([rewrittenHeading(R1, '甲')])
    expect(first[0][2], '仕込み: 差し込んだ図の行の説明文に角かっこが無い').toContain('A[1]')
    expect(
      (await linesOf(unlisted.afterAgain, R1, BRACKET_FIG)).map(([sec]) => sec),
      `論点 ${R1} の図 ${BRACKET_FIG} の置き場（2 回目）`,
    ).toEqual([rewrittenHeading(R1, '甲')])
  })

  /* 行頭に空白のある図の行は、この describe の中の仕込みで自分で作る（上の仕込みとは別の図の id を使い、終わったら元に戻す）。
   *  書き直した世代の論点 R1: 図の仕様に、説明文に角かっこを含む図 INDENT_FIG（差し込み位置は見出し甲）を足し、書き直した世代の本文の
   *  見出し甲の節に、その図の行を行頭に半角の空白 2 つを付けて先に書いておく。
   *  前の世代の論点 IP: 図の仕様を図 INDENT_FIG 1 枚（差し込み位置は最初の見出し）に置き換え、v3 の本文の図の行を消してから、最初の見出しの節に
   *  その図の行を行頭に半角の空白 2 つを付けて書く。
   *  図の仕様に無い図の行: 画像だけを置いた図の行を、行頭の空白の種類（半角の空白・タブ・全角の空白）ごとに、R1 と IP の explanation と detail に書く。 */
  describe('行頭に空白のある図の行', () => {
    const INDENT_FIG = 97
    const INDENTS = [
      { name: '半角の空白', prefix: '  ', figId: 98 },
      { name: 'タブ', prefix: '\t', figId: 99 },
      { name: '全角の空白', prefix: '　', figId: 100 },
    ] as const
    const INDENT_CAPTION = '根を A[1] に置く図です。'
    let IP = 0
    let ipHeading = ''
    let indented: { before: { run: Run } & Loaded; attach: Run; run: Run; after: Loaded }
    const indentedLine = (prefix: string, id: number, figId: number, caption: string) =>
      `${prefix}![${caption}](/figures/materials/${ws.learning}/${id}-${figId}.svg)`
    const strayLines = (id: number) => INDENTS.map((k) => indentedLine(k.prefix, id, k.figId, '仕様に無い図'))

    beforeAll(async () => {
      const used = new Set([R1, R2, R3, Q1, Q2, Q3])
      IP = [...cat.term.keys()].find((id) => {
        if (used.has(id) || entriesOf(ws, REWRITTEN, id).length > 0 || entriesOf(ws, V3, id).length !== 1 || v3Headings(id).length === 0) return false
        const s = figureSpec(ws, id)
        return !!s && (s.figures as Json[]).some((f) => fs.existsSync(svgPath(ws, id, f.id)))
      })!
      if (!IP) throw new Error('仕込み: v3 の教材を 1 つだけ持ち、見出しと画像のある図を持つ前の世代の論点が無い')
      ipHeading = v3Headings(IP)[0].trim()
      const copied: string[] = []
      indented = await restoring(async () => {
        try {
          const spec = figureSpec(ws, IP)!
          const template = (spec.figures as Json[]).find((f) => fs.existsSync(svgPath(ws, IP, f.id)))!
          const templateSvg = svgPath(ws, IP, template.id)
          spec.figures = [{ ...template, id: INDENT_FIG, after: ipHeading, caption: INDENT_CAPTION }]
          ws.writeJson(figureFile(ws, IP), spec)
          const r1Spec = figureSpec(ws, R1)!
          const r1Template = (r1Spec.figures as Json[])[0]
          r1Spec.figures = [...(r1Spec.figures as Json[]), { ...r1Template, id: INDENT_FIG, after: rewrittenHeading(R1, '甲'), caption: INDENT_CAPTION }]
          ws.writeJson(figureFile(ws, R1), r1Spec)
          for (const figId of [INDENT_FIG, ...INDENTS.map((k) => k.figId)]) {
            for (const [id, src] of [
              [R1, svgPath(ws, R1, r1Template.id)],
              [IP, templateSvg],
            ] as const) {
              const dst = svgPath(ws, id, figId)
              fs.copyFileSync(src, dst)
              copied.push(dst)
            }
          }
          editEntries(ws, V3, IP, (m) => {
            m.explanation = `${mark(V3, IP)}\n\n${stripFigLines(m.explanation, IP)}\n\n${strayLines(IP).join('\n\n')}`
            m.detail = underHeading(stripFigLines(m.detail, IP), ipHeading, [
              indentedLine('  ', IP, INDENT_FIG, INDENT_CAPTION),
              ...strayLines(IP),
            ])
          })
          for (const [rel, body] of pristineBundles) {
            const copy = JSON.parse(JSON.stringify(body)) as Json
            for (const m of copy.materials as Json[]) {
              if (m.topic_id !== R1) continue
              m.explanation = `${m.explanation}\n\n${strayLines(R1).join('\n\n')}`
              m.detail = underHeading(m.detail, rewrittenHeading(R1, '甲'), [
                indentedLine('  ', R1, INDENT_FIG, INDENT_CAPTION),
                ...strayLines(R1),
              ])
            }
            ws.writeJson(rel, copy)
          }
          const base = buildSeed(ws)
          const before = { run: base, ...(await load(base)) }
          const attach = attachFigures(ws)
          const run = buildSeed(ws)
          return { before, attach, run, after: await load(run) }
        } finally {
          for (const f of copied) fs.rmSync(f, { force: true })
        }
      })
    })

    // @covers REQ-470#indented-unlisted-dropped
    it('行頭に空白（半角の空白・タブ・全角の空白）のある、図の仕様に無い図の行も、図を差し込んだあとの配る本文に残らない（書き直した世代と前の世代の論点）', async () => {
      ok(indented.before.run, '差し込む前の投入の組み立て')
      ok(indented.attach, '図の差し込み')
      ok(indented.run, '投入の組み立て')
      expect(bodyText(await detailIn(indented.after, R1)), `論点 ${R1} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, R1))
      expect(bodyText(await detailIn(indented.after, IP)), `論点 ${IP} が v3 の教材でない`).toContain(mark(V3, IP))
      const left: string[] = []
      for (const [id, heading] of [
        [R1, rewrittenHeading(R1, '甲')],
        [IP, ipHeading],
      ] as const) {
        for (const k of INDENTS) {
          expect(
            (await linesOf(indented.before, id, k.figId)).map(([sec]) => sec),
            `仕込み: 差し込む前の論点 ${id} の本文に行頭が${k.name}の図 ${k.figId} の行が無い`,
          ).toEqual(['explanation', heading])
          for (const [sec, , line] of await linesOf(indented.after, id, k.figId)) left.push(`論点 ${id}（行頭が${k.name}）${sec}: ${JSON.stringify(line)}`)
        }
      }
      expect(left, '図の仕様に無い図の行で残った物').toEqual([])
    })

    // @covers REQ-470#rewritten-indented-listed-once
    it('書き直した世代から選んだ論点の本文の差し込み位置に、図の仕様にある図の行が行頭に空白付きで既にあっても、図を差し込んだあと差し込み位置に 1 行だけある', async () => {
      ok(indented.before.run, '差し込む前の投入の組み立て')
      ok(indented.attach, '図の差し込み')
      ok(indented.run, '投入の組み立て')
      expect(
        (await linesOf(indented.before, R1, INDENT_FIG)).map(([sec]) => sec),
        `仕込み: 差し込む前の論点 ${R1} の本文の見出し甲の節に図 ${INDENT_FIG} の行が無い`,
      ).toEqual([rewrittenHeading(R1, '甲')])
      expect(
        (await linesOf(indented.after, R1, INDENT_FIG)).map(([sec]) => sec),
        `論点 ${R1} の図 ${INDENT_FIG} の行の置き場: ${JSON.stringify((await linesOf(indented.after, R1, INDENT_FIG)).map(([, , l]) => l))}`,
      ).toEqual([rewrittenHeading(R1, '甲')])
    })

    // @covers REQ-470#previous-indented-placement-kept
    it('前の世代から選んだ論点の、行頭に空白のある図の仕様にある図の行は、図を差し込んでも差し込む前の配る本文と同じ節に同じ数だけある', async () => {
      ok(indented.before.run, '差し込む前の投入の組み立て')
      ok(indented.attach, '図の差し込み')
      ok(indented.run, '投入の組み立て')
      const before = (await linesOf(indented.before, IP, INDENT_FIG)).map(([sec]) => sec)
      expect(before, '仕込み: 差し込む前の配る本文の置き方').toEqual([ipHeading])
      expect(
        (await linesOf(indented.after, IP, INDENT_FIG)).map(([sec]) => sec),
        `論点 ${IP} の図 ${INDENT_FIG} の置き方: ${JSON.stringify((await linesOf(indented.after, IP, INDENT_FIG)).map(([, , l]) => l))}`,
      ).toEqual(before)
    })
  })

  /* 指す先に制御文字を含む図の行は、この describe の中の仕込みで自分で作る（終わったら元に戻す）。
   *  画面は指す先の中の U+0085 と U+001C〜U+001F を空白と読まず、その行を図として出す（REQ-004）ので、その行は図の行。
   *  図の仕様に無い図の行: 字ごとに別の図の id で、指す先の途中にその字を入れた図の行を、R1 の書き直した世代の本文と CP の v3 の本文の
   *  explanation と detail（最初の見出しの節）に書き、その指す先に画像を置く。 */
  describe('指す先に制御文字を含む図の行', () => {
    const CONTROLS = [
      { name: 'U+0085', ch: '\u0085', figId: 101 },
      { name: 'U+001C', ch: '\u001c', figId: 102 },
      { name: 'U+001F', ch: '\u001f', figId: 103 },
    ] as const
    let CP = 0
    let cpHeading = ''
    let control: { before: { run: Run } & Loaded; attach: Run; run: Run; after: Loaded }
    const caption = (id: number, figId: number) => `仕様に無い制御文字の図${id}-${figId}`
    const ctrlRel = (id: number, figId: number, ch: string) => `${id}-${figId.toString().slice(0, 2)}${ch}${figId.toString().slice(2)}.svg`
    const ctrlLine = (id: number, figId: number, ch: string) =>
      `![${caption(id, figId)}](/figures/materials/${ws.learning}/${ctrlRel(id, figId, ch)})`
    const ctrlLines = (id: number) => CONTROLS.map((k) => ctrlLine(id, k.figId, k.ch))
    /** 本文の行のうち、その図の説明文か指す先を含む行を、置き場の節とともに返す（行が途中で切られても、残った片を拾う）。 */
    const ctrlLeft = (body: { explanation?: string | null; detail?: string | null }, id: number, figId: number, ch: string) => {
      const out: string[] = []
      const scan = (text: string | null | undefined, first: string) => {
        let section = first
        for (const line of String(text ?? '').split('\n')) {
          if (first !== 'explanation' && line.startsWith('### ')) section = line.trim()
          if (line.includes(caption(id, figId)) || line.includes(ctrlRel(id, figId, ch))) out.push(`${section}: ${JSON.stringify(line)}`)
        }
      }
      scan(body.explanation, 'explanation')
      scan(body.detail, 'detail の先頭')
      return out
    }

    beforeAll(async () => {
      const used = new Set([R1, R2, R3, Q1, Q2, Q3])
      CP = [...cat.term.keys()].find((id) => {
        if (used.has(id) || entriesOf(ws, REWRITTEN, id).length > 0 || entriesOf(ws, V3, id).length !== 1 || v3Headings(id).length === 0) return false
        const s = figureSpec(ws, id)
        return !!s && (s.figures as Json[]).some((f) => fs.existsSync(svgPath(ws, id, f.id)))
      })!
      if (!CP) throw new Error('仕込み: v3 の教材を 1 つだけ持ち、見出しと画像のある図を持つ前の世代の論点が無い')
      cpHeading = v3Headings(CP)[0].trim()
      const copied: string[] = []
      control = await restoring(async () => {
        try {
          for (const id of [R1, CP]) {
            const template = (figureSpec(ws, id)!.figures as Json[]).find((f) => fs.existsSync(svgPath(ws, id, f.id)))!
            for (const k of CONTROLS) {
              const dst = ws.abs(`public/figures/materials/${ws.learning}/${ctrlRel(id, k.figId, k.ch)}`)
              fs.copyFileSync(svgPath(ws, id, template.id), dst)
              copied.push(dst)
            }
          }
          editEntries(ws, V3, CP, (m) => {
            m.explanation = `${mark(V3, CP)}\n\n${m.explanation ?? ''}\n\n${ctrlLines(CP).join('\n\n')}`
            m.detail = underHeading(String(m.detail ?? ''), cpHeading, ctrlLines(CP))
          })
          for (const [rel, body] of pristineBundles) {
            const copy = JSON.parse(JSON.stringify(body)) as Json
            for (const m of copy.materials as Json[]) {
              if (m.topic_id !== R1) continue
              m.explanation = `${m.explanation}\n\n${ctrlLines(R1).join('\n\n')}`
              m.detail = underHeading(m.detail, rewrittenHeading(R1, '甲'), ctrlLines(R1))
            }
            ws.writeJson(rel, copy)
          }
          const base = buildSeed(ws)
          const before = { run: base, ...(await load(base)) }
          const attach = attachFigures(ws)
          const run = buildSeed(ws)
          return { before, attach, run, after: await load(run) }
        } finally {
          for (const f of copied) fs.rmSync(f, { force: true })
        }
      })
    })

    // @covers REQ-470#src-control-char-unlisted-dropped
    it('指す先の途中に U+0085 か U+001C〜U+001F を含む、図の仕様に無い図の行も、図を差し込んだあとの配る本文に残らない（書き直した世代と前の世代の論点）', async () => {
      ok(control.before.run, '差し込む前の投入の組み立て')
      ok(control.attach, '図の差し込み')
      ok(control.run, '投入の組み立て')
      expect(bodyText(await detailIn(control.after, R1)), `論点 ${R1} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, R1))
      expect(bodyText(await detailIn(control.after, CP)), `論点 ${CP} が v3 の教材でない`).toContain(mark(V3, CP))
      const left: string[] = []
      for (const [id, heading] of [
        [R1, rewrittenHeading(R1, '甲')],
        [CP, cpHeading],
      ] as const) {
        for (const k of CONTROLS) {
          expect(
            ctrlLeft(await detailIn(control.before, id), id, k.figId, k.ch),
            `仕込み: 差し込む前の論点 ${id} の本文に指す先が${k.name}を含む図 ${k.figId} の行が無い`,
          ).toEqual([`explanation: ${JSON.stringify(ctrlLine(id, k.figId, k.ch))}`, `${heading}: ${JSON.stringify(ctrlLine(id, k.figId, k.ch))}`])
          for (const l of ctrlLeft(await detailIn(control.after, id), id, k.figId, k.ch)) left.push(`論点 ${id}（${k.name}）${l}`)
        }
      }
      expect(left, '図の仕様に無い図の行で残った物').toEqual([])
    })
  })

  /* 図の仕様のファイルが無い論点の図の行は、この describe の中の仕込みで自分で作る（終わったら元に戻す）。
   *  書き直した世代の論点 R3 と、v3 の教材を 1 つだけ持つ前の世代の論点 NP の図の仕様のファイルを消し、画像だけを置いた図の行を
   *  explanation の末尾（NOFILE_FIGS の 1 枚目）と最初の見出しの節（2 枚目）に書く。 */
  describe('図の仕様のファイルが無い論点の図の行', () => {
    const NOFILE_FIGS = [141, 142] as const
    let NP = 0
    let npHeading = ''
    let nofile: { before: { run: Run } & Loaded; attach: Run; run: Run; after: Loaded }

    beforeAll(async () => {
      const used = new Set([R1, R2, R3, Q1, Q2, Q3])
      NP = [...cat.term.keys()].find(
        (id) => !used.has(id) && entriesOf(ws, REWRITTEN, id).length === 0 && entriesOf(ws, V3, id).length === 1 && v3Headings(id).length > 0,
      )!
      if (!NP) throw new Error('仕込み: v3 の教材を 1 つだけ持ち、見出しのある前の世代の論点が無い')
      npHeading = v3Headings(NP)[0].trim()
      const srcSvg = svgPath(ws, R1, (figureSpec(ws, R1)!.figures as Json[])[0].id)
      const copied: string[] = []
      nofile = await restoring(async () => {
        try {
          for (const id of [R3, NP]) {
            ws.remove(figureFile(ws, id))
            for (const figId of NOFILE_FIGS) {
              const dst = svgPath(ws, id, figId)
              if (fs.existsSync(dst)) continue
              fs.copyFileSync(srcSvg, dst)
              copied.push(dst)
            }
          }
          editEntries(ws, V3, NP, (m) => {
            m.explanation = `${mark(V3, NP)}\n\n${stripFigLines(m.explanation, NP)}\n\n${figLine(NP, NOFILE_FIGS[0])}`
            m.detail = underHeading(stripFigLines(m.detail, NP), npHeading, [figLine(NP, NOFILE_FIGS[1])])
          })
          for (const [rel, body] of pristineBundles) {
            const copy = JSON.parse(JSON.stringify(body)) as Json
            for (const m of copy.materials as Json[]) {
              if (m.topic_id !== R3) continue
              m.explanation = `${m.explanation}\n\n${figLine(R3, NOFILE_FIGS[0])}`
              m.detail = underHeading(m.detail, rewrittenHeading(R3, '甲'), [figLine(R3, NOFILE_FIGS[1])])
            }
            ws.writeJson(rel, copy)
          }
          const base = buildSeed(ws)
          const before = { run: base, ...(await load(base)) }
          const attach = attachFigures(ws)
          const run = buildSeed(ws)
          return { before, attach, run, after: await load(run) }
        } finally {
          for (const f of copied) fs.rmSync(f, { force: true })
        }
      })
    })

    // @covers REQ-470#no-spec-file-unlisted-dropped
    it('図の仕様のファイルが無い論点の本文にある図の行は、書き直した世代の論点でも前の世代の論点でも、図を差し込んだあとの配る本文の explanation にも detail にも残らない', async () => {
      ok(nofile.before.run, '差し込む前の投入の組み立て')
      ok(nofile.attach, '図の差し込み')
      ok(nofile.run, '投入の組み立て')
      expect(bodyText(await detailIn(nofile.after, R3)), `論点 ${R3} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, R3))
      expect(bodyText(await detailIn(nofile.after, NP)), `論点 ${NP} が v3 の教材でない`).toContain(mark(V3, NP))
      const left: string[] = []
      for (const [id, heading] of [
        [R3, rewrittenHeading(R3, '甲')],
        [NP, npHeading],
      ] as const) {
        expect(
          (await placementOf(nofile.before, id, NOFILE_FIGS)).map(([sec]) => sec),
          `仕込み: 差し込む前の論点 ${id} の本文に図の仕様のファイルに無い図の行が無い`,
        ).toEqual(['explanation', heading])
        for (const [sec, p] of await placementOf(nofile.after, id, NOFILE_FIGS)) left.push(`論点 ${id} ${sec}: ${p}`)
      }
      expect(left, '図の仕様のファイルが無い論点で残った図の行').toEqual([])
    })
  })

  /* 置き場の中の位置と並びは、この describe の中の仕込みで自分で作る（図の id は 111〜132。終わったら元に戻す）。
   *  書き直した世代の本文は、短い説明（explanation）が本文 3 段落、詳しい解説（detail）が見出し甲の節（2 段落と箇条。後に見出し乙がある）と
   *  見出し乙の節（2 段落。後に見出しが無い）。空行は画面に出ないので、行の並びは空でない行で読む。
   *  新しく差し込む論点 F: 図の行の無い本文に、図の仕様の 9 枚（F_SPEC。置き場ごとに 3 枚で、並びは id の昇順・降順のどちらとも違う）を差し込む。
   *  既に図の行がある論点 E: 図の仕様の 13 枚（E_SPEC）の図の行を、差し込む前の本文の、決まった置き場でない所に書いておく
   *  （差し込み位置の中の末尾でない所に 121・122、別の置き場に 123〜125、差し込み位置の末尾に図の仕様とも id の昇順・降順とも違う並びで
   *  explanation に 128・120・129 と見出し乙に 126・130・127、図の仕様と違う説明文の行で 131、同じ行を 2 行で 132）。 */
  describe('置き場の中の位置と、同じ差し込み位置の図の並び', () => {
    type Place = 'explanation' | '甲' | '乙'
    const F_SPEC: readonly (readonly [number, Place])[] = [
      [113, '甲'],
      [115, 'explanation'],
      [117, '乙'],
      [112, '甲'],
      [114, 'explanation'],
      [111, '乙'],
      [116, '甲'],
      [118, 'explanation'],
      [119, '乙'],
    ]
    const E_SPEC: readonly (readonly [number, Place])[] = [
      [124, '甲'],
      [121, '甲'],
      [123, '乙'],
      [122, 'explanation'],
      [127, '乙'],
      [125, 'explanation'],
      [129, 'explanation'],
      [130, '乙'],
      [120, 'explanation'],
      [126, '乙'],
      [128, 'explanation'],
      [131, 'explanation'],
      [132, '甲'],
    ]
    /** 図の仕様と違う説明文で既にある図と、同じ行が 2 行既にある図。 */
    const STALE_FIG = 131
    const DUP_FIG = 132
    let F = 0
    let E = 0
    let placed: {
      before: { run: Run } & Loaded
      attach: Run
      run: Run
      after: Loaded
      attachAgain: Run
      runAgain: Run
      afterAgain: Loaded
    }
    const sectionOf = (id: number, place: Place) => (place === 'explanation' ? 'explanation' : rewrittenHeading(id, place))
    /** 図の仕様で、その置き場を差し込み位置にする図を、図の仕様に並ぶ順に。 */
    const specOrder = (spec: typeof F_SPEC, place: Place) => spec.filter(([, p]) => p === place).map(([figId]) => `図${figId}`)
    const sorted = (kinds: string[]) => [...kinds].sort()

    type Layout = [section: string, kind: string][]
    /** 本文の空でない行を、見出しの行を除いて、置き場（explanation か直前の見出し）と種類（その論点の図の行は「図<id>」、ほかは「本文」）で上から並べる。 */
    const layoutOf = (body: { explanation?: string | null; detail?: string | null }, id: number): Layout => {
      const out: Layout = []
      const fig = new RegExp(`^\\s*!\\[.*\\]\\(/figures/materials/${ws.learning}/${id}-(\\d+)\\.svg\\)\\s*$`)
      const scan = (text: string | null | undefined, first: string) => {
        let section = first
        for (const line of String(text ?? '').split('\n')) {
          if (!line.trim()) continue
          if (first !== 'explanation' && line.startsWith('### ')) {
            section = line.trim()
            continue
          }
          const m = fig.exec(line)
          out.push([section, m ? `図${m[1]}` : '本文'])
        }
      }
      scan(body.explanation, 'explanation')
      scan(body.detail, 'detail の先頭')
      return out
    }
    const layoutIn = async (s: Loaded, id: number) => layoutOf(await detailIn(s, id), id)
    const kindsIn = (layout: Layout, section: string) => layout.filter(([sec]) => sec === section).map(([, kind]) => kind)
    const figsIn = (layout: Layout, section: string) => kindsIn(layout, section).filter((k) => k !== '本文')
    const sectionsOf = (layout: Layout, figId: number) => layout.filter(([, kind]) => kind === `図${figId}`).map(([sec]) => sec)
    /** その置き場が、本文の行（1 行以上）のあと、図の仕様でそこを差し込み位置にする図の行だけ（1 枚につき 1 行。並びは問わない）で終わる。 */
    const expectFiguresAtEnd = (layout: Layout, id: number, spec: typeof F_SPEC, place: Place) => {
      const kinds = kindsIn(layout, sectionOf(id, place))
      const want = sorted(specOrder(spec, place))
      const seen = `論点 ${id} の ${sectionOf(id, place)} の行の並び: ${kinds.join(' → ')}`
      expect(sorted(kinds.filter((k) => k !== '本文')), `図の行が 1 枚につき 1 行でない。${seen}`).toEqual(want)
      expect(kinds.length, `仕込み: 置き場に本文の行が無い。${seen}`).toBeGreaterThan(want.length)
      expect(sorted(kinds.slice(kinds.length - want.length)), `置き場の末尾が図の行でない（図の行のあとに本文の行がある）。${seen}`).toEqual(want)
    }

    beforeAll(async () => {
      F = R2
      E = R1
      const copied: string[] = []
      placed = await restoring(async () => {
        try {
          for (const [id, entries] of [
            [F, F_SPEC],
            [E, E_SPEC],
          ] as const) {
            const spec = figureSpec(ws, id)!
            const template = (spec.figures as Json[])[0]
            const templateSvg = svgPath(ws, id, template.id)
            spec.figures = entries.map(([figId, place]) => ({ ...template, id: figId, after: sectionOf(id, place), caption: `図${figId}の説明です。` }))
            ws.writeJson(figureFile(ws, id), spec)
            for (const [figId] of entries) {
              const dst = svgPath(ws, id, figId)
              fs.copyFileSync(templateSvg, dst)
              copied.push(dst)
            }
          }
          const staleLine = `![図${STALE_FIG}の古い説明です。](/figures/materials/${ws.learning}/${E}-${STALE_FIG}.svg)`
          for (const [rel, body] of pristineBundles) {
            const copy = JSON.parse(JSON.stringify(body)) as Json
            for (const m of copy.materials as Json[]) {
              if (m.topic_id !== F && m.topic_id !== E) continue
              const headA = rewrittenHeading(m.topic_id, '甲')
              const headB = rewrittenHeading(m.topic_id, '乙')
              const a1 = '書き直した詳しい説明の甲の一段目です。'
              const a2 = '書き直した詳しい説明の甲の二段目です。'
              const a3 = '- 書き直した甲の箇条です'
              const b1 = '書き直した詳しい説明の乙の一段目です。'
              const b2 = '書き直した詳しい説明の乙の二段目です。'
              if (m.topic_id === F) {
                m.detail = [headA, a1, '', a2, '', a3, '', headB, b1, '', b2].join('\n')
                continue
              }
              const [first, second, third] = String(m.explanation).split('\n\n')
              m.explanation = [first, figLine(E, 122), second, staleLine, third, figLine(E, 124), figLine(E, 128), figLine(E, 120), figLine(E, 129)].join('\n\n')
              m.detail = [
                headA,
                figLine(E, 121),
                '',
                a1,
                '',
                figLine(E, DUP_FIG),
                '',
                a2,
                '',
                a3,
                '',
                figLine(E, DUP_FIG),
                '',
                figLine(E, 123),
                '',
                headB,
                b1,
                '',
                b2,
                '',
                figLine(E, 125),
                '',
                figLine(E, 126),
                '',
                figLine(E, 130),
                '',
                figLine(E, 127),
              ].join('\n')
            }
            ws.writeJson(rel, copy)
          }
          const base = buildSeed(ws)
          const before = { run: base, ...(await load(base)) }
          const attach = attachFigures(ws)
          const run = buildSeed(ws)
          const after = await load(run)
          const attachAgain = attachFigures(ws)
          const runAgain = buildSeed(ws)
          return { before, attach, run, after, attachAgain, runAgain, afterAgain: await load(runAgain) }
        } finally {
          for (const f of copied) fs.rmSync(f, { force: true })
        }
      })
    })

    const okFirst = () => {
      ok(placed.before.run, '差し込む前の投入の組み立て')
      ok(placed.attach, '図の差し込み')
      ok(placed.run, '投入の組み立て')
    }
    /** 差し込む前の配る本文の論点 E の行の並び（仕込みが書いたとおりか）。 */
    const expectMisplacedBefore = async () => {
      const before = await layoutIn(placed.before, E)
      expect(bodyText(await detailIn(placed.before, E)), `仕込み: 論点 ${E} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, E))
      expect(kindsIn(before, 'explanation'), '仕込み: 差し込む前の explanation の行の並び').toEqual([
        '本文',
        '図122',
        '本文',
        '図131',
        '本文',
        '図124',
        '図128',
        '図120',
        '図129',
      ])
      expect(kindsIn(before, sectionOf(E, '甲')), '仕込み: 差し込む前の見出し甲の節の行の並び').toEqual(['図121', '本文', '図132', '本文', '本文', '図132', '図123'])
      expect(kindsIn(before, sectionOf(E, '乙')), '仕込み: 差し込む前の見出し乙の節の行の並び').toEqual(['本文', '本文', '図125', '図126', '図130', '図127'])
    }

    // @covers REQ-470#rewritten-explanation-end
    it('書き直した世代から選んだ論点の、差し込み位置が短い説明の図の行は、短い説明（explanation）の本文の行のあと、末尾にある', async () => {
      okFirst()
      const t = await detailIn(placed.after, F)
      expect(bodyText(t), `論点 ${F} が書き直した世代の教材でない`).toContain(mark(REWRITTEN, F))
      expectFiguresAtEnd(layoutOf(t, F), F, F_SPEC, 'explanation')
    })

    // @covers REQ-470#rewritten-heading-end-before-next-heading
    it('書き直した世代から選んだ論点の、差し込み位置が見出しで、その節に本文があり後に見出しがある図の行は、節の本文の行のあと、次の見出しの行の直前にある', async () => {
      okFirst()
      const t = await detailIn(placed.after, F)
      const heads = headingsOf(t.detail).map((h) => h.trim())
      expect(heads, '仕込み: 見出し甲の後に見出し乙が無い').toEqual([sectionOf(F, '甲'), sectionOf(F, '乙')])
      expectFiguresAtEnd(layoutOf(t, F), F, F_SPEC, '甲')
    })

    // @covers REQ-470#rewritten-heading-end-of-detail
    it('書き直した世代から選んだ論点の、差し込み位置が見出しで、その節に本文があり後に見出しが無い図の行は、詳しい解説（detail）の末尾にある', async () => {
      okFirst()
      const t = await detailIn(placed.after, F)
      const heads = headingsOf(t.detail).map((h) => h.trim())
      expect(heads[heads.length - 1], '仕込み: 見出し乙が最後の見出しでない').toBe(sectionOf(F, '乙'))
      expectFiguresAtEnd(layoutOf(t, F), F, F_SPEC, '乙')
    })

    // @covers REQ-470#rewritten-same-explanation-spec-order
    it('書き直した世代から選んだ論点の、差し込み位置が短い説明の図が 3 枚あれば、図の行は図の仕様に並ぶ順（id の順でも逆の順でもない）に上から並ぶ', async () => {
      okFirst()
      const layout = await layoutIn(placed.after, F)
      expect(figsIn(layout, 'explanation'), `論点 ${F} の explanation の図の行の並び`).toEqual(specOrder(F_SPEC, 'explanation'))
    })

    // @covers REQ-470#rewritten-same-heading-spec-order
    it('書き直した世代から選んだ論点の、同じ見出しを差し込み位置にする図が 3 枚あれば、図の行は節ごとに図の仕様に並ぶ順（id の順でも逆の順でもない）に上から並ぶ', async () => {
      okFirst()
      const layout = await layoutIn(placed.after, F)
      for (const place of ['甲', '乙'] as const)
        expect(figsIn(layout, sectionOf(F, place)), `論点 ${F} の見出し${place}の節の図の行の並び`).toEqual(specOrder(F_SPEC, place))
    })

    // @covers REQ-470#rewritten-existing-line-not-at-end
    it('書き直した世代から選んだ論点の本文の、差し込み位置の中の末尾でない所（見出しの行の直後・短い説明の途中）に図の仕様にある図の行が既にあっても、差し込んだあとは置き場の本文の行のあとに 1 行だけある', async () => {
      okFirst()
      await expectMisplacedBefore()
      const after = await layoutIn(placed.after, E)
      for (const [figId, place] of [
        [121, '甲'],
        [122, 'explanation'],
      ] as const) {
        const section = sectionOf(E, place)
        const kinds = kindsIn(after, section)
        expect(sectionsOf(after, figId), `論点 ${E} の図 ${figId} の行の置き場`).toEqual([section])
        expect(
          kinds.lastIndexOf('本文'),
          `論点 ${E} の図 ${figId} の行のあとに本文の行がある。${section} の行の並び: ${kinds.join(' → ')}`,
        ).toBeLessThan(kinds.indexOf(`図${figId}`))
      }
    })

    // @covers REQ-470#rewritten-existing-line-in-other-place
    it('書き直した世代から選んだ論点の本文の、差し込み位置と別の置き場（別の見出しの節・短い説明・詳しい解説）に図の仕様にある図の行が既にあっても、差し込んだあとは差し込み位置にだけ 1 行ある', async () => {
      okFirst()
      await expectMisplacedBefore()
      const after = await layoutIn(placed.after, E)
      for (const [figId, place] of [
        [123, '乙'],
        [124, '甲'],
        [125, 'explanation'],
      ] as const)
        expect(sectionsOf(after, figId), `論点 ${E} の図 ${figId} の行の置き場`).toEqual([sectionOf(E, place)])
    })

    // @covers REQ-470#rewritten-existing-lines-in-other-order
    it('書き直した世代から選んだ論点の本文の差し込み位置の末尾に、図の仕様にある図の行が図の仕様とも id の順・逆の順とも違う並びで既にあっても、差し込んだあとは図の仕様に並ぶ順に上から並ぶ', async () => {
      okFirst()
      await expectMisplacedBefore()
      const after = await layoutIn(placed.after, E)
      const only = (kinds: string[], figIds: number[]) => kinds.filter((k) => figIds.some((f) => k === `図${f}`))
      expect(only(figsIn(after, sectionOf(E, '乙')), [126, 127, 130]), `論点 ${E} の見出し乙の節の図 126・127・130 の行の並び`).toEqual([
        '図127',
        '図130',
        '図126',
      ])
      expect(only(figsIn(after, 'explanation'), [120, 128, 129]), `論点 ${E} の explanation の図 120・128・129 の行の並び`).toEqual([
        '図129',
        '図120',
        '図128',
      ])
    })

    // @covers REQ-470#rewritten-existing-line-stale-caption
    it('書き直した世代から選んだ論点の本文に、図の仕様にある図の行が図の仕様と違う説明文で既にあっても、差し込んだあとその図の行は差し込み位置に 1 行だけある', async () => {
      okFirst()
      await expectMisplacedBefore()
      expect(
        (await detailIn(placed.before, E)).explanation,
        `仕込み: 差し込む前の論点 ${E} の本文に図 ${STALE_FIG} の古い説明文の行が無い`,
      ).toContain(`図${STALE_FIG}の古い説明です。`)
      const after = await layoutIn(placed.after, E)
      expect(sectionsOf(after, STALE_FIG), `論点 ${E} の図 ${STALE_FIG} の行の置き場: ${kindsIn(after, 'explanation').join(' → ')}`).toEqual(['explanation'])
    })

    // @covers REQ-470#rewritten-existing-line-duplicated
    it('書き直した世代から選んだ論点の本文に、図の仕様にある同じ図の行が 2 行既にあっても、差し込んだあとその図の行は差し込み位置に 1 行だけある', async () => {
      okFirst()
      await expectMisplacedBefore()
      const after = await layoutIn(placed.after, E)
      expect(
        sectionsOf(after, DUP_FIG),
        `論点 ${E} の図 ${DUP_FIG} の行の置き場: ${kindsIn(after, sectionOf(E, '甲')).join(' → ')}`,
      ).toEqual([sectionOf(E, '甲')])
    })

    // @covers REQ-470#rerun-same-placement
    it('図の差し込みをもう一度かけても、書き直した世代の論点の本文の行の並び（置き場ごとの本文の行と図の行の順）は 1 回目と同じ', async () => {
      okFirst()
      ok(placed.attachAgain, '2 回目の図の差し込み')
      ok(placed.runAgain, '2 回目の投入の組み立て')
      for (const [id, spec] of [
        [F, F_SPEC],
        [E, E_SPEC],
      ] as const) {
        const first = await layoutIn(placed.after, id)
        expect(sorted(first.map(([, kind]) => kind).filter((k) => k !== '本文')), `論点 ${id}: 1 回目に図の仕様の図が 1 枚につき 1 行でない`).toEqual(
          sorted(spec.map(([figId]) => `図${figId}`)),
        )
        expect(await layoutIn(placed.afterAgain, id), `論点 ${id} の 2 回目の行の並び`).toEqual(first)
      }
    })
  })
})

/* ---------- REQ-471 ---------- */

describe('差し込み位置の確認・図の差し込み・描画の検査は配る本文と同じ選び方で世代を選ぶ（UC-027）', () => {
  /** 図の仕様の 1 枚の差し込み位置を書き換えて確かめる。 */
  async function checkWithAfter(id: number, after: string) {
    return restoring(() => {
      const spec = figureSpec(ws, id)!
      const target = (spec.figures as Json[])[spec.figures.length > 1 ? 1 : 0]
      target.after = after
      ws.writeJson(figureFile(ws, id), spec)
      return { run: checkFigureSpecs(ws, [id]), figId: target.id as number }
    })
  }
  const findingsText = (r: Run) => ((resultOf(r)?.findings as string[] | undefined) ?? [r.out]).join('\n')

  // @covers REQ-471#check-rewritten-heading-found
  it('書き直した世代から選ぶ論点で、差し込み位置が書き直した世代にだけある見出しなら、差し込み位置の確認は通す', async () => {
    const r = await checkWithAfter(R1, rewrittenHeading(R1, '乙'))
    expect(r.run.status, r.run.out).toBe(0)
  })

  // @covers REQ-471#check-superseded-heading-missing
  it('書き直した世代から選ぶ論点で、差し込み位置が置き換わった前の世代にだけある見出しなら、門の表の文言でその図と見出しを挙げてエラーにする', async () => {
    const heading = previousHeadings.get(R1)!.find((h) => h !== rewrittenHeading(R1, '甲') && h !== rewrittenHeading(R1, '乙'))!
    expect(heading, '仕込み: 前の世代の見出しが無い').toBeTruthy()
    const r = await checkWithAfter(R1, heading)
    expect(r.run.status, `通してしまった:\n${r.run.out}`).toBe(1)
    expect(findingsText(r.run)).toContain(`${where(R1, r.figId)}: after '${heading}' が教材に無い`)
  })

  // @covers REQ-471#check-previous-heading-found
  it('書き直した世代に教材が無い論点で、差し込み位置が前の世代の最も新しい教材にある見出しなら、差し込み位置の確認は通す', async () => {
    const r = await checkWithAfter(Q1, v3Headings(Q1)[0])
    expect(r.run.status, r.run.out).toBe(0)
  })

  // @covers REQ-471#attach-into-delivered-generation
  it('図の差し込みは、書き直した世代から選ぶ論点の図を、配る本文になる書き直した世代の教材に入れ、選んだ世代ごとの論点の数を返す', async () => {
    ok(assembled.attach, '図の差し込み')
    ok(assembled.run, '投入の組み立て')
    expect(resultOf(assembled.attach)?.topicsByGeneration?.[REWRITTEN], '書き直した世代から選んだ論点の数').toBe(3)
    for (const id of [R1, R2]) {
      const t = await detailIn(assembled, id)
      expect(bodyText(t)).toContain(mark(REWRITTEN, id))
      const placed = placement(t)
      for (const fig of rewrittenFigs.get(id)!)
        expect(placed.filter(([, p]) => isFigure(p, id, fig.id)).length, `論点 ${id} の図 ${fig.id} が配る本文に無い`).toBe(1)
    }
  })

  /** 論点の、その世代の教材の detail の末尾に、実在しない画像を指す図の行を足して描画の検査をかける。 */
  const renderWithMissingImage = (id: number, gen: string) =>
    restoring(() => {
      editEntries(ws, gen, id, (m) => {
        m.detail = `${m.detail}\n\n![実在しない図です。](/figures/materials/${ws.learning}/${id}-999.svg)`
      })
      return checkRender(ws)
    })

  // @covers REQ-471#render-checks-delivered-generation
  it('実データの描画の検査は、書き直した世代から選ぶ論点では書き直した世代の教材を描き、その誤りで落ちる', async () => {
    const r = await renderWithMissingImage(R1, REWRITTEN)
    expect(r.status, `書き直した世代の誤りを見逃した:\n${r.out}`).toBe(1)
    expect(r.out, '落ちた理由がその論点の実在しない図でない').toContain(`${R1}-999`)
  })

  // @covers REQ-471#render-skips-superseded-generation
  it('実データの描画の検査は、書き直した世代に置き換わった前の世代の教材を描かず、その誤りでは落ちない', async () => {
    const r = await renderWithMissingImage(R1, V3)
    expect(r.status, `配らない前の世代の教材で落ちた:\n${r.out}`).toBe(0)
    expect(resultOf(r)?.topicsByGeneration?.[REWRITTEN], '書き直した世代から選んだ論点の数').toBe(3)
  })
})

/* ---------- REQ-472 ---------- */

describe('単元の構成が 1 つも無いあいだは、投入で単元の構成を持つ表に触れない（UC-027）', () => {
  // @covers REQ-472#no-rows-inserted
  it('単元の構成が 1 つも無い学びの投入を空の DB に流すと、単元の構成を持つ表はどれも空のまま', () => {
    ok(baseline.run, '投入の組み立て')
    const d1 = d1Of(baseline)
    for (const table of UNIT_TABLES) expect(rows(d1, `SELECT COUNT(*) AS n FROM ${table}`), table).toEqual([{ n: 0 }])
  })

  // @covers REQ-472#existing-rows-kept
  it('単元の構成が 1 つも無い学びの投入を、単元の構成の行を持つ DB に流しても、その行は消えも増えもしない', async () => {
    const d1 = await loadSeed(sqlOf(assembled))
    const before = unitRows(d1)
    expect(before.unit_plans.length, '仕込み: DB に単元の構成の行が無い').toBeGreaterThan(0)
    applySeed(d1, sqlOf(baseline))
    expect(unitRows(d1)).toEqual(before)
  })

  // @covers REQ-472#rows-of-removed-topic-go
  it('単元の構成が 1 つも無く論点を 1 つ減らした学びの投入を、単元の構成の行を持つ DB に流すと、減った論点に結ばれた行（まとまりへの所属・前提）だけが無くなり、他の行は残る', async () => {
    const d1 = await loadSeed(sqlOf(assembled))
    const before = unitRows(d1)
    // 学ぶ順で 1 番目の論点は、まとまりに属し、3 番目と 4 番目の論点の前提でもある
    const gone = learningOrder(planA)[0]
    const linked = (r: Json) => r.topic_id === gone || r.prerequisite_topic_id === gone
    expect(before.unit_group_topics.filter(linked).length, '仕込み: 減らす論点がまとまりに属していない').toBe(1)
    expect(before.topic_prerequisites.filter(linked).length, '仕込み: 減らす論点が前提に無い').toBeGreaterThan(0)
    const topicsRel = `${ws.data}/topics.json`
    const topicsBody = ws.readText(topicsRel)
    const next = await restoring(() => {
      try {
        ws.remove(`${ws.data}/unit_plans`)
        const t = JSON.parse(topicsBody)
        t.topics = (t.topics as Json[]).filter((x) => x.id !== gone)
        t.topic_count = t.topics.length
        ws.writeJson(topicsRel, t)
        for (const g of [...PREVIOUS, REWRITTEN]) editEntries(ws, g, gone, () => 'remove')
        ws.remove(figureFile(ws, gone))
        const r = buildSeed(ws)
        return { r, sql: r.status === 0 ? ws.readText(SEED(ws)) : '' }
      } finally {
        ws.writeText(topicsRel, topicsBody)
      }
    })
    ok(next.r, '単元の構成が無く論点を減らした投入の組み立て')
    applySeed(d1, next.sql)
    expect(rows(d1, `SELECT id FROM topics WHERE id = ${gone}`), '仕込み: 論点が投入で消えていない').toEqual([])
    expect(unitRows(d1)).toEqual({
      unit_plans: before.unit_plans,
      unit_groups: before.unit_groups,
      unit_group_topics: before.unit_group_topics.filter((r) => !linked(r)),
      topic_prerequisites: before.topic_prerequisites.filter((r) => !linked(r)),
    })
  })
})

/* ---------- REQ-487 ---------- */

describe('登録簿に無い学びか置き場の無い学びは、何も書き出さずに断る（UC-027）', () => {
  const SENTINEL = '-- 前の投入\n'
  let zz: Ws
  beforeAll(() => {
    zz = makeWorkspace(LEARNING, 'zzz')
    zz.writeText(`${zz.data}/seed.sql`, SENTINEL)
  })

  // @covers REQ-487#build-unregistered
  it('登録簿に無い学びの投入の組み立ては INVALID_INPUT で断り、投入を書き出さない', () => {
    expectRefused(buildSeed(zz), 'INVALID_INPUT', '投入の組み立て')
    expect(zz.readText(`${zz.data}/seed.sql`)).toBe(SENTINEL)
  })

  // @covers REQ-487#build-unregistered-with-exam-name
  it('試験名と書き出し先を別に渡しても、登録簿に無い学びの投入の組み立ては INVALID_INPUT で断り、どこにも書き出さない', () => {
    expectRefused(buildSeed(zz, zz.data, ['--exam-name', '架空の試験', '--out', 'out/seed.sql']), 'INVALID_INPUT', '試験名つきの組み立て')
    expect(fs.existsSync(zz.abs('out/seed.sql')), '書き出し先に投入ができた').toBe(false)
    expect(zz.readText(`${zz.data}/seed.sql`)).toBe(SENTINEL)
  })

  // @covers REQ-487#render-unregistered
  it('登録簿に無い学びの実データの描画の検査は INVALID_INPUT で断る', () => {
    expectRefused(checkRender(zz, 'zzz'), 'INVALID_INPUT', '描画の検査')
  })

  // @covers REQ-487#verify-unregistered
  it('登録簿に無い学びの投入後の突き合わせは INVALID_INPUT で断る', () => {
    const db = seededDbFile(zz, 'empty')
    expectRefused(verifySeed(zz, 'zzz', db), 'INVALID_INPUT', '投入後の突き合わせ')
  })

  // @covers REQ-487#attach-no-place
  it('学びの置き場が無い学びの図の差し込みは NOT_FOUND で断り、置き場を作らない', () => {
    expectRefused(attachFigures(zz, [], 'data/zyx'), 'NOT_FOUND', '図の差し込み')
    expect(fs.existsSync(zz.abs('data/zyx')), '置き場ができた').toBe(false)
  })

  // @covers REQ-487#check-specs-no-place
  it('学びの置き場が無い学びの図の仕様の検査は NOT_FOUND で断る', () => {
    expectRefused(checkFigureSpecs(zz, [], 'data/zyx'), 'NOT_FOUND', '図の仕様の検査')
    expect(fs.existsSync(zz.abs('data/zyx')), '置き場ができた').toBe(false)
  })
})

/* ---------- REQ-488 ---------- */

describe('置けない図は差し込まず、論点と図と理由を問題として示して失敗で終える（UC-027）', () => {
  /** 書き直した世代の束を図を差し込む前の中身に戻し、edit を当ててから --only の論点だけに図を差し込む。 */
  const attachAfter = (id: number, edit: () => void) =>
    restoring(() => {
      for (const [rel, body] of pristineBundles) ws.writeJson(rel, body)
      edit()
      const run = attachFigures(ws, ['--only', String(id)])
      const gen = entriesOf(ws, REWRITTEN, id).length ? REWRITTEN : V3
      return { run, placed: entriesOf(ws, gen, id).flatMap((m) => placement(m)) }
    })
  const problemsOf = (r: Run) => (resultOf(r)?.problems as string[] | undefined) ?? []

  // @covers REQ-488#image-missing
  it('図の画像が配信の置き場に無ければ、その図を差し込まず、論点と図と理由を問題に挙げて終了 1 で終える', async () => {
    const fig = rewrittenFigs.get(R1)![0]
    const svg = svgPath(ws, R1, fig.id)
    const moved = `${svg}.uc027`
    const r = await attachAfter(R1, () => fs.renameSync(svg, moved)).finally(() => fs.renameSync(moved, svg))
    expect(r.run.status, `終了 1 で終わらない:\n${r.run.out}`).toBe(1)
    const hits = problemsOf(r.run).filter((p) => p.startsWith(`${where(R1, fig.id)}: `))
    expect(hits.length, `問題に挙がっていない:\n${r.run.out}`).toBe(1)
    expect(hits[0].length).toBeGreaterThan(`${where(R1, fig.id)}: `.length)
    expect(r.placed.filter(([, p]) => isFigure(p, R1, fig.id)), '画像の無い図が差し込まれた').toEqual([])
  })

  // @covers REQ-488#heading-missing-rewritten
  it('書き直した世代から選んだ論点で差し込み位置の見出しが教材に無ければ、その図を差し込まず（explanation にも逃がさず）、門の表の文言で問題に挙げて終了 1 で終える', async () => {
    const fig = rewrittenFigs.get(R1)![1]
    const heading = '### この教材に無い見出し'
    const r = await attachAfter(R1, () => {
      const spec = figureSpec(ws, R1)!
      ;(spec.figures as Json[]).find((f) => f.id === fig.id)!.after = heading
      ws.writeJson(figureFile(ws, R1), spec)
    })
    expect(r.run.status, `終了 1 で終わらない:\n${r.run.out}`).toBe(1)
    expect(problemsOf(r.run)).toContain(`${where(R1, fig.id)}: after '${heading}' が教材に無い`)
    expect(r.placed.filter(([, p]) => isFigure(p, R1, fig.id)), '見出しの無い図が差し込まれた').toEqual([])
  })

  // @covers REQ-488#heading-missing-previous-not-problem
  it('前の世代から選んだ論点で差し込み位置の見出しが教材に無くても、問題に挙げず終了 0 で終える', async () => {
    const r = await attachAfter(Q1, () => {
      const spec = figureSpec(ws, Q1)!
      ;(spec.figures as Json[])[0].after = '### この教材に無い見出し'
      ws.writeJson(figureFile(ws, Q1), spec)
    })
    expect(r.run.status, r.run.out).toBe(0)
    expect(problemsOf(r.run)).toEqual([])
  })

  // @covers REQ-488#no-material-rewritten-on-problem
  it('差し込めない図が 1 つあれば、同じ論点・書き直した世代の他の論点・前の世代の論点に差し込める図があっても、教材のファイルを 1 つも書き換えず、その図を問題に挙げて終了 1 で終える', async () => {
    const fig = rewrittenFigs.get(R1)!.find((f) => f.after !== 'explanation')!
    const heading = '### この教材に無い見出し'
    const materialFiles = () =>
      new Map(
        [...PREVIOUS, REWRITTEN].flatMap((g) => {
          const dir = ws.abs(`${ws.data}/${g}`)
          if (!fs.existsSync(dir)) return []
          return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => [`${ws.data}/${g}/${n}`, ws.readText(`${ws.data}/${g}/${n}`)] as const)
        }),
      )
    const r = await restoring(() => {
      for (const [rel, body] of pristineBundles) ws.writeJson(rel, body)
      const spec = figureSpec(ws, R1)!
      ;(spec.figures as Json[]).find((f) => f.id === fig.id)!.after = heading
      ws.writeJson(figureFile(ws, R1), spec)
      const before = materialFiles()
      const run = attachFigures(ws)
      return { run, before, after: materialFiles() }
    })
    expect(pristineBundles.size, '仕込み: 書き直した世代の束が無い').toBeGreaterThan(0)
    expect(r.run.status, `終了 1 で終わらない:\n${r.run.out}`).toBe(1)
    expect(problemsOf(r.run)).toContain(`${where(R1, fig.id)}: after '${heading}' が教材に無い`)
    const changed = [...r.before.keys()].filter((rel) => r.after.get(rel) !== r.before.get(rel))
    expect(changed, '書き換わった教材のファイル').toEqual([])
    expect([...r.after.keys()].sort(), '教材のファイルが増えたか減った').toEqual([...r.before.keys()].sort())
  })
})

/* ---------- REQ-489 ---------- */

describe('流したあとの DB を投入と突き合わせ、単元の構成を持つ表は投入が書くときだけ行の数を比べる（UC-027）', () => {
  /** 投入を作業場に書き出し、その投入を流した DB を作る。 */
  function prepared(name: string, seed: string, alter?: (db: import('node:sqlite').DatabaseSync) => void) {
    ws.writeText(`${name}.sql`, seed)
    const db = seededDbFile(ws, name, seed)
    if (alter) withDbFile(db, alter)
    return { sql: `${name}.sql`, db }
  }

  // @covers REQ-489#unit-tables-match
  it('投入が単元の構成を持つ表を書き、DB の行の数がどの表も投入と一致すれば、終了 0 で終える', () => {
    const p = prepared('match', sqlOf(assembled))
    const r = verifySeed(ws, LEARNING, p.db, ['--sql', p.sql])
    expect(r.status, r.out).toBe(0)
  })

  // @covers REQ-489#unit-table-count-mismatch
  it('投入が単元の構成を持つ表を書き、DB の行の数が投入と違う表があれば、その表と両方の数を示して終了 1 で終える', () => {
    const want = expectedUnitRows([planA, planB]).unit_group_topics.length
    const p = prepared('mismatch', sqlOf(assembled), (db) => {
      db.exec(`DELETE FROM unit_group_topics WHERE topic_id = ${learningOrder(planB).at(-1)}`)
    })
    const r = verifySeed(ws, LEARNING, p.db, ['--sql', p.sql])
    expect(r.status, `食い違いを見逃した:\n${r.out}`).toBe(1)
    const line = r.out.split('\n').find((l) => l.includes('unit_group_topics'))
    expect(line, `表を示していない:\n${r.out}`).toBeTruthy()
    expect(line).toContain(String(want))
    expect(line).toContain(String(want - 1))
  })

  // @covers REQ-489#seed-without-unit-tables-skipped
  it('投入が単元の構成を持つ表を書かないときは、DB にその表の行があっても比べず、終了 0 で終える', () => {
    const p = prepared('skipped', sqlOf(baseline), (db) => {
      db.exec(`INSERT INTO unit_plans (middle_no, overview) VALUES (${unitA}, '前に入れた全体像です。')`)
      db.exec(`INSERT INTO unit_groups (middle_no, group_no, name, description) VALUES (${unitA}, 1, '前のまとまり', '前のまとまりの説明です。')`)
    })
    const r = verifySeed(ws, LEARNING, p.db, ['--sql', p.sql])
    expect(r.status, r.out).toBe(0)
  })
})
