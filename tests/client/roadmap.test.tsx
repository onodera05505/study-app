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
 *  inProgress を立てると「進行中のテストが 1 つある」サーバになり、作成は 409、
 *  進行中の問い合わせはその行を返す。破棄（DELETE）が通ったあとは進行中が無い状態へ移る。
 *  startFails は進行中の有無以外の理由で作成を断る側（REQ-276）。'network' は通信そのものが届かない。
 *  返り値の recover() で fail を解き、取り直しが成功する状態へ移せる。 */
function stubApi(
  opts: {
    units?: Unit[]
    fail?: string[]
    inProgress?: boolean
    gone?: boolean
    startFails?: 'network' | { status: number; error: string }
  } = {},
) {
  calls = []
  let discarded = false
  let raced = opts.gone === true
  let failing = [...(opts.fail ?? [])]
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    const method = init?.method ?? 'GET'
    calls.push({ url: url.pathname + url.search, method })
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
    if (url.pathname.endsWith('/topics')) body = { topics: opts.units ?? UNITS }
    else if (url.pathname.endsWith('/exams')) body = EXAMS
    else if (url.pathname.endsWith('/me')) body = ME
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
  /** 「この日の確認」のボタン。日ごとに 1 つで、文書の順＝日の順に並ぶ。 */
  const dayButtons = () =>
    [...host.querySelectorAll<HTMLElement>('button, summary, [role="button"]')].filter((b) =>
      /この日の確認/.test(b.textContent ?? ''),
    )
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
    dayButtons,
    buttons: () => [...host.querySelectorAll<HTMLElement>('button, [role="button"]')],
    /** 押せなくされている日（disabled か aria-disabled）。 */
    disabledDays: () =>
      dayButtons().filter(
        (b) => (b as HTMLButtonElement).disabled === true || b.getAttribute('aria-disabled') === 'true',
      ),
    /** n 日目（1 起点）の「この日の確認」を押す。 */
    clickDay: async (n: number) => {
      const b = dayButtons()[n - 1]
      if (!b) throw new Error(`${n} 日目の「この日の確認」が画面に無い`)
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
      const body = host.textContent ?? ''
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
    countText: (needle: string) => (host.textContent ?? '').split(needle).length - 1,
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
