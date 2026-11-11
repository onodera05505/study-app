/** 要約を差し替える道具（`python3 scripts/apply_summary_override.py --data data/itc --id <論点の ID> --summary <要約>`。--id と --summary は組で
 *  何度でも渡せる）が、ロードマップの設定の要約の差し替えを論点の ID の鍵で書き、ロードマップのデータのその ID の単位の要約を書き換え、
 *  名前では当てないこと（REQ-435）と、どの単位にも当たらない ID があれば設定もデータも書き換えずに止め、その ID を示すこと（REQ-436）。UC-009
 *
 *  仕込みは一時の作業場の data/itc/ にテスト自身が書く（roadmap_config.json と roadmap.json だけ。実データは読まない）。
 *  観測するのは終了コード・標準出力と標準エラー・書き換え後の 2 つのファイルだけ。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const APPLY = path.join(ROOT, 'scripts', 'apply_summary_override.py')
const DATA = 'data/itc'

type Json = Record<string, any>

/** 単位の論点の ID（学ぶ順とも名前とも別の値）。 */
const ID = (n: number) => 500 + n
const COUNT = 6
const UNKNOWN = 9876
const OLD_KEY = String(ID(6))
const OLD_SUMMARY = '前から差し替えてある要約'

function units(termOf: (i: number) => string = (i) => `仕込みの単位${String.fromCharCode(0x30a2 + i * 2)}`): Json[] {
  return Array.from({ length: COUNT }, (_, i) => ({
    order: i + 1,
    day: Math.floor(i / 3) + 1,
    topic_id: ID(i + 1),
    term: termOf(i),
    field: '業界と仕事',
    summary: i === COUNT - 1 ? OLD_SUMMARY : `仕込みの要約${i + 1}`,
    prereq: [],
    goals: [1],
  }))
}

