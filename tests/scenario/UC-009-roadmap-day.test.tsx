// @vitest-environment jsdom
/** UC-009「学ぶ順に並んだ論点を日ごとに辿り、この日の確認を始める」の主シナリオ 1〜13 を
 *  1 本で実行する写し（正常系のみ。取れないとき・端の単位は要件のテストが見る）。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、ロードマップ型にしてから読み込み直して描く。
 *  ロードマップ型ではロードマップが /topics に載る。
 *  画面を探す手がかりは次の 3 種だけにし、行き先の文字列や画面の作りは見ない:
 *  用語集の語（ロードマップ・単位・前回の続き・この日の確認・フィードバック）、
 *  要件が引用符で定める画面の語（「ここから」＝REQ-130・REQ-144）、
 *  要件が述べる導線を用語集の「単位」で呼んだ語（前の単位・次の単位＝REQ-139 の学ぶ順の前後の導線）。
 *  1 日の単位数（3）と 1 回の問題数（6）は登録簿の値。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Unit = Record<string, unknown>

/** 単位の名前には数字を入れない（画面に出る数値の断言とぶつからないように）。 */
const NAMES = ['単位 甲', '単位 乙', '単位 丙', '単位 丁', '単位 戊', '単位 己', '単位 庚']
const ID = (i: number) => 101 + i
const unit = (i: number, status: number | null): Unit => ({
  id: ID(i),
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

/** 単位の画面に出る教材の本文と確認問題の本文（単位ごとに別の文にして、移ったことを見る）。 */
const MATERIAL = (name: string) => `${name} の教材の本文です。`
const QUIZ = (name: string) => `${name} の確認問題の本文です。`

/** 1 単位の教材と確認問題、学ぶ順の前後の単位（UC-002 の契約 getTopicDetail の形）。 */
const detail = (i: number) => ({
  topic: {
    id: ID(i),
    term: NAMES[i],
    explanation: MATERIAL(NAMES[i]),
    detail: null,
    questionCount: 1,
    isNew: 0,
    status: UNITS[i].status,
    field: '業界と仕事',
    major: '業界と仕事',
    middle: 'コンサルの仕事',
    middleNo: 1,
    itemName: 'コンサルの仕事',
    syllabusItemId: 1,
  },
  questions: [
    {
      id: `itc-d2-q${i}`,
      number: i + 1,
      examLabel: '2 日目',
      exam: 'itc-d2',
      text: QUIZ(NAMES[i]),
      choices: { ア: 'アの本文', イ: 'イの本文', ウ: 'ウの本文', エ: 'エの本文' },
      answer: 'ア',
      hasFigure: 0,
      figureDescription: null,
      figureImage: null,
      citation: null,
      modified: 0,
      timesAsked: 1,
      otherCitations: [] as string[],
      explanation: {
        correctReason: `${NAMES[i]} の確認問題の答えの根拠です。`,
        choices: [
          { label: 'ア', term: null, note: 'アの説明' },
          { label: 'イ', term: null, note: 'イの説明' },
          { label: 'ウ', term: null, note: 'ウの説明' },
          { label: 'エ', term: null, note: 'エの説明' },
        ],
      },
      contentKey: `ck-${i}`,
    },
  ],
  siblings: [],
  nextTopic: null,
  neighbors: {
    prev: i > 0 ? { id: ID(i - 1), term: NAMES[i - 1] } : null,
    next: i < NAMES.length - 1 ? { id: ID(i + 1), term: NAMES[i + 1] } : null,
  },
})

/** 各日の確認テスト（1 回 6 問）。1 日目は 2 回受けていて最高 5 問正解。 */
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

type Call = { url: string; method: string }
let calls: Call[] = []
const countOf = (part: string, method = 'GET') =>
  calls.filter((c) => c.url.includes(part) && c.method === method).length

function stubApi() {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: url.pathname + url.search, method })
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
    else if (/\/topics\/\d+$/.test(p)) {
      const i = NAMES.findIndex((_, n) => ID(n) === Number(p.split('/').pop()))
      body = detail(i < 0 ? 0 : i)
    } else if (p.endsWith('/topics')) body = { topics: [...UNITS, EXTRA] }
    else if (p.endsWith('/exams')) body = EXAMS
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

const CONTROLS = 'button, [role="button"], summary, a'
const trimmed = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

/** 先頭（日ごとの並びより前）と、日ごとの並び。日の見出しを境に分ける。 */
const DAY_ONE = '1 日目'
const lead = (t: string) => t.slice(0, t.indexOf(DAY_ONE))
const days = (t: string) => t.slice(t.indexOf(DAY_ONE))
/** 日ごとの並びの中での出てくる順（出ていなければ -1）。 */
const order = (t: string, word: string) => days(t).indexOf(word)

/** 押したことで画面に増えた文（確かめが画面の中に出る作りでも読めるように、前後の差を採る）。 */
const addedText = (before: string, after: string) => {
  let s = 0
  while (s < before.length && before[s] === after[s]) s++
  let e = 0
  while (e < before.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++
  return after.slice(s, after.length - e)
}

type View = {
  text: () => string
  menuText: () => string
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

describe('UC-009 学ぶ順に並んだ論点を日ごとに辿り、この日の確認を始める', () => {
  // @scenario UC-009
  it('ロードマップを開き、日ごとの並びから単位を開いて学ぶ順に読み進め、ロードマップへ戻ってこの日の確認を始める', async () => {
    // step 1: 利用者がロードマップを開く
    let v = await open('/topics')
    expect(v.text(), 'ロードマップが出ていない').toContain(NAMES[0])

    // step 2: 行ける先はロードマップとフィードバックに限られ、資格対策だけの画面には入れない
    expect(v.menuText(), 'ロードマップへの導線が無い').toContain('ロードマップ')
    expect(v.menuText(), 'フィードバックへの導線が無い').toContain('フィードバック')
    for (const word of ['練習', '模試', '演習', '履歴']) {
      expect(v.menuText(), `資格対策だけの語「${word}」が行ける先に出ている`).not.toContain(word)
    }
    v = await open('/history') // 資格対策だけの画面（受験履歴）の場所
    expect(v.text(), '資格対策だけの画面に入れてしまう').toContain(NAMES[0])

    // step 3: システムが単位を学ぶ順に並べ、1 日ごとにまとめて日の順に示す
    v = await open('/topics')
    expect(countOf('/api/topics'), '単位の一覧を取りに行っていない').toBeGreaterThan(0)
    for (const day of [DAY_ONE, '2 日目', '3 日目']) {
      expect(v.text(), `${day} の区切りが無い`).toContain(day)
    }
    const map = v.text()
    const placed = NAMES.map((name) => order(map, name))
    expect(
      placed.every((i) => i >= 0),
      '単位が全部出ていない',
    ).toBe(true)
    expect(
      placed.every((i, n) => n === 0 || placed[n - 1] < i),
      '単位が学ぶ順に並んでいない',
    ).toBe(true)

    // step 4: システムが理解した単位数と全体、連続記録を先頭に示し、
    // 最初のまだ理解していない単位を「ここから」として示す
    expect(lead(map), '理解した単位数と全単位数が先頭に出ていない').toMatch(/理解\s*4\s*[／/]\s*7/)
    expect(lead(map), '連続記録が先頭に出ていない').toMatch(/連続\s*13\s*日/)
    expect(order(map, 'ここから'), '「ここから」が並びに出ていない').toBeGreaterThan(-1)
    expect(
      order(map, 'ここから'),
      '「ここから」が最初のまだ理解していない単位より前に付いている',
    ).toBeGreaterThan(order(map, NAMES[3]))
    expect(
      order(map, 'ここから'),
      '「ここから」が最初のまだ理解していない単位より後に付いている',
    ).toBeLessThan(order(map, NAMES[5]))

    // step 5: システムが先頭に続きの導線を 1 つ示す。前回の続きが無いので行き先は「ここから」の単位
    expect(lead(map), '前回の続きが無いのに前回の続きの導線が出ている').not.toContain('前回の続き')
    expect(lead(map), '先頭に続きの導線が無い').toContain('ここから')
    expect(lead(map), '続きの導線に行き先の単位名が出ていない').toContain(NAMES[4])

    // step 6: システムが各日にこの日の確認の問数と、受けた回数・最高の正解数を示す
    expect(v.text(), 'この日の確認が各日に出ていない').toContain('この日の確認')
    expect(v.text(), 'この日の確認の問数が出ていない').toMatch(/6\s*問/)
    expect(v.text(), 'この日の確認を受けた回数が出ていない').toMatch(/2\s*回/)
    expect(v.text(), 'この日の確認の最高の正解数が出ていない').toContain('5')

    // step 7: システムが学ぶ順に入っていない補足の単位を末尾の別枠に示す
    expect(order(map, EXTRA_NAME), '補足の単位が出ていない').toBeGreaterThan(-1)
    expect(order(map, EXTRA_NAME), '補足の単位が日ごとの並びに混ざっている').toBeGreaterThan(
      order(map, NAMES[6]),
    )

    // step 8: 利用者が先頭の続きの導線を開く（行き先は「ここから」の単位）
    await v.press(/^ここから/)

    // step 9: システムが教材と確認問題を示し、末尾に学ぶ順の前後の単位への導線を単位名つきで添える
    const opened = v.text()
    expect(opened, '続きの導線の行き先の単位の教材が出ていない').toContain(MATERIAL(NAMES[4]))
    expect(opened, '単位の確認問題が出ていない').toContain(QUIZ(NAMES[4]))
    expect(opened, '前の単位への導線が無い').toContain('前の単位')
    expect(opened, '次の単位への導線が無い').toContain('次の単位')
    expect(opened, '前の単位の名前が出ていない').toContain(NAMES[3])
    expect(opened, '次の単位の名前が出ていない').toContain(NAMES[5])
    expect(opened.indexOf('次の単位'), '前後の導線が教材と確認問題より前に出ている').toBeGreaterThan(
      opened.indexOf(QUIZ(NAMES[4])),
    )

    // step 10: 利用者が次の単位へ移り、学ぶ順のとおりに読み進める
    await v.press(/次の単位/)
    expect(v.text(), '学ぶ順の次の単位へ移っていない').toContain(MATERIAL(NAMES[5]))

    // step 11（BR-016）: 利用者がロードマップへ戻る
    const backToRoadmap = /ロードマップ[^。]{0,4}戻/
    expect(v.text(), '単位の画面にロードマップへ戻る導線が無い').toMatch(backToRoadmap)
    await v.press(backToRoadmap)
    expect(v.text(), 'ロードマップへ戻っていない').toContain(DAY_ONE)
    expect(v.text(), 'ロードマップへ戻っていない').toContain(NAMES[0])

    // step 12: 利用者がその日の確認を始める。システムが範囲と問数を示して確かめを取る
    // step 13: 利用者が受けると答える。システムがその日の範囲でテストを作り、出題の画面へ移す
    //（確かめの機構は仕様が決めていないので、問われた文と、そのときに画面へ増えた文の両方から読む）
    const beforePress = v.text()
    let confirmed = ''
    vi.stubGlobal('confirm', (message?: unknown) => {
      confirmed = `${String(message ?? '')} ${addedText(beforePress, view!.text())}`
      return true
    })
    await v.press('この日の確認')
    expect(confirmed, '確かめにその日の範囲が出ていない').toContain(DAY_ONE)
    expect(confirmed, '確かめにその日の問数が出ていない').toMatch(/6\s*問/)
    expect(v.text(), '受けると答えたのに出題の画面へ移っていない').toContain(EXAM_QUESTION)

    // 事後条件: その日の範囲でテストが 1 つだけ進行中になり、出題の画面が開いている
    expect(countOf('/api/sessions', 'POST'), 'その日のテストを 1 つだけ作っていない').toBe(1)

    // 事後条件: ロードマップを開き直すと、理解した単位数と「ここから」の位置が記録した理解度の
    // とおりに示され、先頭の続きの導線が最後に開いた単位を指す
    v = await open('/topics')
    const again = v.text()
    expect(again, '理解した単位数が記録した理解度のとおりに出ていない').toMatch(/理解\s*4\s*[／/]\s*7/)
    expect(order(again, 'ここから'), '「ここから」の位置が変わっている').toBeGreaterThan(
      order(again, NAMES[3]),
    )
    expect(order(again, 'ここから'), '「ここから」の位置が変わっている').toBeLessThan(
      order(again, NAMES[5]),
    )
    expect(lead(again), '先頭の続きの導線が前回の続きになっていない').toContain('前回の続き')
    expect(lead(again), '続きの導線が最後に開いた単位を指していない').toContain(NAMES[5])
  })
})
