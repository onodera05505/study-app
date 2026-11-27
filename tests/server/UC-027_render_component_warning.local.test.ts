/** UC-027 実データの描画の検査（checkRender ＝ `bash scripts/check_render.sh <学び>`）が、描画の途中で部品が出した警告では失敗にせず、
 *  警告の先頭と件数を示すこと（REQ-665）。部品が警告を出す入力は、検証方針の境界の扱いのとおり「1 つの問題解説の選択肢に同じ記号が 2 つある」。
 *  作業場は学びの置き場の写し（UC-027_fixture.local.ts の makeWorkspace）。比べる相手は、同じ作業場を書き換える前に回した検査。 */

import fs from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { checkRender, cleanWorkspaces, makeWorkspace } from './UC-027_fixture.local'

vi.setConfig({ testTimeout: 300_000 })

afterAll(() => cleanWorkspaces())

const lines = (out: string) => out.split('\n').filter((l) => l.trim() !== '' && !/ExperimentalWarning|trace-warnings|描画検査 .*秒/.test(l))

describe('実データの描画の検査は、部品の警告では失敗にせず、警告の先頭と件数を示す（UC-027）', () => {
  // @covers REQ-665#component-warning-not-fail
  it('1 つの問題解説の選択肢に同じ記号が 2 つある学びを描くと、部品の警告の先頭と件数が示され、エラーの件数には部品の警告が入らない', () => {
    const ws = makeWorkspace('ip')
    const before = checkRender(ws)
    expect(before.status, `仕込み: 書き換える前の検査が通らない:\n${before.out.slice(-2000)}`).toBe(0)

    const rel = `${ws.data}/question_explanations/expl_01.json`
    const body = JSON.parse(fs.readFileSync(ws.abs(rel), 'utf8'))
    const e = body.explanations[0]
    e.choices[1].label = e.choices[0].label
    fs.writeFileSync(ws.abs(rel), JSON.stringify(body))
    const r = checkRender(ws)

    // 書き換える前に無かった行のうち、警告とその件数を示す行がある（部品の警告の先頭と件数）
    const base = new Set(lines(before.out))
    const added = lines(r.out).filter((l) => !base.has(l))
    expect(added.some((l) => /警告/.test(l) && /(^|\D)1\s*件/.test(l)), `部品の警告の件数を示していない:\n${added.join('\n')}`).toBe(true)
    expect(added.filter((l) => /警告/.test(l)).length, `部品の警告の先頭を示していない:\n${added.join('\n')}`).toBeGreaterThanOrEqual(2)

    // エラーとして挙がるのは検査自身が見る、その問題解説の誤りだけで、件数もその数
    const all = r.out.split('\n')
    const at = all.findIndex((l) => /^エラー\s*\d+\s*件/.test(l))
    expect(at, `エラーの節が無い:\n${r.out.slice(-2000)}`).toBeGreaterThanOrEqual(0)
    const count = Number(/^エラー\s*(\d+)\s*件/.exec(all[at])![1])
    const items = all.slice(at + 1).filter((l) => /^\s+- /.test(l))
    const errorItems = items.slice(0, count)
    expect(errorItems.length).toBe(count)
    expect(errorItems.filter((l) => !l.includes(e.question_id)), `その問題解説でないエラーがある（部品の警告が入った）:\n${errorItems.join('\n')}`).toEqual([])
  })
})
