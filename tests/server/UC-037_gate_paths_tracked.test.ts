import { afterAll, describe, expect, it, vi } from 'vitest'
import { type Run, type TrackedShadow, crashed, removeTemps, trackedShadow } from './UC-037_tracked_fixture'

/** UC-037 文書の検査が、門の対応表の名指すパスをリポジトリが追跡しているかで照らすこと（checkDocs ＝ `python3 scripts/check_docs.py --root <根>`）。
 *  影の根は git の作業ツリー（UC-037_tracked_fixture.ts）。前提は影の根の門の対応表に行を足し、名指すファイルを置いて作る。
 *  観測は終了の状態と、挙げたパスが出力に出ること（文言は照らさない）。
 *  追跡を確かめられない置き場では、文書の検査が中で回す登録簿の整合も確かめられないと挙げるので、門の対応表の確かめが
 *  挙げた理由は、対応表の名前（不変条件と門）を含む行で見分ける（gateUnverifiableLines）。 */

vi.setConfig({ testTimeout: 300_000 })

afterAll(async () => {
  await removeTemps()
})

const GATES = 'docs/不変条件と門.md'

/** 門の対応表の末尾に、rel を名指す行を足す。 */
const nameInGates = (s: TrackedShadow, rel: string) =>
  s.write(GATES, `${s.read(GATES).replace(/\n*$/, '\n')}| Z98 | 仕込みの不変条件 | 仕込みの壊れ方 | \`${rel}\` | あり |\n`)

const out = (r: Run) => `終了 ${r.status}\n${r.out.slice(-3000)}`

/** 門の対応表の確かめが挙げた、追跡を確かめられない理由の行（対応表の名前と、追跡か確かめの語を同じ行に持つ物）。 */
const gateUnverifiableLines = (r: Run) => r.out.split('\n').filter((l) => l.includes('不変条件と門') && /追跡|確かめ/.test(l))

/** 根からの相対の書き方でない名指し（家の置き場・URL・画面や API の経路）。 */
const NON_RELATIVE = ['~/.claude/brain/check_return_line.py', 'https://developers.cloudflare.com/pages/', '/api/auth/sso']

describe('UC-037 配備の前に、文書の索引と門の対応表と決定の記録が現物と食い違っていないことを確かめる', () => {
  describe('門の対応表が名指すパスを、手元にあってもリポジトリが追跡していないか、置き場が追跡を確かめられなければ、そのパスか確かめられない理由を挙げて失敗で終える（REQ-680）', () => {
    // @covers REQ-680#gate-path-untracked
    it('門の対応表が、手元にあってリポジトリが追跡していないファイルを名指すと、そのパスを挙げて失敗で終える', () => {
      const s = trackedShadow()
      const rel = 'scripts/uc037_untracked_gate.py'
      s.write(rel, '# 仕込みの門\n')
      nameInGates(s, rel)
      expect(s.tracked(rel), '仕込み: 追跡していない').toBe(false)
      expect(s.ignored(rel), '仕込み: 無視する物でない').toBe(false)
      const r = s.checkDocs()
      expect(crashed(r), out(r)).toBe(false)
      expect(r.status, out(r)).toBe(1)
      expect(r.out, out(r)).toContain(rel)
    })

    // @covers REQ-680#gate-path-ignored
    it('名指すファイルが git の無視する物でも、そのパスを挙げて失敗で終える', () => {
      const s = trackedShadow()
      const rel = 'scripts/__pycache__/uc037_ignored_gate.py'
      s.write(rel, '# 仕込みの門\n')
      nameInGates(s, rel)
      expect(s.ignored(rel), '仕込み: 無視する物').toBe(true)
      expect(s.tracked(rel), '仕込み: 追跡していない').toBe(false)
      const r = s.checkDocs()
      expect(crashed(r), out(r)).toBe(false)
      expect(r.status, out(r)).toBe(1)
      expect(r.out, out(r)).toContain(rel)
    })

    // @covers REQ-680#gate-path-any-top-untracked
    it('名指すパスの先頭の置き場が何でも、手元にあってリポジトリが追跡していなければ、そのパスを挙げて失敗で終える', () => {
      for (const rel of ['.githooks/uc037_untracked_hook', 'tests/uc037_untracked_gate.ts', 'migrations/uc037_untracked_gate.sql', 'portal/uc037_untracked_gate.txt']) {
        const s = trackedShadow()
        s.write(rel, '仕込みの門\n')
        nameInGates(s, rel)
        expect(s.tracked(rel), `仕込み: ${rel} を追跡していない`).toBe(false)
        expect(s.ignored(rel), `仕込み: ${rel} は無視する物でない`).toBe(false)
        const r = s.checkDocs()
        expect(crashed(r), `${rel}\n${out(r)}`).toBe(false)
        expect(r.status, `${rel}\n${out(r)}`).toBe(1)
        expect(r.out, `${rel} を挙げていない\n${out(r)}`).toContain(rel)
      }
    })

    // @covers REQ-680#gate-path-tracked-passes
    it('門の対応表が名指すパスをすべてリポジトリが追跡していれば、この確かめでは失敗にしない', () => {
      const s = trackedShadow()
      const rel = 'scripts/uc037_tracked_gate.py'
      s.write(rel, '# 仕込みの門\n')
      s.track(rel)
      nameInGates(s, rel)
      expect(s.tracked(rel), '仕込み: 追跡している').toBe(true)
      const r = s.checkDocs()
      expect(crashed(r), out(r)).toBe(false)
      expect(r.status, out(r)).toBe(0)
      expect(r.out, out(r)).not.toContain(rel)
    })

    // @covers REQ-680#tracking-unverifiable-fails
    it('置き場が git の作業ツリーの根でないか、git が追跡の確かめを断ると、門の対応表の確かめが確かめられない理由を挙げて失敗で終える', () => {
      for (const kind of ['no-git', 'refused'] as const) {
        const s = trackedShadow()
        s.unverifiable(kind)
        const r = s.checkDocs()
        expect(crashed(r), `${kind}\n${out(r)}`).toBe(false)
        expect(r.status, `${kind}\n${out(r)}`).toBe(1)
        expect(gateUnverifiableLines(r).length, `${kind} 門の対応表（${GATES}）の確かめが、確かめられない理由を挙げていない\n${out(r)}`).toBeGreaterThan(0)
      }
    })

    // @covers REQ-680#gate-non-relative-not-read
    it('門の対応表が、/ で始まる物・~/ で始まる物・URL を名指しても、パスとして読まず、それでは失敗にしない', () => {
      for (const named of NON_RELATIVE) {
        const s = trackedShadow()
        nameInGates(s, named)
        const r = s.checkDocs()
        expect(crashed(r), `${named}\n${out(r)}`).toBe(false)
        expect(r.status, `${named}\n${out(r)}`).toBe(0)
        expect(r.out, `${named} を、無いか追跡していないパスとして挙げた\n${out(r)}`).not.toContain(named)
      }
    })
  })
})
