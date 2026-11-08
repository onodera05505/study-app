// @vitest-environment jsdom
/** 本文の記法（src/client/components/Markdown.tsx）と用語の説明（TermPop.tsx）。
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

/** 用語集。論点に結び付いた語（topicId あり）と、そうでない語を 1 つずつ。
 *  あわせて、末尾の括弧書きを落とすと他の語と同じ表記になる語の組（REQ-341）と、
 *  括弧書きを落としても何とも重ならない語を置く。 */
const GLOSSARY = [
  { term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 231 },
  { term: 'CSRF', brief: '他人の権限で操作させる攻撃。', topicId: null },
  { term: 'スループット', brief: '単位時間あたりの処理量。', topicId: null },
  { term: 'スループット（ネットワーク）', brief: '単位時間あたりに運べるデータ量。', topicId: null },
  { term: 'キャッシュ（CPU）', brief: '主記憶との速度差を埋める記憶。', topicId: null },
  { term: 'キャッシュ（Web）', brief: '取得した応答を手元に残す仕組み。', topicId: null },
  { term: '公開鍵（RSA）', brief: '誰に配ってもよい鍵。', topicId: null },
]

/** 本文に描かれた押せる語の文字（出た順）。 */
const pressableTexts = () => [...container.querySelectorAll('button.term-btn')].map((b) => b.textContent ?? '')

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

describe('用語の説明（UC-001）', () => {
  // @covers REQ-003#term-notation
  it('[[用語]] が押せる要素になり、記法の括弧は残らない', async () => {
    await draw(h(Markdown, { source: '売上は [[LTV]] で見る。' }))
    const btn = container.querySelector('button.term-btn')
    expect(btn?.textContent).toBe('LTV')
    expect(text()).not.toContain('[[')
    expect(text()).not.toContain(']]')
  })

  // @covers REQ-007#term-in-bold
  it('太字の中の [[用語]] でも押せる要素になる', async () => {
    await draw(h(Markdown, { source: '- **[[LTV]]** — 生涯価値のこと' }))
    const btn = container.querySelector('li b button.term-btn')
    expect(btn?.textContent).toBe('LTV')
    expect(text()).not.toContain('[[')
    expect(text()).not.toContain('**')
  })

  // @covers REQ-009#term-not-in-glossary
  it('用語集に無い語は色を付けず、文字のまま出す', async () => {
    await draw(h(Markdown, { source: '[[まだ無い用語]] の説明。' }))
    expect(container.querySelector('button.term-btn')).toBeNull()
    expect(text()).toContain('まだ無い用語')
    expect(text()).not.toContain('[[')
  })

  // @covers REQ-010#brief-with-topic-link
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

  // @covers REQ-010#brief-without-topic-link
  it('論点に結び付かない用語では「この論点を学ぶ」を出さない', async () => {
    await draw(h(Markdown, { source: '[[CSRF]] の対策。' }))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.term-btn')!.click()
    })
    const card = document.querySelector('.term-card')
    expect(card?.textContent).toContain('他人の権限で操作させる攻撃。')
    expect(card?.querySelector('a.term-link')).toBeNull()
  })

  // @covers REQ-264#glossary-term-pressable
  it('用語集を取ったあとの本文では、記法で書かれた用語集の語がどれも押せる語として出る', async () => {
    await draw(h(Markdown, { source: '[[LTV]] を上げ、[[CSRF]] を防ぐ。' }))
    expect(pressableTexts(), '用語集にある語が押せる語として出ていない').toEqual(['LTV', 'CSRF'])
  })

  // @covers REQ-008#display-name-drops-paren
  it('落としても他の語と重ならない語は、重なる語の組がある用語集の中でも、本文で末尾の括弧書きを落とす', async () => {
    await draw(h(Markdown, { source: '[[公開鍵（RSA）]] で暗号化する。' }))
    expect(pressableTexts()).toEqual(['公開鍵'])
    expect(text()).not.toContain('（RSA）')
  })

  // @covers REQ-008#display-name-drops-paren
  it('本文に出す表示名は、末尾に括弧書き（読み・英字表記）があれば落とす', () => {
    // 末尾に括弧書きが無い語はそのまま
    expect(shortTerm('LTV')).toBe('LTV')
    expect(shortTerm('リスク対応（リスク回避，リスク共有，リスク保有）')).toBe('リスク対応')
    // 短い語でも、末尾の括弧書き（英字表記）は落とす
    expect(shortTerm('公開鍵（RSA）')).toBe('公開鍵')
  })
})

describe('用語の表示名の重なり（UC-001）', () => {
  // @covers REQ-341#same-as-other-term
  it('括弧書きを落とすと用語集の他の語と同じになる語は、本文でも正式な表記のまま出し、他の語と見分けられる', async () => {
    await draw(h(Markdown, { source: '[[スループット（ネットワーク）]] と [[スループット]] は別の語。' }))
    expect(pressableTexts(), '括弧書きを落として他の語と同じ表示名になっている').toEqual([
      'スループット（ネットワーク）',
      'スループット',
    ])
  })

  // @covers REQ-341#same-as-other-shortened
  it('括弧書きを落とすと互いに同じになる語どうしは、どちらも本文で正式な表記のまま出す', async () => {
    await draw(h(Markdown, { source: '[[キャッシュ（CPU）]] と [[キャッシュ（Web）]] を比べる。' }))
    expect(pressableTexts(), '括弧書きを落として互いに同じ表示名になっている').toEqual(['キャッシュ（CPU）', 'キャッシュ（Web）'])
  })

  // @covers REQ-341#same-as-other-term
  it('重なる相手の語が本文に無くても、用語集の他の語と同じになる語は正式な表記のまま出す', async () => {
    await draw(h(Markdown, { source: '[[スループット（ネットワーク）]] を測る。' }))
    expect(pressableTexts(), '相手の語が本文に無いときに括弧書きを落としている').toEqual(['スループット（ネットワーク）'])
  })

  // @covers REQ-341#same-as-other-shortened
  it('重なる相手の語が本文に無くても、括弧書きを落とすと他の語と同じになる語は正式な表記のまま出す', async () => {
    await draw(h(Markdown, { source: '[[キャッシュ（Web）]] を効かせる。' }))
    expect(pressableTexts(), '相手の語が本文に無いときに括弧書きを落としている').toEqual(['キャッシュ（Web）'])
  })
})

describe('本文の記法（UC-001）', () => {
  // @covers REQ-003#allowed-notations
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

  // @covers REQ-003#table-notation
  it('区切り行のある表を見出しつきの表にする', async () => {
    await draw(h(Markdown, { source: '| 用語 | 違い |\n| --- | --- |\n| A | 速い |\n| B | 安い |' }))
    expect(container.querySelectorAll('table thead th')).toHaveLength(2)
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(2)
  })

  // @covers REQ-003#foreign-notation
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

  // @covers REQ-004#material-figure-path
  it('図の画像は /figures/materials/ の行だけを画像にする', async () => {
    await draw(h(Markdown, { source: '![LTV の図](/figures/materials/mkt/231-1.svg)' }))
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/figures/materials/mkt/231-1.svg')
    expect(img?.getAttribute('alt')).toBe('LTV の図')
    expect(container.querySelector('figcaption')?.textContent).toBe('LTV の図')
  })

  // @covers REQ-004#other-path
  it('置き場所の違う画像は画像にせず、段落として出す', async () => {
    await draw(h(Markdown, { source: '![外部](https://example.com/zu.png)' }))
    expect(container.querySelector('img')).toBeNull()
    expect(text()).toContain('![外部](https://example.com/zu.png)')
  })
})
