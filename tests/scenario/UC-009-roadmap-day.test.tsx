// @vitest-environment jsdom
/** UC-009「学ぶ順に並んだ論点を回ごとに辿り、回ごとの確認を始める」の主シナリオ 1〜13 と成功時の事後条件を
 *  1 本で実行する写し（正常系のみ。取れないとき・端の単位・印を持つ学びは要件のテストが見る）。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、ロードマップ型にしてから読み込み直して描く。
 *  ロードマップ型ではロードマップが /topics に載る。
 *  画面を探す手がかりは次の 4 種だけにし、行き先の文字列や画面の作りは見ない:
 *  用語集の語（ロードマップ・単位・前回の続き・学び方の説明・フィードバック・理解度の 3 段階の名前）、
 *  登録簿の語（回の見出し「{day} 日目」・回ごとの確認「この日の確認」・回の数「全 {n} 日」）、
 *  要件が引用符で定める画面の語（「ここから」＝REQ-130・REQ-144）と UC の語（続きの導線）、
 *  要件が述べる導線を用語集の「単位」で呼んだ語（前の単位・次の単位＝REQ-139 の学ぶ順の前後の導線）。
 *  「先頭」は読む順（文書の順）で最初の単位より前、「並びの後」は読む順でその回の最後の単位より後と読む。
 *  1 日の単位数（3）と 1 回の問題数（6）は登録簿の値。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import targets from '../../src/shared/targets.json'

type Unit = Record<string, unknown>

/** 登録簿の補足の回（ID とラベル）。 */
type RoadmapSpec = {
  extraRoundId: string
  extraRoundLabel: string
  roundLabel: string
  roundHeading: string
  roundCheck: string
  roundCount: string
}
const ITC_SPEC = (targets as unknown as { itc: { roadmapSpec: RoadmapSpec } }).itc.roadmapSpec

/** 単位の名前と副題には数字を入れない（画面に出る数値の断言とぶつからないように）。 */
const NAMES = ['単位 甲', '単位 乙', '単位 丙', '単位 丁', '単位 戊', '単位 己', '単位 庚', '単位 辛', '単位 壬']
/** 副題を持つ単位（名前とは分けて投入されている）。続きの導線の行き先（戊）と、その次（己）に持たせる。 */
const SUBTITLES: Record<number, string> = { 4: '始めに押さえる見方', 5: '次に広げる見方' }
const ID = (i: number) => 101 + i
const dayOf = (i: number) => Math.floor(i / 3) + 1
const unit = (i: number, status: number | null): Unit => ({
  id: ID(i),
  term: NAMES[i],
  subtitle: SUBTITLES[i] ?? null,
  questionCount: 2,
  status,
  field: '業界と仕事',
  middle: 'コンサルの仕事',
  itemName: 'コンサルの仕事',
  isNew: 0,
  sortOrder: i + 1,
  round: `itc-d0${dayOf(i)}`,
  roundLabel: ITC_SPEC.roundLabel.replace('{day}', String(dayOf(i))),
  tier: null,
})

/** 9 単位・3 日。甲〜丁が理解なので 1 日目は全部理解、いま学ぶ位置（ここから）は戊。 */
const STATUSES: (number | null)[] = [3, 3, 3, 3, 1, null, 2, null, null]
const UNITS: Unit[] = STATUSES.map((st, i) => unit(i, st))

const EXTRA_NAME = '補足の単位'
const EXTRA: Unit = {
  id: 200,
  term: EXTRA_NAME,
  subtitle: null,
  questionCount: 2,
  status: null,
  field: '補足（ロードマップ外）',
  middle: 'ロードマップ外',
  itemName: 'ロードマップ外',
  isNew: 0,
  sortOrder: null,
  round: ITC_SPEC.extraRoundId,
  roundLabel: ITC_SPEC.extraRoundLabel,
  tier: null,
}

/** 単位の画面に出る教材の本文と確認問題の本文（単位ごとに別の文にして、移ったことを見る）。 */
const MATERIAL = (name: string) => `${name} の教材の本文です。`
const QUIZ = (name: string) => `${name} の確認問題の本文です。`

