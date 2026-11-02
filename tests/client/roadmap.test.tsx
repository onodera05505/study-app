// @vitest-environment jsdom
/** ロードマップの画面（src/client/pages/Roadmap.tsx）。ロードマップ型の対象で描く。UC-009
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、テストごとに差し替えて読み込み直す。
 *  ロードマップ型ではロードマップが `/topics` に載る（`/roadmap` という経路は無い）。
 *  日で束ねる学びの手本は itc（1 日 3 単位・1 回 6 問）、章で束ねて印を持つ学びの手本は eng。
 *  どちらの値も登録簿 src/shared/targets.json が正本で、印の段の語はここから読む。
 *  論点の並びの項目は UC-002 の契約 listTopics の形（round・roundLabel・tier を含む）。
 *  理解度は 1=未理解・2=やや理解・3=理解、記録なしは null。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import targets from '../../src/shared/targets.json'
import { setLastTopic } from '../../src/client/lib/api'

type Unit = Record<string, unknown>
type Target = 'itc' | 'eng'

/** 登録簿の印の段（eng）。段ごとの語は登録簿だけが持つ。 */
const TIERS = (
  targets as unknown as { eng: { roadmapSpec: { tiers: { level: number; label: string }[] } } }
).eng.roadmapSpec.tiers
const tierLabel = (level: number) => {
  const t = TIERS.find((x) => x.level === level)
  if (!t) throw new Error(`登録簿に印の段 ${level} が無い`)
  return t.label
}

/** 日で束ねる学び（itc）の単位。属する回は学ぶ順と 1 日 3 単位から決まる回と一致させる（BR-037）。 */
const unit = (n: number, status: number | null) => {
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

/** 7 単位。1〜4 が理解（status 3）。1 日 3 単位なので 1 日目は全部理解、
 *  いま学ぶ位置（status が 3 でない最初の単位）は 5 番。3 日目は 1 単位だけの最後の日。 */
const UNITS: Unit[] = [
  unit(1, 3),
  unit(2, 3),
  unit(3, 3),
  unit(4, 3),
  unit(5, 1),
  unit(6, null),
  unit(7, 2),
]

const EXTRA: Unit = {
  id: 200,
  term: '補足の単位の名前',
  questionCount: 2,
  status: null,
  field: '補足（ロードマップ外）',
  middle: 'ロードマップ外',
  itemName: 'ロードマップ外',
  isNew: 0,
  sortOrder: null,
  round: 'itc-ex',
  roundLabel: '補足（ロードマップ外）',
  tier: null,
}

/** 学ぶ順を持たず補足でもない単位（回を持たない。契約の round は null）。 */
const unordered = (id: number, term: string): Unit => ({
  id,
  term,
  questionCount: 2,
  status: null,
  field: '業界と仕事',
  middle: 'コンサルの仕事',
  itemName: 'コンサルの仕事',
  isNew: 0,
  sortOrder: null,
  round: null,
  roundLabel: null,
  tier: null,
})

const EXAMS = {
  exams: [
    { exam: 'itc-d01', examLabel: '1 日目', questions: 6, attempts: 2, bestScore: 5 },
    { exam: 'itc-d02', examLabel: '2 日目', questions: 6, attempts: 0, bestScore: null },
    { exam: 'itc-d03', examLabel: '3 日目', questions: 6, attempts: 0, bestScore: null },
  ],
}

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 7, understood: 4, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 13, longest: 13, total: 13 },
}

/** 章で束ねて印を持つ学び（eng）の章。章ごとに単位の数が違う（2・4・1）。
 *  章の名前には数字を入れない（画面に出る数値の断言とぶつからないように）。 */
const CHAPTERS = [
  { round: 'eng-c01', no: 1, name: '甲の章' },
  { round: 'eng-c02', no: 2, name: '乙の章' },
  { round: 'eng-c03', no: 3, name: '丙の章' },
]

/** 章の単位。回のラベルは章の名前だけ（番号は登録簿の回の見出しの語が付ける）。
 *  1 単位の確認問題は 1 問にして、行に問数が出ても回ごとの確認の問数（4・8・2）とぶつけない。 */
const chapterUnit = (id: number, sortOrder: number, chapter: number, tier: number, status: number | null): Unit => {
  const c = CHAPTERS[chapter - 1]
  return {
    id,
    term: `章の単位 ${id}`,
    questionCount: 1,
    status,
    field: 'コンピュータの仕組み',
    middle: 'コンピュータの仕組み',
    itemName: 'コンピュータの仕組み',
    isNew: 0,
    sortOrder,
    round: c.round,
    roundLabel: c.name,
    tier,
  }
}

/** eng の単位。第 1 章は全部理解。第 2 章は印が学ぶ順と無関係に混ざる（1・3・2・1）。
 *  第 3 章は印 1 の単位だけ。学ぶ順で最初の未理解は 303（印 1）、印 1 を外したときの最初の未理解は 304。
 *  印 2 の単位（305）は理解。 */
const ENG_UNITS: Unit[] = [
  chapterUnit(301, 1, 1, 3, 3),
  chapterUnit(302, 2, 1, 1, 3),
  chapterUnit(303, 3, 2, 1, 1),
  chapterUnit(304, 4, 2, 3, null),
  chapterUnit(305, 5, 2, 2, 3),
  chapterUnit(306, 6, 2, 1, 2),
  chapterUnit(307, 7, 3, 1, 1),
]

/** eng の補足の単位（印 1）。補足の回は登録簿の extraRoundId。 */
const ENG_EXTRA: Unit = {
  id: 400,
  term: '章の補足の単位',
  questionCount: 1,
  status: null,
  field: '補足（ロードマップ外）',
  middle: 'ロードマップ外',
  itemName: 'ロードマップ外',
  isNew: 0,
  sortOrder: null,
  round: 'eng-ex',
  roundLabel: '補足（ロードマップ外）',
  tier: 1,
}

const ENG_EXAMS = {
  exams: [
    { exam: 'eng-c01', examLabel: '第 1 章 甲の章', questions: 4, attempts: 1, bestScore: 3 },
    { exam: 'eng-c02', examLabel: '第 2 章 乙の章', questions: 8, attempts: 0, bestScore: null },
    { exam: 'eng-c03', examLabel: '第 3 章 丙の章', questions: 2, attempts: 0, bestScore: null },
  ],
}

const ENG_ME = { ...ME, topics: { total: 8, understood: 3, partly: 1 } }

/** 回の見出しの、日の形と章の形（登録簿の語の形。REQ-279）。 */
const DAY_HEADINGS = ['1 日目', '2 日目', '3 日目']
const CHAPTER_HEADINGS = CHAPTERS.map((c) => `第 ${c.no} 章`)

let calls: Array<{ url: string; method: string; body: unknown }>

/** 進行中のテスト。UC-006 の契約 getCurrentSession の例 okInProgress の形（回答済みの answered を含む）。
 *  範囲は押した日（1 日目）とわざと違えてあり、案内の範囲がこの進行中のテストから採られていることを見る。 */
const IN_PROGRESS = {
  id: 's-7',
  userId: 'u-1',
  kind: 'drill',
  status: 'in_progress',
  sourceExam: null,
  scopeLabel: '論点: RAID',
  timeLimitSec: null,
  questionCount: 12,
  correctCount: null,
  startedAt: 1759276800,
  finishedAt: null,
  answered: 4,
}

/** UC-008 の契約 startMockExam の CONFLICT（409）の本文。失敗の本文は共有語彙の ErrorBody だけで
 *  （additionalProperties: false）、進行中のテストの行は載らない。範囲と進み具合は UC-006 の
 *  getCurrentSession で取り直す。error の文は仕様が決めていないので契約のエラーコードを置く。 */
const CONFLICT_BODY = { error: 'CONFLICT' }

/** 日の見出し（EXAMS の examLabel と同じ順）。案内がどの日のそばに出たかを読むのに使う。 */
const DAY_LABELS = EXAMS.exams.map((e) => e.examLabel)

/** 取れなかったときにサーバが返す ErrorBody の文（経路ごと）。画面はこれを理由として示せる。 */
const FAIL_TEXT: Record<string, string> = {
  '/topics': '単位の一覧を取得できませんでした',
  '/sessions/current': '進行中のテストを確認できませんでした',
}

