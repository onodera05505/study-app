// @vitest-environment jsdom
/** 本文の記法・用語の説明・教材の図（src/client/components/Markdown.tsx と TermPop.tsx）の、
 *  UC-001 の未返済の分割クラス。
 *
 *  用語集は API から来るので fetch を偽物に差し替え、取ってから描く（未取得の間の振る舞いは
 *  repay_UC-001_glossary_state.test.ts が見る）。描くのは本物の React で、押す・外を触る・
 *  Esc を押すまでを DOM のイベントで起こす。用語の説明は body に出るので body から探す。
 *  図の切り替えは、切り替える手段の名前（原寸へ／画面幅へ）が入れ替わることで観測する。 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { Markdown } from '../../src/client/components/Markdown'
import { ensureGlossary } from '../../src/client/lib/glossary'

/** 用語集。紐づく論点のある語と無い語を 1 つずつ。 */
const GLOSSARY = [
  { term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 231 },
  { term: 'CSRF', brief: '他人の権限で操作させる攻撃。', topicId: null },
]

const FIGURE_SRC = '/figures/materials/ip/231-1.svg'
const BODY_WITH_TERM = '前の段落。\n\n売上は [[LTV]] で見る。\n\n後の段落。'

let container: HTMLElement
let root: Root

/** 今どのパスにいるか（押しても画面が移らないことを見る）。 */
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
const card = () => document.querySelector('.term-card')
const termButton = () => container.querySelector<HTMLButtonElement>('button.term-btn')!

/** 用語を押して説明を開く。 */
async function openTerm() {
  await act(async () => {
    termButton().click()
  })
  expect(card(), '前提: 用語を押しても説明が開かない').not.toBeNull()
}

/** 指の操作を、押し始めから押し終わりまで順にその要素で起こす。 */
async function touch(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 教材の図の表示を切り替える手段（原寸へ・画面幅へ）。名前で引く。 */
const toFullSize = () => container.querySelector<HTMLElement>('[aria-label="図を原寸で表示する"]')
const toFitWidth = () =>
  [...container.querySelectorAll<HTMLElement>('[aria-label]')].find((el) =>
    (el.getAttribute('aria-label') ?? '').includes('画面幅'),
  ) ?? null

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
  await act(async () => {
    ensureGlossary()
  })
})

afterEach(async () => {
  // 開いたままの説明を次のテストに持ち越さない（描き直しで React が片付ける）
  await draw(h('span'))
})

describe('本文の記法（UC-001）', () => {
  // @covers REQ-003#unclosed-notation
  it('閉じていない記法は解釈せず、書かれた文字のまま出す', async () => {
    for (const src of ['**閉じていない強調', '閉じていない強調** の後', '[[閉じていない用語']) {
      await draw(h(Markdown, { source: src }))
      expect(container.querySelector('b'), `「${src}」が太字として解釈された`).toBeNull()
      expect(container.querySelector('button.term-btn'), `「${src}」が押せる語として解釈された`).toBeNull()
      expect(text(), `「${src}」が文字のまま出ていない`).toContain(src)
    }
  })
})

describe('用語の説明を開いたまま（UC-001）', () => {
  // @covers REQ-011#no-navigation-on-press
  it('用語を押しても、読んでいた画面から移らない', async () => {
    for (const src of ['売上は [[LTV]] で見る。', '[[CSRF]] の対策。']) {
      await draw(h(Markdown, { source: src }))
      expect(path()).toBe('/topics/1')
      await openTerm()
      expect(path(), `「${src}」の用語を押したら画面が移った`).toBe('/topics/1')
      // 読んでいた本文はそのまま残る
      expect(text()).toContain(src.replace(/\[\[|\]\]/g, ''))
    }
  })

  // @covers REQ-013#same-term-pressed-again
  it('同じ用語をもう一度押すと説明が閉じる', async () => {
    await draw(h(Markdown, { source: BODY_WITH_TERM }))
    await openTerm()
    await act(async () => {
      termButton().click()
    })
    expect(card(), 'もう一度押しても説明が閉じない').toBeNull()
    // 閉じたあとも本文は読める
    expect(text()).toContain('売上は')
    expect(path()).toBe('/topics/1')
  })

  // @covers REQ-013#press-outside
  it('説明の外を触ると説明が閉じる', async () => {
    await draw(h(Markdown, { source: BODY_WITH_TERM }))
    await openTerm()
    const outside = [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('後の段落'))!
    expect(card()!.contains(outside), '前提: 触る場所が説明の中にある').toBe(false)
    await touch(outside)
    expect(card(), '説明の外を触っても説明が閉じない').toBeNull()
    expect(text()).toContain('売上は')
  })

  // @covers REQ-013#escape-key
  it('Esc を押すと説明が閉じる', async () => {
    await draw(h(Markdown, { source: BODY_WITH_TERM }))
    await openTerm()
    await act(async () => {
      card()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(card(), 'Esc を押しても説明が閉じない').toBeNull()
    expect(text()).toContain('売上は')
  })
})

describe('教材の図（UC-001）', () => {
  // @covers REQ-006#press-to-full-size
  it('画面幅で出ている図を押すと原寸に変わる', async () => {
    await draw(h(Markdown, { source: `![LTV の図](${FIGURE_SRC})` }))
    expect(container.querySelector(`img[src="${FIGURE_SRC}"]`), '前提: 教材の図が出ていない').not.toBeNull()
    const press = toFullSize()
    expect(press, '原寸に切り替える手段が無い').not.toBeNull()
    expect(toFitWidth(), '押す前から原寸になっている').toBeNull()
    await act(async () => {
      press!.click()
    })
    expect(toFitWidth(), '押しても原寸に変わらない（画面幅へ戻す手段が出ない）').not.toBeNull()
    expect(toFullSize(), '原寸に変わったのに、まだ原寸へ切り替える手段が出ている').toBeNull()
    // 図はそのまま出ている
    expect(container.querySelector(`img[src="${FIGURE_SRC}"]`)).not.toBeNull()
  })

  // @covers REQ-006#press-again-to-fit
  it('原寸で出ている図をもう一度押すと画面幅に戻る', async () => {
    await draw(h(Markdown, { source: `![LTV の図](${FIGURE_SRC})` }))
    await act(async () => {
      toFullSize()!.click()
    })
    const back = toFitWidth()
    expect(back, '前提: 原寸になっていない').not.toBeNull()
    await act(async () => {
      back!.click()
    })
    expect(toFullSize(), 'もう一度押しても画面幅に戻らない').not.toBeNull()
    expect(toFitWidth(), '画面幅に戻ったのに、まだ画面幅へ戻す手段が出ている').toBeNull()
    expect(container.querySelector(`img[src="${FIGURE_SRC}"]`)).not.toBeNull()
  })
})
