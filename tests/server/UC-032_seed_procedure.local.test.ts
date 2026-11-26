import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MIGRATIONS,
  type Run,
  type ShadowOptions,
  type World,
  argsOf,
  backupRuns,
  indexOf,
  inBatches,
  makeShadow,
  removeShadows,
  runProcedure,
  seedRuns,
  storageCalls,
  tail,
  toolRuns,
} from './UC-032_fixture.local'

/**
 * UC-032 投入の手続き（契約 seedRemote。入口 `bash scripts/seed_remote.sh <学び> [--local]`）が、構造の変更と流す前の投入の検査の門・
 * 本番の控え・投入・投入後の突き合わせの順に保存先へ流すこと（REQ-552〜557・564）。
 *
 * 土台は `UC-032_fixture.local.ts`。保存先は本番（`--remote`）と手元の 2 つの偽物で、投入・控え・構造の変更の確かめはどちらに向いたかで記録する。
 * 流す前の投入の検査（UC-027 checkSeed）・投入後の突き合わせ（UC-027 verifySeedRemote）・控えの道具は、決めた終了の状態で返す包み。
 * 学びは登録簿にある資格対策の学び ip（投入を仕込む）と、投入を書き出していない fe、登録簿に無い zzz。
 */

const SEEDED = 'ip'
const UNSEEDED = 'fe'
const UNKNOWN = 'zzz'
const SEED_SQL = '-- UC-032 のテストの仕込みの投入\nSELECT 1;\n'

type Mode = 'remote' | 'local'
const MODES: Mode[] = ['remote', 'local']
const argsFor = (learning: string, mode: Mode) => (mode === 'local' ? [learning, '--local'] : [learning])

/** 流す先でない保存先。 */
const other = (mode: Mode): Mode => (mode === 'remote' ? 'local' : 'remote')

type Input = { name: string; args: string[]; world?: World; shadow?: Partial<ShadowOptions> }

const base = (): ShadowOptions => ({ copy: ['scripts', 'src'], ownData: [SEEDED, UNSEEDED], seeds: { [SEEDED]: SEED_SQL } })

const inputs: Input[] = [
  ...MODES.flatMap((m): Input[] => [
    { name: `unknown-${m}`, args: argsFor(UNKNOWN, m) },
    { name: `unseeded-${m}`, args: argsFor(UNSEEDED, m) },
    { name: `pending-${m}`, args: argsFor(SEEDED, m), shadow: { [m]: { applied: MIGRATIONS.length - 1 } } },
    { name: `unverifiable-${m}`, args: argsFor(SEEDED, m), world: { migrationsFail: true } },
    { name: `checkFails-${m}`, args: argsFor(SEEDED, m), world: { modes: { check_seed: 'fail' } } },
    { name: `ok-${m}`, args: argsFor(SEEDED, m) },
    { name: `retry-${m}`, args: argsFor(SEEDED, m), world: { seedFails: 1 } },
    { name: `twice-${m}`, args: argsFor(SEEDED, m), world: { seedFails: 2 } },
    { name: `mismatch-${m}`, args: argsFor(SEEDED, m), world: { modes: { verify_seed_remote: 'fail' } } },
  ]),
  { name: 'otherPending-local', args: argsFor(SEEDED, 'local'), shadow: { remote: { applied: MIGRATIONS.length - 1 } } },
  { name: 'otherPending-remote', args: argsFor(SEEDED, 'remote'), shadow: { local: { applied: MIGRATIONS.length - 1 } } },
  { name: 'backupFails', args: argsFor(SEEDED, 'remote'), world: { backupFail: true, modes: { backup_d1: 'fail' } } },
  { name: 'mistyped', args: [SEEDED, '--locl'] },
  { name: 'otherWord', args: [SEEDED, 'local'] },
  { name: 'otherFlag', args: [SEEDED, '--remote'] },
  { name: 'mistypedUnseeded', args: [UNSEEDED, '--locl'] },
]

const runs: Record<string, Run> = {}
const run = (name: string) => {
  const r = runs[name]
  if (!r) throw new Error(`${name} の実行結果が無い`)
  return r
}

