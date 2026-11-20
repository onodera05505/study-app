import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { HOOKS, executable, gitConfig, makeClone, removeTemps, runInstall, userConfig } from './UC-043_fixture'

/** UC-043 コミットの件名の検査を入れる道具（installGithooks ＝ `bash scripts/install_githooks.sh`）の境界。
 *  一時の置き場に git init した別のクローン（UC-043_fixture.ts）で回し、作業ツリーと本体の git の設定には触らない。 */

afterAll(async () => {
  await removeTemps()
})

describe('UC-043 手元のクローンにコミットの件名の検査を入れる', () => {
  describe('フックを実行できるようにし、このクローンのフックの置き場を向け、向けた先と試し方を示す（REQ-652）', () => {
    // @covers REQ-652#hooks-made-executable
    it('実行できない印のフックが、実行できるようになる', () => {
      const c = makeClone()
      expect(Object.values(executable(c)).some((x) => x), '仕込み: 実行できるフックが既にある').toBe(false)
      const r = runInstall(c)
      expect(r.status, r.out).toBe(0)
      const after = executable(c)
      expect(Object.keys(after).length).toBeGreaterThan(0)
      expect(Object.entries(after).filter(([, x]) => !x).map(([n]) => n), '実行できないままのフック').toEqual([])
    })

    // @covers REQ-652#hooks-path-set
    it('このクローンのフックの置き場が、リポジトリの中の置き場に向き、成功で終える', () => {
      const c = makeClone()
      expect(gitConfig(c, 'core.hooksPath'), '仕込み: 既に向いている').toBeNull()
      const r = runInstall(c)
      expect(r.status, r.out).toBe(0)
      expect(gitConfig(c, 'core.hooksPath')).toBe(HOOKS)
    })

    // @covers REQ-652#target-and-try-shown
    it('向けた先と、件名の検査のフック（commit-msg）の試し方を示す', () => {
      const c = makeClone()
      const r = runInstall(c)
      expect(r.status, r.out).toBe(0)
      expect(r.out, '向けた先を示していない').toContain(HOOKS)
      expect(r.out, '件名の検査のフックの試し方を示していない').toContain('commit-msg')
    })

    // @covers REQ-652#already-pointed
    it('既に向いているクローンで回しても、成功で終え、向きは 1 つのまま変わらない', () => {
      const c = makeClone()
      expect(runInstall(c).status).toBe(0)
      const r = runInstall(c)
      expect(r.status, r.out).toBe(0)
      const all = spawnSync('git', ['-C', c.dir, 'config', '--local', '--get-all', 'core.hooksPath'], { env: c.env, encoding: 'utf8' })
      expect(all.stdout.trim().split('\n')).toEqual([HOOKS])
    })

    // @covers REQ-652#only-this-clone
    it('利用者の git の設定（このクローンの外）は書き換えない', () => {
      const c = makeClone()
      const before = userConfig(c)
      const r = runInstall(c)
      expect(r.status, r.out).toBe(0)
      expect(userConfig(c)).toBe(before)
    })
  })
})
