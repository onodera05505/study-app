import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BROKEN,
  COPY_ONLY,
  type FileRecord,
  type Place,
  type RecordRun,
  hitsOf,
  lineOf,
  placeRecord,
  recordPlace,
  removeTemps,
  runPlain,
  runRecorded,
  sectionsOf,
} from './UC-035_fixture'

/** UC-035 テストを回して実行の記録を書き出す入口（`node tests/support/coverage/run.mjs`）の境界。
 *  小さな置き場（UC-035_fixture.ts）を記録つきで回し、置き場の記録 `coverage/lcov.info` と、道具が出した物と、入口の終了の状態と出力を見る。
 *  上限の理由は REQ-590 の検証方針（小さな置き場の 1 回は数秒。並べたときの遅れに 10 倍以上の余裕）。 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 })

const PY = 'scripts/uc035_tool.py'
const SH = 'scripts/uc035_tool.sh'
const NODE = 'scripts/uc035_tool.mjs'
const ONCE = 'scripts/uc035_once.py'

/** 記録つき（読めない記録あり）・記録つき（読めない記録なし）・記録なしの 3 回と、1 回目のあとにテストを 1 つ外して回した 2 回目。 */
let place: Place
let recorded: RecordRun
let records: FileRecord[]
let control: RecordRun
let plain: RecordRun
let second: FileRecord[] | null
const observed = (p: Place, name: string) => JSON.parse(readFileSync(p.path(name), 'utf8')) as Record<string, any>

beforeAll(() => {
  const forControl = recordPlace()
  control = runRecorded(forControl, { UC035_OBSERVED: forControl.path('observed_control.json') })

  place = recordPlace()
  plain = runPlain(place, { UC035_OBSERVED: place.path('observed_plain.json') })
  recorded = runRecorded(place, { UC035_OBSERVED: place.path('observed_recorded.json'), UC035_BROKEN: '1' })
  records = placeRecord(place) ?? []

  // 2 回目: 一度だけの道具を回すテストを外して、同じ置き場を回す
  place.remove('tests/once.test.ts')
  runRecorded(place, { UC035_OBSERVED: place.path('observed_second.json') })
  second = placeRecord(place)
})

afterAll(async () => {
  await removeTemps()
})

const out = () => `終了 ${recorded.status}\n${recorded.out}`

