// @vitest-environment jsdom
/**
 * まなびばの画面（portal/static の index.html と、そこが読む script）を jsdom で描き、
 * 一覧の応答だけでなく画面に何が出ているかを見る（UC-013 の REQ-183、UC-011 の REQ-162）。
 *
 * まなびばのサーバの代わりに偽の fetch が契約の応答（listLearnings・getMe・listAccounts）を返す。
 * 値は契約の examples から採る。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** jsdom の環境では import.meta.url が file の URL でないので、作業の場所から辿る。 */
const STATIC = resolve(process.cwd(), 'portal/static')

/** 契約 listLearnings の応答。 */
const LEARNINGS = [
  { key: 'ip', brand: 'IT パスポート 最短合格', kind: '資格対策', desc: '過去問の出題頻度＝重要度の順に、最短で合格ラインへ' },
  { key: 'ap', brand: '応用情報 午前', kind: '資格対策', desc: '午前の過去問を頻出の論点から' },
]

/** 契約 listAccounts の examples の 2 行。 */
const ACCOUNTS = [
  { id: '8a0f1d62-3c47-4b10-9f85-d2e6a1c70b33', email: 'yudai@example.com', name: '山田 太郎', role: 'ADMIN', createdAt: 1758000000, grants: ['ap', 'ip'] },
  { id: '1c7e4b05-9a26-4d83-b7f1-6e0c3a9d2544', email: 'hanako@example.com', name: '鈴木 花子', role: 'MEMBER', createdAt: 1758600000, grants: ['ip'] },
]
const ME_ADMIN = { account: { id: ACCOUNTS[0].id, email: ACCOUNTS[0].email, name: ACCOUNTS[0].name, role: 'ADMIN' }, grants: ['ap', 'ip'] }

type Reply = { status: number; body: unknown }

function stubPortal(replyOf: (path: string, method: string) => Reply) {
  vi.stubGlobal('fetch', async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof raw === 'string' ? raw : raw instanceof URL ? raw.href : raw.url, 'https://manabiba.example')
    const { status, body } = replyOf(url.pathname, (init?.method ?? 'GET').toUpperCase())
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
}

const unauthenticated: Reply = { status: 401, body: { error: 'ログインが必要です' } }

