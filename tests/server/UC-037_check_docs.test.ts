import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { type Shadow, type ToolRun, crashed, removeTemps, runReal, toolShadow } from './UC-037_fixture'

/** UC-037 配備の前に文書を現物と照らす道具の境界。
 *  checkDocs ＝ `python3 scripts/check_docs.py [--root <根>]`、checkFeedbackLedger ＝ `python3 scripts/check_feedback_ledger.py`。
 *  前提は影の根（UC-037_fixture.ts）の文書を書き換えて作り、checkDocs には `--root` で影の根を渡す。
 *  観測は終了の状態と、挙げた物の名前が出力に出ること（文言は照らさない）。 */

vi.setConfig({ testTimeout: 300_000 })

afterAll(async () => {
  await removeTemps()
})

const INDEX = 'docs/文書の索引.md'
const GATES = 'docs/不変条件と門.md'
const PREMISES = 'brain/PREMISES.md'
const LEDGER = 'brain/feedback/審議台帳.md'
/** リポジトリに写した追跡の道具の置き場（docs/INVENTORY.md の「scripts/trace/*.mjs」）。 */
const TRACE_COPY = 'scripts/trace/stop_gate.mjs'

const checkDocs = (s: Shadow) => s.run('check_docs.py', ['--root', s.root])
const checkLedger = (s: Shadow) => s.run('check_feedback_ledger.py')

function expectFailedNaming(r: ToolRun, ...names: string[]) {
  expect(crashed(r), r.out).toBe(false)
  expect(r.status, r.out).toBe(1)
  for (const n of names) expect(r.out, `「${n}」を挙げていない`).toContain(n)
}

const append = (s: Shadow, rel: string, text: string) => s.write(rel, `${s.read(rel).replace(/\n*$/, '\n')}${text}\n`)

/** 審議台帳の頭（表の区切りの行まで）と、行。 */
const ledgerHead = (s: Shadow) => {
  const lines = s.read(LEDGER).split('\n')
  const sep = lines.findIndex((l) => /^\|\s*-+\s*\|/.test(l))
  return lines.slice(0, sep + 1).join('\n')
}
const row = (cells: string[]) => `| ${cells.join(' | ')} |`
/** 12 列の行（案・決定・規則だけを変える）。 */
const ledgerRow = (proposal: string, decision: string, rule: string) =>
  row(['11-19', 'テスト / uc037', '仕込みの指摘', 'UX', '再現', '反しない', '誰でも', '小', proposal, decision, rule, ''])
const writeLedger = (s: Shadow, rows: string[]) => s.write(LEDGER, `${ledgerHead(s)}\n${rows.join('\n')}\n`)

