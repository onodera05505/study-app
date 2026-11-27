// @vitest-environment jsdom
/** UC-002「分野から単元をたどり、論点の教材と紐づく過去問を読む」の主シナリオを
 *  1 本で実行する写し（正常系のみ。失敗系・境界は要件のテストが見る）。
 *
 *  資格対策の学びの画面。サーバの応答は偽の fetch で返し、値は契約（listFields・listCategories・
 *  listTopics・getTopicDetail）の examples から採る。画面の文字は用語集と主シナリオの語で引き、
 *  理解度は段階の名前（未・未理解・やや理解・理解）で、出題回数の印は BR-051 の ★ で読む。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

/** listFields の応答（契約の examples.ok）。 */
const FIELDS = {
  fields: [
    { field: 'テクノロジ系', topics: 312, questions: 1680, understood: 40, partly: 12, untouched: 30, unanswered: 230 },
    { field: 'マネジメント系', topics: 96, questions: 440, understood: 8, partly: 4, untouched: 6, unanswered: 78 },
  ],
}

/** listCategories の単元。セキュリティは契約の examples.ok、もう 1 つは分野で絞ったときに消える単元。 */
/** 分野の名前の「系」を除いた部分（画面の語の照合に使う）。 */
const FIELD_SHORT = 'テクノロジ'
const OTHER_FIELD_MIDDLE = 'サービスマネジメント'
const CATEGORIES = [
  { middleNo: 12, middle: 'セキュリティ', major: '技術要素', field: 'テクノロジ系', topics: 38, questions: 214, understood: 6 },
  { middleNo: 30, middle: OTHER_FIELD_MIDDLE, major: OTHER_FIELD_MIDDLE, field: 'マネジメント系', topics: 20, questions: 90, understood: 2 },
]

/** listTopics の単元の構成と論点（契約の examples.ok。配列の順が単元の構成の順）。 */
const STRUCTURE = {
  overview: '情報を守る考え方と、それを支える暗号・認証の仕組みを学ぶ。',
  groups: [
    { no: 1, name: '暗号と証明書', description: '鍵の持ち方で暗号を分け、署名と証明書で相手を確かめる。' },
    { no: 2, name: '攻撃と対策', description: 'よくある攻撃の手口と、それぞれを防ぐ仕組み。' },
  ],
}
/** listTopics の topics の 1 行（契約の形）。 */
type TopicRow = {
  id: number
  term: string
  subtitle: string | null
  questionCount: number
  frequencyTier: 1 | 2 | 3 | null
  status: 0 | 1 | 2 | 3 | null
  statusSource: 'auto' | 'override' | null
  field: string
  middle: string
  itemNo: number | null
  itemName: string
  groupNo: number | null
  isNew: 0 | 1
  sortOrder: number | null
  round: string | null
  roundLabel: string | null
  tier: number | null
}
/** 資格対策の学びの行で、論点ごとに違う鍵だけを受け取る。 */
type TopicOwn = Pick<TopicRow, 'id' | 'term' | 'questionCount' | 'frequencyTier' | 'status' | 'statusSource' | 'itemNo' | 'itemName' | 'groupNo'>
const topicRow = (over: TopicOwn): TopicRow => ({
  subtitle: null,
  field: 'テクノロジ系',
  middle: 'セキュリティ',
  isNew: 0,
  sortOrder: null,
  round: null,
  roundLabel: null,
  tier: null,
  ...over,
})
const TOPICS = [
  topicRow({ id: 419, term: '共通鍵暗号方式', questionCount: 7, frequencyTier: 3, status: 1, statusSource: 'auto', itemNo: 3, itemName: '暗号技術', groupNo: 1 }),
  topicRow({ id: 418, term: '公開鍵暗号方式', questionCount: 9, frequencyTier: 3, status: 2, statusSource: 'override', itemNo: 3, itemName: '暗号技術', groupNo: 1 }),
  topicRow({ id: 433, term: 'SQL インジェクション', questionCount: 1, frequencyTier: 1, status: 0, statusSource: 'auto', itemNo: 5, itemName: '情報セキュリティ対策', groupNo: 2 }),
]
const TERMS = TOPICS.map((t) => t.term)

