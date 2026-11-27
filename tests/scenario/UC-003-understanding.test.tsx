// @vitest-environment jsdom
/** UC-003「論点の理解度を記録して次に学ぶ論点を辿る」の主シナリオを
 *  1 本で実行する写し（正常系のみ。失敗系・境界は要件のテストが見る）。
 *
 *  資格対策の学びの画面。サーバの応答は偽の fetch で返し、理解度は偽のサーバが
 *  BR-049・BR-050 のとおり「回答の履歴からの判定」と「本人の上書き」で持つ。値は契約
 *  （recordUnderstanding・getHomeSummary、論点の経路は UC-002 の listTopics・getTopicDetail、
 *  演習の経路は UC-004 の startSession・getCurrentQuestion・answerQuestion）の examples から採る。
 *  画面の文字は用語集の語で引き、理解度は段階の名前（未・未理解・やや理解・理解）で、
 *  選ばれている段階は色ではなく読み上げに届く選択の状態で読む。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../../src/client/App'
import { setToken } from '../../src/client/lib/api'

const FIELD = 'テクノロジ系'
const MIDDLE = 'セキュリティ'
const TARGET = { id: 418, term: '公開鍵暗号方式', questionCount: 9 }
const OTHER = { id: 419, term: '共通鍵暗号方式', questionCount: 7 }
const TOPIC_LIST = [OTHER, TARGET]
const TERMS = TOPIC_LIST.map((t) => t.term)
const UNDERSTOOD = 3
const PARTLY = 2
const NOT_YET = 1
const UNANSWERED = 0

/** 偽のサーバが持つ理解度（論点ごとの段階と、回答の履歴からの判定か本人の上書きか）。 */
type Understanding = { status: number; statusSource: 'auto' | 'override' }
let understanding = new Map<number, Understanding>()
/** 偽のサーバに残っている理解度の記録（1 利用者 1 論点に 1 件）。 */
let records = new Map<number, number>()

const STRUCTURE = {
  overview: '情報を守る考え方と、それを支える暗号・認証の仕組みを学ぶ。',
  groups: [{ no: 1, name: '暗号と証明書', description: '鍵の持ち方で暗号を分け、署名と証明書で相手を確かめる。' }],
}
const row = (t: { id: number; term: string; questionCount: number }) => ({
  id: t.id,
  term: t.term,
  subtitle: null,
  questionCount: t.questionCount,
  frequencyTier: 3,
  ...understanding.get(t.id)!,
  field: FIELD,
  middle: MIDDLE,
  itemNo: 3,
  itemName: '暗号技術',
  groupNo: 1,
  isNew: 0,
  sortOrder: null,
  round: null,
  roundLabel: null,
  tier: null,
})
const countWith = (status: number) => TOPIC_LIST.filter((t) => understanding.get(t.id)!.status === status).length
/** 次に学ぶの候補: 理解でない論点を出題頻度の降順に（BR-030）。 */
const nextTopics = () =>
  TOPIC_LIST.filter((t) => understanding.get(t.id)!.status !== UNDERSTOOD)
    .sort((a, b) => b.questionCount - a.questionCount)
    .map((t) => ({ ...t, field: FIELD }))

/** getCurrentQuestion が返す問題（UC-002 の getTopicDetail の examples.ok の過去問）。 */
const DRILL_QUESTION = {
  text: '公開鍵暗号方式を用いて送信者が受信者宛てのメッセージを暗号化するとき、暗号化に使う鍵はどれか。',
  choices: { ア: '受信者の公開鍵', イ: '受信者の秘密鍵', ウ: '送信者の公開鍵', エ: '送信者の秘密鍵' },
  citation: '平成30年度秋期 問38',
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 2,
  otherCitations: ['平成28年度春期 問40'],
}
const WRONG_CHOICE = '受信者の秘密鍵'
const SESSION_ID = '8f14e45f-ea2b-4f1c-9a3e-6b1d2c7f4a90'
let drillAnswered = 0

const RECENT = { id: '6b2c91f4-10ad-4e7b-8d53-0c7f9a4e2b18', kind: 'middle', scopeLabel: `単元「${MIDDLE}」`, questionCount: 20, correctCount: 14, finishedAt: 1759276800 }
const VISITS = { today: '2026-10-01', streak: 4, longest: 11, total: 37 }

type Call = { url: string; method: string; body?: string }
let calls: Call[] = []
const countOf = (part: string, method = 'GET') => calls.filter((c) => c.method === method && c.url.includes(part)).length

/** 理解度の記録の応答を、テストが離すまで止めておく（記録の完了を待たずに示すかを見るため）。 */
let releaseRecord: (() => void) | null = null

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
}

