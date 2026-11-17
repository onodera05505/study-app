import { afterAll, describe, expect, it, vi } from 'vitest'
import { build, buildRaw, cleanWorkspaces, figureFile, makeWorkspace, setupRewritten, type Run } from './UC-028_fixture'
import { loadContract, shapeErrors, singleJson } from './learner_entry_shape'

/** UC-028 単元の読み物を作る入口（buildUnitReading ＝ `python3 scripts/build_unit_reading.py --data <data> --unit <unit> --out <out>`）の
 *  応答の出し方の境界。観測するのは、標準出力の全体が JSON 1 つであること、その JSON が契約の response か ToolError の形に合うこと、
 *  終了コードだけ。終了コードの値は契約の response の description（成功 0、errors に当たれば 1）から取る。
 *  どの errors に当たるかの細目は各失敗の要件が見るので、ここでは断りの code ごとに 1 つの入力を使う。 */

const CONTRACT = loadContract('docs/goals/GOAL-12-measure-with-learner-role/UC-028-read-cert-unit-with-learner-role/contract.yaml')

/** 1 回作るのに図を描くブラウザの起動を含む。 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

afterAll(() => cleanWorkspaces())

function expectSuccess(r: Run) {
  expect(r.status, r.stdout + r.stderr).toBe(0)
  const out = singleJson(r.stdout)
  expect(out.ok, `標準出力が JSON 1 つでない:\n${r.stdout}`).toBe(true)
  expect(shapeErrors(out.value, CONTRACT.operations.buildUnitReading.response, CONTRACT)).toEqual([])
  expect(out.value !== null && typeof out.value === 'object' && 'error' in out.value, r.stdout).toBe(false)
}

function expectRefusal(r: Run, code: string) {
  expect(r.status, r.stdout + r.stderr).toBe(1)
  const out = singleJson(r.stdout)
  expect(out.ok, `標準出力が JSON 1 つでない:\n${r.stdout}`).toBe(true)
  expect(shapeErrors(out.value, CONTRACT.schemas.ToolError, CONTRACT)).toEqual([])
  expect(out.value.error.code, r.stdout).toBe(code)
}

/** 単元の全論点を書き直した世代から選べる作業場。 */
function prepared(name: string) {
  const ws = makeWorkspace(name)
  const unit = setupRewritten(ws)
  return { ws, unit }
}

describe('UC-028 入口は結果か断りを JSON 1 つで示し、終了の状態で分ける（REQ-528）', () => {
  /** @covers REQ-528#success */
  it('止まらずに作れば、終了 0 で response の形の JSON 1 つだけを出す', () => {
    const { ws } = prepared('entry-ok')
    expectSuccess(build(ws))
  })

  /** @covers REQ-528#refused-invalid-input */
  it('引数が契約の形の外で断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は INVALID_INPUT', () => {
    const { ws } = prepared('entry-bad-arguments')
    expectRefusal(buildRaw(ws, ['--data', ws.data, '--unit', '1', '--out', '']), 'INVALID_INPUT')
  })

  /** @covers REQ-528#refused-not-found */
  it('単元が無くて断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は NOT_FOUND', () => {
    const { ws } = prepared('entry-unit-missing')
    expectRefusal(build(ws, { unit: '99', out: 'readings/ip_99' }), 'NOT_FOUND')
  })

  /** @covers REQ-528#refused-conflict */
  it('出力先に中身があって断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は CONFLICT', () => {
    const { ws } = prepared('entry-out-not-empty')
    ws.write('readings/ip_21/memo.txt', '既にある中身')
    expectRefusal(build(ws), 'CONFLICT')
  })

  /** @covers REQ-528#refused-internal */
  it('図を PNG に描けずに止めれば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は INTERNAL', () => {
    const { ws, unit } = prepared('entry-not-drawable')
    ws.write(figureFile(ws, `${unit.at(3).id}-1.svg`), '<svg width="240" height="60"><rect width="240" height="60" fill="#ffffff"/></svg>')
    expectRefusal(build(ws), 'INTERNAL')
  })
})
