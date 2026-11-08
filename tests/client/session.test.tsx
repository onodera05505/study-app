// @vitest-environment jsdom
/** 出題の画面（問題・選択肢・進捗・判定・時計・中断・締め・同一内容の印）。
 *  fetch を偽物にして本物の React で描く。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Session } from '../../src/client/pages/Session'
import { invalidateCached } from '../../src/client/lib/api'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''
const els = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const btn = (re: RegExp) => els('button,a,[role="button"]').find((b) => re.test(b.textContent ?? ''))
/** 選択肢のボタン（選択肢の本文を持つボタン）。本文には記号（ア〜エ）を含めない。 */
const choiceBtns = () =>
  els('button').filter((b) => Object.values(CHOICES).some((v) => (b.textContent ?? '').includes(v))) as HTMLButtonElement[]
const choiceBtn = (label: keyof typeof CHOICES) =>
  choiceBtns().find((b) => (b.textContent ?? '').includes(CHOICES[label]))
/** その要素から container までの class をつないだもの（印がどの階層に付いていても拾う）。 */
function classChain(el: Element | undefined): string {
  const out: string[] = []
  for (let e: Element | null = el ?? null; e && e !== container; e = e.parentElement) out.push(e.className)
  return out.join('|')
}

async function click(el: HTMLElement | undefined, what: string) {
  if (!el) throw new Error(`${what} が画面に無い`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type Reply = { status?: number; body?: unknown; queue?: unknown[]; wait?: Promise<unknown> }
type Call = { url: string; method: string; body: Record<string, unknown> | undefined }

/** 「<メソッド> <path>」ごとに応答を決める偽の fetch。queue は呼ばれた順に返す（最後の値は繰り返す）。 */
function stubApi(replyOf: (key: string) => Reply) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> | undefined
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      body = undefined
    }
    calls.push({ url: u, method, body })
    const reply = replyOf(`${method} ${u.split('?')[0]}`)
    if (reply.wait) await reply.wait
    const status = reply.status ?? 200
    const payload = reply.queue ? (reply.queue.length > 1 ? reply.queue.shift() : reply.queue[0]) : (reply.body ?? {})
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) }
  })
  return calls
}

/** 選択肢の本文。記号（ア〜エ）が「記号として描かれたか」を見たいので、本文には記号を入れない。 */
const CHOICES = {
  ア: '固定費を限界利益率で割った売上高',
  イ: '売上高から変動費を差し引いた額',
  ウ: '在庫の平均残高を売上原価で割った値',
  エ: '総資産を売上高で割った値',
}

const Q = (over: Record<string, unknown> = {}) => ({
  idx: 1,
  text: '問題文その1',
  choices: CHOICES,
  citation: '出典：令和6年度 ITパスポート試験 問11',
  modified: false,
  hasFigure: false,
  figureDescription: null,
  figureImage: null,
  timesAsked: 1,
  otherCitations: [] as string[],
  ...over,
})

const SESSION = (over: Record<string, unknown> = {}) => ({
  id: 's-1',
  kind: 'drill',
  scopeLabel: '論点「損益分岐点」',
  questionCount: 3,
  sourceExam: null,
  ...over,
})

const CUR = (over: Record<string, unknown> = {}) => ({
  session: SESSION(),
  question: Q(),
  answered: 1,
  remainingSec: null,
  finished: false,
  ...over,
})

const EXPL = {
  correctReason: 'アが正解の根拠です。',
  choices: [
    { label: 'ア', term: null, note: '正解。均衡点の定義そのもの。' },
    { label: 'イ', term: '損益分岐点', note: '売上と費用が等しくなる点の説明。' },
    { label: 'ウ', term: 'ABC 分析', note: '重点管理の手法の説明。' },
    { label: 'エ', term: '在庫回転率', note: '在庫の回り方を見る指標の説明。' },
  ],
}

const ANSWER = (over: Record<string, unknown> = {}) => ({
  correct: false,
  correctAnswer: 'ア',
  explanation: EXPL,
  remaining: 1,
  finished: false,
  ...over,
})

