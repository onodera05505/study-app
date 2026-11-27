import { beforeEach, describe, expect, it } from 'vitest'
import portal from '../../portal/src/index'
import {
  GRANTED,
  JAPANESE,
  NOT_GRANTED,
  PORTAL_URL,
  Portal,
  SESSION_COOKIE,
  UNKNOWN_LEARNING,
  WRONG_SECRET,
  YUDAI,
  jsonInit,
  locationOf,
} from './repay_UC-013_portal_fixture'

/**
 * UC-033 の REQ-573（まなびば）: 断りの応答が、理由の文とは別に断りの種類の名前を 1 つ持つ。
 *
 * JSON の本文で断る応答は ErrorBody の `code` に名前を持ち、ヘッダ `X-Error-Code` は付けない。
 * JSON の本文を持たない断り（入口 startSso の平文の 400 と、ログイン画面や一覧へ戻す 302）は、
 * ヘッダ `X-Error-Code` に名前を持ち、本文と戻り先の URL には名前を出さない（ADR-0012）。
 * 期待する名前は各操作の契約の `errors` のうち当たった条件の `code`、どの経路にも立つ断りは UC-017 の要件が当てる名前。
 *
 * 入力の選び方: まなびばの http の契約が使う名前（INVALID_INPUT・UNAUTHENTICATED・FORBIDDEN・NOT_FOUND・CONFLICT）を、
 * それぞれ 1 つ以上の契約の失敗例で尽くす。D1 はメモリの SQLite（repay_UC-013_portal_fixture）。
 */

type PortalEnv = Parameters<typeof portal.request>[2]

/** JSON の本文の断り: 状態の番号、ErrorBody の 2 つの鍵、名前、日本語の理由、名前のヘッダが無いこと。 */
const expectNamed = async (res: Response, status: number, code: string, label: string) => {
  expect(res.status, `${label}: 状態の番号`).toBe(status)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body).sort(), `${label}: 本文が {error, code} でない`).toEqual(['code', 'error'])
  expect(body.code, `${label}: 断りの種類の名前`).toBe(code)
  expect(String(body.error), `${label}: 理由の文が日本語でない`).toMatch(JAPANESE)
  expect(res.headers.get('X-Error-Code'), `${label}: JSON の断りに名前のヘッダが付いている`).toBeNull()
}

/** JSON の本文を持たない断り: 名前はヘッダ X-Error-Code にあり、戻り先の URL には出ない。 */
const expectHeaderNamed = (res: Response, code: string, label: string) => {
  expect(res.headers.get('X-Error-Code'), `${label}: X-Error-Code`).toBe(code)
}

const withCookie = (cookie: string): RequestInit => ({ headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } })

/** YUDAI を管理者にしてそのセッションを得る（管理者の作り方はこの UC の外なので表に直に当てる）。 */
const adminSession = async (p: Portal) => {
  p.sqlite.prepare("update accounts set role = 'ADMIN' where email = ?").run(YUDAI.email)
  return p.session(YUDAI)
}

/** どのメソッドでも例外を投げる偽の D1。 */
const brokenStore = (): D1Database => {
  const boom = () => {
    throw new Error('boom')
  }
  return { prepare: boom, batch: boom, exec: boom, dump: boom } as unknown as D1Database
}

