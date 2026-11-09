// @vitest-environment jsdom
/** ロードマップの画面（src/client/pages/Roadmap.tsx）の、単位の行の示し方と先頭の導線。UC-009
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、描くたびに差し替えて読み込み直す。
 *  ロードマップ型ではロードマップが `/topics` に載る。日で束ねる学びの手本は itc、章で束ねて印を持つ学びの手本は eng。
 *  回の語・印の語は登録簿 src/shared/targets.json、段階の名前は src/client/lib/api.ts の STATUS_LABEL が正本（BR-045）。
 *  論点の並びの項目は UC-002 の契約 listTopics の形（subtitle・round・roundLabel・tier を含む）。
 *  理解度は 1=未理解・2=やや理解・3=理解、記録なしは null。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import targets from '../../src/shared/targets.json'
import { STATUS_LABEL, setLastTopic } from '../../src/client/lib/api'

type Unit = Record<string, unknown>
type Target = 'itc' | 'eng'

const TIERS = (
  targets as unknown as { eng: { roadmapSpec: { tiers: { level: number; label: string }[] } } }
).eng.roadmapSpec.tiers
const tierLabel = (level: number) => {
  const t = TIERS.find((x) => x.level === level)
  if (!t) throw new Error(`登録簿に印の段 ${level} が無い`)
  return t.label
}

/** 段階の名前（BR-045 の正本から読む）。 */
const stageName = (status: number) => {
  const v = (STATUS_LABEL as unknown as Record<number, unknown>)[status]
  if (typeof v !== 'string' || !v) throw new Error(`STATUS_LABEL に段階 ${status} の名前が無い`)
  return v
}
const STAGES = [1, 2, 3]

/** 日で束ねる学び（itc）の単位。1 日 3 単位（登録簿の値）で属する日を決める。 */
const unit = (n: number, status: number | null, subtitle: string | null = null, term = `単位 ${n} の名前`): Unit => {
  const day = Math.ceil(n / 3)
  return {
    id: 100 + n,
    term,
    subtitle,
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

const SUB2 = '二つ目の単位に添える言葉'
const PAREN_TERM = '単位 4 の名前（括弧の中も名前）'

/** 7 単位。1〜3 が理解。最初の未理解は 4 番（括弧書きを含む名前・副題なし）。2 番だけ副題を持つ。
 *  3 日目は 1 単位だけ。status は 1・2・3・null をすべて含む。 */
const UNITS: Unit[] = [
  unit(1, 3),
  unit(2, 3, SUB2),
  unit(3, 3),
  unit(4, 1, null, PAREN_TERM),
  unit(5, null),
  unit(6, 2),
  unit(7, 1),
]

const EXAMS = {
  exams: [
    { exam: 'itc-d01', examLabel: '1 日目', questions: 6, attempts: 0, bestScore: null },
    { exam: 'itc-d02', examLabel: '2 日目', questions: 6, attempts: 0, bestScore: null },
    { exam: 'itc-d03', examLabel: '3 日目', questions: 6, attempts: 0, bestScore: null },
  ],
}

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 7, understood: 3, partly: 1 },
  recentSessions: [],
  nextTopics: [],
  visits: { today: '2026-09-29', streak: 13, longest: 13, total: 13 },
}

/** 章で束ねて印を持つ学び（eng）の章。章の名前に数字を入れない。 */
const CHAPTERS = [
  { round: 'eng-c01', no: 1, name: '甲の章' },
  { round: 'eng-c02', no: 2, name: '乙の章' },
  { round: 'eng-c03', no: 3, name: '丙の章' },
]

const SUB_ENG = '章の単位に添える言葉'