const FIGURE_SRC = '/figures/ip/2018h30a-q40.png'
const question = (n: number, over: Record<string, unknown> = {}) => ({
  id: `2018h30a-${n}`,
  number: n,
  examLabel: '平成30年度秋期',
  text: `過去問 ${n} の本文です。`,
  choices: { ア: `${n} のア`, イ: `${n} のイ`, ウ: `${n} のウ`, エ: `${n} のエ` },
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `平成30年度秋期 問${n}`,
  modified: 0,
  timesAsked: 1,
  otherCitations: [] as string[],
  explanation: {
    correctReason: `過去問 ${n} の正解の根拠です。`,
    choices: [
      { label: 'ア', term: null, note: `${n} のアの説明` },
      { label: 'イ', term: null, note: `${n} のイの説明` },
    ],
  },
  ...over,
})

/** 紐づく過去問 8 問。先頭は契約の examples.ok の過去問、2 問目は図の画像と書き起こしを持つ。 */
const FIRST = question(38, {
  text: '公開鍵暗号方式を用いて送信者が受信者宛てのメッセージを暗号化するとき、暗号化に使う鍵はどれか。',
  choices: { ア: '受信者の公開鍵', イ: '受信者の秘密鍵', ウ: '送信者の公開鍵', エ: '送信者の秘密鍵' },
  citation: '平成30年度秋期 問38',
  timesAsked: 2,
  otherCitations: ['平成28年度春期 問40'],
  explanation: {
    correctReason: '正解。公開鍵暗号方式では、受信者だけが持つ秘密鍵でしか復号できないようにするため、受信者の公開鍵で暗号化する。',
    choices: [
      { label: 'ア', term: null, note: '正解。受信者の公開鍵で暗号化する。' },
      { label: 'イ', term: '秘密鍵', note: '本人だけが持ち、復号や署名に使う鍵。' },
    ],
  },
})
const QUESTIONS = [
  FIRST,
  question(40, { hasFigure: 1, figureImage: FIGURE_SRC, figureDescription: '図の書き起こしの本文です。' }),
  question(41),
  question(42),
  question(43),
  question(44),
  question(45),
  question(46),
]

/** getTopicDetail の応答（契約の examples.ok。詳しい解説は本文を持たせる）。 */
const DETAIL = {
  topic: {
    id: 418,
    term: '公開鍵暗号方式',
    subtitle: null,
    explanation: '暗号化する鍵と復号する鍵を分け、暗号化する側の鍵を公開してよい方式。',
    detail: '詳しい解説の本文です。',
    questionCount: 9,
    frequencyTier: 3,
    isNew: 0,
    status: 2,
    statusSource: 'override',
    field: 'テクノロジ系',
    major: '技術要素',
    middle: 'セキュリティ',
    middleNo: 12,
    itemName: '暗号技術',
    tier: null,
  },
  questions: QUESTIONS,
  prerequisites: [{ id: 419, term: '共通鍵暗号方式', questionCount: 7, frequencyTier: 3 }],
  siblings: [
    { id: 419, term: '共通鍵暗号方式', questionCount: 7, frequencyTier: 3 },
    { id: 421, term: 'ディジタル署名', questionCount: 6, frequencyTier: 3 },
  ],
  nextTopic: { id: 421, term: 'ディジタル署名', questionCount: 6, frequencyTier: 3 },
  neighbors: null,
}