/** 1 単位の教材と確認問題、学ぶ順の前後の単位（UC-002 の契約 getTopicDetail の形）。 */
const detail = (i: number) => ({
  topic: {
    id: ID(i),
    term: NAMES[i],
    subtitle: SUBTITLES[i] ?? null,
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
    tier: null,
  },
  questions: [
    {
      id: `itc-d02-q${i}`,
      number: i + 1,
      examLabel: '2 日目',
      exam: 'itc-d02',
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
    { exam: 'itc-d01', examLabel: '1 日目', questions: 6, attempts: 2, bestScore: 5 },
    { exam: 'itc-d02', examLabel: '2 日目', questions: 6, attempts: 0, bestScore: null },
    { exam: 'itc-d03', examLabel: '3 日目', questions: 6, attempts: 0, bestScore: null },
  ],
}

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 9, understood: 4, partly: 0 },
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
        session: { id: 's-new', kind: 'mock', scopeLabel: '1 日目', questionCount: 6, sourceExam: 'itc-d01' },
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

const CONTROLS = 'button, [role="button"], [role="link"], [role="radio"], summary, a, input[type="radio"]'
const squash = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
const trimmed = (el: Element) => squash(el.textContent)
/** 操作の名前（読み上げで分かる名前を先に、無ければ見えている文字）。 */
const nameOf = (el: Element) => {
  const aria = el.getAttribute('aria-label')
  if (aria) return squash(aria)
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) return squash([...labels].map((l) => l.textContent).join(' '))
  return trimmed(el)
}
/** 読む順で a が b より前にある（b を含まない）。 */
const before = (a: Node, b: Node) =>
  !a.contains(b) && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

/** 単位の位置（並びに出ている方。続きの導線にも名前が出うるので、読む順で最後の出現を採る）。 */
const at = (t: string, word: string) => t.lastIndexOf(word)

/** その文を持つ最も内側の要素のうち、読む順で最後のもの。 */
function innermost(host: HTMLElement, word: string): HTMLElement | null {
  const els = [...host.querySelectorAll<HTMLElement>('*')].filter(
    (el) => squash(el.textContent).includes(word) && ![...el.children].some((c) => squash(c.textContent).includes(word)),
  )
  return els.length ? els[els.length - 1] : null
}

/** 並びの中の 1 単位の行: 名前を持つ要素から、ほかの単位の名前を含まない限り外へ広げた範囲。 */
function rowOf(host: HTMLElement, name: string): HTMLElement {
  const others = [...NAMES, EXTRA_NAME].filter((n) => n !== name)
  let el = innermost(host, name)
  if (!el) throw new Error(`単位「${name}」が並びに出ていない`)
  while (el.parentElement && el.parentElement !== host) {
    const up = squash(el.parentElement.textContent)
    if (others.some((n) => up.includes(n))) break
    el = el.parentElement
  }
  return el
}

/** 理解度の段階の名前（用語集）。「理解」は他の 2 つに含まれるので、長いものから当てる。 */
const STAGE = { 1: '未理解', 2: 'やや理解', 3: '理解' } as const
const stageIn = (t: string) =>
  t.includes('やや理解') && !t.replace(/やや理解/g, '').includes('理解')
    ? 'やや理解'
    : t.includes('未理解') && !t.replace(/未理解/g, '').includes('理解')
      ? '未理解'
      : t.includes('理解') && !t.includes('未理解') && !t.includes('やや理解')
        ? '理解'
        : null

