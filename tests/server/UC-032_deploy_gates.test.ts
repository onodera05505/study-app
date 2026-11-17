import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ACCOUNT,
  MIGRATIONS,
  OTHER_ACCOUNT,
  REGISTRY_KEYS,
  type Run,
  type ShadowOptions,
  type StorageSpec,
  type Tool,
  type World,
  deployRuns,
  indexOf,
  inBatches,
  makeShadow,
  removeShadows,
  runProcedure,
  tail,
  toolRuns,
} from './UC-032_fixture'

/**
 * UC-032 学び側の配備の手続き（入口 `bash scripts/deploy-pages.sh <学び>`。契約の操作ではない）が、配信の前に
 * 配備のアカウント・本番の保存先の構造の変更・ロードマップ型の回を確かめ、ソースの門・登録簿の門・文書の索引の門・
 * 実データの描画の検査を回して、すべて通ったときだけ配信すること（REQ-558〜562）。
 *
 * 土台は `UC-032_fixture.ts`。門と描画の検査は、決めた終了の状態で返す包み（正本の形はそれぞれの契約）。
 * 本番の保存先は偽の SQLite で、学ぶ順を持つ論点は `topics.sort_order` が入った行、回は `topics.round`。
 * 学びは登録簿にある資格対策の学び ip と、ロードマップ型の学び eng、登録簿に無い zzz。
 */

const QUALIFICATION = 'ip'
const ROADMAP = 'eng'
const UNKNOWN = 'zzz'

/** 学ぶ順を持つ論点の数（示された数を出力から見分けられるよう、ほかに出にくい数にする）。 */
const ORDERED = 37
const ordered = (missingRounds = 0): StorageSpec['topics'] =>
  Array.from({ length: ORDERED }, (_, i) => ({ sortOrder: i + 1, round: i < missingRounds ? null : String(Math.floor(i / 8) + 1) }))

/** 学ぶ順を持つ論点のうち回の無い論点の数（示された数を見分けられるよう、出力に出にくい数にする）。 */
const MISSING = 23
/** 学ぶ順を持たず回も無い論点（回の無い論点の数に入らない）。 */
const UNORDERED_NO_ROUND = 6
const unordered: NonNullable<StorageSpec['topics']> = Array.from({ length: UNORDERED_NO_ROUND }, () => ({ sortOrder: null, round: null }))
/** 前後が数字・区切り（時刻や日付の : - / .）でない 10 進の数として出ているか。 */
const shows = (out: string, n: number) => new RegExp(`(?<![\\d.:/-])${n}(?![\\d.:/-])`).test(out)

const GATES: Tool[] = ['check_source', 'check_roadmap_registry', 'check_docs', 'check_render']

type Input = { name: string; learning: string; world?: World; remote?: StorageSpec }

const inputs: Input[] = [
  { name: 'unknown', learning: UNKNOWN },
  { name: 'otherAccount', learning: QUALIFICATION, world: { whoami: 'other' } },
  { name: 'accountUnverifiable', learning: QUALIFICATION, world: { whoami: 'fail' } },
  { name: 'pending', learning: QUALIFICATION, remote: { applied: MIGRATIONS.length - 1 } },
  { name: 'migrationsUnverifiable', learning: QUALIFICATION, world: { migrationsFail: true } },
  ...GATES.map((g): Input => ({ name: `${g}Stops`, learning: QUALIFICATION, world: { modes: { [g]: 'fail' } } })),
  { name: 'qualificationOk', learning: QUALIFICATION, remote: { topics: [] } },
  { name: 'roadmapOk', learning: ROADMAP, remote: { topics: ordered() } },
  { name: 'roundMissing', learning: ROADMAP, remote: { topics: ordered(1) } },
  { name: 'manyRoundsMissing', learning: ROADMAP, remote: { topics: [...(ordered(MISSING) ?? []), ...unordered] } },
  { name: 'roundsUnreadable', learning: ROADMAP, remote: { topics: ordered() }, world: { queryFail: true } },
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
      const opts: ShadowOptions = { copy: ['scripts', 'src', 'public', 'portal'], remote: input.remote }
      const shadow = makeShadow(`deploy-${input.name}`, opts)
      runs[input.name] = await runProcedure(shadow, 'deploy-pages.sh', [input.learning], input.world)
    }),
    4,
  )
}, 600_000)

