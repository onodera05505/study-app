import { describe, expect, it, vi } from 'vitest'
import {
  QUESTIONS_DIR, RENDER_SCRIPT, build, buildRaw, copyFixture, grade, gradeRaw, makeWorkspace, prepareGrade, resultFile,
  type Run, type Workspace,
} from './uc019_fixture'
import { loadContract, shapeErrors, singleJson, type Json } from './learner_entry_shape'
import { spawnSync } from 'node:child_process'

/** UC-019 の 3 つの入口（buildLearnerPack ＝ `python3 scripts/build_learner_pack.py`、gradeLearnerAnswers ＝ `python3 scripts/grade_learner.py`、
 *  renderLearnerInstructions ＝ `python3 scripts/render_prompts.py`）の応答の出し方の境界。
 *  観測するのは、標準出力の全体が JSON 1 つであること、その JSON が契約の response か ToolError の形に合うこと、終了コードだけ。
 *  終了コードの値は契約の response の description（成功 0、errors に当たれば 1）から取る。
 *  どの errors に当たるかの細目は各失敗の要件が見るので、ここでは断りの code ごとに 1 つの入力を使う。 */

const CONTRACT = loadContract('docs/goals/GOAL-12-measure-with-learner-role/UC-019-measure-with-learner-pack/contract.yaml')
const TOOL_ERROR = CONTRACT.schemas.ToolError

/** パックを作る 1 回は図を描くブラウザの起動を含み、手元のフィクスチャで数秒かかる。 */
vi.setConfig({ testTimeout: 60_000 })

/** 成功の観測: 終了 0・標準出力が JSON 1 つ・その JSON が操作の response の形に合い、断りの形（error 欄）を持たない。 */
function expectSuccess(r: Run, operation: string) {
  expect(r.status, r.stdout + r.stderr).toBe(0)
  const out = singleJson(r.stdout)
  expect(out.ok, `標準出力が JSON 1 つでない:\n${r.stdout}`).toBe(true)
  expect(shapeErrors(out.value, CONTRACT.operations[operation].response, CONTRACT)).toEqual([])
  expect(out.value !== null && typeof out.value === 'object' && 'error' in out.value, r.stdout).toBe(false)
  return out.value as Json
}

/** 断りの観測: 終了 1・標準出力が JSON 1 つ・その JSON が ToolError の形に合い、code が当たった errors の物。 */
function expectRefusal(r: Run, code: string) {
  expect(r.status, r.stdout + r.stderr).toBe(1)
  const out = singleJson(r.stdout)
  expect(out.ok, `標準出力が JSON 1 つでない:\n${r.stdout}`).toBe(true)
  expect(shapeErrors(out.value, TOOL_ERROR, CONTRACT)).toEqual([])
  expect(out.value.error.code, r.stdout).toBe(code)
}

