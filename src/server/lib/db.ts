import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'

export type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  JWT_SECRET?: string
  /** 新規登録に必要な合言葉。未設定なら登録は誰でもできる（身内向けの想定）。 */
  SIGNUP_CODE?: string
  /** まなびば（SSO）。設定された環境ではパスワードのログイン・登録を受けない（要件 §15） */
  SSO_PORTAL_URL?: string
  SSO_SECRET?: string
  APP_NAME?: string
  /** どの試験のデプロイか（'ip' | 'ap'）。未設定なら ip。src/shared/exam.ts を参照 */
  EXAM?: string
}

export type Variables = {
  user: { id: string; name: string; role: string }
}

// @implements REQ-048
export function getDb(env: Bindings) {
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof getDb>

/** JWT_SECRET は secret として設定する運用。未設定のまま本番に出さないよう、
 *  開発用の既定値を使ったことが分かるようにしておく。 */
// @implements REQ-049, REQ-095
export function getSecret(env: Bindings): string {
  return env.JWT_SECRET ?? 'dev-only-insecure-secret'
}

export { schema }
