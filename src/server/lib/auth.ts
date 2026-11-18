import { sign, verify } from 'hono/jwt'

// Cloudflare Workers は PBKDF2 の反復回数を 100,000 までしか受け付けない
// （それ以上は NotSupportedError になる。ローカルの miniflare は上限を課さないので、
// 超えると本番でだけ落ちる）。上限いっぱいの 100,000 を使う。上限の値は scripts/check_source.py が持つ。
const ITERATIONS = 100_000
// 照合の側の上限。scripts/check_source.py の上限（PBKDF2_MAX）と同じ値。これを超える記録は導出に進まない。
const PBKDF2_MAX = 100_000
const KEY_LENGTH = 32
const RECORD_RE = /^([1-9][0-9]*):((?:[0-9a-f]{2})+):([0-9a-f]+)$/

const encoder = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** パスワードの記録は Web Crypto の PBKDF2 で作る。
 *  bcryptjs は Workers 上で純 JS 実装になり CPU 時間を食うため使わない。 */
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

/** @implements REQ-290, BR-039 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(new ArrayBuffer(16))
  crypto.getRandomValues(salt)
  const hash = await derive(password, salt, ITERATIONS)
  return `${ITERATIONS}:${toHex(salt.buffer)}:${hash}`
}

/** @implements REQ-290, BR-039 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // 記録として成り立たない値・上限を超える計算量は、導出に進まず通らないと答える
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const m = RECORD_RE.exec(stored)
  if (!m) return false
  const [, iterStr, saltHex, expected] = m
  const iterations = Number(iterStr)
  if (!Number.isSafeInteger(iterations) || iterations > PBKDF2_MAX) return false
  if (expected.length !== KEY_LENGTH * 2) return false
  let actual: string
  try {
    actual = await derive(password, fromHex(saltHex), iterations)
  } catch {
    return false
  }
  // 比較時間を入力に依存させない
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/** 配備にトークンの署名の秘密が無いときの断り。トークンを発行する経路と、認証を要する経路が
 *  同じ形で断る。本文はどの設定が足りないかを明かさない。 */
export const NOT_CONFIGURED = {
  status: 503,
  error: 'この配備はまだ設定が終わっていません。管理者に連絡してください',
} as const

export type TokenPayload = {
  sub: string
  name: string
  role: string
  exp: number
}

export const TOKEN_TTL_SEC = 60 * 60 * 24 * 14

/** @implements REQ-289 */
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

/** @implements REQ-289, BR-044 */
export async function readToken(secret: string, token: string): Promise<TokenPayload | null> {
  try {
    return (await verify(token, secret, 'HS256')) as TokenPayload
  } catch {
    return null
  }
}
