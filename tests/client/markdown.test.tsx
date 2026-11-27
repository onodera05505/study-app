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
    // 説明文の出し方（画像に持たせず、図に結び付けた文字として 1 回）は REQ-427 が持つ
  })

  // @covers REQ-004#other-path
  it('置き場所の違う画像は画像にせず、段落として出す', async () => {
    await draw(h(Markdown, { source: '![外部](https://example.com/zu.png)' }))
    expect(container.querySelector('img')).toBeNull()
    expect(text()).toContain('![外部](https://example.com/zu.png)')
  })

  /** 置き場所を指す画像の記法が図として出て、記法の文字（`![` と `](指す先)`）が本文に残っていないこと。 */
  const expectFigureOnly = (src: string) => {
    const imgs = [...container.querySelectorAll('img')]
    expect(imgs.map((i) => i.getAttribute('src')), '置き場所を指す画像の記法が図になっていない').toEqual([src])
    expect(text(), '画像の記法が書かれた文字のまま出ている').not.toContain('![')
    expect(text(), '画像の記法が書かれた文字のまま出ている').not.toContain(`](${src})`)
  }

  // @covers REQ-004#material-figure-caption-brackets
  it('図の説明文に対になった角かっこ（A[1]）を含む、置き場所を指す画像の記法も図として出る', async () => {
    const src = '/figures/materials/ap/509-1.svg'
    await draw(
      h(Markdown, {
        source: `### 配列に置いた木と添字の順\n\n![根を A[1] に置き、子の添字を線の上の式（左が 2i、右が 2i＋1）で決めています。添字の小さい順に読むと、浅い段から、同じ段は左から右へたどる幅優先の順になります。](${src})`,
      }),
    )
    expectFigureOnly(src)
  })

  // @covers REQ-004#material-figure-caption-brackets
  it('図の説明文に対にならない角かっこ（区間の [0, 1)）を含む、置き場所を指す画像の記法も図として出る', async () => {
    const src = '/figures/materials/ap/12-2.svg'
    await draw(h(Markdown, { source: `![乱数は区間 [0, 1) の値を取り、横軸に並べています。](${src})` }))
    expectFigureOnly(src)
  })

  // @covers REQ-004#material-figure-caption-parens
  it('図の説明文に半角の丸かっこを含む、置き場所を指す画像の記法も図として出る', async () => {
    const src = '/figures/materials/fe/40-1.svg'
    await draw(h(Markdown, { source: `![子の添字は左が 2i (i は親の添字)、右が 2i+1 です。](${src})` }))
    expectFigureOnly(src)
  })

  // @covers REQ-004#other-path-caption-brackets
  it('図の説明文に角かっこを含んでも、置き場所の外を指す画像の記法は画像にせず、書かれた文字のまま出す', async () => {
    const line = '![根を A[1] に置いた木](https://example.com/zu.png)'
    await draw(h(Markdown, { source: line }))
    expect(container.querySelector('img')).toBeNull()
    expect(text()).toContain(line)
  })
})

/* ---------- 図の説明文（REQ-427） ---------- */

/** 観測できる形で見えないか（hidden・インラインの display / visibility）。aria-hidden は見た目を隠さない。 */
function visuallyHidden(el: Element): boolean {
  for (let e: Element | null = el; e && e !== container.parentElement; e = e.parentElement) {
    if (e.hasAttribute('hidden')) return true
    const st = (e as HTMLElement).style
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return true
  }
  return false
}

/** 読み上げから外れているか（見えない形か、aria-hidden か inert）。 */
function unannounced(el: Element): boolean {
  if (visuallyHidden(el)) return true
  for (let e: Element | null = el; e && e !== container.parentElement; e = e.parentElement) {
    if (e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('inert')) return true
  }
  return false
}

/** s の中に word が何回現れるか。 */
const occurrences = (s: string, word: string) => s.split(word).length - 1

/** 本文の中の文字の節（text node）を、その親の要素と一緒に集める。 */
function textNodes(): { text: string; parent: Element }[] {
  const out: { text: string; parent: Element }[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && (n.textContent ?? '') !== '') out.push({ text: n.textContent ?? '', parent: n.parentElement })
  }
  return out
}

