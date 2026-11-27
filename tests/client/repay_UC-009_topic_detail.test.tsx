// @vitest-environment jsdom
/** ロードマップ型の論点の画面（src/client/pages/TopicDetail.tsx）の、UC-009 の未返済の分割クラス。
 *  日で束ねる学び（itc）で描く。対象は読み込み時に決まる（VITE_EXAM）ので、描くたびに読み込み直す。
 *  ロードマップ型ではロードマップが `/topics` に載る。
 *
 *  サーバの応答は fetch を偽物にして与える（形は UC-002 の契約 getTopicDetail の response）。
 *  確認問題は自前に作った問題で、過去問ではない（用語集）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Over = Record<string, unknown>

/** 確認問題。citation は契約上の必須の文字列なので、画面に出れば読める値を入れておく。 */
const CITATION = 'どこかの回 問1'

const question = (n: number, over: Over = {}) => ({
  id: `itc-u231-q${n}`,
  number: n,
  examLabel: 'どこかの回',
  text: `確認問題 ${n} の本文です。`,
  choices: { ア: `${n} のア`, イ: `${n} のイ`, ウ: `${n} のウ`, エ: `${n} のエ` },
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: CITATION,
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

const detail = (over: Over = {}) => ({
  topic: {
    id: 231,
    term: '単位 231 の名前',
    explanation: '短い説明の本文です。',
    detail: '詳しい解説の本文です。',
    questionCount: 2,
    isNew: 0,
    status: 1,
    field: '業界と仕事',
    major: '業界と仕事',
    middle: 'コンサルの仕事',
    middleNo: 1,
    itemName: 'コンサルの仕事',
    syllabusItemId: 1,
    tier: null,
  },
  questions: [question(1), question(2)],
  siblings: [],
  nextTopic: null,
  neighbors: { prev: { id: 230, term: '前の単位の名前' }, next: { id: 232, term: '次の単位の名前' } },
  ...over,
})

/** 応答を決める偽の fetch。 */
function stubApi(body: Over = {}) {
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    if ((init?.method ?? 'GET') === 'PUT')
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    if (url.pathname.endsWith('/glossary'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: [] }) }
    if (/\/topics\/\d+$/.test(url.pathname))
      return { ok: true, status: 200, text: async () => JSON.stringify(detail(body)) }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) }
  })
}

/** VITE_EXAM をロードマップ型の対象（itc）にしてから読み込み、論点の画面を描く。 */
async function drawTopic() {
  vi.stubEnv('VITE_EXAM', 'itc')
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter, Route, Routes, useLocation } = await import('react-router-dom')
  const { TopicDetail } = await import('../../src/client/pages/TopicDetail')
  const h = React.createElement
  // 今いる場所を読むための印。画面の作りには触らない
  const Where = () => h('span', null, `PATH:${useLocation().pathname}|`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/topics/231'] },
        h(
          'div',
          null,
          h(Where),
          h(
            Routes,
            null,
            h(Route, { path: '/topics/:id', element: h(TopicDetail) }),
            h(Route, { path: '/topics', element: h('div', null, 'ロードマップの画面') }),
          ),
        ),
      ),
    )
  })
  const text = () => host.textContent ?? ''
  const links = () => [...host.querySelectorAll('a')]
  return {
    text,
    links,
    path: () => (text().match(/PATH:([^|]*)\|/) ?? [])[1] ?? '',
    clickEl: async (el: HTMLElement) => {
      await React.act(async () => {
        el.click()
      })
    },
    close: async () => {
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('ロードマップ型の論点の教材と確認問題（UC-009）', () => {
  // @covers REQ-137#material-and-questions-shown
  it('開いた単位の教材と、その単位の確認問題（本文と選択肢）を出す', async () => {
    stubApi()
    const v = await drawTopic()
    expect(v.text()).toContain('単位 231 の名前')
    expect(v.text(), '教材が出ていない').toContain('短い説明の本文です。')
    expect(v.text(), '確認問題の本文が出ていない').toContain('確認問題 1 の本文です。')
    expect(v.text(), '確認問題の選択肢が出ていない').toContain('1 のア')
    await v.close()
  })

  // @covers REQ-137#own-questions-without-source
  it('自前に作った確認問題には出典を出さない', async () => {
    stubApi()
    const v = await drawTopic()
    expect(v.text(), '描けていない（この検査は空振りになる）').toContain('確認問題 1 の本文です。')
    expect(v.text(), '確認問題に出典が付いている').not.toContain('出典')
    expect(v.text(), '確認問題に出典の値が出ている').not.toContain(CITATION)
    await v.close()
  })
})

describe('学ぶ順の前後の導線（UC-009）', () => {
  // @covers REQ-140#both-sides-missing-disabled
  it('学ぶ順を持たない補足の単位では、前後どちらの導線も押せない形で残す', async () => {
    stubApi({ neighbors: { prev: null, next: null } })
    const v = await drawTopic()
    expect(v.text(), '描けていない（この検査は空振りになる）').toContain('短い説明の本文です。')
    // 導線そのものは消さない
    expect(v.text(), '前の向きの導線が消えている').toContain('前の単位')
    expect(v.text(), '次の向きの導線が消えている').toContain('次の単位')
    // どちらも押せる要素になっていない
    expect(v.links().some((a) => /前の単位|次の単位/.test(a.textContent ?? '')), '相手が無い向きが押せる形で残っている').toBe(
      false,
    )
    await v.close()
  })
})

describe('ロードマップへ戻る（UC-009）', () => {
  // @covers REQ-141#back-to-roadmap
  it('戻る導線を選ぶと、ロードマップが出る', async () => {
    stubApi()
    const v = await drawTopic()
    const back = v.links().find((a) => /ロードマップ/.test(a.textContent ?? '') && /戻る/.test(a.textContent ?? ''))
    expect(back, 'ロードマップへ戻る導線が無い').toBeTruthy()
    await v.clickEl(back!)
    expect(v.path(), '戻る導線を選んでもロードマップへ移っていない').toBe('/topics')
    expect(v.text()).toContain('ロードマップの画面')
    await v.close()
  })
})
