// @vitest-environment jsdom
/** 前回の続きの導線から開いた論点が取れなかったとき（UC-005・UC-002）。
 *  ホームの導線を選んでから、論点の画面と単元の一覧までを本物の App で描く
 *  （どこで行き先を決めるかを仕様にしないため、経路を差し替えない）。
 *  サーバの応答は fetch を偽物にして与える（形は UC-002 の契約の getTopicDetail・listCategories、
 *  UC-003 の契約の getHomeSummary。断りの本文は共有語彙の ErrorBody）。
 *  端末に置く値は鍵の名前に頼らずに見る（鍵の名前は仕様ではない）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom'
import { App } from '../../src/client/App'
import { getLastTopic, invalidateCached, setLastTopic, setToken } from '../../src/client/lib/api'

/** 端末に覚えさせる前回の続き（契約 LastTopic の 4 項目）。単元は一覧の単元と別の名前にする。 */
const REMEMBERED = { id: 777, term: '前回開いた論点', middle: '事業の指標', middleNo: 4 }

/** 論点の取得の断りの本文。論点の画面がこの文字を示したら「取れなかったことを示した」と見る。 */
const NOT_FOUND_BODY = 'サーバが返した見つからない旨の本文'
const FAILED_BODY = 'サーバが返した取得の失敗の本文'

/** 単元の一覧に並ぶ単元（覚えた単元とは別の名前）。 */
const CATEGORIES = {
  categories: [
    { middleNo: 1, middle: '企業活動', major: '企業と法務', field: 'ストラテジ系', topics: 3, questions: 15, understood: 1 },
    { middleNo: 11, middle: 'セキュリティ', major: '技術要素', field: 'テクノロジ系', topics: 1, questions: 7, understood: 0 },
  ],
}

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 2, understood: 0, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 3, longest: 3, total: 3 },
}

