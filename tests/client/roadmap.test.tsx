// @vitest-environment jsdom
/** ロードマップの画面（src/client/pages/Roadmap.tsx）。ロードマップ型の対象で描く。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、テストごとに差し替えて読み込み直す。
 *  ロードマップ型ではロードマップが `/topics` に載る（`/roadmap` という経路は無い）。
 *  1 日の単位数（itc は 3）と 1 回の問題数（6）は登録簿 src/shared/targets.json の値。
 *  理解度は 1=未理解・2=やや理解・3=理解、記録なしは null。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLastTopic } from '../../src/client/lib/api'

type Unit = Record<string, unknown>

const unit = (n: number, status: number | null) => ({
  id: 100 + n,
  term: `単位 ${n} の名前`,
  questionCount: 2,
  status,
  field: '業界と仕事',
  middle: 'コンサルの仕事',
  itemName: 'コンサルの仕事',
  isNew: 0,
  sortOrder: n,
})

/** 7 単位。1〜4 が理解（status 3）。1 日 3 単位なので 1 日目は全部理解、
 *  いま学ぶ位置（status が 3 でない最初の単位）は 5 番。 */
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
}

const EXAMS = {
  exams: [
    { exam: 'itc-d1', examLabel: '1 日目', questions: 6, attempts: 2, bestScore: 5 },
    { exam: 'itc-d2', examLabel: '2 日目', questions: 6, attempts: 0, bestScore: null },
    { exam: 'itc-d3', examLabel: '3 日目', questions: 6, attempts: 0, bestScore: null },
  ],
}

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 7, understood: 4, partly: 0 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 13, longest: 13, total: 13 },
}

let calls: Array<{ url: string; method: string }>

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

/** UC-008 の契約 startMockExam の CONFLICT（409）の本文。sessions の行を inProgress に添える形で、
 *  回答済みの数は入らない（進み具合は UC-006 の getCurrentSession が持つ）。
 *  error の文は仕様が決めていないので、契約のエラーコードだけを置く。案内の文はここから採らせない。 */
const CONFLICT_BODY = (() => {
  const { answered: _answered, ...row } = IN_PROGRESS
  return { error: 'CONFLICT', inProgress: row }
})()

/** 応答を決める偽の fetch。fail に入れた path は 500。
 *  inProgress を立てると「進行中のテストが 1 つある」サーバになり、作成は 409、
 *  進行中の問い合わせはその行を返す。破棄（DELETE）が通ったあとは進行中が無い状態へ移る。 */
function stubApi(opts: { units?: Unit[]; fail?: string[]; inProgress?: boolean } = {}) {
  calls = []
  let discarded = false
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = init?.method ?? 'GET'
    calls.push({ url: url.pathname + url.search, method })
    if ((opts.fail ?? []).some((f) => url.pathname.endsWith(f)))
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: '単位の一覧を取得できませんでした' }),
      }
    const inProgress = opts.inProgress === true && !discarded
    if (method === 'DELETE' && url.pathname.endsWith('/sessions/current')) {
      discarded = true
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    }
    if (method === 'POST' && url.pathname.endsWith('/sessions')) {
      if (inProgress)
        return { ok: false, status: 409, text: async () => JSON.stringify(CONFLICT_BODY) }
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({ id: 's-new', kind: 'mock', scopeLabel: '2 日目', questionCount: 6, timeLimitSec: null }),
      }
    }
    let body: unknown = {}
    if (url.pathname.endsWith('/topics')) body = { topics: opts.units ?? UNITS }
    else if (url.pathname.endsWith('/exams')) body = EXAMS
    else if (url.pathname.endsWith('/me')) body = ME
    else if (url.pathname.endsWith('/sessions/current')) body = { session: inProgress ? IN_PROGRESS : null }
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
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

