// @vitest-environment jsdom
/** 論点の画面（src/client/pages/TopicDetail.tsx）。本物の React で描く。
 *
 *  サーバの応答は fetch を偽物にして与える（形は scripts/check_api.py の TOPIC_DETAIL と同じ）。
 *  ロードマップ型の枝は VITE_EXAM を差し替えてから読み込み直す。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { getLastTopic, invalidateCached } from '../../src/client/lib/api'

const FIGURE_SRC = '/figures/ip/2024r06-q1.png'

type Over = Record<string, unknown>

const question = (n: number, over: Over = {}) => ({
  id: `2024r06-q${n}`,
  number: n,
  examLabel: '令和6年度',
  text: `過去問 ${n} の本文です。`,
  choices: { ア: `${n} のア`, イ: `${n} のイ`, ウ: `${n} のウ`, エ: `${n} のエ` },
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `出典：令和6年度 ITパスポート試験 問${n}`,
  modified: 0,
  timesAsked: 1,
  otherCitations: [],
  explanation: {
    correctReason: `問 ${n} の正解の理由です。`,
    choices: [
      { label: 'ア', term: null, note: `${n} のアの説明` },
      { label: 'イ', term: null, note: `${n} のイの説明` },
      { label: 'ウ', term: null, note: `${n} のウの説明` },
      { label: 'エ', term: null, note: `${n} のエの説明` },
    ],
  },
  contentKey: `ck-${n}`,
  exam: '2024r06',
  ...over,
})

/** 過去問 8 問。1 問目は図の画像つき、2 問目は書き起こしだけ、3 問目は図なし。 */
const QUESTIONS = [
  question(1, { hasFigure: 1, figureImage: FIGURE_SRC, figureDescription: '図の書き起こしです。' }),
  question(2, { hasFigure: 1, figureImage: null, figureDescription: '表だけの書き起こしです。' }),
  question(3),
  question(4),
  question(5),
  question(6),
  question(7),
  question(8),
]

const detail = (over: Over = {}) => ({
  topic: {
    id: 231,
    term: 'LTV',
    explanation: '短い説明の本文です。',
    detail: '詳しい解説の本文です。',
    questionCount: QUESTIONS.length,
    isNew: 0,
    status: 3,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: '事業の指標',
    middleNo: 4,
    itemName: '会計と財務',
    syllabusItemId: 3,
  },
  questions: QUESTIONS,
  siblings: [{ id: 232, term: '同じ小項目の他の論点', questionCount: 3 }],
  nextTopic: { id: 555, term: '次に学ぶ論点', questionCount: 6, field: 'ストラテジ系' },
  neighbors: { prev: null, next: null },
  ...over,
})

let container: HTMLElement
let root: Root
let calls: Array<{ url: string; method: string }>

const text = () => container.textContent ?? ''
const hrefs = () => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')

/** 応答を決める偽の fetch。progress（PUT）の応答はテストごとに差し替える。 */
function stubApi(opts: { body?: Over; put?: () => Promise<unknown> } = {}) {
  calls = []
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = init?.method ?? 'GET'
    calls.push({ url: url.pathname + url.search, method })
    if (method === 'PUT' && url.pathname.includes('/progress')) {
      if (opts.put) return await (opts.put() as Promise<any>)
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    }
    if (url.pathname.endsWith('/glossary'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: [] }) }
    if (/\/topics\/\d+$/.test(url.pathname))
      return { ok: true, status: 200, text: async () => JSON.stringify(detail(opts.body ?? {})) }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) }
  })
}

