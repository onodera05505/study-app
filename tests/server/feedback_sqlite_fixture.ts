/** フィードバックの受け口（UC-010 の契約 submitFeedback ＝ POST /api/feedback）を、migrations を当てた
 *  本物の SQLite（node:sqlite を D1 の口で包んだ tests/portal/repay_UC-014_sqlite_d1.ts）に向けて叩くための土台。
 *
 *  SQL の形を真似る偽物と違い、受け口が prepare で書いても batch で書いても SQLite がそのまま実行するので、
 *  「残る」「残らない」を書き込みの書き方に依らずに、保存先（migrations の feedback 表）を読み戻して観測できる。
 *  直近 1 日の受付の件数は、送る前に feedback 表へその人の行を今の時刻で直接置いて作る。 */

import { learningD1, sqliteOf, type DatabaseSync } from '../portal/repay_UC-014_sqlite_d1'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

export const SECRET = 'test-secret'
export const USER_ID = 'u-1'

/** 日本語が 1 文字も無い理由は、たいてい内部の例外がそのまま出ている。 */
export const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

/** 保存先に残ったフィードバックの 1 行（migrations の feedback 表の列）。 */
export type StoredFeedback = {
  id: string
  user_id: string
  kind: string
  page: string | null
  topic_id: number | null
  question_id: string | null
  body: string
}

export type Sent = { res: Response; stored: StoredFeedback[] }

/** 利用者が 1 人居る空の学びの D1。直近 1 日に dailyCount 件を受け付け済みにしておく。 */
async function openStore(dailyCount: number): Promise<{ d1: D1Database; db: DatabaseSync; seeded: Set<string> }> {
  const d1 = await learningD1()
  const db = sqliteOf(d1)
  db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'x')`).run(USER_ID, `${USER_ID}@example.com`, '名')
  const seeded = new Set<string>()
  for (let i = 0; i < dailyCount; i++) {
    const id = `seeded-${i}`
    db.prepare(`INSERT INTO feedback (id, user_id, kind, body) VALUES (?, ?, 'good', ?)`).run(id, USER_ID, `受付済み ${i + 1}`)
    seeded.add(id)
  }
  return { d1, db, seeded }
}

/** 本体を文字列のまま送る（JSON でない本体を送るのにも使う）。auth = false ならトークンを付けない。 */
export async function postRaw(body: string, dailyCount = 0, auth = true): Promise<Sent> {
  const { d1, db, seeded } = await openStore(dailyCount)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = `Bearer ${await issueToken(SECRET, { id: USER_ID, name: '名', role: 'MEMBER' })}`
  const env = { EXAM: 'ip', JWT_SECRET: SECRET, DB: d1 } as unknown as Bindings
  const res = await app.request('/api/feedback', { method: 'POST', headers, body }, env)
  const rows = db
    .prepare(`SELECT id, user_id, kind, page, topic_id, question_id, body FROM feedback`)
    .all() as unknown as StoredFeedback[]
  return { res, stored: rows.filter((row) => !seeded.has(row.id)) }
}

/** JSON の送信。dailyCount は直近 1 日に受け付け済みの件数。 */
export async function post(payload: unknown, dailyCount = 0, auth = true): Promise<Sent> {
  return postRaw(JSON.stringify(payload), dailyCount, auth)
}