/** 覚えた論点の取得の応え方。gone は 404（契約の NOT_FOUND）、failed は 500。 */
function stubApi(topic: 'gone' | 'failed') {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    if (p.endsWith(`/topics/${REMEMBERED.id}`)) {
      return topic === 'gone'
        ? { ok: false, status: 404, text: async () => JSON.stringify({ error: NOT_FOUND_BODY }) }
        : { ok: false, status: 500, text: async () => JSON.stringify({ error: FAILED_BODY }) }
    }
    let body: unknown = {}
    if (p.includes('version.json')) body = { build: 'abc1234', at: '2026-09-28T00:00:00Z' }
    else if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://manabiba.example', app: 'ip' }
    else if (p.endsWith('/topics')) body = { topics: [] }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = CATEGORIES
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
const anchors = () => [...host.querySelectorAll('a')]

/** 要素の文字と、読み上げ用の属性（aria-label・title）を合わせた文字。 */
function blockText(el: Element): string {
  const labels = [el, ...el.querySelectorAll('[aria-label], [title]')]
    .map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`)
    .join(' ')
  return `${el.textContent ?? ''} ${labels}`
}

/** 端末の中で needle を含む値を持つ鍵（鍵の名前を仕様にしないための探し方）。 */
function keyHolding(s: Storage, needle: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)!
    if ((s.getItem(k) ?? '').includes(needle)) return k
  }
  return null
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 画面の外から履歴を動かす口（戻る・別の論点を直に開く）。 */
let navigate: NavigateFunction | null = null
function HistoryProbe() {
  navigate = useNavigate()
  return null
}

/** 資格版の App を entry から描く（毎回根を作り直す）。 */
async function open(entry: string) {
  await close()
  invalidateCached()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.history.replaceState({}, '', entry)
  await act(async () => {
    root!.render(h(MemoryRouter, { initialEntries: [entry] }, h(App), h(HistoryProbe)))
  })
  await settle()
}
async function close() {
  if (root) {
    await act(async () => root!.unmount())
    host.remove()
    root = null
  }
}

/** ホームを開いて、前回の続きの導線を選ぶ。 */
async function followResumeLink() {
  setLastTopic(REMEMBERED)
  await open('/')
  const link = anchors().find((a) => a.getAttribute('href') === `/topics/${REMEMBERED.id}`)
  if (!link) throw new Error('ホームに前回の続きの導線が無い')
  await act(async () => {
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

/** 単元の一覧が開いている（一覧の単元がどちらも示されている）。 */
const unitListOpen = () => CATEGORIES.categories.every((c) => text().includes(c.middle))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  setToken('token-for-test')
})

afterEach(async () => {
  await close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('前回の続きの論点がもう無い（UC-005）', () => {
  // @covers REQ-342#gone-via-resume-link
  it('覚えた論点がもう無いときに導線を選ぶと、論点の画面に取れなかったことを示さず、単元の一覧が開く', async () => {
    stubApi('gone')
    await followResumeLink()
    expect(unitListOpen(), '単元の一覧が開いていない').toBe(true)
    expect(text(), '論点の画面に取れなかったことを示している').not.toContain(NOT_FOUND_BODY)
  })

  // @covers REQ-342#gone-via-resume-link
  it('覚えた論点がもう無いときに導線を選ぶと、開いた単元の一覧で前回の続きの論点が見つからないことを示す', async () => {
    stubApi('gone')
    await followResumeLink()
    const notice = [...host.querySelectorAll<HTMLElement>('*')]
      .filter((el) => {
        const t = blockText(el)
        return /前回の続き|前回開いた論点/.test(t) && /見つか|ありません|無くな|なくな|削除/.test(t)
      })
      .sort((a, b) => blockText(a).length - blockText(b).length)[0]
    expect(notice, '前回の続きの論点が見つからないことが示されていない').toBeTruthy()
    expect(blockText(notice!).length, '見つからない旨が、知らせではなく画面全体にしか見つからない').toBeLessThan(120)
    expect(unitListOpen(), '知らせを出した画面が単元の一覧でない').toBe(true)
  })

  // @covers REQ-342#gone-via-resume-link
  it('覚えた論点がもう無いときに導線を選ぶと、端末が覚えた前回の続きを捨て、開き直したホームに導線が出ない', async () => {
    stubApi('gone')
    await followResumeLink()
    expect(getLastTopic(), '覚えた前回の続きが捨てられていない').toBeNull()
    expect(keyHolding(localStorage, REMEMBERED.term), '端末に覚えた論点の値が残っている').toBeNull()
    await open('/')
    expect(text(), '開き直したホームにまだ前回の続きが出ている').not.toContain(REMEMBERED.term)
    expect(anchors().some((a) => a.getAttribute('href') === `/topics/${REMEMBERED.id}`)).toBe(false)
  })
})

describe('前回の続きの導線から開いて取れなかった（UC-002）', () => {
  // @covers REQ-033#detail-fetch-failed
  it('導線から開いた論点の取得が見つからない以外の理由で失敗したときは、単元の一覧へ移さず、取れなかったことと取り直す手段を示す', async () => {
    stubApi('failed')
    await followResumeLink()
    expect(text(), '取れなかったことが示されていない').toContain(FAILED_BODY)
    expect(text()).not.toContain('読み込み中')
    expect(unitListOpen(), '見つからないのではないのに単元の一覧へ移っている').toBe(false)
    const retry = [...host.querySelectorAll<HTMLElement>('button, a, [role="button"]')].find((el) =>
      /再読み込み|もう一度|取り直|再試行|やり直|再取得/.test(blockText(el)),
    )
    expect(retry, '取り直す手段が添えられていない').toBeTruthy()
  })
})

/** 論点の教材（契約 getTopicDetail の 200 の形）。 */
const detailOf = (id: number, term: string) => ({
  topic: {
    id,
    term,
    explanation: `${term} の短い説明です。`,
    detail: null,
    questionCount: 0,
    isNew: 0,
    status: null,
    field: 'ストラテジ系',
    major: '企業と法務',
    middle: REMEMBERED.middle,
    middleNo: REMEMBERED.middleNo,
    itemName: '会計と財務',
    syllabusItemId: 3,
  },
  questions: [],
  siblings: [],
  nextTopic: null,
  neighbors: { prev: null, next: null },
})

/** 導線から開いたあとに別に開く論点（今もある）。 */
const LATER = { id: 778, term: 'あとで開いた論点' }

describe('前回の続きの導線から開いた履歴へ戻って取れなかった（UC-002）', () => {
  // @covers REQ-033#detail-fetch-failed
  it('導線から開いたあと別の論点を開き、履歴で戻った論点が見つからないときは、単元の一覧へ移さず、取り直す手段を示し、あとで開いた論点の記憶を捨てない', async () => {
    let rememberedGone = false
    stubApi('gone')
    const gone = globalThis.fetch as unknown as (raw: string) => Promise<unknown>
    vi.stubGlobal('fetch', async (raw: string) => {
      const p = new URL(String(raw), 'http://localhost').pathname
      if (p.endsWith(`/topics/${REMEMBERED.id}`) && !rememberedGone) {
        const body = detailOf(REMEMBERED.id, REMEMBERED.term)
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
      }
      if (p.endsWith(`/topics/${LATER.id}`)) {
        const body = detailOf(LATER.id, LATER.term)
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
      }
      return gone(raw)
    })
    await followResumeLink()
    expect(text(), '導線から開いた論点が開いていない（この検査は空振りになる）').toContain(`${REMEMBERED.term} の短い説明です。`)

    await act(async () => navigate!(`/topics/${LATER.id}`))
    await settle()
    expect(text(), 'あとの論点が開いていない（この検査は空振りになる）').toContain(`${LATER.term} の短い説明です。`)
    expect(getLastTopic()?.id, 'あとで開いた論点を前回の続きに覚えていない（この検査は空振りになる）').toBe(LATER.id)

    rememberedGone = true
    await act(async () => navigate!(-1))
    await settle()
    expect(text(), '履歴で戻った論点で取れなかったことが示されていない').toContain(NOT_FOUND_BODY)
    expect(unitListOpen(), '導線を選んでいないのに単元の一覧へ移っている').toBe(false)
    const retry = [...host.querySelectorAll<HTMLElement>('button, a, [role="button"]')].find((el) =>
      /再読み込み|もう一度|取り直|再試行|やり直|再取得/.test(blockText(el)),
    )
    expect(retry, '取り直す手段が添えられていない').toBeTruthy()
    expect(getLastTopic()?.id, 'あとで開いた論点の前回の続きを捨てている').toBe(LATER.id)
  })
})
