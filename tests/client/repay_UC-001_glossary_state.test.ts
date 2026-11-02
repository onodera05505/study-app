// @vitest-environment jsdom
/** 用語集の取得の状態（src/client/lib/glossary.ts の ensureGlossary と、その状態で描く Markdown）の、
 *  UC-001 の未返済の分割クラス。
 *
 *  用語集はモジュールの中に覚えられるので、テストごとに読み直す。読み直した側の
 *  React で描かないと hook がずれるため、react も動的に読み込む。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const GLOSSARY = [{ term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 231 }]

let container: HTMLElement

/** モジュールを読み直して、描く道具と検査の対象をまとめて返す。 */
async function load() {
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const { ensureGlossary, useGlossary } = await import('../../src/client/lib/glossary')
  const { Markdown } = await import('../../src/client/components/Markdown')
  const root = createRoot(container)
  const draw = async (node: unknown) => {
    await React.act(async () => {
      root.render(React.createElement(MemoryRouter, { initialEntries: ['/topics/1'] }, node as never))
    })
  }
  /** useGlossary の結果を文字にして出す（未取得は「未取得」）。 */
  const Probe = () => {
    const g = useGlossary()
    return React.createElement('span', { id: 'probe' }, g === null ? '未取得' : `件数 ${g.size}`)
  }
  const settle = () =>
    React.act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  return { React, root, draw, Probe, settle, ensureGlossary, Markdown }
}

const text = () => container.textContent ?? ''
const probe = () => container.querySelector('#probe')?.textContent ?? ''

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  container.remove()
  vi.unstubAllGlobals()
})

describe('用語集の取得の状態（UC-001）', () => {
  // @covers REQ-001#no-refetch-after-failure
  it('取得に失敗したあとにもう一度求めても、取り直さない', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url))
      throw new TypeError('Failed to fetch')
    })
    const m = await load()
    m.ensureGlossary()
    await m.settle()
    expect(calls.filter((u) => u.includes('/glossary'))).toHaveLength(1)

    // 失敗が確定したあとに、何度か求め直す
    m.ensureGlossary()
    m.ensureGlossary()
    await m.settle()
    await m.draw(m.React.createElement(m.Probe))
    await m.settle()
    expect(calls.filter((u) => u.includes('/glossary')), '失敗のあとに取り直している').toHaveLength(1)
    // 取り直さないまま、空の用語集として扱われている
    expect(probe()).toBe('件数 0')
    await m.React.act(async () => m.root.unmount())
  })

  // @covers REQ-005#pending-term-not-pressable
  it('用語集が未取得の間は、本文の用語を押せる語にせず文字のまま出す', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: GLOSSARY }) }
    })
    const m = await load()
    m.ensureGlossary()
    await m.draw(
      m.React.createElement(
        m.React.Fragment,
        null,
        m.React.createElement(m.Probe),
        m.React.createElement(m.Markdown, { source: '売上は [[LTV]] で見る。' }),
      ),
    )
    expect(probe(), '前提: 用語集が未取得になっていない').toBe('未取得')
    expect(container.querySelector('button.term-btn'), '未取得なのに押せる語になっている').toBeNull()
    expect(text()).toContain('売上は LTV で見る。')
    expect(text()).not.toContain('[[')
    expect(text()).not.toContain(']]')

    // 取得が済めば、同じ本文の用語が押せる語になる（未取得の間だけの振る舞いであること）
    open()
    await m.settle()
    expect(probe()).toBe('件数 1')
    expect(container.querySelector('button.term-btn')?.textContent).toBe('LTV')
    await m.React.act(async () => m.root.unmount())
  })
})
