import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'

/**
 * UC-013 学び側のパスワードでのログインと登録の求めは、受け持たない経路への要求と同じ断りになる（REQ-204）。
 *
 * 配備の側は UC.md の表「学び側の認証の受け口」の 4 行。どの行でも、学び側のパスワードでのログインと登録の求めは、
 * 同じ配備の受け持たない /api の経路（REQ-256）への要求と同じ状態と本文で断られ、トークンを返さない。
 * DB を束ねないので、断らずに本人の記録を作る処理へ進んだ求めは 404 にならない（記録を作れないことの観測）。
 */

const PORTAL_URL = 'https://portal.example'

/** UC.md の表「学び側の認証の受け口」の 4 行（学びの key は登録簿にある ip）。 */
const DEPLOYMENTS: Array<[string, Bindings]> = [
  ['まなびばの場所と共有秘密がそろっている', { EXAM: 'ip', JWT_SECRET: 'test-secret', SSO_PORTAL_URL: PORTAL_URL, SSO_SECRET: 'shared' } as Bindings],
  ['まなびばの場所はあるが共有秘密が無い', { EXAM: 'ip', JWT_SECRET: 'test-secret', SSO_PORTAL_URL: PORTAL_URL } as Bindings],
  ['まなびばの場所が無い', { EXAM: 'ip', JWT_SECRET: 'test-secret' } as Bindings],
  ['トークンの署名の秘密が無い', { EXAM: 'ip', SSO_PORTAL_URL: PORTAL_URL, SSO_SECRET: 'shared' } as Bindings],
]

const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** 学び側のパスワードで本人を得ようとする本文の代表（形を満たす本文と、満たさない本文）。 */
const LOGIN_BODIES: unknown[] = [{ email: 'yudai@example.com', password: 'harunokaze8' }, { email: 'yudai-example.com', password: '' }, {}]
const REGISTER_BODIES: unknown[] = [
  { email: 'yudai@example.com', password: 'harunokaze8', name: '山田 太郎' },
  { email: 'yudai@example.com', password: 'harunokaze8', name: '山田 太郎', signupCode: 'aikotoba' },
  {},
]

/** 応答の状態と本文。比べるために本文は文字列のまま持つ。 */
const snapshot = async (res: Response) => ({ status: res.status, body: await res.text() })

/** 同じ配備の受け持たない /api の経路への同じ形の要求（REQ-256 の断り）。 */
const notServed = async (env: Bindings, body: unknown) => snapshot(await app.request('/api/auth/no-such-path', post(body), env))

const expectSameAsNotServed = async (path: string, bodies: unknown[]) => {
  for (const [label, env] of DEPLOYMENTS) {
    for (const body of bodies) {
      const want = await notServed(env, body)
      expect(want.status, `${label}: 受け持たない経路の断りが 404 でない（比べる元が成り立たない）`).toBe(404)
      const got = await snapshot(await app.request(path, post(body), env))
      const caseLabel = `${label}・${path}・${JSON.stringify(body)}`
      expect(got, `${caseLabel}: 受け持たない経路への要求と同じ断りでない`).toEqual(want)
      expect(got.body, `${caseLabel}: トークンを返している`).not.toMatch(/"token"/)
    }
  }
}

describe('UC-013 学び側のパスワードでのログインと登録は受け持たない（REQ-204）', () => {
  // @covers REQ-204#password-login-not-served
  it('どの配備でも、学び側のパスワードでのログインの求めは受け持たない経路と同じ断りになり、トークンを返さない', async () => {
    await expectSameAsNotServed('/api/auth/login', LOGIN_BODIES)
  })

  // @covers REQ-204#register-not-served
  it('どの配備でも、学び側の登録の求めは受け持たない経路と同じ断りになり、トークンを返さない', async () => {
    await expectSameAsNotServed('/api/auth/register', REGISTER_BODIES)
  })
})