function stubApi() {
  calls = []
  understanding = new Map([
    [TARGET.id, { status: UNANSWERED, statusSource: 'auto' }],
    [OTHER.id, { status: UNANSWERED, statusSource: 'auto' }],
  ])
  records = new Map()
  drillAnswered = 0
  releaseRecord = null
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const sent = init?.body ? String(init.body) : undefined
    calls.push({ url: url.pathname + url.search, method, body: sent })
    const p = url.pathname
    const q = url.searchParams

    const progress = p.match(/\/topics\/(\d+)\/progress$/)
    if (method === 'PUT' && progress) {
      const id = Number(progress[1])
      const status = Number(JSON.parse(sent ?? '{}').status)
      await new Promise<void>((resolve) => {
        releaseRecord = resolve
      })
      records.set(id, status)
      understanding.set(id, { status, statusSource: 'override' })
      return json({ ok: true, status })
    }
    if (method === 'POST' && p.endsWith('/sessions'))
      return json({ id: SESSION_ID, kind: 'drill', scopeLabel: `論点「${TARGET.term}」`, questionCount: 2, timeLimitSec: null }, 201)
    if (method === 'POST' && p.endsWith(`/sessions/${SESSION_ID}/answer`)) {
      drillAnswered += 1
      // 最新の回答が誤答なので、記録より後の回答として BR-049 の判定（未理解）に戻る
      understanding.set(TARGET.id, { status: NOT_YET, statusSource: 'auto' })
      return json({
        correct: false,
        correctAnswer: 'ア',
        explanation: {
          correctReason: '正解。受信者の公開鍵で暗号化する。',
          choices: [{ label: 'イ', term: '秘密鍵', note: '本人だけが持ち、復号や署名に使う鍵。' }],
        },
        remaining: 2 - drillAnswered,
        finished: false,
      })
    }

    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-10-01T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/fields'))
      body = {
        fields: [
          {
            field: FIELD,
            topics: TOPIC_LIST.length,
            questions: 16,
            understood: countWith(UNDERSTOOD),
            partly: countWith(PARTLY),
            untouched: countWith(NOT_YET),
            unanswered: countWith(UNANSWERED),
          },
        ],
      }
    else if (p.endsWith('/categories'))
      body = { categories: [{ middleNo: 12, middle: MIDDLE, major: '技術要素', field: FIELD, topics: TOPIC_LIST.length, questions: 16, understood: countWith(UNDERSTOOD) }] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith(`/sessions/${SESSION_ID}/current`))
      body = {
        session: { id: SESSION_ID, kind: 'drill', scopeLabel: `論点「${TARGET.term}」`, questionCount: 2, sourceExam: null },
        question: { idx: drillAnswered, ...DRILL_QUESTION },
        answered: drillAnswered,
        remainingSec: null,
        finished: false,
      }
    else if (/\/topics\/\d+$/.test(p)) {
      const id = Number(p.split('/').at(-1))
      const t = TOPIC_LIST.find((x) => x.id === id)!
      const next = nextTopics().find((x) => x.id !== id) ?? null
      body = {
        topic: {
          id,
          term: t.term,
          subtitle: null,
          explanation: `${t.term} の短い説明です。`,
          detail: null,
          questionCount: t.questionCount,
          frequencyTier: 3,
          isNew: 0,
          ...understanding.get(id)!,
          field: FIELD,
          major: '技術要素',
          middle: MIDDLE,
          middleNo: 12,
          itemName: '暗号技術',
          tier: null,
        },
        questions: [],
        prerequisites: [],
        // 次に学ぶの導線だけが他の論点を指すよう、同じまとまりの他の論点は空にする
        siblings: [],
        nextTopic: next && { id: next.id, term: next.term, questionCount: next.questionCount, frequencyTier: 3 },
        neighbors: null,
      }
    } else if (p.endsWith('/topics')) {
      const status = q.get('status')
      const chosen = status === null ? null : status.split(',').filter((s) => s !== '').map(Number)
      body = {
        structure: STRUCTURE,
        topics: TOPIC_LIST.map(row).filter((r) => chosen === null || chosen.includes(r.status)),
      }
    } else if (p.endsWith('/glossary')) body = { glossary: [] }
    else if (p.endsWith('/me'))
      body = {
        user: { id: '8a0f1d62-3c47-4b10-9f85-d2e6a1c70b33', name: '山田 太郎', role: 'MEMBER' },
        topics: { total: TOPIC_LIST.length, understood: countWith(UNDERSTOOD), partly: countWith(PARTLY) },
        recentSessions: [RECENT],
        nextTopics: nextTopics(),
        visits: VISITS,
      }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    return json(body)
  })
}

let host: HTMLElement
let root: Root | null = null

const squash = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
const text = () => squash(host.textContent)