describe('UC-037 配備の前に、文書の索引と門の対応表と決定の記録が現物と食い違っていないことを確かめる', () => {
  describe('文書の検査は、食い違いをすべて挙げて失敗で終え、無ければ一致したことを示す（REQ-601）', () => {
    // @covers REQ-601#all-consistent
    it('今のリポジトリでは、食い違いが無く、一致したことを示して成功で終える', () => {
      const r = runReal('check_docs.py')
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).toBe(0)
      expect(r.stdout.trim().length, '一致したことを示していない').toBeGreaterThan(0)
    })

    // @covers REQ-601#doc-not-in-index
    it('文書の索引に無い文書が docs/ にあると、その文書を挙げて失敗で終える', () => {
      const s = toolShadow()
      s.write('docs/uc037_索引に無い文書.md', '# 索引に無い文書\n')
      expectFailedNaming(checkDocs(s), 'uc037_索引に無い文書.md')
    })

    // @covers REQ-601#report-not-in-index
    it('報告書の索引に無い報告書があると、その報告書を挙げて失敗で終える', () => {
      const s = toolShadow()
      s.write('brain/reports/99_uc037_索引に無い報告書.md', '# 索引に無い報告書\n')
      expectFailedNaming(checkDocs(s), '99_uc037_索引に無い報告書.md')
    })

    // @covers REQ-601#gate-path-missing
    it('門の対応表が名指すパスが無いと、そのパスを挙げて失敗で終える', () => {
      const s = toolShadow()
      append(s, GATES, '| Z99 | 仕込みの不変条件 | 仕込みの壊れ方 | `scripts/uc037_no_such_gate.py` | あり |')
      expectFailedNaming(checkDocs(s), 'uc037_no_such_gate.py')
    })

    // @covers REQ-601#spec-not-present-tense
    it('仕様書の本文に経緯の言い回し（「以前は」）があると、その仕様書を挙げて失敗で終える', () => {
      const s = toolShadow()
      const name = 'material_figures_spec.md'
      const rel = `scripts/prompts/${name}`
      const text = s.read(rel)
      // 本文の最初の見出しの直後に 1 文足す（末尾の改訂履歴には入れない）
      s.write(rel, text.replace(/\n/, '\n\n以前は図を描かなかった。\n'))
      expectFailedNaming(checkDocs(s), name)
    })

    // @covers REQ-601#decision-target-missing
    it('決定行の反映先が無いと、その反映先を挙げて失敗で終える', () => {
      const s = toolShadow()
      append(s, PREMISES, '- 2026-11-19 テストの仕込みの決定: 反映先の無い決定行。→ 反映: `scripts/uc037_no_such_target.py`')
      expectFailedNaming(checkDocs(s), 'uc037_no_such_target.py')
    })

    // @covers REQ-601#return-line-missing
    it('還元行の要る作業ログに還元行が無いと、その作業ログを挙げて失敗で終える', () => {
      const s = toolShadow()
      const name = '作業ログ_2026-11-19_uc037仕込み.md'
      s.write(`docs/${name}`, '# 仕込みの作業ログ\n\n還元行を持たない。\n')
      append(s, INDEX, `| 仕込みの作業ログ | [\`docs/${name}\`](${name}) |`)
      expectFailedNaming(checkDocs(s), name)
    })

    // @covers REQ-601#registry-mismatch
    it('対象の登録簿にある対象が配備先の一覧に無いと、その対象を挙げて失敗で終える', () => {
      const s = toolShadow()
      const projects = JSON.parse(s.read('scripts/pages_projects.json')) as Record<string, unknown>
      expect(projects.mkt, '仕込み: 配備先の一覧に mkt が無い').toBeDefined()
      delete projects.mkt
      s.write('scripts/pages_projects.json', JSON.stringify(projects, null, 2))
      expectFailedNaming(checkDocs(s), 'mkt')
    })

    // @covers REQ-601#ledger-problem
    it('審議台帳に判断基準に無い規則を名指す行があると、失敗で終える', () => {
      const s = toolShadow()
      append(s, LEDGER, ledgerRow('採用', '採用', 'R99'))
      expectFailedNaming(checkDocs(s))
    })

    // @covers REQ-601#tracking-tool-copy-differs
    it('リポジトリに写した追跡の道具が手元の共通の置き場の正本と違うと、その道具を挙げて失敗で終える', () => {
      // 実行する機械の共通の置き場を前提にせず、一時の HOME に偽の正本を置く
      const home = mkdtempSync(join(tmpdir(), 'uc037-home-'))
      try {
        const original = '// uc037 の偽の正本（追跡の道具）\nexport {}\n'
        mkdirSync(join(home, '.claude', 'brain', 'tools', 'trace'), { recursive: true })
        writeFileSync(join(home, '.claude', 'brain', 'tools', 'trace', 'stop_gate.mjs'), original)
        const s = toolShadow()
        s.write(TRACE_COPY, `${original}// 写しだけに足した行\n`)
        expectFailedNaming(s.run('check_docs.py', ['--root', s.root], { HOME: home }), 'stop_gate.mjs')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    // @covers REQ-601#tracking-tool-no-central
    it('共通の置き場の正本が無いときは、写した追跡の道具を見ず、それでは失敗にしない', () => {
      const s = toolShadow()
      s.write(TRACE_COPY, '// 正本と違う写し\n')
      // 手元の共通の置き場を、追跡の道具の正本を持たない物にする
      const home = mkdtempSync(join(tmpdir(), 'uc037-home-'))
      try {
        // 共通の置き場は、追跡の道具の正本（tools/trace）だけを除いてリンクで写す
        const brain = join(homedir(), '.claude', 'brain')
        mkdirSync(join(home, '.claude', 'brain', 'tools'), { recursive: true })
        if (existsSync(brain)) for (const name of readdirSync(brain)) if (name !== 'tools') symlinkSync(join(brain, name), join(home, '.claude', 'brain', name))
        if (existsSync(join(brain, 'tools')))
          for (const name of readdirSync(join(brain, 'tools'))) if (name !== 'trace') symlinkSync(join(brain, 'tools', name), join(home, '.claude', 'brain', 'tools', name))
        const r = s.run('check_docs.py', ['--root', s.root], { HOME: home })
        expect(r.out).not.toContain('stop_gate.mjs')
        expect(r.status, r.out).toBe(0)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    // @covers REQ-601#all-mismatches-listed
    it('食い違いが 2 つの種類にあると、両方を挙げて失敗で終え、文書を書き換えない', () => {
      const s = toolShadow()
      s.write('docs/uc037_索引に無い文書.md', '# 索引に無い文書\n')
      append(s, PREMISES, '- 2026-11-19 テストの仕込みの決定: 反映先の無い決定行。→ 反映: `scripts/uc037_no_such_target.py`')
      const before = [s.read(INDEX), s.read(PREMISES), s.read(GATES)]
      expectFailedNaming(checkDocs(s), 'uc037_索引に無い文書.md', 'uc037_no_such_target.py')
      expect([s.read(INDEX), s.read(PREMISES), s.read(GATES)], '文書が書き換わった').toEqual(before)
    })
  })

  describe('審議台帳の検査は、判断基準に無い規則・規則の無い行・列の足りない行を挙げ、案と決定のずれの数を示す（REQ-602）', () => {
    // @covers REQ-602#consistent
    it('どの行も判断基準にある規則を名指し、列がそろっていると、成功で終える', () => {
      const s = toolShadow()
      writeLedger(s, [ledgerRow('採用', '採用', 'R1'), ledgerRow('保留', '保留', 'R4, R8')])
      const r = checkLedger(s)
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).toBe(0)
    })

    // @covers REQ-602#unknown-rule
    it('判断基準に無い規則を名指す行があると、その規則を挙げて失敗で終える', () => {
      const s = toolShadow()
      writeLedger(s, [ledgerRow('採用', '採用', 'R1'), ledgerRow('採用', '採用', 'R99')])
      expectFailedNaming(checkLedger(s), 'R99')
    })

    // @covers REQ-602#no-rule
    it('規則を名指さない行があると、失敗で終える', () => {
      const s = toolShadow()
      writeLedger(s, [ledgerRow('採用', '採用', 'R1'), ledgerRow('採用', '採用', '')])
      expectFailedNaming(checkLedger(s))
    })

    // @covers REQ-602#columns-short
    it('列の足りない行があると、失敗で終える', () => {
      const s = toolShadow()
      writeLedger(s, [ledgerRow('採用', '採用', 'R1'), row(['11-19', 'テスト / uc037', '列の足りない行'])])
      expectFailedNaming(checkLedger(s))
    })

    // @covers REQ-602#drift-count-shown
    it('決定が空でも「（」で始まるのでもなく、案の「（」より前の部分が決定に含まれない行の数を、ずれた行の数として示し、それだけでは失敗にしない', () => {
      const s = toolShadow()
      writeLedger(s, [
        ledgerRow('採用', '採用', 'R1'),
        ledgerRow('採用', '不採用', 'R9'),
        ledgerRow('保留', '採用', 'R4'),
        ledgerRow('条件付き（一部だけ）', '条件付き（ほかの言い回し）', 'R8'),
        ledgerRow('不採用', '保留', 'R10'),
        ledgerRow('採用', '（同上）', 'R2'),
        ledgerRow('保留', '', 'R5'),
      ])
      const r = checkLedger(s)
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).toBe(0)
      expect(r.out.split('\n').some((l) => l.includes('ずれ') && /(^|\D)2(\D|$)/.test(l)), `ずれた行の数 2 を示していない:\n${r.out}`).toBe(true)
    })
  })
})
