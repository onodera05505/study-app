import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type Place, type RecordRun, recordPlace, removeTemps, runRecorded } from './UC-035_fixture'

/** UC-035 REQ-666: 今回のテストの実行のどこかで呼ばれた関数を、同じファイルの別の記録が呼ばれていないと持っていても、
 *  実行の記録で呼ばれていないとは載せない（合わせ方は ADR-0015: 同じファイルの同じ始まりの行の関数は同じ関数とみなす）。
 *
 *  入力: 小さな置き場（UC-035_fixture.ts）に、1 行に書いたクラスの道具 `scripts/uc035_merge.mjs` を置く。置き場のテストは、
 *  テストと同じプロセスでその道具を読み込んでクラスを作り（呼ばれる）、子プロセスでその道具を回してクラスを作らない（0 回）。
 *  同じプロセスの記録と子プロセスの記録は、同じ行の関数に違う名前を付けうる（ADR-0015）。
 *  道具は、どちらの記録でも呼ばれない名前つきの関数（クラスと別の行で始まる）も持つ。
 *  観測するのは、置き場の記録 `coverage/lcov.info` の、そのファイルのその行に始まる関数の呼ばれた回数だけ。 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 })

const TOOL = 'scripts/uc035_merge.mjs'
const TOOL_BODY = [
  'export class Counter { constructor() { this.n = 1 } }',
  '',
  'export function neverCalled() {',
  "  return 'never'",
  '}',
  '',
  "if (process.argv[2] === 'child') {",
  "  console.log('child ran without making a counter')",
  '}',
  '',
].join('\n')
/** クラス（と、その作り手）が始まる行。 */
const CLASS_LINE = 1
/** どちらの記録でも呼ばれない名前つきの関数が始まる行と名前。 */
const NEVER_LINE = 3
const NEVER_NAME = 'neverCalled'

const PLACE_TEST = `import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it as check } from 'vitest'
import { Counter } from '../scripts/uc035_merge.mjs'

check('同じプロセスでは作り、子プロセスでは作らない', () => {
  expect(new Counter().n).toBe(1)
  const r = spawnSync('node', [join(import.meta.dirname, '..', 'scripts', 'uc035_merge.mjs'), 'child'], { encoding: 'utf8' })
  expect(r.status).toBe(0)
})
`

type FnRecord = { line: number; name: string; count: number }

/** lcov の、file を指す節ごとの関数（始まりの行・名前・呼ばれた回数）。 */
function functionsOf(lcov: string, file: string): FnRecord[][] {
  const sections: FnRecord[][] = []
  let cur: { lines: Map<string, number>; counts: Map<string, number> } | null = null
  const close = () => {
    if (cur) sections.push([...cur.lines].map(([name, line]) => ({ name, line, count: cur!.counts.get(name) ?? 0 })))
    cur = null
  }
  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      close()
      if (line.slice(3).trim().endsWith(file)) cur = { lines: new Map(), counts: new Map() }
    } else if (cur && line.startsWith('FN:')) {
      const [n, ...name] = line.slice(3).split(',')
      cur.lines.set(name.join(','), Number(n))
    } else if (cur && line.startsWith('FNDA:')) {
      const [c, ...name] = line.slice(5).split(',')
      cur.counts.set(name.join(','), Number(c))
    } else if (line.startsWith('end_of_record')) close()
  }
  close()
  return sections
}

let place: Place
let run: RecordRun

beforeAll(() => {
  place = recordPlace()
  // この確かめに要る物だけを置く（置き場の土台のテストは外す）
  for (const t of ['tests/tools.test.ts', 'tests/once.test.ts', 'tests/broken.test.ts']) place.remove(t)
  place.write(TOOL, TOOL_BODY)
  place.write('tests/merge.test.ts', PLACE_TEST)
  run = runRecorded(place)
})

afterAll(async () => {
  await removeTemps()
})

describe('UC-035 別の記録が呼ばれていないと持っていても、今回どこかで呼ばれた関数は呼ばれていないと載せない（REQ-666）', () => {
  // @covers REQ-666#called-in-one-record-not-uncalled
  it('テストと同じプロセスで呼ばれ、子プロセスの記録では 0 回の関数（同じ行に始まる）は、実行の記録で呼ばれていないと載らない', () => {
    expect(run.status, run.out.slice(-3000)).toBe(0)
    const lcov = readFileSync(place.path('coverage/lcov.info'), 'utf8')
    const sections = functionsOf(lcov, TOOL)
    expect(sections.length, `${TOOL} が記録に無い`).toBeGreaterThan(0)
    const atClass = sections.flat().filter((f) => f.line === CLASS_LINE)
    expect(atClass.length, `${CLASS_LINE} 行に始まる関数が記録に無い: ${JSON.stringify(sections)}`).toBeGreaterThan(0)
    const uncalled = atClass.filter((f) => f.count === 0)
    expect(uncalled, `呼ばれた関数が、呼ばれていないと載っている: ${JSON.stringify(sections)}`).toEqual([])
  })

  // @covers REQ-666#uncalled-in-both-stays-uncalled
  it('同じファイルが 2 つの記録に載るとき、どちらの記録でも呼ばれない名前つきの関数（別の行で始まる）は、実行の記録で 0 回と載る', () => {
    expect(run.status, run.out.slice(-3000)).toBe(0)
    const lcov = readFileSync(place.path('coverage/lcov.info'), 'utf8')
    const sections = functionsOf(lcov, TOOL)
    expect(sections.length, `${TOOL} が 2 つの記録に載っていない: ${JSON.stringify(sections)}`).toBeGreaterThanOrEqual(2)
    const never = sections.flat().filter((f) => f.line === NEVER_LINE)
    expect(never.length, `${NEVER_LINE} 行に始まる関数が記録に無い: ${JSON.stringify(sections)}`).toBeGreaterThan(0)
    expect(never.some((f) => f.name === NEVER_NAME), JSON.stringify(never)).toBe(true)
    expect(never.filter((f) => f.count > 0), `呼ばれていない関数が、呼ばれたと載っている: ${JSON.stringify(sections)}`).toEqual([])
  })
})
