import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** フィードバックの受け口（UC-010 の表 3）。受け付けた送信が残ること・断った送信が残らないこと・
 *  直近 1 日の上限を、偽の D1 で見る。
 *
 *  偽の D1 は、走らせた SQL と束ねた値を `executed` に記録する。「残る」は feedback への INSERT が
 *  1 件あり本文などの値が束ねられていること、「残らない」は INSERT が 1 件も無いことで見る。
 *  直近 1 日の件数は、feedback を読む SELECT に対して「どの列名で読んでも同じ数を返す行」を
 *  `dailyCount` 件返して作る（件数を集約で読む作りでも、行を数える作りでも同じ値になる）。
 *  表の名前と列は保存先の正本（schema）が持つので、ここでは SQL の中に feedback が現れることだけを見る。 */
type Executed = { sql: string; params: unknown[] }

function fakeD1(dailyCount: number, executed: Executed[]) {
  const countRow = new Proxy(
    {},
    { get: () => dailyCount, has: () => true, ownKeys: () => [], getOwnPropertyDescriptor: () => undefined },
  )
  const readsFeedback = (sql: string) => /^\s*select\b[\s\S]*\bfeedback\b/i.test(sql)
  const rowsFor = (sql: string): unknown[] =>
    readsFeedback(sql) ? Array.from({ length: dailyCount }, () => countRow) : []
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const record = () => executed.push({ sql, params })
    const stmt = {
      bind: (...bound: unknown[]) => {
        params = bound
        return stmt
      },
      run: async () => {
        record()
        return { success: true, results: [], meta: {} }
      },
      all: async () => {
        record()
        return { success: true, results: rowsFor(sql), meta: {} }
      },
      first: async () => {
        record()
        return rowsFor(sql)[0] ?? null
      },
      raw: async () => {
        record()
        const rows = rowsFor(sql)
        // 集約を位置で読む作りに合わせ、列の数だけ同じ値を並べる
        const width = Math.max(1, (sql.match(/,/g) ?? []).length + 1)
        return rows.map(() => Array.from({ length: width }, () => dailyCount))
      },
    }
    return stmt
  }
  return { prepare, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) }
}

const SECRET = 'test-secret'
const USER_ID = 'u-1'
const env = (dailyCount: number, executed: Executed[]) =>
  ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(dailyCount, executed) }) as unknown as Bindings

/** 契約 `submitFeedback` の `overDailyLimit` の例（21 件目が断られる）が示す 1 日の上限。 */
const DAILY_LIMIT = 20

type Sent = { res: Response; executed: Executed[] }

/** JSON の送信。`dailyCount` は直近 1 日に受け付け済みの件数。 */
async function post(payload: unknown, dailyCount = 0): Promise<Sent> {
  return postRaw(JSON.stringify(payload), dailyCount)
}

/** 本体を文字列のまま送る（JSON でない本体を送るのに使う）。 */
async function postRaw(body: string, dailyCount = 0): Promise<Sent> {
  const executed: Executed[] = []
  const token = await issueToken(SECRET, { id: USER_ID, name: '名', role: 'MEMBER' })
  const res = await app.request(
    '/api/feedback',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    },
    env(dailyCount, executed),
  )
  return { res, executed }
}

/** feedback への INSERT だけを取り出す。 */
const feedbackInserts = (executed: Executed[]) =>
  executed.filter(({ sql }) => /^\s*insert\b[\s\S]*\bfeedback\b/i.test(sql))

/** 日本語が 1 文字も無い理由は、たいてい内部の例外がそのまま出ている。 */
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

async function expectJapaneseReason(res: Response, label: string) {
  const data = (await res.json()) as { error?: unknown; id?: unknown }
  expect(typeof data.error, `${label}: 理由が文字列でない`).toBe('string')
  expect(JAPANESE.test(String(data.error)), `${label}: 理由が日本語でない: ${String(data.error)}`).toBe(true)
  expect(data.id, `${label}: 断ったのに受付の id が返っている`).toBeUndefined()
}

/** 形の正しい送信が 201 で受け付けられ、受付の id だけが返ること（偽の D1 が通せていることの確認）。 */
async function expectAccepted(payload: unknown, dailyCount = 0): Promise<Sent> {
  const sent = await post(payload, dailyCount)
  expect(sent.res.status, `形の正しい ${JSON.stringify(payload)} が受け付けられない`).toBe(201)
  return sent
}

