// @vitest-environment jsdom
/** 資格対策の学びで、論点の画面と論点の一覧の行が示す理解度（未の示し方と、回答の履歴からの判定か本人の上書きかの別）。UC-003
 *
 *  サーバの応答は偽の fetch で与える（形は UC-002 の契約の getTopicDetail・listTopics・listFields・listCategories、
 *  UC-003 の契約の recordUnderstanding）。学びの種類は読み込み時に決まる（VITE_EXAM）ので、資格対策（ip）に差し替えて読み込み直す。
 *  画面は用語集の語で読む: 段階は「未」「未理解」「やや理解」「理解」、別は「回答の履歴からの判定」「本人の上書き」。
 *  示している理解度は、別の語を持つ最も内側の範囲から、理解度の操作の文字を除いて読む（DOM の形は固定しない）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TERM = '論点 231 の名前'
const OTHER_TERMS = ['一覧の論点あ', '一覧の論点い']

type Source = 'auto' | 'override'
type Shown = { status: number; statusSource: Source }

const detailOf = (shown: Shown) => ({
  topic: {
    id: 231,
    term: TERM,
    subtitle: null,
    explanation: '短い説明の本文です。',
    detail: null,
    questionCount: 4,
    frequencyTier: 3,
    isNew: 0,
    ...shown,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '行の単元',
    middleNo: 9,
    itemName: '行の小項目',
    tier: null,
  },
  questions: [],
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: null,
})

const rowOfTopic = (id: number, term: string, shown: Shown) => ({
  id,
  term,
  subtitle: null,
  questionCount: 4,
  frequencyTier: 3,
  ...shown,
  field: 'ストラテジ系',
  middle: '行の単元',
  itemNo: 1,
  itemName: '行の小項目',
  groupNo: null,
  isNew: 0,
  sortOrder: null,
  round: null,
  roundLabel: null,
  tier: null,
})

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body })

let puts = 0
let release: (() => void) | null = null
/** 偽のサーバ。detail は呼ばれるたびに評価する（記録の前後で変えられる）。
 *  record は記録の応答の返し方: ok はすぐ成功、hold はテストが離すまで止める、fail は 500 で断る。 */
function stubApi(opts: {
  detail: () => Shown
  rows?: ReturnType<typeof rowOfTopic>[]
  onRecord?: (status: number) => void
  record?: 'ok' | 'hold' | 'fail'
}) {
  release = null
  puts = 0
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const p = url.pathname
    if (method === 'PUT' && /\/topics\/\d+\/progress$/.test(p)) {
      puts++
      const status = Number(JSON.parse(String(init?.body ?? '{}')).status)
      if (opts.record === 'fail') return json({ error: '理解度を記録できませんでした' }, 500)
      if (opts.record === 'hold')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      opts.onRecord?.(status)
      return json({ ok: true, status })
    }
    if (p.endsWith('/glossary')) return json({ glossary: [] })
    if (/\/topics\/\d+$/.test(p)) return json(detailOf(opts.detail()))
    if (p.endsWith('/fields'))
      return json({ fields: [{ field: 'ストラテジ系', topics: 3, questions: 12, understood: 0, partly: 1, untouched: 1, unanswered: 1 }] })
    if (p.endsWith('/categories'))
      return json({ categories: [{ middleNo: 9, middle: '行の単元', major: '企業と法務', field: 'ストラテジ系', topics: 3, questions: 12, understood: 0 }] })
    if (p.endsWith('/topics')) return json({ structure: null, topics: opts.rows ?? [] })
    if (p.endsWith('/sessions/current')) return json({ session: null })
    return json({})
  })
}

let host: HTMLElement
let close: (() => Promise<void>) | null = null
let act: (cb: () => Promise<void>) => Promise<void>

async function draw(entry: string) {
  vi.stubEnv('VITE_EXAM', 'ip')
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter, Route, Routes } = await import('react-router-dom')
  const { TopicDetail } = await import('../../src/client/pages/TopicDetail')
  const { Topics } = await import('../../src/client/pages/Topics')
  act = React.act as unknown as typeof act
  const h = React.createElement
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: [entry] },
        h(Routes, null, h(Route, { path: '/topics/:id', element: h(TopicDetail) }), h(Route, { path: '/topics', element: h(Topics) })),
      ),
    )
  })
  close = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}

const squash = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim()
const CONTROLS = 'button, [role="button"], [role="radio"], [role="checkbox"], summary, a, input[type="radio"], input[type="checkbox"]'
const nameOf = (el: Element) => {
  const aria = el.getAttribute('aria-label')
  if (aria) return squash(aria)
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) return squash([...labels].map((l) => l.textContent).join(' '))
  return squash(el.textContent)
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

const STAGES = ['未理解', 'やや理解', '理解']
const ALL_TERMS = [TERM, ...OTHER_TERMS]
/** 理解度の操作の選択肢（段階の名前を 1 つだけ持ち、論点の名前を持たない操作）。 */
const stageControls = () =>
  [...host.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => {
    const n = nameOf(el)
    return STAGES.includes(stageIn(n) ?? '') && !ALL_TERMS.some((t) => n.includes(t))
  })

const SOURCES = ['回答の履歴からの判定', '本人の上書き']
/** 論点の画面が示す理解度: 別の語を持つ最も内側の範囲で、操作の文字を除いて読む段階と別。 */
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
  throw new Error(`論点の画面に理解度が、回答の履歴からの判定か本人の上書きかの別とともに示されていない: ${squash(host.textContent)}`)
}