async function draw(node: ReactNode, entry = '/topics/231') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/topics/:id" element={node} />
          <Route path="/topics" element={<div>論点の一覧</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

/** 要件が決めている文字で操作を探して押す。 */
async function choose(label: string | RegExp) {
  const match = (s: string) => (typeof label === 'string' ? s.includes(label) : label.test(s))
  const cand = [...container.querySelectorAll<HTMLElement>('button, summary, [role="button"]')].filter(
    (el) => match(el.textContent ?? ''),
  )
  if (!cand.length) throw new Error(`「${label}」の操作が画面に無い`)
  await act(async () => {
    cand[0].click()
  })
}

/** 理解度の 3 段階のボタン（1=未理解・2=やや理解・3=理解。押した段階が aria-pressed）。 */
const STAGES = ['未理解', 'やや理解', '理解']

function stageControls() {
  return [...container.querySelectorAll<HTMLElement>('button')].filter((el) =>
    STAGES.includes((el.textContent ?? '').trim()),
  )
}

/** 押した状態（aria-pressed）になっている段階の文字。 */
function selectedStage(): string {
  const els = stageControls()
  if (els.length < STAGES.length)
    throw new Error('理解度の 3 段階（未理解・やや理解・理解）の操作が画面に無い')
  const marked = els.filter((el) => el.getAttribute('aria-pressed') === 'true')
  if (marked.length !== 1)
    throw new Error(
      `aria-pressed の段階が ${marked.length} 個ある（1 個のはず）: ` +
        els.map((e) => `${(e.textContent ?? '').trim()}=${e.getAttribute('aria-pressed')}`).join(' / '),
    )
  return (marked[0].textContent ?? '').trim()
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('論点の解説（UC-002）', () => {
  // @covers REQ-030#detail-toggle
  it('短い説明は最初から描き、詳しい解説は押したときだけ開く', async () => {
    stubApi()
    await draw(<TopicDetail />)
    expect(text()).toContain('短い説明の本文です。')
    expect(text()).not.toContain('詳しい解説の本文です。')
    await choose(/詳し/)
    expect(text()).toContain('詳しい解説の本文です。')
    await choose(/詳し/)
    expect(text()).not.toContain('詳しい解説の本文です。')
  })
})

describe('紐づく過去問（UC-002）', () => {
  const explControls = () =>
    [...container.querySelectorAll<HTMLElement>('button, summary')].filter(
      (b) => /解説/.test(b.textContent ?? '') && !/詳し/.test(b.textContent ?? ''),
    )

  // @covers REQ-031#answer-then-explanation
  it('本文と選択肢は出すが、答えを押すまで解説の手段を出さない', async () => {
    stubApi()
    await draw(<TopicDetail />)
    expect(text()).toContain('過去問 1 の本文です。')
    expect(text()).toContain('1 のア')
    expect(text()).not.toContain('問 1 の正解の理由です。')
    expect(explControls(), '答えを見る前に解説の手段が出ている').toHaveLength(0)
    await choose('答え')
    expect(explControls().length, '答えを出したのに解説の手段が無い').toBeGreaterThan(0)
    await act(async () => {
      explControls()[0].click()
    })
    expect(text()).toContain('問 1 の正解の理由です。')
  })

  // @covers REQ-032#first-page-then-rest
  it('最初は先頭の数問だけ出し、残りの件数つきの手段で残りを開く', async () => {
    stubApi()
    await draw(<TopicDetail />)
    const shown = QUESTIONS.filter((q) => text().includes(q.text)).length
    expect(shown, '過去問が全部出ている（先頭の数問だけにする）').toBeLessThan(QUESTIONS.length)
    expect(shown).toBeGreaterThan(0)
    const more = [...container.querySelectorAll<HTMLElement>('button')].filter((b) =>
      new RegExp(`${QUESTIONS.length - shown}\\s*問`).test(b.textContent ?? ''),
    )
    expect(more.length, `残り ${QUESTIONS.length - shown} 問を開く手段が無い`).toBeGreaterThan(0)
    await act(async () => {
      more[0].click()
    })
    expect(QUESTIONS.every((q) => text().includes(q.text))).toBe(true)
  })

  // @covers REQ-024#figure-image-and-transcript
  it('図は画像を出して書き起こしを開けるようにし、画像が無い問題は書き起こしを本体にする', async () => {
    stubApi()
    await draw(<TopicDetail />)
    const img = container.querySelector(`img[src="${FIGURE_SRC}"]`)
    expect(img, '切り出した画像が出ていない').not.toBeNull()
    // タップで原寸に切り替える手段
    expect(
      container.querySelector('[aria-label="図を原寸で表示する"]'),
      '原寸に切り替える手段が無い',
    ).not.toBeNull()
    // 画像がある問題の書き起こしは畳まれていて、押すと出る（併記）
    expect(text()).not.toContain('図の書き起こしです。')
    await choose('図の説明（読み上げ・検索用）')
    expect(text()).toContain('図の書き起こしです。')
    expect(text()).toContain('図の説明を閉じる')
    // 画像が無い（表だけの）問題は書き起こしがそのまま出る
    expect(text()).toContain('表だけの書き起こしです。')
    // 図の無い問題には画像を出さない（画像は 1 枚だけ）
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })
})

describe('理解度の記録', () => {
  // @covers REQ-038#selected-before-response
  it('記録の結果を待たずに、押した段階を選択済みにする', async () => {
    // 応答が返らない PUT（待たずに描き替えることを見る）
    stubApi({ put: () => new Promise(() => {}) })
    await draw(<TopicDetail />)
    expect(selectedStage()).toBe('理解')
    await choose('やや理解')
    expect(selectedStage()).toBe('やや理解')
    expect(calls.some((c) => c.method === 'PUT')).toBe(true)
  })

  // @covers REQ-039#revert-on-failure
  it('記録に失敗したら押す前の段階に戻し、教材を消さずに失敗を伝える', async () => {
    stubApi({
      put: async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: '理解度を記録できませんでした' }),
      }),
    })
    await draw(<TopicDetail />)
    await choose('未理解')
    expect(text()).toContain('理解度を記録できませんでした')
    expect(selectedStage()).toBe('理解')
    // 読んでいた教材が消えていない
    expect(text()).toContain('短い説明の本文です。')
  })
})

