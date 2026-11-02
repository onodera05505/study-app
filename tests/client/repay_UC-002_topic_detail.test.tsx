// @vitest-environment jsdom
/** 論点の画面（src/client/pages/TopicDetail.tsx）の、UC-002 の未返済の分割クラス。
 *  本物の React で描く。
 *
 *  サーバの応答は fetch を偽物にして与える（形は contract.yaml の getTopicDetail の response）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TopicDetail } from '../../src/client/pages/TopicDetail'
import { invalidateCached } from '../../src/client/lib/api'

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
  ...over,
})

const manyQuestions = (count: number) => Array.from({ length: count }, (_, i) => question(i + 1))

const detail = (over: Over = {}) => {
  const { topic: topicOver, questions: questionsOver, ...rest } = over
  const questions = (questionsOver as unknown[] | undefined) ?? manyQuestions(8)
  return {
    topic: {
      id: 231,
      term: 'LTV',
      explanation: '短い説明の本文です。',
      detail: '詳しい解説の本文です。',
      questionCount: questions.length,
      isNew: 0,
      status: 3,
      field: 'ストラテジ系',
      major: '企業と法務',
      middle: '事業の指標',
      middleNo: 4,
      itemName: '会計と財務',
      tier: null,
      ...((topicOver as Over | undefined) ?? {}),
    },
    questions,
    siblings: [],
    nextTopic: null,
    neighbors: null,
    ...rest,
  }
}

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const hrefs = () => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
const buttons = () => [...container.querySelectorAll<HTMLElement>('button, summary, [role="button"]')]

/** 要素の文字と、読み上げ用の属性（aria-label・title）を合わせた文字。 */
function blockText(el: Element): string {
  const labels = [el, ...el.querySelectorAll('[aria-label], [title]')]
    .map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`)
    .join(' ')
  return `${el.textContent ?? ''} ${labels}`
}

const allElements = () => [...container.querySelectorAll<HTMLElement>('*')]

type StubOpts = {
  body?: Over
  /** 論点の教材の取得を 500 で失敗させる。 */
  fail?: string
}

/** 応答を決める偽の fetch。 */
function stubApi(opts: StubOpts = {}) {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    if (url.pathname.endsWith('/glossary'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: [] }) }
    if (/\/topics\/\d+$/.test(url.pathname)) {
      if (opts.fail)
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: opts.fail }) }
      return { ok: true, status: 200, text: async () => JSON.stringify(detail(opts.body ?? {})) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) }
  })
}

/** 1 件のテストの中で応答を替えて描き直すこともあるので、毎回捨ててから描く。 */
async function draw(node: ReactNode = <TopicDetail />, entry = '/topics/231') {
  await act(async () => {
    root.render(null)
  })
  invalidateCached()
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

/** 示したいことを述べている要素（部品の名前と「無い」旨が同じ要素の文字に収まる）。 */
function noticeOf(part: RegExp): HTMLElement | undefined {
  return allElements()
    .filter((el) => {
      const t = blockText(el)
      return part.test(t) && /(まだ|準備中|ありません|無い|ない|未作成)/.test(t)
    })
    .sort((a, b) => blockText(a).length - blockText(b).length)[0]
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  invalidateCached()
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

describe('論点の解説（UC-002）', () => {
  // @covers REQ-026#no-material
  it('教材が無い論点では、教材の場所を空にせず、教材がまだ無いことを示す', async () => {
    stubApi({ body: { topic: { explanation: null, detail: null }, questions: manyQuestions(1) } })
    await draw()
    expect(text()).toContain('LTV')
    // 過去問は示される（教材が無いだけ）
    expect(text()).toContain('過去問 1 の本文です。')
    const notice = noticeOf(/教材|解説|説明/)
    expect(notice, '教材がまだ無いことを示す文字が無い（教材の場所が空）').toBeTruthy()
    expect(blockText(notice!).length, '「教材が無い」旨が、教材の場所ではなく画面全体にしか見つからない').toBeLessThan(80)
  })

  // @covers REQ-026#no-questions
  it('紐づく過去問が無い論点では、過去問の場所を空にせず、過去問が無いことを示す', async () => {
    stubApi({ body: { questions: [] } })
    await draw()
    // 教材は示される（過去問が無いだけ）
    expect(text()).toContain('短い説明の本文です。')
    const notice = noticeOf(/過去問|問題/)
    expect(notice, '紐づく過去問が無いことを示す文字が無い（過去問の場所が空）').toBeTruthy()
    expect(blockText(notice!).length, '「過去問が無い」旨が、過去問の場所ではなく画面全体にしか見つからない').toBeLessThan(80)
    expect(text()).not.toContain('読み込み中')
  })

  // @covers REQ-033#detail-fetch-failed
  it('教材が取れなかったら、読み込み中を残さず、教材と過去問の代わりに取れなかったことを示す', async () => {
    stubApi({ fail: '論点の教材を取得できませんでした' })
    await draw()
    expect(text()).toContain('論点の教材を取得できませんでした')
    expect(text()).not.toContain('読み込み中')
    expect(text()).not.toContain('短い説明の本文です。')
    expect(text()).not.toContain('過去問 1 の本文です。')
  })
})

describe('紐づく過去問（UC-002）', () => {
  // @covers REQ-023#same-content-questions
  it('同一内容の過去問には、件数と他の出典を、渡された順（回の新しい順）に添える', async () => {
    const others = ['令和5年度 問12', '令和3年度 問7']
    stubApi({
      body: {
        questions: [question(1, { timesAsked: 3, otherCitations: others }), question(2)],
      },
    })
    await draw()
    for (const c of others) expect(text(), `他の出典「${c}」が出ていない`).toContain(c)
    expect(text().indexOf(others[0])).toBeLessThan(text().indexOf(others[1]))
    // 件数（3）は、その過去問の本文と同じ場所に添える
    const block = allElements()
      .filter((el) => {
        const t = blockText(el)
        return t.includes('過去問 1 の本文です。') && !t.includes('過去問 2 の本文です。')
      })
      .sort((a, b) => blockText(a).length - blockText(b).length)
      .find((el) => /3\s*(回|件|問|度)/.test(blockText(el)))
    expect(block, '同一内容の件数（3）が過去問に添えられていない').toBeTruthy()
    // 同一内容でない過去問には他の出典も件数も添えない
    const single = allElements()
      .filter((el) => {
        const t = blockText(el)
        return t.includes('過去問 2 の本文です。') && !t.includes('過去問 1 の本文です。')
      })
      .sort((a, b) => blockText(b).length - blockText(a).length)[0]
    expect(blockText(single)).not.toContain(others[0])
  })

  // @covers REQ-023#siblings-shown
  it('同じ小項目の他の論点を、名前と行き先つきで示す', async () => {
    const siblings = [
      { id: 232, term: 'きょうだい論点その一', questionCount: 3 },
      { id: 233, term: 'きょうだい論点その二', questionCount: 5 },
    ]
    stubApi({ body: { siblings, questions: manyQuestions(1) } })
    await draw()
    for (const s of siblings) {
      expect(text(), `他の論点「${s.term}」が出ていない`).toContain(s.term)
      expect(hrefs(), `他の論点「${s.term}」への行き先が無い`).toContain(`/topics/${s.id}`)
    }
  })

  // @covers REQ-024#transcript-only
  it('図の画像が無い過去問では、書き起こしを畳まずに本体として示す', async () => {
    stubApi({
      body: {
        questions: [
          question(1, { hasFigure: 1, figureImage: null, figureDescription: '画像の無い図の書き起こしです。' }),
          question(2),
        ],
      },
    })
    await draw()
    expect(text()).toContain('画像の無い図の書き起こしです。')
    expect(container.querySelectorAll('img'), '無いはずの図の画像が出ている').toHaveLength(0)
    expect(buttons().some((b) => /図の説明/.test(b.textContent ?? '')), '書き起こしを開く手段が出ている（本体にする）').toBe(
      false,
    )
  })

  // @covers REQ-025#unclosed-markup
  it('閉じていない囲みを含む書き起こしでも、示すことを中断せず、中身を書かれた文字のまま示す', async () => {
    const transcript = ['前置きの文です。', '```', '閉じない囲みの中の文字', '囲みの後の文字'].join('\n')
    stubApi({
      body: {
        questions: [question(1, { hasFigure: 1, figureImage: null, figureDescription: transcript }), question(2)],
      },
    })
    await draw()
    expect(text()).toContain('前置きの文です。')
    expect(text()).toContain('閉じない囲みの中の文字')
    expect(text()).toContain('囲みの後の文字')
    // 示すことを中断していない（後ろの過去問も出る）
    expect(text()).toContain('過去問 1 の本文です。')
    expect(text()).toContain('過去問 2 の本文です。')
  })

  // @covers REQ-032#fewer-than-limit
  it('決めた件数以下しか紐づかない論点では全部を最初から示し、残りを開く手段を出さない', async () => {
    // 決めた件数は、多い入力で最初に示された数として観測する
    const many = manyQuestions(8)
    stubApi({ body: { questions: many } })
    await draw()
    const limit = many.filter((q) => text().includes(q.text)).length
    expect(limit, '多い入力で全部が出ている（決めた件数が観測できない）').toBeLessThan(many.length)
    const rest = buttons().find((b) => new RegExp(`${many.length - limit}\\s*問`).test(b.textContent ?? ''))
    expect(rest, '残りを開く手段が無い（決めた件数の手段が観測できない）').toBeTruthy()
    const restPattern = new RegExp(
      (rest!.textContent ?? '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+'),
    )
    // 境界: ちょうど決めた件数
    for (const count of [limit, 1]) {
      const few = manyQuestions(count)
      stubApi({ body: { questions: few } })
      await draw()
      for (const q of few) expect(text(), `${count} 問のとき「${q.text}」が最初から出ていない`).toContain(q.text)
      expect(
        buttons().some((b) => restPattern.test(b.textContent ?? '')),
        `${count} 問のとき残りを開く手段（${rest!.textContent}）が出ている`,
      ).toBe(false)
      expect(buttons().some((b) => /(^|\D)0\s*問/.test(b.textContent ?? '')), '残り 0 問の手段が出ている').toBe(false)
    }
  })
})