/** 論点の一覧の 1 行: 論点名を持つ最も内側の要素から、ほかの論点名を含まない限り外へ広げた範囲。 */
function rowOf(term: string): HTMLElement {
  const others = ALL_TERMS.filter((t) => t !== term)
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

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  release?.()
  if (close) await close()
  close = null
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('資格対策の論点の画面と一覧の行が示す理解度（UC-003）', () => {
  // @covers REQ-481#screen-shows-unanswered
  it('未（status=0）の論点は、論点の画面でも一覧の行でも「未」と示し、「未理解」と示さない', async () => {
    stubApi({ detail: () => ({ status: 0, statusSource: 'auto' }) })
    await draw('/topics/231')
    expect(shownUnderstanding().stage, '論点の画面が未を未として示していない').toBe('未')
    await close!()
    close = null

    const rows = [
      rowOfTopic(231, TERM, { status: 0, statusSource: 'auto' }),
      rowOfTopic(232, OTHER_TERMS[0], { status: 1, statusSource: 'auto' }),
      rowOfTopic(233, OTHER_TERMS[1], { status: 2, statusSource: 'override' }),
    ]
    stubApi({ detail: () => ({ status: 0, statusSource: 'auto' }), rows })
    await draw('/topics')
    const unit = [...host.querySelectorAll<HTMLElement>(CONTROLS)].find((el) => nameOf(el).includes('行の単元'))
    if (unit)
      await act(async () => {
        unit.click()
      })
    expect(stageIn(squash(rowOf(TERM).textContent)), '一覧の行が未を未として示していない').toBe('未')
    expect(stageIn(squash(rowOf(OTHER_TERMS[0]).textContent)), '未理解の行が未理解と示されていない').toBe('未理解')
  })

  // @covers REQ-483#screen-names-source
  it('論点の画面は、示している段階が回答の履歴からの判定か本人の上書きかを、段階とともに示す', async () => {
    const cases: Array<[Shown, { stage: string; source: string }]> = [
      [{ status: 0, statusSource: 'auto' }, { stage: '未', source: '回答の履歴からの判定' }],
      [{ status: 2, statusSource: 'auto' }, { stage: 'やや理解', source: '回答の履歴からの判定' }],
      [{ status: 2, statusSource: 'override' }, { stage: 'やや理解', source: '本人の上書き' }],
      [{ status: 3, statusSource: 'override' }, { stage: '理解', source: '本人の上書き' }],
    ]
    for (const [shown, expected] of cases) {
      stubApi({ detail: () => shown })
      await draw('/topics/231')
      expect(shownUnderstanding(), `status=${shown.status}・${shown.statusSource}`).toEqual(expected)
      await close!()
      close = null
    }
  })

  // @covers REQ-483#source-after-recording
  it('判定が示されている論点で段階を選んで記録が成功したあとは、選んだ段階を本人の上書きとして示す', async () => {
    let shown: Shown = { status: 1, statusSource: 'auto' }
    stubApi({
      detail: () => shown,
      onRecord: (status) => {
        shown = { status, statusSource: 'override' }
      },
    })
    await draw('/topics/231')
    expect(shownUnderstanding()).toEqual({ stage: '未理解', source: '回答の履歴からの判定' })
    const choice = stageControls().find((el) => stageIn(nameOf(el)) === 'やや理解')
    expect(choice, '理解度の操作に「やや理解」の選択肢が無い').toBeTruthy()
    await act(async () => {
      choice!.click()
    })
    await act(async () => {})
    expect(puts, '理解度の記録を求めていない').toBe(1)
    expect(shownUnderstanding(), '記録したあとに本人の上書きとして示していない').toEqual({ stage: 'やや理解', source: '本人の上書き' })
  })
  /** 示している理解度が判定の未理解の論点で、やや理解を選ぶ。 */
  async function choosePartlyOnJudged(record: 'hold' | 'fail') {
    let shown: Shown = { status: 1, statusSource: 'auto' }
    stubApi({
      detail: () => shown,
      record,
      onRecord: (status) => {
        shown = { status, statusSource: 'override' }
      },
    })
    await draw('/topics/231')
    expect(shownUnderstanding()).toEqual({ stage: '未理解', source: '回答の履歴からの判定' })
    const choice = stageControls().find((el) => stageIn(nameOf(el)) === 'やや理解')
    expect(choice, '理解度の操作に「やや理解」の選択肢が無い').toBeTruthy()
    await act(async () => {
      choice!.click()
    })
  }

  // @covers REQ-483#override-shown-before-response
  it('段階を選ぶと、記録の応答が返る前から、選んだ段階を本人の上書きとして示す', async () => {
    await choosePartlyOnJudged('hold')
    expect(release, '理解度の記録を求めていない').not.toBeNull()
    expect(shownUnderstanding(), '記録の完了を待って本人の上書きを示している').toEqual({ stage: 'やや理解', source: '本人の上書き' })
  })

  // @covers REQ-483#revert-on-record-failure
  it('記録が届かなかったときは、選ぶ前の段階と回答の履歴からの判定の示し方に戻す', async () => {
    await choosePartlyOnJudged('fail')
    await act(async () => {})
    expect(puts, '理解度の記録を求めていない').toBe(1)
    expect(shownUnderstanding(), '記録が届かなかったのに選ぶ前の示し方に戻っていない').toEqual({
      stage: '未理解',
      source: '回答の履歴からの判定',
    })
  })
})