const ME = {
  user: { id: '8a0f1d62-3c47-4b10-9f85-d2e6a1c70b33', name: '山田 太郎', role: 'MEMBER' },
  topics: { total: 532, understood: 48, partly: 16 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-10-01', streak: 4, longest: 11, total: 37 },
}

let calls: string[] = []
const countOf = (part: string) => calls.filter((u) => u.includes(part)).length
const topicListCalls = () => calls.filter((c) => /\/api\/topics(\?|$)/.test(c))

function stubApi() {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}${url.search}`)
    const p = url.pathname
    const q = url.searchParams
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-10-01T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/fields')) body = FIELDS
    else if (p.endsWith('/categories'))
      body = {
        categories: CATEGORIES.filter((c) => {
          const f = q.get('field')
          return !f || c.field.startsWith(f) || f.startsWith(c.field)
        }),
      }
    else if (/\/topics\/\d+$/.test(p)) body = DETAIL
    else if (p.endsWith('/topics')) {
      const status = q.get('status')
      const chosen = status === null ? null : status.split(',').filter((s) => s !== '').map(Number)
      const inUnit = q.get('middleNo') === null || q.get('middleNo') === '12'
      const topics = inUnit ? TOPICS.filter((t) => chosen === null || (t.status !== null && chosen.includes(t.status))) : []
      const structure = inUnit && q.get('middleNo') === '12' && (q.get('sort') ?? 'structure') === 'structure' ? STRUCTURE : null
      body = { structure, topics }
    } else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
  })
}

let host: HTMLElement
let root: Root | null = null

const squash = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
const text = () => squash(host.textContent)
const images = () => [...host.querySelectorAll('img')]

/** 押せるもの（役割と、読み上げに届く名前か見える文字で探す。class・nth は使わない）。 */
const CONTROLS = 'button, [role="button"], [role="checkbox"], [role="radio"], summary, a, input[type="checkbox"], input[type="radio"]'
const nameOf = (el: Element) => {
  const aria = el.getAttribute('aria-label')
  if (aria) return squash(aria)
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) return squash([...labels].map((l) => l.textContent).join(' '))
  return squash(el.textContent)
}
const hit = (el: Element, name: string | RegExp) =>
  typeof name === 'string' ? nameOf(el).includes(name) : name.test(nameOf(el))
const controls = (name: string | RegExp) =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => hit(el, name))
async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}
/** 名前が一致するものを先に選び、無ければ含むものを選ぶ。 */
async function press(name: string | RegExp) {
  const els = controls(name)
  const target = (typeof name === 'string' ? els.find((el) => nameOf(el) === name) : undefined) ?? els[0]
  if (!target) throw new Error(`「${name}」の操作が画面に無い`)
  await click(target)
}

/** 文字列に現れる理解度の段階の名前（ちょうど 1 つのときだけ返す）。長い名前から先に当てる。 */
function stageIn(t: string): string | null {
  let rest = t.replace(/理解度/g, '')
  const found: string[] = []
  for (const name of ['やや理解', '未理解', '理解', '未']) {
    if (rest.includes(name)) found.push(name)
    rest = rest.split(name).join('')
  }
  return found.length === 1 ? found[0] : null
}

/** 論点の一覧の 1 行: 論点名を持つ最も内側の要素から、ほかの論点名を含まない限り外へ広げた範囲。 */
function rowOf(term: string): HTMLElement {
  const others = TERMS.filter((t) => t !== term)
  const els = [...host.querySelectorAll<HTMLElement>('*')].filter(
    (el) => squash(el.textContent).includes(term) && ![...el.children].some((c) => squash(c.textContent).includes(term)),
  )
  let el = els[els.length - 1]
  if (!el) throw new Error(`論点「${term}」が一覧に出ていない`)
  while (el.parentElement && el.parentElement !== host) {
    const up = squash(el.parentElement.textContent)
    if (others.some((o) => up.includes(o)) || STRUCTURE.groups.some((g) => up.includes(g.name))) break
    el = el.parentElement
  }
  return el
}
/** 行に添えた出題回数の印の段（★ の連なりの最長）。 */
const tierIn = (t: string) => Math.max(0, ...(t.match(/★+/g) ?? []).map((s) => s.length))

/** 理解度の絞り込みの選択肢（論点の行ではなく、名前が段階の名前だけを指すもの）。 */
const filterOf = (stage: string) =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].find(
    (el) => stageIn(nameOf(el)) === stage && !TERMS.some((t) => nameOf(el).includes(t)),
  )

/** 画面の文字の中で、前の語より後ろに次の語が現れる（並びの確認）。 */
function expectInOrder(words: string[], message: string) {
  const t = text()
  let from = -1
  for (const w of words) {
    const at = t.indexOf(w, from + 1)
    expect(at, `${message}: 「${w}」が前の語より後ろに無い`).toBeGreaterThan(from)
    from = at
  }
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

describe('UC-002 分野から単元をたどり、論点の教材と紐づく過去問を読む', () => {
  // @scenario UC-002
  it('単元の一覧から分野で絞って単元と論点を選び、教材と過去問を読んで来た論点の一覧へ戻る', async () => {
    // 段 1: 利用者が単元の一覧を開く
    await open('/topics')
    expect(countOf('/api/fields'), '分野の集計を取りに行っていない').toBe(1)

    // 段 2: 分野ごとの論点数・過去問数と、理解度の内訳（未を含む）。分野の名前は末尾の「系」を省いて示してもよい
    expect(text()).toContain(FIELD_SHORT)
    expect(text(), '分野の論点数が出ていない').toContain('312')
    expect(text(), '分野の過去問数が出ていない').toMatch(/1,?680/)
    expect(text(), '理解度の内訳に未の数が出ていない').toContain('230')

    // 段 3: 大項目ごとにまとめた単元を、論点数・過去問数・「理解した数／論点数」つきで
    expect(text(), '大項目の見出しが無い').toContain('技術要素')
    expect(text()).toContain('セキュリティ')
    expect(text(), '単元の過去問数が出ていない').toContain('214')
    expect(text(), '「理解した数／論点数」が出ていない').toMatch(/6\s*[／/]\s*38/)
    expect(text()).toContain(OTHER_FIELD_MIDDLE)

    // 段 4: 利用者が分野を選び、単元を絞り込む
    await press(FIELD_SHORT)
    expect(text(), '分野で絞っても他の分野の単元が残っている').not.toContain(OTHER_FIELD_MIDDLE)
    expect(text()).toContain('セキュリティ')

    // 段 5: 利用者が単元を選ぶ
    await press('セキュリティ')
    const asked = topicListCalls()
    expect(asked.length, '単元を選んでも論点の一覧を取りに行っていない').toBeGreaterThan(0)
    expect(asked[asked.length - 1], '選んだ単元で論点の一覧を求めていない').toContain('middleNo=12')

    // 段 6: 先頭に全体像、まとまりごとに名前と説明の見出し、論点は単元の構成の順
    expectInOrder(
      [
        STRUCTURE.overview,
        STRUCTURE.groups[0].name,
        STRUCTURE.groups[0].description,
        '共通鍵暗号方式',
        '公開鍵暗号方式',
        STRUCTURE.groups[1].name,
        STRUCTURE.groups[1].description,
        'SQL インジェクション',
      ],
      '論点の一覧が全体像・まとまりの見出し・単元の構成の順になっていない',
    )
    // 論点ごとの出題頻度と出題回数の印（BR-051）と理解度
    for (const t of TOPICS) {
      const row = squash(rowOf(t.term).textContent)
      expect(row, `「${t.term}」の行に出題頻度が出ていない`).toContain(String(t.questionCount))
      expect(tierIn(row), `「${t.term}」の行の出題回数の印の段が違う`).toBe(t.frequencyTier)
    }
    expect(stageIn(squash(rowOf('共通鍵暗号方式').textContent)), '行の理解度が違う').toBe('未理解')
    expect(stageIn(squash(rowOf('公開鍵暗号方式').textContent)), '行の理解度が違う').toBe('やや理解')
    expect(stageIn(squash(rowOf('SQL インジェクション').textContent)), '行の理解度が違う').toBe('未')

    // 段 7: 利用者が理解度の絞り込みを選び直す（未を外す）
    const unanswered = filterOf('未')
    if (!unanswered) throw new Error('理解度の絞り込みに「未」の選択肢が無い')
    await click(unanswered)
    const last = topicListCalls().at(-1) ?? ''
    const status = new URL(last.replace(/^\w+ /, ''), 'http://localhost').searchParams.get('status')
    expect(status, '選び直した絞り込みで論点の一覧を求めていない').not.toBeNull()
    expect(status!.split(','), '外した「未」が絞り込みに残っている').not.toContain('0')
    expect(text(), '絞り込みで外した論点が残っている').not.toContain('SQL インジェクション')
    expect(text(), '論点が残らないまとまりの見出しが残っている').not.toContain(STRUCTURE.groups[1].name)
    expectInOrder(['共通鍵暗号方式', '公開鍵暗号方式'], '絞り込んだあとの並びが単元の構成の順でない')

    // 段 8: 利用者が論点を選ぶ
    await press('公開鍵暗号方式')
    expect(countOf('/api/topics/418'), '選んだ論点を取りに行っていない').toBe(1)

    // 段 9: 教材・紐づく過去問・前提の論点への導線・同じまとまりの他の論点
    expect(text()).toContain(DETAIL.topic.explanation)
    expect(text()).toContain(FIRST.text)
    expect(text(), '前提の論点が示されていない').toContain('前提の論点')
    expect(controls('共通鍵暗号方式').length, '前提の論点へ移る導線が無い').toBeGreaterThan(0)
    expect(controls('ディジタル署名').length, '同じまとまりの他の論点が示されていない').toBeGreaterThan(0)
    expect(text(), '過去問の出典が出ていない').toContain(FIRST.citation)
    expect(text(), '他の出典が出ていない').toContain('他の出典')
    expect(text()).toContain(FIRST.otherCitations[0])

    // 段 10: 利用者が教材の詳しい解説を開く
    expect(text(), '開く前から詳しい解説が出ている').not.toContain(DETAIL.topic.detail)
    await press(/詳し/)
    expect(text()).toContain(DETAIL.topic.detail)

    // 段 11: 過去問の答え → 問題解説 → 残りの過去問。図の書き起こしを開き、図を押して切り替える
    expect(text(), '答えを開く前に問題解説が出ている').not.toContain(FIRST.explanation.correctReason)
    expect(controls('問題解説'), '答えを開く前に問題解説を開く手段が出ている').toHaveLength(0)
    await press(/答え/)
    await press('問題解説')
    expect(text()).toContain(FIRST.explanation.correctReason)

    const shown = QUESTIONS.filter((q) => text().includes(q.text)).length
    expect(shown, '最初から過去問が全部出ている').toBeLessThan(QUESTIONS.length)
    await press(new RegExp(`${QUESTIONS.length - shown}\\s*問`))
    expect(QUESTIONS.every((q) => text().includes(q.text)), '残りの過去問が開かない').toBe(true)

    await press(/書き起こし/)
    expect(text(), '図の書き起こしが開かない').toContain('図の書き起こしの本文です。')
    const figure = images().find((i) => i.getAttribute('src') === FIGURE_SRC)
    if (!figure) throw new Error('過去問の図の画像が出ていない')
    await click(figure)
    await click(figure)
    expect(images().some((i) => i.getAttribute('src') === FIGURE_SRC), '図を押したあと図が消えた').toBe(true)

    // 段 12: 利用者が戻る導線で、来た論点の一覧へ戻る
    await press(/戻る/)
    expect(text(), '来た論点の一覧へ戻れていない').toContain(STRUCTURE.overview)

    // 事後条件: 論点の一覧は単元の構成の順で各論点に出題回数の印、分野と単元の集計は取り直されない
    expectInOrder(['共通鍵暗号方式', '公開鍵暗号方式'], '戻った論点の一覧が単元の構成の順でない')
    for (const term of ['共通鍵暗号方式', '公開鍵暗号方式'])
      expect(tierIn(squash(rowOf(term).textContent)), `戻った一覧の「${term}」に出題回数の印が無い`).toBe(3)
    expect(countOf('/api/fields'), '分野の集計を取り直している').toBe(1)
  })
})
