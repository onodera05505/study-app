import { describe, expect, it } from 'vitest'
import { JAPANESE, post } from './feedback_sqlite_fixture'

/** フィードバックの受け口（契約 submitFeedback）の入力検証を、migrations を当てた本物の SQLite に向けて見る。
 *  本文のクラスは、種類（kind）を契約の許す値で添えた送信で見る。種類が欠けると本文の理由に関わらず
 *  断られるので、本文の断りを観測できない。 */
describe('フィードバックの受け口の入力検証（UC-010・UC-017）', () => {
  // @covers REQ-255#mutating-route-refused
  it('ログインしていない送信は 401', async () => {
    const { res, stored } = await post({ body: '分かりにくかった', kind: 'improve' }, 0, false)
    expect(res.status).toBe(401)
    expect(await res.json()).toHaveProperty('error')
    expect(stored).toEqual([])
  })

  // @covers REQ-160#body-empty
  it('本文が無い・空・空白だけの送信は 400 と日本語の理由', async () => {
    for (const payload of [{ kind: 'improve' }, { body: '', kind: 'improve' }, { body: '   ', kind: 'improve' }]) {
      const { res, stored } = await post(payload)
      expect(res.status, `${JSON.stringify(payload)} が 400 で拒まれていない`).toBe(400)
      const data = (await res.json()) as { error?: string }
      expect(typeof data.error).toBe('string')
      expect(JAPANESE.test(data.error ?? ''), `理由が日本語でない: ${data.error}`).toBe(true)
      expect(stored, `${JSON.stringify(payload)} なのにフィードバックが残っている`).toEqual([])
    }
    // 同じ種類で本文がある送信は通る（断りが本文の空によることの対照）
    const { res } = await post({ body: '分かりにくかった', kind: 'improve' })
    expect(res.status).toBe(201)
  })

  // @covers REQ-160#body-too-long
  it('本文が 2,000 字を超える送信は 400（2,000 字は入力検証を通る）', async () => {
    const over = await post({ body: 'あ'.repeat(2001), kind: 'improve' })
    expect(over.res.status).toBe(400)
    expect(JAPANESE.test(((await over.res.json()) as { error?: string }).error ?? '')).toBe(true)
    expect(over.stored).toEqual([])

    // 上限ちょうどは受け付けて残す（止めていたら「2,000 字以内」が送れない）
    const ok = await post({ body: 'あ'.repeat(2000), kind: 'improve' })
    expect(ok.res.status, '2,000 字が入力検証で拒まれている').toBe(201)
    expect(ok.stored.map((row) => row.body)).toEqual(['あ'.repeat(2000)])
  })
})