/** id の並び（空白区切り）が指す要素の文字。 */
const referencedText = (ids: string | null) =>
  (ids ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

/** 画像そのものが持つ文字（代替文・title・aria-label・aria-labelledby / aria-describedby が指す文字）。 */
const imageCarried = (img: Element) =>
  [
    img.getAttribute('alt') ?? '',
    img.getAttribute('title') ?? '',
    img.getAttribute('aria-label') ?? '',
    referencedText(img.getAttribute('aria-labelledby')),
    referencedText(img.getAttribute('aria-describedby')),
  ].join(' ')

/** 見た目に現れる回数（見えている文字の節と、見えている要素の title の吹き出し）。 */
function visibleCount(caption: string): number {
  let n = 0
  for (const t of textNodes()) if (!visuallyHidden(t.parent)) n += occurrences(t.text, caption)
  for (const el of container.querySelectorAll('[title]'))
    if (!visuallyHidden(el)) n += occurrences(el.getAttribute('title') ?? '', caption)
  return n
}

/** 読み上げに届く回数（読み上げから外れていない文字の節と、外れていない要素の代替文・aria-label・title、
 *  画像が aria-labelledby / aria-describedby で指す文字）。 */
function announcedCount(caption: string): number {
  let n = 0
  for (const t of textNodes()) if (!unannounced(t.parent)) n += occurrences(t.text, caption)
  for (const el of container.querySelectorAll('*')) {
    if (unannounced(el)) continue
    n += occurrences(el.getAttribute('aria-label') ?? '', caption)
    n += occurrences(el.getAttribute('title') ?? '', caption)
    if (el.tagName === 'IMG') {
      n += occurrences(el.getAttribute('alt') ?? '', caption)
      n += occurrences(referencedText(el.getAttribute('aria-labelledby')), caption)
      n += occurrences(referencedText(el.getAttribute('aria-describedby')), caption)
    }
  }
  return n
}

/** 説明文が、その画像の図（figure か role="figure"）に結び付いた画面の文字か。
 *  結び付きは、同じ図の中の figcaption にあるか、図が aria-labelledby / aria-describedby で指す要素にあること。 */
function linkedTo(img: Element, caption: string): boolean {
  const fig = img.closest('figure, [role="figure"]')
  if (!fig) return false
  const captions = [...fig.querySelectorAll('figcaption')].filter((c) => c.closest('figure, [role="figure"]') === fig)
  if (captions.some((c) => !visuallyHidden(c) && (c.textContent ?? '').includes(caption))) return true
  return [fig.getAttribute('aria-labelledby'), fig.getAttribute('aria-describedby')].some((ids) =>
    (ids ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .some((id) => {
        const el = document.getElementById(id)
        return !!el && fig.contains(el) && !visuallyHidden(el) && (el.textContent ?? '').includes(caption)
      }),
  )
}

/** 1 枚の図について、説明文の出し方を確かめる。 */
function expectCaptionOnce(src: string, caption: string) {
  const img = container.querySelector(`img[src="${src}"]`)
  expect(img, `${src} の図が画像として出ていない`).toBeTruthy()
  expect(imageCarried(img!), `${src} の画像そのものが説明文を持っている`).not.toContain(caption)
  expect(linkedTo(img!, caption), `${src} の説明文が、その図に結び付いた画面の文字になっていない`).toBe(true)
  expect(visibleCount(caption), `「${caption}」が見た目で 1 回でない`).toBe(1)
  expect(announcedCount(caption), `「${caption}」が読み上げで 1 回でない`).toBe(1)
}

describe('図の説明文（UC-001）', () => {
  const CAPTION_1 = '売上高の線と総費用の線が交わる点が損益分岐点です。横軸の売上高で読みます。'
  const CAPTION_2 = '固定費は売上高によらず一定で、変動費は売上高に比例して増えます。'
  const SRC_1 = '/figures/materials/ip/102-1.svg'
  const SRC_2 = '/figures/materials/ip/102-2.svg'

  // @covers REQ-427#single-figure
  it('図が 1 枚の本文では、説明文は画像に持たせず、図に結び付いた画面の文字として見た目でも読み上げでも 1 回だけ出る', async () => {
    await draw(h(Markdown, { source: `損益分岐点を図で見ます。\n\n![${CAPTION_1}](${SRC_1})\n\n図のあとの本文です。` }))
    expectCaptionOnce(SRC_1, CAPTION_1)
  })

  // @covers REQ-427#several-figures
  it('説明文の違う図が 2 枚ある本文では、それぞれの説明文がそれぞれの図に結び付き、取り違えずに各 1 回だけ出る', async () => {
    await draw(h(Markdown, { source: `![${CAPTION_1}](${SRC_1})\n\n間の本文です。\n\n![${CAPTION_2}](${SRC_2})` }))
    expectCaptionOnce(SRC_1, CAPTION_1)
    expectCaptionOnce(SRC_2, CAPTION_2)
    const img1 = container.querySelector(`img[src="${SRC_1}"]`)!
    const img2 = container.querySelector(`img[src="${SRC_2}"]`)!
    expect(linkedTo(img1, CAPTION_2), '1 枚目の図に 2 枚目の説明文が結び付いている').toBe(false)
    expect(linkedTo(img2, CAPTION_1), '2 枚目の図に 1 枚目の説明文が結び付いている').toBe(false)
  })
})
