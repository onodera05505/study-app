// @vitest-environment jsdom
/** 履歴の画面（完了したテストの一覧と結果への導線・取得前と空と失敗の区別・読み直し）。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { History } from '../../src/client/pages/History'
import { invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const btn = (re: RegExp) => els('button,a,[role="button"]').find((b) => re.test(b.textContent ?? ''))
/** その文字列を持つ、いちばん内側の要素（＝一覧の行）。 */
const innermost = (s: string) =>
  els('*')
    .filter((e) => (e.textContent ?? '').includes(s))
    .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
/** 子要素を持たない要素の文字（画面に出ている文の最小単位）。 */
const leaves = () =>
  els('*')
    .filter((e) => e.children.length === 0)
    .map((e) => (e.textContent ?? '').trim())
    .filter((s) => s !== '')

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown; wait?: Promise<unknown> }

const respond = async (reply: Reply) => {
  if (reply.wait) await reply.wait
  const status = reply.status ?? 200
  return { ok: status < 400, status, text: async () => JSON.stringify(reply.body ?? {}) }
}

function stubApi(reply: Reply) {
  vi.stubGlobal('fetch', async () => respond(reply))
}

/** 受験履歴（/api/sessions）の要求だけ、1 回目は `first`、2 回目からは `then` で応える。
 *  他の要求は空の 200。履歴の要求の回数を返す。 */
function stubHistorySequence(first: Reply, then: Reply) {
  let calls = 0
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string })?.url ?? String(input))
    if (!/\/api\/sessions(\?|$)/.test(url)) return respond({ body: {} })
    calls++
    return respond(calls === 1 ? first : then)
  })
  return () => calls
}

const session = (over: Record<string, unknown>) => ({
  id: 's-1',
  kind: 'field',
  scopeLabel: '分野「テクノロジ系」',
  questionCount: 20,
  correctCount: 15,
  startedAt: 1789000000000,
  finishedAt: 1789003600000,
  sourceExam: null,
  ...over,
})

const HISTORY = { sessions: [session({})] }

const Where = () => h('div', null, `PATH:${useLocation().pathname}`)
const path = () => (text().match(/PATH:(\/\S*)/) ?? [])[1] ?? ''

/** 1 件のテストの中で応答を替えて描き直すので、毎回根を捨てて作り直す（描き直しで取り直させる）。 */
async function draw() {
  await act(async () => {
    root.unmount()
  })
  container.innerHTML = ''
  root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/history'] },
        h(
          Routes,
          null,
          h(Route, { path: '/history', element: h(History) }),
          h(Route, { path: '*', element: h(Where) }),
        ),
      ),
    )
  })
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
  vi.restoreAllMocks()
})

