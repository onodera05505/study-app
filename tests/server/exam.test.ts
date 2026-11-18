import { describe, expect, it } from 'vitest'
import targets from '../../src/shared/targets.json'
import { EXAMS, examOf } from '../../src/shared/exam'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/**
 * 配備に与えられた学びの key の解決（UC-017 の表「配備に与えられた学びの key」）。
 *
 * 登録簿 src/shared/targets.json が学びの値の正本で、ここでは値を書き写さずに登録簿から読む。
 * 学び側の配備は env の EXAM に学びの key を受ける。解決できない配備の断りは、契約の errorCodes の
 * NOT_CONFIGURED（配備に設定が無いことに当たる 503 と _shared の ErrorBody）で見る。文言そのものは照合しない。
 */

type Entry = Record<string, unknown>
const REGISTRY = targets as unknown as Record<string, Entry>
const REGISTERED = Object.keys(REGISTRY).filter((k) => !k.startsWith('_'))

/**
 * REQ-353 が挙げる、学びとして応えるのに使う値（名前・種類・1 回の問題数・制限時間・合否の目安・分野比率）の登録簿の項目。
 * 名前は学びの名前（brand・title）で、出典に添える試験の名前（examName）は REQ-353 の名前に数えない。
 */
const RESOLVED_FIELDS = ['brand', 'title', 'kind', 'mockSize', 'mockMinutes', 'passRule', 'fieldRatio'] as const

const SECRET = 'test-secret'
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

/** 学びの key を解決できない配備（key を与えない／登録簿に無い key）。署名の秘密の有無は over で決める。 */
const missingKey = (over: Partial<Bindings> = {}) => ({ JWT_SECRET: SECRET, ...over }) as Bindings
const unknownKey = (over: Partial<Bindings> = {}) => ({ EXAM: 'no-such-target', JWT_SECRET: SECRET, ...over }) as Bindings
const UNRESOLVED: Array<[string, (over?: Partial<Bindings>) => Bindings]> = [
  ['key が与えられていない', missingKey],
  ['key が登録簿に無い', unknownKey],
]

/** 何を聞かれても空を返す偽の D1（保存先が応答する配備）。 */
const passiveStore = (): D1Database => {
  const stmt: any = {
    bind: () => stmt,
    run: async () => ({ success: true, results: [], meta: {} }),
    all: async () => ({ success: true, results: [], meta: {} }),
    first: async () => null,
    raw: async () => [],
  }
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) } as unknown as D1Database
}

/** どのメソッドでも例外を投げる偽の D1（壊れている保存先）。 */
const brokenStore = (): D1Database => {
  const boom = () => {
    throw new Error('boom')
  }
  return { prepare: boom, batch: boom, exec: boom, dump: boom } as unknown as D1Database
}

const memberToken = () => issueToken(SECRET, { id: 'u-1', name: '名', role: 'MEMBER' })

const request = (method: string, body?: unknown, token?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
})

/** 配備に設定が無いことに当たる断り（503 と {error, code} だけ・日本語の 1 文）。 */
const expectNotConfigured = async (res: Response, label: string) => {
  expect(res.status, label).toBe(503)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body).sort(), `${label}: 本文が {error, code} だけでない`).toEqual(['code', 'error'])
  expect(String(body.error), `${label}: 理由が日本語でない`).toMatch(JAPANESE)
  expect(String(body.error).trim().split('\n'), label).toHaveLength(1)
}

/** 受け持つ /api の経路の代表（認証を要する取得・認証を要する変更・本人の記録）。契約の request を満たす本文を添える。 */
const OWNED_AUTH_REQUIRED: Array<[string, string, unknown]> = [
  ['GET', '/api/fields', undefined],
  ['GET', '/api/me', undefined],
  ['POST', '/api/sessions', { kind: 'review' }],
]

