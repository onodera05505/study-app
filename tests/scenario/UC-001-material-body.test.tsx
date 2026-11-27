// @vitest-environment jsdom
/** UC-001「教材の本文を読み、用語の説明をその場で確かめる」の主シナリオを 1 本で実行する写し
 *  （正常系のみ。用語集が取れない・用語集に無い語は要件のテストが見る）。
 *
 *  本文を出す画面として論点の画面を使い、用語集の応答は待たせられる偽の fetch で返す。
 *  画面の文字は要件の文面から採る。
 *  教材の図の置き場所は /figures/materials/<試験>/（既定の対象は ip）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

/** 用語集（用語・1 行説明・紐づく論点）。末尾に括弧書きのある語を 1 つ入れる。 */
const PAREN_TERM = 'リスク対応（リスク回避，リスク共有，リスク保有）'
const GLOSSARY = [
  { term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 999 },
  { term: PAREN_TERM, brief: 'リスクへの向き合い方の総称。', topicId: null },
]

const FIGURE_SRC = '/figures/materials/ip/231-1.svg'
const OUTSIDE_FIGURE = '![外部の図](https://example.com/zu.png)'

/** 決めた記法（見出し・箇条書き・番号付き・太字・表・用語・図の画像行）と、許していない記法。 */
const BODY = [
  '### 見出しの行',
  '- **[[LTV]]** — 生涯価値のこと',
  '',
  '売上は [[LTV]] で見る。',
  '',
  // 正式表記は本文に地の文としては置かない（用語の説明の見出しだけで確かめるため）
  `リスクへの備えは [[${PAREN_TERM}]] を読む。`,
  '',
  '| 用語 | 違い |',
  '| --- | --- |',
  '| A | 速い |',
  '',
  '[リンク](https://example.com) と `コード` はそのまま。',
  '',
  `![LTV の図](${FIGURE_SRC})`,
  '',
  OUTSIDE_FIGURE,
].join('\n')

const DETAIL = {
  topic: {
    id: 231,
    term: 'LTV',
    subtitle: null,
    explanation: BODY,
    detail: null,
    questionCount: 0,
    frequencyTier: null,
    isNew: 0,
    status: 0,
    statusSource: 'auto',
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '事業の指標',
    middleNo: 4,
    itemName: '会計と財務',
    tier: null,
  },
  questions: [],
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
}

let glossaryCalls = 0
/** 用語集の応答を止めておく門（step 3 の「引けていない間」を作る）。 */
let openGate!: () => void

function stubApi() {
  glossaryCalls = 0
  const gate = new Promise<void>((r) => {
    openGate = r
  })
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    if (p.endsWith('/glossary')) {
      glossaryCalls++
      await gate
      const body = { glossary: GLOSSARY }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
    }
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (/\/topics\/\d+$/.test(p)) body = DETAIL
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

const text = () => (host.textContent ?? '').replace(/\s+/g, ' ')
/** 用語の説明はページの外側（body）に出ることがあるので、body の文字も見る。 */
const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
const images = () => [...host.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')
const headings = () =>
  [...host.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => (el.textContent ?? '').trim())

const CONTROLS = 'button, [role="button"], summary, a'
const hit = (el: Element, name: string) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === name
/** 見える文字が一致する押せるもの（用語は押せる語になる）。 */
const controls = (name: string) =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => hit(el, name))
async function press(name: string) {
  const els = controls(name)
  if (!els.length) throw new Error(`「${name}」の押せる語が画面に無い`)
  await act(async () => {
    els[0].click()
  })
}

async function open(entry: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.history.replaceState({}, '', entry)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(App)))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  stubApi()
  setToken('token-for-scenario')
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

describe('UC-001 本文の用語の説明と図の描画', () => {
  // @scenario UC-001
  it('用語集を 1 度だけ引き、記法どおりに本文を描き、用語を押して 1 行説明を出す', async () => {
    // step 1・2: 利用者が教材を開く。画面は用語集をまとめて取りに行き、何度求められても 1 回しか取りに行かない
    await open('/topics/231')
    expect(glossaryCalls, '用語集を 1 回だけ取りに行っていない').toBe(1)

    // 用語集を引けていない間は未取得として扱い、本文の用語に色を付けない
    expect(text(), '本文が出ていない').toContain('売上は')
    expect(controls('LTV'), '用語集が引けていないのに押せる語になっている').toHaveLength(0)

    // step 2: システムは用語集の全語（用語・1 行説明・紐づく論点）を返す
    await act(async () => {
      openGate()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(glossaryCalls, '用語集を取り直している').toBe(1)

    // step 3: 画面は本文を決めた記法（見出し・箇条書き・番号付き・太字・表）だけ解釈し、それ以外は文字のまま出す
    expect(headings(), '見出しの記法が解釈されていない').toContain('見出しの行')
    const items = [...host.querySelectorAll('li')].map((el) => (el.textContent ?? '').trim())
    expect(
      items.some((t) => t.includes('生涯価値のこと')),
      '箇条書きの記法が解釈されていない',
    ).toBe(true)
    const cells = [...host.querySelectorAll('table td, table th')].map((el) => (el.textContent ?? '').trim())
    expect(cells, '表の記法が解釈されていない').toContain('速い')
    expect(cells, '表の見出しが解釈されていない').toContain('用語')
    expect(host.querySelector('a[href="https://example.com"]'), '許していないリンクの記法が解釈されている').toBeNull()
    expect(text(), '許していない記法が文字のまま出ていない').toContain('[リンク](https://example.com)')
    expect(text()).toContain('`コード`')

    // step 3: 画面は行の中の記法を描き、太字の中の [[用語]] も押せる語にする
    expect(controls('LTV').length, '太字の中と本文の中の用語が押せる語になっていない').toBeGreaterThan(1)
    expect(text(), '記法の括弧が残っている').not.toContain('[[')
    expect(text(), '太字の記法が文字のまま残っている').not.toContain('**')

    // step 4・5: 利用者が色の付いた用語を押す。画面は 1 行の説明と「この論点を学ぶ →」をその場に出し、画面は移らない
    await press('LTV')
    expect(pageText(), '1 行の説明が出ていない').toContain('1 人の顧客が生涯で払う金額。')
    const toTopic = [...document.body.querySelectorAll('a')].find((a) =>
      /この論点を学ぶ/.test(a.textContent ?? ''),
    )
    expect(toTopic, '「この論点を学ぶ →」が出ていない').toBeTruthy()
    expect(toTopic!.getAttribute('href')).toBe('/topics/999')
    expect(text(), '用語を押したら画面が移ってしまった').toContain('売上は')

    // 本文に出す用語の表示名は、末尾に括弧書き（読み・英字表記）があればそれを落として出す
    //（用語の説明の見出しは正式表記のまま）
    expect(controls('リスク対応').length, '末尾の括弧書きが落ちていない').toBeGreaterThan(0)
    await press('リスク対応')
    expect(pageText(), '用語の説明の見出しが正式表記になっていない').toContain(PAREN_TERM)

    // step 3: 画面は図の画像行を、教材の図の置き場所のものだけ画像にし、他の画像記法は文字のまま出す
    expect(images(), '教材の図の置き場所の画像行が画像になっていない').toContain(FIGURE_SRC)
    expect(images(), '置き場所の違う画像行が画像になっている').not.toContain('https://example.com/zu.png')
    expect(text(), '置き場所の違う画像記法が文字のまま出ていない').toContain(OUTSIDE_FIGURE)
  })
})
