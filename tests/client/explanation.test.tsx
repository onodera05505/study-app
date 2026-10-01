// @vitest-environment jsdom
/** 問題ごとの解説の表示（正解の根拠・選択肢ごとの 1 行・正解の行の印・誤答の用語名）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { Explanation } from '../../src/client/components/Explanation'
import { invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
/** その文字列を持つ、いちばん内側の要素。 */
const innermost = (s: string) =>
  els('*')
    .filter((e) => (e.textContent ?? '').includes(s))
    .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
/** その要素から container までの class をつないだもの（印がどの階層に付いていても拾う）。 */
function classChain(el: Element | undefined): string {
  const out: string[] = []
  for (let e: Element | null = el ?? null; e && e !== container; e = e.parentElement) out.push(e.className)
  return out.join('|')
}

const EXPL = {
  correctReason: '固定費を限界利益率で割ると求まります。',
  choices: [
    { label: 'ア', term: null, note: '正解。限界利益率で割る。' },
    { label: 'イ', term: '損益分岐点', note: '売上と費用が等しくなる点の説明。' },
    { label: 'ウ', term: 'ABC 分析', note: '重点管理の手法の説明。' },
    { label: 'エ', term: '在庫回転率', note: '在庫の回り方を見る指標の説明。' },
  ],
}

async function draw(data: unknown) {
  const props = { data, answer: 'ア' } as unknown as Parameters<typeof Explanation>[0]
  await act(async () => {
    root.render(h(MemoryRouter, null, h(Explanation, props)))
  })
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  invalidateCached()
  // 用語集（用語ポップが引く）
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ glossary: [{ term: '損益分岐点', brief: '売上と費用が等しくなる点', topicId: 12 }] }),
  }))
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('解説の表示', () => {
  // @covers REQ-062#explanation-rendered
  it('正解の根拠と選択肢ごとの 1 行を出し、正解の行に印を付ける', async () => {
    await draw(EXPL)
    expect(text()).toContain('固定費を限界利益率で割ると求まります。')
    for (const c of EXPL.choices) expect(text(), `選択肢 ${c.label} の行が出ていない`).toContain(c.note)
    const correct = classChain(innermost('正解。限界利益率で割る。'))
    const wrong = classChain(innermost('売上と費用が等しくなる点の説明。'))
    expect(correct, '正解の行に印が付いていない').not.toBe(wrong)
  })

  // @covers REQ-007#term-in-single-line
  it('誤答の用語名は押すと説明が出る語になる', async () => {
    await draw(EXPL)
    const marked = els('button,a,[role="button"],[tabindex],[class*="term"]').some((e) =>
      (e.textContent ?? '').includes('損益分岐点'),
    )
    expect(marked, '誤答の用語名が押せる語になっていない').toBe(true)
  })

  // @covers REQ-065#explanation-absent-renders-nothing
  it('解説が無い問題では何も描かない', async () => {
    await draw(EXPL)
    expect(container.querySelector('.expl'), '解説があるのに描かれていない').not.toBeNull()
    expect(text()).not.toBe('')
    await draw(null)
    expect(container.querySelector('.expl'), '解説が無いのに解説の枠を描いている').toBeNull()
    expect(text(), '解説が無いのに何かを描いている').toBe('')
  })
})
