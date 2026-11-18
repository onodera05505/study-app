import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import { SECRET, USER, as, openWorld, seedQuestions, startOk, topicOf, type World } from './sessions_sqlite_fixture'
import { post as postFeedback } from './feedback_sqlite_fixture'

/**
 * UC-033 の REQ-573（学び側）: 断りの応答が、理由の文とは別に断りの種類の名前を 1 つ持つ。
 *
 * JSON の本文で断る応答は、共有の形 ErrorBody（理由の文 `error` と名前 `code`）の `code` に名前を持ち、
 * 名前を持つヘッダ `X-Error-Code` は付けない（名前は 1 か所に 1 つ。ADR-0012）。
 * 期待する名前は、1 つの操作に属する断りではその操作の契約の `errors` のうち当たった条件の `code`、
 * どの経路にも立つ断り（ADR-0011）では UC-017 の要件と `errorCodes` が当てる名前。理由の文の語は照合しない。
 *
 * 入力の選び方: 学び側の http の契約が使う名前（UNAUTHENTICATED・INVALID_INPUT・NOT_FOUND・CONFLICT・
 * RATE_LIMITED・NOT_CONFIGURED・UPSTREAM_UNAVAILABLE・FORBIDDEN・INTERNAL）を、それぞれ 1 つ以上の契約の失敗例で尽くす。
 * 保存先は migrations を当てたメモリの SQLite（sessions_sqlite_fixture・feedback_sqlite_fixture）。
 */

const JAPANESE = /[ぁ-んァ-ヶ一-龥]/
const PORTAL = { SSO_PORTAL_URL: 'https://portal.example', SSO_SECRET: 'shared' }
/** 契約 UC-013 signInWithCode の examples の使い捨てコード。 */
const CODE = '3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40'
/** 契約 UC-010 submitFeedback の overDailyLimit の例（21 件目が断られる）が示す 1 日の上限。 */
const DAILY_LIMIT = 20

/** JSON の本文の断り: 状態の番号、ErrorBody の 2 つの鍵、名前、日本語の理由、名前のヘッダが無いこと。 */
const expectNamed = async (res: Response, status: number, code: string, label: string) => {
  expect(res.status, `${label}: 状態の番号`).toBe(status)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body).sort(), `${label}: 本文が {error, code} でない`).toEqual(['code', 'error'])
  expect(body.code, `${label}: 断りの種類の名前`).toBe(code)
  expect(String(body.error), `${label}: 理由の文が日本語でない`).toMatch(JAPANESE)
  expect(res.headers.get('X-Error-Code'), `${label}: JSON の断りに名前のヘッダが付いている`).toBeNull()
  return body
}

const learningEnv = (w: World, over: Partial<Bindings> = {}) =>
  ({ EXAM: w.learning, JWT_SECRET: SECRET, DB: w.d1, ...over }) as unknown as Bindings
const noStore = (over: Partial<Bindings> = {}) => ({ EXAM: 'ip', JWT_SECRET: SECRET, ...over }) as Bindings
const memberToken = () => issueToken(SECRET, { id: USER, name: '検査', role: 'MEMBER' })

const request = (method: string, body?: unknown, token?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
})

/** まなびばへの呼び出しを、このテストの中だけ決めた応答（または届かないこと）に差し替える。 */
const withPortalReply = async (reply: (() => Response) | 'unreachable', body: () => Promise<void>) => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    if (reply === 'unreachable') throw new TypeError('fetch failed')
    return reply()
  }) as typeof fetch
  try {
    await body()
  } finally {
    globalThis.fetch = orig
  }
}

const portalJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 契約 signInWithCode の発行の要求。 */
const signInWithCode = (env: Bindings, code: unknown = CODE) => app.request('/api/auth/sso', request('POST', { code }), env)