function replies(over: Record<string, Reply> = {}): (key: string) => Reply {
  const base: Record<string, Reply> = {
    'GET /api/sessions/s-1/current': { body: CUR() },
    'POST /api/sessions/s-1/answer': { body: ANSWER() },
    'POST /api/sessions/s-1/finish': { body: { ok: true, correct: 2, total: 3 } },
    'GET /api/sessions/s-1': { body: { session: SESSION(), overall: { total: 3, correct: 2, pct: 67 }, fields: [], passed: false, expired: false, criteria: { overallPct: 60, fieldPct: 30 }, approximation: '公式スコアとは一致しません。', items: [] } },
    ...over,
  }
  return (key) => base[key] ?? { body: EMPTY }
}

/** 一覧は [] ・進行中は null。どの一覧を引かれても「空」で返す。 */
const EMPTY = { fields: [], categories: [], topics: [], exams: [], sessions: [], glossary: [], items: [], session: null }

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
        { initialEntries: ['/sessions/s-1'] },
        h(
          Routes,
          null,
          h(Route, { path: '/sessions/:id', element: h(Session) }),
          h(Route, { path: '/session/:id', element: h(Session) }),
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('出題の画面', () => {
  // @covers REQ-059#scope-and-progress
  it('問題文・選択肢の記号・範囲の名前・進捗（回答済み／全体）を出す', async () => {
    stubApi(replies())
    await draw()
    expect(text()).toContain('問題文その1')
    for (const [label, body] of Object.entries(CHOICES)) {
      expect(text(), `選択肢 ${label} が出ていない`).toContain(label)
      expect(text()).toContain(body)
    }
    expect(text()).toContain('論点「損益分岐点」')
    expect(text()).toMatch(/1\s*[／/]\s*3/)
  })

  // @covers REQ-061#send-current-idx-and-choice
  it('表示中の位置と選んだ記号を送り、送信中と判定後は選択肢を押せなくする', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const calls = stubApi(replies({ 'POST /api/sessions/s-1/answer': { body: ANSWER(), wait: held } }))
    await draw()
    await click(choiceBtn('ア'), '選択肢ア')
    const sent = calls.filter((c) => c.url === '/api/sessions/s-1/answer')
    expect(sent).toHaveLength(1)
    expect(sent[0].body?.idx).toBe(1)
    expect(sent[0].body?.answer).toBe('ア')
    // 送信中
    expect(choiceBtns().every((b) => b.disabled), '送信中に選択肢が押せる').toBe(true)
    await act(async () => {
      release()
      await held
    })
    // 判定後も押せない（2 回目の送信が起きない）
    expect(choiceBtns().every((b) => b.disabled), '判定後に選択肢が押せる').toBe(true)
    await click(choiceBtn('イ'), '選択肢イ')
    expect(calls.filter((c) => c.url === '/api/sessions/s-1/answer')).toHaveLength(1)
  })

  // @covers REQ-063#verdict-and-marks
  it('回答のあとに正誤と正解の記号を出し、正解と誤答の選択肢を別の印で示す。「次の問題へ」で次が出る', async () => {
    stubApi(
      replies({
        'GET /api/sessions/s-1/current': {
          queue: [CUR(), CUR({ question: Q({ idx: 2, text: '問題文その2' }), answered: 2 })],
        },
      }),
    )
    await draw()
    await click(choiceBtn('イ'), '選択肢イ')
    expect(text()).toContain('正解')
    expect(text()).toContain('ア')
    const correct = classChain(choiceBtn('ア'))
    const chosen = classChain(choiceBtn('イ'))
    const other = classChain(choiceBtn('ウ'))
    expect(correct, '正解の選択肢に印が無い').not.toBe(other)
    expect(chosen, '誤って選んだ選択肢に印が無い').not.toBe(other)
    expect(correct, '正解と誤答が同じ印になっている').not.toBe(chosen)
    await click(btn(/次の問題/), '「次の問題へ」')
    expect(text()).toContain('問題文その2')
  })

  /** 断りの本文は契約の ErrorBody だけで、断られた理由（進行中でない・時間切れ・未回答なし・位置の食い違い）を
   *  区別しない（BR-022）。だから分岐は取り直した getCurrentQuestion の応答だけで決まる。 */
  const REJECTED = { status: 409, body: { error: '回答を受け付けられませんでした' } }
  const refetches = (calls: Call[]) => calls.filter((c) => c.url === '/api/sessions/s-1/current').length
  const finishes = (calls: Call[]) => calls.filter((c) => c.url === '/api/sessions/s-1/finish').length

  // @covers REQ-068#rejected-refetch-finished
  it('断られて取り直した結果が「終わっている」なら、採点したことにせず締めの流れへ進む', async () => {
    const calls = stubApi(
      replies({
        'POST /api/sessions/s-1/answer': REJECTED,
        'GET /api/sessions/s-1/current': {
          queue: [
            CUR(),
            // 未回答が無くなっている（契約 getCurrentQuestion の例 okNoUnanswered の形）
            { session: SESSION(), question: null, answered: 3, remainingSec: null, finished: true, expired: false },
          ],
        },
      }),
    )
    await draw()
    const before = refetches(calls)
    await click(choiceBtn('ア'), '選択肢ア')
    expect(refetches(calls), '断られたのに現在の問題を取り直していない').toBeGreaterThan(before)
    expect(text(), '位置はずれていないのにずれを伝えている').not.toMatch(/ずれ/)
    expect(text(), '断られた回答を採点したことにしている').not.toContain('アが正解の根拠です。')
    expect(finishes(calls), '取り直した結果が終わっているのに締めへ進まない').toBeGreaterThan(0)
  })

  // @covers REQ-068#stale-idx-refetch
  it('断られて取り直した位置が送った位置と違うなら、ずれを伝えて取り直した結果で進む', async () => {
    const calls = stubApi(
      replies({
        'POST /api/sessions/s-1/answer': {
          status: 409,
          // 断りの本文は契約の ErrorBody だけ（位置は載らない。位置の正本は現在の問題の取得。BR-022）
          body: { error: '表示がずれていました。読み込み直します' },
        },
        'GET /api/sessions/s-1/current': {
          queue: [CUR(), CUR({ question: Q({ idx: 2, text: '問題文その2' }), answered: 2 })],
        },
      }),
    )
    await draw()
    const before = refetches(calls)
    await click(choiceBtn('ア'), '選択肢ア')
    expect(text()).toMatch(/ずれ/)
    expect(refetches(calls), '現在の問題を取り直していない').toBeGreaterThan(before)
    // 取り直した結果で画面が進む（位置は取り直した現在の問題が持つ）
    expect(text(), '取り直した現在の問題を示していない').toContain('問題文その2')
    expect(text(), '取り直した進捗（2／3）になっていない').toMatch(/2\s*[／/]\s*3/)
  })

  /** 取り直しが断られたときにサーバが返す本文（契約 getCurrentQuestion の NOT_FOUND。本文は ErrorBody だけ）。 */
  const REFETCH_FAILED = { status: 404, body: { error: 'テストが見つかりませんでした' } }
  /** その文のとおりの操作を探す（押したあとに名札が変わっても読めるよう、押す直前に引き直す）。 */
  const byLabel = (label: string) =>
    els('button,a,[role="button"]').find((b) => (b.textContent ?? '').trim() === label)

  /** 断られた回答のあとの「現在の問題の取り直し」だけが失敗する偽のサーバ。
   *  最初の描画の取得は成功し、2 回目以降（断られたあとの取り直し）が落ちる。
   *  recover() を呼ぶと、そのあとの取り直しは次の問題（位置 2）で成功する。 */
  function stubRefetchFailure(fail: Reply | 'network') {
    let gets = 0
    let recovered = false
    const base = replies({ 'POST /api/sessions/s-1/answer': REJECTED })
    const calls = stubApi((key) => {
      if (key !== 'GET /api/sessions/s-1/current') return base(key)
      gets += 1
      if (gets === 1) return { body: CUR() }
      if (recovered) return { body: CUR({ question: Q({ idx: 2, text: '問題文その2' }), answered: 2 }) }
      // 通信そのものが届かない側は、応答を返さずに投げる（偽の fetch が落ちる）
      if (fail === 'network') throw new TypeError('Failed to fetch')
      return fail
    })
    return {
      calls,
      recover: () => {
        recovered = true
      },
    }
  }

  /** 「取り直す手段」を探してその文を返す。押して現在の問題の取得が実際に増え、回答の送り直しが
   *  起きないものだけを手段と見なす（在るだけ・押しても何も起きないものは手段にしない）。
   *  中断（REQ-070）と締め（REQ-069）と練習テストへ戻る導線（REQ-348）は別の操作なので候補から外す。 */
  async function findRetry(calls: Call[]): Promise<string | undefined> {
    const answers = () => calls.filter((c) => c.url === '/api/sessions/s-1/answer').length
    const choices = choiceBtns()
    const labels = els('button,a,[role="button"]')
      .filter((b) => !choices.includes(b as HTMLButtonElement))
      .map((b) => (b.textContent ?? '').trim())
      .filter((t) => t !== '' && !/中断|採点|練習テスト/.test(t))
    for (const label of labels) {
      const el = byLabel(label)
      if (!el) continue
      const got = refetches(calls)
      const posted = answers()
      await click(el, label)
      // 画面を離れる操作は取り直す手段ではない（離れたらそれ以上は探せない）
      if (path() !== '') return undefined
      if (refetches(calls) > got && answers() === posted) return label
    }
    return undefined
  }

  // @covers REQ-278#refetch-failed-shows-reason-with-retry
  it('画面を開いた直後の最初の取得が落ちたときも、問題の場所に理由を出して取り直す手段を添える', async () => {
    const FAIL = { status: 500, body: { error: '現在の問題を取得できませんでした' } }
    const calls = stubApi(replies({ 'GET /api/sessions/s-1/current': FAIL }))
    await draw()
    expect(refetches(calls), '現在の問題を取りに行っていない').toBeGreaterThan(0)
    expect(text(), '取れなかった理由が出ていない').toMatch(
      /現在の問題を取得できませんでした|取得できません|取り直せていません|失敗/,
    )
    expect(finishes(calls), '取れていないのに締めへ進んでいる').toBe(0)
    // 取り直す手段（押すと現在の問題の取得だけが走る、文のある操作）
    expect(await findRetry(calls), '取り直す手段が添えられていない').toBeDefined()

    // 空振り対策: 取れた側では同じ理由が出ない（出続ける文を理由と読んでいない）
    stubApi(replies())
    await draw()
    expect(text()).toContain('問題文その1')
    expect(text(), '取れたのに取れなかった理由が出ている').not.toMatch(
      /現在の問題を取得できませんでした|取得できません|取り直せていません/,
    )
  })

  // @covers REQ-278#refetch-failed-shows-reason-with-retry
  it('断られたあとに取り直せなかったら、問題が出るはずだった場所に理由を出し、取り直す手段を添える', async () => {
    const { calls } = stubRefetchFailure(REFETCH_FAILED)
    await draw()
    const before = refetches(calls)
    await click(choiceBtn('ア'), '選択肢ア')
    expect(refetches(calls), '断られたのに現在の問題を取り直していない').toBeGreaterThan(before)
    // 理由（文言は仕様が決めていないので、サーバが返した ErrorBody の文か取れなかったことを指す語）
    expect(text(), '取り直せなかった理由が出ていない').toMatch(
      /テストが見つかりませんでした|取得できません|取り直せません|取り直せませんでした/,
    )
    // 理由は「現在の問題が出るはずだった場所」に出る（取り直せていない問題を出したままにしない）
    expect(text(), '取り直せていない位置の問題をそのまま出している').not.toContain('問題文その1')
    // 取り直せていないのに、取り直せた側（REQ-068）の示し方へ倒れない
    expect(text(), '取り直せていないのに位置のずれを伝えている').not.toMatch(/ずれ/)
    expect(finishes(calls), '取り直せていないのに締めへ進んでいる').toBe(0)
    expect(text(), '断られた回答を採点したことにしている').not.toContain('アが正解の根拠です。')
    // 取り直す手段（押すと現在の問題の取得だけが走る、文のある操作）
    expect(await findRetry(calls), '取り直す手段が添えられていない').toBeDefined()

    // 空振り対策: 取り直せた側では同じ理由が出ない（出続ける文を理由と読んでいない）
    stubApi(
      replies({
        'POST /api/sessions/s-1/answer': REJECTED,
        'GET /api/sessions/s-1/current': {
          queue: [CUR(), CUR({ question: Q({ idx: 2, text: '問題文その2' }), answered: 2 })],
        },
      }),
    )
    await draw()
    await click(choiceBtn('ア'), '選択肢ア')
    expect(text(), '取り直せたのに取り直せなかった理由が出ている').not.toMatch(
      /テストが見つかりませんでした|取得できません|取り直せません|取り直せませんでした/,
    )
  })

  // @covers REQ-278#refetch-failed-shows-reason-with-retry
  it('取り直しの通信そのものが届かないときも、理由を出して取り直す手段を添える', async () => {
    const FAILED = /できません|できなかった|失敗|エラー|通信|取り直/
    const { calls } = stubRefetchFailure('network')
    await draw()
    const before = refetches(calls)
    // 空振り対策: 描いた直後は失敗の案内が出ていない（出しっぱなしの文を拾っていない）
    expect(text(), '描いた直後から失敗の案内が出ている').not.toMatch(FAILED)
    await click(choiceBtn('ア'), '選択肢ア')
    expect(refetches(calls), '断られたのに現在の問題を取り直していない').toBeGreaterThan(before)
    expect(text(), '取り直せなかったことを示していない').toMatch(FAILED)
    expect(finishes(calls), '取り直せていないのに締めへ進んでいる').toBe(0)
    expect(await findRetry(calls), '取り直す手段が添えられていない').toBeDefined()
  })

  // @covers REQ-278#retry-refetches-current-only
  it('添えた手段を押すと、回答を送り直さずに現在の問題だけを取り直し、取り直せたらその問題を出す', async () => {
    const { calls, recover } = stubRefetchFailure(REFETCH_FAILED)
    const answers = () => calls.filter((c) => c.url === '/api/sessions/s-1/answer').length
    await draw()
    await click(choiceBtn('ア'), '選択肢ア')
    const retry = await findRetry(calls)
    expect(retry, '取り直す手段が添えられていない').toBeDefined()
    expect(byLabel(retry!), '一度押したら取り直す手段が消えている（押し直せない）').toBeDefined()
    // 取り直せる状態に戻して押し直す
    recover()
    const got = refetches(calls)
    const posted = answers()
    await click(byLabel(retry!), `取り直す手段「${retry}」`)
    expect(refetches(calls), '押しても現在の問題を取り直さない').toBeGreaterThan(got)
    expect(answers(), '取り直しで断られた回答を送り直している').toBe(posted)
    expect(text(), '取り直せたのに現在の問題が出ない').toContain('問題文その2')
    expect(text(), '取り直せた進捗（2／3）になっていない').toMatch(/2\s*[／/]\s*3/)
  })

  /** 見つからないものとして断られた取得の本文（契約 getCurrentQuestion の NOT_FOUND。本文は ErrorBody だけで、
   *  「続けられない」の語を含めない＝画面が自分で示しているかを見分ける）。 */
  const NOT_FOUND = { status: 404, body: { error: 'その ID のテストはありません' } }
  const CANNOT_CONTINUE = /続けられ/

  // @covers REQ-348#not-found-cannot-continue
  it('現在の問題の取得が見つからないものとして断られたら、画面を開いた直後でも断られた回答のあとでも、そのテストでは続けられないことを示す', async () => {
    // 空振り対策: 見つからない以外の失敗（サーバの失敗）では続けられないとは言わない
    stubApi(replies({ 'GET /api/sessions/s-1/current': { status: 500, body: { error: '現在の問題を取得できませんでした' } } }))
    await draw()
    expect(text(), 'サーバの失敗なのに続けられないと示している（この検査は空振りになる）').not.toMatch(CANNOT_CONTINUE)

    // 画面を開いた直後の取得
    const opened = stubApi(replies({ 'GET /api/sessions/s-1/current': NOT_FOUND }))
    await draw()
    expect(refetches(opened), '現在の問題を取りに行っていない').toBeGreaterThan(0)
    expect(text(), '開いた直後に見つからないのに、続けられないことを示していない').toMatch(CANNOT_CONTINUE)
    expect(finishes(opened), '見つからないのに締めへ進んでいる').toBe(0)

    // 断られた回答のあとの取り直し
    const { calls } = stubRefetchFailure(NOT_FOUND)
    await draw()
    await click(choiceBtn('ア'), '選択肢ア')
    expect(refetches(calls), '断られたのに現在の問題を取り直していない').toBeGreaterThan(1)
    expect(text(), '取り直しで見つからないのに、続けられないことを示していない').toMatch(CANNOT_CONTINUE)
    expect(text(), '見つからないテストの問題を出したままにしている').not.toContain('問題文その1')
    expect(finishes(calls), '見つからないのに締めへ進んでいる').toBe(0)
  })

  // @covers REQ-348#back-to-practice
  it('見つからないものとして断られたときに添えた導線をたどると、練習テストへ戻る', async () => {
    for (const label of ['開いた直後', '断られた回答のあと']) {
      if (label === '開いた直後') stubApi(replies({ 'GET /api/sessions/s-1/current': NOT_FOUND }))
      else stubRefetchFailure(NOT_FOUND)
      await draw()
      if (label !== '開いた直後') await click(choiceBtn('ア'), '選択肢ア')
      const back = els('button,a,[role="button"]').find((b) => /練習テスト/.test(b.textContent ?? ''))
      expect(back, `${label}: 練習テストへ戻る導線が無い`).toBeDefined()
      await click(back, `${label}: 練習テストへ戻る導線`)
      expect(path(), `${label}: 導線をたどっても練習テストへ戻らない`).toBe('/practice')
    }
  })

  // @covers REQ-074#finish-failed-retryable
  it('締めに失敗したら理由と「まだ採点できていません」を出し、押し直せる', async () => {
    const calls = stubApi(
      replies({
        'GET /api/sessions/s-1/current': {
          body: { session: SESSION(), question: null, answered: 3, remainingSec: null, finished: true, expired: false },
        },
        'POST /api/sessions/s-1/finish': { status: 500, body: { error: '採点できませんでした' } },
      }),
    )
    await draw()
    const finishes = () => calls.filter((c) => c.url === '/api/sessions/s-1/finish')
    expect(finishes().length, '未回答が無いのに締めが呼ばれない').toBeGreaterThan(0)
    expect(text()).toContain('まだ採点できていません')
    expect(text()).toContain('採点できませんでした')
    const n = finishes().length
    await click(btn(/採点/), '締め直し')
    const again = finishes()
    expect(again.length).toBeGreaterThan(n)
    expect(again[again.length - 1].body).toEqual(again[0].body)
  })

  // @covers REQ-069#finish-with-unanswered
  it('「ここまでで採点する」は未回答の残り問数を示して確認し、了承したときだけ締める', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const calls = stubApi(replies())
    await draw()
    await click(btn(/ここまでで採点/), '「ここまでで採点する」')
    expect(confirm, '確認を取っていない').toHaveBeenCalled()
    expect(confirm.mock.calls.map((c) => String(c[0])).join(' '), '未回答の残り問数が確認に入っていない').toContain('2')
    expect(calls.some((c) => c.url === '/api/sessions/s-1/finish')).toBe(false)
    confirm.mockReturnValue(true)
    await click(btn(/ここまでで採点/), '「ここまでで採点する」')
    expect(calls.some((c) => c.url === '/api/sessions/s-1/finish')).toBe(true)
  })

  // @covers REQ-070#suspend-keeps-answers
  it('「中断してホームへ」でホームに戻り、そこまでの回答を残す（破棄しない）', async () => {
    const calls = stubApi(replies())
    await draw()
    await click(btn(/中断/), '「中断してホームへ」')
    expect(path()).toBe('/')
    expect(calls.some((c) => c.method === 'DELETE'), '中断で進行中のセッションを消している').toBe(false)
  })
})

