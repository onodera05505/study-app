// @vitest-environment jsdom
/** フィードバックの画面（UC-010 の表 1・表 2）。添え先の見せ方と添える・添えないの選択、下書き、
 *  送る操作の可否、受付後の片付けと導線、送信の失敗と重ねた送信を見る。
 *
 *  送信先（サーバ）は偽物にして、呼ばれた回数と送信の本体を読む。端末の記憶は jsdom の
 *  Storage をそのまま使い、「画面を離れて戻る」は描いた根を空にしてから描き直して表す。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Feedback } from '../../src/client/pages/Feedback'
import { annotateLastPage, setLastPage } from '../../src/client/lib/lastPage'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

const TYPED = 'この論点の説明が分かりにくいです。'
const LABEL = '学習の単位「LTV」'
const TOPIC_SCREEN = 'TOPIC-SCREEN-MARKER-412'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

type Reply = { status?: number; body: unknown }
type Call = { url: string; init?: RequestInit }

/** 呼ばれた (url, init) を集める偽の fetch。`replyOf` が Promise を返せば、それが解けるまで応答しない。 */
function stubApi(replyOf: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init }
    calls.push(call)
    const { status = 200, body } = await replyOf(call)
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
  })
  return calls
}

const accepted = (id = 'f-1') => stubApi(() => ({ status: 201, body: { id } }))

/** 送信（POST /api/feedback）だけを数える。 */
const posts = (calls: Call[]) => calls.filter((c) => c.url.includes('/feedback') && c.init?.method === 'POST')
const sentBody = (call: Call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>

/** フィードバックの画面と、添え先の行き先になる画面（目印の文字だけ）を持つ経路で描く。 */
async function draw(entry = '/feedback') {
  await act(async () => {
    root.render(
      h(
        MemoryRouter,
        { initialEntries: [entry] },
        h(
          Routes,
          null,
          h(Route, { path: '/feedback', element: h(Feedback) }),
          h(Route, { path: '/topics/:id', element: h('div', null, TOPIC_SCREEN) }),
        ),
      ),
    )
  })
}

/** 画面を離れる（描いた物を空にする）。戻るのは draw()。 */
async function leave() {
  await act(async () => {
    root.render(null)
  })
}

function button(re: RegExp): HTMLButtonElement | null {
  return ([...container.querySelectorAll('button')].find((b) => re.test(b.textContent ?? '')) ??
    null) as HTMLButtonElement | null
}

/** 文字で導線（リンクかボタン）を探す。 */
function lead(re: RegExp): HTMLElement | null {
  return ([...container.querySelectorAll('a, button')].find((el) => re.test(el.textContent ?? '')) ??
    null) as HTMLElement | null
}

function input(): HTMLTextAreaElement | HTMLInputElement | null {
  return container.querySelector('textarea') ?? container.querySelector<HTMLInputElement>('input[type="text"]')
}

/** React の制御された入力欄に文字を入れる。 */
async function type(value: string) {
  const el = input()
  expect(el, '本文の入力欄が無い').not.toBeNull()
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(el!, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** フィードバックの種類を選ぶ操作（UC の主シナリオ #5）。 */
const kindRadios = () => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
async function chooseKind() {
  const radio = kindRadios()[0]
  expect(radio, 'フィードバックの種類を選ぶ操作が無い').toBeTruthy()
  await act(async () => {
    radio.click()
  })
}
const kindChosen = () => kindRadios().some((r) => r.checked)

/** 添える・添えないを選ぶ操作（契約 LastPage を送信に載せるかどうか）。 */
const attachChooser = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')
async function chooseNotToAttach() {
  const box = attachChooser()
  expect(box, '添える・添えないを選ぶ操作が無い').not.toBeNull()
  if (box!.checked) {
    await act(async () => {
      box!.click()
    })
  }
  expect(box!.checked, '添えない側に切り替わらない').toBe(false)
}

async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** 送る操作。ボタンが無ければ null（送る操作そのものが無い状態として扱う）。 */
async function trySend() {
  const btn = button(/送/)
  if (!btn) return null
  await click(btn)
  return btn
}

async function send() {
  const btn = button(/送/)
  expect(btn, '送信のボタンが無い').not.toBeNull()
  await click(btn!)
}

/** 画面の文字を要素ごとに集める（失敗の理由など「新しく出た文字」を差で見るのに使う）。 */
function textNodes(): string[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const out: string[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = (n.textContent ?? '').trim()
    if (s) out.push(s)
  }
  return out
}
const newTexts = (before: string[]) => textNodes().filter((s) => !before.includes(s))

/** 端末の記憶（localStorage・sessionStorage）のどこかに文字が残っているか。鍵の名前は見ない。 */
function remembered(fragment: string): boolean {
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key && (store.getItem(key) ?? '').includes(fragment)) return true
    }
  }
  return false
}