/** 応答を決める偽の fetch。fail に入れた path は 500（本文は FAIL_TEXT の理由）。
 *  target で既定の並び・回ごとの確認・本人の記録を選ぶ（units・exams で差し替えられる）。
 *  inProgress を立てると「進行中のテストが 1 つある」サーバになり、作成は 409、
 *  進行中の問い合わせはその行を返す。破棄（DELETE）が通ったあとは進行中が無い状態へ移る。
 *  startFails は進行中の有無以外の理由で作成を断る側（REQ-276）。'network' は通信そのものが届かない。
 *  返り値の recover() で fail を解き、取り直しが成功する状態へ移せる。 */
function stubApi(
  opts: {
    target?: Target
    units?: Unit[]
    exams?: typeof EXAMS
    fail?: string[]
    inProgress?: boolean
    gone?: boolean
    startFails?: 'network' | { status: number; error: string }
  } = {},
) {
  calls = []
  const eng = opts.target === 'eng'
  let discarded = false
  let raced = opts.gone === true
  let failing = [...(opts.fail ?? [])]
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = init?.method ?? 'GET'
    let sent: unknown = null
    if (typeof init?.body === 'string') {
      try {
        sent = JSON.parse(init.body)
      } catch {
        sent = init.body
      }
    }
    calls.push({ url: url.pathname + url.search, method, body: sent })
    const failed = failing.find((f) => url.pathname.endsWith(f))
    if (failed !== undefined)
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: FAIL_TEXT[failed] ?? '取得できませんでした' }),
      }
    const inProgress = opts.inProgress === true && !discarded
    if (method === 'DELETE' && url.pathname.endsWith('/sessions/current')) {
      discarded = true
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    }
    if (method === 'POST' && url.pathname.endsWith('/sessions')) {
      if (inProgress)
        return { ok: false, status: 409, text: async () => JSON.stringify(CONFLICT_BODY) }
      if (raced) {
        // 競合: この 1 回だけ進行中があるとして断る。取り直すともう無い（進行中の問い合わせは null）
        raced = false
        return { ok: false, status: 409, text: async () => JSON.stringify(CONFLICT_BODY) }
      }
      if (opts.startFails === 'network') throw new TypeError('Failed to fetch')
      if (opts.startFails)
        return {
          ok: false,
          status: opts.startFails.status,
          text: async () => JSON.stringify({ error: (opts.startFails as { error: string }).error }),
        }
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({ id: 's-new', kind: 'mock', scopeLabel: '2 日目', questionCount: 6, timeLimitSec: null }),
      }
    }
    let body: unknown = {}
    if (url.pathname.endsWith('/topics')) body = { topics: opts.units ?? (eng ? ENG_UNITS : UNITS) }
    else if (url.pathname.endsWith('/exams')) body = opts.exams ?? (eng ? ENG_EXAMS : EXAMS)
    else if (url.pathname.endsWith('/me')) body = eng ? ENG_ME : ME
    else if (url.pathname.endsWith('/sessions/current')) body = { session: inProgress ? IN_PROGRESS : null }
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
  return {
    /** 取れなかった経路を取れる状態に戻す（取り直しが成功する側へ移す）。 */
    recover: () => {
      failing = []
    },
  }
}

/** 確かめの応答。1 件のテストの中で answer を替えられ、問われた文は asked に残る
 *  （確かめの機構は仕様が決めていないので、画面の中に出る作りでも読めるよう asked と画面の差の両方を見る）。 */
function stubConfirm(answer: boolean) {
  const state = { answer, asked: [] as string[] }
  vi.stubGlobal('confirm', (message?: unknown) => {
    state.asked.push(String(message ?? ''))
    return state.answer
  })
  return state
}

