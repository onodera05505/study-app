import { describe, expect, it } from 'vitest'
import { getDb, getSecret, schema } from '../../src/server/lib/db'
import type { Bindings } from '../../src/server/lib/db'

const env = (over: Partial<Bindings> = {}) => ({ ...over }) as Bindings

describe('データの保存先（D1 と drizzle のスキーマ）', () => {
  // @verifies REQ-048
  it('getDb は env.DB を束ねた drizzle を返し、schema の全表を query で引ける', () => {
    const calls: string[] = []
    const fakeD1 = { prepare: (sql: string) => { calls.push(sql); throw new Error('not executed in unit test') } } as unknown as D1Database
    const db = getDb(env({ DB: fakeD1 }))
    for (const table of ['users', 'topics', 'pastQuestions', 'topicQuestions', 'sessions', 'sessionQuestions', 'progress', 'feedback', 'glossary', 'questionExplanations', 'appSettings', 'syllabusItems', 'dailyVisits'] as const) {
      expect(schema[table], table).toBeDefined()
      expect((db.query as Record<string, unknown>)[table], `query.${table}`).toBeDefined()
    }
    // 生成時には SQL を発行しない（接続の口を作るだけ）
    expect(calls).toEqual([])
  })
})

describe('トークンの秘密', () => {
  // @verifies REQ-049
  it('JWT_SECRET があればその値を返す', () => {
    expect(getSecret(env({ JWT_SECRET: 'from-secret' }))).toBe('from-secret')
  })

  // @verifies REQ-049
  it('未設定の環境では開発用の既定値に倒れる（本番は secret を設定する運用）', () => {
    expect(getSecret(env())).toBe('dev-only-insecure-secret')
  })
})