const CONTROLS = 'button, [role="button"], [role="radio"], [role="checkbox"], summary, a, input[type="radio"], input[type="checkbox"]'
/** 操作の名前（読み上げで分かる名前を先に、無ければ見えている文字）。 */
const nameOf = (el: Element) => {
  const aria = el.getAttribute('aria-label')
  if (aria) return squash(aria)
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) return squash([...labels].map((l) => l.textContent).join(' '))
  return squash(el.textContent)
}
const controls = (name: string | RegExp) =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) =>
    typeof name === 'string' ? nameOf(el).includes(name) : name.test(nameOf(el)),
  )
async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}
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

/** 理解度の操作で選べる 3 段階（未は記録できないので選択肢に無い）。 */
const STAGES = ['未理解', 'やや理解', '理解']
const stageControls = () =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => {
    const n = nameOf(el)
    return STAGES.includes(stageIn(n) ?? '') && !TERMS.some((t) => n.includes(t))
  })
async function pressStage(stage: string) {
  const el = stageControls().find((x) => stageIn(nameOf(x)) === stage)
  if (!el) throw new Error(`理解度の操作に「${stage}」の選択肢が無い`)
  await click(el)
}
/** 選ばれていることが色によらず分かる形（読み上げに届く選択の状態）を持つ選択肢か。 */
const isChosen = (el: HTMLElement) =>
  el.getAttribute('aria-pressed') === 'true' ||
  el.getAttribute('aria-checked') === 'true' ||
  el.getAttribute('aria-selected') === 'true' ||
  (el.getAttribute('aria-current') ?? 'false') !== 'false' ||
  (el instanceof HTMLInputElement && el.checked)
/** 理解度の操作で選ばれている段階の名前（どれも選ばれていなければ null）。 */
function chosenStage(): string | null {
  const els = stageControls()
  expect(els.map((e) => stageIn(nameOf(e))), '理解度の操作が 3 段階の名前を持つ選択肢になっていない').toEqual(STAGES)
  const marked = els.filter(isChosen)
  expect(marked.length, '選ばれている選択肢が 2 つ以上ある').toBeLessThanOrEqual(1)
  return marked.length ? stageIn(nameOf(marked[0])) : null
}

const SOURCES = ['回答の履歴からの判定', '本人の上書き']
/** 論点の画面が示す理解度: 判定か上書きかの別を持つ最も内側の範囲で、操作の文字を除いて読む段階と別。 */
function shownUnderstanding(): { stage: string | null; source: string } {
  const ctrls = stageControls()
  const candidates = [...host.querySelectorAll<HTMLElement>('*')].filter((el) =>
    SOURCES.some((s) => squash(el.textContent).includes(s)),
  )
  for (const el of candidates.reverse()) {
    let t = squash(el.textContent)
    for (const c of ctrls) if (el.contains(c)) t = t.replace(squash(c.textContent), '')
    const sources = SOURCES.filter((s) => t.includes(s))
    for (const s of SOURCES) t = t.split(s).join('')
    const stage = stageIn(t)
    if (stage && sources.length === 1) return { stage, source: sources[0] }
  }
  throw new Error('論点の画面に理解度が、回答の履歴からの判定か本人の上書きかの別とともに示されていない')
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
    if (others.some((o) => squash(el.parentElement!.textContent).includes(o))) break
    el = el.parentElement
  }
  return el
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
  releaseRecord?.()
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
  vi.unstubAllGlobals()
})