/** 押したあとに画面へ増えた文（確かめが画面の中に出る作りでも読めるように、前後の差を採る）。 */
const addedText = (before: string, after: string) => {
  let s = 0
  while (s < before.length && before[s] === after[s]) s++
  let e = 0
  while (e < before.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++
  return after.slice(s, after.length - e)
}

/** 隠されていない（hidden 属性・display:none の祖先を持たない）要素か。 */
const shown = (el: Element) => !el.closest('[hidden]') && !el.closest('[style*="display: none"]')

/** 回ごとの確認の入口の語（登録簿の語。REQ-280）。 */
const ROUND_WORD = /この(日|章)の確認/

/** VITE_EXAM をロードマップ型の対象にしてから読み込み、描いた画面を返す。 */
async function drawRoadmap(target: Target = 'itc') {
  vi.stubEnv('VITE_EXAM', target)
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter, Route, Routes, useLocation } = await import('react-router-dom')
  const { Roadmap } = await import('../../src/client/pages/Roadmap')
  // 今いる場所（移った先の id まで）を読むための印。画面の作りには触らない
  const Where = () => React.createElement('span', null, `PATH:${useLocation().pathname}|`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const h = React.createElement
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
            // ロードマップ型ではロードマップが /topics に載っている
            h(Route, { path: '/topics', element: h(Roadmap) }),
            h(Route, { path: '/topics/:id', element: h('div', null, '単位の画面') }),
            h(Route, { path: '/sessions/:id', element: h('div', null, '出題の画面') }),
          ),
        ),
      ),
    )
  })
  const text = () => host.textContent ?? ''
  const links = () => [...host.querySelectorAll('a')]
  /** 回ごとの確認の入口（「この日の確認」「この章の確認」）。回ごとに 1 つで、文書の順＝回の順に並ぶ。 */
  const dayButtons = () =>
    [...host.querySelectorAll<HTMLElement>('button, summary, [role="button"]')].filter((b) =>
      ROUND_WORD.test(b.textContent ?? ''),
    )
  /** 並びの中の単位の導線（先頭の続きの導線と、先頭の 1 行の中の導線は除く）。 */
  const rowLinks = () =>
    links().filter(
      (a) =>
        /^\/topics\/\d+$/.test(a.getAttribute('href') ?? '') &&
        !/前回の続き|ここから（/.test(a.textContent ?? '') &&
        !a.closest('p.lead'),
    )
  /** 並びの中の単位 id の導線のうち、隠されていないもの。 */
  const unitLink = (id: number) => rowLinks().find((a) => a.getAttribute('href') === `/topics/${id}` && shown(a))
  /** 印の絞り込みの操作。印の語を持つ、押せる・選べる要素（単位の行の導線は除く）。 */
  const tierControl = (level: number) => {
    const label = tierLabel(level)
    const cands = [
      ...host.querySelectorAll<HTMLElement>(
        'input, button, [role="checkbox"], [role="switch"], [role="button"], [aria-pressed]',
      ),
    ]
    const named = (el: HTMLElement) => {
      const parts = [el.textContent ?? '', el.getAttribute('aria-label') ?? '']
      if (el instanceof HTMLInputElement) {
        for (const l of el.labels ?? []) parts.push(l.textContent ?? '')
        const wrap = el.closest('label')
        if (wrap) parts.push(wrap.textContent ?? '')
      }
      return parts.join(' ')
    }
    return cands.find((el) => named(el).includes(label))
  }
  const isSelected = (el: HTMLElement) =>
    el instanceof HTMLInputElement
      ? el.checked
      : el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true'
  return {
    host,
    text,
    /** いま開いている場所（/sessions/s-7 のような id つきの経路まで）。 */
    path: () => (text().match(/PATH:([^|]*)\|/) ?? [])[1] ?? '',
    lead: () => host.querySelector('p.lead')?.textContent ?? '',
    links,
    unitLink,
    /** 一覧の中の「ここから」の印（隠されていないもの）。 */
    hereLabels: () => [...host.querySelectorAll('span.rm-here-label')].filter(shown),
    linkTo: (to: string) => links().find((a) => a.getAttribute('href') === to),
    /** 単位の行の文字（印や「ここから」が行に付いているかを見る）。一覧の 1 項目
     *  （li・tr・role="listitem"）を 1 行とし、無ければ単位の導線そのもの。 */
    rowText: (id: number) => {
      const a = unitLink(id)
      if (!a) throw new Error(`単位 ${id} への導線が画面に無い`)
      return (a.closest('li, tr, [role="listitem"]') ?? a).textContent ?? ''
    },
    /** 文書の順の上で、与えた見出しの並びのうち k 番目（0 起点）の見出しから次の見出し
     *  （最後なら end の文、無ければ末尾）までの文字。単位の名前が先頭の続きの導線に出ても、
     *  見出しは最初の出現で採る。 */
    section: (headings: string[], k: number, end?: string) => {
      const body = text()
      const at = body.indexOf(headings[k])
      if (at < 0) throw new Error(`見出し「${headings[k]}」が画面に無い`)
      let to = k + 1 < headings.length ? body.indexOf(headings[k + 1], at) : -1
      if (to < 0 && end !== undefined) to = body.indexOf(end, at)
      return body.slice(at, to < 0 ? body.length : to)
    },
    dayButtons,
    tierControl,
    isSelected,
    /** 印の絞り込みの段を押す（選ぶ・外す）。 */
    toggleTier: async (level: number) => {
      const el = tierControl(level)
      if (!el) throw new Error(`印「${tierLabel(level)}」の絞り込みが画面に無い`)
      await React.act(async () => {
        el.click()
      })
    },
    buttons: () => [...host.querySelectorAll<HTMLElement>('button, [role="button"]')],
    /** 押せなくされている日（disabled か aria-disabled）。 */
    disabledDays: () =>
      dayButtons().filter(
        (b) => (b as HTMLButtonElement).disabled === true || b.getAttribute('aria-disabled') === 'true',
      ),
    /** n 番目（1 起点）の回の回ごとの確認を押す。 */
    clickDay: async (n: number) => {
      const b = dayButtons()[n - 1]
      if (!b) throw new Error(`${n} 番目の回の回ごとの確認が画面に無い`)
      await React.act(async () => {
        b.click()
      })
    },
    clickEl: async (el: HTMLElement) => {
      await React.act(async () => {
        el.click()
      })
    },
    /** 文書の順の上で、与えた文がどの日の見出しの後ろに出ているか。
     *  日ごとに並ぶ画面では「その日の見出しの後ろ」＝「その日のそば」。 */
    dayOf: (needle: string | RegExp) => {
      const body = text()
      const at = typeof needle === 'string' ? body.indexOf(needle) : body.search(needle)
      if (at < 0) throw new Error(`「${needle}」が画面に無い`)
      let found = ''
      for (const label of DAY_LABELS) {
        const i = body.indexOf(label)
        if (i >= 0 && i < at) found = label
      }
      return found
    },
    /** その文が画面に出ている回数（案内が 1 か所だけかを見る）。 */
    countText: (needle: string) => text().split(needle).length - 1,
    click: async (label: string | RegExp) => {
      const match = (s: string) => (typeof label === 'string' ? s.includes(label) : label.test(s))
      const cand = [...host.querySelectorAll<HTMLElement>('button, summary, [role="button"]')].filter(
        (el) => match(el.textContent ?? ''),
      )
      if (!cand.length) throw new Error(`「${label}」の操作が画面に無い`)
      await React.act(async () => {
        cand[0].click()
      })
    },
    clickAllButtons: async () => {
      for (const b of [...host.querySelectorAll<HTMLElement>('button')]) {
        await React.act(async () => {
          b.click()
        })
      }
    },
    close: async () => {
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
}

const countOf = (part: string, method = 'GET') =>
  calls.filter((c) => c.url.includes(part) && c.method === method).length

/** 文書の中で、単位の行が出ている位置（先頭の続きの導線より後ろの、最後の出現）。 */
const posOf = (body: string, term: string) => {
  const i = body.lastIndexOf(term)
  if (i < 0) throw new Error(`「${term}」が画面に無い`)
  return i
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('1 日ごとの並び（UC-009）', () => {
  // @covers REQ-130#first-unlearned-only
  it('日の順に並べ、最初のまだ理解していない単位にだけ「ここから」の印を付ける', async () => {
    stubApi()
    const v = await drawRoadmap()
    expect(v.text()).toContain('1 日目')
    expect(v.text()).toContain('2 日目')
    expect(v.text()).toContain('3 日目')
    // 1 日 3 単位（登録簿の値）なので、いま学ぶ位置は 5 番目の単位
    expect(v.hereLabels()).toHaveLength(1)
    expect(v.hereLabels()[0].textContent).toBe('ここから')
    expect(v.rowText(105)).toContain('ここから')
    expect(v.rowText(101)).not.toContain('ここから')
    await v.close()
  })

  // @covers REQ-134#extra-present-in-tail
  it('補足の単位は日ごとの並びに混ぜず、末尾の別枠に出す', async () => {
    stubApi({ units: [...UNITS, EXTRA] })
    const v = await drawRoadmap()
    const body = v.text()
    expect(body).toContain('補足の単位の名前')
    expect(body.indexOf('補足の単位の名前')).toBeGreaterThan(body.indexOf('単位 7 の名前'))
    await v.close()
  })

  // @covers REQ-134#extra-absent-no-section
  it('補足の単位が無ければ、その枠ごと出さない', async () => {
    stubApi()
    const v = await drawRoadmap()
    expect(v.text()).not.toContain('補足')
    await v.close()
  })
})

describe('先頭の 1 行（UC-009）', () => {
  // @covers REQ-131#understood-count-and-total
  it('理解した単位数と全単位数を出す', async () => {
    stubApi()
    const v = await drawRoadmap()
    expect(v.lead()).toContain('理解 4 / 7 単位')
    await v.close()
  })
})

describe('各日の確認テスト（UC-009）', () => {
  // @covers REQ-133#attempted-day
  it('その日の確認の問題数と、受けた回数・最高正解数を出す（受けていない日は出さない）', async () => {
    stubApi()
    const v = await drawRoadmap()
    expect(v.text()).toContain('この日の確認')
    expect(v.text()).toMatch(/6\s*問/)
    expect(v.text()).toMatch(/2\s*回/)
    expect(v.text()).toContain('5')
    // 受けていない日（attempts 0）には結果を出さない
    expect(v.text()).not.toMatch(/0\s*回/)
    await v.close()
  })

  // @covers REQ-142#confirm-shows-scope-and-count
  it('確かめにその日の範囲と問数が出る', async () => {
    stubApi()
    // 確かめの機構（confirm か画面の中か）は仕様が決めていないので、どちらでも読める形で見る
    const asked: string[] = []
    vi.stubGlobal('confirm', (message?: unknown) => {
      asked.push(String(message ?? ''))
      return false
    })
    const v = await drawRoadmap()
    const before = v.text()
    await v.click('この日の確認')
    const shown = `${asked.join(' ')} ${addedText(before, v.text())}`
    expect(shown, 'その日の範囲（1 日目）が確かめに出ていない').toContain('1 日目')
    expect(shown, 'その日の問数が確かめに出ていない').toMatch(/6\s*問/)
    await v.close()
  })

  // @covers REQ-142#declined-no-test
  it('確かめを断ると作成を求めない', async () => {
    stubApi()
    vi.stubGlobal('confirm', () => false)
    const v = await drawRoadmap()
    await v.click('この日の確認')
    expect(countOf('/sessions', 'POST')).toBe(0)
    await v.close()
  })

  /** 押すと進行中の取得だけをやり直す（新しいテストの作成は求めない）操作を探す。
   *  取れなかったときに添える「取り直す手段」の探し方で、既に無いときはこれが無いことを見る。 */
  const findRetry = async (v: Awaited<ReturnType<typeof drawRoadmap>>) => {
    for (const b of v.buttons()) {
      if (/この日の確認/.test(b.textContent ?? '')) continue
      const got = countOf('/sessions/current')
      const posted = countOf('/sessions', 'POST')
      await v.clickEl(b)
      if (countOf('/sessions/current') > got && countOf('/sessions', 'POST') === posted) return b
    }
    return undefined
  }

  // @covers REQ-143#in-progress-blocks
  it('作成が 409 のときは、どの日を押しても新しいテストを作らず移らず、日ごとの並びを残す', async () => {
    stubApi({ inProgress: true })
    stubConfirm(true)
    const v = await drawRoadmap()
    expect(v.dayButtons(), '日ごとの「この日の確認」が 3 日ぶん出ていない').toHaveLength(3)
    await v.clickDay(1)
    expect(countOf('/sessions', 'POST'), '作成をサーバに求めていない').toBe(1)
    // 文言は仕様が決めていないので、進行中のテストを指す語が出ることだけを見る
    expect(v.text(), '進行中のテストの案内が出ていない').toMatch(/進行中のテスト/)
    // 案内が出ている間も、押せなくする日は 1 つも無い（押した日も、ほかの日も）
    expect(v.disabledDays(), '進行中の間に押せなくなっている日がある').toHaveLength(0)
    await v.clickDay(2)
    await v.clickDay(3)
    expect(countOf('/sessions', 'POST'), 'ほかの日を押しても作成を求めていない（押せない）').toBe(3)
    // どれを押しても新しいテストにはならず、出題の画面へも移らない
    expect(v.path(), '出題の画面へ移っている').toBe('/topics')
    expect(v.text(), '出題の画面へ移っている').not.toContain('出題の画面')
    // その場＝ロードマップのまま。並びの取得が失敗したときと同じ描画に落ちていない
    for (const day of DAY_LABELS)
      expect(v.text(), `日ごとの見出し「${day}」が消えている`).toContain(day)
    expect(v.text(), '並びの先頭の単位が消えている').toContain('単位 1 の名前')
    expect(v.text(), '並びの末尾の単位が消えている').toContain('単位 7 の名前')
    expect(v.text(), '案内を出した場所の「この日の確認」が消えている').toContain('この日の確認')
    await v.close()
  })

  // @covers REQ-143#in-progress-shows-scope-and-progress
  it('進行中のテストの範囲と回答済み／全体の問数を、契約の進行中の取得から採って出す', async () => {
    stubApi({ inProgress: true })
    stubConfirm(true)
    const v = await drawRoadmap()
    const before = v.text()
    const fetched = countOf('/sessions/current')
    await v.clickDay(1)
    // 409 の本文は ErrorBody だけなので、範囲と進み具合は UC-006 の getCurrentSession で取り直すしかない
    expect(
      countOf('/sessions/current'),
      '断られたあとに進行中のテストを契約の操作で取り直していない',
    ).toBeGreaterThan(fetched)
    const shown = addedText(before, v.text())
    expect(shown, '進行中のテストの範囲が案内に出ていない').toContain(IN_PROGRESS.scopeLabel)
    // 2 つの数が並んで出ることだけを見る（どちらを先に書くか・区切りの文字は仕様が決めていない）
    const { answered, questionCount } = IN_PROGRESS
    expect(shown, '回答済みと全体の問数が案内に出ていない').toMatch(
      new RegExp(`(${answered}\\D{0,12}${questionCount}|${questionCount}\\D{0,12}${answered})`),
    )
    await v.close()
  })

  // @covers REQ-143#in-progress-shows-scope-and-progress
  it('案内は押した日のそばに 1 か所だけ出し、別の日を押すとその日のそばへ移る', async () => {
    stubApi({ inProgress: true })
    stubConfirm(true)
    const v = await drawRoadmap()
    await v.clickDay(1)
    expect(v.countText(IN_PROGRESS.scopeLabel), '案内が 1 か所だけ出ていない').toBe(1)
    expect(v.dayOf(IN_PROGRESS.scopeLabel), '1 日目を押したのに 1 日目のそばに出ていない').toBe(
      DAY_LABELS[0],
    )
    await v.clickDay(3)
    expect(v.countText(IN_PROGRESS.scopeLabel), '前に押した日の案内も残って 2 か所に出ている').toBe(1)
    expect(v.dayOf(IN_PROGRESS.scopeLabel), '3 日目を押したのに 3 日目のそばに出ていない').toBe(
      DAY_LABELS[2],
    )
    await v.close()
  })

  // @covers REQ-143#in-progress-resume-moves
  it('「再開する」を選ぶと、その進行中のテストの出題の画面へ移る', async () => {
    stubApi({ inProgress: true })
    stubConfirm(true)
    const v = await drawRoadmap()
    await v.click('この日の確認')
    await v.click('再開')
    expect(v.text(), '出題の画面へ移っていない').toContain('出題の画面')
    expect(v.path(), '進行中のテストとは別の行き先へ移っている').toMatch(
      new RegExp(`^/sessions/${IN_PROGRESS.id}$`),
    )
    expect(countOf('/sessions', 'POST'), '再開なのに新しいテストを作っている').toBe(1)
    await v.close()
  })

  // @covers REQ-143#in-progress-discard-confirms-and-clears
  it('「破棄する」は回答済みの問数を示して了承を取り、破棄できたらこの日の確認を始められる', async () => {
    stubApi({ inProgress: true })
    const c = stubConfirm(true)
    const v = await drawRoadmap()
    await v.click('この日の確認')
    const before = v.text()
    const askedBefore = c.asked.length
    await v.click('破棄')
    const shown = `${c.asked.slice(askedBefore).join(' ')} ${addedText(before, v.text())}`
    expect(shown, '破棄の確かめに回答済みの問数が出ていない').toContain(String(IN_PROGRESS.answered))
    expect(countOf('/sessions/current', 'DELETE'), '破棄を 1 回だけサーバに頼んでいない').toBe(1)
    expect(v.text(), '破棄したのに進行中の案内が残っている').not.toContain(IN_PROGRESS.scopeLabel)
    expect(v.text(), 'この日の確認が消えている').toContain('この日の確認')
    await v.click('この日の確認')
    expect(countOf('/sessions', 'POST'), '破棄のあとにこの日の確認を始められない').toBe(2)
    await v.close()
  })

  // @covers REQ-143#in-progress-discard-declined-keeps
  it('破棄の了承を取り消すと、破棄を頼まず案内を残し、この日の確認も始めない', async () => {
    stubApi({ inProgress: true })
    const c = stubConfirm(true)
    const v = await drawRoadmap()
    await v.click('この日の確認')
    c.answer = false
    await v.click('破棄')
    expect(countOf('/sessions/current', 'DELETE'), '取り消したのに破棄を頼んでいる').toBe(0)
    expect(v.text(), '取り消したのに進行中の案内が消えている').toContain(IN_PROGRESS.scopeLabel)
    expect(v.text(), '取り消したのに再開の選択肢が消えている').toMatch(/再開/)
    expect(countOf('/sessions', 'POST'), '取り消したのに新しいテストを作っている').toBe(1)
    expect(v.text(), '出題の画面へ移っている').not.toContain('出題の画面')
    await v.close()
  })

  // @covers REQ-143#in-progress-not-fetched
  it('進行中のテストの範囲と進み具合が取れないときは理由と取り直す手段を出し、取り直せてから再開・破棄を選べる', async () => {
    // 作成は 409（進行中あり）だが、進行中のテストの問い合わせだけが取れない
    const api = stubApi({ inProgress: true, fail: ['/sessions/current'] })
    stubConfirm(true)
    const v = await drawRoadmap()
    const before = v.text()
    await v.clickDay(1)
    const shown = addedText(before, v.text())
    // 理由を示す（文言は仕様が決めていないので、サーバが返した ErrorBody の文か取れなかったことを指す語）
    expect(shown, '取れなかった理由が出ていない').toMatch(
      new RegExp(`${FAIL_TEXT['/sessions/current']}|取得できません|確認できません|取れません|失敗`),
    )
    // 取れていないものを、取れたかのように出さない
    expect(v.text(), '取れていない進行中のテストの範囲を示している').not.toContain(IN_PROGRESS.scopeLabel)
    expect(
      v.buttons().filter((b) => /再開|破棄/.test(b.textContent ?? '')),
      '取り直せていないのに再開・破棄が選べる',
    ).toHaveLength(0)
    for (const day of DAY_LABELS)
      expect(v.text(), `日ごとの見出し「${day}」が消えている`).toContain(day)

    const retry = await findRetry(v)
    expect(retry, '取れなかったのに取り直す手段が添えられていない').toBeDefined()

    // 取り直せたら、範囲と進み具合が出て再開・破棄が選べる
    const label = (retry?.textContent ?? '').trim()
    expect(label, '取り直す手段に押せる文が無い（空の操作では押し直せない）').not.toBe('')
    api.recover()
    await v.click(label)
    expect(v.text(), '取り直せたのに進行中のテストの範囲が出ない').toContain(IN_PROGRESS.scopeLabel)
    expect(
      v.buttons().filter((b) => /再開/.test(b.textContent ?? '')),
      '取り直せたのに再開が選べない',
    ).not.toHaveLength(0)
    expect(
      v.buttons().filter((b) => /破棄/.test(b.textContent ?? '')),
      '取り直せたのに破棄が選べない',
    ).not.toHaveLength(0)
    await v.close()
  })

  // @covers REQ-143#in-progress-already-gone
  it('取りに行った進行中のテストが既に無いときは、無い旨を押した日のそばに出し、始められる状態に戻る', async () => {
    // 競合: 作成は 409 で断られたが、取り直すともう進行中のテストは無い（別の経路で締められた・破棄された）
    stubApi({ gone: true })
    stubConfirm(true)
    const v = await drawRoadmap()
    const before = v.text()
    const fetched = countOf('/sessions/current')
    await v.clickDay(2)
    expect(countOf('/sessions', 'POST'), '作成をサーバに求めていない').toBe(1)
    expect(countOf('/sessions/current'), '断られたあとに進行中のテストを取り直していない').toBeGreaterThan(
      fetched,
    )
    // 文言は仕様が決めていないので、進行中のテストを指す語が出ることだけを見る
    const shown = addedText(before, v.text())
    expect(shown, '進行中のテストが無いことが示されていない').toMatch(/進行中/)
    expect(v.dayOf(/進行中/), '2 日目を押したのに 2 日目のそばに出ていない').toBe(DAY_LABELS[1])
    // 既に無いものの範囲・進み具合・再開・破棄は出さない
    expect(v.text(), '既に無い進行中のテストの範囲を示している').not.toContain(IN_PROGRESS.scopeLabel)
    expect(
      v.buttons().filter((b) => /再開|破棄/.test(b.textContent ?? '')),
      '既に無いのに再開・破棄が選べる',
    ).toHaveLength(0)
    for (const day of DAY_LABELS)
      expect(v.text(), `日ごとの見出し「${day}」が消えている`).toContain(day)
    // 「既に無い」と「取れなかった」を分ける: 取り直す手段は添えない（取り直しても無いものは出てこない）
    expect(
      await findRetry(v),
      '既に無いのに取り直す手段が添えられている（取れなかった側の案内に倒れている）',
    ).toBeUndefined()
    // この日の確認を始められる状態に戻っている（同じ日をもう一度押すと作成へ進む）
    await v.clickDay(2)
    expect(countOf('/sessions', 'POST'), 'この日の確認を始められる状態に戻っていない').toBe(2)
    await v.close()
  })

  // @covers REQ-276#start-failed-shows-reason-keeps-list
  it('進行中の有無以外の理由で作れなかったときは、押した日のそばに理由を出し、日ごとの並びを消さない', async () => {
    // UC-008 の契約 startMockExam の INVALID_INPUT（選んだ範囲に出題できる問題が 1 問も無い）
    const reason = 'この日の確認問題がまだ登録されていません'
    stubApi({ startFails: { status: 400, error: reason } })
    stubConfirm(true)
    const v = await drawRoadmap()
    await v.clickDay(2)
    expect(countOf('/sessions', 'POST'), '作成をサーバに求めていない').toBe(1)
    expect(v.text(), 'サーバが返した理由が出ていない').toContain(reason)
    expect(v.dayOf(reason), '押した日（2 日目）のそばに理由が出ていない').toBe(DAY_LABELS[1])
    for (const day of DAY_LABELS)
      expect(v.text(), `日ごとの見出し「${day}」が消えている`).toContain(day)
    expect(v.text(), '並びの先頭の単位が消えている').toContain('単位 1 の名前')
    expect(v.text(), '並びの末尾の単位が消えている').toContain('単位 7 の名前')
    expect(v.text(), '出題の画面へ移っている').not.toContain('出題の画面')
    // 進行中のテストがある側（REQ-143）の案内に混ぜない
    expect(v.text(), '進行中でもないのに再開・破棄の案内を出している').not.toMatch(/再開|破棄/)
    await v.close()
  })

  // @covers REQ-276#start-failed-shows-reason-keeps-list
  it('通信そのものが届かないときも、理由を出して日ごとの並びを消さない', async () => {
    stubApi({ startFails: 'network' })
    stubConfirm(true)
    const v = await drawRoadmap()
    const before = v.text()
    await v.clickDay(3)
    expect(countOf('/sessions', 'POST'), '作成をサーバに求めていない').toBe(1)
    const shown = addedText(before, v.text())
    expect(shown, '始められなかったことを示していない').toMatch(/できません|できなかった|失敗|エラー|通信/)
    for (const day of DAY_LABELS)
      expect(v.text(), `日ごとの見出し「${day}」が消えている`).toContain(day)
    expect(v.text(), '並びの先頭の単位が消えている').toContain('単位 1 の名前')
    expect(v.text(), '出題の画面へ移っている').not.toContain('出題の画面')
    await v.close()
  })
})

describe('先頭の導線（UC-009）', () => {
  // @covers REQ-144#last-topic-destination
  it('覚えた単位があれば「前回の続きから」にする', async () => {
    stubApi()
    setLastTopic({ id: 103, term: '単位 3 の名前', middle: 'コンサルの仕事', middleNo: 1 })
    const v = await drawRoadmap()
    expect(v.text()).toContain('前回の続きから（単位 3 の名前）')
    const to = v.links().find((a) => /前回の続きから/.test(a.textContent ?? ''))
    expect(to?.getAttribute('href')).toBe('/topics/103')
    await v.close()
  })

  // @covers REQ-144#last-topic-destination
  it('前回の続きが行き先のときは、印で絞り込んで覚えた単位が隠れても行き先を変えない', async () => {
    stubApi({ target: 'eng' })
    setLastTopic({ id: 302, term: '章の単位 302', middle: 'コンピュータの仕組み', middleNo: 1 })
    const v = await drawRoadmap('eng')
    const go = () => v.links().find((a) => /前回の続きから/.test(a.textContent ?? ''))
    expect(go()?.getAttribute('href'), '前回の続きが行き先になっていない（この検査は空振りになる）').toBe('/topics/302')
    // 302 は印 1。外すと一覧からは隠れる
    await v.toggleTier(1)
    expect(v.unitLink(302), '印を外せていない（この検査は空振りになる）').toBeUndefined()
    expect(go()?.getAttribute('href'), '絞り込みで前回の続きの行き先が変わっている').toBe('/topics/302')
    await v.close()
  })

  // @covers REQ-144#fallback-here
  it('覚えた単位が無ければ、いま学ぶ位置（status が 3 でない最初の単位）へ送る', async () => {
    stubApi()
    const v = await drawRoadmap()
    expect(v.text()).not.toContain('前回の続きから')
    const to = v.links().find((a) => /ここから（/.test(a.textContent ?? ''))
    expect(to?.textContent).toContain('ここから（単位 5 の名前）')
    expect(to?.getAttribute('href')).toBe('/topics/105')
    await v.close()
  })
})

describe('取れなかったとき（UC-009）', () => {
  // @covers REQ-241#list-unavailable-shows-retry
  it('単位の一覧が取れないときは、失敗と取り直す手段を出す', async () => {
    stubApi({ fail: ['/topics'] })
    const v = await drawRoadmap()
    expect(v.text()).toContain('単位の一覧を取得できませんでした')
    const before = countOf('/topics')
    await v.clickAllButtons()
    expect(countOf('/topics'), '取り直す手段が無い（押しても取りに行かない）').toBeGreaterThan(before)
    await v.close()
  })

  // @covers REQ-136#both-missing-list-kept
  it('確認テストと連続日数だけが取れないときは、一覧を出したままにする', async () => {
    stubApi({ fail: ['/exams', '/me'] })
    const v = await drawRoadmap()
    expect(v.text()).toContain('単位 1 の名前')
    expect(v.text()).toContain('単位 7 の名前')
    expect(v.text()).not.toContain('連続 13 日')
    await v.close()
  })
})

describe('回ごとの並び（日で束ねる学び・章で束ねる学び）（UC-009）', () => {
  // @covers REQ-129#grouped-by-round-in-order
  it('届いた順によらず学ぶ順に並べ、各単位を属する日にまとめて日の順に出す（単位の足りない最後の日も 1 回）', async () => {
    // 並びの応答をわざと崩して渡す（学ぶ順と回で並べ直すのは画面の側）
    stubApi({ units: [UNITS[6], UNITS[2], UNITS[4], UNITS[0], UNITS[5], UNITS[3], UNITS[1]] })
    const v = await drawRoadmap()
    const body = v.text()
    const at = UNITS.map((u) => posOf(body, String(u.term)))
    expect(at, '単位が学ぶ順に並んでいない').toEqual([...at].sort((a, b) => a - b))
    for (const [k, members] of [
      [0, [1, 2, 3]],
      [1, [4, 5, 6]],
      [2, [7]],
    ] as const) {
      const sec = v.section(DAY_HEADINGS, k)
      for (const n of [1, 2, 3, 4, 5, 6, 7]) {
        const inside = sec.includes(`単位 ${n} の名前`)
        expect(inside, `単位 ${n} が「${DAY_HEADINGS[k]}」に${inside ? '混ざっている' : '出ていない'}`).toBe(
          (members as readonly number[]).includes(n),
        )
      }
    }
    await v.close()
  })

  // @covers REQ-129#rounds-of-different-size
  it('章ごとに単位の数が違っても（2・4・1）、各章にはその章に属する単位だけが出る', async () => {
    stubApi({ target: 'eng', units: [...ENG_UNITS, ENG_EXTRA] })
    const v = await drawRoadmap('eng')
    const members: Record<number, number[]> = { 0: [301, 302], 1: [303, 304, 305, 306], 2: [307] }
    for (let k = 0; k < 3; k++) {
      const sec = v.section(CHAPTER_HEADINGS, k, '補足')
      for (const u of ENG_UNITS) {
        const id = Number(u.id)
        const inside = sec.includes(`章の単位 ${id}`)
        expect(inside, `単位 ${id} が「${CHAPTER_HEADINGS[k]}」に${inside ? '混ざっている' : '出ていない'}`).toBe(
          members[k].includes(id),
        )
      }
      expect(sec, `補足の単位が「${CHAPTER_HEADINGS[k]}」に混ざっている`).not.toContain('章の補足の単位')
    }
    await v.close()
  })

  // @covers REQ-129#tier-does-not-reorder
  it('1 つの章に違う印の単位が混ざっていても、印の順に並べ替えず学ぶ順のまま出す', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    const sec = v.section(CHAPTER_HEADINGS, 1)
    // 第 2 章の印は学ぶ順に 1・3・2・1
    const at = [303, 304, 305, 306].map((id) => {
      const i = sec.indexOf(`章の単位 ${id}`)
      expect(i, `単位 ${id} が第 2 章に出ていない`).toBeGreaterThanOrEqual(0)
      return i
    })
    expect(at, '印で並べ替えている').toEqual([...at].sort((a, b) => a - b))
    await v.close()
  })

  // @covers REQ-129#completed-round-marked
  it('その日の単位が全て理解の日にだけ、完了した旨を付ける', async () => {
    stubApi()
    const v = await drawRoadmap()
    // 1 日目は 1〜3 が全部理解、2 日目は 5・6 が未理解
    const done = /完了|済み|✓|✔/
    expect(v.section(DAY_HEADINGS, 0), '全部理解の 1 日目に完了した旨が無い').toMatch(done)
    expect(v.section(DAY_HEADINGS, 1), '未理解が残る 2 日目に完了した旨が付いている').not.toMatch(done)
    expect(v.section(DAY_HEADINGS, 2), '未理解が残る 3 日目に完了した旨が付いている').not.toMatch(done)
    await v.close()
  })
})

describe('「ここから」（UC-009）', () => {
  // @covers REQ-130#unset-status-is-unlearned
  it('理解度の記録が無い単位も未理解として数え、それが最初ならそこに「ここから」を付ける', async () => {
    // 1〜4 は理解、5 は記録なし、6 は未理解
    stubApi({ units: [unit(1, 3), unit(2, 3), unit(3, 3), unit(4, 3), unit(5, null), unit(6, 1), unit(7, 2)] })
    const v = await drawRoadmap()
    expect(v.hereLabels()).toHaveLength(1)
    expect(v.rowText(105), '記録の無い最初の単位に「ここから」が付いていない').toContain('ここから')
    expect(v.rowText(106)).not.toContain('ここから')
    await v.close()
  })

  // @covers REQ-130#all-understood-no-here
  it('全ての単位が理解のときは「ここから」を出さない', async () => {
    stubApi({ units: [1, 2, 3, 4, 5, 6, 7].map((n) => unit(n, 3)) })
    const v = await drawRoadmap()
    expect(v.hereLabels(), '全部理解なのに「ここから」の印が出ている').toHaveLength(0)
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(v.rowText(100 + n)).not.toContain('ここから')
    await v.close()
  })
})

describe('先頭の数（回の数の語と 1 回の論点数）（UC-009）', () => {
  // @covers REQ-131#round-count-day-word
  it('日で束ねる学びは回の数を日の語で出し、補足の回と順序なしの 1 回を数えない', async () => {
    stubApi({ units: [unordered(150, '順序なしの単位の名前'), ...UNITS, EXTRA] })
    const v = await drawRoadmap()
    expect(v.lead()).toContain('全 3 日')
    expect(v.lead()).not.toMatch(/全\s*\d+\s*章/)
    await v.close()
  })

  // @covers REQ-131#round-count-chapter-word
  it('章で束ねる学びは回の数を章の語で出し、補足の回と順序なしの 1 回を数えない', async () => {
    stubApi({ target: 'eng', units: [unordered(350, '章の順序なしの単位'), ...ENG_UNITS, ENG_EXTRA] })
    const v = await drawRoadmap('eng')
    expect(v.lead()).toContain('全 3 章')
    expect(v.lead()).not.toMatch(/全\s*\d+\s*日/)
    await v.close()
  })

  // @covers REQ-131#per-round-count-fixed
  it('1 回の論点数を登録簿が決めている日で束ねる学びは、その数を先頭に出す', async () => {
    stubApi()
    const v = await drawRoadmap()
    expect(v.lead()).toContain('1 日 3 単位')
    await v.close()
  })

  // @covers REQ-131#per-round-count-absent
  it('章で束ねる学びは、1 回の論点数を先頭に出さない', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    expect(v.lead(), '先頭が描かれていない').toContain('全 3 章')
    expect(v.lead()).not.toMatch(/1\s*(日|章|回)\s*\d+\s*単位/)
    await v.close()
  })
})