describe('UC-033 REQ-573 断りの種類の名前（まなびば）', () => {
  let p: Portal
  beforeEach(async () => {
    p = await Portal.open()
  })

  describe('#portal まなびばの断りは、その条件の名前を持つ', () => {
    // @covers REQ-573#portal
    it('ログイン（signIn）: メールの形でない・パスワードが合わない、の名前がそれぞれ契約の code', async () => {
      // badEmail
      await expectNamed(await p.login({ email: 'yudai-example.com', password: 'harunokaze8' }), 400, 'INVALID_INPUT', 'メールの形でない')
      // wrongPassword
      await expectNamed(await p.login({ email: YUDAI.email, password: 'chigaupass9' }), 401, 'UNAUTHENTICATED', 'パスワードが合わない')
    })

    // @covers REQ-573#portal
    it('本人の問い合わせ（getMe）と一覧（listAccounts）: セッション無し・管理者でない、の名前がそれぞれ契約の code', async () => {
      // getMe の noSession
      await expectNamed(await p.me(), 401, 'UNAUTHENTICATED', 'セッション無しの getMe')
      // listAccounts の notAdmin
      const member = await p.session(YUDAI)
      await expectNamed(await p.request('/api/admin/accounts', withCookie(member)), 403, 'FORBIDDEN', '管理者でない listAccounts')
    })

    // @covers REQ-573#portal
    it('アカウントの作成と更新（createAccount・updateAccount）: メールの重複・在りもしない id、の名前がそれぞれ契約の code', async () => {
      const admin = await adminSession(p)
      // createAccount の duplicateEmail
      await expectNamed(
        await p.request('/api/admin/accounts', jsonInit('POST', { email: YUDAI.email, name: '鈴木 花子', password: 'harunokaze8' }, admin)),
        409,
        'CONFLICT',
        'メールの重複',
      )
      // updateAccount の notFound
      await expectNamed(
        await p.request('/api/admin/accounts/00000000-0000-4000-8000-000000000000', jsonInit('PUT', { name: '鈴木 花' }, admin)),
        404,
        'NOT_FOUND',
        '在りもしない id の更新',
      )
    })

    // @covers REQ-573#portal
    it('コードの交換（exchangeCode）: 共有秘密が合わない・学びが登録簿に無い・使えないコード・発行のあとに権限が外れた、の名前がそれぞれ契約の code', async () => {
      const cookie = await p.session(YUDAI)
      const code = await p.issueCode(cookie, GRANTED)
      // badSecret
      await expectNamed(await p.exchange({ code, app: GRANTED, secret: WRONG_SECRET }), 403, 'FORBIDDEN', '共有秘密が合わない')
      // unknownLearning
      await expectNamed(await p.exchangeWithSecret({ code, app: UNKNOWN_LEARNING }), 400, 'INVALID_INPUT', '学びが登録簿に無い')
      // usedCode（発行していないコード）
      await expectNamed(await p.exchangeWithSecret({ code: '5b7e0c14-2a93-4de6-8f21-0c4ab9e35d77', app: GRANTED }), 401, 'UNAUTHENTICATED', '使えないコード')
      // revokedGrant
      p.revokeGrant(await p.accountId(YUDAI), GRANTED)
      await expectNamed(await p.exchangeWithSecret({ code, app: GRANTED }), 403, 'FORBIDDEN', '発行のあとに権限が外れた')
    })

    // @covers REQ-573#portal
    it('自分のパスワードの変更（changeOwnPassword）: 現在のパスワードが空の名前が契約の code', async () => {
      const cookie = await p.session(YUDAI)
      // emptyCurrent
      await expectNamed(await p.request('/api/me/password', jsonInit('POST', { current: '', next: 'natsunoame9' }, cookie)), 400, 'INVALID_INPUT', '現在のパスワードが空')
    })
  })

  describe('#non-json-refusal JSON の本文を持たない断りは、ヘッダから名前が読める', () => {
    // @covers REQ-573#non-json-refusal
    it('入口（startSso）で登録簿に無い学びを指すと、本文は平文の 1 文のままで、名前は X-Error-Code の INVALID_INPUT', async () => {
      const res = await p.startSso(`app=${UNKNOWN_LEARNING}`, await p.session(YUDAI))
      expect(res.status).toBe(400)
      expectHeaderNamed(res, 'INVALID_INPUT', '登録簿に無い学び')
      const text = await res.text()
      expect(() => JSON.parse(text), '本文が JSON になっている').toThrow()
      expect(text.trim().split('\n'), '本文が 1 文でない').toHaveLength(1)
      expect(text).toMatch(JAPANESE)
      expect(text, '本文に名前が出ている').not.toContain('INVALID_INPUT')
    })

    // @covers REQ-573#non-json-refusal
    it('入口（startSso）でセッションが無いとまなびばの中へ 302 で戻り、名前は X-Error-Code の UNAUTHENTICATED（戻り先に名前を出さない）', async () => {
      const res = await p.startSso(`app=${GRANTED}`)
      const location = locationOf(res, 'セッション無し')
      expect(location.origin).toBe(new URL(PORTAL_URL).origin)
      expectHeaderNamed(res, 'UNAUTHENTICATED', 'セッション無し')
      expect(decodeURIComponent(location.href), '戻り先に名前が出ている').not.toContain('UNAUTHENTICATED')
    })

    // @covers REQ-573#non-json-refusal
    it('入口（startSso）で権限の無い学びを開くとまなびばの一覧へ 302 で戻り、名前は X-Error-Code の FORBIDDEN（戻り先に名前を出さない）', async () => {
      const cookie = await p.session(YUDAI)
      const res = await p.startSso(`app=${NOT_GRANTED}`, cookie)
      const location = locationOf(res, '権限の無い学び')
      expect(location.origin).toBe(new URL(PORTAL_URL).origin)
      expectHeaderNamed(res, 'FORBIDDEN', '権限の無い学び')
      expect(decodeURIComponent(location.href), '戻り先に名前が出ている').not.toContain('FORBIDDEN')
      // 戻り先はログインへの戻り先と区別できるまま
      const noSession = locationOf(await p.startSso(`app=${NOT_GRANTED}`), 'セッション無し')
      expect(location.href).not.toBe(noSession.href)
    })
  })

  describe('#common-refusal どの経路にも立つ断り（まなびば）は、UC-017 の要件の当てた名前を持つ', () => {
    // @covers REQ-573#common-refusal
    it('本人と分からない要求は UNAUTHENTICATED、受け持たない /api の経路は NOT_FOUND、JSON として読めない本文は INVALID_INPUT', async () => {
      await expectNamed(await p.logout(), 401, 'UNAUTHENTICATED', 'セッション無しの signOut')
      await expectNamed(await p.request('/api/no-such-path'), 404, 'NOT_FOUND', '受け持たない経路（匿名）')
      await expectNamed(await p.request('/api/no-such-path', withCookie(await p.session(YUDAI))), 404, 'NOT_FOUND', '受け持たない経路（本人）')
      await expectNamed(await p.login('not json'), 400, 'INVALID_INPUT', 'JSON として読めない本文')
    })

    // @covers REQ-573#common-refusal
    it('処理の途中の想定していない失敗は INTERNAL', async () => {
      const env = { ...(p.env as object), DB: brokenStore() } as unknown as PortalEnv
      const res = await portal.request('/api/login', jsonInit('POST', { email: YUDAI.email, password: YUDAI.password }), env)
      await expectNamed(res, 500, 'INTERNAL', '保存先が壊れている signIn')
    })
  })
})
