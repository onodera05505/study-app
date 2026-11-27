import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALSO_GRANTED,
  GRANTED,
  Portal,
  UNKNOWN_LEARNING,
  WRONG_SECRET,
  YUDAI,
  expectError,
} from './repay_UC-013_portal_fixture'

/**
 * UC-013 まなびばから権限のある学びに入る — 使い捨てコードを換えるところ（REQ-200〜203・263）。
 *
 * コードは契約 startSso で本物を発行し、契約 exchangeCode（POST /api/sso/exchange、共有秘密は本文の secret）を
 * 境界から叩く。使用済みかどうかは「もう一度換えられるか」でも、行の used_at でも観測する。
 * 期限を過ぎさせることと権限を外すことだけは SQLite への仕込み。
 */

/** 契約 exchangeCode の応答（本人のメールと名前だけ）。 */
const PERSON = { email: YUDAI.email, name: YUDAI.name }

/** 断りの本文に本人のメールも名前も含まれない。 */
const expectNoPerson = (error: string, label: string) => {
  expect(error, `${label}: 断りにメールが含まれる`).not.toContain(YUDAI.email)
  expect(error, `${label}: 断りに名前が含まれる`).not.toContain(YUDAI.name)
}

describe('UC-013 使い捨てコードの交換（まなびば）', () => {
  let p: Portal
  let cookie: string
  let code: string

  beforeEach(async () => {
    p = await Portal.open()
    cookie = await p.session(YUDAI)
    code = await p.issueCode(cookie, GRANTED)
  })

  describe('REQ-200 合う共有秘密で未使用・期限内・権限のあるコードを換える', () => {
    // @covers REQ-200#exchange-ok
    it('本人のメールと名前だけが 200 で返る', async () => {
      const res = await p.exchangeWithSecret({ code, app: GRANTED })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(PERSON)
    })

    // @covers REQ-200#code-marked-used
    it('換えたあとは行が使用済みになり、同じコードはもう換えられない', async () => {
      expect((await p.exchangeWithSecret({ code, app: GRANTED })).status).toBe(200)
      expect(p.codeRow(code)?.used_at, '行が使用済みになっていない').not.toBeNull()
      await expectError(await p.exchangeWithSecret({ code, app: GRANTED }), 401, '2 度目の交換')
    })
  })

  describe('REQ-201 共有秘密が合わない・無い呼び出しはコードの状態にかかわらず断る', () => {
    // @covers REQ-201#wrong-secret
    it('合わない共有秘密は 403 の {error} で、メールも名前も渡さない', async () => {
      const error = await expectError(await p.exchange({ code, app: GRANTED, secret: WRONG_SECRET }), 403, '合わない共有秘密')
      expectNoPerson(error, '合わない共有秘密')
    })

    // @covers REQ-201#no-secret
    it.each([
      ['secret が無い', {}],
      ['secret が空', { secret: '' }],
      ['secret が文字列でない', { secret: 123 }],
    ])('共有秘密を添えていない（%s）と 403 で、メールも名前も渡さない', async (label, over) => {
      const body: Record<string, unknown> = { code, app: GRANTED, ...over }
      const error = await expectError(await p.exchange(body), 403, label)
      expectNoPerson(error, label)
    })

    // @covers REQ-201#refused-before-code-state
    it('コードが使用済み・期限切れ・別の学び宛て・権限が外れたあとでも、共有秘密の側で先に 403（契約の errors の並び）', async () => {
      const used = code
      expect((await p.exchangeWithSecret({ code: used, app: GRANTED })).status).toBe(200)
      const expired = await p.issueCode(cookie, GRANTED)
      p.expireCode(expired)
      const forOther = await p.issueCode(cookie, GRANTED)
      const revoked = await p.issueCode(cookie, ALSO_GRANTED)
      p.revokeGrant(await p.accountId(YUDAI), ALSO_GRANTED)
      const cases: Array<[string, Record<string, unknown>]> = [
        ['使用済み × 合わない秘密', { code: used, app: GRANTED, secret: WRONG_SECRET }],
        ['期限切れ × 合わない秘密', { code: expired, app: GRANTED, secret: WRONG_SECRET }],
        ['別の学び宛て × 秘密なし', { code: forOther, app: ALSO_GRANTED }],
        ['権限が外れた × 合わない秘密', { code: revoked, app: ALSO_GRANTED, secret: WRONG_SECRET }],
        ['無いコード × 秘密なし', { code: 'no-such-code', app: GRANTED }],
      ]
      for (const [label, body] of cases) await expectError(await p.exchange(body), 403, label)
    })

    // @covers REQ-201#code-not-consumed
    it('断られたコードは使用済みにならず、そのあと合う共有秘密で換えられる', async () => {
      expect((await p.exchange({ code, app: GRANTED, secret: WRONG_SECRET })).status).toBe(403)
      expect((await p.exchange({ code, app: GRANTED })).status).toBe(403)
      expect(p.codeRow(code)?.used_at, '断ったのに使用済みになった').toBeNull()
      const res = await p.exchangeWithSecret({ code, app: GRANTED })
      expect(res.status, '断られたあとの正しい交換が通らない').toBe(200)
      expect(await res.json()).toEqual(PERSON)
    })
  })

  describe('REQ-202 使用済み・期限切れ・別の学び宛てのコードは合う秘密でも換えない', () => {
    // @covers REQ-202#used-code
    it('一度換えたコードをもう一度換えに来ると 401 で、メールも名前も渡さない', async () => {
      expect((await p.exchangeWithSecret({ code, app: GRANTED })).status).toBe(200)
      const error = await expectError(await p.exchangeWithSecret({ code, app: GRANTED }), 401, '使用済み')
      expectNoPerson(error, '使用済み')
    })

    // @covers REQ-202#expired-code
    it('期限を過ぎた直後のコードは 401 で、メールも名前も渡さない', async () => {
      p.expireCode(code)
      const error = await expectError(await p.exchangeWithSecret({ code, app: GRANTED }), 401, '期限切れ')
      expectNoPerson(error, '期限切れ')
    })

    // @covers REQ-202#code-for-other-learning
    it('別の学び（権限はある）に宛てて発行されたコードを換えに来ると 401 で、メールも名前も渡さない', async () => {
      const error = await expectError(await p.exchangeWithSecret({ code, app: ALSO_GRANTED }), 401, '別の学び宛て')
      expectNoPerson(error, '別の学び宛て')
    })
  })

  describe('REQ-203 発行のあとで権限が外れたコードは換えない', () => {
    // @covers REQ-203#grant-revoked-after-issue
    it('発行のあとでその学びの権限を外すと、合う秘密でも 403 で、メールも名前も渡さない', async () => {
      p.revokeGrant(await p.accountId(YUDAI), GRANTED)
      const error = await expectError(await p.exchangeWithSecret({ code, app: GRANTED }), 403, '発行後に権限が外れた')
      expectNoPerson(error, '発行後に権限が外れた')
    })
  })

  describe('REQ-263 コードか宛て先の学びを欠く・登録簿に無い学びを指す呼び出しは換えない', () => {
    // @covers REQ-263#code-missing
    it.each([
      ['code が無い', { app: GRANTED }],
      ['code が空', { code: '', app: GRANTED }],
    ])('%s と 400 の {error}', async (label, body) => {
      await expectError(await p.exchangeWithSecret(body), 400, label)
    })

    // @covers REQ-263#app-missing
    it.each([
      ['app が無い', {}],
      ['app が空', { app: '' }],
    ])('%s と 400 の {error}', async (label, over) => {
      await expectError(await p.exchangeWithSecret({ code, ...over }), 400, label)
    })

    // @covers REQ-263#app-unknown
    it('app が登録簿に無いと 400 の {error}', async () => {
      await expectError(await p.exchangeWithSecret({ code, app: UNKNOWN_LEARNING }), 400, '登録簿に無い学び')
    })

    // @covers REQ-263#code-not-consumed
    it('断ったあともコードは使用済みにならず、メールも名前も返らず、そのあと正しく換えられる', async () => {
      for (const [label, body] of [
        ['app が無い', { code }],
        ['app が空', { code, app: '' }],
        ['登録簿に無い学び', { code, app: UNKNOWN_LEARNING }],
      ] as Array<[string, Record<string, unknown>]>) {
        const error = await expectError(await p.exchangeWithSecret(body), 400, label)
        expectNoPerson(error, label)
      }
      expect(p.codeRow(code)?.used_at, '断ったのに使用済みになった').toBeNull()
      const res = await p.exchangeWithSecret({ code, app: GRANTED })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(PERSON)
    })

    // @covers REQ-263#secret-precedes-invalid-input
    it('共有秘密が合わず、かつ入力も形を満たさない要求は、先に 403（契約の errors の 1・2 件目の並び）', async () => {
      await expectError(await p.exchange({ code, app: UNKNOWN_LEARNING, secret: WRONG_SECRET }), 403, '合わない秘密 × 登録簿に無い学び')
      await expectError(await p.exchange({ app: GRANTED }), 403, '秘密なし × code 無し')
      await expectError(await p.exchange({ code, secret: WRONG_SECRET }), 403, '合わない秘密 × app 無し')
    })

    // @covers REQ-263#precedes-code-check
    it('入力が形を満たさず、かつコードも通らない要求は、先に 400（契約の errors の 2・3 件目の並び）', async () => {
      expect((await p.exchangeWithSecret({ code, app: GRANTED })).status).toBe(200)
      await expectError(await p.exchangeWithSecret({ code, app: UNKNOWN_LEARNING }), 400, '登録簿に無い学び × 使用済み')
      const expired = await p.issueCode(cookie, GRANTED)
      p.expireCode(expired)
      await expectError(await p.exchangeWithSecret({ code: expired, app: UNKNOWN_LEARNING }), 400, '登録簿に無い学び × 期限切れ')
      await expectError(await p.exchangeWithSecret({ code: 'no-such-code', app: '' }), 400, 'app 空 × 無いコード')
    })
  })
})
