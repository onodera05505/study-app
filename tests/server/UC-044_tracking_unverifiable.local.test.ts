import { afterAll, describe, expect, it, vi } from 'vitest'
import { LOCAL_UC, PORTABLE_UC, type Run, classifyChecks, makeShadow, outOf, ran, removeTemps, runCasesCalls, runPortableChecks } from './UC-044_fixture.local'

/** UC-044 置き場がリポジトリの追跡する物を確かめられないとき、検査の振り分け（classifyChecks ＝ `scripts/classify_checks.*`）と
 *  手元に依らない検査（runPortableChecks ＝ `scripts/run_portable_checks.*`）が、理由を示して、どのテストも回さずに失敗で終えること。
 *  入口の引き方と影の根（確かめられない置き場の 2 つの形も）は UC-044_fixture.local.ts。
 *  理由は、「追跡」の語が出て、名前と中身の食い違い（REQ-679）があるとも、その件数も示さないことで見る（文言は固定しない）。 */

vi.setConfig({ testTimeout: 600_000 })

afterAll(async () => {
  await removeTemps()
})

const KINDS = ['no-git', 'refused'] as const
const base = (rel: string) => rel.split('/').pop() ?? rel

/** 名前と中身の食い違いがあると示す行（その語を持つ物）と、その件数を示す行（「食い違い」の語と数を同じ行に持つ物）。 */
const mismatchLines = (r: Run) => r.out.split('\n').filter((l) => l.includes('名前と中身の食い違い') || (l.includes('食い違い') && /\d/.test(l)))

/** 失敗で終え、追跡を確かめられない理由を、食い違いの件数とは別に示す。 */
function expectUnverifiable(kind: string, r: Run) {
  expect(r.status, `${kind}\n${outOf(r)}`).toBe(1)
  expect(r.out, `${kind} 追跡を確かめられない理由を示していない\n${outOf(r)}`).toContain('追跡')
  expect(mismatchLines(r), `${kind} 追跡を確かめられないことを、名前と中身の食い違いとして示した\n${outOf(r)}`).toEqual([])
}

describe('UC-044 手元に依らない検査を共有の置き場で回し、手元に依る検査を手元の入口に受け持たせる', () => {
  describe('置き場がリポジトリの追跡する物を確かめられないとき、確かめられない理由を示して、どのテストも回さずに失敗で終える（REQ-682）', () => {
    // @covers REQ-682#classify-unverifiable-fails
    it('検査の振り分けを確かめると、確かめられない理由を示して失敗で終え、テストのファイルと UC の振り分けを示さない', () => {
      for (const kind of KINDS) {
        const s = makeShadow()
        s.unverifiable(kind)
        const r = classifyChecks(s)
        expectUnverifiable(kind, r)
        for (const name of [base(s.portableTest), base(s.localTest), PORTABLE_UC, LOCAL_UC])
          expect(r.out, `${kind} 「${name}」の振り分けを示した\n${outOf(r)}`).not.toContain(name)
      }
    })

    // @covers REQ-682#portable-unverifiable-none-ran
    it('手元に依らない検査を回すと、確かめられない理由を示し、どのテストも契約の実例も回さずに失敗で終える', () => {
      for (const kind of KINDS) {
        const s = makeShadow()
        s.unverifiable(kind)
        const r = runPortableChecks(s)
        expectUnverifiable(kind, r)
        for (const mark of ['portable', 'local', 'local-fixture']) expect(ran(s, mark), `${kind} テスト（${mark}）が回った`).toBe(false)
        expect(runCasesCalls(s), `${kind} 契約の実例を回した`).toEqual([])
      }
    })

    // @covers REQ-682#work-tree-root-passes
    it('置き場が git の作業ツリーの根で、git が索引を読み出せれば、この確かめでは失敗にしない', () => {
      const s = makeShadow()
      const classified = classifyChecks(s)
      expect(classified.status, `振り分け\n${outOf(classified)}`).toBe(0)
      const portable = runPortableChecks(s)
      expect(portable.status, `手元に依らない検査\n${outOf(portable)}`).toBe(0)
      expect(ran(s, 'portable'), '手元に依らないテストが回っていない').toBe(true)
    })
  })
})