describe('履歴の画面（UC-007）', () => {
  // @covers REQ-095#listed-with-kind-scope-rate-datetime
  it('種別の表示名・範囲・正答率・日時を一覧する', async () => {
    stubApi({ body: HISTORY })
    await draw()
    expect(text()).toContain('分野「テクノロジ系」')
    expect(text(), '種別が内部の値のまま出ている').not.toContain('field')
    expect(text(), '正答率が割合の単位つきで出ていない').toMatch(/75\s*%/)
    expect(text()).toContain('15')
    expect(text()).toContain('20')
    expect(text(), '日時が出ていない').toMatch(/\d{4}[-/年]/)
  })

  // @covers REQ-095#newest-first
  it('締めた時刻の違う複数の締めたテストを、締めた時刻の新しい順に並べる', async () => {
    // 応答は契約どおり新しい順。始めた時刻は逆順にして、締めた時刻で並んでいることを見分ける
    const base = 1789000000000
    stubApi({
      body: {
        sessions: [
          session({ id: 's-3', scopeLabel: '論点「RAID」', startedAt: base + 1000, finishedAt: base + 300000 }),
          session({ id: 's-2', scopeLabel: '単元「基礎理論」', startedAt: base + 2000, finishedAt: base + 200000 }),
          session({ id: 's-1', scopeLabel: '分野「テクノロジ系」', startedAt: base + 3000, finishedAt: base + 100000 }),
        ],
      },
    })
    await draw()
    const at = (label: string) => {
      const i = text().indexOf(label)
      expect(i, `${label} が一覧に無い`).toBeGreaterThanOrEqual(0)
      return i
    }
    expect(at('論点「RAID」')).toBeLessThan(at('単元「基礎理論」'))
    expect(at('単元「基礎理論」')).toBeLessThan(at('分野「テクノロジ系」'))
  })

  // @covers REQ-098#row-opens-result
  it('一覧の 1 件を押すと、そのテストの結果へ移る', async () => {
    stubApi({
      body: {
        sessions: [
          session({ id: 's-9', scopeLabel: '論点「RAID」', finishedAt: 1789090000000 }),
          session({ id: 's-1', scopeLabel: '分野「テクノロジ系」' }),
        ],
      },
    })
    await draw()
    expect(path(), '一覧を出した時点で別の場所へ移っている').toBe('')
    // 2 件のうち 2 行目を選び、移った先が選んだ 1 件（先頭ではない）を指すことを見る
    await click(innermost('分野「テクノロジ系」'), '履歴の行')
    expect(path()).toMatch(/result/)
    expect(path()).toContain('s-1')
    expect(path()).not.toContain('s-9')
  })

  // @covers REQ-099#empty-tells-none
  it('取得前は読み込み中とし、完了したテストが無いときだけ履歴が無いことを伝える', async () => {
    stubApi({ body: HISTORY, wait: new Promise(() => {}) })
    await draw()
    expect(text(), '取得前に読み込み中と分からない').toMatch(/読み込み/)
    expect(text()).not.toContain('分野「テクノロジ系」')

    stubApi({ body: { sessions: [] } })
    await draw()
    expect(text(), '空のときに読み込み中のままになっている').not.toMatch(/読み込み/)
    expect(text(), '空のときに何も伝えていない').not.toBe('')
  })

  // @covers REQ-099#not-yet-fetched-stays-silent
  it('まだ取れていない間は、締めたテストが無いことを示さない', async () => {
    // 「無い」と伝える文 ＝ 0 件のときだけに出て、1 件以上のときには出ない文（文言の正本は画面のコード）
    stubApi({ body: HISTORY })
    await draw()
    const whenListed = new Set(leaves())
    stubApi({ body: { sessions: [] } })
    await draw()
    const noneMessages = leaves().filter((s) => !whenListed.has(s))
    expect(noneMessages, '0 件のときだけに出る文が無く、この検査は空振りになる').not.toHaveLength(0)

    stubApi({ body: HISTORY, wait: new Promise(() => {}) })
    await draw()
    for (const message of noneMessages) {
      expect(text(), `取得前に「${message}」が出ている`).not.toContain(message)
    }
  })

  // @covers REQ-100#fetch-failed-shows-reason-and-reload
  it('取得に失敗したときは理由と読み直しを出す', async () => {
    // サーバーが返す理由は、汎用の失敗の文と取り違えない独自の文にする
    const reason = 'uc007-理由-履歴の保存先が応えない'
    stubApi({ status: 500, body: { error: reason } })
    await draw()
    expect(text(), 'サーバーが返した理由を示していない').toContain(reason)
    expect(btn(/再読み込み|読み直/), '読み直しの導線が無い').toBeTruthy()
  })

  // @covers REQ-101#reload-refetches
  it('取得に失敗した状態で読み直しを選ぶと、受験履歴を取り直す', async () => {
    const calls = stubHistorySequence(
      { status: 500, body: { error: '履歴を取得できませんでした' } },
      { body: HISTORY },
    )
    await draw()
    expect(calls(), '最初の取得が走っていない').toBe(1)
    expect(text()).not.toContain('分野「テクノロジ系」')

    await click(btn(/再読み込み|読み直/), '読み直しの導線')
    expect(calls(), '読み直しで受験履歴を取り直していない').toBeGreaterThanOrEqual(2)
    expect(text(), '取り直した一覧が出ていない').toContain('分野「テクノロジ系」')
    expect(text(), '取り直せたのに失敗の表示が残っている').not.toMatch(/取得できません|取れません|失敗/)
  })
})