/** 本文と種類をそろえて送る所まで進める。 */
async function fillAndSend() {
  await chooseKind()
  await type(TYPED)
  await send()
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  await leave()
  vi.unstubAllGlobals()
})

describe('フィードバックの画面の添え先（UC-010）', () => {
  // @covers REQ-151#attachment-not-shown
  it('添え先を覚えていなければ、添え先も添える・添えないの選択も示さない', async () => {
    accepted()
    await draw()
    expect(input(), '本文の入力欄が無い').not.toBeNull()
    expect(text()).not.toContain(LABEL)
    expect(attachChooser(), '添える物が無いのに添える・添えないの選択が出ている').toBeNull()
  })

  // @covers REQ-152#show-attachment-label
  it('覚えている添え先を人が読む名前つきで示し、添える・添えないを選べる', async () => {
    setLastPage({ path: '/topics/412', label: '学習の単位の詳細' })
    annotateLastPage({ topicId: 412, label: LABEL })
    accepted()
    await draw()
    expect(text()).toContain(LABEL)
    expect(attachChooser(), '添える・添えないを選ぶ操作が無い').not.toBeNull()
  })

  // @covers REQ-152#attach-excluded
  it('添えないことを選んで送ると、送信に添え先が載らない', async () => {
    setLastPage({ path: '/topics/412', label: '学習の単位の詳細' })
    annotateLastPage({ topicId: 412, label: LABEL })
    const calls = accepted()
    await draw()
    await chooseNotToAttach()
    await fillAndSend()

    const sent = posts(calls)
    expect(sent, 'POST /api/feedback が呼ばれていない').toHaveLength(1)
    const body = sentBody(sent[0])
    expect(body.body).toBe(TYPED)
    expect(body.page).toBeUndefined()
    expect(body.topicId).toBeUndefined()
    expect(body.questionId).toBeUndefined()
  })
})

describe('フィードバックの下書き（UC-010）', () => {
  // @covers REQ-153#draft-kept
  it('本文を書いている間、書きかけの本文が端末に残る', async () => {
    accepted()
    await draw()
    await type(TYPED)
    expect(remembered(TYPED), '書きかけの本文が端末の記憶に無い').toBe(true)
  })

  // @covers REQ-153#draft-restored
  it('画面を離れて戻ると、下書きから本文を書き続けられる', async () => {
    accepted()
    await draw()
    await type(TYPED)
    await leave()
    await draw()
    expect(input()?.value, '戻ったときに下書きが本文に戻っていない').toBe(TYPED)

    await type(`${TYPED}続きです。`)
    await leave()
    await draw()
    expect(input()?.value).toBe(`${TYPED}続きです。`)
  })

  // @covers REQ-153#draft-absent
  it('下書きが無ければ本文は空で始まる', async () => {
    accepted()
    await draw()
    expect(input()?.value).toBe('')
  })

  // @covers REQ-153#draft-absent
  it('端末の記憶が読めなくても本文は空で始まり、画面は止まらない', async () => {
    accepted()
    const real = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('この端末では読めない')
    }
    try {
      await draw()
      expect(input(), '記憶が読めないと画面が出ない').not.toBeNull()
      expect(input()?.value).toBe('')
    } finally {
      Storage.prototype.getItem = real
    }
  })
})

describe('送る操作の可否（UC-010）', () => {
  // @covers REQ-154#body-missing
  it('種類を選んでも本文が空・空白だけなら送れない', async () => {
    const calls = accepted()
    await draw()
    await chooseKind()
    for (const body of ['', '   ', '\n\t']) {
      await type(body)
      await trySend()
      expect(posts(calls), `本文 ${JSON.stringify(body)} で送れてしまう`).toHaveLength(0)
    }
  })

  // @covers REQ-154#kind-missing
  it('本文があっても種類を選んでいなければ送れない', async () => {
    const calls = accepted()
    await draw()
    expect(kindRadios().length, 'フィードバックの種類を選ぶ操作が無い').toBeGreaterThan(0)
    expect(kindChosen(), '開いた時点で種類が選ばれている（選ばずに送れてしまう）').toBe(false)
    await type(TYPED)
    await trySend()
    expect(posts(calls)).toHaveLength(0)
  })

  // @covers REQ-154#becomes-sendable
  it('本文と種類がそろうと送れる側に変わる', async () => {
    const calls = accepted()
    await draw()
    await type(TYPED)
    await trySend()
    expect(posts(calls), '種類を選ぶ前に送れてしまう').toHaveLength(0)

    await chooseKind()
    await send()
    expect(posts(calls)).toHaveLength(1)
    expect(sentBody(posts(calls)[0]).body).toBe(TYPED)
  })
})

