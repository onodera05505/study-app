// @vitest-environment jsdom
/** 論点の画面（src/client/pages/TopicDetail.tsx）の理解度の操作の、選択肢の名前と選ばれている形。UC-003
 *
 *  学びの種類によらない決まりなので、資格対策（ip）とロードマップ型（itc）の両方で描く。対象は読み込み時に決まる
 *  （VITE_EXAM）ので、描くたびに差し替えて読み込み直す。段階の名前は src/client/lib/api.ts の STATUS_LABEL が正本（BR-045）。
 *  選択肢は押せる・選べる要素（button・input・role="radio" など）のうち、読み上げで得られる名前に段階の名前を持つもの。
 *  選ばれている形は aria-pressed・aria-checked・aria-selected・aria-current・checked のどれか。
 *  選ばれている選択肢は、ロードマップ型では今記録されている段階（記録が無ければ未理解。BR-029）、
 *  資格対策では今示している理解度の段階（回答の履歴からの判定か本人の上書き。未のときはどれでもない。BR-050）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STATUS_LABEL } from '../../src/client/lib/api'

type Target = 'ip' | 'itc'
const TARGETS: Target[] = ['ip', 'itc']
const STAGES = [1, 2, 3]

const stageName = (status: number) => {
  const v = (STATUS_LABEL as unknown as Record<number, unknown>)[status]
  if (typeof v !== 'string' || !v) throw new Error(`STATUS_LABEL に段階 ${status} の名前が無い`)
  return v
}

type Source = 'auto' | 'override' | null

const detail = (target: Target, status: number | null, statusSource: Source) => ({
  topic: {
    id: 231,
    term: '論点 231 の名前',
    subtitle: null,
    explanation: '短い説明の本文です。',
    detail: null,
    questionCount: target === 'ip' ? 4 : 0,
    frequencyTier: target === 'ip' ? 3 : null,
    isNew: 0,
    status,
    statusSource,
    field: target === 'ip' ? 'ストラテジ系' : '業界と仕事',
    major: '大分類',
    middle: '中分類',
    middleNo: 1,
    itemName: '小項目',
    syllabusItemId: 1,
    tier: null,
  },
  questions: [],
  prerequisites: [],
  siblings: [],
  nextTopic: null,
  neighbors: target === 'ip' ? null : { prev: { id: 230, term: '前の単位' }, next: null },
})

function stubApi(target: Target, status: number | null, statusSource: Source = target === 'ip' ? 'auto' : null) {
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost')
    if ((init?.method ?? 'GET') === 'PUT')
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    if (url.pathname.endsWith('/glossary'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ glossary: [] }) }
    if (/\/topics\/\d+$/.test(url.pathname))
      return { ok: true, status: 200, text: async () => JSON.stringify(detail(target, status, statusSource)) }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) }
  })
}

async function drawTopic(target: Target) {
  vi.stubEnv('VITE_EXAM', target)
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter, Route, Routes } = await import('react-router-dom')
  const { TopicDetail } = await import('../../src/client/pages/TopicDetail')
  const h = React.createElement
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/topics/231'] },
        h(
          Routes,
          null,
          h(Route, { path: '/topics/:id', element: h(TopicDetail) }),
          h(Route, { path: '/topics', element: h('div', null, '一覧') }),
        ),
      ),
    )
  })
  return {
    host,
    close: async () => {
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
}

/** 読み上げで得られる文字（aria-hidden の部分木を読まず、aria-label はその値で読む）。 */
function spoken(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof Element)) return ''
  if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden')) return ''
  const label = node.getAttribute('aria-label')
  if (label) return label
  return [...node.childNodes].map(spoken).join('')
}

/** 操作の名前（aria-label・aria-labelledby・結びついた label・中身の順）。 */
function nameOf(el: HTMLElement): string {
  const label = el.getAttribute('aria-label')
  if (label) return label
  const by = el.getAttribute('aria-labelledby')
  if (by)
    return by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .map((x) => (x ? spoken(x) : ''))
      .join(' ')
  if (el instanceof HTMLInputElement) {
    const labels = [...(el.labels ?? [])].map(spoken).join(' ')
    if (labels.trim()) return labels
  }
  return spoken(el)
}

