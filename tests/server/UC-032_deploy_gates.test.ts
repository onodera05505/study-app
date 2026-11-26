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
  type LogEntry,
  type World,
  argsOf,
  deployRuns,
  indexOf,
  inBatches,
  makeShadow,
  removeShadows,
  runProcedure,
  tail,
  toolRuns,
  withoutPinnedTool,
} from './UC-032_fixture'

/**
 * UC-032 学び側の配備の手続き（入口 `bash scripts/deploy-pages.sh <学び>`。契約の操作ではない）が、配信の前に
 * 配備のアカウント・本番の保存先の構造の変更・ロードマップ型の回を確かめ、ソースの門・登録簿の門・文書の索引の門・
 * 実データの描画の検査を回して、すべて通ったときだけ配信すること（REQ-558〜562）。
 *
 * 土台は `UC-032_fixture.ts`。門と描画の検査は、決めた終了の状態で返す包み（正本の形はそれぞれの契約）。
 * 本番の保存先は偽の SQLite で、学ぶ順を持つ論点は `topics.sort_order` が入った行、回は `topics.round`。
 * 学びは登録簿にある資格対策の学び ip と、ロードマップ型の学び eng、登録簿に無い zzz。
 * 固定した版の配備の道具が無い入力は、影の根から固定した版を除いて別の版の偽物だけを残し、npx の呼び出しも記録する（withoutPinnedTool）。
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

type Input = { name: string; learning: string; world?: World; remote?: StorageSpec; pinned?: false }

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
  { name: 'severalAccounts', learning: QUALIFICATION, world: { whoami: 'several' } },
  // ログイン中の並びは決めたアカウント（whoami の既定）のまま、向け先のアカウントの環境変数だけを違う値にする
  { name: 'envAccountDiffers', learning: QUALIFICATION, world: { accountEnv: OTHER_ACCOUNT } },
  // 環境変数を与えず、固定した版の道具を除く（ログイン中の並びは決めたアカウントのまま）
  { name: 'pinnedToolMissing', learning: QUALIFICATION, pinned: false },
  // 向け先のアカウントの環境変数を違う値にし、固定した版の道具を除く
  { name: 'envAccountDiffersWithoutPinnedTool', learning: QUALIFICATION, world: { accountEnv: OTHER_ACCOUNT }, pinned: false },
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
      if (input.pinned === false) withoutPinnedTool(shadow)
      // 向け先のアカウントの環境変数（CLOUDFLARE_ACCOUNT_ID）は、与える入力のほかは子に渡さない
      runs[input.name] = await runProcedure(shadow, 'deploy-pages.sh', [input.learning], { accountEnv: null, ...input.world })
    }),
    4,
  )
}, 600_000)

afterAll(async () => {
  await removeShadows()
}, 120_000)

const isWrangler = (e: LogEntry) => e.tool === 'pinned' || e.tool === 'unpinned'
/** 照らす問い合わせ（固定した版の wrangler whoami。REQ-351）。 */
const isCheck = (e: LogEntry) => e.tool === 'pinned' && argsOf(e)[0] === 'whoami'
const checkAt = (r: Run) => r.log.findIndex(isCheck)
/** 照らす問い合わせのほかに呼んだ物（配備の道具のどの版も・版の問い合わせも・npx も・門も・組み立ても・配信も）。 */
const actions = (r: Run) => r.log.filter((e) => !isCheck(e))
const describeActions = (r: Run) => actions(r).map((e) => `${e.tool} ${argsOf(e).slice(0, 3).join(' ')}`).join('\n')

const expectNotDelivered = (r: Run, label: string) => {
  expect(deployRuns(r), `${label}: 配信している:\n${tail(r)}`).toEqual([])
  expect(r.code, `${label}: 配信せずに成功で終わった:\n${tail(r)}`).not.toBe(0)
}