describe('UC-033 REQ-573 断りの種類の名前（学び側）', () => {
  describe('#operation-refusal 契約の errors に当たる断りは、その条件の名前を持つ', () => {
    // @covers REQ-573#operation-refusal
    it('テストの開始（startSession）: トークン無し・種別が enum の外・範囲が空・進行中がある、の名前がそれぞれ契約の code', async () => {
      const w = await openWorld()
      const token = await memberToken()
      // unauthenticatedBeforeInvalidKind
      await expectNamed(await app.request('/api/sessions', request('POST', { kind: 'daily' }), learningEnv(w)), 401, 'UNAUTHENTICATED', 'トークン無し')
      // invalidKind
      await expectNamed(await app.request('/api/sessions', request('POST', { kind: 'daily' }, token), learningEnv(w)), 400, 'INVALID_INPUT', '種別が enum の外')
      // emptyScope
      await expectNamed(await (await as(w)).start({ kind: 'drill', topicId: 9999 }), 404, 'NOT_FOUND', '出題できる範囲が空')
      // inProgress
      seedQuestions(w, '2024r06', 3, 'テクノロジ系')
      await startOk(w, { kind: 'drill', topicId: topicOf(w, 'テクノロジ系') })
      await expectNamed(await (await as(w)).start({ kind: 'review' }), 409, 'CONFLICT', '進行中のテストがある')
    })

    // @covers REQ-573#operation-refusal
    it('テストの開始（startSession）: 作る途中で出題の保存に失敗した断りの名前が契約の code（saveFailed）', async () => {
      // 契約の saveFailed の要求（中分類 12 の演習）が、保存が落ちなければ作れる学び
      const worldWithMiddle12 = async () => {
        const w = await openWorld()
        seedQuestions(w, '2024r06', 3, 'テクノロジ系')
        w.db.prepare('UPDATE syllabus_items SET middle_no = 12').run()
        return w
      }
      const body = { kind: 'middle', middleNo: 12 }
      await startOk(await worldWithMiddle12(), body)
      // session_questions への行の追加を最初の行で落とす
      const w = await worldWithMiddle12()
      w.db.exec(
        `CREATE TRIGGER fail_sq BEFORE INSERT ON session_questions WHEN NEW.idx = 0 BEGIN SELECT RAISE(ABORT, '出題の保存に失敗した'); END;`,
      )
      await expectNamed(await (await as(w)).start(body), 500, 'INTERNAL', '出題の保存に失敗した')
    })

    // @covers REQ-573#operation-refusal
    it('論点の詳細（getTopicDetail）: id が整数でない・在りもしない id、の名前がそれぞれ契約の code', async () => {
      const w = await openWorld()
      const token = await memberToken()
      // invalidIdBeforeNotFound
      await expectNamed(await app.request('/api/topics/abc', request('GET', undefined, token), learningEnv(w)), 400, 'INVALID_INPUT', 'id が abc')
      // notFound
      await expectNamed(await app.request('/api/topics/999999', request('GET', undefined, token), learningEnv(w)), 404, 'NOT_FOUND', 'id が 999999')
    })

    // @covers REQ-573#operation-refusal
    it('フィードバックの送信（submitFeedback）: 直近 1 日の受付が上限に達している断りの名前が契約の code', async () => {
      // overDailyLimit
      const { res } = await postFeedback({ body: '分かりにくかった', kind: 'improve' }, DAILY_LIMIT)
      await expectNamed(res, 429, 'RATE_LIMITED', '上限に達した 21 件目')
    })

    // @covers REQ-573#operation-refusal
    it('使い捨てコードの交換（signInWithCode）: 設定が無い・code が空・まなびばに届かない・権限無し・換えない、の名前がそれぞれ契約の code', async () => {
      // noSigningSecret
      await withPortalReply('unreachable', async () => {
        await expectNamed(await signInWithCode({ EXAM: 'ip', ...PORTAL } as Bindings), 503, 'NOT_CONFIGURED', '署名の秘密が無い配備')
        // まなびばの場所はあるが共有秘密が無い
        await expectNamed(
          await signInWithCode(noStore({ SSO_PORTAL_URL: PORTAL.SSO_PORTAL_URL })),
          503,
          'NOT_CONFIGURED',
          '共有秘密が無い配備',
        )
        // emptyCode
        await expectNamed(await signInWithCode(noStore(PORTAL), ''), 400, 'INVALID_INPUT', 'code が空')
        // portalUnreachable
        await expectNamed(await signInWithCode(noStore(PORTAL)), 502, 'UPSTREAM_UNAVAILABLE', 'まなびばに届かない')
      })
      // noGrant（まなびばが権限無しとして断った）
      await withPortalReply(
        () => portalJson(403, { error: 'この学びを開く権限がありません', code: 'FORBIDDEN' }),
        async () => {
          await expectNamed(await signInWithCode(noStore(PORTAL)), 403, 'FORBIDDEN', 'まなびばが権限無しとして断った')
        },
      )
      // usedCode（まなびばが換えず、断りが権限無し以外）
      await withPortalReply(
        () => portalJson(401, { error: 'コードが無効です', code: 'UNAUTHENTICATED' }),
        async () => {
          await expectNamed(await signInWithCode(noStore(PORTAL)), 401, 'UNAUTHENTICATED', 'まなびばがコードを換えない')
        },
      )
    })
  })

  describe('#same-status-different-name 状態の番号が同じで種類が違う断りは、名前が違う', () => {
    // @covers REQ-573#same-status-different-name
    it('404 の断りのうち、見つからない断りは NOT_FOUND、まなびばの場所が無い配備の交換の断りは NOT_CONFIGURED', async () => {
      const w = await openWorld()
      const token = await memberToken()
      const notFound = await expectNamed(
        await app.request('/api/topics/999999', request('GET', undefined, token), learningEnv(w)),
        404,
        'NOT_FOUND',
        '在りもしない論点（getTopicDetail の notFound）',
      )
      const unknownPath = await expectNamed(
        await app.request('/api/no-such-path', request('GET', undefined, token), learningEnv(w)),
        404,
        'NOT_FOUND',
        '受け持たない /api の経路',
      )
      // notConfigured（この配備にまなびばの場所が無い。契約の wire は 404）
      let noPortal: Record<string, unknown> = {}
      await withPortalReply('unreachable', async () => {
        noPortal = await expectNamed(await signInWithCode(noStore()), 404, 'NOT_CONFIGURED', 'まなびばの場所が無い配備')
      })
      expect(noPortal.code, '同じ 404 で種類の名前が同じ').not.toBe(notFound.code)
      expect(noPortal.code, '同じ 404 で種類の名前が同じ').not.toBe(unknownPath.code)
    })
  })

  describe('#common-refusal どの経路にも立つ断りは、UC-017 の要件の当てた名前を持つ', () => {
    // @covers REQ-573#common-refusal
    it('本人と分からない要求（REQ-255）は、取得でも変更でも UNAUTHENTICATED', async () => {
      const wrongSecret = await issueToken('other-secret', { id: USER, name: '検査', role: 'MEMBER' })
      for (const [method, path, body] of [
        ['GET', '/api/fields', undefined],
        ['POST', '/api/sessions', { kind: 'review' }],
      ] as const) {
        await expectNamed(await app.request(path, request(method, body), noStore()), 401, 'UNAUTHENTICATED', `${method} ${path}（トークン無し）`)
        await expectNamed(await app.request(path, request(method, body, wrongSecret), noStore()), 401, 'UNAUTHENTICATED', `${method} ${path}（別の秘密）`)
      }
    })

    // @covers REQ-573#common-refusal
    it('受け持たない /api の経路（REQ-256）は、匿名でも本人としても NOT_FOUND', async () => {
      const token = await memberToken()
      for (const [who, t] of [['匿名', undefined], ['本人として', token]] as const) {
        await expectNamed(await app.request('/api/no-such-path', request('GET', undefined, t), noStore()), 404, 'NOT_FOUND', `/api/no-such-path（${who}）`)
      }
    })

    // @covers REQ-573#common-refusal
    it('決められた形を満たさない本文（REQ-257）は、JSON として読めない本文も項目の崩れも INVALID_INPUT', async () => {
      const w = await openWorld()
      const token = await memberToken()
      for (const body of ['not json', {}, { kind: 12 }]) {
        const label = `POST /api/sessions ${typeof body === 'string' ? body : JSON.stringify(body)}`
        await expectNamed(await app.request('/api/sessions', request('POST', body, token), learningEnv(w)), 400, 'INVALID_INPUT', label)
      }
    })

    // @covers REQ-573#common-refusal
    it('処理の途中の想定していない失敗（REQ-258）は INTERNAL', async () => {
      // 本人としては通るが、保存先を束ねていない配備なので処理の途中で失敗する
      await expectNamed(await app.request('/api/fields', request('GET', undefined, await memberToken()), noStore()), 500, 'INTERNAL', 'GET /api/fields（保存先が無い）')
    })

    // @covers REQ-573#common-refusal
    it('配備に設定が無い（REQ-275 の署名の秘密が無い・REQ-354 の学びの key が解決できない）断りは NOT_CONFIGURED', async () => {
      const token = await memberToken()
      await expectNamed(
        await app.request('/api/fields', request('GET', undefined, token), { EXAM: 'ip' } as Bindings),
        503,
        'NOT_CONFIGURED',
        '署名の秘密が無い配備の GET /api/fields',
      )
      for (const [label, env] of [
        ['key が与えられていない', { JWT_SECRET: SECRET } as Bindings],
        ['key が登録簿に無い', noStore({ EXAM: 'no-such-target' })],
      ] as const) {
        await expectNamed(await app.request('/api/health', {}, env), 503, 'NOT_CONFIGURED', `${label}配備の死活確認`)
        await expectNamed(await app.request('/api/fields', request('GET', undefined, token), env), 503, 'NOT_CONFIGURED', `${label}配備の GET /api/fields`)
      }
    })
  })
})