describe('回ごとの確認の結果（UC-009）', () => {
  // @covers REQ-133#unattempted-day
  it('一度も受けていない日には問数だけを出し、受けた結果を出さない', async () => {
    stubApi()
    const v = await drawRoadmap()
    const day2 = v.section(DAY_HEADINGS, 1)
    expect(day2, '受けていない日に問数が出ていない').toMatch(/(?<!\d)6\s*問/)
    expect(day2, '受けていない日に受けた回数が出ている').not.toMatch(/\d+\s*回/)
    expect(day2, '受けていない日に最高の正解数が出ている').not.toContain('最高')
    await v.close()
  })
})

describe('順序なしの 1 回（UC-009）', () => {
  // @covers REQ-135#unordered-present-leading-day
  it('学ぶ順を持たない補足でない単位は、日ごとの並びの先頭に 1 つにまとめて出す', async () => {
    stubApi({ units: [...UNITS, unordered(150, '順序なしの単位 甲'), unordered(151, '順序なしの単位 乙'), EXTRA] })
    const v = await drawRoadmap()
    const body = v.text()
    const first = body.indexOf(DAY_HEADINGS[0])
    expect(first).toBeGreaterThanOrEqual(0)
    for (const name of ['順序なしの単位 甲', '順序なしの単位 乙']) {
      expect(posOf(body, name), `「${name}」が 1 日目より前に出ていない`).toBeLessThan(first)
      expect(posOf(body, name), `「${name}」が補足の別枠に混ざっている`).toBeLessThan(posOf(body, '補足の単位の名前'))
    }
    // 2 つの順序なしの単位のあいだに日の見出しを挟まない（1 つの回にまとまる）
    const between = body.slice(posOf(body, '順序なしの単位 甲'), posOf(body, '順序なしの単位 乙'))
    expect(between).not.toMatch(/\d+\s*日目/)
    await v.close()
  })

  // @covers REQ-135#unordered-absent
  it('そのような単位が無いときは、1 日目より前に単位の行を出さない', async () => {
    stubApi()
    const v = await drawRoadmap()
    const body = v.text()
    const first = body.indexOf(DAY_HEADINGS[0])
    expect(first).toBeGreaterThanOrEqual(0)
    for (const u of UNITS) expect(posOf(body, String(u.term)), `${u.term} が 1 日目より前に出ている`).toBeGreaterThan(first)
    await v.close()
  })
})

