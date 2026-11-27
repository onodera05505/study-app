import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALSO_GRANTED,
  GRANTED,
  HANAKO,
  JAPANESE,
  NOT_GRANTED,
  PORTAL_URL,
  Portal,
  SESSION_COOKIE,
  UNKNOWN_LEARNING,
  YUDAI,
  expectError,
  learningUrl,
  locationOf,
} from './repay_UC-013_portal_fixture'

/**
 * UC-013 まなびばから権限のある学びに入る — まなびばのセッションと学びを開くところ（REQ-181〜189）。
 *
 * 契約 signIn / getMe / signOut / listLearnings / startSso を境界から叩く。
 * 一覧の「見える・開ける・促す」は、画面の正本が静的な HTML で単体の組には無いので、
 * 画面がそれを組み立てる材料（listLearnings の応答・getMe の可否と grants・startSso の戻し先）で観測する。
 */

const PASSWORD_MAX = 200

/** 契約 AccountWithGrants の形（grants は learning の昇順）。 */
type AccountWithGrants = { account: { id: string; email: string; name: string; role: string }; grants: string[] }

describe('UC-013 まなびばのセッションと学びを開く', () => {
  let p: Portal

  beforeEach(async () => {
    p = await Portal.open()
  })

  describe('REQ-181 正しいメールとパスワードでセッションが開く', () => {
    // @covers REQ-181#valid-credentials
    it('登録済みの組を送ると 200 でアカウントと権限が返り、セッションの Cookie が付く', async () => {
      const res = await p.login({ email: YUDAI.email, password: YUDAI.password })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AccountWithGrants
      expect(body.account).toMatchObject({ email: YUDAI.email, name: YUDAI.name, role: 'MEMBER' })
      expect(body.grants).toEqual([...YUDAI.grants].sort())
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`)), 'セッションの Cookie が付いていない').toBe(true)
      expect(p.sessionCount(body.account.id), 'この端末のセッションが 1 つ開いていない').toBe(1)
    })

    // @covers REQ-181#session-identifies-person
    it('開いたセッションからの要求は、その本人のものとして通り、別のアカウントのセッションは別の本人になる', async () => {
      const yudai = await p.session(YUDAI)
      const hanako = await p.session(HANAKO)
      const meYudai = (await (await p.me(yudai)).json()) as AccountWithGrants
      const meHanako = (await (await p.me(hanako)).json()) as AccountWithGrants
      expect(meYudai.account.email).toBe(YUDAI.email)
      expect(meHanako.account.email).toBe(HANAKO.email)
      expect(meYudai.account.id).not.toBe(meHanako.account.id)
      await expectError(await p.me(`${yudai}-tampered`), 401, '値を変えた Cookie')
    })

    // @covers REQ-181#email-normalized
    it.each([
      ['前後に空白', `  ${YUDAI.email}  `],
      ['大文字', YUDAI.email.toUpperCase()],
      ['大文字と空白の混在', ` ${YUDAI.email.replace('yudai', 'Yudai').replace('example', 'Example')} `],
    ])('メールの前後の空白と大文字小文字だけが違う組（%s）でも通り、本人は同じ', async (_label, email) => {
      const res = await p.login({ email, password: YUDAI.password })
      expect(res.status, `${_label}: ログインできない`).toBe(200)
      const body = (await res.json()) as AccountWithGrants
      expect(body.account.email).toBe(YUDAI.email)
    })
  })

  describe('REQ-182 合わない組はセッションを開かずに断る', () => {
    // @covers REQ-182#unknown-email
    it('登録簿に無いメールは 401 の {error} で、セッションは 1 つも開かない', async () => {
      await expectError(await p.login({ email: 'dare@example.com', password: YUDAI.password }), 401, '登録簿に無いメール')
      expect(p.sessionCount()).toBe(0)
    })

    // @covers REQ-182#wrong-password
    it.each([
      ['契約の例 chigaupass9', 'chigaupass9'],
      ['上限ちょうど（200 文字）で合わない', 'x'.repeat(PASSWORD_MAX)],
      ['上限の 1 つ先（201 文字）', 'x'.repeat(PASSWORD_MAX + 1)],
      ['正しいパスワードの前後に空白', ` ${YUDAI.password} `],
    ])('登録済みのメールに合わないパスワード（%s）は 401 で、セッションを開かない', async (label, password) => {
      await expectError(await p.login({ email: YUDAI.email, password }), 401, label)
      expect(p.sessionCount(), `${label}: セッションが開いた`).toBe(0)
    })

    // @covers REQ-182#refusal-is-uniform
    it('メールが無い場合とパスワードが違う場合で、状態・本文・Content-Type が同じ（BR-002）', async () => {
      const unknown = await p.login({ email: 'dare@example.com', password: YUDAI.password })
      const wrong = await p.login({ email: YUDAI.email, password: 'chigaupass9' })
      expect(unknown.status).toBe(401)
      expect(wrong.status).toBe(unknown.status)
      expect(wrong.headers.get('content-type')).toBe(unknown.headers.get('content-type'))
      expect(await wrong.text()).toBe(await unknown.text())
    })

    // @covers REQ-182#malformed-credentials
    it.each([
      ['メールに @ が無い（契約の例）', { email: 'yudai-example.com', password: YUDAI.password }],
      ['メールが空', { email: '', password: YUDAI.password }],
      ['パスワードが空', { email: YUDAI.email, password: '' }],
      ['パスワードが無い', { email: YUDAI.email }],
      ['メールが無い', { password: YUDAI.password }],
      ['メールが文字列でない', { email: 12345, password: YUDAI.password }],
      ['本文が JSON でない', 'これは JSON ではない'],
    ])('形を満たさない本文（%s）は 400 の {error} で、セッションを開かない', async (label, body) => {
      await expectError(await p.login(body), 400, label)
      expect(p.sessionCount(), `${label}: セッションが開いた`).toBe(0)
    })
  })

  describe('REQ-183 セッションが無い端末には一覧を見せるが開けない', () => {
    // @covers REQ-183#list-visible-without-session
    it('セッションが無くても学びの一覧は 200 で返り、各項目は key・brand・kind・desc だけ（学びの場所も秘密も含まない）', async () => {
      const res = await p.learnings()
      expect(res.status).toBe(200)
      const body = (await res.json()) as { learnings: Array<Record<string, unknown>> }
      expect(body.learnings.length).toBeGreaterThan(0)
      expect(body.learnings.map((l) => l.key)).toContain(GRANTED)
      for (const item of body.learnings) {
        expect(Object.keys(item).sort(), `項目 ${String(item.key)} の鍵`).toEqual(['brand', 'desc', 'key', 'kind'])
        for (const value of Object.values(item)) expect(typeof value).toBe('string')
      }
    })

    // @covers REQ-183#not-openable
    it('セッションが無い端末が学びを開こうとしても学びの入口へは送られず、使い捨てコードも発行されない', async () => {
      const location = locationOf(await p.startSso(`app=${GRANTED}`), 'セッション無しで学びを開く')
      expect(location.origin, '学びの入口へ送られた').not.toBe(new URL(learningUrl(GRANTED)).origin)
      expect(location.pathname).not.toBe('/sso/callback')
      expect(p.codeRows()).toEqual([])
    })

    // @covers REQ-183#login-prompted
    it('セッションが無い端末の本人の問い合わせは 401 の {error}（画面はこれでログインを促す）', async () => {
      await expectError(await p.me(), 401, 'セッション無しの getMe')
    })
  })

  describe('REQ-184 セッションがある端末には名前を添え、権限のある学びだけを開ける形にする', () => {
    // @covers REQ-184#name-shown
    it('本人の問い合わせに本人の名前が返る', async () => {
      const cookie = await p.session(YUDAI)
      const res = await p.me(cookie)
      expect(res.status).toBe(200)
      const body = (await res.json()) as AccountWithGrants
      expect(body.account.name).toBe(YUDAI.name)
    })

    // @covers REQ-184#granted-openable
    it('権限のある学びは grants に並び、開くとその学びの入口へ送られる', async () => {
      const cookie = await p.session(YUDAI)
      const body = (await (await p.me(cookie)).json()) as AccountWithGrants
      expect(body.grants).toEqual([...YUDAI.grants].sort())
      for (const app of [GRANTED, ALSO_GRANTED]) {
        const location = locationOf(await p.startSso(`app=${app}`, cookie), `${app} を開く`)
        expect(location.origin, `${app} の入口へ送られない`).toBe(new URL(learningUrl(app)).origin)
      }
    })

    // @covers REQ-184#not-granted-marked
    it('一覧にはあるが grants に無い学びがあり（開けないと分かる材料）、開こうとしても学びの入口へは送られない', async () => {
      const cookie = await p.session(YUDAI)
      const list = (await (await p.learnings()).json()) as { learnings: Array<{ key: string }> }
      const me = (await (await p.me(cookie)).json()) as AccountWithGrants
      expect(list.learnings.map((l) => l.key), '権限の無い学びが一覧に無い').toContain(NOT_GRANTED)
      expect(me.grants).not.toContain(NOT_GRANTED)
      const location = locationOf(await p.startSso(`app=${NOT_GRANTED}`, cookie), '権限の無い学びを開く')
      expect(location.origin).not.toBe(new URL(learningUrl(NOT_GRANTED)).origin)
    })
  })

  describe('REQ-185 セッションが無い端末はまなびばのログイン画面へ送られる', () => {
    // @covers REQ-185#redirect-to-login
    it('セッションが無い端末が学びを開こうとすると、まなびばの中へ 302 で送られる', async () => {
      const location = locationOf(await p.startSso(`app=${GRANTED}`), 'セッション無し')
      expect(location.origin).toBe(new URL(PORTAL_URL).origin)
      expect(location.pathname).not.toBe('/sso/start')
    })

    // @covers REQ-185#grant-not-consulted
    it('権限のある学びでも無い学びでも、期限の過ぎたセッションでも、送り先は同じでコードは発行されない', async () => {
      const expired = p.expiredSession(await p.accountId(YUDAI))
      const [granted, notGranted, withExpired] = await Promise.all([
        p.startSso(`app=${GRANTED}`),
        p.startSso(`app=${NOT_GRANTED}`),
        p.startSso(`app=${GRANTED}`, expired),
      ])
      const paths = [granted, notGranted, withExpired].map((res, i) => locationOf(res, ['権限あり', '権限なし', '期限切れ'][i]).pathname)
      expect(new Set(paths).size, `送り先が権限や期限で変わる: ${paths.join(' / ')}`).toBe(1)
      expect(p.codeRows()).toEqual([])
    })

    // @covers REQ-185#destination-is-internal
    it('要求に外の場所を混ぜても、送り先とそこに埋め込まれた行き先はまなびばの中に限られる', async () => {
      const evil = 'evil.example'
      const query = `app=${GRANTED}&next=https://${evil}/&redirect=//${evil}&return_to=https%3A%2F%2F${evil}%2F&url=https://${evil}`
      const location = locationOf(await p.startSso(query), '外の場所を混ぜた要求')
      expect(location.origin).toBe(new URL(PORTAL_URL).origin)
      expect(decodeURIComponent(location.href)).not.toContain(evil)
      for (const [key, value] of location.searchParams) {
        if (/^(https?:)?\/\//.test(value)) {
          expect(new URL(value, PORTAL_URL).origin, `クエリ ${key} が外の場所を指す`).toBe(new URL(PORTAL_URL).origin)
        }
      }
    })
  })

  describe('REQ-186 権限のある学びを開くと使い捨てコードを添えて入口へ戻す', () => {
    // @covers REQ-186#code-issued
    it('権限のある学びを開くと、その本人・その学び宛ての未使用で期限内のコードが 1 つだけ発行される', async () => {
      const cookie = await p.session(YUDAI)
      const code = await p.issueCode(cookie, GRANTED)
      const rows = p.codeRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].code).toBe(code)
      expect(rows[0].account_id).toBe(await p.accountId(YUDAI))
      expect(rows[0].learning).toBe(GRANTED)
      expect(rows[0].used_at).toBeNull()
      const nowInSameUnit = rows[0].expires_at > 1e11 ? Date.now() : Math.floor(Date.now() / 1000)
      expect(rows[0].expires_at, '発行した時点で期限が過ぎている').toBeGreaterThan(nowInSameUnit)
    })

    // @covers REQ-186#redirect-to-learning
    it('戻し先は登録簿にあるその学びの入口の /sso/callback で、発行したコードが code に付く', async () => {
      const cookie = await p.session(YUDAI)
      for (const app of [GRANTED, ALSO_GRANTED]) {
        const location = locationOf(await p.startSso(`app=${app}`, cookie), `${app} を開く`)
        expect(location.href.startsWith(`${learningUrl(app)}/sso/callback?`), `${app}: 戻し先 ${location.href}`).toBe(true)
        const code = location.searchParams.get('code')
        expect(code).toBeTruthy()
        expect(p.codeRow(code!)?.learning).toBe(app)
      }
    })
  })

  describe('REQ-187 権限の無い学びはコードを出さずに一覧へ戻す', () => {
    // @covers REQ-187#no-code-issued
    it('権限の無い学びを開こうとしても使い捨てコードは発行されない', async () => {
      const cookie = await p.session(YUDAI)
      const res = await p.startSso(`app=${NOT_GRANTED}`, cookie)
      expect(res.status).toBe(302)
      expect(p.codeRows()).toEqual([])
    })

    // @covers REQ-187#back-to-list-with-reason
    it('まなびばの中へ戻され、送り先はログインへの送り先と違い、その学びの権限が無いことが伝わる形を持つ', async () => {
      const cookie = await p.session(YUDAI)
      const noGrant = locationOf(await p.startSso(`app=${NOT_GRANTED}`, cookie), '権限の無い学び')
      const noSession = locationOf(await p.startSso(`app=${NOT_GRANTED}`), 'セッション無し')
      expect(noGrant.origin).toBe(new URL(PORTAL_URL).origin)
      expect(noGrant.href, 'ログインへの送り先と区別が付かない').not.toBe(noSession.href)
      expect(decodeURIComponent(noGrant.href)).toMatch(new RegExp(`${NOT_GRANTED}|権限|denied|forbidden|error|reason`, 'i'))
    })
  })

  describe('REQ-188 登録簿に無い学びはセッションの状態にかかわらず受け付けない', () => {
    // @covers REQ-188#unknown-learning-rejected
    it.each([
      ['登録簿に無い key', `app=${UNKNOWN_LEARNING}`],
      ['app が空', 'app='],
      ['app が無い', ''],
    ])('%s を指すと 400 で、本文は JSON でなく平文の 1 文', async (label, query) => {
      const res = await p.startSso(query, await p.session(YUDAI))
      expect(res.status, label).toBe(400)
      const text = await res.text()
      expect(() => JSON.parse(text), `${label}: 本文が JSON`).toThrow()
      expect(text.trim(), `${label}: 本文が空`).not.toBe('')
      expect(text.trim().split('\n'), `${label}: 1 文でない`).toHaveLength(1)
      expect(text, label).toMatch(JAPANESE)
    })

    // @covers REQ-188#session-state-irrelevant
    it('セッションが無い・ある・期限が過ぎているのどれでも、同じ 400 と同じ本文', async () => {
      const accountId = await p.accountId(YUDAI)
      const responses = await Promise.all([
        p.startSso(`app=${UNKNOWN_LEARNING}`),
        p.startSso(`app=${UNKNOWN_LEARNING}`, await p.session(YUDAI)),
        p.startSso(`app=${UNKNOWN_LEARNING}`, p.expiredSession(accountId)),
      ])
      const statuses = responses.map((r) => r.status)
      expect(statuses).toEqual([400, 400, 400])
      const bodies = await Promise.all(responses.map((r) => r.text()))
      expect(new Set(bodies).size, `本文がセッションの状態で変わる: ${bodies.join(' / ')}`).toBe(1)
    })

    // @covers REQ-188#no-code-issued
    it('登録簿に無い学びを指した要求では、どのセッションの状態でもコードは発行されない', async () => {
      const accountId = await p.accountId(YUDAI)
      await p.startSso(`app=${UNKNOWN_LEARNING}`)
      await p.startSso(`app=${UNKNOWN_LEARNING}`, await p.session(YUDAI))
      await p.startSso(`app=${UNKNOWN_LEARNING}`, p.expiredSession(accountId))
      expect(p.codeRows()).toEqual([])
    })
  })

  describe('REQ-189 ログアウトはその端末のセッションだけを終わらせる', () => {
    // @covers REQ-189#this-device-session-ends
    it('ログアウトすると 200 {ok: true} で Cookie が消され、その Cookie での本人の問い合わせは 401 になる', async () => {
      const cookie = await p.session(YUDAI)
      const res = await p.logout(cookie)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      expect(cleared, 'セッションの Cookie を消す Set-Cookie が無い').toBeDefined()
      expect(cleared!, 'Cookie が消されていない（Max-Age=0 か過去の Expires）').toMatch(/max-age=0|expires=/i)
      await expectError(await p.me(cookie), 401, 'ログアウトした端末のセッション')
      expect(p.sessionCount(await p.accountId(YUDAI)), 'ログアウトした端末のセッションが残っている').toBe(1)
    })

    // @covers REQ-189#other-devices-keep-session
    it('同じアカウントの他の端末のセッションは残り、本人の問い合わせが通り続ける', async () => {
      const device1 = await p.session(YUDAI)
      const device2 = await p.session(YUDAI)
      expect(device2, '仕込み: 2 つ目の端末のセッションが 1 つ目と同じ').not.toBe(device1)
      expect((await p.logout(device1)).status).toBe(200)
      const me = await p.me(device2)
      expect(me.status, '他の端末のセッションが切れた').toBe(200)
      expect(((await me.json()) as AccountWithGrants).account.email).toBe(YUDAI.email)
      await expectError(await p.logout(), 401, 'セッション無しのログアウト')
    })
  })
})