/** 照らす問い合わせ（checks 回。0 か 1）のほかは何もせず、配信しないまま失敗で終えた。 */
const refusedForAccount = (r: Run, label: string, checks: 0 | 1) => {
  expectNotDelivered(r, label)
  expect(r.log.filter(isCheck).length, `${label}: 照らす問い合わせの回数が違う:\n${tail(r)}`).toBe(checks)
  expect(actions(r).length, `${label}: 照らすほかに何かをした:\n${describeActions(r)}`).toBe(0)
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

  describe('REQ-559 向け先かログイン中のアカウントが決めたアカウントと違うか、固定した版の道具が無いか確かめられなければ、照らすほかは何もせず配信しない', () => {
    // @covers REQ-559#other-account
    it('決めたアカウントと違うアカウントだけでログインしていると、両方のアカウントを示し、照らす 1 回のほかは何もせずに、配信しないまま失敗で終わる', () => {
      const r = run('otherAccount')
      refusedForAccount(r, '違うアカウント', 1)
      expect(r.out.includes(OTHER_ACCOUNT), 'ログイン中のアカウントを示していない').toBe(true)
      expect(r.out.includes(ACCOUNT), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-559#account-unverifiable
    it('固定した版の道具は入っているが、ログイン中のアカウントを確かめられないと、決めたアカウントを示し、照らす 1 回のほかは配備の道具（版の問い合わせも）も門も呼ばずに、配信しないまま失敗で終わる', () => {
      const r = run('accountUnverifiable')
      refusedForAccount(r, '確かめられないアカウント', 1)
      expect(r.out.includes(ACCOUNT), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-559#pinned-tool-missing
    it('環境変数を与えず、固定した版の道具が無く別の版の道具だけがあると、確かめられないとして決めたアカウントを示し、どの版の道具も npx も門も呼ばずに、配信しないまま失敗で終わる', () => {
      const r = run('pinnedToolMissing')
      refusedForAccount(r, '固定した版の道具が無い', 0)
      expect(r.out.includes(ACCOUNT), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-559#several-accounts-listed
    it('ログイン中に 2 つのアカウントが見え、決めたアカウントが並びの 2 番目にあれば、合うとして、照らしたあとで配信の前の門（本番の保存先の構造の変更の確かめ）に進む', () => {
      const r = run('severalAccounts')
      const at = checkAt(r)
      expect(at, `アカウントを照らしていない:\n${tail(r)}`).toBeGreaterThanOrEqual(0)
      const gate = r.log.findIndex((e, i) => i > at && isWrangler(e) && argsOf(e)[0] === 'd1' && argsOf(e)[1] === 'migrations' && argsOf(e)[2] === 'list' && argsOf(e).includes('--remote'))
      expect(gate, `照らしたあとで配信の前の門に進んでいない:\n${tail(r)}`).toBeGreaterThan(at)
    })

    // @covers REQ-559#env-account-differs
    it('向け先のアカウントの環境変数が決めたアカウントと違えば、固定した版の道具が入っていてログイン中の並びに決めたアカウントがあっても、配備の道具を 1 回も呼ばず（版の問い合わせも）、門も組み立ても配信もしないまま、向け先と決めたアカウントを示して失敗で終わる', () => {
      const r = run('envAccountDiffers')
      refusedForAccount(r, '向け先のアカウントの環境変数が違う', 0)
      expect(r.out.includes(OTHER_ACCOUNT), '食い違ったアカウント（向け先のアカウント）を示していない').toBe(true)
      expect(r.out.includes(ACCOUNT), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-559#env-account-differs-without-pinned-tool
    it('向け先のアカウントの環境変数が決めたアカウントと違い、固定した版の道具が無く別の版の道具だけがあると、固定した版が無いことより先に向け先と決めたアカウントを示し、どの版の道具も npx も門も呼ばずに、配信しないまま失敗で終わる', () => {
      const r = run('envAccountDiffersWithoutPinnedTool')
      refusedForAccount(r, '向け先が違い固定した版の道具が無い', 0)
      expect(r.out.includes(OTHER_ACCOUNT), '食い違ったアカウント（向け先のアカウント）を示していない').toBe(true)
      expect(r.out.includes(ACCOUNT), '決めたアカウントを示していない').toBe(true)
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
