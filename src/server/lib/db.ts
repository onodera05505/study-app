import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'

export type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  JWT_SECRET?: string
  /** 新規登録に必要な合言葉。未設定なら登録は誰でもできる（身内向けの想定）。 */
  SIGNUP_CODE?: string
  APP_NAME?: string
  /** どの試験のデプロイか（'ip' | 'ap'）。未設定なら ip。src/shared/exam.ts を参照 */
  EXAM?: string
}

export type Variables = {
  user: { id: string; name: string; role: string }
}

export function getDb(env: Bindings) {
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof getDb>

/** JWT_SECRET は secret として設定する運用。未設定のまま本番に出さないよう、
 *  開発用の既定値を使ったことが分かるようにしておく。 */
export function getSecret(env: Bindings): string {
  return env.JWT_SECRET ?? 'dev-only-insecure-secret'
}

export { schema }
