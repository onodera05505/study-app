// @vitest-environment jsdom
/** 画面の部品: 理解度のバッジ（StatusBadge.tsx）と論点の一覧の行の理解度（Topics.tsx）・用語の説明（TermPop.tsx）・
 *  同一内容の印（DupBadge.tsx）。
 *
 *  用語集は API から来るので fetch を偽物にして、先に取っておく
 *  （未取得の間は色を付けない仕様なので、取れている状態で見る）。 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { StatusBadge } from '../../src/client/components/StatusBadge'
import { Topics } from '../../src/client/pages/Topics'
import { invalidateCached } from '../../src/client/lib/api'
import { TermPop, shortTerm } from '../../src/client/components/TermPop'
import { DupBadge } from '../../src/client/components/DupBadge'
import { ensureGlossary } from '../../src/client/lib/glossary'

/** 末尾に括弧書きのある語（本文では括弧の前まで、ポップの見出しは正式表記）と、無い語。 */
const LONG_TERM = 'リスク対応（リスク回避，リスク共有，リスク保有）'
const GLOSSARY = [
  { term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 231 },
  { term: LONG_TERM, brief: 'リスクへの備え方の分類。', topicId: 77 },
]

let container: HTMLElement
let root: Root

/** 用語集だけを返す偽の fetch。 */
const glossaryFetch = async (url: string) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(String(url).endsWith('/glossary') ? { glossary: GLOSSARY } : {}),
})

const text = () => container.textContent ?? ''

async function draw(node: ReactNode) {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={['/topics/1']}>{node}</MemoryRouter>)
  })
}

beforeAll(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', glossaryFetch)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    ensureGlossary()
  })
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
})

describe('理解度の見せ方（UC-003）', () => {
  /** 段階の番号と段階の名前（用語集の語）。 */
  const STAGES = [
    [1, '未理解'],
    [2, 'やや理解'],
    [3, '理解'],
  ] as const

  /** 画面で観測できる文字（見える文字と読み上げの名前）。CSS だけで付く飾りはここに入らない。 */
  const observable = (el: Element) =>
    [el.textContent ?? '', ...[el, ...el.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') ?? '')]
      .join(' ')

  /** 用語「理解度」と段階の名前を取り除いた残り（空白は詰める）。段階ごとの記号はこの残りに現れる。
   *  「理解」は「理解度」の一部でもあるので、先に「理解度」を取り除く。 */
  const withoutName = (s: string, name: string) =>
    s.split('理解度').join('').split(name).join('').replace(/\s+/g, '')

  // @covers REQ-041#badge-text-and-mark-per-stage
  it('論点の画面の理解度は、3 段階それぞれで段階の名前と、段階ごとに違う記号が並んで出る', async () => {
    const rest: string[] = []
    for (const [status, name] of STAGES) {
      await draw(<StatusBadge status={status} />)
      const s = observable(container)
      expect(s, `status=${status} で段階の名前「${name}」が出ていない`).toContain(name)
      if (name === '理解') expect(s, '「理解」が「やや理解」と読み違えられる').not.toContain('やや')
      const mark = withoutName(s, name)
      expect(mark, `status=${status} で段階の名前のほかに記号が出ていない（観測できる文字: ${s}）`).not.toBe('')
      rest.push(mark)
    }
    expect(new Set(rest).size, `段階ごとの記号が互いに違わない: ${rest.join(' / ')}`).toBe(STAGES.length)
  })

  // @covers REQ-041#row-mark-per-stage
  it('論点の一覧の行の理解度は、3 段階それぞれで段階の名前と、段階ごとに違う記号が並んで出る', async () => {
    // 行どうしは名前と理解度だけが違い、ほかの値（小項目・出題回数）は同じにする
    const rows = STAGES.map(([status], i) => ({
      id: 701 + i,
      term: ['行の論点あ', '行の論点い', '行の論点う'][i],
      subtitle: null,
      questionCount: 5,
      status,
      field: 'ストラテジ系',
      middle: '行の単元',
      itemName: '行の小項目',
      isNew: 0,
      sortOrder: null,
      round: null,
      roundLabel: null,
      tier: null,
    }))
    invalidateCached()
    vi.stubGlobal('fetch', async (raw: string) => {
      const url = new URL(String(raw), 'http://localhost')
      let body: unknown = {}
      if (url.pathname.endsWith('/glossary')) body = { glossary: GLOSSARY }
      else if (url.pathname.endsWith('/fields'))
        body = { fields: [{ field: 'ストラテジ系', topics: 3, questions: 15, understood: 1, partly: 1, untouched: 1 }] }
      else if (url.pathname.endsWith('/categories'))
        body = {
          categories: [
            { middleNo: 9, middle: '行の単元', major: '行の大項目', field: 'ストラテジ系', topics: 3, questions: 15, understood: 1 },
          ],
        }
      else if (url.pathname.endsWith('/topics')) body = { topics: rows }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    })
    try {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/topics']}>
            <Routes>
              <Route path="/topics" element={<Topics />} />
              <Route path="/topics/:id" element={<div>論点の画面</div>} />
            </Routes>
          </MemoryRouter>,
        )
      })
      const unit = [...container.querySelectorAll<HTMLElement>('button, a, [role="button"]')].find((el) =>
        (el.textContent ?? '').includes('行の単元'),
      )
      expect(unit, '単元「行の単元」を選ぶ操作が画面に無い').toBeTruthy()
      await act(async () => {
        unit!.click()
      })

      const terms = rows.map((r) => r.term)
      /** その論点の名前を含み、ほかの論点の名前を含まない最も外側の要素を行とみなす。 */
      const rowOf = (term: string): Element => {
        const others = terms.filter((t) => t !== term)
        const hits = [...container.querySelectorAll('*')].filter((el) => {
          const s = el.textContent ?? ''
          return s.includes(term) && !others.some((o) => s.includes(o))
        })
        if (!hits.length) throw new Error(`論点「${term}」の行が画面に無い`)
        return hits.reduce((outer, el) => (el.contains(outer) ? el : outer))
      }

      const rest: string[] = []
      STAGES.forEach(([status, name], i) => {
        const s = observable(rowOf(terms[i]))
        expect(s, `status=${status} の行に段階の名前「${name}」が出ていない`).toContain(name)
        if (name === '理解') expect(s, '「理解」の行が「やや理解」と読み違えられる').not.toContain('やや')
        rest.push(withoutName(s.split(terms[i]).join(''), name))
      })
      // 名前と理解度以外は同じ行なので、残りの違いは段階ごとの記号の違いになる
      expect(new Set(rest).size, `一覧の行の記号が段階ごとに違わない: ${rest.join(' / ')}`).toBe(STAGES.length)
    } finally {
      vi.stubGlobal('fetch', glossaryFetch)
    }
  })
})

