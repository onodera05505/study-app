/** UC-034「学び側とまなびばの経路と作り手と運用の道具を入口の一覧に出し、契約と突き合わせられるようにする」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。中継ぎ・名前の表・重なり・断りは各要件のテストが見る）。
 *
 *  運用者は入口の一覧を出す道具（`npx tsx scripts/list_entries.ts`）を手元の作業ツリーで 1 回回し、出た一覧をファイルに書いて、
 *  契約との突き合わせ（`node .harness/bin/harness.mjs lint entries --from <ファイル>`。`.harness/tools/lint-entries/README.md`）に渡す。
 *  事後条件の「契約との突き合わせに渡せる」は、突き合わせが一覧を読めた（一覧の読めなさの違反 E4 が無く、使い方の誤りで止まらない）ことで見る。
 *  契約に無い入口と入口の無い操作（E1・E2）は、契約と実装の側の事実で、この UC の成功の外。 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ListRun, ROOT, expectListed, routeKey, routesOf, runReal, tailOf, toolsOf } from '../server/UC-034_fixture'

const dir = mkdtempSync(join(tmpdir(), 'uc034-scenario-'))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('UC-034 入口の一覧を出し、契約と突き合わせられるようにする', () => {
  // @scenario UC-034
  it('運用者が入口の一覧を出すと、経路と道具が 1 行に 1 件ずつ重なりなく並び、その一覧を契約との突き合わせに渡せる', () => {
    // 1〜4. 運用者が入口の一覧を出す（システムが経路と道具を並べ、同じ入口を 1 つにまとめて 1 行に 1 件ずつ出す）
    const run: ListRun = runReal()
    expectListed(run, expect)
    const routes = routesOf(run).map(routeKey)
    const tools = toolsOf(run).map((t) => t.name)
    expect(routes.length, `経路の入口が出ていない:\n${tailOf(run)}`).toBeGreaterThan(0)
    expect(tools.length, `道具の入口が出ていない:\n${tailOf(run)}`).toBeGreaterThan(0)
    expect(new Set(routes).size, '同じ経路が 2 回出た').toBe(routes.length)
    expect(new Set(tools).size, '同じ道具が 2 回出た').toBe(tools.length)

    // 5. 運用者が、出た一覧を契約との突き合わせに渡す
    const file = join(dir, 'entries.jsonl')
    writeFileSync(file, run.stdout)
    const matched = spawnSync('node', [join(ROOT, '.harness', 'bin', 'harness.mjs'), 'lint', 'entries', '--from', file], { cwd: ROOT, encoding: 'utf8' })
    const out = `${matched.stdout}\n${matched.stderr}`
    expect(matched.status, `突き合わせが一覧を受け取れずに止まった:\n${out}`).not.toBe(2)
    expect(out, `突き合わせが一覧を読めない（E4）:\n${out}`).not.toMatch(/\bE4\b/)
  }, 180_000)
})