const chapterUnit = (
  id: number,
  sortOrder: number,
  chapter: number,
  tier: number,
  status: number | null,
  subtitle: string | null = null,
): Unit => {
  const c = CHAPTERS[chapter - 1]
  return {
    id,
    term: `章の単位 ${id}`,
    subtitle,
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

/** 章ごとに単位の数が違う（2・4・1）。印は登録簿の段を巡る。303 が副題を持つ。 */
const ENG_UNITS: Unit[] = [
  chapterUnit(301, 1, 1, TIERS[0].level, 3),
  chapterUnit(302, 2, 1, TIERS[TIERS.length - 1].level, 3),
  chapterUnit(303, 3, 2, TIERS[0].level, 1, SUB_ENG),
  chapterUnit(304, 4, 2, TIERS[1 % TIERS.length].level, null),
  chapterUnit(305, 5, 2, TIERS[2 % TIERS.length].level, 3),
  chapterUnit(306, 6, 2, TIERS[0].level, 2),
  chapterUnit(307, 7, 3, TIERS[TIERS.length - 1].level, 1),
]

const SUB_EXTRA = '補足の単位に添える言葉'
const ENG_EXTRA: Unit = {
  id: 400,
  term: '章の補足の単位',
  subtitle: SUB_EXTRA,
  questionCount: 1,
  status: null,
  field: '補足（ロードマップ外）',
  middle: 'ロードマップ外',
  itemName: 'ロードマップ外',
  isNew: 0,
  sortOrder: null,
  round: 'eng-ex',
  roundLabel: '補足（ロードマップ外）',
  tier: TIERS[0].level,
}

const ENG_EXAMS = {
  exams: [
    { exam: 'eng-c01', examLabel: '第 1 章 甲の章', questions: 2, attempts: 0, bestScore: null },
    { exam: 'eng-c02', examLabel: '第 2 章 乙の章', questions: 4, attempts: 0, bestScore: null },
    { exam: 'eng-c03', examLabel: '第 3 章 丙の章', questions: 1, attempts: 0, bestScore: null },
  ],
}

const ENG_ME = { ...ME, topics: { total: 8, understood: 3, partly: 1 } }

/** 回の見出しの形（登録簿の語の形。REQ-279）。 */
const DAY_HEADINGS = ['1 日目', '2 日目', '3 日目']
const CHAPTER_HEADINGS = CHAPTERS.map((c) => `第 ${c.no} 章`)

/** 回ごとの確認の入口の語（登録簿の語。REQ-280）。 */
const ROUND_WORD = /この(日|章)の確認/

function stubApi(opts: { target?: Target; units?: Unit[] } = {}) {
  const eng = opts.target === 'eng'
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    let body: unknown = {}
    if (url.pathname.endsWith('/topics')) body = { topics: opts.units ?? (eng ? ENG_UNITS : UNITS) }
    else if (url.pathname.endsWith('/exams')) body = eng ? ENG_EXAMS : EXAMS
    else if (url.pathname.endsWith('/me')) body = eng ? ENG_ME : ME
    else if (url.pathname.endsWith('/sessions/current')) body = { session: null }
    else if (url.pathname.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** 読み上げで得られる文字。aria-hidden="true" と hidden の部分木は読まず、aria-label を持つ要素はその値で読む。 */
function spoken(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof Element)) return ''
  if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden')) return ''
  const label = node.getAttribute('aria-label')
  if (label) return ` ${label} `
  return [...node.childNodes].map(spoken).join('')
}

/** 畳まれた details の中身（summary 以外）か。 */
const insideClosedDetails = (n: Node) => {
  const el = n instanceof Element ? n : n.parentElement
  const d = el?.closest('details')
  return !!d && !d.open && !el?.closest('summary')
}

async function drawRoadmap(target: Target = 'itc') {
  vi.stubEnv('VITE_EXAM', target)
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter, Route, Routes } = await import('react-router-dom')
  const { Roadmap } = await import('../../src/client/pages/Roadmap')
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
          Routes,
          null,
          h(Route, { path: '/topics', element: h(Roadmap) }),
          h(Route, { path: '/topics/:id', element: h('div', null, '単位の画面') }),
        ),
      ),
    )
  })
  const headings = target === 'eng' ? CHAPTER_HEADINGS : DAY_HEADINGS
  /** 文書の順で最初に回の見出しの語が出る文字の節（畳まれた中身は除く）。 */
  const headingNode = (k: number) => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (insideClosedDetails(n)) continue
      if ((n.textContent ?? '').includes(headings[k])) return n
    }
    throw new Error(`回の見出し「${headings[k]}」が画面に無い`)
  }
  const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  const topicLinks = () =>
    [...host.querySelectorAll('a')].filter((a) => /^\/topics\/\d+$/.test(a.getAttribute('href') ?? ''))
  /** 最初の回の見出しより前にある、論点へ移る導線。 */
  const headLinks = () => {
    const first = headingNode(0)
    return topicLinks().filter((a) => before(a, first))
  }
  /** 並びの中の単位 id の導線（最初の回の見出しより後ろの最後の出現。補足の別枠も含む）。 */
  const unitLink = (id: number) => {
    const first = headingNode(0)
    const found = topicLinks().filter((a) => a.getAttribute('href') === `/topics/${id}` && before(first, a))
    const a = found[found.length - 1]
    if (!a) throw new Error(`単位 ${id} への導線が並びに無い`)
    return a
  }
  /** 単位の行。一覧の 1 項目（li・tr・role="listitem"）、無ければ単位の導線そのもの。 */
  const row = (id: number) => {
    const a = unitLink(id)
    return (a.closest('li, tr, [role="listitem"]') ?? a) as HTMLElement
  }
  return {
    host,
    text: () => host.textContent ?? '',
    headingNode,
    before,
    headLinks,
    unitLink,
    row,
    rowText: (id: number) => row(id).textContent ?? '',
    entries: () =>
      [...host.querySelectorAll<HTMLElement>('button, summary, [role="button"], a')].filter((b) =>
        ROUND_WORD.test(b.textContent ?? ''),
      ),
    act: React.act,
    close: async () => {
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
}
type View = Awaited<ReturnType<typeof drawRoadmap>>

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** 行の中で、文字がちょうど text の要素。 */
const elementExactly = (row: HTMLElement, text: string) =>
  [row, ...row.querySelectorAll<HTMLElement>('*')].filter((el) => norm(el.textContent) === norm(text))

describe('単位の名前と副題（UC-009）', () => {
  // @covers REQ-415#name-and-subtitle-apart
  it('副題を持つ単位の行で、名前と副題がそれぞれ別の要素として出て、副題が名前の後ろに出る', async () => {
    const cases: Array<{ target: Target; id: number; term: string; subtitle: string; units?: Unit[] }> = [
      { target: 'itc', id: 102, term: '単位 2 の名前', subtitle: SUB2 },
      { target: 'eng', id: 303, term: '章の単位 303', subtitle: SUB_ENG },
      { target: 'eng', id: 400, term: '章の補足の単位', subtitle: SUB_EXTRA, units: [...ENG_UNITS, ENG_EXTRA] },
    ]
    for (const c of cases) {
      stubApi({ target: c.target, units: c.units })
      const v = await drawRoadmap(c.target)
      const r = v.row(c.id)
      const names = elementExactly(r, c.term)
      expect(names.length, `${c.target} 単位 ${c.id}: 名前だけの要素が無い（名前と副題が分かれていない）`).toBeGreaterThan(0)
      const name = names[names.length - 1]
      const subs = [...r.querySelectorAll<HTMLElement>('*')].filter(
        (el) => norm(el.textContent).includes(c.subtitle) && !norm(el.textContent).includes(c.term),
      )
      expect(subs.length, `${c.target} 単位 ${c.id}: 名前を含まない副題の要素が無い`).toBeGreaterThan(0)
      expect(v.before(name, subs[0]), `${c.target} 単位 ${c.id}: 副題が名前の後ろに出ていない`).toBe(true)
      await v.close()
    }
  })

  // @covers REQ-415#name-only
  it('副題を持たない単位の行には名前だけが 1 つの要素として出て、副題の代わりの文字が出ない（括弧書きの名前も切り出さない）', async () => {
    const cases: Array<{ target: Target; id: number; term: string }> = [
      { target: 'itc', id: 101, term: '単位 1 の名前' },
      { target: 'itc', id: 104, term: PAREN_TERM },
      { target: 'eng', id: 304, term: '章の単位 304' },
    ]
    for (const c of cases) {
      stubApi({ target: c.target })
      const v = await drawRoadmap(c.target)
      const r = v.row(c.id)
      expect(elementExactly(r, c.term).length, `${c.target} 単位 ${c.id}: 名前がそのまま 1 つの要素として出ていない`).toBeGreaterThan(0)
      const t = r.textContent ?? ''
      for (const bad of ['null', 'undefined', '（）', '()'])
        expect(t, `${c.target} 単位 ${c.id}: 副題の代わりに「${bad}」が出ている`).not.toContain(bad)
      await v.close()
    }
  })
})

/** 学び方の説明の開く操作（summary か aria-expanded を持つ操作で、学び方の説明の語を持つもの）。 */
function guideToggle(host: HTMLElement) {
  const cands = [...host.querySelectorAll<HTMLElement>('summary, [aria-expanded]')].filter((el) =>
    `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.includes('学び方'),
  )
  if (!cands.length) throw new Error('学び方の説明を開く操作（畳んだ説明）が画面に無い')
  return cands[0]
}
const isOpen = (t: HTMLElement) =>
  t.tagName === 'SUMMARY' ? !!t.closest('details')?.open : t.getAttribute('aria-expanded') === 'true'
/** 説明の中身の文字（details なら summary を除いた文字、aria-controls なら指す要素の文字）。 */
function guideBody(host: HTMLElement, t: HTMLElement): string | null {
  if (t.tagName === 'SUMMARY') {
    const d = t.closest('details')!
    return norm((d.textContent ?? '').replace(t.textContent ?? '', ''))
  }
  const id = t.getAttribute('aria-controls')
  const el = id ? host.ownerDocument.getElementById(id) : null
  if (!el) return null
  return el.hidden || el.closest('[hidden]') ? '' : norm(el.textContent)
}

describe('学び方の説明（UC-009）', () => {
  // @covers REQ-417#collapsed-on-open
  it('ロードマップを開いた直後、学び方の説明は開く操作だけが見え、中身は畳まれている', async () => {
    for (const target of ['itc', 'eng'] as Target[]) {
      stubApi({ target })
      const v = await drawRoadmap(target)
      const t = guideToggle(v.host)
      expect(isOpen(t), `${target}: 開いた直後に学び方の説明が開いている`).toBe(false)
      const body = guideBody(v.host, t)
      if (body !== null && t.tagName !== 'SUMMARY')
        expect(body, `${target}: 畳んでいるのに中身が見えている`).toBe('')
      await v.close()
    }
  })

  // @covers REQ-417#expanded-on-user-open
  it('利用者が開く操作をしたときに、学び方の説明の中身が出る', async () => {
    for (const target of ['itc', 'eng'] as Target[]) {
      stubApi({ target })
      const v = await drawRoadmap(target)
      const t = guideToggle(v.host)
      const before = v.text()
      await v.act(async () => {
        t.click()
      })
      const t2 = guideToggle(v.host)
      expect(isOpen(t2), `${target}: 開く操作をしても開いていない`).toBe(true)
      const body = guideBody(v.host, t2)
      const shown = body ?? norm(v.text().length > before.length ? v.text() : '')
      expect(shown.length, `${target}: 開いても学び方の説明の中身が無い`).toBeGreaterThan(0)
      await v.close()
    }
  })
})

describe('回の見出しの語を単位に繰り返さない（UC-009）', () => {
  // @covers REQ-418#day-word-not-in-unit
  it('日で束ねる学びで、各単位の行にその日の見出しの語（〇日目）が出ない', async () => {
    stubApi()
    const v = await drawRoadmap('itc')
    for (const u of UNITS) {
      const day = String(u.roundLabel).match(/\d+/)![0]
      expect(v.rowText(Number(u.id)), `単位 ${u.id} の行に「${u.roundLabel}」が繰り返されている`).not.toMatch(
        new RegExp(`${day}\\s*日目`),
      )
    }
    await v.close()
  })

  // @covers REQ-418#chapter-word-and-name-not-in-unit
  it('章で束ねる学びで、各単位の行に章の見出しの語（第 n 章）も章の名前も出ない', async () => {
    stubApi({ target: 'eng' })
    const v = await drawRoadmap('eng')
    for (const u of ENG_UNITS) {
      const c = CHAPTERS.find((x) => x.round === u.round)!
      const t = v.rowText(Number(u.id))
      expect(t, `単位 ${u.id} の行に章の見出しの語が繰り返されている`).not.toMatch(new RegExp(`第\\s*${c.no}\\s*章`))
      expect(t, `単位 ${u.id} の行に章の名前「${c.name}」が繰り返されている`).not.toContain(c.name)
    }
    await v.close()
  })
})

describe('回ごとの確認の入口の位置（UC-009）', () => {
  /** 回 k の入口が、その回の最後の単位より後ろ、次の回の最初の単位より前にあるか。 */
  const check = (v: View, units: Unit[], rounds: string[]) => {
    const entries = v.entries()
    expect(entries, '回ごとの確認の入口が回の数だけ無い').toHaveLength(rounds.length)
    rounds.forEach((round, k) => {
      const own = units.filter((u) => u.round === round).map((u) => v.unitLink(Number(u.id)))
      const next = units.filter((u) => u.round === rounds[k + 1]).map((u) => v.unitLink(Number(u.id)))
      for (const a of own)
        expect(v.before(a, entries[k]), `${round} の入口が、その回の単位 ${a.getAttribute('href')} より前にある`).toBe(true)
      for (const a of next)
        expect(v.before(entries[k], a), `${round} の入口が、次の回の単位 ${a.getAttribute('href')} より後ろにある`).toBe(true)
    })
  }

  // @covers REQ-419#entry-after-own-units
  it('各回の回ごとの確認の入口が、その回の最後の単位より後ろ、次の回の最初の単位より前に出る', async () => {
    stubApi()
    const itc = await drawRoadmap('itc')
    check(itc, UNITS, ['itc-d01', 'itc-d02', 'itc-d03'])
    await itc.close()
    stubApi({ target: 'eng' })
    const eng = await drawRoadmap('eng')
    check(eng, ENG_UNITS, CHAPTERS.map((c) => c.round))
    await eng.close()
  })
})

/** その段階の名前が出ていて、自分の名前の一部でないほかの段階の名前が出ていないか。 */
const expectStage = (spokenText: string, status: number, where: string) => {
  const mine = stageName(status)
  expect(spokenText, `${where}: 段階の名前「${mine}」が読み上げで得られない`).toContain(mine)
  for (const other of STAGES.filter((s) => s !== status).map(stageName))
    if (!mine.includes(other))
      expect(spokenText, `${where}: ほかの段階の名前「${other}」が出ている`).not.toContain(other)
}

describe('単位の理解度の段階の名前（UC-009）', () => {
  // @covers REQ-420#stage-name-per-status
  it('理解度の記録が 1・2・3 の単位の行に、その段階の名前が出て、ほかの段階の名前は出ない', async () => {
    for (const target of ['itc', 'eng'] as Target[]) {
      stubApi({ target })
      const v = await drawRoadmap(target)
      const units = target === 'eng' ? ENG_UNITS : UNITS
      for (const s of STAGES) {
        const us = units.filter((u) => u.status === s)
        expect(us.length, `仕込み: ${target} に段階 ${s} の単位が無い`).toBeGreaterThan(0)
        for (const u of us) expectStage(spoken(v.row(Number(u.id))), s, `${target} 単位 ${u.id}`)
      }
      await v.close()
    }
  })

  // @covers REQ-420#no-record-as-unlearned
  it('理解度の記録が無い単位の行に、未理解の段階の名前が出る', async () => {
    for (const target of ['itc', 'eng'] as Target[]) {
      stubApi({ target })
      const v = await drawRoadmap(target)
      const units = (target === 'eng' ? ENG_UNITS : UNITS).filter((u) => u.status === null)
      expect(units.length, `仕込み: ${target} に記録の無い単位が無い`).toBeGreaterThan(0)
      for (const u of units) expectStage(spoken(v.row(Number(u.id))), 1, `${target} 単位 ${u.id}`)
      await v.close()
    }
  })
})

describe('印の読み上げの名前（UC-009）', () => {
  // @covers REQ-282#tier-label-as-accessible-name
  it('各単位の印が、読み上げで得られる文字として登録簿の印の語を持つ', async () => {
    stubApi({ target: 'eng', units: [...ENG_UNITS, ENG_EXTRA] })
    const v = await drawRoadmap('eng')
    for (const u of [...ENG_UNITS, ENG_EXTRA])
      expect(spoken(v.row(Number(u.id))), `単位 ${u.id} の印「${tierLabel(Number(u.tier))}」が読み上げで得られない`).toContain(
        tierLabel(Number(u.tier)),
      )
    await v.close()
  })
})

describe('先頭の導線（並びに無い前回の続き・1 つだけ）（UC-009）', () => {
  const GONE = { id: 999, term: 'もう並びに無い単位', middle: 'コンサルの仕事', middleNo: 1 }

  // @covers REQ-144#last-topic-gone-falls-to-here
  it('前回の続きの論点が並びにもう無く、未理解の論点があるときは、その論点を指さず「ここから」の論点を行き先にする', async () => {
    stubApi()
    setLastTopic(GONE)
    const v = await drawRoadmap()
    const head = v.headLinks()
    expect(head.length, '先頭に論点へ移る導線が無い').toBeGreaterThan(0)
    expect(head[0].getAttribute('href'), '行き先が「ここから」の単位（104）でない').toBe('/topics/104')
    expect(v.text(), '並びに無い前回の続きの名前が出ている').not.toContain(GONE.term)
    expect(v.host.querySelector('a[href="/topics/999"]'), '並びに無い論点への導線がある').toBeNull()
    await v.close()
  })

  // @covers REQ-144#last-topic-gone-falls-to-list-head
  it('前回の続きの論点が並びにもう無く、未理解の論点も無いときは、学ぶ順で最初の論点を行き先にする', async () => {
    const allUnderstood = UNITS.map((u) => ({ ...u, status: 3 })).reverse()
    stubApi({ units: allUnderstood })
    setLastTopic(GONE)
    const v = await drawRoadmap()
    const head = v.headLinks()
    expect(head.length, '先頭に論点へ移る導線が無い').toBeGreaterThan(0)
    expect(head[0].getAttribute('href'), '行き先が学ぶ順で最初の単位（101）でない').toBe('/topics/101')
    expect(v.host.querySelector('a[href="/topics/999"]'), '並びに無い論点への導線がある').toBeNull()
    await v.close()
  })

  // @covers REQ-144#single-head-link
  it('最初の回の見出しより前に置かれる論点へ移る導線は、前回の続きがあるときも無いときも続きの導線の 1 つだけ', async () => {
    const cases: Array<{ last: Parameters<typeof setLastTopic>[0] | null; to: string }> = [
      { last: { id: 102, term: '単位 2 の名前', middle: 'コンサルの仕事', middleNo: 1 }, to: '/topics/102' },
      { last: null, to: '/topics/104' },
    ]
    for (const c of cases) {
      localStorage.clear()
      stubApi()
      if (c.last) setLastTopic(c.last)
      const v = await drawRoadmap()
      const head = v.headLinks()
      expect(
        head.map((a) => a.getAttribute('href')),
        `前回の続き ${c.last ? 'あり' : 'なし'}: 先頭の論点へ移る導線が 1 つだけでない`,
      ).toEqual([c.to])
      await v.close()
    }
  })
})