describe('受付後の片付けと導線（UC-010）', () => {
  // @covers REQ-155#accepted-clears-draft
  it('受け付けられたあとに画面を離れて戻っても、本文と種類は下書きから戻らない', async () => {
    accepted()
    await draw()
    await fillAndSend()
    expect(remembered(TYPED), '受け付けられたのに本文が端末に残っている').toBe(false)

    await leave()
    await draw()
    expect(input(), '戻ったときに本文を書く場が無い').not.toBeNull()
    expect(input()?.value).toBe('')
    expect(kindChosen(), '前に選んだ種類が残っている').toBe(false)
  })

  // @covers REQ-155#no-inline-reply
  it('受け口が受付の id 以外の文を返しても、その場の応答としては出さない', async () => {
    const INLINE = 'SERVER-INLINE-REPLY-ご意見ありがとうございます、担当が確認しました'
    stubApi(() => ({ status: 201, body: { id: 'f-9', reply: INLINE, message: INLINE, answer: INLINE } }))
    await draw()
    await fillAndSend()
    expect(text()).not.toContain(TYPED)
    expect(text()).not.toContain(INLINE)
    expect(text()).not.toContain('f-9')
  })

  // @covers REQ-158#send-another
  it('受付文が出ている間はもう 1 件送る導線があり、選ぶと本文を書く場が出る', async () => {
    const calls = accepted()
    await draw()
    await fillAndSend()
    expect(posts(calls)).toHaveLength(1)

    const another = lead(/もう\s*(1|一)\s*件/)
    expect(another, 'もう 1 件送る導線が無い').not.toBeNull()
    await click(another!)
    expect(input(), 'もう 1 件送る導線の先に本文を書く場が無い').not.toBeNull()
    expect(input()?.value).toBe('')
  })

  // @covers REQ-158#back-to-attachment
  it('添え先があれば、その画面へ戻る導線があり、選ぶとその画面が出る', async () => {
    setLastPage({ path: '/topics/412', label: '学習の単位の詳細' })
    annotateLastPage({ topicId: 412, label: LABEL })
    accepted()
    await draw()
    await fillAndSend()

    const back = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/topics/412')
    expect(back, '添え先の画面（/topics/412）へ戻る導線が無い').toBeTruthy()
    await click(back!)
    expect(text()).toContain(TOPIC_SCREEN)
  })

  // @covers REQ-158#no-attachment-no-back
  it('添え先が無ければ戻る導線を出さない（もう 1 件送る導線は出る）', async () => {
    accepted()
    await draw()
    await fillAndSend()

    expect(lead(/もう\s*(1|一)\s*件/), 'もう 1 件送る導線が無い').not.toBeNull()
    expect(lead(/戻る/), '添え先が無いのに戻る導線が出ている').toBeNull()
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
    expect(links.filter((href) => /^\/(topics|sessions|roadmap)/.test(href))).toEqual([])
  })
})

