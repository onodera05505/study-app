import { describe, expect, it } from 'vitest'
import { JAPANESE, USER_ID, post, postRaw, type Sent } from './feedback_sqlite_fixture'

/** フィードバックの受け口（UC-010 の表 3）。受け付けた送信が残ること・断った送信が残らないこと・
 *  直近 1 日の上限を、migrations を当てた本物の SQLite（feedback_sqlite_fixture.ts）で見る。
 *  「残る」「残らない」は、送ったあとに保存先の feedback 表を読み戻して見る。
 *  本文・添え先のクラスは種類（kind）を契約の許す値で添えて送る（種類の欠けで先に断られると、
 *  そのクラスの理由で断られたことを観測できない）。 */

/** 契約 `submitFeedback` の `overDailyLimit` の例（21 件目が断られる）が示す 1 日の上限。 */
const DAILY_LIMIT = 20

async function expectJapaneseReason(res: Response, label: string) {
  const data = (await res.json()) as { error?: unknown; id?: unknown }
  expect(typeof data.error, `${label}: 理由が文字列でない`).toBe('string')
  expect(JAPANESE.test(String(data.error)), `${label}: 理由が日本語でない: ${String(data.error)}`).toBe(true)
  expect(data.id, `${label}: 断ったのに受付の id が返っている`).toBeUndefined()
}

/** 形の正しい送信が 201 で受け付けられ、受付の id だけが返ること（本文以外のクラスの対照）。 */
async function expectAccepted(payload: unknown, dailyCount = 0): Promise<Sent> {
  const sent = await post(payload, dailyCount)
  expect(sent.res.status, `形の正しい ${JSON.stringify(payload)} が受け付けられない`).toBe(201)
  return sent
}