afterAll(async () => {
  await removeShadows()
}, 120_000)

const expectNotDelivered = (r: Run, label: string) => {
  expect(deployRuns(r), `${label}: 配信している:\n${tail(r)}`).toEqual([])
  expect(r.code, `${label}: 配信せずに成功で終わった:\n${tail(r)}`).not.toBe(0)
}

describe('UC-032 配備と投入の前に門を回し、通らない物を本番に出さない（学び側の配備の手続き）', () => {
  describe('REQ-558 登録簿に無い学びは、学びの一覧を示し、門を回さず配信しないまま断る', () => {
    // @covers REQ-558#unknown-learning
    it('登録簿に無い学びを渡すと、登録簿の学びの key をすべて示し、門を 1 つも回さず、配信しないまま失敗で終わる', () => {
      const r = run('unknown')
      expectNotDelivered(r, '登録簿に無い学び')
      for (const g of GATES) expect(toolRuns(r, g), `${g} を回している`).toEqual([])
      const missing = REGISTRY_KEYS.filter((k) => !new RegExp(`\\b${k}\\b`).test(r.out))
      expect(missing, `登録簿の学びの一覧に出ていない key がある:\n${tail(r)}`).toEqual([])
    })
  })

  describe('REQ-559 ログイン中のアカウントが決めた配備のアカウントと違うか確かめられなければ、両方を示して配信しない', () => {
    // @covers REQ-559#other-account
    it('配備先に決めたアカウントと違うアカウントでログインしていると、両方のアカウントを示し、配信しないまま失敗で終わる', () => {
      const r = run('otherAccount')
      expectNotDelivered(r, '違うアカウント')
      expect(r.out, 'ログイン中のアカウントを示していない').toContain(OTHER_ACCOUNT)
      expect(r.out, '決めたアカウントを示していない').toContain(ACCOUNT)
    })

    // @covers REQ-559#account-unverifiable
    it('ログイン中のアカウントを確かめられないと、決めたアカウントを示し、配信しないまま失敗で終わる', () => {
      const r = run('accountUnverifiable')
      expectNotDelivered(r, '確かめられないアカウント')
      expect(r.out, '決めたアカウントを示していない').toContain(ACCOUNT)
    })
  })

  describe('REQ-560 構造の変更が当たっていないか確かめられないか、門か描画の検査が止めたら配信しない', () => {
    // @covers REQ-560#unapplied-migration
    it('本番の保存先に当たっていない構造の変更が 1 つあると、配信しないまま失敗で終わる', () => {
      expectNotDelivered(run('pending'), '当たっていない構造の変更')
    })

    // @covers REQ-560#migrations-unverifiable
    it('本番の保存先の構造の変更を確かめられないと、配信しないまま失敗で終わる', () => {
      expectNotDelivered(run('migrationsUnverifiable'), '確かめられない構造の変更')
    })

    // @covers REQ-560#source-gate-stops
    it('ソースの門が止めると、配信しないまま失敗で終わる', () => {
      const r = run('check_sourceStops')
      expect(toolRuns(r, 'check_source').length, `仕込み: ソースの門を回していない:\n${tail(r)}`).toBeGreaterThan(0)
      expectNotDelivered(r, 'ソースの門')
    })

    // @covers REQ-560#registry-gate-stops
    it('その学びの登録簿の門が止めると、配信しないまま失敗で終わる', () => {
      const r = run('check_roadmap_registryStops')
      const calls = toolRuns(r, 'check_roadmap_registry')
      expect(calls.length, `仕込み: 登録簿の門を回していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(calls.some((e) => (Array.isArray(e.argv) ? e.argv : [e.argv]).includes(QUALIFICATION)), '登録簿の門にその学びを渡していない').toBe(true)
      expectNotDelivered(r, '登録簿の門')
    })

    // @covers REQ-560#docs-index-gate-stops
    it('文書の索引の門が止めると、配信しないまま失敗で終わる', () => {
      const r = run('check_docsStops')
      expect(toolRuns(r, 'check_docs').length, `仕込み: 文書の索引の門を回していない:\n${tail(r)}`).toBeGreaterThan(0)
      expectNotDelivered(r, '文書の索引の門')
    })

    // @covers REQ-560#render-check-stops
    it('実データの描画の検査が止めると、配信しないまま失敗で終わる', () => {
      const r = run('check_renderStops')
      expect(toolRuns(r, 'check_render').length, `仕込み: 描画の検査を回していない:\n${tail(r)}`).toBeGreaterThan(0)
      expectNotDelivered(r, '描画の検査')
    })
  })

  describe('REQ-561 資格対策の学びは回を見ずに通し、ロードマップ型は学ぶ順を持つ論点のすべてに回があれば数を示して通す', () => {
    // @covers REQ-561#qualification-no-round-check
    it('資格対策の学びは、門がすべて通れば、回を確かめる物が無いとして配信する', () => {
      const r = run('qualificationOk')
      expect(deployRuns(r).length, `配信していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(r.code, `配信したのに成功で終わらない:\n${tail(r)}`).toBe(0)
    })

    // @covers REQ-561#roadmap-all-rounds
    it('ロードマップ型の学びは、学ぶ順を持つ論点のすべてに回があれば、その論点の数を示し、門がすべて通ったあとに配信する', () => {
      const r = run('roadmapOk')
      const deployed = deployRuns(r)
      expect(deployed.length, `配信していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(r.code, `配信したのに成功で終わらない:\n${tail(r)}`).toBe(0)
      expect(r.out, `学ぶ順を持つ論点の数（${ORDERED}）を示していない`).toMatch(new RegExp(`\\b${ORDERED}\\b`))
      const first = Math.min(...deployed.map((e) => indexOf(r, e)))
      for (const g of GATES) {
        const calls = toolRuns(r, g)
        expect(calls.length, `${g} を回していない`).toBeGreaterThan(0)
        expect(Math.max(...calls.map((e) => indexOf(r, e))), `${g} が配信より後`).toBeLessThan(first)
      }
    })
  })

  describe('REQ-562 ロードマップ型で回の無い論点があるか回を読めなければ、配信しないまま失敗で終える', () => {
    // @covers REQ-562#round-missing
    it('学ぶ順を持つ論点のうち 1 つにだけ回が無いと、配信しないまま失敗で終わる', () => {
      expectNotDelivered(run('roundMissing'), '回の無い論点')
    })

    // @covers REQ-562#rounds-unreadable
    it('本番の保存先から論点の回を読めないと、配信しないまま失敗で終わる', () => {
      expectNotDelivered(run('roundsUnreadable'), '回を読めない')
    })

    // @covers REQ-562#missing-count-shown
    it('学ぶ順を持つ論点のうち複数に回が無いと、学ぶ順を持たない論点を数に入れずに、回の無い論点の数を示す', () => {
      const r = run('manyRoundsMissing')
      expect(MISSING, '仕込み: 回の無い論点が複数でない').toBeGreaterThan(1)
      expect(MISSING, '仕込み: 回のある論点が残っていない').toBeLessThan(ORDERED)
      expect(shows(r.out, MISSING), `学ぶ順を持つ論点のうち回の無い論点の数（${MISSING}）を示していない:\n${tail(r)}`).toBe(true)
      expect(shows(r.out, MISSING + UNORDERED_NO_ROUND), `学ぶ順を持たない論点まで数えた数（${MISSING + UNORDERED_NO_ROUND}）を示している:\n${tail(r)}`).toBe(false)
    })
  })
})
