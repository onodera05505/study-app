// @vitest-environment jsdom
/** UC-004「分野 → カテゴリ → 論点 を辿り、論点の解説と紐づく過去問を読む」の基本の流れを
 *  1 本で実行する写し（正常系のみ。失敗系・境界は REQ のテストが見る）。
 *
 *  資格版（学ぶ順が決まっていない対象）の画面。サーバの応答は偽の fetch で返し、
 *  画面の文字は要件（REQ-010・REQ-120〜REQ-126・REQ-055）の文面から採る。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

/** 分野ごとの論点数・過去問数と理解度の内訳（GET /api/fields）。 */
const FIELDS = {
  fields: [
    { field: 'ストラテジ系', topics: 4, questions: 24, understood: 2, partly: 1, untouched: 1 },
    { field: 'テクノロジ系', topics: 4, questions: 20, understood: 1, partly: 0, untouched: 3 },
  ],
}

/** 単元（中分類）ごとの論点数・過去問数と理解した数（GET /api/categories）。 */
const CATEGORIES = [
  { middleNo: 1, middle: '企業活動', major: '企業と法務', field: 'ストラテジ系', topics: 4, questions: 24, understood: 2 },
  { middleNo: 11, middle: 'セキュリティ', major: '技術要素', field: 'テクノロジ系', topics: 4, questions: 20, understood: 1 },
]

/** 単元「企業活動」の論点（出題頻度の降順）。 */
const TOPICS = [
  { id: 11, term: '損益分岐点', questionCount: 9, status: null, field: 'ストラテジ系', middle: '企業活動', itemName: '会計と財務', isNew: 0, sortOrder: null },
  { id: 12, term: 'PDCA', questionCount: 4, status: null, field: 'ストラテジ系', middle: '企業活動', itemName: '業務分析', isNew: 0, sortOrder: null },
]

const FIGURE_SRC = '/figures/ip/2024r06-q1.png'
/** 同一内容でまとめられた過去問の、代表以外の出典（回の新しい順。代表は令和6年度）。 */
const OTHER_CITATIONS = [
  '出典：令和5年度 ITパスポート試験 問4',
  '出典：平成28年度 春期 ITパスポート試験 問1',
]
/** 出典の「回の名前 問N」の形（§9。頭の「出典：」は代表の見出し）。 */
const withoutHead = (citation: string) => citation.replace('出典：', '')

const question = (n: number, over: Record<string, unknown> = {}) => ({
  id: `2024r06-q${n}`,
  number: n,
  examLabel: '令和6年度',
  exam: '2024r06',
  text: `過去問 ${n} の本文です。`,
  choices: { ア: `${n} のア`, イ: `${n} のイ`, ウ: `${n} のウ`, エ: `${n} のエ` },
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `出典：令和6年度 ITパスポート試験 問${n}`,
  modified: 0,
  timesAsked: 1,
  otherCitations: [] as string[],
  explanation: {
    correctReason: `過去問 ${n} の答えの根拠です。`,
    choices: [
      { label: 'ア', term: null, note: `${n} のアの説明` },
      { label: 'イ', term: null, note: `${n} のイの説明` },
      { label: 'ウ', term: null, note: `${n} のウの説明` },
      { label: 'エ', term: null, note: `${n} のエの説明` },
    ],
  },
  contentKey: `ck-${n}`,
  ...over,
})

/** 8 問。1 問目は図の画像つきで同一内容が 3 回、2 問目は画像の無い書き起こしだけ。 */
const QUESTIONS = [
  question(1, {
    hasFigure: 1,
    figureImage: FIGURE_SRC,
    figureDescription: '図の書き起こしです。',
    timesAsked: 3,
    otherCitations: OTHER_CITATIONS,
  }),
  question(2, { hasFigure: 1, figureImage: null, figureDescription: '表だけの書き起こしです。' }),
  question(3),
  question(4),
  question(5),
  question(6),
  question(7),
  question(8),
]

