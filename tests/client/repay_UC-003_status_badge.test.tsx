// @vitest-environment jsdom
/** 理解度のバッジと行の印（StatusBadge.tsx）のうち、ロードマップ型で記録が無い論点の示し方（UC-003・BR-029）。
 *  記録が無いこと（null）はロードマップ型の応答だけが持つ値（資格対策では未＝0 が返る）。
 *  本物の React で描き、記録なし（null）の描画を未理解（1）の描画と見比べる。 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StatusBadge, statusRowClass } from '../../src/client/components/StatusBadge'

let container: HTMLElement
let root: Root

async function draw(node: ReactNode) {
  await act(async () => {
    root.render(node)
  })
  return container.innerHTML
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
})

describe('ロードマップ型で記録が無い論点の理解度の示し方（UC-003）', () => {
  // @covers REQ-041#roadmap-no-record-shown-as-unlearned
  it('記録が無い論点は、論点の画面のバッジも一覧の行の印も未理解と同じ示し方になる', async () => {
    const unlearned = await draw(<StatusBadge status={1} />)
    expect(container.textContent).toContain('未理解')
    const none = await draw(<StatusBadge status={null} />)
    expect(container.textContent, '記録なしのバッジに未理解の文字が無い').toContain('未理解')
    expect(none, '記録なしのバッジが未理解のバッジと違う').toBe(unlearned)

    // 他の段階と同じになっていない（未理解だけと同じ）
    for (const status of [2, 3] as const)
      expect(none, `記録なしのバッジが status=${status} と同じ`).not.toBe(await draw(<StatusBadge status={status} />))

    // 一覧の行の印
    expect(statusRowClass(null), '記録なしの行の印が未理解と違う').toBe(statusRowClass(1))
    expect(statusRowClass(null)).not.toBe(statusRowClass(2))
    expect(statusRowClass(null)).not.toBe(statusRowClass(3))
  })
})