/** その段階の名前を持ち、自分の名前の一部でないほかの段階の名前を持たない名前か。 */
const namesStage = (name: string, status: number) => {
  const mine = stageName(status)
  if (!name.includes(mine)) return false
  return STAGES.filter((s) => s !== status)
    .map(stageName)
    .every((other) => mine.includes(other) || !name.includes(other))
}

const CONTROLS = 'button, input, [role="radio"], [role="button"], [role="option"], [role="menuitemradio"], [role="tab"]'

/** 段階ごとの選択肢（段階の名前を持つ操作）。 */
function choicesOf(host: HTMLElement) {
  const ctrls = [...host.querySelectorAll<HTMLElement>(CONTROLS)]
  return STAGES.map((s) => ({ status: s, els: ctrls.filter((el) => namesStage(nameOf(el), s)) }))
}

const isSelected = (el: HTMLElement) =>
  el.getAttribute('aria-pressed') === 'true' ||
  el.getAttribute('aria-checked') === 'true' ||
  el.getAttribute('aria-selected') === 'true' ||
  (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') ||
  (el instanceof HTMLInputElement && el.checked)

/** 理解度が status のとき、選ばれている段階が expected だけ（null ならどれも選ばれていない）であることを見る。 */
async function expectMarked(target: Target, status: number | null, expected: number | null, statusSource?: Source) {
  stubApi(target, status, statusSource)
  const v = await drawTopic(target)
  const choices = choicesOf(v.host)
  for (const c of choices) {
    expect(c.els, `${target} 理解度 ${status}・${statusSource}: 段階「${stageName(c.status)}」の選択肢がちょうど 1 つない`).toHaveLength(1)
    expect(
      isSelected(c.els[0]),
      `${target} 理解度 ${status}・${statusSource}: 段階「${stageName(c.status)}」の選択肢の選ばれている形が違う`,
    ).toBe(c.status === expected)
  }
  await v.close()
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

describe('理解度の選択肢の名前と選ばれている形（UC-003）', () => {
  // @covers REQ-421#choice-named-by-stage
  it('理解度の 3 つの選択肢のそれぞれが、選ぶと記録される段階の名前を読み上げで得られる名前として持ち、段階ごとにちょうど 1 つある', async () => {
    for (const target of TARGETS) {
      stubApi(target, 2)
      const v = await drawTopic(target)
      for (const c of choicesOf(v.host))
        expect(c.els, `${target}: 名前に段階「${stageName(c.status)}」を持つ選択肢がちょうど 1 つない`).toHaveLength(1)
      await v.close()
    }
  })

  // @covers REQ-421#roadmap-recorded-stage-marked
  it('ロードマップ型で記録が 1・2・3 のとき、その段階の選択肢だけが選ばれている形を持ち、ほかは持たない', async () => {
    for (const s of STAGES) await expectMarked('itc', s, s, null)
  })

  // @covers REQ-421#roadmap-no-record-marks-unlearned
  it('ロードマップ型で記録が無いとき、未理解の選択肢だけが選ばれている形になる', async () => {
    await expectMarked('itc', null, 1, null)
  })

  // @covers REQ-421#exam-shown-stage-marked
  it('資格対策で示している理解度が 1・2・3 のとき、回答の履歴からの判定でも本人の上書きでも、その段階の選択肢だけが選ばれている形を持つ', async () => {
    for (const source of ['auto', 'override'] as const) for (const s of STAGES) await expectMarked('ip', s, s, source)
  })

  // @covers REQ-421#exam-unanswered-marks-none
  it('資格対策で示している理解度が未のとき、どの選択肢も選ばれている形を持たない', async () => {
    await expectMarked('ip', 0, null, 'auto')
  })
})