/** VITE_EXAM をロードマップ型にしてから読み込み、描いた画面を返す。 */
async function drawRoadmap() {
  vi.stubEnv('VITE_EXAM', 'itc')
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
  const links = () => [...host.querySelectorAll('a')]
  return {
    host,
    text: () => host.textContent ?? '',
    /** いま開いている場所（/sessions/s-7 のような id つきの経路まで）。 */
    path: () => ((host.textContent ?? '').match(/PATH:([^|]*)\|/) ?? [])[1] ?? '',
    lead: () => host.querySelector('p.lead')?.textContent ?? '',
    links,
    /** 一覧の中の「ここから」の印。 */
    hereLabels: () => [...host.querySelectorAll('span.rm-here-label')],
    linkTo: (to: string) => links().find((a) => a.getAttribute('href') === to),
    /** 単位の行のあたりの文字（印が行に付いているかを見る。上に 2 段まで辿る）。 */
    rowText: (id: number) => {
      const a = links().find((x) => x.getAttribute('href') === `/topics/${id}`)
      if (!a) throw new Error(`単位 ${id} への導線が画面に無い`)
      let el: Element = a
      for (let i = 0; i < 2 && el.parentElement; i++) el = el.parentElement
      return el.textContent ?? ''
    },
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

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('1 日ごとの並び', () => {
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

describe('先頭の 1 行', () => {
  // @covers REQ-131#understood-count-and-total
  it('理解した単位数と全単位数、連続日数を出す', async () => {
    stubApi()
    const v = await drawRoadmap()
    expect(v.lead()).toContain('1 日 3 単位')
    expect(v.lead()).toContain('全 3 日')
    expect(v.lead()).toContain('連続 13 日')
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

  /** 押したあとに画面へ増えた文（確かめが画面の中に出る作りでも読めるように、前後の差を採る）。 */
  const addedText = (before: string, after: string) => {
    let s = 0
    while (s < before.length && before[s] === after[s]) s++
    let e = 0
    while (e < before.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++
    return after.slice(s, after.length - e)
  }

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

  // @covers REQ-143#in-progress-blocks
  it('作成が 409 のときは、その場で進行中の案内を出し、日ごとの並びを残したまま移らない', async () => {
    stubApi({ inProgress: true })
    stubConfirm(true)
    const v = await drawRoadmap()
    await v.click('この日の確認')
    expect(countOf('/sessions', 'POST'), '作成をサーバに求めていない').toBe(1)
    // 文言は仕様が決めていないので、進行中のテストを指す語が出ることだけを見る
    expect(v.text(), '進行中のテストの案内が出ていない').toMatch(/進行中のテスト/)
    expect(v.text(), '出題の画面へ移っている').not.toContain('出題の画面')
    // その場＝ロードマップのまま。並びの取得が失敗したときと同じ描画に落ちていない
    for (const day of ['1 日目', '2 日目', '3 日目'])
      expect(v.text(), `日ごとの見出し「${day}」が消えている`).toContain(day)
    expect(v.text(), '並びの先頭の単位が消えている').toContain('単位 1 の名前')
    expect(v.text(), '並びの末尾の単位が消えている').toContain('単位 7 の名前')
    expect(v.text(), '案内を出した場所の「この日の確認」が消えている').toContain('この日の確認')
    await v.close()
  })

  // @covers REQ-143#in-progress-shows-scope-and-progress
  it('進行中のテストの範囲と、回答済み／全体の問数を、押した日のその場に出す', async () => {
    stubApi({ inProgress: true })
    stubConfirm(true)
    const v = await drawRoadmap()
    const before = v.text()
    await v.click('この日の確認')
    // 押したことで増えた文＝その場に出た案内。どこへ出すかの形は仕様が決めていないので位置では見ない
    const shown = addedText(before, v.text())
    expect(shown, '進行中のテストの範囲が案内に出ていない').toContain(IN_PROGRESS.scopeLabel)
    // 2 つの数が並んで出ることだけを見る（どちらを先に書くか・区切りの文字は仕様が決めていない）
    const { answered, questionCount } = IN_PROGRESS
    expect(shown, '回答済みと全体の問数が案内に出ていない').toMatch(
      new RegExp(`(${answered}\\D{0,12}${questionCount}|${questionCount}\\D{0,12}${answered})`),
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
  it('進み具合が取れなくても、範囲と全体の問数を示し、再開・破棄は選べる', async () => {
    // 作成は 409（進行中あり）だが、進み具合の問い合わせだけが取れない
    stubApi({ inProgress: true, fail: ['/sessions/current'] })
    stubConfirm(true)
    const v = await drawRoadmap()
    const before = v.text()
    await v.click('この日の確認')
    const row = CONFLICT_BODY.inProgress
    const shown = addedText(before, v.text())
    // 409 の本文にあるものは示せる（進み具合の問い合わせに頼らない）
    expect(shown, '進行中のテストの範囲が案内に出ていない').toContain(row.scopeLabel)
    expect(shown, '進行中のテストの全体の問数が案内に出ていない').toMatch(
      new RegExp(`${row.questionCount}\\s*問|問\\D{0,6}${row.questionCount}`),
    )
    // 取れていない進み具合を、取れたかのように回答済み／全体の形で出さない
    expect(shown, '取れていない回答済みの数を示している').not.toMatch(
      new RegExp(`${IN_PROGRESS.answered}\\D{0,8}${row.questionCount}`),
    )
    // 条件は「進行中のテストがある」だけなので、取れなくても選べる
    expect(v.text(), '再開が選べない').toMatch(/再開/)
    expect(v.text(), '破棄が選べない').toMatch(/破棄/)
    await v.click('再開')
    expect(v.path(), '進行中のテストの出題の画面へ移っていない').toMatch(
      new RegExp(`^/sessions/${row.id}$`),
    )
    await v.close()
  })
})

describe('先頭の導線', () => {
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

describe('取れなかったとき', () => {
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