describe('一部が取れなかったとき（UC-009）', () => {
  // @covers REQ-136#exams-missing-only
  it('回ごとの確認の結果だけが取れないときは、並びと連続記録を出したままにする', async () => {
    stubApi({ fail: ['/exams'] })
    const v = await drawRoadmap()
    expect(v.text()).toContain('単位 1 の名前')
    expect(v.text()).toContain('単位 7 の名前')
    expect(v.text(), '取れた連続記録が消えている').toContain('連続 13 日')
    expect(v.text(), '取れていない受けた回数を出している').not.toMatch(/2\s*回/)
    await v.close()
  })

  // @covers REQ-136#streak-missing-only
  it('連続記録だけが取れないときは、並びと回ごとの確認の結果を出したままにする', async () => {
    stubApi({ fail: ['/me'] })
    const v = await drawRoadmap()
    expect(v.text()).toContain('単位 1 の名前')
    expect(v.text()).toContain('単位 7 の名前')
    const day1 = v.section(DAY_HEADINGS, 0)
    expect(day1, '取れた回ごとの確認の問数が消えている').toMatch(/(?<!\d)6\s*問/)
    expect(day1, '取れた受けた回数が消えている').toMatch(/2\s*回/)
    expect(v.text(), '取れていない連続記録を出している').not.toContain('連続 13 日')
    await v.close()
  })
})