beforeAll(async () => {
  await inBatches(
    inputs.map((input) => async () => {
      const shadow = makeShadow(`seed-${input.name}`, { ...base(), ...input.shadow })
      runs[input.name] = await runProcedure(shadow, 'seed_remote.sh', input.args, input.world)
    }),
    6,
  )
}, 600_000)

afterAll(async () => {
  await removeShadows()
}, 120_000)

/** 保存先に何も流していない（投入も控えもしていない）。 */
const expectNothingFlowed = (r: Run, label: string) => {
  expect(seedRuns(r), `${label}: 投入を流している:\n${tail(r)}`).toEqual([])
  expect(backupRuns(r), `${label}: 控えを取っている:\n${tail(r)}`).toEqual([])
}

describe('UC-032 配備と投入の前に門を回し、通らない物を本番に出さない（投入の手続き）', () => {
  describe('REQ-552 登録簿に無い学び・投入が書き出されていない学びは保存先に触れずに断る', () => {
    // @covers REQ-552#unknown-learning
    it('登録簿に無い学びを渡すと、本番へでも手元へでも、保存先に向けた操作を何もせず失敗で終わる', () => {
      for (const m of MODES) {
        const r = run(`unknown-${m}`)
        expect(r.code, `${m}: 登録簿に無い学びで成功で終わった:\n${tail(r)}`).not.toBe(0)
        expect(storageCalls(r), `${m}: 保存先に触れている`).toEqual([])
        expectNothingFlowed(r, m)
      }
    })

    // @covers REQ-552#seed-not-written
    it('投入が書き出されていない学びを渡すと、本番へでも手元へでも、保存先に向けた操作を何もせず失敗で終わる', () => {
      for (const m of MODES) {
        const r = run(`unseeded-${m}`)
        expect(r.code, `${m}: 投入が無いのに成功で終わった:\n${tail(r)}`).not.toBe(0)
        expect(storageCalls(r), `${m}: 保存先に触れている`).toEqual([])
        expectNothingFlowed(r, m)
      }
    })
  })

  describe('REQ-553 流す先に当たっていない構造の変更があるか確かめられなければ、控えも投入もせず失敗で終える', () => {
    // @covers REQ-553#unapplied-migration
    it('流す先の保存先に当たっていない構造の変更が 1 つあると、控えも投入もせず失敗で終わる', () => {
      for (const m of MODES) {
        const r = run(`pending-${m}`)
        expect(r.code, `${m}: 当たっていない構造の変更があるのに成功で終わった:\n${tail(r)}`).not.toBe(0)
        expectNothingFlowed(r, m)
      }
    })

    // @covers REQ-553#migrations-unverifiable
    it('構造の変更が当たっているかを保存先から確かめられないと、控えも投入もせず失敗で終わる', () => {
      for (const m of MODES) {
        const r = run(`unverifiable-${m}`)
        expect(r.code, `${m}: 確かめられないのに成功で終わった:\n${tail(r)}`).not.toBe(0)
        expectNothingFlowed(r, m)
      }
    })

    // @covers REQ-553#other-storage-not-target
    it('流す先でない保存先にだけ当たっていない構造の変更があっても、それでは止めずに流す先へ投入する', () => {
      for (const m of MODES) {
        const r = run(`otherPending-${m}`)
        expect(r.code, `${m}: 流す先でない保存先の構造の変更で止まった:\n${tail(r)}`).toBe(0)
        expect(seedRuns(r).length, `${m}: 投入を流していない:\n${tail(r)}`).toBeGreaterThan(0)
        expect(seedRuns(r).every((e) => e.side === m), `${m}: 流す先でない保存先へ流している`).toBe(true)
        expect(seedRuns(r).some((e) => e.side === other(m)), `${m}: 流す先でない保存先へ流している`).toBe(false)
      }
    })
  })

  describe('REQ-554 流す前の投入の検査が問題を示したら、控えも投入もせず失敗で終える', () => {
    // @covers REQ-554#seed-check-problem
    it('流す前の投入の検査が問題を示すと、本番へでも手元へでも、控えも投入もせず失敗で終わる', () => {
      for (const m of MODES) {
        const r = run(`checkFails-${m}`)
        expect(toolRuns(r, 'check_seed').length, `${m}: 仕込み: 流す前の投入の検査が呼ばれていない:\n${tail(r)}`).toBeGreaterThan(0)
        expect(r.code, `${m}: 検査が問題を示したのに成功で終わった:\n${tail(r)}`).not.toBe(0)
        expectNothingFlowed(r, m)
      }
    })
  })

  describe('REQ-555 本番へ流すときだけ投入の前に控えを取り、取れなければ投入しない', () => {
    // @covers REQ-555#remote-backup-before-seed
    it('門の通った投入を本番へ流すと、本番の保存先の控えを取ってから本番の保存先へ投入する', () => {
      const r = run('ok-remote')
      const seeds = seedRuns(r)
      const backups = backupRuns(r)
      expect(seeds.length, `投入を流していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(seeds.every((e) => e.side === 'remote'), '本番の保存先（--remote）へ流していない').toBe(true)
      expect(backups.length, `控えを取っていない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(
        backups.every((e) => e.tool === 'backup_d1' ? argsOf(e).includes(SEEDED) : e.side === 'remote'),
        '本番のその学びの保存先でない控えを取っている',
      ).toBe(true)
      const firstSeed = Math.min(...seeds.map((e) => indexOf(r, e)))
      expect(Math.min(...backups.map((e) => indexOf(r, e))), '控えより先に投入している').toBeLessThan(firstSeed)
    })

    // @covers REQ-555#local-no-backup
    it('門の通った投入を手元の保存先へ流すと、控えを取らずに手元の保存先へ投入する', () => {
      const r = run('ok-local')
      expect(seedRuns(r).length, `投入を流していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(seedRuns(r).every((e) => e.side === 'local'), '手元でなく本番の保存先（--remote）へ流している').toBe(true)
      expect(backupRuns(r), '手元へ流すのに控えを取っている').toEqual([])
    })

    // @covers REQ-555#backup-fails
    it('本番へ流すときに控えが取れないと、投入せず失敗で終わる', () => {
      const r = run('backupFails')
      expect(backupRuns(r).length, `仕込み: 控えを取ろうとしていない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(seedRuns(r), '控えが取れないのに投入している').toEqual([])
      expect(r.code, `控えが取れないのに成功で終わった:\n${tail(r)}`).not.toBe(0)
    })
  })

  describe('REQ-556 投入が失敗したら 1 回だけやり直し、2 回目も失敗したら突き合わせに進まず失敗で終える', () => {
    // @covers REQ-556#retry-once-then-passes
    it('投入が 1 回失敗して次は通ると、ちょうど 2 回投入して突き合わせに進む', () => {
      for (const m of MODES) {
        const r = run(`retry-${m}`)
        expect(seedRuns(r).length, `${m}: 投入の回数が 2 でない:\n${tail(r)}`).toBe(2)
        expect(toolRuns(r, 'verify_seed_remote').length, `${m}: 突き合わせに進んでいない:\n${tail(r)}`).toBeGreaterThan(0)
        expect(r.code, `${m}: やり直しで通ったのに成功で終わらない:\n${tail(r)}`).toBe(0)
      }
    })

    // @covers REQ-556#fails-twice
    it('投入が 2 回続けて失敗すると、3 回目を流さず、突き合わせに進まず失敗で終わる', () => {
      for (const m of MODES) {
        const r = run(`twice-${m}`)
        expect(seedRuns(r).length, `${m}: 投入の回数が 2 でない:\n${tail(r)}`).toBe(2)
        expect(toolRuns(r, 'verify_seed_remote'), `${m}: 失敗したのに突き合わせに進んでいる`).toEqual([])
        expect(r.code, `${m}: 2 回失敗したのに成功で終わった:\n${tail(r)}`).not.toBe(0)
      }
    })
  })

  describe('REQ-557 流したあとの保存先を投入と突き合わせ、通ったときだけ成功で終える', () => {
    // @covers REQ-557#reconciled-completes
    it('投入が通り突き合わせも通ると、投入のあとに突き合わせを回して成功で終わる', () => {
      for (const m of MODES) {
        const r = run(`ok-${m}`)
        const seeds = seedRuns(r)
        const verifies = toolRuns(r, 'verify_seed_remote')
        expect(seeds.length, `${m}: 投入を流していない:\n${tail(r)}`).toBeGreaterThan(0)
        expect(verifies.length, `${m}: 突き合わせを回していない:\n${tail(r)}`).toBeGreaterThan(0)
        expect(Math.max(...verifies.map((e) => indexOf(r, e))), `${m}: 突き合わせが投入より前`).toBeGreaterThan(Math.max(...seeds.map((e) => indexOf(r, e))))
        expect(r.code, `${m}: 突き合わせが通ったのに成功で終わらない:\n${tail(r)}`).toBe(0)
      }
    })

    // @covers REQ-557#mismatch-fails
    it('投入は通ったが突き合わせが食い違いを示すと、失敗で終わる', () => {
      for (const m of MODES) {
        const r = run(`mismatch-${m}`)
        expect(seedRuns(r).length, `${m}: 仕込み: 投入を流していない:\n${tail(r)}`).toBeGreaterThan(0)
        expect(toolRuns(r, 'verify_seed_remote').length, `${m}: 仕込み: 突き合わせを回していない:\n${tail(r)}`).toBeGreaterThan(0)
        expect(r.code, `${m}: 食い違いがあるのに成功で終わった:\n${tail(r)}`).not.toBe(0)
      }
    })

    // @covers REQ-557#reconciles-target-storage
    it('突き合わせは流した先の保存先を見る（手元へ流したときだけ手元を見る指定を付ける）', () => {
      const remote = toolRuns(run('ok-remote'), 'verify_seed_remote')
      const local = toolRuns(run('ok-local'), 'verify_seed_remote')
      expect(remote.length, '本番へ流したときに突き合わせを回していない').toBeGreaterThan(0)
      expect(local.length, '手元へ流したときに突き合わせを回していない').toBeGreaterThan(0)
      expect(remote.every((e) => !argsOf(e).includes('--local')), '本番へ流したのに手元を突き合わせている').toBe(true)
      expect(local.every((e) => argsOf(e).includes('--local')), '手元へ流したのに本番を突き合わせている').toBe(true)
    })
  })

  describe('REQ-564 学びの次の引数が手元の保存先へ流す指定でなければ、門も控えも回さず何も流さずに断る', () => {
    // @covers REQ-564#not-local-flag
    it('学びの次に手元へ流す指定でない引数（打ち間違えた指定・指定でない語・本番を名指す指定）を渡すと、門も控えも回さず、どの保存先にも触れずに失敗で終わる', () => {
      for (const name of ['mistyped', 'otherWord', 'otherFlag']) {
        const r = run(name)
        expect(r.code, `${name}: 成功で終わった:\n${tail(r)}`).not.toBe(0)
        expect(toolRuns(r, 'check_seed'), `${name}: 流す前の投入の検査を回している`).toEqual([])
        expect(storageCalls(r), `${name}: 保存先に触れている（構造の変更の確かめ・控え・投入）:\n${tail(r)}`).toEqual([])
        expectNothingFlowed(r, name)
      }
    })

    // @covers REQ-564#before-seed-missing
    it('投入が書き出されていない学びに打ち間違えた指定を渡しても、門も控えも回さず、どの保存先にも触れずに失敗で終わる', () => {
      const r = run('mistypedUnseeded')
      expect(r.code, `成功で終わった:\n${tail(r)}`).not.toBe(0)
      expect(toolRuns(r, 'check_seed'), '流す前の投入の検査を回している').toEqual([])
      expect(storageCalls(r), '保存先に触れている').toEqual([])
      expectNothingFlowed(r, 'mistypedUnseeded')
    })
  })
})
