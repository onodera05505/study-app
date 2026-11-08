import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'

export type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  /** トークンの署名の秘密。secret として配備ごとに設定する。無い配備ではトークンを発行も検証もしない。 */
  JWT_SECRET?: string
  /** 新規登録に必要な合言葉。未設定なら登録は誰でもできる（身内向けの想定）。 */
  SIGNUP_CODE?: string
  /** まなびば（SSO）。設定された環境ではパスワードのログイン・登録を受けない。 */
  SSO_PORTAL_URL?: string
  SSO_SECRET?: string
  APP_NAME?: string
  /** どの学びの配備か（登録簿の key）。解決できない配備はどの /api の要求も断る。src/shared/exam.ts を参照 */
  EXAM?: string
}

export type Variables = {
  user: { id: string; name: string; role: string }
}

export function getDb(env: Bindings) {
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof getDb>

/** トークンの署名の秘密を取り出す。配備に無ければ null。
 *  署名の秘密が在るかどうかの判定はここ 1 か所で、呼び出し側は null のときに断る。
 *  既定値には倒さない（倒すと、秘密の無い配備が弱い鍵で発行と検証を続けてしまう）。 */
export function getSecret(env: Bindings): string | null {
  return env.JWT_SECRET ?? null
}

export { schema }