describe('次に学ぶ論点', () => {
  // @covers REQ-045#next-topic-link-on-detail
  it('添えられた候補があれば末尾に導線を出す', async () => {
    stubApi()
    await draw(<TopicDetail />)
    expect(text()).toContain('次に学ぶ')
    expect(text()).toContain('次に学ぶ論点')
    expect(hrefs()).toContain('/topics/555')
  })

  // @covers REQ-046#detail-shows-list-link
  it('候補が無ければ次に学ぶを出さず、一覧への導線を出す', async () => {
    stubApi({ body: { nextTopic: null } })
    await draw(<TopicDetail />)
    expect(text()).not.toContain('次に学ぶ')
    expect(hrefs()).toContain('/topics')
  })
})

describe('前回の続き', () => {
  // @covers REQ-077#opened-topic-remembered
  it('論点の画面を開くと、その論点を前回の続きとして覚える', async () => {
    stubApi()
    expect(getLastTopic()).toBeNull()
    await draw(<TopicDetail />)
    expect(getLastTopic()).toMatchObject({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
  })
})

describe('ロードマップ型の論点の画面', () => {
  /** VITE_EXAM を差し替えてから読み込み直す（対象は読み込み時に決まる）。 */
  async function drawRoadmap(over: Over = {}) {
    vi.stubEnv('VITE_EXAM', 'itc')
    vi.resetModules()
    const React = await import('react')
    const { createRoot: create } = await import('react-dom/client')
    const { MemoryRouter: Router, Route: R, Routes: Rs } = await import('react-router-dom')
    const page = await import('../../src/client/pages/TopicDetail')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const r = create(host)
    await React.act(async () => {
      r.render(
        React.createElement(
          Router,
          { initialEntries: ['/topics/231'] },
          React.createElement(
            Rs,
            null,
            React.createElement(R, { path: '/topics/:id', element: React.createElement(page.TopicDetail) }),
            // ロードマップ型ではロードマップが /topics に載っている
            React.createElement(R, { path: '/topics', element: React.createElement('div', null, 'ロードマップ') }),
          ),
        ),
      )
    })
    return {
      text: () => host.textContent ?? '',
      links: () => [...host.querySelectorAll('a')],
      close: async () => {
        await React.act(async () => r.unmount())
        host.remove()
      },
      over,
    }
  }

  // @covers REQ-139#neighbors-named-and-linked
  it('前後の単位への導線を単位名つきで末尾に出す', async () => {
    stubApi({
      body: {
        neighbors: { prev: { id: 230, term: '前の単位の名前' }, next: { id: 232, term: '次の単位の名前' } },
      },
    })
    const v = await drawRoadmap()
    expect(v.text()).toContain('前の単位の名前')
    expect(v.text()).toContain('次の単位の名前')
    const to = v.links().map((a) => a.getAttribute('href'))
    expect(to).toContain('/topics/230')
    expect(to).toContain('/topics/232')
    await v.close()
  })

  // @covers REQ-138#no-sibling-no-next
  it('他の論点と次に学ぶを出さず、戻り先をロードマップにする', async () => {
    stubApi({
      body: {
        neighbors: { prev: { id: 230, term: '前の単位の名前' }, next: { id: 232, term: '次の単位の名前' } },
      },
    })
    const v = await drawRoadmap()
    expect(v.text()).not.toContain('同じ小項目の他の論点')
    expect(v.text()).not.toContain('次に学ぶ')
    // 戻り先はロードマップ（ロードマップ型では /topics）
    const back = v.links().find((a) => a.getAttribute('href') === '/topics')
    expect(back, '戻り先がロードマップ（/topics）になっていない').toBeTruthy()
    expect(back!.textContent).toContain('ロードマップに戻る')
    await v.close()
  })

  // @covers REQ-140#one-side-missing-disabled
  it('端の単位では、無い向きの案内を押せない形で残す', async () => {
    stubApi({
      body: { neighbors: { prev: null, next: { id: 232, term: '次の単位の名前' } } },
    })
    const v = await drawRoadmap()
    // 案内そのものは消さない
    expect(v.text()).toContain('前の単位')
    // 前へ移る手段は無い（押せる要素になっていない）
    expect(v.links().some((a) => /前の単位/.test(a.textContent ?? ''))).toBe(false)
    expect(v.links().map((a) => a.getAttribute('href'))).toContain('/topics/232')
    await v.close()
  })
})
