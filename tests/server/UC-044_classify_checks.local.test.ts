import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  INDIRECT_TEST,
  LOCAL_UC,
  PORTABLE_UC,
  type Run,
  type Shadow44,
  classifyChecks,
  groupsOf,
  makeShadow,
  outOf,
  probeTest,
  ran,
  removeTemps,
  runPortableChecks,
} from './UC-044_fixture.local'

/** UC-044 検査の振り分けを確かめる道具の境界（classifyChecks ＝ `scripts/classify_checks.*`）と、名前と中身の食い違いで止まること
 *  （REQ-679。手元に依らない検査 runPortableChecks ＝ `scripts/run_portable_checks.*` でも見る）。入口の引き方と影の根は UC-044_fixture.local.ts。
 *  振り分けは、名前を含む行が置かれた組（用語集の語「手元だけ」「手元に依らない」。読み方は groupsOf）で読む。
 *  食い違いは、終了の状態と、挙げた物の名前が出力に出ることで見る（文言は照らさない）。 */

vi.setConfig({ testTimeout: 600_000 })

afterAll(async () => {
  await removeTemps()
})

const base = (rel: string) => rel.split('/').pop() ?? rel
const group = (r: Run, name: string) => [...groupsOf(r.out, name)]

/** 振り分けが通って、name がちょうど g の組にだけ出る。 */
function expectIn(r: Run, name: string, g: 'local' | 'portable') {
  expect(r.status, outOf(r)).toBe(0)
  expect(group(r, name), `「${name}」の組\n${outOf(r)}`).toEqual([g])
}

/** 失敗で終え、names をすべて挙げる。 */
function expectFailedNaming(r: Run, ...names: string[]) {
  expect(r.status, outOf(r)).toBe(1)
  for (const n of names) expect(r.out, `「${n}」を挙げていない\n${outOf(r)}`).toContain(n)
}

/** 手元の物を使うのに、手元の物の土台の名前を持たない土台（中身は関数の中にあり、読み込んでも何も起こさない）。 */
const unnamedFixture = (body: string) => `import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function useLocal(root: string): unknown {
  void spawnSync, existsSync, readFileSync, homedir, join, root
  ${body}
}
`
/** 土台 fixture を読み込む、手元に依らない名前のテスト（土台を土台として使う形にする）。 */
const userOf = (fixture: string, mark: string) => probeTest(mark, { imports: [`import { useLocal } from './${base(fixture).replace(/\.ts$/, '')}'`, 'void useLocal'] })