describe('回ごとの確認を始める（UC-009）', () => {
  // @covers REQ-142#accepted-creates-and-moves
  it('受けると答えると、その日の範囲でテストを作って出題の画面へ移る', async () => {
    stubApi()
    stubConfirm(true)
    const v = await drawRoadmap()
    await v.clickDay(2)
    const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/sessions'))
    expect(posts, 'テストの作成を 1 回だけ求めていない').toHaveLength(1)
    expect(posts[0].body, '作成の範囲が押した日（itc-d02）になっていない').toMatchObject({ kind: 'mock', exam: 'itc-d02' })
    expect(v.path(), '作ったテストの出題の画面へ移っていない').toBe('/sessions/s-new')
    await v.close()
  })
})

describe('回の見出し（UC-009）', () => {
  // @covers REQ-279#day-heading
  it('日で束ねる学びは、各回の見出しを日の形（〇日目）で、その日の単位より前に出す', async () => {
    stubApi()
    const v = await drawRoadmap()
    const body = v.text()
    const at = DAY_HEADINGS.map((h) => body.indexOf(h))
    for (const [k, i] of at.entries()) expect(i, `見出し「${DAY_HEADINGS[k]}」が無い`).toBeGreaterThanOrEqual(0)
    expect(at, '見出しが日の順に並んでいない').toEqual([...at].sort((a, b) => a - b))
    expect(at[0], '1 日目の見出しが 1 日目の単位より後ろにある').toBeLessThan(posOf(body, '単位 1 の名前'))
    expect(at[1], '2 日目の見出しが 2 日目の単位より後ろにある').toBeLessThan(posOf(body, '単位 4 の名前'))
    expect(at[2], '3 日目の見出しが 3 日目の単位より後ろにある').toBeLessThan(posOf(body, '単位 7 の名前'))
    expect(body, '日で束ねる学びに章の見出しが出ている').not.toMatch(/第\s*\d+\s*章/)
    await v.close()
  })

  // @covers REQ-279#chapter-heading
  it('章で束ねる学びは、各回の見出しに章の番号と投入された章の名前を出し、日の形を使わない', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    for (const [k, c] of CHAPTERS.entries()) {
      expect(v.text(), `見出し「第 ${c.no} 章 ${c.name}」が出ていない`).toMatch(
        new RegExp(`第\\s*${c.no}\\s*章\\s*${c.name}`),
      )
      expect(v.text(), `第 ${c.no} 章の番号が重なって出ている`).not.toMatch(
        new RegExp(`第\\s*${c.no}\\s*章\\s*第\\s*${c.no}\\s*章`),
      )
    }
    expect(v.text(), '章で束ねる学びに日の見出しが出ている').not.toMatch(/\d+\s*日目/)
    await v.close()
  })

  // @covers REQ-279#heading-without-exam-list
  it('回ごとの確認の一覧が取れないときも、回の見出しは同じく出る', async () => {
    stubApi({ fail: ['/exams'] })
    const v = await drawRoadmap()
    for (const h of DAY_HEADINGS) expect(v.text(), `見出し「${h}」が消えている`).toContain(h)
    await v.close()
  })

  // @covers REQ-279#heading-without-exam-list
  it('回ごとの確認を持たない章にも、回の見出しは同じく出る', async () => {
    stubApi({ target: 'eng', exams: { exams: ENG_EXAMS.exams.slice(0, 2) } })
    const v = await drawRoadmap('eng')
    expect(v.text(), '確認を持たない第 3 章の見出しが消えている').toContain('第 3 章')
    expect(v.section(CHAPTER_HEADINGS, 2)).toContain('丙の章')
    await v.close()
  })
})

