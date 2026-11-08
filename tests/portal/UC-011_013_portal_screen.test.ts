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

/** index.html を文書に入れ、そこが読む script を順に実行して、読み込み完了の合図を送る。 */
async function drawPortal(path = '/') {
  window.history.replaceState({}, '', path)
  const html = readFileSync(resolve(STATIC, 'index.html'), 'utf8')
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const sources = [...parsed.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')!)
  parsed.querySelectorAll('script').forEach((s) => s.remove())
  document.head.innerHTML = parsed.head.innerHTML
  document.body.innerHTML = parsed.body.innerHTML
  for (const src of sources) {
    const code = readFileSync(resolve(STATIC, src.replace(/^\//, '')), 'utf8')
    ;(0, eval)(code)
  }
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