describe('出題の画面の時計（制限時間つき）', () => {
  // @covers REQ-112#countdown-ticks
  it('残り時間を時分秒で出し、1 秒ごとに減らす', async () => {
    vi.useFakeTimers()
    stubApi(replies({ 'GET /api/sessions/s-1/current': { body: CUR({ remainingSec: 125, session: SESSION({ kind: 'mock' }) }) } }))
    await draw()
    expect(text(), '残り時間が時分秒で出ていない').toMatch(/2\s*[:分]\s*0?5/)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(text(), '1 秒後に 1 減っていない').toMatch(/2\s*[:分]\s*0?4/)
  })

  // @covers REQ-248#below-threshold-distinct
  it('残り 5 分未満になったら時計の見た目を変える', async () => {
    const timer = () => container.querySelector('span.timer')
    stubApi(replies({ 'GET /api/sessions/s-1/current': { body: CUR({ remainingSec: 301, session: SESSION({ kind: 'mock' }) }) } }))
    await draw()
    expect(timer(), '時計（span.timer）が無い').not.toBeNull()
    expect(timer()!.className, '残り 5 分より前から強調されている').not.toMatch(/\blow\b/)

    stubApi(replies({ 'GET /api/sessions/s-1/current': { body: CUR({ remainingSec: 299, session: SESSION({ kind: 'mock' }) }) } }))
    await draw()
    expect(timer()!.className, '残り 5 分未満でも強調されない').toMatch(/\blow\b/)
  })

  // @covers REQ-118#auto-finish-at-zero
  it('残り時間が 0 になったら自動で締めて結果の画面へ移る', async () => {
    vi.useFakeTimers()
    const calls = stubApi(replies({ 'GET /api/sessions/s-1/current': { body: CUR({ remainingSec: 1, session: SESSION({ kind: 'mock' }) }) } }))
    await draw()
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(calls.some((c) => c.url === '/api/sessions/s-1/finish'), '0 になっても締めが呼ばれない').toBe(true)
    expect(path()).toMatch(/result/)
    expect(path()).toContain('s-1')
  })
})