describe('回ごとの確認の語（UC-009）', () => {
  // @covers REQ-280#day-wording
  it('日で束ねる学びは、各日の入口と確かめに「この日の確認」を出す', async () => {
    stubApi()
    const c = stubConfirm(false)
    const v = await drawRoadmap()
    expect(v.dayButtons().filter((b) => /この日の確認/.test(b.textContent ?? ''))).toHaveLength(3)
    const before = v.text()
    await v.clickDay(1)
    expect(`${c.asked.join(' ')} ${addedText(before, v.text())}`, '確かめに「この日の確認」が無い').toContain(
      'この日の確認',
    )
    expect(v.text()).not.toContain('この章の確認')
    await v.close()
  })

  // @covers REQ-280#chapter-wording
  it('章で束ねる学びは、各章の入口と確かめに「この章の確認」を出す', async () => {
    stubApi({ target: 'eng' })
    const c = stubConfirm(false)
    const v = await drawRoadmap('eng')
    expect(v.dayButtons().filter((b) => /この章の確認/.test(b.textContent ?? ''))).toHaveLength(3)
    const before = v.text()
    await v.clickDay(1)
    expect(`${c.asked.join(' ')} ${addedText(before, v.text())}`, '確かめに「この章の確認」が無い').toContain(
      'この章の確認',
    )
    expect(v.text()).not.toContain('この日の確認')
    await v.close()
  })
})

describe('印（印を持つ学び）（UC-009）', () => {
  // @covers REQ-282#tier-label-per-unit
  it('回ごとの並びと補足の別枠の各単位に、その単位の印を登録簿の語で出す', async () => {
    stubApi({ target: 'eng', units: [...ENG_UNITS, ENG_EXTRA] })
    const v = await drawRoadmap('eng')
    for (const u of [...ENG_UNITS, ENG_EXTRA])
      expect(v.rowText(Number(u.id)), `単位 ${u.id} に印「${tierLabel(Number(u.tier))}」が無い`).toContain(
        tierLabel(Number(u.tier)),
      )
    await v.close()
  })

  // @covers REQ-287#filter-offered-all-selected
  it('開いたとき、登録簿の全ての印の段を選んだ状態で絞り込みを添える', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    for (const t of TIERS) {
      const el = v.tierControl(t.level)
      expect(el, `印「${t.label}」の絞り込みが無い`).toBeDefined()
      expect(v.isSelected(el!), `印「${t.label}」が選ばれていない`).toBe(true)
    }
    await v.close()
  })

  // @covers REQ-287#reopen-resets-to-all
  it('選び直したあとに開き直すと、全ての印を選んだ状態に戻る', async () => {
    stubApi({ target: 'eng' })
    const first = await drawRoadmap('eng')
    await first.toggleTier(1)
    expect(first.isSelected(first.tierControl(1)!), '印を外せていない（この検査は空振りになる）').toBe(false)
    await first.close()
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    for (const t of TIERS) expect(v.isSelected(v.tierControl(t.level)!), `印「${t.label}」が選ばれていない`).toBe(true)
    expect(v.unitLink(303), '前の選択を覚えて印 1 の単位を隠している').toBeDefined()
    await v.close()
  })

  // @covers REQ-288#last-tier-cannot-be-cleared
  it('選んでいる印が 1 つだけのときは、それを外す操作をしても選んだ組が空にならない', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    await v.toggleTier(1)
    await v.toggleTier(2)
    expect(v.isSelected(v.tierControl(3)!)).toBe(true)
    await v.toggleTier(3)
    expect(v.isSelected(v.tierControl(3)!), '最後の 1 つの印を外せてしまう').toBe(true)
    expect(v.unitLink(301), '最後の印の単位が消えている').toBeDefined()
    expect(v.unitLink(304), '最後の印の単位が消えている').toBeDefined()
    await v.close()
  })

  // @covers REQ-288#two-or-more-can-be-cleared
  it('選んでいる印が 2 つ以上のときは、そのうち 1 つを外せる', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    await v.toggleTier(1)
    expect(v.isSelected(v.tierControl(1)!), '2 つ以上選んでいるのに印を外せない').toBe(false)
    expect(v.isSelected(v.tierControl(2)!)).toBe(true)
    expect(v.isSelected(v.tierControl(3)!)).toBe(true)
    await v.toggleTier(2)
    expect(v.isSelected(v.tierControl(2)!), '2 つ選んでいるのに印を外せない').toBe(false)
    await v.close()
  })
})