/** 押したことで画面に増えた文（確かめが画面の中に出る作りでも読めるように、前後の差を採る）。 */
const addedText = (before: string, after: string) => {
  let s = 0
  while (s < before.length && before[s] === after[s]) s++
  let e = 0
  while (e < before.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++
  return after.slice(s, after.length - e)
}

type View = {
  host: HTMLElement
  text: () => string
  menuText: () => string
  press: (name: string | RegExp) => Promise<void>
  click: (target: HTMLElement) => Promise<void>
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
    host: el,
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
    click: async (target) => {
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

/** 回の見出し（登録簿の語）と回ごとの確認の語（登録簿）。 */
const HEADING = (day: number) => ITC_SPEC.roundHeading.replace('{day}', String(day))
const DAY_ONE = HEADING(1)
const CHECK = ITC_SPEC.roundCheck
const DAYS = 3

/** 先頭（読む順で最初の単位より前）にある、論点へ移る導線。続きの導線は UC の語、
 *  行き先の語は「ここから」（REQ-144）・前回の続き（用語集）、または行き先の単位名。 */
function leadGuides(v: View): HTMLElement[] {
  const first = rowOf(v.host, NAMES[0])
  return [...v.host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => {
    if (!before(el, first)) return false
    const n = nameOf(el)
    return /ここから|続き/.test(n) || [...NAMES, EXTRA_NAME].some((name) => n.includes(name))
  })
}

/** 理解度の操作（選ぶと記録される段階の名前を持つ操作）。 */
const stageControls = (v: View) =>
  [...v.host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) =>
    (Object.values(STAGE) as string[]).includes(stageIn(nameOf(el)) ?? ''),
  )

describe('UC-009 学ぶ順に並んだ論点を回ごとに辿り、回ごとの確認を始める', () => {
  // @scenario UC-009
  it('ロードマップを開き、回ごとの並びから単位を開いて学ぶ順に読み進め、ロードマップへ戻って回ごとの確認を始める', async () => {
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

    // step 3: システムが論点を学ぶ順に並べ、回ごとにまとめて回の順に、回の見出しを付けて示す
    v = await open('/topics')
    expect(countOf('/api/topics'), '単位の一覧を取りに行っていない').toBeGreaterThan(0)
    const map = v.text()
    const placed = NAMES.map((name) => at(map, name))
    expect(
      placed.every((i) => i >= 0),
      '単位が全部出ていない',
    ).toBe(true)
    expect(
      placed.every((i, n) => n === 0 || placed[n - 1] < i),
      '単位が学ぶ順に並んでいない',
    ).toBe(true)
    for (let d = 1; d <= DAYS; d++) {
      const head = map.lastIndexOf(HEADING(d), placed[(d - 1) * 3])
      expect(head, `${HEADING(d)} の見出しがその回の単位の前に無い`).toBeGreaterThan(d === 1 ? -1 : placed[(d - 1) * 3 - 1])
    }
    // step 3: 各単位には名前と副題を分けて示し、理解度を段階の名前で示し、回の見出しの語は繰り返さない
    NAMES.forEach((name, i) => {
      const row = rowOf(v.host, name)
      const rowText = trimmed(row)
      const expected = STAGE[(STATUSES[i] ?? 1) as 1 | 2 | 3]
      expect(stageIn(rowText.replace(SUBTITLES[i] ?? '', '')), `「${name}」に理解度が段階の名前で出ていない`).toBe(expected)
      expect(rowText, `「${name}」に回の見出しの語が繰り返されている`).not.toContain(HEADING(dayOf(i)))
      const sub = SUBTITLES[i]
      if (sub) {
        expect(rowText, `「${name}」に副題が出ていない`).toContain(sub)
        expect(rowText.indexOf(sub), `「${name}」の副題が名前の後ろに添えられていない`).toBeGreaterThan(
          rowText.indexOf(name),
        )
        expect(
          innermost(row, name) !== null && !trimmed(innermost(row, name)!).includes(sub),
          `「${name}」の名前と副題が分けて示されていない`,
        ).toBe(true)
      }
    })

    // step 4: 理解した論点数と全体、回の数、連続記録を先頭に示す
    const lead = map.slice(0, placed[0])
    expect(lead, '理解した単位数と全単位数が先頭に出ていない').toMatch(/理解\s*4\s*[／/]\s*9/)
    expect(lead, '回の数が先頭に出ていない').toContain(ITC_SPEC.roundCount.replace('{n}', String(DAYS)))
    expect(lead, '連続記録が先頭に出ていない').toMatch(/連続\s*13\s*日/)
    // step 4: 学び方の説明を畳んで添える
    const howTo = [...v.host.querySelectorAll<HTMLElement>(CONTROLS)].find((el) => nameOf(el).includes('学び方の説明'))
    expect(howTo, '学び方の説明が添えられていない').toBeTruthy()
    expect(before(howTo!, rowOf(v.host, NAMES[0])), '学び方の説明が先頭に無い').toBe(true)
    const folded =
      howTo!.getAttribute('aria-expanded') === 'false' ||
      (howTo!.closest('details') !== null && !(howTo!.closest('details') as HTMLDetailsElement).open)
    expect(folded, '学び方の説明が畳まれていない').toBe(true)
    // step 4: 最初の未理解の論点を「ここから」として示す（並びの中にだけ 1 つ）
    const here = map.indexOf('ここから', placed[0])
    expect(here, '「ここから」が並びに出ていない').toBeGreaterThan(-1)
    expect(here, '「ここから」が最初のまだ理解していない単位より前に付いている').toBeGreaterThan(placed[3])
    expect(here, '「ここから」が最初のまだ理解していない単位より後に付いている').toBeLessThan(placed[5])
    expect(map.indexOf('ここから', here + 1), '「ここから」が並びに 2 つ以上ある').toBe(-1)

    // step 5: 先頭に論点へ移る導線として続きの導線を 1 つだけ示す（前回の続きが無いので行き先は「ここから」の単位）
    const guides = leadGuides(v)
    expect(guides.map(nameOf), '先頭の論点へ移る導線が続きの導線の 1 つだけになっていない').toHaveLength(1)
    expect(nameOf(guides[0]), '前回の続きが無いのに前回の続きの導線が出ている').not.toContain('前回の続き')

    // step 6: 各回の単位の並びの後に、回ごとの確認の入口と問数、受けた回数・最高正解数を登録簿の語で示す
    expect(
      map.slice(placed[0]).split(CHECK).length - 1,
      `${CHECK}が回ごとに 1 つずつになっていない`,
    ).toBe(DAYS)
    for (let d = 1; d <= DAYS; d++) {
      const last = placed[d * 3 - 1]
      const end = d < DAYS ? placed[d * 3] : at(map, EXTRA_NAME)
      const after = map.slice(last, end)
      const nextHead = d < DAYS ? after.indexOf(HEADING(d + 1)) : after.indexOf(ITC_SPEC.extraRoundLabel)
      const entry = after.indexOf(CHECK)
      expect(entry, `${HEADING(d)} の${CHECK}がその回の単位の並びの後に無い`).toBeGreaterThan(-1)
      if (nextHead > -1) expect(entry, `${HEADING(d)} の${CHECK}が次の回に入っている`).toBeLessThan(nextHead)
      const tail = after.slice(entry, nextHead > -1 ? nextHead : undefined)
      expect(tail, `${HEADING(d)} の${CHECK}に問数が出ていない`).toMatch(/6\s*問/)
      if (d === 1) {
        expect(tail, `${CHECK}を受けた回数が出ていない`).toMatch(/2\s*回/)
        expect(tail, `${CHECK}の最高正解数が出ていない`).toContain('5')
      }
    }

    // step 7: 学ぶ順に入っていない補足の論点を末尾の別枠に示す
    expect(at(map, EXTRA_NAME), '補足の単位が出ていない').toBeGreaterThan(-1)
    expect(at(map, EXTRA_NAME), '補足の単位が回ごとの並びに混ざっている').toBeGreaterThan(placed[NAMES.length - 1])

    // step 8: 利用者が先頭の続きの導線を開く
    await v.click(guides[0])

    // step 9: 論点の名前だけの見出しに副題を添え、教材と確認問題と理解度の操作を示し、
    // 末尾に学ぶ順の前後の論点への導線を論点名つきで添える。行き先は「ここから」の単位
    const opened = v.text()
    expect(opened, '続きの導線の行き先が「ここから」の単位の教材になっていない').toContain(MATERIAL(NAMES[4]))
    const headings = [...v.host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]')]
    const title = headings.find((el) => trimmed(el) === NAMES[4])
    expect(title, '論点の名前だけの見出しが無い').toBeTruthy()
    const subEl = innermost(v.host, SUBTITLES[4])
    expect(subEl, '見出しに副題が添えられていない').toBeTruthy()
    expect(before(title!, subEl!), '副題が見出しの後ろに添えられていない').toBe(true)
    expect(opened, '単位の確認問題が出ていない').toContain(QUIZ(NAMES[4]))
    expect(
      [...new Set(stageControls(v).map((el) => stageIn(nameOf(el))))].sort(),
      '理解度の操作（未理解・やや理解・理解）が出ていない',
    ).toEqual(['やや理解', '未理解', '理解'].sort())
    expect(opened, '前の単位への導線が無い').toContain('前の単位')
    expect(opened, '次の単位への導線が無い').toContain('次の単位')
    expect(opened, '前の単位の名前が出ていない').toContain(NAMES[3])
    expect(opened, '次の単位の名前が出ていない').toContain(NAMES[5])
    expect(opened.indexOf('次の単位'), '前後の導線が教材と確認問題より前に出ている').toBeGreaterThan(
      opened.indexOf(QUIZ(NAMES[4])),
    )

    // step 10: 利用者が次の論点へ移り、学ぶ順のとおりに読み進める
    await v.press(/次の単位/)
    expect(v.text(), '学ぶ順の次の単位へ移っていない').toContain(MATERIAL(NAMES[5]))

    // step 11（BR-016）: 利用者がロードマップへ戻る
    const backToRoadmap = /ロードマップ[^。]{0,4}戻/
    expect(v.text(), '単位の画面にロードマップへ戻る導線が無い').toMatch(backToRoadmap)
    await v.press(backToRoadmap)
    expect(v.text(), 'ロードマップへ戻っていない').toContain(DAY_ONE)
    expect(v.text(), 'ロードマップへ戻っていない').toContain(NAMES[0])

    // step 12: 利用者がその回の回ごとの確認を始める。システムが範囲と問数を示して確かめを取る
    // step 13: 利用者が受けると答える。システムがその回の範囲でテストを作り、出題の画面へ移す
    //（確かめの機構は仕様が決めていないので、問われた文と、そのときに画面へ増えた文の両方から読む）
    const beforePress = v.text()
    let confirmed = ''
    vi.stubGlobal('confirm', (message?: unknown) => {
      confirmed = `${String(message ?? '')} ${addedText(beforePress, view!.text())}`
      return true
    })
    await v.press(CHECK)
    expect(confirmed, '確かめにその回の範囲が出ていない').toContain(DAY_ONE)
    expect(confirmed, '確かめにその回の問数が出ていない').toMatch(/6\s*問/)
    expect(v.text(), '受けると答えたのに出題の画面へ移っていない').toContain(EXAM_QUESTION)

    // 事後条件: その回の範囲でテストが 1 つだけ進行中になり、出題の画面が開いている
    expect(countOf('/api/sessions', 'POST'), 'その回のテストを 1 つだけ作っていない').toBe(1)

    // 事後条件: ロードマップを開き直すと、理解した論点数と「ここから」の位置が記録した理解度の
    // とおりに示され、先頭の続きの導線が最後に開いた論点を指す
    v = await open('/topics')
    const again = v.text()
    const placedAgain = NAMES.map((name) => at(again, name))
    expect(again.slice(0, placedAgain[0]), '理解した単位数が記録した理解度のとおりに出ていない').toMatch(
      /理解\s*4\s*[／/]\s*9/,
    )
    const hereAgain = again.indexOf('ここから', placedAgain[0])
    expect(hereAgain, '「ここから」の位置が変わっている').toBeGreaterThan(placedAgain[3])
    expect(hereAgain, '「ここから」の位置が変わっている').toBeLessThan(placedAgain[5])
    const guidesAgain = leadGuides(v)
    expect(guidesAgain.map(nameOf), '先頭の論点へ移る導線が続きの導線の 1 つだけになっていない').toHaveLength(1)
    expect(nameOf(guidesAgain[0]), '先頭の続きの導線が前回の続きになっていない').toContain('前回の続き')
    await v.click(guidesAgain[0])
    expect(v.text(), '先頭の続きの導線が最後に開いた単位を指していない').toContain(MATERIAL(NAMES[5]))
  })
})