describe('UC-044 手元に依らない検査を共有の置き場で回し、手元に依る検査を手元の入口に受け持たせる', () => {
  describe('検査の振り分けは、手元の物の土台を直にか間接に読み込む物を手元だけに、ほかを手元に依らない物に分ける（REQ-678）', () => {
    // @covers REQ-678#direct-import-local
    it('手元の物の土台を直に読み込むテストのファイルは、手元だけに分ける', () => {
      const s = makeShadow()
      expectIn(classifyChecks(s), base(s.localTest), 'local')
    })

    // @covers REQ-678#indirect-import-local
    it('手元の物の土台を読み込む別の土台を通して読み込むテストのファイルは、手元だけに分ける', () => {
      const s = makeShadow({ indirect: true })
      expectIn(classifyChecks(s), base(INDIRECT_TEST), 'local')
    })

    // @covers REQ-678#no-local-portable
    it('手元の物の土台を読み込まないテストのファイルは、手元に依らない物に分ける', () => {
      const s = makeShadow()
      expectIn(classifyChecks(s), base(s.portableTest), 'portable')
    })

    // @covers REQ-678#handler-local
    it('手元の物の土台を読み込む受け持ちの UC は、手元だけに分ける', () => {
      const s = makeShadow()
      expectIn(classifyChecks(s), LOCAL_UC, 'local')
    })

    // @covers REQ-678#each-once
    it('どのテストのファイルと受け持ちも、2 つのどちらか一方にだけ現れ、漏れが無い', () => {
      const s = makeShadow({ indirect: true })
      const r = classifyChecks(s)
      expect(r.status, outOf(r)).toBe(0)
      for (const name of [s.localTest, s.portableTest, INDIRECT_TEST].map(base).concat([LOCAL_UC, PORTABLE_UC]))
        expect(group(r, name).length, `「${name}」が出る組の数\n${outOf(r)}`).toBe(1)
    })
  })

  describe('テストのファイルと土台の名前が、読み込む物・使う物と食い違えば、すべて挙げて、どのテストも回さずに失敗で終える（REQ-679）', () => {
    // @covers REQ-679#local-import-unnamed
    it('手元の物の土台を読み込むのに手元だけの名前を持たないテストのファイルを挙げて失敗で終える', () => {
      const name = 'tests/server/probe_unnamed.test.ts'
      const s = makeShadow({ files: { [name]: probeTest('unnamed', { imports: ["import { PROBE } from './probe_fixture.local'", 'void PROBE'] }) } })
      expectFailedNaming(classifyChecks(s), base(name))
    })

    // @covers REQ-679#local-name-no-import
    it('手元だけの名前を持つのに手元の物の土台を読み込まないテストのファイルを挙げて失敗で終える', () => {
      const name = 'tests/server/probe_nolocal.local.test.ts'
      const s = makeShadow({ files: { [name]: probeTest('nolocal') } })
      expectFailedNaming(classifyChecks(s), base(name))
    })

    // @covers REQ-679#sandbox-fixture-unnamed
    it('macOS の囲いを起こすのに手元の物の土台の名前を持たない土台を挙げて失敗で終える', () => {
      const fixture = 'tests/server/probe_sandbox_fixture.ts'
      const s = makeShadow({
        files: {
          [fixture]: unnamedFixture("return spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', 'true'])"),
          'tests/server/probe_sandbox.test.ts': userOf(fixture, 'sandbox'),
        },
      })
      expectFailedNaming(classifyChecks(s), base(fixture))
    })

    // @covers REQ-679#local-deploy-fixture-unnamed
    it('手元の配備を起こすか手元の保存先を読むのに手元の物の土台の名前を持たない土台を挙げて失敗で終える', () => {
      const deploy = 'tests/server/probe_deploy_fixture.ts'
      const storage = 'tests/server/probe_storage_fixture.ts'
      const s = makeShadow({
        files: {
          [deploy]: unnamedFixture("return spawnSync('npx', ['wrangler', 'dev', '--port', '8799'])"),
          'tests/server/probe_deploy.test.ts': userOf(deploy, 'deploy'),
          [storage]: unnamedFixture("return existsSync(join(root, '.wrangler', 'state', 'v3', 'd1'))"),
          'tests/server/probe_storage.test.ts': userOf(storage, 'storage'),
        },
      })
      expectFailedNaming(classifyChecks(s), base(deploy), base(storage))
    })

    // @covers REQ-679#untracked-fixture-unnamed
    it('リポジトリが追跡しないファイルを読むのに手元の物の土台の名前を持たない土台を挙げて失敗で終える', () => {
      const home = 'tests/server/probe_home_fixture.ts'
      const ignored = 'tests/server/probe_ignored_fixture.ts'
      const s = makeShadow({
        files: {
          [home]: unnamedFixture("return readFileSync(join(homedir(), '.claude/brain/INDEX.md'), 'utf8')"),
          'tests/server/probe_home.test.ts': userOf(home, 'home'),
          [ignored]: unnamedFixture("return readFileSync(join(root, '.claude/settings.local.json'), 'utf8')"),
          'tests/server/probe_ignored.test.ts': userOf(ignored, 'ignored'),
        },
      })
      expectFailedNaming(classifyChecks(s), base(home), base(ignored))
    })

    // @covers REQ-679#all-cases-fixture-unnamed
    it('契約の実例の確かめを UC を絞らずに起こすのに手元の物の土台の名前を持たない土台を挙げて失敗で終える', () => {
      const fixture = 'tests/server/probe_allcases_fixture.ts'
      const s = makeShadow({
        files: {
          [fixture]: unnamedFixture("return spawnSync('npm', ['run', 'contract-run', '--', '--json'], { cwd: root })"),
          'tests/server/probe_allcases.test.ts': userOf(fixture, 'allcases'),
        },
      })
      expectFailedNaming(classifyChecks(s), base(fixture))
    })

    // @covers REQ-679#all-listed-none-ran
    it('食い違いが 2 つの種類にあると両方を挙げ、手元に依らない検査を回すときもどのテストも回さない', () => {
      const test = 'tests/server/probe_unnamed.test.ts'
      const fixture = 'tests/server/probe_sandbox_fixture.ts'
      const s: Shadow44 = makeShadow({
        files: {
          [test]: probeTest('unnamed', { imports: ["import { PROBE } from './probe_fixture.local'", 'void PROBE'] }),
          [fixture]: unnamedFixture("return spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', 'true'])"),
          'tests/server/probe_sandbox.test.ts': userOf(fixture, 'sandbox'),
        },
      })
      const r = runPortableChecks(s)
      expectFailedNaming(r, base(test), base(fixture))
      for (const mark of ['portable', 'local', 'local-fixture', 'unnamed', 'sandbox']) expect(ran(s, mark), `テスト（${mark}）が回った`).toBe(false)
    })
  })
})
