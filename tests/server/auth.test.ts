import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_TTL_SEC, hashPassword, issueToken, readToken, verifyPassword } from '../../src/server/lib/auth'

const SECRET = 'test-secret'
const user = { id: 'u-1', name: '小野寺', role: 'MEMBER' }
const DAY_MS = 86_400_000
const PASSWORD = 'correct horse 8'

/** 配備先の実行環境の上限。値の正本は scripts/check_source.py の上限の定数（不変条件 O5）。 */
function runtimeLimit(): number {
  const src = readFileSync(new URL('../../scripts/check_source.py', import.meta.url), 'utf8')
  const m = src.match(/^PBKDF2_MAX\s*=\s*([\d_]+)/m)
  if (!m) throw new Error('scripts/check_source.py に上限の定数が見つからない')
  return Number(m[1].replace(/_/g, ''))
}

/** Web Crypto の導出に渡る計算量を集める。計算そのものは本物に任せる。 */
function spyDerivedIterations(): () => number[] {
  const spy = vi.spyOn(crypto.subtle, 'deriveBits')
  return () => spy.mock.calls.map(([algorithm]) => Number((algorithm as { iterations?: unknown }).iterations))
}

/** 成り立つ記録の欄（計算量・ソルト・導出の値）。壊れた記録は、この欄の 1 つだけを崩して作る。 */
async function storedFields(): Promise<[string, string, string]> {
  const stored = await hashPassword(PASSWORD)
  const fields = stored.split(':')
  if (fields.length !== 3) throw new Error('記録が「計算量:ソルト:導出の値」の 3 欄でない')
  return fields as [string, string, string]
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('パスワードのハッシュ', () => {
  // @covers REQ-290#same-password-matches
  it('保存した記録は保存したときと同じパスワードで照合に通る', async () => {
    const stored = await hashPassword(PASSWORD)
    expect(await verifyPassword(PASSWORD, stored)).toBe(true)
  })

  // @covers REQ-290#other-password-rejected
  it('成り立つ記録に違うパスワードを照合すると通らない', async () => {
    const stored = await hashPassword(PASSWORD)
    expect(await verifyPassword('correct horse 9', stored)).toBe(false)
  })

  // @covers REQ-290#broken-record-too-few-fields
  it.each([
    ['区切りの無い値', 'no-colons'],
    ['欄が 2 つの値', 'abc:def'],
  ])('欄の数が足りない記録（%s）の照合は、例外を投げずに通らないと答える', async (_label, record) => {
    await expect(verifyPassword(PASSWORD, record)).resolves.toBe(false)
  })

  // @covers REQ-290#broken-record-non-numeric-cost
  it('計算量の欄が数でない記録の照合は、例外を投げずに通らないと答える', async () => {
    const [, salt, hash] = await storedFields()
    await expect(verifyPassword(PASSWORD, `abc:${salt}:${hash}`)).resolves.toBe(false)
  })

  // @covers REQ-290#broken-record-non-hex-field
  it.each([
    ['ソルトの欄', (cost: string, _salt: string, hash: string) => `${cost}:zz-not-hex:${hash}`],
    ['導出の値の欄', (cost: string, salt: string) => `${cost}:${salt}:zz-not-hex`],
  ])('%sが 16 進でない記録の照合は、例外を投げずに通らないと答える', async (_label, build) => {
    const [cost, salt, hash] = await storedFields()
    await expect(verifyPassword(PASSWORD, build(cost, salt, hash))).resolves.toBe(false)
  })

  // @covers REQ-290#broken-record-empty-field
  it.each([
    ['計算量の欄', (_cost: string, salt: string, hash: string) => `:${salt}:${hash}`],
    ['ソルトの欄', (cost: string, _salt: string, hash: string) => `${cost}::${hash}`],
    ['導出の値の欄', (cost: string, salt: string) => `${cost}:${salt}:`],
  ])('%sが空の記録の照合は、例外を投げずに通らないと答える', async (_label, build) => {
    const [cost, salt, hash] = await storedFields()
    await expect(verifyPassword(PASSWORD, build(cost, salt, hash))).resolves.toBe(false)
  })

  // @covers REQ-290#broken-record-too-many-fields
  it('成り立つ記録の後ろに欄が余分に付いた記録の照合は、正しいパスワードでも例外を投げずに通らないと答える', async () => {
    const stored = await hashPassword(PASSWORD)
    await expect(verifyPassword(PASSWORD, `${stored}:junk`)).resolves.toBe(false)
  })

  // @covers REQ-290#broken-record-derived-length
  it('導出の値の欄が 16 進だが長さが違う記録の照合は、正しいパスワードでも例外を投げずに通らないと答える', async () => {
    const stored = await hashPassword(PASSWORD)
    await expect(verifyPassword(PASSWORD, `${stored}00`)).resolves.toBe(false)
  })

  // 欄の形は成り立ち、計算量の欄だけが上限を 1 超える
  // @covers REQ-290#over-limit-record-rejected
  it('上限を超える計算を求める記録の照合は、上限を超える導出に進まずに通らないと答える', async () => {
    const limit = runtimeLimit()
    const [, salt, hash] = await storedFields()
    const iterations = spyDerivedIterations()
    await expect(verifyPassword(PASSWORD, `${limit + 1}:${salt}:${hash}`)).resolves.toBe(false)
    expect(iterations().filter((n) => !(n <= limit))).toEqual([])
  })

  // @covers REQ-290#same-password-distinct-records
  it('同じパスワードを 2 度保存した記録どうしは一致しない', async () => {
    const a = await hashPassword(PASSWORD)
    const b = await hashPassword(PASSWORD)
    expect(a).not.toBe(b)
  })

  // @covers REQ-290#create-within-runtime-limit
  it('記録を作るとき Web Crypto の導出に渡る計算量は配備先の実行環境の上限を超えない', async () => {
    const limit = runtimeLimit()
    const iterations = spyDerivedIterations()
    await hashPassword(PASSWORD)
    expect(iterations().length).toBeGreaterThan(0)
    for (const n of iterations()) {
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
      expect(n).toBeLessThanOrEqual(limit)
    }
  })

  // 欄の形は成り立ち、計算量の欄が上限ちょうど。ここで見るのは答えが返ることと導出に渡る計算量で、答えの真偽は問わない
  // @covers REQ-290#verify-within-runtime-limit
  it('上限ちょうどの計算量の記録の照合は、上限の内の導出で答えを返す', async () => {
    const limit = runtimeLimit()
    const [, salt, hash] = await storedFields()
    const iterations = spyDerivedIterations()
    const answer = await verifyPassword(PASSWORD, `${limit}:${salt}:${hash}`)
    expect(typeof answer).toBe('boolean')
    expect(iterations()).toContain(limit)
    expect(iterations().filter((n) => !(n <= limit))).toEqual([])
  })

  // @covers REQ-290#persist-v1-compat
  it('配備された版が作った記録の見本は、今のコードで、作ったときのパスワードでだけ照合に通る', async () => {
    const golden = JSON.parse(readFileSync(new URL('../../contracts/fixtures/password-records-v1.json', import.meta.url), 'utf8')) as {
      records: Array<{ password: string; record: string }>
    }
    expect(golden.records.length, '見本が 1 件も無い').toBeGreaterThan(0)
    for (const { password, record } of golden.records) {
      expect(await verifyPassword(password, record), `見本の記録が作ったときのパスワードで通らない: ${record.slice(0, 16)}…`).toBe(true)
      expect(await verifyPassword(`${password}x`, record), `見本の記録が違うパスワードで通る: ${record.slice(0, 16)}…`).toBe(false)
    }
    // 見本どうしでパスワードを取り違えても通らない
    const [first, second] = golden.records
    if (first && second) expect(await verifyPassword(second.password, first.record)).toBe(false)
  })
})

describe('トークン', () => {
  // @covers REQ-289#issued-token-accepted
  it('この配備で発行して期間内のトークンは発行した本人として読まれる', async () => {
    const token = await issueToken(SECRET, user)
    const payload = await readToken(SECRET, token)
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe(user.id)
    expect(payload!.name).toBe(user.name)
    expect(payload!.role).toBe(user.role)
  })

  // @covers REQ-289#not-signed-by-this-deployment
  it('中身を差し替えた・別の秘密で作られた・トークンの形を成さないものは断る', async () => {
    const token = await issueToken(SECRET, user)
    const parts = token.split('.')
    // 中身だけ差し替えた（署名はそのままの）トークン
    const forged = btoa(JSON.stringify({ sub: 'u-2', name: 'other', role: 'ADMIN', exp: 9_999_999_999 })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    const tampered = [parts[0], forged, parts[2]].join('.')
    expect(await readToken(SECRET, tampered)).toBeNull()
    expect(await readToken('other-secret', token)).toBeNull()
    expect(await readToken(SECRET, 'not-a-token')).toBeNull()
  })

  // 期間の長さは実装の定数（秒）を読む。トークンの時刻は秒の単位なので、直前は 1 秒手前
  // @covers REQ-289#lifetime-from-issue
  it('発行したトークンは発行から決められた長さの直前まで通り、その長さちょうどで通らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const issuedAt = new Date('2026-11-01T00:00:00Z').getTime()
    vi.setSystemTime(issuedAt)
    const token = await issueToken(SECRET, user)

    vi.setSystemTime(issuedAt + (TOKEN_TTL_SEC - 1) * 1000)
    expect(await readToken(SECRET, token)).not.toBeNull()

    vi.setSystemTime(issuedAt + TOKEN_TTL_SEC * 1000)
    expect(await readToken(SECRET, token)).toBeNull()
  })

  // @covers REQ-289#expired
  it('決められた期間を過ぎたトークンは断る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const issuedAt = new Date('2026-08-01T00:00:00Z').getTime()
    vi.setSystemTime(issuedAt)
    const token = await issueToken(SECRET, user)

    vi.setSystemTime(issuedAt + TOKEN_TTL_SEC * 1000 + DAY_MS)
    expect(await readToken(SECRET, token)).toBeNull()
  })
})
