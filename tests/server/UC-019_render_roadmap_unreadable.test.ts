import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { RENDER_SCRIPT, copyFixture, makeWorkspace, toolError, type Json, type Run, type Workspace } from './uc019_fixture'

/** UC-019 学習者役への指示を描き出す入口（renderLearnerInstructions ＝ `python3 scripts/render_prompts.py --data <学びの置き場>`）で、
 *  登録簿がロードマップを持つとする学びの置き場のロードマップが無いか、JSON の object として読めないときの境界。
 *  断りは契約の errors「雛形の差し込みに埋まらない物が残る」（INVALID_INPUT、placeholders に差し込みの名前）。
 *  学びは登録簿でロードマップを持つ itc（日で束ねる）と eng（章で束ねる）の 2 つで見る。
 *  観測するのは、終了コード、標準出力の ToolError、作業場所のファイルが 1 つも変わらないことだけ。 */

const KEYS = ['itc', 'eng'] as const
const INSTRUCTIONS = (data: string) => `${data}/prompts/roadmap_learner.md`

function render(ws: Workspace, data: string): Run {
  const r = spawnSync('python3', [RENDER_SCRIPT, '--data', data], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  let json: Json = undefined
  try {
    json = JSON.parse(r.stdout.trim())
  } catch {
    json = undefined
  }
  const e = toolError(json)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, code: e && typeof e.code === 'string' ? e.code : undefined }
}

/** 学びの置き場を、ロードマップの中身だけを与えて作る（undefined ならロードマップのファイルを置かない）。
 *  existing が真なら、前からある指示のファイルも置く。 */
function workspaceWith(key: string, roadmap: string | undefined, existing: boolean) {
  const ws = makeWorkspace()
  const data = `data/${key}`
  ws.remove(`${data}/roadmap.json`)
  if (roadmap !== undefined) ws.write(`${data}/roadmap.json`, roadmap)
  if (existing) ws.write(INSTRUCTIONS(data), '前からある指示\n')
  return { ws, data }
}

/** 断ったときの観測: 終了 1・INVALID_INPUT・理由・差し込み days だけを挙げる・作業場所のファイルが 1 つも変わらない。 */
function expectRefusedWithDays(ws: Workspace, data: string) {
  const before = ws.snapshotTree()
  const r = render(ws, data)
  expect(r.status, r.stdout + r.stderr).toBe(1)
  expect(r.code, r.stdout).toBe('INVALID_INPUT')
  const e = toolError(r.json)
  expect(typeof e?.reason === 'string' && e.reason.length > 0, r.stdout).toBe(true)
  expect(e?.placeholders, r.stdout).toEqual(['days'])
  expect(ws.snapshotTree()).toEqual(before)
}

describe('UC-019 指示を描き出すときにロードマップが無いか読めない（REQ-526）', () => {
  for (const key of KEYS) {
    for (const existing of [false, true]) {
      const label = `${key}・前からある指示${existing ? 'あり' : 'なし'}`

      /** @covers REQ-526#roadmap-missing */
      it(`ロードマップのファイルが無ければ、差し込み days を挙げて断り、指示を書かない（${label}）`, () => {
        const { ws, data } = workspaceWith(key, undefined, existing)
        expectRefusedWithDays(ws, data)
      })

      for (const [kind, body] of [
        ['途中で切れた', '{ "units": ['],
        ['空のファイル', ''],
        ['JSON でない文', 'ロードマップ'],
      ] as const) {
        /** @covers REQ-526#roadmap-not-json */
        it(`ロードマップが JSON として読めない（${kind}）なら、差し込み days を挙げて断り、指示を書かない（${label}）`, () => {
          const { ws, data } = workspaceWith(key, body, existing)
          expectRefusedWithDays(ws, data)
        })
      }

      for (const [kind, body] of [
        ['配列', '[{ "days": 9 }]'],
        ['文字列', '"days"'],
        ['数', '9'],
        ['null', 'null'],
      ] as const) {
        /** @covers REQ-526#roadmap-not-object */
        it(`ロードマップが JSON だが object でない（${kind}）なら、差し込み days を挙げて断り、指示を書かない（${label}）`, () => {
          const { ws, data } = workspaceWith(key, body, existing)
          expectRefusedWithDays(ws, data)
        })
      }
    }
  }

  /** @covers REQ-526#roadmap-not-json */
  it('作り物の置き場 roadmap-unreadable から描き出すと、差し込み days を挙げて断り、指示を書かない', () => {
    const ws = makeWorkspace()
    const data = `${copyFixture(ws, 'roadmap-unreadable')}/data/itc`
    expectRefusedWithDays(ws, data)
  })
})
