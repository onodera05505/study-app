// @vitest-environment jsdom
/** 用語集の取得（src/client/lib/glossary.ts の ensureGlossary / useGlossary）。
 *
 *  用語集はモジュールの中に覚えられるので、テストごとに読み直す。読み直した側の
 *  React で描かないと hook がずれるため、react も動的に読み込む。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const GLOSSARY = [
  { term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 231 },
  { term: 'CSRF', brief: '他人の権限で操作させる攻撃。', topicId: null },
]

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
    return React.createElement(
      'span',
      { id: 'probe' },
      g === null ? '未取得' : `件数 ${g.size} / ${g.get('LTV')?.brief ?? '無し'}`,
    )
  }
  return { React, root, draw, Probe, ensureGlossary, useGlossary, Markdown }
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

describe('用語集の取得', () => {
  // @verifies REQ-136
  it('何度求められても取りに行くのは 1 回だけ', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url))
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: GLOSSARY }) }
    })
    const m = await load()
    await m.React.act(async () => {
      m.ensureGlossary()
      m.ensureGlossary()
      m.ensureGlossary()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(calls.filter((u) => u.includes('/glossary'))).toHaveLength(1)
    // 以後は覚えたものを返す（取りに行かずに引ける）
    await m.draw(m.React.createElement(m.Probe))
    expect(probe()).toContain('1 人の顧客が生涯で払う金額。')
    expect(calls.filter((u) => u.includes('/glossary'))).toHaveLength(1)
    await m.React.act(async () => m.root.unmount())
  })

  // @verifies REQ-138
  it('取得が済むまでは未取得として区別し、済んでから引ける', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: GLOSSARY }) }
    })
    const m = await load()
    await m.draw(m.React.createElement(m.Probe))
    m.ensureGlossary()
    await m.React.act(async () => {})
    expect(probe()).toBe('未取得')
    open()
    await m.React.act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(probe()).toContain('件数 2')
    await m.React.act(async () => m.root.unmount())
  })

  // @verifies REQ-141
  it('用語集が取れなかったときは、空の用語集として扱い本文を素の文字で描く', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const m = await load()
    await m.React.act(async () => {
      m.ensureGlossary()
      await new Promise((r) => setTimeout(r, 0))
    })
    // 未取得（null）ではなく空の用語集になる
    await m.draw(m.React.createElement(m.Probe))
    expect(probe()).toBe('件数 0 / 無し')
    await m.draw(m.React.createElement(m.Markdown, { source: '売上は [[LTV]] で見る。' }))
    expect(container.querySelector('button.term-btn')).toBeNull()
    expect(text()).toContain('LTV')
    expect(text()).toContain('売上は')
    expect(text()).not.toContain('[[')
    expect(text()).not.toContain(']]')
    await m.React.act(async () => m.root.unmount())
  })
})
