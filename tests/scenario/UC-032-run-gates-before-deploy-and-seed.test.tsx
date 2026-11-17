/** UC-032「配備と投入の前に門を回し、通らない物を本番に出さない」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。門で止まる場合・控えや投入や突き合わせの失敗・配信の前の確かめで止まる場合は各要件のテストが見る）。
 *
 *  土台は `tests/server/UC-032_fixture.ts`（本番の保存先と配信先に届かない影の根と偽の配備の道具）。
 *  学びは登録簿にあるロードマップ型の学び eng。運用者が回す 4 つの入口（checkSource・checkRoadmapRegistry・seedRemote・
 *  学び側の配備の手続き）を契約のとおりコマンドとして呼ぶ。
 *  - ソースの門と登録簿の門は、運用者が回すときも配備の手続きが回すときも、影の根に写した本物を回す
 *  - 流す前の投入の検査・投入後の突き合わせ（UC-027 の範囲）・控えの道具・文書の索引の門・実データの描画の検査（UC-027 の範囲）は、
 *    通ったと返す包み（呼ばれた順は記録する）
 *  - 投入（事前条件の「組み立てられている」）は、学ぶ順と回を持つ論点だけの小さな投入を仕込む。偽の本番の保存先はそれを当てる
 *    （配備の手続きの回の確かめは、流した投入の結果を本番の保存先から読む） */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  type Run,
  type Shadow,
  type Tool,
  type World,
  argsOf,
  backupRuns,
  deployRuns,
  indexOf,
  makeShadow,
  removeShadows,
  runCommand,
  runProcedure,
  seedRuns,
  tail,
  toolRuns,
} from '../server/UC-032_fixture'

const LEARNING = 'eng'
const TOPICS = 12
const SEED = [
  '-- UC-032 のシナリオの仕込みの投入（学ぶ順と回を持つ論点）',
  ...Array.from(
    { length: TOPICS },
    (_, i) => `INSERT INTO topics (term, syllabus_item_id, sort_order, round) VALUES ('論点${i + 1}', 1, ${i + 1}, '${Math.floor(i / 4) + 1}');`,
  ),
  '',
].join('\n')

/** 門は本物を回し、ほかの契約の道具は通ったと返す。投入は偽の保存先に当てる。 */
const WORLD: World = {
  modes: { check_source: 'real', check_roadmap_registry: 'real' },
  applySeed: true,
}
const GATES: Tool[] = ['check_source', 'check_roadmap_registry', 'check_docs', 'check_render']

let shadow: Shadow
const steps: Record<string, Run> = {}

beforeAll(async () => {
  shadow = makeShadow('scenario', { copy: ['scripts', 'src', 'public', 'portal'], seeds: { [LEARNING]: SEED }, remote: { topics: [] } })
  const script = (name: string) => join(shadow.root, 'scripts', name)
  // 1–2. ソースの門
  steps.source = await runCommand(shadow, 'python3', [script('check_source.py')], WORLD)
  // 3–4. その学びの登録簿の門
  steps.registry = await runCommand(shadow, 'python3', [script('check_roadmap_registry.py'), LEARNING], WORLD)
  // 5–8. その学びの投入を本番の保存先へ流す
  steps.seed = await runProcedure(shadow, 'seed_remote.sh', [LEARNING], WORLD)
  // 9–12. その学びを配信する
  steps.deploy = await runProcedure(shadow, 'deploy-pages.sh', [LEARNING], WORLD)
}, 600_000)

afterAll(async () => {
  await removeShadows()
}, 120_000)

describe('UC-032 配備と投入の前に門を回し、通らない物を本番に出さない', () => {
  // @scenario UC-032
  it('ソースの門と登録簿の門が通り、投入が控えのあとに本番の保存先へ入って突き合わさり、門がすべて通った配信物で配信される', () => {
    // 2. ソースの門が通したことを示す
    expect(steps.source.code, `ソースの門が通さなかった:\n${tail(steps.source)}`).toBe(0)
    // 4. 登録簿の門が通したことを示す
    expect(steps.registry.code, `登録簿の門が通さなかった:\n${tail(steps.registry)}`).toBe(0)

    // 6–8. 門・控え・投入・突き合わせを回して完了を示す
    const seed = steps.seed
    expect(seed.code, `投入が完了しなかった:\n${tail(seed)}`).toBe(0)
    const seeds = seedRuns(seed)
    expect(seeds.length, '投入を流していない').toBeGreaterThan(0)
    expect(seeds.every((e) => e.side === 'remote'), '本番の保存先（--remote）へ流していない').toBe(true)
    expect(toolRuns(seed, 'check_seed').length, '流す前の投入の検査を回していない').toBeGreaterThan(0)
    const firstSeed = Math.min(...seeds.map((e) => indexOf(seed, e)))
    expect(Math.max(...toolRuns(seed, 'check_seed').map((e) => indexOf(seed, e))), '流す前の投入の検査が投入より後').toBeLessThan(firstSeed)
    const backups = backupRuns(seed)
    expect(backups.length, '本番の保存先の控えを取っていない').toBeGreaterThan(0)
    expect(Math.min(...backups.map((e) => indexOf(seed, e))), '控えより先に投入している').toBeLessThan(firstSeed)
    const verifies = toolRuns(seed, 'verify_seed_remote')
    expect(verifies.length, '投入後の突き合わせを回していない').toBeGreaterThan(0)
    expect(verifies.every((e) => !argsOf(e).includes('--local')), '本番でなく手元を突き合わせている').toBe(true)
    expect(Math.max(...verifies.map((e) => indexOf(seed, e))), '突き合わせが投入より前').toBeGreaterThan(firstSeed)

    // 10–12. 配信の前の確かめと門がすべて通り、配信物を出す
    const deploy = steps.deploy
    expect(deploy.code, `配信が成功で終わらなかった:\n${tail(deploy)}`).toBe(0)
    const deployed = deployRuns(deploy)
    expect(deployed.length, '配信していない').toBeGreaterThan(0)
    const firstDeploy = Math.min(...deployed.map((e) => indexOf(deploy, e)))
    for (const g of GATES) {
      const calls = toolRuns(deploy, g)
      expect(calls.length, `配備の手続きが ${g} を回していない`).toBeGreaterThan(0)
      expect(Math.max(...calls.map((e) => indexOf(deploy, e))), `${g} が配信より後`).toBeLessThan(firstDeploy)
    }
  })
})
