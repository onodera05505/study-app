// @vitest-environment jsdom
/** UC-015「ロードマップ型の対象では、論点が学ぶ順に並び、メニューは 2 つに絞られる」の
 *  基本の流れを 1 本で実行する写し（正常系のみ。取れないときは REQ-149 のテストが見る）。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、ロードマップ型にしてから読み込み直して描く。
 *  ロードマップ型ではロードマップが /topics に載る。
 *  画面の文字は要件（REQ-038・REQ-143〜REQ-148）の文面から採る。
 *  1 日の単位数（3）と 1 回の問題数（6）は登録簿の値。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Unit = Record<string, unknown>

/** 単位の名前には数字を入れない（画面に出る数値の断言とぶつからないように）。 */
const NAMES = ['単位 甲', '単位 乙', '単位 丙', '単位 丁', '単位 戊', '単位 己', '単位 庚']
const unit = (i: number, status: number | null): Unit => ({
  id: 101 + i,
  term: NAMES[i],
  questionCount: 2,
  status,
  field: '業界と仕事',
  middle: 'コンサルの仕事',
  itemName: 'コンサルの仕事',
  isNew: 0,
  sortOrder: i + 1,
})

/** 7 単位。甲〜丁が理解（3）なので 1 日目（3 単位）は全部理解、いま学ぶ位置は戊。 */
const UNITS: Unit[] = [unit(0, 3), unit(1, 3), unit(2, 3), unit(3, 3), unit(4, 1), unit(5, null), unit(6, 2)]

const EXTRA_NAME = '補足の単位'
const EXTRA: Unit = {
  id: 200,
  term: EXTRA_NAME,
  questionCount: 2,
  status: null,
  field: '補足（ロードマップ外）',
  middle: 'ロードマップ外',
  itemName: 'ロードマップ外',
  isNew: 0,
  sortOrder: null,
}

/** 各日の確認テスト（1 回 6 問）。1 日目は 2 回受けている。 */
const EXAMS = {
  exams: [
    { exam: 'itc-d1', examLabel: '1 日目', questions: 6, attempts: 2, bestScore: 5 },
    { exam: 'itc-d2', examLabel: '2 日目', questions: 6, attempts: 0, bestScore: null },
    { exam: 'itc-d3', examLabel: '3 日目', questions: 6, attempts: 0, bestScore: null },
  ],
}

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 7, understood: 4, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 13, longest: 13, total: 13 },
}

const EXAM_QUESTION = '確認テストの問題文です。'

type Call = { url: string; method: string; body?: string }
let calls: Call[] = []
const countOf = (part: string, method = 'GET') =>
  calls.filter((c) => c.url.includes(part) && c.method === method).length

function stubApi() {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: url.pathname + url.search, method, body: init?.body ? String(init.body) : undefined })
    const p = url.pathname
    if (method === 'POST' && p.endsWith('/sessions')) {
      const body = { id: 's-new', kind: 'mock', scopeLabel: '1 日目', questionCount: 6, timeLimitSec: null }
      return { ok: true, status: 201, text: async () => JSON.stringify(body), json: async () => body }
    }
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'itc' }
    else if (p.endsWith('/sessions/s-new/current'))
      body = {
        session: { id: 's-new', kind: 'mock', scopeLabel: '1 日目', questionCount: 6, sourceExam: 'itc-d1' },
        question: {
          idx: 1,
          text: EXAM_QUESTION,
          choices: { ア: 'アの本文', イ: 'イの本文', ウ: 'ウの本文', エ: 'エの本文' },
          citation: null,
          modified: false,
          hasFigure: false,
          figureDescription: null,
          figureImage: null,
          timesAsked: 1,
          otherCitations: [],
        },
        answered: 0,
        remainingSec: null,
        finished: false,
      }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/topics')) body = { topics: [...UNITS, EXTRA] }
    else if (p.endsWith('/exams')) body = EXAMS
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

const CONTROLS = 'button, [role="button"], summary, a'
const trimmed = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

type View = {
  text: () => string
  menuText: () => string
  menuHrefs: () => string[]
  press: (name: string | RegExp) => Promise<void>
  close: () => Promise<void>
}
let view: View | null = null

/** ロードマップ型（VITE_EXAM=itc）で読み込み直して App を描く。 */
async function open(entry: string): Promise<View> {
  if (view) await view.close()
  vi.stubEnv('VITE_EXAM', 'itc')
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const api = await import('../../src/client/lib/api')
  api.setToken('token-for-scenario')
  const { App } = await import('../../src/client/App')
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  window.history.replaceState({}, '', entry)
  await React.act(async () => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(App)),
    )
  })
  const menu = () => el.querySelector('nav') ?? el.querySelector('header') ?? el
  view = {
    text: () => (el.textContent ?? '').replace(/\s+/g, ' '),
    menuText: () => (menu().textContent ?? '').replace(/\s+/g, ' '),
    menuHrefs: () =>
      [...menu().querySelectorAll('a')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((href) => href.startsWith('/') && href !== '/'),
    press: async (name) => {
      const els = [...el.querySelectorAll<HTMLElement>(CONTROLS)].filter((x) =>
        typeof name === 'string' ? trimmed(x).includes(name) : name.test(trimmed(x)),
      )
      const target =
        (typeof name === 'string' ? els.find((x) => trimmed(x) === String(name)) : undefined) ?? els[0]
      if (!target) throw new Error(`「${name}」の操作が画面に無い`)
      await React.act(async () => {
        target.click()
      })
    },
    close: async () => {
      await React.act(async () => root.unmount())
      el.remove()
    },
  }
  return view
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  stubApi()
})