/** 日で束ねるロードマップ型の学び（itc）のロードマップを、days を持たせて置く。 */
function withItcRoadmap(ws: Workspace) {
  ws.write('data/itc/roadmap.json', {
    target: '作り物の学び', per_day: 2, days: 9,
    units: [
      { order: 1, day: 1, topic_id: 3, term: '作り物の単位3', field: '作り物の分野', middle: '作り物の単元', summary: '作り物の要約3' },
      { order: 2, day: 2, topic_id: 12, term: '作り物の単位12', field: '作り物の分野', middle: '作り物の単元', summary: '作り物の要約12' },
    ],
  })
}
const render = (ws: Workspace, args: string[]): Run => {
  const r = spawnSync('python3', [RENDER_SCRIPT, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: singleJson(r.stdout).value, code: undefined }
}

describe('UC-019 入口は結果か断りを JSON 1 つで示し、終了の状態で分ける（REQ-527）', () => {
  describe('パックを作る入口（buildLearnerPack）', () => {
    /** @covers REQ-527#pack-success */
    it('止まらずに作れば、終了 0 で response の形の JSON 1 つだけを出す', () => {
      const ws = makeWorkspace()
      expectSuccess(build(ws), 'buildLearnerPack')
    })

    /** @covers REQ-527#pack-refused-invalid-input */
    it('引数が契約の形の外で断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は INVALID_INPUT', () => {
      const ws = makeWorkspace()
      expectRefusal(buildRaw(ws, ['--data', 'data/eng', '--cycle', '0', '--out', '']), 'INVALID_INPUT')
    })

    /** @covers REQ-527#pack-refused-not-found */
    it('今の確認問題が無くて断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は NOT_FOUND', () => {
      const ws = makeWorkspace()
      ws.remove(QUESTIONS_DIR)
      expectRefusal(build(ws), 'NOT_FOUND')
    })

    /** @covers REQ-527#pack-refused-conflict */
    it('出力先に中身があって断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は CONFLICT', () => {
      const ws = makeWorkspace()
      ws.write('packs/c8/memo.txt', '既にある中身')
      expectRefusal(build(ws), 'CONFLICT')
    })

    /** @covers REQ-527#pack-refused-internal */
    it('図が XML として整わずに止めれば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は INTERNAL', () => {
      const ws = makeWorkspace()
      const data = `${copyFixture(ws, 'figure-not-well-formed')}/data/itc`
      expectRefusal(build(ws, { data, cycle: 1, out: 'packs/fx' }), 'INTERNAL')
    })
  })

  describe('採点の入口（gradeLearnerAnswers）', () => {
    const ANSWERS = { answers: { 't5-1': 'イ', 't2-1': 'ア' }, units: [{ topic_id: 5, understood: 3 }] }

    /** @covers REQ-527#grade-success */
    it('止まらずに採点すれば、終了 0 で response（周の結果）の形の JSON 1 つだけを出す', () => {
      const ws = makeWorkspace()
      prepareGrade(ws, ANSWERS)
      expectSuccess(grade(ws), 'gradeLearnerAnswers')
    })

    /** @covers REQ-527#grade-refused-invalid-input */
    it('引数が契約の形の外で断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は INVALID_INPUT', () => {
      const ws = makeWorkspace()
      expectRefusal(gradeRaw(ws, ['--data', 'data/eng', '--cycle', '0', '--answers', '']), 'INVALID_INPUT')
    })

    /** @covers REQ-527#grade-refused-not-found */
    it('その周のパックの写しが無くて断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は NOT_FOUND', () => {
      const ws = makeWorkspace()
      ws.write('answers/learner.json', ANSWERS)
      expectRefusal(grade(ws), 'NOT_FOUND')
    })

    /** @covers REQ-527#grade-refused-conflict */
    it('その周の結果が既にあって断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は CONFLICT', () => {
      const ws = makeWorkspace()
      prepareGrade(ws, ANSWERS)
      ws.write(resultFile(8), { cycle: 8 })
      expectRefusal(grade(ws), 'CONFLICT')
    })
  })

  describe('学習者役への指示を描き出す入口（renderLearnerInstructions）', () => {
    /** @covers REQ-527#instructions-success */
    it('止まらずに描き出せば、終了 0 で response の形の JSON 1 つだけを出す', () => {
      const ws = makeWorkspace()
      withItcRoadmap(ws)
      const json = expectSuccess(render(ws, ['--data', 'data/itc']), 'renderLearnerInstructions')
      expect(json.path).toBe('data/itc/prompts/roadmap_learner.md')
    })

    /** @covers REQ-527#instructions-refused-invalid-input */
    it('引数が契約の形の外で断れば、終了 1 で ToolError の形の JSON 1 つだけを出し、code は INVALID_INPUT', () => {
      const ws = makeWorkspace()
      withItcRoadmap(ws)
      expectRefusal(render(ws, []), 'INVALID_INPUT')
    })
  })
})
