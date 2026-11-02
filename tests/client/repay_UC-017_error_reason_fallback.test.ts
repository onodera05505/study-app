// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * UC-017 学びとまなびばの要求の受け口を一様に守る（画面側。REQ-261）。
 *
 * 学び側への要求が失敗の応答で返り、本文に理由（{error}）が添えられていないとき、
 * 画面の API 呼び出しが利用者に伝える文が日本語の 1 文に倒れることを見る。
 * 「理由が無い」は、本文に error の項目が無い場合と本文が JSON として読めない場合の両方。
 */

// api.ts はモジュールの中で memo を持つので、テストごとに読み直す
async function load() {
  vi.resetModules()
  return await import('../../src/client/lib/api')
}

const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** 理由の無い失敗の応答（本文に error が無い・本文が JSON でない・本文が空）。 */
const REASONLESS: Array<[string, () => Response]> = [
  ['500 で本文が {}', () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } })],
  ['400 で本文に error 以外の鍵だけ', () => new Response(JSON.stringify({ detail: 'x' }), { status: 400, headers: { 'Content-Type': 'application/json' } })],
  ['502 で本文が HTML', () => new Response('<html><body>Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } })],
  ['503 で本文が空', () => new Response('', { status: 503 })],
]

/** 1 つの応答について、利用者に伝わる文が日本語の 1 文に倒れていない点を列挙する（無ければ空）。 */
const problemsOf = (label: string, e: unknown, ApiError: abstract new (...args: never[]) => Error): string[] => {
  if (!(e instanceof ApiError)) return [`${label}: ApiError でなく ${String(e)} がそのまま漏れる`]
  const message = e.message
  const problems: string[] = []
  if (!JAPANESE.test(message)) problems.push(`${label}: 日本語でない（${message}）`)
  if (message.trim() === '') problems.push(`${label}: 空`)
  if (message.trim().split('\n').length !== 1) problems.push(`${label}: 1 文でない`)
  if (/Internal Server Error|Bad Gateway|Unexpected token|<html|JSON/i.test(message)) problems.push(`${label}: 英語の既定文か HTML が出ている（${message}）`)
  return problems
}

describe('UC-017 失敗の応答に理由が無いときの画面の文', () => {
  // @covers REQ-261#reason-absent-fallback
  it('理由の無い失敗は、状態コードに関わらず日本語の 1 文に倒れ、英語の既定文や HTML を出さない', async () => {
    const m = await load()
    const problems: string[] = []
    for (const [label, response] of REASONLESS) {
      vi.stubGlobal('fetch', vi.fn(async () => response()))
      const e = await m.api('/x').catch((x: unknown) => x)
      problems.push(...problemsOf(label, e, m.ApiError))
    }
    expect(problems).toEqual([])
  })
})