afterEach(async () => {
  if (view) {
    await view.close()
    view = null
  }
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('UC-015 ロードマップ型の並びとメニュー', () => {
  // @scenario UC-015
  it('ロードマップ型の学びを開き、日ごとの並び・先頭の 1 行・各日の確認を辿って確認テストを始める', async () => {
    // 1. 利用者がロードマップ型の学びを開く。上部メニューは「ロードマップ」「フィードバック」の 2 つだけ
    const v = await open('/')
    expect([...new Set(v.menuHrefs())].sort(), '上部メニューが 2 つになっていない').toEqual([
      '/feedback',
      '/topics',
    ])
    expect(v.menuText()).toContain('ロードマップ')
    expect(v.menuText()).toContain('フィードバック')
    for (const word of ['練習', '模試', '履歴']) {
      expect(v.menuText(), `メニューに資格の語「${word}」が出ている`).not.toContain(word)
    }

    // 2. 利用者がホームの場所を開く。画面はロードマップへ送る
    expect(v.text(), 'ホームの場所がロードマップになっていない').toContain(NAMES[0])

    // 3. 画面は単位の一覧を取りに行く。システムは学ぶ順に並べて返す
    expect(countOf('/api/topics'), '単位の一覧を取りに行っていない').toBeGreaterThan(0)
    // 先頭の導線にも単位名が出るので、一覧の側（後ろの出現）で並びを見る
    const order = NAMES.map((name) => v.text().lastIndexOf(name))
    expect(order.every((i) => i >= 0), '単位が全部出ていない').toBe(true)
    expect(
      order.every((i, n) => n === 0 || order[n - 1] < i),
      '単位が学ぶ順に並んでいない',
    ).toBe(true)

    // 4. 画面は単位を 1 日ごとにまとめて並べ、最初のまだ理解していない単位に「ここから」を出す
    for (const day of ['1 日目', '2 日目', '3 日目']) {
      expect(v.text(), `${day} の区切りが無い`).toContain(day)
    }
    const body = v.text()
    const here = body.lastIndexOf('ここから')
    expect(here, '「ここから」が出ていない').toBeGreaterThan(-1)
    expect(here, '「ここから」が最初のまだ理解していない単位に付いていない').toBeGreaterThan(
      body.indexOf(NAMES[3]),
    )
    expect(here, '「ここから」が最初のまだ理解していない単位より後に付いている').toBeLessThan(
      body.indexOf(NAMES[5]),
    )

    // 5. 画面はロードマップの先頭に、理解した単位数と全体、連続日数を 1 行で出す
    expect(v.text(), '理解した単位数と全単位数が出ていない').toMatch(/理解\s*4\s*[／/]\s*7/)
    expect(v.text(), '連続日数が出ていない').toMatch(/連続\s*13\s*日/)

    // 6. 画面は各日の見出しに「この日の確認（N 問）」と、受けた回数を出す
    expect(v.text()).toContain('この日の確認')
    expect(v.text(), '1 回の問題数が出ていない').toMatch(/6\s*問/)
    expect(v.text(), '受けた回数が出ていない').toMatch(/2\s*回/)

    // 8. 画面はロードマップに入れなかった補足の単位を、末尾の別枠に並べる
    //    （7 で出題画面へ移る前に、同じ描画で確かめる）
    expect(v.text()).toContain(EXTRA_NAME)
    expect(
      v.text().indexOf(EXTRA_NAME),
      '補足の単位が日ごとの並びに混ざっている',
    ).toBeGreaterThan(v.text().indexOf(NAMES[6]))

    // 7. 利用者が「この日の確認」を押す。画面はその日の範囲と問数を示して確かめ、
    //    受けると答えたときだけその日の範囲のテストを作って出題画面へ移る
    //    （確かめの機構は仕様が決めていないので、この写しは「受ける」と答えたことだけを表す。
    //     確かめに範囲と問数が出ること・断ると作らないことは REQ-147 のテストが見る）
    vi.stubGlobal('confirm', () => true)
    await v.press('この日の確認')
    expect(countOf('/api/sessions', 'POST'), 'テストの作成をサーバに求めていない').toBe(1)
    expect(v.text(), '出題画面へ移っていない').toContain(EXAM_QUESTION)

    // 事後条件: 資格版の画面（履歴）には入れず、ロードマップになる
    const after = await open('/history')
    expect(after.text(), '資格版の履歴に入れてしまう').toContain(NAMES[0])
  })
})
