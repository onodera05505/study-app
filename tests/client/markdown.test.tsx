// @vitest-environment jsdom
/** 本文の記法（src/client/components/Markdown.tsx）と用語ポップ（TermPop.tsx）。
 *
 *  用語集は API から来るので fetch を偽物に差し替える。描くのは本物の React
 *  （react-dom/client）で、押したときの振る舞いまで見る。 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { Markdown } from '../../src/client/components/Markdown'
import { shortTerm } from '../../src/client/components/TermPop'
import { ensureGlossary } from '../../src/client/lib/glossary'

/** 用語集。論点に結び付いた語（topicId あり）と、そうでない語を 1 つずつ。 */
const GLOSSARY = [
  { term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 231 },
  { term: 'CSRF', brief: '他人の権限で操作させる攻撃。', topicId: null },
]

let container: HTMLElement
let root: Root

/** 今どのパスにいるか。押しても画面が移らないことを見るために添える。 */
function Probe() {
  return h('span', { id: 'path' }, useLocation().pathname)
}

async function draw(node: ReactNode) {
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: ['/topics/1'] }, node, h(Probe)))
  })
}

const text = () => container.textContent ?? ''
const path = () => container.querySelector('#path')?.textContent

beforeAll(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(String(url).endsWith('/glossary') ? { glossary: GLOSSARY } : {}),
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // 用語集を取ってから描く（未取得の間は色を付けない仕様なので、先に取る）
  await act(async () => {
    ensureGlossary()
  })
})

// 開いたポップは body に出るが、次に描き直した時点で React が片付ける
// （自分で消すと React の片付けとぶつかる）。

describe('用語ポップ', () => {
  // @verifies REQ-016
  it('[[用語]] が押せる要素になり、記法の括弧は残らない', async () => {
    await draw(h(Markdown, { source: '売上は [[LTV]] で見る。' }))
    const btn = container.querySelector('button.term-btn')
    expect(btn?.textContent).toBe('LTV')
    expect(text()).not.toContain('[[')
    expect(text()).not.toContain(']]')
  })

  // @verifies REQ-139
  it('太字の中の [[用語]] でも押せる要素になる', async () => {
    await draw(h(Markdown, { source: '- **[[LTV]]** — 生涯価値のこと' }))
    const btn = container.querySelector('li b button.term-btn')
    expect(btn?.textContent).toBe('LTV')
    expect(text()).not.toContain('[[')
    expect(text()).not.toContain('**')
  })

  // @verifies REQ-142
  it('用語集に無い語は色を付けず、文字のまま出す', async () => {
    await draw(h(Markdown, { source: '[[まだ無い用語]] の説明。' }))
    expect(container.querySelector('button.term-btn')).toBeNull()
    expect(text()).toContain('まだ無い用語')
    expect(text()).not.toContain('[[')
  })

  // @verifies REQ-016
  it('押すと 1 行説明と「この論点を学ぶ」が出て、画面は移らない', async () => {
    await draw(h(Markdown, { source: '売上は [[LTV]] で見る。' }))
    const btn = container.querySelector<HTMLButtonElement>('button.term-btn')!
    expect(document.querySelector('.term-card')).toBeNull()
    await act(async () => {
      btn.click()
    })
    const card = document.querySelector('.term-card')
    expect(card?.textContent).toContain('1 人の顧客が生涯で払う金額。')
    expect(card?.querySelector('a.term-link')?.getAttribute('href')).toBe('/topics/231')
    // ポップが出ただけで、読んでいた画面から移っていない
    expect(path()).toBe('/topics/1')
  })

  // @verifies REQ-016
  it('論点に結び付かない用語では「この論点を学ぶ」を出さない', async () => {
    await draw(h(Markdown, { source: '[[CSRF]] の対策。' }))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.term-btn')!.click()
    })
    const card = document.querySelector('.term-card')
    expect(card?.textContent).toContain('他人の権限で操作させる攻撃。')
    expect(card?.querySelector('a.term-link')).toBeNull()
  })

  // @verifies REQ-140
  it('本文に出す表示名は、末尾に括弧書き（読み・英字表記）があれば落とす', () => {
    // 末尾に括弧書きが無い語はそのまま
    expect(shortTerm('LTV')).toBe('LTV')
    expect(shortTerm('リスク対応（リスク回避，リスク共有，リスク保有）')).toBe('リスク対応')
    // 短い語でも、末尾の括弧書き（英字表記）は落とす
    expect(shortTerm('公開鍵（RSA）')).toBe('公開鍵')
  })
})

describe('本文の記法', () => {
  // @verifies REQ-018
  it('見出し・箇条書き・番号付き・太字を解釈する', async () => {
    await draw(
      h(Markdown, {
        source: '### 見出し\n- 一つ目\n- 二つ目\n\n1. 手順1\n2. 手順2\n\n**強い**ところ',
      }),
    )
    expect(container.querySelector('h3')?.textContent).toBe('見出し')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(container.querySelector('p b')?.textContent).toBe('強い')
  })

  // @verifies REQ-018
  it('区切り行のある表を見出しつきの表にする', async () => {
    await draw(h(Markdown, { source: '| 用語 | 違い |\n| --- | --- |\n| A | 速い |\n| B | 安い |' }))
    expect(container.querySelectorAll('table thead th')).toHaveLength(2)
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(2)
  })

  // @verifies REQ-018
  it('許した記法以外は書かれた文字のまま出す', async () => {
    await draw(
      h(Markdown, {
        source: '[リンク](https://example.com) と `コード` と > 引用\n**閉じていない強調',
      }),
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('code')).toBeNull()
    expect(container.querySelector('blockquote')).toBeNull()
    expect(text()).toContain('[リンク](https://example.com)')
    expect(text()).toContain('`コード`')
    expect(text()).toContain('> 引用')
    // 閉じていない ** は消さずに文字として残す（本文が消えないほうが大事）
    expect(text()).toContain('**閉じていない強調')
  })

  // @verifies REQ-017
  it('図の画像は /figures/materials/ の行だけを画像にする', async () => {
    await draw(h(Markdown, { source: '![LTV の図](/figures/materials/mkt/231-1.svg)' }))
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/figures/materials/mkt/231-1.svg')
    expect(img?.getAttribute('alt')).toBe('LTV の図')
    expect(container.querySelector('figcaption')?.textContent).toBe('LTV の図')
  })

  // @verifies REQ-017
  it('置き場所の違う画像は画像にせず、段落として出す', async () => {
    await draw(h(Markdown, { source: '![外部](https://example.com/zu.png)' }))
    expect(container.querySelector('img')).toBeNull()
    expect(text()).toContain('![外部](https://example.com/zu.png)')
  })
})
