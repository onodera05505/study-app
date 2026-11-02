// @vitest-environment jsdom
/** ロードマップの画面（src/client/pages/Roadmap.tsx）の、UC-009 の未返済の分割クラス。
 *  日で束ねる学び（itc）で描く。対象は読み込み時に決まる（VITE_EXAM）ので、描くたびに読み込み直す。
 *  ロードマップ型ではロードマップが `/topics` に載る。
 *
 *  論点の並びは UC-002 の契約 listTopics の形、回ごとの確認の一覧は UC-008 の listExams、
 *  連続記録は UC-003 の /api/me、前回の続きの端末の記憶は UC-005（書き込みの 1 か所 setLastTopic）。
 *  理解度は 1=未理解・2=やや理解・3=理解、記録なしは null。
 *  「開き直す」は、同じ経路の上で単位の画面へ移ってロードマップへ戻ることで表す。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLastTopic } from '../../src/client/lib/api'

type Unit = Record<string, unknown>

/** 日で束ねる学び（itc）の単位。属する回は学ぶ順と 1 日 3 単位から決まる回と一致させる（BR-037）。 */
const unit = (n: number, status: number | null): Unit => {
  const day = Math.ceil(n / 3)
  return {
    id: 100 + n,
    term: `単位 ${n} の名前`,
    questionCount: 2,
    status,
    field: '業界と仕事',
    middle: 'コンサルの仕事',
    itemName: 'コンサルの仕事',
    isNew: 0,
    sortOrder: n,
    round: `itc-d0${day}`,
    roundLabel: `${day} 日目`,
    tier: null,
  }
}

/** 7 単位。1〜4 が理解。学ぶ順で最初の未理解は 5 番。 */
const UNITS: Unit[] = [unit(1, 3), unit(2, 3), unit(3, 3), unit(4, 3), unit(5, 1), unit(6, null), unit(7, 2)]

const EXAMS = {
  exams: [
    { exam: 'itc-d01', examLabel: '1 日目', questions: 6, attempts: 2, bestScore: 5 },
    { exam: 'itc-d02', examLabel: '2 日目', questions: 6, attempts: 0, bestScore: null },
    { exam: 'itc-d03', examLabel: '3 日目', questions: 6, attempts: 0, bestScore: null },
  ],
}

const STREAK = 13

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 7, understood: 4, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: STREAK, longest: STREAK, total: STREAK },
}

/** 論点が無い旨の文（BR-015 が取得前に出すことを禁じる種類の文）。 */
const NO_UNITS_NOTICE = /(単位|論点)(は|が)?(ありません|無い|見つかりません)|該当(する[^。]*)?(ありません|なし)/

let calls: Array<{ url: string; method: string }>

/** 応答を決める偽の fetch。units は参照で持ち、テストの途中で差し替えると次の取得から効く。
 *  pending に入れた経路は応答を返さない（取得していないあいだ、を作る）。 */
function stubApi(opts: { units?: Unit[]; pending?: string[] } = {}) {
  calls = []
  const state = { units: opts.units ?? UNITS }
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = init?.method ?? 'GET'
    calls.push({ url: url.pathname + url.search, method })
    if ((opts.pending ?? []).some((p) => url.pathname.endsWith(p))) return new Promise(() => {})
    let body: unknown = {}
    if (url.pathname.endsWith('/topics')) body = { topics: state.units }
    else if (url.pathname.endsWith('/exams')) body = EXAMS
    else if (url.pathname.endsWith('/me')) body = ME
    else if (url.pathname.endsWith('/sessions/current')) body = { session: null }
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
  return state
}

const countOf = (part: string, method = 'GET') =>
  calls.filter((c) => c.url.includes(part) && c.method === method).length

/** VITE_EXAM をロードマップ型の対象（itc）にしてから読み込み、描いた画面を返す。
 *  単位の画面の代わりは、ロードマップへ戻る導線だけを持つ（開き直しの操作のため）。 */
