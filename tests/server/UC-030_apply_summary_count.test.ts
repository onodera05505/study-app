/** 要約を差し替える入口（applySummaryOverride ＝ `python3 scripts/apply_summary_override.py --data <学びの置き場> --id <論点の ID> --summary <要約>`。
 *  --id と --summary は同じ順で組にし、それぞれ何度でも渡せる）が、論点の ID と要約の数が合わないときに止まること。UC-030
 *
 *  仕込みは一時の作業場の data/itc/ にテスト自身が書く（roadmap_config.json と roadmap.json だけ）。
 *  観測するのは終了コード・標準出力と、2 つのファイルが組み立ての前のままかどうかだけ。 */

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPLY_SUMMARY, type Json, cleanup, roadmapConfig, run, snapshot, workspace, writeJson } from './UC-030_roadmap_fixture'

vi.setConfig({ testTimeout: 60_000 })

afterEach(cleanup)

const DATA = 'data/itc'
const ID = (n: number) => 500 + n
const COUNT = 4
const UNKNOWN = 9876

function units(): Json[] {
  return Array.from({ length: COUNT }, (_, i) => ({
    order: i + 1,
    day: Math.floor(i / 2) + 1,
    topic_id: ID(i + 1),
    term: `仕込みの単位${String.fromCharCode(0x30a2 + i * 2)}`,
    field: '業界と仕事',
    middle: '仕込みの中分類',
    summary: `仕込みの要約${i + 1}`,
    prereq: [],
    goals: [1],
  }))
}

/** 作業場に設定とロードマップのデータを書き、--id と --summary を渡す。 */
function apply(ids: string[], summaries: string[]) {
  const ws = workspace('uc030-summary')
  const dir = path.join(ws, DATA)
  writeJson(path.join(dir, 'roadmap_config.json'), roadmapConfig({ max: COUNT, per_day: 2 }))
  writeJson(path.join(dir, 'roadmap.json'), { target: '仕込みの学び', per_day: 2, days: 2, unit_count: COUNT, units: units() })
  const before = snapshot(dir)
  const args = [...ids.flatMap((id) => ['--id', id]), ...summaries.flatMap((s) => ['--summary', s])]
  const r = run(ws, APPLY_SUMMARY, ['--data', DATA, ...args])
  return { ...r, before, after: snapshot(dir), dir }
}

function expectUntouched(a: ReturnType<typeof apply>, where: string) {
  expect(a.status, `${where}: 終了 1 で止まらない:\n${a.out}`).toBe(1)
  expect(a.after, `${where}: 設定かロードマップのデータが書き換わった`).toEqual(a.before)
  expect(fs.existsSync(path.join(a.dir, 'roadmap.json'))).toBe(true)
  expect(a.stdout.trim(), `${where}: 標準出力に止めた理由が無い`).not.toBe('')
}

describe('UC-030 論点の ID と要約の数が合わなければ書き換えずに止める', () => {
  // @covers REQ-545#more-ids-than-summaries
  it('論点の ID が要約より多ければ、どれも当たる ID でも、設定もロードマップのデータも書き換えずに止め、数が合わないことを示す', () => {
    expectUntouched(apply([String(ID(1)), String(ID(2))], ['一つだけの要約']), 'ID 2 つと要約 1 つ')
    expectUntouched(apply([String(ID(1)), String(ID(2)), String(ID(3))], ['一つ目', '二つ目']), 'ID 3 つと要約 2 つ')
  })

  // @covers REQ-545#more-summaries-than-ids
  it('要約が論点の ID より多ければ、設定もロードマップのデータも書き換えずに止め、数が合わないことを示す', () => {
    expectUntouched(apply([String(ID(1))], ['一つ目の要約', '二つ目の要約']), 'ID 1 つと要約 2 つ')
  })

  // @covers REQ-545#mismatch-before-unknown-id
  it('数が合わず、渡した ID がどの単位にも当たらないときも、書き換えずに止める', () => {
    expectUntouched(apply([String(UNKNOWN), String(UNKNOWN + 1)], ['当たらない単位の要約']), '数が合わず当たらない ID')
  })
})
