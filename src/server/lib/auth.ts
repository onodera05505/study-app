import { sign, verify } from 'hono/jwt'

/** パスワードハッシュは Web Crypto の PBKDF2 で行う。
 *  bcryptjs は Workers 上で純 JS 実装になり CPU 時間を食うため使わない。 */
// Cloudflare Workers は PBKDF2 の反復回数を 100,000 までしか受け付けない
// （それ以上は NotSupportedError になる）。ローカルの miniflare は通ってしまうので、
// 本番に出すまで気づけなかった。上限いっぱいの 100,000 を使う。
const ITERATIONS = 100_000
const KEY_LENGTH = 32

const encoder = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH * 8,
  )
  return toHex(bits)
}

// @implements-old REQ-036
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(new ArrayBuffer(16))
  crypto.getRandomValues(salt)
  const hash = await derive(password, salt, ITERATIONS)
  return `${ITERATIONS}:${toHex(salt.buffer)}:${hash}`
}

// @implements-old REQ-093
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [iterStr, saltHex, expected] = stored.split(':')
  if (!iterStr || !saltHex || !expected) return false
  const actual = await derive(password, fromHex(saltHex), Number(iterStr))
  // 比較時間を入力に依存させない
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

export type TokenPayload = {
  sub: string
  name: string
  role: string
  exp: number
}

const TOKEN_TTL_SEC = 60 * 60 * 24 * 14

// @implements-old REQ-061
export async function issueToken(
  secret: string,
  user: { id: string; name: string; role: string },
): Promise<string> {
  const payload: TokenPayload = {
    sub: user.id,
    name: user.name,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
  }
  return sign(payload, secret, 'HS256')
}

// @implements-old REQ-087
export async function readToken(secret: string, token: string): Promise<TokenPayload | null> {
  try {
    return (await verify(token, secret, 'HS256')) as TokenPayload
  } catch {
    return null
  }
}