describe('UC-003 論点の理解度を記録して次に学ぶ論点を辿る', () => {
  // @scenario UC-003
  it('回答の履歴からの判定を上書きし、演習で回答して判定に戻り、ホームの次に学ぶから論点を辿る', async () => {
    // 段 1: 利用者が論点の画面を開く（論点を選ぶまでの導線は UC-002 の範囲）
    await open('/topics')
    await press(MIDDLE)
    await press(TARGET.term)
    expect(text(), '論点の画面が出ていない').toContain(`${TARGET.term} の短い説明です。`)

    // 段 2: 回答が無いので未を、回答の履歴からの判定として示す（未のときはどの選択肢も選ばれていない）
    expect(shownUnderstanding(), '回答の無い論点の理解度が未の判定として示されていない').toEqual({
      stage: '未',
      source: '回答の履歴からの判定',
    })
    expect(chosenStage(), '未なのに理解度の操作のどれかが選ばれている').toBeNull()

    // 段 3: 利用者が 3 段階のいずれか（やや理解）を選んで判定を上書きする
    await pressStage('やや理解')

    // 段 4: 記録の完了を待たずに、選ばれた段階を選ばれているものとして示す
    expect(releaseRecord, '理解度の記録を求めていない').not.toBeNull()
    expect(chosenStage(), '記録の完了を待たずに選んだ段階が示されていない').toBe('やや理解')

    // 段 5: 選ばれた段階をその利用者のその論点の理解度の記録として残す（recordUnderstanding）
    await act(async () => {
      releaseRecord!()
    })
    const puts = calls.filter((c) => c.method === 'PUT' && c.url.includes(`/api/topics/${TARGET.id}/progress`))
    expect(puts, '理解度の記録が 1 回だけ求められていない').toHaveLength(1)
    expect(JSON.parse(puts[0].body ?? '{}').status, '記録に選んだ段階が入っていない').toBe(PARTLY)
    expect([...records.entries()], '記録がその論点の 1 件になっていない').toEqual([[TARGET.id, PARTLY]])

    // 段 6: 論点の画面では記録した段階を本人の上書きとして示し、操作では今の段階が選ばれている
    expect(shownUnderstanding(), '記録した段階が本人の上書きとして示されていない').toEqual({
      stage: 'やや理解',
      source: '本人の上書き',
    })
    expect(chosenStage(), '今の段階の選択肢が色によらず見分けられる形で示されていない').toBe('やや理解')

    // 段 6: 論点の一覧の行に記録した段階の名前を示す
    const fieldsBefore = countOf('/api/fields')
    await press(/戻る/)
    expect(stageIn(squash(rowOf(TARGET.term).textContent)), '論点の一覧の行に記録した段階が出ていない').toBe('やや理解')
    expect(stageIn(squash(rowOf(OTHER.term).textContent)), '記録していない論点の行が未でない').toBe('未')

    // 段 6: 分野・単元の集計にも反映する（単元の一覧に入ると集計を取り直す）
    await press(/戻る/)
    expect(countOf('/api/fields'), '理解度を記録したのに分野の集計を取り直していない').toBeGreaterThan(fieldsBefore)

    // 段 7: 利用者がその論点の過去問に演習で回答する（論点の教材から論点ドリルを始める。進め方は UC-004）
    await press(MIDDLE)
    await press(TARGET.term)
    await press(/論点ドリル/)
    const started = calls.filter((c) => c.method === 'POST' && /\/api\/sessions$/.test(c.url))
    expect(started, '論点ドリルを始めていない').toHaveLength(1)
    expect(JSON.parse(started[0].body ?? '{}'), '開いている論点の論点ドリルになっていない').toMatchObject({
      kind: 'drill',
      topicId: TARGET.id,
    })
    expect(text(), '演習の問題が出ていない').toContain(DRILL_QUESTION.text)
    await press(WRONG_CHOICE)
    expect(countOf(`/api/sessions/${SESSION_ID}/answer`, 'POST'), '回答が送られていない').toBe(1)

    // 段 9: 利用者がホームを開く
    await press('ホーム')

    // 段 10: 次に学ぶ（未を含むまだ理解していない論点を出題頻度の高い順）と、連続記録と最近の結果
    expect(text()).toContain('次に学ぶ')
    expect(text().indexOf(TARGET.term), '次に学ぶが出題頻度の高い順に並んでいない').toBeLessThan(
      text().indexOf(OTHER.term),
    )
    expect(text(), '次に学ぶに出題頻度が出ていない').toContain(String(TARGET.questionCount))
    expect(text(), '次に学ぶに分野が出ていない').toContain(FIELD)
    expect(text(), '連続記録が出ていない').toContain('連続記録')
    expect(text()).toContain(String(VISITS.streak))
    expect(text(), '最近の結果が出ていない').toContain(RECENT.scopeLabel)

    // 段 11: 利用者が示された論点を開く
    await press(TARGET.term)
    expect(text(), '次に学ぶから論点の画面へ移れていない').toContain(`${TARGET.term} の短い説明です。`)

    // 段 8: 回答したあとに示す理解度は、回答の履歴からの判定に戻っている
    expect(shownUnderstanding(), '回答したのに本人の上書きが効いたままになっている').toEqual({
      stage: '未理解',
      source: '回答の履歴からの判定',
    })
    expect(chosenStage(), '理解度の操作が回答の履歴からの判定の段階を選んでいない').toBe('未理解')

    // 段 12: いま開いている論点を除いた次に学ぶの先頭を示す
    expect(text()).toContain('次に学ぶ')
    expect(controls(OTHER.term).length, '論点の画面に次に学ぶの先頭への導線が無い').toBeGreaterThan(0)

    // 事後条件: 記録は本人のその論点の 1 件として残り、回答のあとは判定が理解度になっている
    expect([...records.entries()]).toEqual([[TARGET.id, PARTLY]])
    expect(understanding.get(TARGET.id)).toEqual({ status: NOT_YET, statusSource: 'auto' })
  })
})