describe('模擬試験の出題', () => {
  // @covers REQ-113#no-feedback-next
  it('1 問ごとの正誤も解説も出さずに次の問題へ送る', async () => {
    stubApi(
      replies({
        'GET /api/sessions/s-1/current': {
          queue: [
            CUR({ session: SESSION({ kind: 'mock' }) }),
            CUR({ session: SESSION({ kind: 'mock' }), question: Q({ idx: 2, text: '問題文その2' }), answered: 2 }),
          ],
        },
        // 模試の回答の応答は残りの未回答の件数と終わったかだけ（REQ-343）
        'POST /api/sessions/s-1/answer': { body: { remaining: 1, finished: false } },
      }),
    )
    await draw()
    await click(choiceBtn('イ'), '選択肢イ')
    expect(text(), '模擬試験で解説が出ている').not.toContain('アが正解の根拠です。')
    expect(text(), '模擬試験で正誤が出ている').not.toMatch(/正解/)
    expect(text()).toContain('問題文その2')
  })
})

describe('同一内容の印', () => {
  const asked2 = {
    question: Q({ timesAsked: 2, otherCitations: ['出典：平成28年度 春期 ITパスポート試験 問1'] }),
  }
  /** 印に出る他の出典（先頭の「出典：」は外して並べる）。 */
  const OTHER = '平成28年度 春期 ITパスポート試験 問1'

  // @covers REQ-053#mark-shown-when-multiple
  it('同じ内容が 2 回以上出題されているときだけ回数と他の出典を出す', async () => {
    stubApi(replies({ 'GET /api/sessions/s-1/current': { body: CUR(asked2) } }))
    await draw()
    expect(text()).toMatch(/2\s*回/)
    expect(text()).toContain(OTHER)

    stubApi(replies({ 'GET /api/sessions/s-1/current': { body: CUR() } }))
    await draw()
    expect(text(), '1 回だけの問題に印が出ている').not.toMatch(/\d+\s*回/)
  })

  // @covers REQ-249#sourced-exam-question-no-marks
  it('公開回の通し受験では印を出さず、演習とランダム構成では出す', async () => {
    stubApi(
      replies({
        'GET /api/sessions/s-1/current': {
          body: CUR({ ...asked2, session: SESSION({ kind: 'mock', sourceExam: '2024r06' }) }),
        },
      }),
    )
    await draw()
    expect(text(), '通し受験で同一内容の印が出ている').not.toMatch(/他の出典/)
    expect(text()).not.toContain(OTHER)

    stubApi(replies({ 'GET /api/sessions/s-1/current': { body: CUR(asked2) } }))
    await draw()
    expect(text()).toContain(OTHER)
  })
})