function config(): Json {
  return {
    max: COUNT,
    per_day: 3,
    min_per_goal: 1,
    must_include: [ID(2)],
    exclude: [],
    prereq_add: {},
    prereq_replace: {},
    cluster: [],
    summary_override: { [OLD_KEY]: OLD_SUMMARY },
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Applied = { status: number | null; out: string; cfg: Json; roadmap: Json; cfgText: string; roadmapText: string }

/** 作業場に設定とロードマップのデータを書き、--id と --summary の組を渡して差し替える。 */
function apply(us: Json[], pairs: [string, string][]): Applied & { before: { cfgText: string; roadmapText: string } } {
  const ws = fs.mkdtempSync(path.join(tmpdir(), 'uc009-summary-'))
  dirs.push(ws)
  const dir = path.join(ws, DATA)
  fs.mkdirSync(dir, { recursive: true })
  const cfgFile = path.join(dir, 'roadmap_config.json')
  const roadmapFile = path.join(dir, 'roadmap.json')
  fs.writeFileSync(cfgFile, JSON.stringify(config(), null, 2))
  fs.writeFileSync(roadmapFile, JSON.stringify({ target: '仕込みの学び', per_day: 3, days: 2, unit_count: us.length, units: us }, null, 2))
  const before = { cfgText: fs.readFileSync(cfgFile, 'utf8'), roadmapText: fs.readFileSync(roadmapFile, 'utf8') }
  const args = pairs.flatMap(([id, summary]) => ['--id', id, '--summary', summary])
  const r = spawnSync('python3', [APPLY, '--data', DATA, ...args], { cwd: ws, encoding: 'utf8' })
  const cfgText = fs.readFileSync(cfgFile, 'utf8')
  const roadmapText = fs.readFileSync(roadmapFile, 'utf8')
  return {
    status: r.status,
    out: `${r.stdout}\n${r.stderr}`,
    cfgText,
    roadmapText,
    cfg: JSON.parse(cfgText),
    roadmap: JSON.parse(roadmapText),
    before,
  }
}

function applied(us: Json[], pairs: [string, string][]) {
  const a = apply(us, pairs)
  expect(a.status, `差し替えが終了 0 で終わらない:\n${a.out}`).toBe(0)
  return a
}

const summaryOf = (a: Applied, id: number) => {
  const u = (a.roadmap.units as Json[]).filter((x) => x.topic_id === id)
  expect(u, `ロードマップのデータに論点 ${id} の単位がちょうど 1 つない`).toHaveLength(1)
  return u[0].summary
}

const NEW = '鍵の ID で差し替えた新しい要約'

describe('要約を論点の ID で差し替える（UC-009）', () => {
  // @covers REQ-435#config-keyed-by-id
  it('設定の要約の差し替えに、渡した論点の ID の文字列を鍵として新しい要約が入り、単位の名前の鍵は作らず、他の設定は変わらない', () => {
    const us = units()
    const a = applied(us, [[String(ID(3)), NEW]])
    expect(a.cfg.summary_override[String(ID(3))]).toBe(NEW)
    expect(a.cfg.summary_override, '単位の名前を鍵にしている').not.toHaveProperty([us[2].term])
    expect(a.cfg.summary_override[OLD_KEY], '前からの差し替えが変わった').toBe(OLD_SUMMARY)
    const { summary_override: _s, ...rest } = a.cfg
    const { summary_override: _t, ...restBefore } = config()
    expect(rest, '要約の差し替え以外の設定が変わった').toEqual(restBefore)
  })

  // @covers REQ-435#roadmap-unit-rewritten
  it('ロードマップのデータで、渡した論点の ID を持つ単位の要約だけが新しい要約になり、他の単位は変わらない', () => {
    const us = units()
    const a = applied(us, [[String(ID(3)), NEW]])
    expect(summaryOf(a, ID(3))).toBe(NEW)
    for (const u of us.filter((x) => x.topic_id !== ID(3)))
      expect(summaryOf(a, u.topic_id), `論点 ${u.topic_id} の要約が変わった`).toBe(u.summary)
  })

  // @covers REQ-435#several-pairs
  it('論点の ID と要約の組を複数渡すと、組ごとに設定の鍵と単位の要約がその組の値になる', () => {
    const pairs: [string, string][] = [
      [String(ID(1)), '一つ目の組の要約'],
      [String(ID(4)), '二つ目の組の要約'],
      [OLD_KEY, '前からの鍵を上書きする要約'],
    ]
    const a = applied(units(), pairs)
    for (const [id, summary] of pairs) {
      expect(a.cfg.summary_override[id], `設定の鍵 ${id}`).toBe(summary)
      expect(summaryOf(a, Number(id)), `論点 ${id} の単位`).toBe(summary)
    }
  })

  // @covers REQ-435#names-not-matched
  it('単位の名前を別の単位の ID と同じ文字にしてあっても、渡した ID を持つ単位に当たり、その名前の単位には当たらない', () => {
    // 名前を 1 つずらした単位の ID の文字にする: 名前で当てると、別の単位に当たる
    const us = units((i) => String(ID(((i + 1) % COUNT) + 1)))
    const target = ID(3)
    const namedLikeTarget = us.find((u) => u.term === String(target))!
    expect(namedLikeTarget.topic_id, '仕込み: ID と同じ名前の単位が別の単位でない').not.toBe(target)
    const a = applied(us, [[String(target), NEW]])
    expect(summaryOf(a, target)).toBe(NEW)
    expect(summaryOf(a, namedLikeTarget.topic_id), '名前で当たった単位の要約が変わった').toBe(namedLikeTarget.summary)
    expect(a.cfg.summary_override[String(target)]).toBe(NEW)
  })
})

describe('当たらない ID なら書き換えずに止める（UC-009）', () => {
  function expectUntouched(a: ReturnType<typeof apply>, shown: string, where: string) {
    expect(a.status, `${where}: 止まらずに終了 0 で終わった:\n${a.out}`).not.toBe(0)
    expect(a.cfgText, `${where}: ロードマップの設定が書き換わった`).toBe(a.before.cfgText)
    expect(a.roadmapText, `${where}: ロードマップのデータが書き換わった`).toBe(a.before.roadmapText)
    expect(a.out, `${where}: どの ID が当たらないかを示していない`).toContain(shown)
  }

  // @covers REQ-436#unknown-id
  it('どの単位にも当たらない論点の ID を渡すと、設定もロードマップのデータも書き換えずに止め、その ID を示す', () => {
    expectUntouched(apply(units(), [[String(UNKNOWN), NEW]]), String(UNKNOWN), '当たらない ID だけ')
  })

  // @covers REQ-436#unknown-among-known
  it('当たる ID の組と当たらない ID の組を一緒に渡すと、当たる組の分も含めてどちらも書き換えずに止め、当たらない ID を示す', () => {
    for (const [where, pairs] of [
      [
        '当たる組が先',
        [
          [String(ID(1)), NEW],
          [String(UNKNOWN), '当たらない組の要約'],
        ],
      ],
      [
        '当たらない組が先',
        [
          [String(UNKNOWN), '当たらない組の要約'],
          [String(ID(1)), NEW],
        ],
      ],
    ] as [string, [string, string][]][])
      expectUntouched(apply(units(), pairs), String(UNKNOWN), where)
  })

  // @covers REQ-436#id-only-in-config
  it('設定の要約の差し替えに鍵があってもロードマップのデータのどの単位にも無い ID を渡すと、書き換えずに止め、その ID を示す', () => {
    const us = units().filter((u) => u.topic_id !== ID(6))
    expect(config().summary_override, '仕込み: 設定にその鍵が無い').toHaveProperty([OLD_KEY])
    expectUntouched(apply(us, [[OLD_KEY, NEW]]), OLD_KEY, '設定にだけある ID')
  })

  // @covers REQ-436#name-in-place-of-id
  it('論点の ID の代わりに単位の名前を渡すと、名前で当てずに書き換えずに止め、その値を示す', () => {
    const us = units()
    expectUntouched(apply(us, [[us[2].term, NEW]]), us[2].term, '単位の名前')
  })
})