describe('フィードバックの受け口の保存と上限（UC-010）', () => {
  // @covers REQ-159#accept-and-store
  it('本文と種類がそろった送信は、送った本人のフィードバックとして残り、受付の id だけが返る', async () => {
    const { res, executed } = await expectAccepted({ body: '単位「LTV」の 1÷解約率のところが分かりにくかった', kind: 'improve' })
    const data = (await res.json()) as Record<string, unknown>
    expect(typeof data.id).toBe('string')
    expect(String(data.id).length).toBeGreaterThan(0)
    // 返すのは受付の id だけ（その場の応答は返さない）
    expect(Object.keys(data)).toEqual(['id'])

    const inserts = feedbackInserts(executed)
    expect(inserts, 'feedback への INSERT が 1 件でない').toHaveLength(1)
    const bound = inserts[0].params.map(String)
    expect(bound, '本文が残っていない').toContain('単位「LTV」の 1÷解約率のところが分かりにくかった')
    expect(bound, '種類が残っていない').toContain('improve')
    expect(bound, '送った本人に紐づいていない').toContain(USER_ID)
  })

  // @covers REQ-159#accept-and-store
  it('前後の空白は落とした形で残す', async () => {
    const { executed } = await expectAccepted({ body: '  分かりにくかった  ', kind: 'good' })
    const bound = feedbackInserts(executed)[0]?.params.map(String) ?? []
    expect(bound).toContain('分かりにくかった')
    expect(bound).not.toContain('  分かりにくかった  ')
  })

  // @covers REQ-159#attachment-stored
  it('添え先（場所・論点・問題）を添えた送信は、その添え先ごと残る', async () => {
    const withTopic = await expectAccepted({
      body: '単位「LTV」の 1÷解約率のところが分かりにくかった',
      kind: 'improve',
      page: '/topics/412',
      topicId: 412,
    })
    const boundTopic = feedbackInserts(withTopic.executed)[0]?.params.map(String) ?? []
    expect(boundTopic, '場所が残っていない').toContain('/topics/412')
    expect(boundTopic, '論点が残っていない').toContain('412')

    const withQuestion = await expectAccepted({
      body: 'この問の選択肢に答えが無いように見える',
      kind: 'other',
      page: '/sessions/51d0',
      questionId: '51d0e9b7-6a24-4c83-9f15-7b2e0d8a43c6#2',
    })
    const boundQuestion = feedbackInserts(withQuestion.executed)[0]?.params.map(String) ?? []
    expect(boundQuestion, '場所が残っていない').toContain('/sessions/51d0')
    expect(boundQuestion, '問題が残っていない').toContain('51d0e9b7-6a24-4c83-9f15-7b2e0d8a43c6#2')
  })

  // @covers REQ-159#no-attachment-accepted
  it('添え先の無い送信も受け付けて残す', async () => {
    const { res, executed } = await expectAccepted({ body: '分かりにくかった', kind: 'improve' })
    expect(typeof ((await res.json()) as { id?: unknown }).id).toBe('string')
    const inserts = feedbackInserts(executed)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].params.map(String)).toContain('分かりにくかった')
  })

  // @covers REQ-160#body-wrong-type
  it('本文の型が違う送信・本文ごと JSON でない送信は 400 と日本語の理由', async () => {
    for (const payload of [{ body: 123 }, { body: null }, { body: ['分かりにくかった'] }, { body: { text: 'x' } }]) {
      const { res } = await post(payload)
      expect(res.status, `${JSON.stringify(payload)} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, JSON.stringify(payload))
    }
    for (const raw of ['これは JSON ではない', '[]', '"分かりにくかった"']) {
      const { res } = await postRaw(raw)
      expect(res.status, `本体 ${raw} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, `本体 ${raw}`)
    }
  })

  // @covers REQ-160#kind-not-allowed
  it('決められていない種類の送信は 400 と日本語の理由（決められた種類は通る）', async () => {
    for (const kind of ['zzz', '', 'GOOD', 1]) {
      const { res } = await post({ body: '分かりにくかった', kind })
      expect(res.status, `kind=${JSON.stringify(kind)} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, `kind=${JSON.stringify(kind)}`)
    }
    for (const kind of ['text', 'unclear', 'good', 'improve', 'other']) {
      await expectAccepted({ body: '分かりにくかった', kind })
    }
  })

  // @covers REQ-160#attachment-wrong-shape
  it('添え先（場所・論点・問題）が決められた形でない送信は 400 と日本語の理由', async () => {
    const malformed: Record<string, unknown>[] = [
      { topicId: '1' },
      { topicId: 0 },
      { topicId: -1 },
      { topicId: 1.5 },
      { page: 12 },
      { page: 'a'.repeat(201) },
      { questionId: 7 },
      { questionId: 'q'.repeat(65) },
    ]
    for (const extra of malformed) {
      const payload = { body: '分かりにくかった', kind: 'improve', ...extra }
      const { res } = await post(payload)
      expect(res.status, `${JSON.stringify(extra)} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, JSON.stringify(extra))
    }
    // 上限ちょうどの長さは通る
    await expectAccepted({ body: '分かりにくかった', kind: 'improve', page: 'a'.repeat(200) })
    await expectAccepted({ body: '分かりにくかった', kind: 'improve', questionId: 'q'.repeat(64) })
  })

  // @covers REQ-160#nothing-stored
  it('形で断った送信はフィードバックとして残らない', async () => {
    const rejected: Array<{ label: string; send: () => Promise<Sent> }> = [
      { label: '本文が空白だけ', send: () => post({ body: '   ', kind: 'improve' }) },
      { label: '本文が長すぎ', send: () => post({ body: 'あ'.repeat(2001), kind: 'improve' }) },
      { label: '本文の型違い', send: () => post({ body: 123 }) },
      { label: '本体が JSON でない', send: () => postRaw('これは JSON ではない') },
      { label: '種類が決められていない', send: () => post({ body: '分かりにくかった', kind: 'zzz' }) },
      { label: '論点が文字列', send: () => post({ body: '分かりにくかった', topicId: '1' }) },
    ]
    for (const { label, send } of rejected) {
      const { res, executed } = await send()
      expect(res.status, `${label} が 400 で拒まれていない`).toBe(400)
      expect(feedbackInserts(executed), `${label} なのにフィードバックが残っている`).toEqual([])
    }
  })

  // @covers REQ-160#invalid-before-rate-limit
  it('上限に達している利用者からの形の違う送信は、上限の理由より先に形の理由（400）で断る', async () => {
    for (const payload of [{ body: '   ', kind: 'improve' }, { body: '分かりにくかった', kind: 'zzz' }]) {
      const { res, executed } = await post(payload, DAILY_LIMIT)
      expect(res.status, `${JSON.stringify(payload)} が 400 でない（上限の理由が先に出ている）`).toBe(400)
      await expectJapaneseReason(res, JSON.stringify(payload))
      expect(feedbackInserts(executed)).toEqual([])
    }
  })

  // @covers REQ-161#at-limit-rejected
  it('直近 1 日の受付が上限に達している間の送信は 429 と日本語の理由', async () => {
    for (const dailyCount of [DAILY_LIMIT, DAILY_LIMIT + 5]) {
      const { res } = await post({ body: '21 件目のフィードバック', kind: 'good' }, dailyCount)
      expect(res.status, `受付済み ${dailyCount} 件で 429 にならない`).toBe(429)
      await expectJapaneseReason(res, `受付済み ${dailyCount} 件`)
    }
  })

  // @covers REQ-161#nothing-stored
  it('上限で断った送信はフィードバックとして残らない', async () => {
    const { res, executed } = await post({ body: '21 件目のフィードバック', kind: 'good' }, DAILY_LIMIT)
    expect(res.status).toBe(429)
    expect(feedbackInserts(executed), '上限で断ったのにフィードバックが残っている').toEqual([])
  })

  // @covers REQ-161#under-limit-accepted
  it('上限に達するまでの送信は受け付ける（上限の件数目まで通る）', async () => {
    for (const dailyCount of [0, 1, DAILY_LIMIT - 1]) {
      const { res, executed } = await post({ body: `${dailyCount + 1} 件目のフィードバック`, kind: 'good' }, dailyCount)
      expect(res.status, `受付済み ${dailyCount} 件で受け付けられない`).toBe(201)
      expect(feedbackInserts(executed)).toHaveLength(1)
    }
  })
})
