import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_FIXTURE,
  type Run,
  type Shadow44,
  calls,
  makeShadow,
  outOf,
  ran,
  removeTemps,
  runCasesCalls,
  runPortableChecks,
} from './UC-044_fixture.local'

/** UC-044 手元に依らない検査を回す道具の境界（runPortableChecks ＝ `scripts/run_portable_checks.*`。入口の引き方は UC-044_fixture.local.ts）。
 *  影の根の小さな作業ツリー（手元に依らないテスト 1 つ・手元だけのテスト 1 つ・手元に依らない UC と手元だけの UC の受け持ち 1 つずつ）で回し、
 *  終了の状態・出力・影の根に残った跡（テストの印と、テスト以外の検査の記録係の記録）を見る。 */

vi.setConfig({ testTimeout: 600_000 })

afterAll(async () => {
  await removeTemps()
})

/** 原本 harness の呼び出しのうち、argv に words をすべて持つ物。 */
const harnessWith = (s: Shadow44, ...words: string[]) => calls(s).filter((c) => c.tool === 'harness' && words.every((w) => c.argv.includes(w)))
const UC_ID = /\bUC-\d{3}\b/

const failedWith = (r: Run) => {
  expect(r.status, outOf(r)).toBe(1)
}

describe('UC-044 手元に依らない検査を共有の置き場で回し、手元に依る検査を手元の入口に受け持たせる', () => {
  describe('手元に依らない検査は、手元に依らない物だけを回し、手元だけの物の名前を示す（REQ-677）', () => {
    // @covers REQ-677#portable-ran
    it('手元に依らないテストのファイルと UC の契約の実例が回り、それが通れば成功で終える', () => {
      const s = makeShadow()
      const r = runPortableChecks(s)
      expect(r.status, outOf(r)).toBe(0)
      expect(ran(s, 'portable'), '手元に依らないテストが回っていない').toBe(true)
      expect(
        runCasesCalls(s).some((c) => c.argv.includes(s.portableUc)),
        `手元に依らない UC の契約の実例を回していない: ${JSON.stringify(runCasesCalls(s))}`,
      ).toBe(true)
    })

    // @covers REQ-677#local-not-ran
    it('手元だけのテストのファイルと UC の契約の実例と実行の記録の門は回らない', () => {
      const s = makeShadow()
      const r = runPortableChecks(s)
      expect(r.status, outOf(r)).not.toBeNull()
      expect(ran(s, 'local'), '手元だけのテストが回った').toBe(false)
      expect(ran(s, 'local-fixture'), `手元の物の土台（${LOCAL_FIXTURE}）が読み込まれた`).toBe(false)
      const cases = runCasesCalls(s)
      expect(
        cases.filter((c) => c.argv.includes(s.localUc)),
        '手元だけの UC の契約の実例を回した',
      ).toEqual([])
      expect(
        cases.filter((c) => !c.argv.some((a) => UC_ID.test(a))),
        'UC を絞らずに契約の実例の確かめを回した（手元だけの UC の実例も回る）',
      ).toEqual([])
      expect(harnessWith(s, 'coverage'), '実行の記録の門を回した').toEqual([])
    })

    // @covers REQ-677#local-named
    it('回さなかった手元だけのテストのファイル・UC・実行の記録の門の名前を示す', () => {
      const s = makeShadow()
      const r = runPortableChecks(s)
      expect(r.status, outOf(r)).not.toBeNull()
      for (const name of [s.localTest, s.localUc, 'coverage']) expect(r.out, `「${name}」を示していない\n${outOf(r)}`).toContain(name)
    })

    // @covers REQ-677#spec-and-static-ran
    it('仕様と紐づきの検査・入口の一覧の突き合わせ・型・静的な門が回る', () => {
      const s = makeShadow()
      const r = runPortableChecks(s)
      expect(r.status, outOf(r)).not.toBeNull()
      const seen = calls(s)
      const spec = seen.some(
        (c) => c.tool === 'harness' && c.argv.includes('lint') && (c.argv.includes('spec') || c.argv.includes('refs') || c.argv.includes('verify')),
      )
      expect(spec, `仕様と紐づきの検査（原本の lint spec・lint refs）を回していない: ${JSON.stringify(seen)}`).toBe(true)
      expect(seen.some((c) => c.tool === 'list_entries'), '入口の一覧（commands.list_entries）を出していない').toBe(true)
      expect(harnessWith(s, 'lint', 'entries').length, '入口の一覧の突き合わせ（原本の lint entries）を回していない').toBeGreaterThan(0)
      expect(seen.some((c) => c.tool === 'typecheck'), '型（commands.typecheck）を回していない').toBe(true)
      expect(seen.some((c) => c.tool === 'check_source'), '静的な門（check_source）を回していない').toBe(true)
      expect(seen.some((c) => c.tool === 'check_docs'), '静的な門（check_docs）を回していない').toBe(true)
    })

    // @covers REQ-677#portable-failure-fails
    it('手元に依らないテストが 1 つ落ちると、失敗で終える', () => {
      const s = makeShadow({ portableFails: true })
      const r = runPortableChecks(s)
      expect(ran(s, 'portable'), '手元に依らないテストが回っていない').toBe(true)
      failedWith(r)
    })
  })
})