async function drawRoadmap() {
  vi.stubEnv('VITE_EXAM', 'itc')
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter, Route, Routes, Link, useLocation, useParams } = await import('react-router-dom')
  const { Roadmap } = await import('../../src/client/pages/Roadmap')
  const h = React.createElement
  // 今いる場所を読むための印。画面の作りには触らない
  const Where = () => h('span', null, `PATH:${useLocation().pathname}|`)
  const UnitStub = () => h('div', null, `単位の画面 ${useParams().id}`, h(Link, { to: '/topics' }, '代わりの戻り'))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/topics'] },
        h(
          'div',
          null,
          h(Where),
          h(
            Routes,
            null,
            h(Route, { path: '/topics', element: h(Roadmap) }),
            h(Route, { path: '/topics/:id', element: h(UnitStub) }),
          ),
        ),
      ),
    )
  })
  const text = () => host.textContent ?? ''
  const links = () => [...host.querySelectorAll('a')]
  const clickEl = async (el: HTMLElement) => {
    await React.act(async () => {
      el.click()
    })
  }
  return {
    text,
    links,
    path: () => (text().match(/PATH:([^|]*)\|/) ?? [])[1] ?? '',
    /** 一覧の中の「ここから」の印（単位の行に付くもの）。 */
    hereRows: () =>
      links()
        .filter((a) => /^\/topics\/\d+$/.test(a.getAttribute('href') ?? '') && !/ここから（|前回の続き/.test(a.textContent ?? ''))
        .map((a) => a.closest('li, tr, [role="listitem"]') ?? a)
        .filter((row) => (row.textContent ?? '').includes('ここから'))
        .map((row) => row.querySelector('a')?.getAttribute('href') ?? ''),
    /** 単位の画面へ移ってからロードマップへ戻る（ロードマップを開き直す）。 */
    reopen: async (unitId: number) => {
      const go = links().find((a) => a.getAttribute('href') === `/topics/${unitId}`)
      if (!go) throw new Error(`単位 ${unitId} への導線が画面に無い`)
      await clickEl(go)
      if (!text().includes(`単位の画面 ${unitId}`)) throw new Error('単位の画面へ移れていない')
      const back = links().find((a) => a.textContent === '代わりの戻り')
      await clickEl(back!)
    },
    clickEl,
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

describe('並びの取得前と空の区別（UC-009）', () => {
  // @covers REQ-126#fetching
  it('並びをまだ取得していないあいだは、単位が無い旨を出さない', async () => {
    stubApi({ pending: ['/topics'] })
    const v = await drawRoadmap()
    expect(countOf('/topics'), '並びを取りに行っていない（この検査は空振りになる）').toBeGreaterThan(0)
    expect(v.text(), '取得前なのに単位が無い旨が出ている').not.toMatch(NO_UNITS_NOTICE)
    await v.close()
  })

  // @covers REQ-126#fetched-empty
  it('取得できて結果が空のときだけ、単位が無い旨を出す', async () => {
    stubApi({ units: [] })
    const v = await drawRoadmap()
    expect(v.text(), '結果が空なのに単位が無い旨が出ない').toMatch(NO_UNITS_NOTICE)
    expect(v.text()).not.toContain('読み込み中')
    await v.close()
  })
})

describe('開くたびに取り直す（UC-009）', () => {
  // @covers REQ-127#reopen-refetches
  it('単位の画面から戻って 2 度目に開いたときも、並びを取りに行く', async () => {
    stubApi()
    const v = await drawRoadmap()
    const first = countOf('/topics')
    expect(first, '最初の取得が無い（この検査は空振りになる）').toBeGreaterThan(0)
    await v.reopen(105)
    expect(v.text()).toContain('単位 1 の名前')
    expect(countOf('/topics'), '開き直したのに前の並びを使い回している').toBeGreaterThan(first)
    await v.close()
  })

  // @covers REQ-127#reflects-latest-status
  it('別の画面で理解度が変わった直後に開くと、その理解度で「ここから」と理解した数が出る', async () => {
    const state = stubApi()
    const v = await drawRoadmap()
    expect(v.hereRows(), '最初の「ここから」が 5 番でない（この検査は空振りになる）').toEqual(['/topics/105'])
    // 単位の画面で 5 番を理解にした、という状態をサーバ側に作る
    state.units = UNITS.map((u) => (u.id === 105 ? { ...u, status: 3 } : u))
    await v.reopen(105)
    expect(v.hereRows(), '開き直したのに「ここから」が前の理解度のまま').toEqual(['/topics/106'])
    expect(v.text()).toMatch(/理解\s*5\s*\/\s*7/)
    await v.close()
  })
})

describe('先頭の連続記録（UC-009）', () => {
  // @covers REQ-132#streak-shown
  it('連続記録を、単位の並びより前（先頭）に出す', async () => {
    stubApi()
    const v = await drawRoadmap()
    const body = v.text()
    const at = body.search(new RegExp(`連続\\s*${STREAK}\\s*日`))
    expect(at, `連続記録（${STREAK} 日）が出ていない`).toBeGreaterThanOrEqual(0)
    expect(at, '連続記録が単位の並びより後ろにある').toBeLessThan(body.indexOf('単位 1 の名前'))
    await v.close()
  })
})

describe('先頭の続きの導線（UC-009）', () => {
  // @covers REQ-145#follows-continue-link
  it('先頭の続きの導線を選ぶと、その行き先の単位の画面へ移る', async () => {
    stubApi()
    setLastTopic({ id: 103, term: '単位 3 の名前', middle: 'コンサルの仕事', middleNo: 1 })
    const v = await drawRoadmap()
    const go = v.links().find((a) => /前回の続きから/.test(a.textContent ?? ''))
    expect(go, '先頭に続きの導線が無い（この検査は空振りになる）').toBeTruthy()
    const to = go!.getAttribute('href')
    expect(to, '行き先が宣言されていない（この検査は空振りになる）').toMatch(/^\/topics\/\d+$/)
    await v.clickEl(go!)
    expect(v.path(), '導線が示す行き先へ移っていない').toBe(to)
    expect(v.text()).toContain('単位の画面 103')
    await v.close()
  })
})