describe('学びの key の解決（UC-017）', () => {
  describe('REQ-353 登録簿にある学びとして応える', () => {
    // @covers REQ-353#every-registered-key-resolves
    it('登録簿（targets.json）の学びをすべて解決できる側に持ち、1 つも欠けず余りも無い', () => {
      expect(REGISTERED.length).toBeGreaterThan(1)
      expect(Object.keys(EXAMS).sort()).toEqual([...REGISTERED].sort())
    })

    // @covers REQ-353#every-registered-key-resolves
    it('登録簿にあるどの key を与えた配備も、解決できない側に落ちず、その学びとして死活確認と認証の形に応える', async () => {
      for (const key of REGISTERED) {
        expect(examOf(key).key, `${key} が別の学びとして解決された`).toBe(key)
        const env = { EXAM: key, JWT_SECRET: SECRET } as Bindings
        const health = await app.request('/api/health', {}, env)
        expect(health.status, `${key} の死活確認`).toBe(200)
        expect(await health.json(), `${key} の死活確認`).toEqual({ ok: true })
        const config = await app.request('/api/auth/config', {}, env)
        expect(config.status, `${key} の認証の形`).toBe(200)
      }
    })

    // @covers REQ-353#values-from-registry
    it('解決した学びの名前・種類・1 回の問題数・制限時間・合否の目安・分野比率が、その key の登録簿の値と同じ', () => {
      for (const key of REGISTERED) {
        const raw = REGISTRY[key]
        const resolved = examOf(key) as unknown as Record<string, unknown>
        expect(resolved.key, key).toBe(key)
        for (const field of RESOLVED_FIELDS) expect(raw[field], `仕込み: 登録簿の ${key} に ${field} が無い`).toBeDefined()
        const differs = RESOLVED_FIELDS.filter((field) => JSON.stringify(resolved[field]) !== JSON.stringify(raw[field]))
        expect(differs, `${key} で登録簿の値と違う項目`).toEqual([])
      }
    })
  })

  describe('REQ-354 学びの key を解決できない配備はどの要求も断る', () => {
    // @covers REQ-354#unknown-key-refused
    it('登録簿に無い key を与えた配備は、既定の学びに倒さず、受け持つ経路への通る要求を設定が無いことに当たる形で断る', async () => {
      const token = await memberToken()
      for (const [method, path, body] of OWNED_AUTH_REQUIRED) {
        await expectNotConfigured(await app.request(path, request(method, body, token), unknownKey({ DB: passiveStore() })), `${method} ${path}`)
      }
    })

    // @covers REQ-354#missing-key-refused
    it('key を与えていない配備は、既定の学びに倒さず、受け持つ経路への通る要求を設定が無いことに当たる形で断る', async () => {
      const token = await memberToken()
      for (const [method, path, body] of OWNED_AUTH_REQUIRED) {
        await expectNotConfigured(await app.request(path, request(method, body, token), missingKey({ DB: passiveStore() })), `${method} ${path}`)
      }
    })

    // @covers REQ-354#health-also-refused
    it('そうした配備の死活確認は、保存先が応答してもしなくても、生きていることを示さずに断る', async () => {
      for (const [label, deployment] of UNRESOLVED) {
        for (const [store, over] of [
          ['保存先が応答する', { DB: passiveStore() }],
          ['保存先が結びついていない', {}],
          ['保存先が壊れている', { DB: brokenStore() }],
        ] as Array<[string, Partial<Bindings>]>) {
          await expectNotConfigured(await app.request('/api/health', {}, deployment(over)), `${label}・${store}`)
        }
      }
    })

    // @covers REQ-354#auth-config-also-refused
    it('そうした配備への認証の形の問い合わせは、認証の形を答えずに断る', async () => {
      for (const [label, deployment] of UNRESOLVED) {
        await expectNotConfigured(await app.request('/api/auth/config', {}, deployment()), label)
      }
    })

    // @covers REQ-354#precedes-other-refusals
    it('トークンが無く・本文も形を満たさず・署名の秘密も無い要求でも、認証や本文の断りではなくこの断りが立つ', async () => {
      const token = await memberToken()
      for (const [label, deployment] of UNRESOLVED) {
        // 3 つ全部が重なる入力
        await expectNotConfigured(
          await app.request('/api/sessions', request('POST', { kind: 'zzz' }), deployment({ JWT_SECRET: undefined })),
          `${label}・トークン無し・本文の形違い・署名の秘密無し`,
        )
        // 認証の断り（401）より先
        await expectNotConfigured(await app.request('/api/sessions', request('POST', { kind: 'review' }), deployment()), `${label}・トークン無し`)
        // 本文の断り（400）より先
        await expectNotConfigured(
          await app.request('/api/sessions', request('POST', 'not json', token), deployment({ DB: passiveStore() })),
          `${label}・本文が JSON でない`,
        )
      }
    })
  })
})
