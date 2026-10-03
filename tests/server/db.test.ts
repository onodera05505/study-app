import { describe, expect, it } from 'vitest'
import { getDb, schema } from '../../src/server/lib/db'
import type { Bindings } from '../../src/server/lib/db'

const env = (over: Partial<Bindings> = {}) => ({ ...over }) as Bindings

describe('データの保存先（D1 と drizzle のスキーマ）', () => {
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