describe('印の絞り込み（UC-009）', () => {
  // @covers REQ-283#selected-tiers-only
  it('一部の印を選ぶと、その印の単位だけが回ごとの並びと補足の別枠に残る', async () => {
    stubApi({ target: 'eng', units: [...ENG_UNITS, ENG_EXTRA] })
    const v = await drawRoadmap('eng')
    await v.toggleTier(1)
    for (const id of [301, 304, 305]) expect(v.unitLink(id), `選んだ印の単位 ${id} が消えている`).toBeDefined()
    for (const id of [302, 303, 306, 307, 400])
      expect(v.unitLink(id), `外した印の単位 ${id} が残っている`).toBeUndefined()
    // 印を 1 つだけ選んだとき
    await v.toggleTier(3)
    expect(v.unitLink(305), '選んだ印 2 の単位が消えている').toBeDefined()
    for (const id of [301, 302, 303, 304, 306, 307, 400])
      expect(v.unitLink(id), `外した印の単位 ${id} が残っている`).toBeUndefined()
    await v.close()
  })

  // @covers REQ-283#all-selected-shows-all
  it('全ての印を選び直すと全ての単位が出て、「ここから」が学ぶ順で最初の未理解に戻る', async () => {
    stubApi({ target: 'eng', units: [...ENG_UNITS, ENG_EXTRA] })
    const v = await drawRoadmap('eng')
    await v.toggleTier(1)
    expect(v.unitLink(303), '印を外せていない（この検査は空振りになる）').toBeUndefined()
    await v.toggleTier(1)
    for (const u of [...ENG_UNITS, ENG_EXTRA]) expect(v.unitLink(Number(u.id)), `単位 ${u.id} が戻っていない`).toBeDefined()
    expect(v.hereLabels()).toHaveLength(1)
    expect(v.rowText(303), '「ここから」が学ぶ順で最初の未理解（303）に戻っていない').toContain('ここから')
    await v.close()
  })

  // @covers REQ-283#round-without-match-keeps-heading
  it('選んだ印の単位を 1 つも持たない章でも、回の見出しと回ごとの確認の入口が残る', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    await v.toggleTier(1)
    expect(v.unitLink(307), '印を外せていない（この検査は空振りになる）').toBeUndefined()
    expect(v.text(), '第 3 章の見出しが消えている').toContain('第 3 章')
    expect(v.section(CHAPTER_HEADINGS, 2)).toContain('丙の章')
    expect(v.dayButtons(), '回ごとの確認の入口が 3 章ぶん残っていない').toHaveLength(3)
    expect(v.section(CHAPTER_HEADINGS, 2), '第 3 章の回ごとの確認の入口が消えている').toContain('この章の確認')
    await v.close()
  })

  // @covers REQ-283#extra-section-hidden-when-empty
  it('補足の単位に選んだ印のものが 1 つも無いときは、補足の別枠そのものを出さない', async () => {
    stubApi({ target: 'eng', units: [...ENG_UNITS, ENG_EXTRA] })
    const v = await drawRoadmap('eng')
    expect(v.text(), '補足の別枠が初めから出ていない（この検査は空振りになる）').toContain('補足')
    await v.toggleTier(1)
    expect(v.text(), '残る単位の無い補足の別枠が出ている').not.toContain('補足')
    await v.close()
  })

  // @covers REQ-283#here-moves-within-filter
  it('最初の未理解の単位が絞り込みで隠れると、残した中で最初の未理解に「ここから」を付け直す', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    expect(v.rowText(303), '絞り込む前の「ここから」が 303 に無い（この検査は空振りになる）').toContain('ここから')
    await v.toggleTier(1)
    expect(v.hereLabels()).toHaveLength(1)
    expect(v.rowText(304), '残した中で最初の未理解（304）に「ここから」が無い').toContain('ここから')
    await v.close()
  })

  // @covers REQ-283#continue-link-follows-filter
  it('先頭の続きの導線が「ここから」へ向くときは、絞り込みのあいだ一覧の「ここから」と同じ単位へ向き、全部に戻すと元へ戻る', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    const go = () => v.links().find((a) => /ここから（/.test(a.textContent ?? ''))
    expect(go()?.getAttribute('href'), '絞り込む前の行き先が 303 でない（この検査は空振りになる）').toBe('/topics/303')
    await v.toggleTier(1)
    expect(go()?.getAttribute('href'), '絞り込んだのに行き先が一覧の「ここから」（304）でない').toBe('/topics/304')
    expect(go()?.textContent).toContain('章の単位 304')
    expect(v.rowText(304)).toContain('ここから')
    await v.toggleTier(1)
    expect(go()?.getAttribute('href'), '全部の印に戻したのに元の行き先へ戻らない').toBe('/topics/303')
    await v.close()
  })

  // @covers REQ-283#no-unlearned-in-filter-no-here
  it('残した単位が全て理解のときは「ここから」を出さない', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    await v.toggleTier(1)
    await v.toggleTier(3)
    expect(v.unitLink(305), '印 2 の単位が残っていない（この検査は空振りになる）').toBeDefined()
    expect(v.hereLabels(), '残した単位が全て理解なのに「ここから」が出ている').toHaveLength(0)
    expect(v.rowText(305)).not.toContain('ここから')
    await v.close()
  })

  // @covers REQ-283#scope-and-summary-unchanged
  it('絞り込んでも、先頭の数と回ごとの確認の問数と範囲は変わらない', async () => {
    stubApi({ target: 'eng' })
    const c = stubConfirm(true)
    const v = await drawRoadmap('eng')
    const lead = v.lead()
    expect(lead, '先頭が描かれていない').not.toBe('')
    await v.toggleTier(1)
    expect(v.lead(), '絞り込みで先頭の数が変わっている').toBe(lead)
    for (const [k, e] of ENG_EXAMS.exams.entries())
      expect(v.section(CHAPTER_HEADINGS, k), `${e.examLabel} の問数が変わっている`).toMatch(
        new RegExp(`(?<!\\d)${e.questions}\\s*問`),
      )
    // 単位が 1 つも残っていない第 3 章でも、範囲と問数は絞り込む前のまま
    const before = v.text()
    await v.clickDay(3)
    expect(`${c.asked.join(' ')} ${addedText(before, v.text())}`, '確かめの問数が変わっている').toMatch(
      /(?<!\d)2\s*問/,
    )
    const posts = calls.filter((x) => x.method === 'POST' && x.url.endsWith('/sessions'))
    expect(posts).toHaveLength(1)
    expect(posts[0].body, '作成の範囲が章（eng-c3）のままでない').toMatchObject({ kind: 'mock', exam: 'eng-c03' })
    await v.close()
  })

  // @covers REQ-283#progress-notice-kept
  it('進行中の案内が出ているあいだに絞り込みを選び直しても、案内は残る', async () => {
    stubApi({ target: 'eng', inProgress: true })
    stubConfirm(true)
    const v = await drawRoadmap('eng')
    await v.clickDay(1)
    expect(v.countText(IN_PROGRESS.scopeLabel), '進行中の案内が出ていない（この検査は空振りになる）').toBe(1)
    await v.toggleTier(1)
    expect(v.countText(IN_PROGRESS.scopeLabel), '絞り込みで進行中の案内が消えている').toBe(1)
    expect(v.buttons().some((b) => /再開/.test(b.textContent ?? '')), '再開の選択肢が消えている').toBe(true)
    await v.close()
  })
})

describe('印を持たない学び（UC-009）', () => {
  // @covers REQ-285#no-tier-on-roadmap
  it('印を持たない学びのロードマップには、単位の印も印の絞り込みも出ない', async () => {
    stubApi({ units: [...UNITS, EXTRA] })
    const v = await drawRoadmap()
    expect(v.text(), '描けていない（この検査は空振りになる）').toContain('単位 1 の名前')
    for (const t of TIERS) expect(v.text(), `印の語「${t.label}」が出ている`).not.toContain(t.label)
    expect(v.text(), '印が出ている').not.toContain('★')
    expect(
      v.host.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"], [aria-pressed]'),
      '印の絞り込みの操作が出ている',
    ).toHaveLength(0)
    await v.close()
  })
})
