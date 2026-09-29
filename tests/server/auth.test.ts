import { sign } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import { hashPassword, issueToken, readToken, verifyPassword } from '../../src/server/lib/auth'

const SECRET = 'test-secret'
const user = { id: 'u-1', name: '小野寺', role: 'MEMBER' }

describe('パスワードのハッシュ', () => {
  // @verifies REQ-093
  it('ハッシュしたパスワードは同じ文字列で照合できる', async () => {
    const stored = await hashPassword('correct horse 8')
    expect(await verifyPassword('correct horse 8', stored)).toBe(true)
  })

  // @verifies REQ-093
  it('違うパスワード・壊れた保存値は照合に失敗する', async () => {
    const stored = await hashPassword('correct horse 8')
    expect(await verifyPassword('correct horse 9', stored)).toBe(false)
    expect(await verifyPassword('correct horse 8', 'no-colons')).toBe(false)
  })

  // @verifies REQ-036
  it('毎回ソルトが変わるので同じパスワードでもハッシュは一致しない', async () => {
    const a = await hashPassword('correct horse 8')
    const b = await hashPassword('correct horse 8')
    expect(a).not.toBe(b)
  })

  // PBKDF2 の反復回数は保存値の先頭に入る（Cloudflare Workers の上限は 100,000）
  // @verifies REQ-036
  it('反復回数は 100,000 以下', async () => {
    const stored = await hashPassword('correct horse 8')
    const iterations = Number(stored.split(':')[0])
    expect(Number.isInteger(iterations)).toBe(true)
    expect(iterations).toBeGreaterThan(0)
    expect(iterations).toBeLessThanOrEqual(100_000)
  })
})

describe('トークン', () => {
  // @verifies REQ-087
  it('発行したトークンは同じ秘密で読み戻せる', async () => {
    const token = await issueToken(SECRET, user)
    const payload = await readToken(SECRET, token)
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe('u-1')
    expect(payload!.name).toBe('小野寺')
    expect(payload!.role).toBe('MEMBER')
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  // @verifies REQ-087
  it('改ざん・別の秘密・素の文字列は null', async () => {
    const token = await issueToken(SECRET, user)
    const parts = token.split('.')
    // 中身だけ差し替えた（署名はそのままの）トークン
    const forged = btoa(JSON.stringify({ sub: 'u-2', name: 'other', role: 'ADMIN', exp: 9_999_999_999 })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    const tampered = [parts[0], forged, parts[2]].join('.')
    expect(await readToken(SECRET, tampered)).toBeNull()
    expect(await readToken('other-secret', token)).toBeNull()
    expect(await readToken(SECRET, 'not-a-token')).toBeNull()
  })

  // @verifies REQ-061
  it('HS256 で sub・name・role を持ち、期限は発行から 14 日', async () => {
    const issuedAt = Math.floor(Date.now() / 1000)
    const token = await issueToken(SECRET, user)
    const b64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    expect(JSON.parse(b64url(token.split('.')[0])).alg).toBe('HS256')
    const payload = await readToken(SECRET, token)
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe(user.id)
    expect(payload!.name).toBe(user.name)
    expect(payload!.role).toBe(user.role)
    const days = (payload!.exp - issuedAt) / 86_400
    expect(days).toBeGreaterThan(13.99)
    expect(days).toBeLessThan(14.01)
  })

  // @verifies REQ-087
  it('期限切れのトークンは null', async () => {
    const expired = await sign({ sub: 'u-1', name: '小野寺', role: 'MEMBER', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, 'HS256')
    expect(await readToken(SECRET, expired)).toBeNull()
  })
})
