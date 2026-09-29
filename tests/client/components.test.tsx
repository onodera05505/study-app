// @vitest-environment jsdom
/** 画面の部品: 理解度のバッジと行の印（StatusBadge.tsx）・用語ポップ（TermPop.tsx）・
 *  同一内容の印（DupBadge.tsx）。
 *
 *  用語集は API から来るので fetch を偽物にして、先に取っておく
 *  （未取得の間は色を付けない仕様なので、取れている状態で見る）。 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { StatusBadge, statusRowClass } from '../../src/client/components/StatusBadge'
import { TermPop, shortTerm } from '../../src/client/components/TermPop'
import { DupBadge } from '../../src/client/components/DupBadge'
import { ensureGlossary } from '../../src/client/lib/glossary'

/** 正式表記が長い語（本文では短く、ポップの見出しは正式表記）と、短い語。 */
const LONG_TERM = 'リスク対応（リスク回避，リスク共有，リスク保有）'
const GLOSSARY = [
  { term: 'LTV', brief: '1 人の顧客が生涯で払う金額。', topicId: 231 },
  { term: LONG_TERM, brief: 'リスクへの備え方の分類。', topicId: 77 },
]

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

async function draw(node: ReactNode) {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={['/topics/1']}>{node}</MemoryRouter>)
  })
}

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
  await act(async () => {
    root.render(null)
  })
})

describe('理解度の見せ方', () => {
  // @verifies REQ-130
  it('3 段階それぞれで段階の文字と段階ごとに違う印が出る（記録が無ければ未理解）', async () => {
    const marks: string[] = []
    for (const [status, want] of [[1, '未理解'], [2, 'やや理解'], [3, '理解']] as const) {
      await draw(<StatusBadge status={status} />)
      expect(text(), `status=${status} の段階の文字`).toContain(want)
      const el = container.querySelector<HTMLElement>('span.status-badge')
      expect(el, `status=${status} の印になる要素（span.status-badge）`).not.toBeNull()
      expect(el!.classList.contains(`st-${status}`), `status=${status} の印が st-${status} でない`).toBe(true)
      marks.push(el!.className)
    }
    // 「理解」だけは「やや理解」と読み違えられないこと
    await draw(<StatusBadge status={3} />)
    expect(text()).not.toContain('やや')
    // 色だけに頼らないための印（段階ごとに違う）
    expect(new Set(marks).size).toBe(3)
    // 記録が無い論点は未理解として示す
    await draw(<StatusBadge status={null} />)
    expect(text()).toContain('未理解')
    expect(container.querySelector('span.status-badge')?.classList.contains('st-1')).toBe(true)
  })

  // @verifies REQ-131
  it('一覧の行の印は段階ごとに変わり、記録が無いときは未理解と同じになる', () => {
    const rows = [statusRowClass(1), statusRowClass(2), statusRowClass(3)]
    expect(rows.every((c) => typeof c === 'string' && c.trim() !== '')).toBe(true)
    expect(new Set(rows).size).toBe(3)
    expect(statusRowClass(null)).toBe('row st-1')
    expect(statusRowClass(null)).toBe(statusRowClass(1))
  })
})

describe('用語ポップ', () => {
  // @verifies REQ-016, REQ-140
  it('本文の表示名は短くし、押すと出るポップの見出しは正式表記のまま', async () => {
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

  // @verifies REQ-140
  it('短い正式表記はそのまま出す（括弧書きを落とすのは長いときだけ）', () => {
    expect(shortTerm('LTV')).toBe('LTV')
    expect(shortTerm(LONG_TERM)).toBe('リスク対応')
  })

  // @verifies REQ-142
  it('用語集に無い語は押せる要素にせず、書かれた文字のまま出す', async () => {
    await draw(<TermPop term="まだ用語集に無い語" />)
    expect(container.querySelector('button.term-btn')).toBeNull()
    expect(text()).toBe('まだ用語集に無い語')
  })
})

describe('同一内容の過去問の印', () => {
  /** props の形は API の過去問の項目（timesAsked・otherCitations）と同じ。 */
  const OTHER = '出典：令和5年度 ITパスポート試験 問4'

  // @verifies REQ-126
  it('2 回以上出題された問題には回数と他の出典を出す', async () => {
    await draw(<DupBadge timesAsked={2} otherCitations={[OTHER]} />)
    expect(text()).toContain('同一の問題が 2 回出題されています')
    // 他の出典は頭の「出典：」を外して並べる
    expect(text()).toContain('他の出典: 令和5年度 ITパスポート試験 問4')
  })

  // @verifies REQ-126
  it('まとめられていない（1 回だけの）問題には何も出さない', async () => {
    await draw(<DupBadge timesAsked={1} otherCitations={[]} />)
    expect(text()).toBe('')
  })
})