describe('UC-035 テストを回して実行の記録を書き出し、どのテストからも動かないコードを門で見つけられるようにする', () => {
  describe('子プロセスで回した道具の動いた行と呼ばれた関数を、写し元のファイルとして載せる（REQ-590）', () => {
    // @covers REQ-590#repo-python-tool
    it('置き場から回した Python の道具は、動いた行と呼ばれた関数が載り、動かなかった関数とその行は動いていないと載る', () => {
      expect(recorded.status, out()).toBe(0)
      const s = sectionsOf(place, records, PY)
      expect(s.length, `記録に ${PY} が無い:\n${out()}`).toBeGreaterThan(0)
      expect(hitsOf(s, lineOf(PY, "f.write('python wrote"))).toBeGreaterThan(0)
      expect(hitsOf(s, lineOf(PY, "print('never')"))).toBe(0)
      expect(Math.max(...s.map((x) => x.functions.get('used') ?? 0))).toBeGreaterThan(0)
      expect(Math.max(...s.map((x) => x.functions.get('unused') ?? -1))).toBe(0)
    })

    // @covers REQ-590#repo-shell-tool
    it('置き場から回したシェルの道具は、動いた行が載り、通らなかった行は動いていないと載る', () => {
      const s = sectionsOf(place, records, SH)
      expect(s.length, `記録に ${SH} が無い:\n${out()}`).toBeGreaterThan(0)
      expect(hitsOf(s, lineOf(SH, 'echo "shell stdout"'))).toBeGreaterThan(0)
      expect(hitsOf(s, lineOf(SH, 'echo "never"'))).toBe(0)
    })

    // @covers REQ-590#repo-node-tool
    it('置き場から回した Node の道具は、動いた行と呼ばれた関数が載り、動かなかった関数は呼ばれていないと載る', () => {
      const s = sectionsOf(place, records, NODE)
      expect(s.length, `記録に ${NODE} が無い:\n${out()}`).toBeGreaterThan(0)
      expect(hitsOf(s, lineOf(NODE, "writeFileSync(out, 'node wrote"))).toBeGreaterThan(0)
      expect(Math.max(...s.map((x) => x.functions.get('used') ?? 0))).toBeGreaterThan(0)
      expect(Math.max(...s.map((x) => x.functions.get('unused') ?? 0))).toBe(0)
    })

    // @covers REQ-590#copied-tool-as-original
    it('写しの置き場で回した道具は、写し元のファイルの行と関数として載り、写しのパスでは載らない', () => {
      const s = sectionsOf(place, records, PY)
      expect(hitsOf(s, lineOf(PY, "print('python from copy')")), '写しで動いた行が写し元に載っていない').toBeGreaterThan(0)
      expect(Math.max(...s.map((x) => x.functions.get('copied') ?? 0))).toBeGreaterThan(0)
      expect(records.filter((r) => r.sf.includes('uc035-copy-')).map((r) => r.sf), '写しのパスで載った').toEqual([])
    })

    // @covers REQ-590#place-via-link
    it('置き場をリンクを含むパスで渡しても、置き場から回した Python と Node の道具の動いた行が写し元のファイルとして載る', () => {
      const p = recordPlace()
      // 置き場を指すリンクを別の一時の置き場に置き、そのリンクを通したパスで渡す
      const links = mkdtempSync(join(tmpdir(), 'uc035-link-'))
      const link = join(links, 'place-link')
      symlinkSync(p.dir, link)
      expect(realpathSync(link)).toBe(p.dir)
      let r: RecordRun
      try {
        r = runRecorded(p, { TEST_RECORD_ROOT: link, UC035_OBSERVED: p.path('observed_link.json') })
      } finally {
        rmSync(links, { recursive: true, force: true })
      }
      expect(r.status, r.out).toBe(0)
      const rec = placeRecord(p) ?? []
      expect(hitsOf(sectionsOf(p, rec, PY), lineOf(PY, "f.write('python wrote")), 'Python の道具の動いた行が載っていない').toBeGreaterThan(0)
      expect(hitsOf(sectionsOf(p, rec, NODE), lineOf(NODE, "writeFileSync(out, 'node wrote")), 'Node の道具の動いた行が載っていない').toBeGreaterThan(0)
    })

    // @covers REQ-590#copy-only-not-listed
    it('写し元に同じファイルが無い道具は、記録に載らない', () => {
      expect(observed(place, 'observed_recorded.json').copy?.onlyStatus, '仕込み: 写しにだけある道具が回っていない').toBe(0)
      expect(records.filter((r) => r.sf.endsWith(COPY_ONLY.split('/').pop()!)).map((r) => r.sf)).toEqual([])
    })
  })

  describe('記録を取っているあいだ、道具の出す物は記録を取らないときと同じ（REQ-591）', () => {
    const same = (name: string) => {
      expect(plain.status, plain.out).toBe(0)
      const a = observed(place, 'observed_plain.json')[name]
      const b = observed(place, 'observed_recorded.json')[name]
      expect(a, `記録なしで ${name} の道具が回っていない`).toBeDefined()
      expect(b).toEqual(a)
    }

    // @covers REQ-591#python-tool-same
    it('Python の道具の標準出力・標準エラー・終了の状態・書き出すファイルは、記録の有無で同じ', () => {
      same('python')
    })

    // @covers REQ-591#shell-tool-same
    it('シェルの道具の標準出力・標準エラー・終了の状態・書き出すファイルは、記録の有無で同じ', () => {
      same('shell')
    })

    // @covers REQ-591#node-tool-same
    it('Node の道具の標準出力・標準エラー・終了の状態・書き出すファイルは、記録の有無で同じ', () => {
      same('node')
    })
  })

  describe('今回の実行で動いた分だけを書き出し、前に回したときの分を残さない（REQ-592）', () => {
    // @covers REQ-592#previous-run-not-kept
    it('前の実行で回した道具を今回のテストが回さないと、今回の記録ではその道具は動いていない', () => {
      expect(hitsOf(sectionsOf(place, records, ONCE), lineOf(ONCE, "print('once')")), '仕込み: 1 回目に一度だけの道具が動いていない').toBeGreaterThan(0)
      expect(second, '2 回目の記録が無い').not.toBeNull()
      const s = sectionsOf(place, second!, ONCE)
      expect(hitsOf(s, lineOf(ONCE, "print('once')")) ?? 0, '前の実行の分が残った').toBe(0)
      expect(Math.max(0, ...s.map((x) => x.functions.get('once') ?? 0))).toBe(0)
    })
  })

  describe('Python の道具の記録を取る環境を作れなければ、理由を 1 行で示して失敗で終える（REQ-593）', () => {
    // @covers REQ-593#venv-uncreatable
    it('Python の記録の環境を作れない置き場を渡すと、理由を 1 行で示して、失敗で終える', () => {
      const p = recordPlace()
      writeFileSync(p.path('not_a_dir'), 'ふつうのファイル')
      const venv = p.path('not_a_dir/venv')
      const r = runRecorded(p, { TEST_RECORD_VENV: venv })
      expect(r.status, r.out).not.toBe(0)
      expect(r.status, '時間切れで止まった').not.toBeNull()
      const lines = r.out.split('\n').filter((l) => l.trim() !== '')
      expect(lines.filter((l) => l.includes(venv)), `理由が 1 行で示されていない:\n${r.out}`).toHaveLength(1)
    })
  })

  describe('読めない記録は飛ばし、それでは失敗にせず、飛ばした数を 1 行で示す（REQ-610）', () => {
    // @covers REQ-610#unreadable-raw-skipped
    it('生の記録の置き場に読めない記録（Node と Python）があっても、それを飛ばし、成功で終え、飛ばした数を 1 行で示す', () => {
      expect(control.status, control.out).toBe(0)
      expect(recorded.status, out()).toBe(0)
      const timing = /^\s*(Start at|Duration|RUN)\b/
      const base = new Set(control.out.split('\n').filter((l) => l.trim() !== '' && !timing.test(l)).map((l) => l.replace(/uc035-place-\w+/g, '')))
      const added = recorded.out
        .split('\n')
        .filter((l) => l.trim() !== '' && !timing.test(l))
        .filter((l) => !base.has(l.replace(/uc035-place-\w+/g, '')))
      expect(added, `読めない記録の無い実行に無かった行が 1 行でない:\n${out()}`).toHaveLength(1)
      expect(added[0]).toMatch(new RegExp(`(^|\\D)${BROKEN.node + BROKEN.python}(\\D|$)`))
    })
  })
})