/** GET /api/topics/11 の応答。 */
const DETAIL = {
  topic: {
    id: 11,
    term: '損益分岐点',
    explanation: '短い説明の本文です。',
    detail: '詳しい解説の本文です。',
    questionCount: QUESTIONS.length,
    isNew: 0,
    status: null,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '企業活動',
    middleNo: 1,
    itemName: '会計と財務',
    syllabusItemId: 1,
  },
  questions: QUESTIONS,
  siblings: [{ id: 12, term: 'PDCA', questionCount: 4 }],
  nextTopic: null,
  neighbors: { prev: null, next: null },
}

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 8, understood: 3, partly: 1 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

let calls: string[] = []
const countOf = (part: string) => calls.filter((u) => u.includes(part)).length

function stubApi() {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}${url.search}`)
    const p = url.pathname
    const field = url.searchParams.get('field')
    const sameField = (f: string) => !field || f.startsWith(field) || field.startsWith(f)
    const middleNo = url.searchParams.get('middleNo')
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/fields')) body = FIELDS
    else if (p.endsWith('/categories')) body = { categories: CATEGORIES.filter((c) => sameField(c.field)) }
    else if (/\/topics\/\d+$/.test(p)) body = DETAIL
    else if (p.endsWith('/topics')) body = { topics: middleNo === '1' || !middleNo ? TOPICS : [] }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

const text = () => (host.textContent ?? '').replace(/\s+/g, ' ')
const images = () => [...host.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')

/** 押せるもの（役割と見える文字で探す。class・nth は使わない）。 */
const CONTROLS = 'button, [role="button"], summary, a'
const hit = (el: Element, name: string | RegExp) => {
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return typeof name === 'string' ? t.includes(name) : name.test(t)
}
const controls = (name: string | RegExp) =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => hit(el, name))
/** 見える文字が一致するものを先に選び、無ければ含むものを選ぶ。 */
async function press(name: string | RegExp) {
  const same = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === String(name)
  const els = controls(name)
  const target = (typeof name === 'string' ? els.find(same) : undefined) ?? els[0]
  if (!target) throw new Error(`「${name}」の操作が画面に無い`)
  await act(async () => {
    target.click()
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

describe('UC-004 分野 → 単元 → 論点 を辿って解説と過去問を読む', () => {
  // @scenario UC-004
  it('学習の画面を開き、分野で絞り、単元と論点を選び、解説と過去問を読んで一覧へ戻る', async () => {
    // 1. 利用者が学習の画面を開く。画面は分野と単元の集計を取りに行き、開いている間は覚えて取り直さない
    await open('/topics')
    expect(countOf('/api/fields'), '分野の集計を取りに行っていない').toBe(1)
    expect(countOf('/api/categories'), '単元の集計を取りに行っていない').toBeGreaterThan(0)

    // 2. システムは分野ごとの論点数・過去問数と理解度の内訳を返す（偽の fetch が受け持つ）
    // 3. システムは分野配下の単元ごとの論点数・過去問数と理解した数を返す（同上）

    // 4. 画面は分野で絞り込める単元の一覧を、論点数・過去問数・理解の割合つきで出す
    expect(text(), '大項目の見出しが無い').toContain('企業と法務')
    expect(text()).toContain('企業活動')
    expect(text(), '単元の過去問数が出ていない').toContain('24')
    expect(text(), '「理解した数／論点数」が出ていない').toMatch(/2\s*[／/]\s*4/)
    // 分野で絞り込める（絞り込む手段がある。押したときの絞り込みは REQ-121 のテストが見る）
    expect(controls(/ストラテジ/).length, '分野で絞り込む手段が無い').toBeGreaterThan(0)

    // 5. 利用者が単元を選ぶ。システムはその単元の論点を出題頻度の降順に、理解度つきで返す
    await press('企業活動')
    const asked = calls.filter((c) => c.includes('/api/topics?'))
    expect(asked.length, '単元を選んでも論点を取りに行っていない').toBeGreaterThan(0)
    expect(asked[asked.length - 1], '選んだ単元で絞って取りに行っていない').toContain('middleNo=1')

    // 6. 画面は論点の一覧を出題頻度つきで並べ、並べ替えと理解度の絞り込みを受ける
    expect(text()).toContain('損益分岐点')
    expect(text()).toContain('PDCA')
    expect(text(), '出題回数が出ていない').toContain('9')
    expect(text(), '小項目名が出ていない').toContain('会計と財務')
    expect(controls('名前順').length, '並べ替え（名前順）の手段が無い').toBeGreaterThan(0)
    expect(controls('やや理解').length, '理解度の絞り込みの手段が無い').toBeGreaterThan(0)

    // 7. 利用者が論点を選ぶ。システムは解説・紐づく過去問・同じ小項目の他の論点を返す
    await press('損益分岐点')
    expect(countOf('/api/topics/11'), '選んだ論点を取りに行っていない').toBe(1)

    // 8. 画面は短い説明を本文の記法で描き、詳しい解説は押したときだけ開く
    expect(text()).toContain('短い説明の本文です。')
    expect(text(), '押す前から詳しい解説が開いている').not.toContain('詳しい解説の本文です。')
    await press(/詳し/)
    expect(text()).toContain('詳しい解説の本文です。')

    // 9. 画面は紐づく過去問を、本文・選択肢・答え・解説を畳んだ形で出し、最初は数問だけ見せて残りは押して開く
    const explControls = () => controls(/解説/).filter((el) => !/詳し/.test(el.textContent ?? ''))
    expect(text()).toContain('過去問 1 の本文です。')
    expect(text(), '選択肢が出ていない').toContain('1 のア')
    expect(text(), '答えを押す前に問題の解説が開いている').not.toContain('過去問 1 の答えの根拠です。')
    expect(explControls(), '答えを押す前に解説の手段が出ている').toHaveLength(0)
    await press(/答え/)
    expect(explControls().length, '答えを出したのに解説の手段が無い').toBeGreaterThan(0)
    await act(async () => {
      explControls()[0].click()
    })
    expect(text()).toContain('過去問 1 の答えの根拠です。')
    const shown = QUESTIONS.filter((q) => text().includes(q.text)).length
    expect(shown, '最初から過去問が全部出ている（先頭の数問だけにする）').toBeLessThan(QUESTIONS.length)
    const rest = QUESTIONS.length - shown
    const more = controls(new RegExp(`${rest}\\s*問`))
    expect(more.length, `残り ${rest} 問を開く手段が無い`).toBeGreaterThan(0)
    await act(async () => {
      more[0].click()
    })
    expect(QUESTIONS.every((q) => text().includes(q.text)), '残りの過去問が開かない').toBe(true)

    // 10. 図として描かれた過去問について、画面は切り出した画像と書き起こしを併記する
    expect(images(), '原本から切り出した画像が出ていない').toContain(FIGURE_SRC)
    expect(text(), '画像の無い問題の書き起こしが本体として出ていない').toContain('表だけの書き起こしです。')

    // 11. 画面は同一内容でまとめられた過去問に「同一の問題が N 回出題されています」の印と、
    //     「他の出典：」に続けて代表以外の回の出典を回の新しい順に出す
    expect(text(), '同一内容の出題回数の印が出ていない').toMatch(
      /同一の問題が\s*3\s*回出題されています/,
    )
    const head = text().indexOf('他の出典：')
    expect(head, '「他の出典：」の見出しが出ていない').toBeGreaterThan(-1)
    // 代表以外の回が「回の名前 問N」の形で、渡した回の新しい順に見出しのあとへ並ぶ
    const places = OTHER_CITATIONS.map((c) => text().indexOf(withoutHead(c)))
    places.forEach((at, i) => {
      expect(at, `他の出典に「${withoutHead(OTHER_CITATIONS[i])}」が出ていない`).toBeGreaterThan(head)
    })
    expect(places[0], '他の出典が回の新しい順に並んでいない').toBeLessThan(places[1])

    // 12. 利用者は画面左上の戻るリンクで、来た一覧へ戻る
    //     行き先とラベルの文字は仕様が決めていないので断言しない（REQ-055 の範囲＝戻るリンクがあり、
    //     押すと来た一覧の側へ戻る、だけを固定する）
    await press(/戻る/)
    expect(text(), '戻るリンクで学習の一覧へ戻れていない').toContain('企業と法務')

    // 事後条件: 分野・単元の集計は画面を開いている間だけ覚えられ、次に一覧へ入っても取り直されない
    expect(countOf('/api/fields'), '一覧へ戻ったときに集計を取り直している').toBe(1)
  })
})