describe('フィードバックの受け口の保存と上限（UC-010）', () => {
  // @covers REQ-159#accept-and-store
  it('本文と種類がそろった送信は、送った本人のフィードバックとして残り、受付の id だけが返る', async () => {
    const { res, stored } = await expectAccepted({ body: '単位「LTV」の 1÷解約率のところが分かりにくかった', kind: 'improve' })
    const data = (await res.json()) as Record<string, unknown>
    expect(typeof data.id).toBe('string')
    expect(String(data.id).length).toBeGreaterThan(0)
    // 返すのは受付の id だけ（その場の応答は返さない）
    expect(Object.keys(data)).toEqual(['id'])

    expect(stored, 'フィードバックが 1 件だけ残っていない').toHaveLength(1)
    expect(stored[0].id, '返した id で残っていない').toBe(data.id)
    expect(stored[0].body).toBe('単位「LTV」の 1÷解約率のところが分かりにくかった')
    expect(stored[0].kind).toBe('improve')
    expect(stored[0].user_id, '送った本人に紐づいていない').toBe(USER_ID)
  })

  // @covers REQ-159#accept-and-store
  it('前後の空白は落とした形で残す', async () => {
    const { stored } = await expectAccepted({ body: '  分かりにくかった  ', kind: 'good' })
    expect(stored.map((row) => row.body)).toEqual(['分かりにくかった'])
  })

  // @covers REQ-159#attachment-stored
  it('添え先（場所・論点・問題）を添えた送信は、その添え先ごと残る', async () => {
    const withTopic = await expectAccepted({
      body: '単位「LTV」の 1÷解約率のところが分かりにくかった',
      kind: 'improve',
      page: '/topics/412',
      topicId: 412,
    })
    expect(withTopic.stored).toHaveLength(1)
    expect(withTopic.stored[0].page, '場所が残っていない').toBe('/topics/412')
    expect(withTopic.stored[0].topic_id, '論点が残っていない').toBe(412)

    const withQuestion = await expectAccepted({
      body: 'この問の選択肢に答えが無いように見える',
      kind: 'other',
      page: '/sessions/51d0',
      questionId: '51d0e9b7-6a24-4c83-9f15-7b2e0d8a43c6#2',
    })
    expect(withQuestion.stored).toHaveLength(1)
    expect(withQuestion.stored[0].page, '場所が残っていない').toBe('/sessions/51d0')
    expect(withQuestion.stored[0].question_id, '問題が残っていない').toBe('51d0e9b7-6a24-4c83-9f15-7b2e0d8a43c6#2')
    expect(withQuestion.stored[0].kind).toBe('other')
  })

  // @covers REQ-159#no-attachment-accepted
  it('添え先の無い送信も受け付けて残す', async () => {
    const { res, stored } = await expectAccepted({ body: '分かりにくかった', kind: 'improve' })
    expect(typeof ((await res.json()) as { id?: unknown }).id).toBe('string')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ body: '分かりにくかった', page: null, topic_id: null, question_id: null })
  })

  // @covers REQ-160#body-wrong-type
  it('本文の型が違う送信・本文ごと JSON でない送信は 400 と日本語の理由', async () => {
    for (const body of [123, null, ['分かりにくかった'], { text: 'x' }, true]) {
      const payload = { body, kind: 'improve' }
      const { res, stored } = await post(payload)
      expect(res.status, `${JSON.stringify(payload)} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, JSON.stringify(payload))
      expect(stored, `${JSON.stringify(payload)} なのにフィードバックが残っている`).toEqual([])
    }
    for (const raw of ['これは JSON ではない', '[]', '"分かりにくかった"']) {
      const { res } = await postRaw(raw)
      expect(res.status, `本体 ${raw} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, `本体 ${raw}`)
    }
  })

  // @covers REQ-160#kind-missing
  it('種類の鍵が無い送信は、既定の種類に倒さず 400 と日本語の理由で断り、フィードバックを残さない', async () => {
    for (const payload of [
      { body: '分かりにくかった' },
      { body: '単位「LTV」の 1÷解約率のところが分かりにくかった', page: '/topics/412', topicId: 412 },
    ]) {
      const { res, stored } = await post(payload)
      expect(res.status, `${JSON.stringify(payload)} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, JSON.stringify(payload))
      expect(stored, `${JSON.stringify(payload)} なのにフィードバックが残っている`).toEqual([])
    }
  })

  // @covers REQ-160#kind-not-allowed
  it('決められていない種類の送信は 400 と日本語の理由（決められた種類は通る）', async () => {
    for (const kind of ['zzz', '', 'GOOD', 1, null]) {
      const { res, stored } = await post({ body: '分かりにくかった', kind })
      expect(res.status, `kind=${JSON.stringify(kind)} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, `kind=${JSON.stringify(kind)}`)
      expect(stored).toEqual([])
    }
    for (const kind of ['text', 'unclear', 'good', 'improve', 'other']) {
      const { stored } = await expectAccepted({ body: '分かりにくかった', kind })
      expect(stored.map((row) => row.kind)).toEqual([kind])
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
      const { res, stored } = await post(payload)
      expect(res.status, `${JSON.stringify(extra)} が 400 で拒まれていない`).toBe(400)
      await expectJapaneseReason(res, JSON.stringify(extra))
      expect(stored).toEqual([])
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
      { label: '本文の型違い', send: () => post({ body: 123, kind: 'improve' }) },
      { label: '本体が JSON でない', send: () => postRaw('これは JSON ではない') },
      { label: '種類が無い', send: () => post({ body: '分かりにくかった' }) },
      { label: '種類が決められていない', send: () => post({ body: '分かりにくかった', kind: 'zzz' }) },
      { label: '論点が文字列', send: () => post({ body: '分かりにくかった', kind: 'improve', topicId: '1' }) },
    ]
    for (const { label, send } of rejected) {
      const { res, stored } = await send()
      expect(res.status, `${label} が 400 で拒まれていない`).toBe(400)
      expect(stored, `${label} なのにフィードバックが残っている`).toEqual([])
    }
  })

  // @covers REQ-160#invalid-before-rate-limit
  it('上限に達している利用者からの形の違う送信は、上限の理由より先に形の理由（400）で断る', async () => {
    for (const payload of [{ body: '   ', kind: 'improve' }, { body: '分かりにくかった', kind: 'zzz' }, { body: '分かりにくかった' }]) {
      const { res, stored } = await post(payload, DAILY_LIMIT)
      expect(res.status, `${JSON.stringify(payload)} が 400 でない（上限の理由が先に出ている）`).toBe(400)
      await expectJapaneseReason(res, JSON.stringify(payload))
      expect(stored).toEqual([])
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
    const { res, stored } = await post({ body: '21 件目のフィードバック', kind: 'good' }, DAILY_LIMIT)
    expect(res.status).toBe(429)
    expect(stored, '上限で断ったのにフィードバックが残っている').toEqual([])
  })

  // @covers REQ-161#under-limit-accepted
  it('上限に達するまでの送信は受け付ける（上限の件数目まで通る）', async () => {
    for (const dailyCount of [0, 1, DAILY_LIMIT - 1]) {
      const body = `${dailyCount + 1} 件目のフィードバック`
      const { res, stored } = await post({ body, kind: 'good' }, dailyCount)
      expect(res.status, `受付済み ${dailyCount} 件で受け付けられない`).toBe(201)
      expect(stored.map((row) => row.body)).toEqual([body])
    }
  })
})
