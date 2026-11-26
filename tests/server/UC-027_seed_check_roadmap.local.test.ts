/** UC-027 流す前の投入の検査（checkSeed ＝ `python3 scripts/check_seed.py --data <置き場> [--sql <投入>]`）を、ロードマップ型の学び（登録簿で
 *  roadmap を持つ itc）の投入にかける。ロードマップ型の投入は、回と 1 回の問題数と印を登録簿の値と突き合わせる所を通る。
 *  作業場は学びの置き場の写し（UC-027_fixture.local.ts の makeWorkspace）で、投入は写しの上で組み立てる。原本の data/ は書き換えない。 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ROOT, buildSeed, cleanWorkspaces, makeWorkspace, type Ws } from './UC-027_fixture.local'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 })

const LEARNING = 'itc'

const checkSeed = (ws: Ws, extra: string[] = []) => {
  const r = spawnSync('python3', [path.join(ROOT, 'scripts', 'check_seed.py'), '--data', ws.data, ...extra], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`.split(ws.dir).join('<ws>') }
}

let ws: Ws
let built: { status: number | null; out: string }

beforeAll(() => {
  ws = makeWorkspace(LEARNING)
  built = buildSeed(ws)
})

afterAll(() => cleanWorkspaces())

describe('流す前の投入の検査は、問題があれば示して失敗で終える（UC-027）', () => {
  // @covers REQ-531#clean-seed-passes
  it('ロードマップ型の学びの組み立てたままの投入は、回と 1 回の問題数と印を登録簿と突き合わせ、問題を示さずに終了 0 で終える', () => {
    expect(built.status, `仕込み: 投入を組み立てられない:\n${built.out}`).toBe(0)
    const r = checkSeed(ws)
    expect(r.status, `問題の無い投入で失敗した:\n${r.out.slice(-3000)}`).toBe(0)
  })
})