/** index.html を文書に入れ、そこが読む script を順に読み込んで、読み込み完了の合図を送る。 */
async function drawPortal(path = '/') {
  window.history.replaceState({}, '', path)
  const html = readFileSync(resolve(STATIC, 'index.html'), 'utf8')
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const sources = [...parsed.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')!)
  parsed.querySelectorAll('script').forEach((s) => s.remove())
  document.head.innerHTML = parsed.head.innerHTML
  document.body.innerHTML = parsed.body.innerHTML
  // script はファイルとして読み込む（文字列の評価では、どの行が動いたかが実行の記録に載らない）。描くたびに読み込み直す
  vi.resetModules()
  for (const src of sources) await import(/* @vite-ignore */ resolve(STATIC, src.replace(/^\//, '')))
  document.dispatchEvent(new Event('DOMContentLoaded'))
  window.dispatchEvent(new Event('load'))
  await settle()
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const bodyText = () => document.body.textContent ?? ''

afterEach(() => {
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('UC-013 セッションの無い端末にも学びの一覧を出す（まなびばの画面）', () => {
  // @covers REQ-183#screen-lists-without-session
  it('セッションが無い端末の画面に、ログインの欄だけでなく登録簿の学びの一覧が出ている', async () => {
    stubPortal((path) => (path === '/api/learnings' ? { status: 200, body: { learnings: LEARNINGS } } : unauthenticated))
    await drawPortal('/')
    for (const l of LEARNINGS) {
      expect(bodyText(), `セッションが無い端末の画面に学び「${l.brand}」が出ていない`).toContain(l.brand)
    }
  })
})

describe('UC-011 管理の画面の表（まなびばの画面）', () => {
  /** 管理の画面を開く。表が出ていなければ「管理」の導線を押す。 */
  async function openAdmin() {
    stubPortal((path) => {
      if (path === '/api/learnings') return { status: 200, body: { learnings: LEARNINGS } }
      if (path === '/api/me') return { status: 200, body: ME_ADMIN }
      if (path === '/api/admin/accounts') return { status: 200, body: { accounts: ACCOUNTS } }
      return { status: 404, body: { error: '見つかりません' } }
    })
    await drawPortal('/')
    if (!bodyText().includes(ACCOUNTS[1].email)) {
      const toAdmin = [...document.querySelectorAll<HTMLElement>('a, button')].find((e) => (e.textContent ?? '').includes('管理'))
      expect(toAdmin, '管理の画面への導線が無い').toBeTruthy()
      toAdmin!.click()
      await settle()
    }
  }

  /** 作成時刻（unixepoch 秒）を年・月・日の並びで含むか（書式は見ない）。 */
  const showsDate = (text: string, epochSec: number) => {
    const d = new Date(epochSec * 1000)
    const [y, m, day] = [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    return new RegExp(`${y}\\D{1,3}0?${m}\\D{1,3}0?${day}`).test(text)
  }

  // @covers REQ-162#screen-shows-all-columns
  it('管理の画面の表が、行ごとに名前・メールアドレス・役割・作成時刻・権限を出している', async () => {
    await openAdmin()
    const rows = [...document.querySelectorAll('tr')]
    for (const a of ACCOUNTS) {
      const row = rows.find((r) => (r.textContent ?? '').includes(a.email))
      expect(row, `${a.email} の行が管理の表に無い`).toBeTruthy()
      const text = row!.textContent ?? ''
      expect(text, `${a.email} の行に名前が無い`).toContain(a.name)
      expect(text, `${a.email} の行に役割が無い`).toMatch(a.role === 'ADMIN' ? /管理者|ADMIN/ : /利用者|MEMBER/)
      expect(showsDate(text, a.createdAt), `${a.email} の行に作成時刻が無い`).toBe(true)
      for (const g of a.grants) {
        const brand = LEARNINGS.find((l) => l.key === g)!.brand
        expect(text.includes(g) || text.includes(brand), `${a.email} の行に権限「${g}」が無い`).toBe(true)
      }
    }
  })
})

describe('UC-011 管理の画面が、済んだことと断りの理由を示す（まなびばの画面）', () => {
  /** 管理の画面の行の相手（契約 listAccounts の examples の 2 行目。利用者）。 */
  const OTHER = ACCOUNTS[1]
  /** 2 人目の管理者（最後の管理者の断りの前提）。 */
  const OTHER_ADMIN = { id: '5d2e9c41-7b08-4e6a-a1f3-0c9b8d7e6f52', email: 'jiro@example.com', name: '佐藤 次郎', role: 'ADMIN', createdAt: 1758900000, grants: ['ap'] }
  type Call = { method: string; path: string; body: unknown }

  /** 管理の画面を開く。answer は一覧・本人・学びの一覧のほかの求め（と、2 回目からの一覧）への答え。 */
  async function openAdmin(answer: (call: Call, n: number) => Reply | 'unreachable' | null, accounts = ACCOUNTS) {
    const calls: Call[] = []
    let listed = 0
    vi.stubGlobal('fetch', async (raw: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof raw === 'string' ? raw : raw instanceof URL ? raw.href : raw.url, 'https://manabiba.example')
      const method = (init?.method ?? 'GET').toUpperCase()
      const call: Call = { method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
      calls.push(call)
      const custom = answer(call, call.path === '/api/admin/accounts' && method === 'GET' ? listed++ : 0)
      if (custom === 'unreachable') throw new TypeError('Failed to fetch')
      let reply: Reply = custom ?? { status: 404, body: { error: '見つかりません' } }
      if (!custom && call.path === '/api/learnings') reply = { status: 200, body: { learnings: LEARNINGS } }
      if (!custom && call.path === '/api/me') reply = { status: 200, body: ME_ADMIN }
      if (!custom && call.path === '/api/admin/accounts' && method === 'GET') reply = { status: 200, body: { accounts } }
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
    })
    await drawPortal('/')
    if (!bodyText().includes(OTHER.email)) {
      ;[...document.querySelectorAll<HTMLElement>('a, button')].find((e) => (e.textContent ?? '').includes('管理'))?.click()
      await settle()
    }
    expect(bodyText(), '前提: 管理の画面の表が出ていない').toContain(OTHER.email)
    return calls
  }

  /** 表の外に出ている文（葉の要素ごと。隠れている物は除く）。 */
  const messages = () =>
    [...document.body.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.children.length === 0 && !el.closest('table') && !el.closest('[hidden]') && (el.textContent ?? '').trim() !== '')
      .map((el) => (el.textContent ?? '').trim())
  /** body の操作の前後で、新しく出た文。 */
  async function newMessagesAfter(act: () => void | Promise<void>): Promise<string[]> {
    const before = new Set(messages())
    await act()
    await settle()
    return messages().filter((m) => !before.has(m))
  }
  const rowOf = (email: string) => [...document.querySelectorAll('tr')].find((r) => (r.textContent ?? '').includes(email))!
  /** 行の学びの印（aria-label は「<名前> に <学びの名前>」）。 */
  const grantBox = (account: { name: string }, key: string) =>
    document.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${account.name} に ${LEARNINGS.find((l) => l.key === key)!.brand}"]`)!
  const buttonIn = (email: string, word: string) => [...rowOf(email).querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes(word))!

  /** 削除して読み直しまで済んだときに画面に出る文（成功の文を、失敗の場合と比べるために取る）。 */
  async function deletedMessages() {
    vi.stubGlobal('confirm', () => true)
    await openAdmin((c, n) => {
      if (c.method === 'DELETE') return { status: 200, body: { ok: true } }
      if (c.path === '/api/admin/accounts' && n >= 1) return { status: 200, body: { accounts: [ACCOUNTS[0]] } }
      return null
    })
    return newMessagesAfter(() => buttonIn(OTHER.email, '削除').click())
  }

  /** 行の学びの印の保存が断られたときに画面に出る文（成功の文と比べるために取る）。 */
  async function grantRefusedMessages() {
    await openAdmin((c) => (c.method === 'PUT' || c.method === 'PATCH' ? { status: 400, body: { error: '保存の断りの理由（テスト）' } } : null))
    const shown = await newMessagesAfter(() => grantBox(OTHER, 'ap').click())
    document.body.innerHTML = ''
    return shown
  }
  /** 他人のパスワードの再設定が断られたときに画面に出る文。 */
  async function resetRefusedMessages() {
    vi.stubGlobal('prompt', () => 'new-password-1234')
    await openAdmin((c) => (c.method === 'POST' && c.path.includes(OTHER.id) ? { status: 400, body: { error: '再設定の断りの理由（テスト）' } } : null))
    const shown = await newMessagesAfter(() => buttonIn(OTHER.email, '再設定').click())
    document.body.innerHTML = ''
    return shown
  }

  // @covers REQ-661#grants-saved-shown
  it('行の学びの印を付けて保存が済むと、済んだことが画面に出る（断られたときの文とは違う）', async () => {
    const refused = await grantRefusedMessages()
    const calls = await openAdmin((c) => (c.method === 'PUT' || c.method === 'PATCH' ? { status: 200, body: { ok: true } } : null))
    const shown = await newMessagesAfter(() => grantBox(OTHER, 'ap').click())
    expect(calls.some((c) => (c.method === 'PUT' || c.method === 'PATCH') && c.path.endsWith(OTHER.id)), '前提: 保存を求めていない').toBe(true)
    expect(shown.length, '保存が済んだのに画面に何も出ない').toBeGreaterThan(0)
    for (const m of refused) expect(shown, `保存が済んだのに、断られたときの文「${m}」が出た`).not.toContain(m)
    expect(grantBox(OTHER, 'ap').checked).toBe(true)
  })

  // @covers REQ-661#password-reset-shown
  it('他人のパスワードの再設定が済むと、済んだことが画面に出る（断られたときの文とは違う）', async () => {
    const refused = await resetRefusedMessages()
    vi.stubGlobal('prompt', () => 'new-password-1234')
    const calls = await openAdmin((c) => (c.method === 'POST' && c.path.includes(OTHER.id) ? { status: 200, body: { ok: true } } : null))
    const shown = await newMessagesAfter(() => buttonIn(OTHER.email, '再設定').click())
    expect(calls.some((c) => c.method === 'POST' && c.path.includes(OTHER.id)), '前提: 再設定を求めていない').toBe(true)
    expect(shown.length, '再設定が済んだのに画面に何も出ない').toBeGreaterThan(0)
    for (const m of refused) expect(shown, `再設定が済んだのに、断られたときの文「${m}」が出た`).not.toContain(m)
  })

  // @covers REQ-661#deleted-shown
  it('他人の削除を確かめて済み、一覧の読み直しも済むと、済んだことが画面に出る', async () => {
    const shown = await deletedMessages()
    expect(shown.length, '削除が済んだのに画面に何も出ない').toBeGreaterThan(0)
    expect(bodyText(), '読み直した一覧に消した相手が残っている').not.toContain(OTHER.email)
  })

  // @covers REQ-661#delete-reload-failed
  it('削除は済んだが一覧の読み直しに失敗すると、済んだことは出ず、読み直しの失敗の理由が出る', async () => {
    const done = await deletedMessages()
    document.body.innerHTML = ''
    const REASON = '一覧を読み直せませんでした（テストの理由）'
    vi.stubGlobal('confirm', () => true)
    await openAdmin((c, n) => {
      if (c.method === 'DELETE') return { status: 200, body: { ok: true } }
      if (c.path === '/api/admin/accounts' && n >= 1) return { status: 500, body: { error: REASON } }
      return null
    })
    const shown = await newMessagesAfter(() => buttonIn(OTHER.email, '削除').click())
    expect(shown.some((m) => m.includes(REASON)), `読み直しの失敗の理由が出ない: ${shown.join(' / ')}`).toBe(true)
    for (const m of done) expect(shown, '読み直しに失敗したのに済んだことが出た').not.toContain(m)
  })

  const REFUSAL = '学びの登録簿に無い学びが含まれています（テストの理由）'
  /** 行の学びの印 key を押し、保存が outcome（断られる・届かない）になったときに出た文と、そのあとの印を返す。 */
  async function grantSaveFails(key: 'ip' | 'ap', outcome: 'refused' | 'unreachable') {
    await openAdmin((c) =>
      c.method === 'PUT' || c.method === 'PATCH' ? (outcome === 'refused' ? { status: 400, body: { error: REFUSAL } } : 'unreachable') : null,
    )
    const before = grantBox(OTHER, key).checked
    const shown = await newMessagesAfter(() => grantBox(OTHER, key).click())
    return { before, shown, after: grantBox(OTHER, key).checked }
  }

  // @covers REQ-662#grant-check-refused
  it('印を付けた保存が断られると、断りの理由が出て、その印が外れた状態に戻る', async () => {
    const r = await grantSaveFails('ap', 'refused')
    expect(r.before, '前提: 押す前に印が付いている').toBe(false)
    expect(r.shown.some((m) => m.includes(REFUSAL)), `断りの理由が出ない: ${r.shown.join(' / ')}`).toBe(true)
    expect(r.after, '断られたのに印が付いたまま').toBe(false)
  })

  // @covers REQ-662#grant-check-unreachable
  it('印を付けた保存が届かないと、届かなかったことが出て、その印が外れた状態に戻る', async () => {
    const r = await grantSaveFails('ap', 'unreachable')
    expect(r.before, '前提: 押す前に印が付いている').toBe(false)
    expect(r.shown.length, '届かなかったのに画面に何も出ない').toBeGreaterThan(0)
    expect(r.after, '届かなかったのに印が付いたまま').toBe(false)
  })

  // @covers REQ-662#grant-uncheck-refused
  it('印を外した保存が断られると、断りの理由が出て、その印が付いた状態に戻る', async () => {
    const r = await grantSaveFails('ip', 'refused')
    expect(r.before, '前提: 押す前に印が外れている').toBe(true)
    expect(r.shown.some((m) => m.includes(REFUSAL)), `断りの理由が出ない: ${r.shown.join(' / ')}`).toBe(true)
    expect(r.after, '断られたのに印が外れたまま').toBe(true)
  })

  // @covers REQ-662#grant-uncheck-unreachable
  it('印を外した保存が届かないと、届かなかったことが出て、その印が付いた状態に戻る', async () => {
    const r = await grantSaveFails('ip', 'unreachable')
    expect(r.before, '前提: 押す前に印が外れている').toBe(true)
    expect(r.shown.length, '届かなかったのに画面に何も出ない').toBeGreaterThan(0)
    expect(r.after, '届かなかったのに印が外れたまま').toBe(true)
  })

  // @covers REQ-179#screen-shows-rejected-password
  it('再設定のパスワードが受け付けられないと、受け付けられなかった理由が画面に出る', async () => {
    const REASON = 'パスワードは 8 文字以上にしてください（テストの理由）'
    vi.stubGlobal('prompt', () => 'short-pw-but-sent-to-server')
    await openAdmin((c) => (c.method === 'POST' && c.path.includes(OTHER.id) ? { status: 400, body: { error: REASON } } : null))
    const shown = await newMessagesAfter(() => buttonIn(OTHER.email, '再設定').click())
    expect(shown.some((m) => m.includes(REASON)), `受け付けられなかった理由が出ない: ${shown.join(' / ')}`).toBe(true)
  })

  // @covers REQ-174#screen-shows-reset-target-missing
  it('再設定の相手が見つからないと、見つからない理由が画面に出る', async () => {
    const REASON = 'アカウントが見つかりません（テストの理由）'
    vi.stubGlobal('prompt', () => 'new-password-1234')
    await openAdmin((c) => (c.method === 'POST' && c.path.includes(OTHER.id) ? { status: 404, body: { error: REASON } } : null))
    const shown = await newMessagesAfter(() => buttonIn(OTHER.email, '再設定').click())
    expect(shown.some((m) => m.includes(REASON)), `見つからない理由が出ない: ${shown.join(' / ')}`).toBe(true)
  })

  // @covers REQ-175#screen-shows-delete-target-missing
  it('削除の相手が見つからないと、見つからない理由が画面に出る', async () => {
    const REASON = 'アカウントが見つかりません（テストの理由）'
    vi.stubGlobal('confirm', () => true)
    await openAdmin((c) => (c.method === 'DELETE' ? { status: 404, body: { error: REASON } } : null))
    const shown = await newMessagesAfter(() => buttonIn(OTHER.email, '削除').click())
    expect(shown.some((m) => m.includes(REASON)), `見つからない理由が出ない: ${shown.join(' / ')}`).toBe(true)
  })

  // @covers REQ-404#screen-shows-last-admin
  it('管理者の削除が最後の管理者を外すとして断られると、外せない理由が画面に出て、行は残る', async () => {
    const REASON = '最後の管理者は外せません（テストの理由）'
    vi.stubGlobal('confirm', () => true)
    await openAdmin((c) => (c.method === 'DELETE' ? { status: 409, body: { error: REASON } } : null), [...ACCOUNTS, OTHER_ADMIN])
    const shown = await newMessagesAfter(() => buttonIn(OTHER_ADMIN.email, '削除').click())
    expect(shown.some((m) => m.includes(REASON)), `外せない理由が出ない: ${shown.join(' / ')}`).toBe(true)
    expect(bodyText(), '断られたのに行が消えた').toContain(OTHER_ADMIN.email)
  })
})