describe('用語の説明（UC-001）', () => {
  // @covers REQ-008#pop-heading-official-form
  it('本文の表示名は末尾の括弧書きを落とし、押すと出るポップの見出しは正式表記のまま', async () => {
    await draw(<TermPop term={LONG_TERM} />)
    const btn = container.querySelector<HTMLButtonElement>('button.term-btn')
    expect(btn, '用語が押せる要素になっていない').not.toBeNull()
    expect(btn!.textContent).toBe('リスク対応')
    await act(async () => {
      btn!.click()
    })
    const card = document.querySelector('.term-card')
    expect(card, '押してもポップが出ない').not.toBeNull()
    expect(card!.textContent).toContain('リスクへの備え方の分類。')
    expect(card!.textContent).toContain(LONG_TERM)
    expect(card!.querySelector('a.term-link')?.getAttribute('href')).toBe('/topics/77')
  })

  // @covers REQ-008#display-name-without-paren
  it('末尾に括弧書きが無ければそのまま、あれば括弧の前までにする', () => {
    expect(shortTerm('LTV')).toBe('LTV')
    expect(shortTerm(LONG_TERM)).toBe('リスク対応')
  })

  // @covers REQ-009#term-not-in-glossary
  it('用語集に無い語は押せる要素にせず、書かれた文字のまま出す', async () => {
    await draw(<TermPop term="まだ用語集に無い語" />)
    expect(container.querySelector('button.term-btn')).toBeNull()
    expect(text()).toBe('まだ用語集に無い語')
  })
})

describe('同一内容の過去問の印', () => {
  /** props の形は API の過去問の項目（timesAsked・otherCitations）と同じ。
   *  代表以外の回を、回の新しい順（令和5年度 → 平成28年度 春期）で渡す。 */
  const OTHERS = [
    '出典：令和5年度 ITパスポート試験 問4',
    '出典：平成28年度 春期 ITパスポート試験 問1',
  ]

  // @covers REQ-053#mark-shown-when-multiple
  it('2 回以上出題された問題には回数と、「他の出典：」に続けて代表以外の回を新しい順に出す', async () => {
    await draw(<DupBadge timesAsked={3} otherCitations={OTHERS} />)
    // 数の前後の空白は仕様が決めていないので、そこだけ緩めて見る
    expect(text()).toMatch(/同一の問題が\s*3\s*回出題されています/)
    const head = text().indexOf('他の出典：')
    expect(head, '「他の出典：」の見出しが出ていない').toBeGreaterThan(-1)
    // 代表以外の回は「回の名前 問N」の形（§9 の出典と同じ形。頭の「出典：」は代表の見出し）
    const first = text().indexOf('令和5年度 ITパスポート試験 問4')
    const second = text().indexOf('平成28年度 春期 ITパスポート試験 問1')
    expect(first, '新しい回の出典が見出しのあとに出ていない').toBeGreaterThan(head)
    expect(second, '古い回の出典が見出しのあとに出ていない').toBeGreaterThan(head)
    expect(first, '他の出典が回の新しい順に並んでいない').toBeLessThan(second)
    // 代表の見出し（「出典：」）とは分けるので、見出しのあとに「出典：」は出てこない
    expect(
      text().slice(head + '他の出典：'.length),
      '他の出典に代表の見出し「出典：」が混ざっている',
    ).not.toContain('出典：')
  })

  // @covers REQ-053#mark-shown-when-multiple
  it('まとめられていない（1 回だけの）問題には何も出さない', async () => {
    await draw(<DupBadge timesAsked={1} otherCitations={[]} />)
    expect(text()).toBe('')
  })
})