describe('送信の失敗と重ねた送信（UC-010）', () => {
  // @covers REQ-156#double-submit
  it('送信中に重ねて送っても、送信は 1 回だけ', async () => {
    let release!: (reply: Reply) => void
    const pending = new Promise<Reply>((resolve) => {
      release = resolve
    })
    const calls = stubApi(() => pending)
    await draw()
    await chooseKind()
    await type(TYPED)
    await send()
    await trySend()
    await trySend()
    expect(posts(calls), '送信中に重ねた操作で送信が増えている').toHaveLength(1)

    await act(async () => {
      release({ status: 201, body: { id: 'f-1' } })
    })
    expect(posts(calls)).toHaveLength(1)
  })

  // @covers REQ-157#rejected-by-receiver
  it('受け口が断ると日本語の理由が出て、本文と種類が残り、もう一度送れる', async () => {
    let status = 429
    const calls = stubApi(() =>
      status === 429
        ? { status, body: { error: '1 日に送れる件数の上限に達しました' } }
        : { status, body: { id: 'f-2' } },
    )
    await draw()
    await chooseKind()
    await type(TYPED)
    const before = textNodes()
    await send()
    expect(posts(calls)).toHaveLength(1)

    const added = newTexts(before)
    expect(added.some((s) => JAPANESE.test(s)), `日本語の理由が出ていない: ${JSON.stringify(added)}`).toBe(true)
    expect(input()?.value, '断られたのに本文が消えている').toBe(TYPED)
    expect(kindChosen(), '断られたのに種類が外れている').toBe(true)

    status = 201
    await send()
    expect(posts(calls), '送り直せない').toHaveLength(2)
    expect(sentBody(posts(calls)[1]).body).toBe(TYPED)
  })

  // @covers REQ-157#not-delivered
  it('送信が届かなくても日本語の理由が出て、本文と種類が残り、もう一度送れる', async () => {
    let reachable = false
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (!reachable) throw new TypeError('Failed to fetch')
      return { ok: true, status: 201, text: async () => '{"id":"f-3"}', json: async () => ({ id: 'f-3' }) }
    })
    await draw()
    await chooseKind()
    await type(TYPED)
    const before = textNodes()
    await send()
    expect(posts(calls)).toHaveLength(1)

    const added = newTexts(before)
    expect(added.some((s) => JAPANESE.test(s)), `日本語の理由が出ていない: ${JSON.stringify(added)}`).toBe(true)
    expect(input()?.value, '届かなかったのに本文が消えている').toBe(TYPED)
    expect(kindChosen(), '届かなかったのに種類が外れている').toBe(true)

    reachable = true
    await send()
    expect(posts(calls), '送り直せない').toHaveLength(2)
  })
})

describe('送信中に画面を離れたとき（UC-010）', () => {
  /** 送信の応答を手で返す偽の fetch。返すまで送信中のまま止まる。 */
  function holdSend() {
    const calls: Call[] = []
    let settle!: (outcome: Reply | 'network') => void
    const outcome = new Promise<Reply | 'network'>((resolve) => {
      settle = resolve
    })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const got = await outcome
      if (got === 'network') throw new TypeError('Failed to fetch')
      const { status = 200, body } = got
      return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }
    })
    return { calls, settle: async (o: Reply | 'network') => act(async () => settle(o)) }
  }

  /** 送信を取り消していない（中断の合図が立っていない）。 */
  const notAborted = (call: Call) => (call.init?.signal as AbortSignal | undefined)?.aborted !== true

  // @covers REQ-349#left-then-accepted
  it('送信中に離れてその送信が受け付けられると、送信は 1 件のまま取り消されず、戻ったときの本文は空で始まる', async () => {
    const held = holdSend()
    await draw()
    await fillAndSend()
    expect(posts(held.calls), '送信が始まっていない').toHaveLength(1)

    await leave()
    expect(notAborted(posts(held.calls)[0]), '画面を離れたら送信を取り消している').toBe(true)
    await held.settle({ status: 201, body: { id: 'f-1' } })

    expect(posts(held.calls), '送信が 1 件でない').toHaveLength(1)
    expect(remembered(TYPED), '受け付けられたのに本文が下書きに残っている').toBe(false)
    await draw()
    expect(input(), '戻ったときに本文を書く場が無い').not.toBeNull()
    expect(input()?.value, '受け付けられたのに戻ると本文が残っている').toBe('')
  })

  // @covers REQ-349#left-then-rejected
  it('送信中に離れてその送信が拒まれた・届かなかったときは、取り消されず、戻ると書いた本文が下書きから戻る', async () => {
    const outcomes: Array<[string, Reply | 'network']> = [
      ['拒まれた', { status: 429, body: { error: '1 日に送れる件数の上限に達しました' } }],
      ['届かなかった', 'network'],
    ]
    for (const [label, outcome] of outcomes) {
      localStorage.clear()
      sessionStorage.clear()
      const held = holdSend()
      await draw()
      await fillAndSend()
      expect(posts(held.calls), `${label}: 送信が始まっていない`).toHaveLength(1)

      await leave()
      expect(notAborted(posts(held.calls)[0]), `${label}: 画面を離れたら送信を取り消している`).toBe(true)
      await held.settle(outcome)

      expect(posts(held.calls), `${label}: 送信が 1 件でない`).toHaveLength(1)
      await draw()
      expect(input()?.value, `${label}: 書いた本文が下書きから戻らない`).toBe(TYPED)
      await leave()
      vi.unstubAllGlobals()
    }
  })
})
