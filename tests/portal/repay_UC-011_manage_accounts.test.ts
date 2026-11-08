import { describe, expect, it } from 'vitest'
import app from '../../portal/src/index'
import { hashPassword } from '../../src/server/lib/auth'
import { portalD1, sqliteOf, type DatabaseSync } from './repay_UC-014_sqlite_d1'

/**
 * UC-011 アカウントを作り、学びの権限とパスワードを付け替え、削除する（まなびばの管理の経路）。
 *
 * まなびばの migrations を当てた本物の SQLite（node:sqlite）を D1 の口で包んだ共通の偽の D1（repay_UC-014_sqlite_d1）を使い、契約（contract.yaml）の
 * operation を HTTP の入口から叩く。観測は原則として境界（listAccounts・getMe・signIn）で行い、
 * 削除で消えた行の権限とセッションだけはスキーマ源（portal/migrations）の表を直に数える。
 * 最初の管理者はまなびばに作る API が無いので D1 に直に入れる（scripts/check_portal_api.py と同じ）。
 */

// ---- 登場人物（id・メール・権限の値は契約の examples から） ----

const ADMIN = { id: '8a0f1d62-3c47-4b10-9f85-d2e6a1c70b33', email: 'yudai@example.com', name: '山田 太郎', password: 'harunokaze8', role: 'ADMIN', createdAt: 1758000000, grants: ['ap', 'ip'] }
const MEMBER = { id: '1c7e4b05-9a26-4d83-b7f1-6e0c3a9d2544', email: 'hanako@example.com', name: '鈴木 花子', password: 'natsunoame9', role: 'MEMBER', createdAt: 1758600000, grants: ['ip'] }
const ADMIN2 = { id: '5e2b9c71-0d4a-4f36-a8c2-7b1e6f0d9a88', email: 'jiro@example.com', name: '佐藤 次郎', password: 'akinokoe10', role: 'ADMIN', createdAt: 1758300000, grants: [] as string[] }
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const KNOWN = { a: 'ip', b: 'ap' }
const UNKNOWN_LEARNING = 'zzz'

type Person = typeof ADMIN
type Env = Parameters<typeof app.request>[2]
type Account = { id: string; email: string; name: string; role: string; createdAt: number; grants: string[] }

/** 静的ファイルの束縛。この検査では使われないので固定の応答を返すだけ。 */
const assets = { fetch: async () => new Response('') }

async function seed(db: DatabaseSync, p: Person) {
  db.prepare(`INSERT INTO accounts (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    p.id,
    p.email,
    p.name,
    await hashPassword(p.password),
    p.role,
    p.createdAt,
    p.createdAt,
  )
  for (const g of p.grants) db.prepare(`INSERT INTO grants (account_id, learning) VALUES (?, ?)`).run(p.id, g)
}

/** 管理者 1 人の世界。people に足した人も D1 に入れる。 */
async function world(...people: Person[]) {
  const DB = await portalD1()
  const db = sqliteOf(DB)
  await seed(db, ADMIN)
  for (const p of people) await seed(db, p)
  const env = { DB, ASSETS: assets, SSO_SECRET: 'shared' } as unknown as Env
  const admin = await login(env, ADMIN.email, ADMIN.password)
  return { db, env, admin }
}

const json = (method: string, body: unknown, cookie?: string) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
})

/** signIn（UC-013 の契約）。応答の Set-Cookie をそのまま次の要求の Cookie にする。 */
async function login(env: Env, email: string, password: string) {
  const res = await app.request('/api/login', json('POST', { email, password }), env)
  expect(res.status, `ログインできない: ${email}`).toBe(200)
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  expect(cookie, 'ログインの応答にセッションの Cookie が無い').not.toBe('')
  return cookie
}

/** signIn の結果のステータスだけ（パスワードが通るかの観測）。 */
const loginStatus = async (env: Env, email: string, password: string) =>
  (await app.request('/api/login', json('POST', { email, password }), env)).status

/** getMe のステータス（そのセッションが生きているかの観測）。 */
const meStatus = async (env: Env, cookie: string) => (await app.request('/api/me', { headers: { Cookie: cookie } }, env)).status

/** listAccounts。管理者で呼ぶ前提。 */
async function list(env: Env, cookie: string): Promise<Account[]> {
  const res = await app.request('/api/admin/accounts', { headers: { Cookie: cookie } }, env)
  expect(res.status, '一覧が取れない').toBe(200)
  return ((await res.json()) as { accounts: Account[] }).accounts
}

const find = (accounts: Account[], id: string) => accounts.find((a) => a.id === id)

const create = (env: Env, cookie: string, body: unknown) => app.request('/api/admin/accounts', json('POST', body, cookie), env)
const update = (env: Env, cookie: string, id: string, body: unknown) => app.request(`/api/admin/accounts/${id}`, json('PUT', body, cookie), env)
const reset = (env: Env, cookie: string, id: string, body: unknown) => app.request(`/api/admin/accounts/${id}/password`, json('POST', body, cookie), env)
const remove = (env: Env, cookie: string, id: string) => app.request(`/api/admin/accounts/${id}`, { method: 'DELETE', headers: { Cookie: cookie } }, env)

/** JSON でない本文をそのまま送る。 */
const rawBody = (method: string, cookie: string) => ({ method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{not json' })

const countRows = (db: DatabaseSync, table: 'grants' | 'sessions', accountId: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(accountId) as { n: number }).n)

const NEW = { email: 'saburo@example.com', name: '高橋 三郎', password: 'fuyunoyuki7' }

describe('UC-011 アカウントと学びの権限の管理（まなびば）', () => {
  describe('REQ-162 一覧', () => {
    // @covers REQ-162#all-accounts-in-creation-order
    it('役割の違う複数のアカウントが、名前・メール・役割・作成時刻つきで作成時刻の昇順に出る', async () => {
      const { env, admin } = await world(MEMBER, ADMIN2)
      const accounts = await list(env, admin)
      expect(accounts.map((a) => a.id)).toEqual([ADMIN.id, ADMIN2.id, MEMBER.id])
      for (const p of [ADMIN, ADMIN2, MEMBER]) {
        const row = find(accounts, p.id)!
        expect({ email: row.email, name: row.name, role: row.role, createdAt: row.createdAt }).toEqual({ email: p.email, name: p.name, role: p.role, createdAt: p.createdAt })
      }
    })

    // @covers REQ-162#grants-per-account
    it('行ごとに権限のある学びが key の昇順で出て、権限の無い行は空', async () => {
      const { env, admin } = await world(MEMBER, ADMIN2)
      const accounts = await list(env, admin)
      expect(find(accounts, ADMIN.id)!.grants).toEqual(['ap', 'ip'])
      expect(find(accounts, MEMBER.id)!.grants).toEqual(['ip'])
      expect(find(accounts, ADMIN2.id)!.grants).toEqual([])
    })

    // @covers REQ-162#only-self
    it('自分しかいないときは自分の行が 1 件だけ出る', async () => {
      const { env, admin } = await world()
      const accounts = await list(env, admin)
      expect(accounts.map((a) => a.id)).toEqual([ADMIN.id])
    })
  })

  describe('REQ-163 作成', () => {
    // @covers REQ-163#create-with-grants
    it('メール・名前・初期パスワード・開ける学びで作ると、役割が利用者で権限つきの行が一覧に加わる', async () => {
      const { env, admin } = await world()
      const res = await create(env, admin, { ...NEW, grants: [KNOWN.a] })
      expect(res.status).toBe(201)
      const made = (await res.json()) as Account
      expect(made).toMatchObject({ email: NEW.email, name: NEW.name, role: 'MEMBER', grants: [KNOWN.a] })
      const row = find(await list(env, admin), made.id)
      expect(row).toMatchObject({ email: NEW.email, name: NEW.name, role: 'MEMBER', grants: [KNOWN.a] })
    })

    // @covers REQ-163#create-without-grants
    it('開ける学びを省くと、権限の無い行が加わる', async () => {
      const { env, admin } = await world()
      const res = await create(env, admin, NEW)
      expect(res.status).toBe(201)
      const made = (await res.json()) as Account
      expect(find(await list(env, admin), made.id)!.grants).toEqual([])
    })

    // @covers REQ-163#create-normalized-email
    it('前後に空白があり大文字を含むメールは、畳んだ値で保存されて一覧にもその値で出る', async () => {
      const { env, admin } = await world()
      const res = await create(env, admin, { ...NEW, email: '  Saburo@Example.COM ' })
      expect(res.status).toBe(201)
      const made = (await res.json()) as Account
      expect(made.email).toBe(NEW.email)
      expect(find(await list(env, admin), made.id)!.email).toBe(NEW.email)
    })
  })

  describe('REQ-163 作成で役割は求めから採らない', () => {
    // @covers REQ-163#role-not-taken-from-request
    it('作成の求めに管理者の役割を添えても、できるアカウントの役割は利用者', async () => {
      const { env, admin } = await world()
      const res = await create(env, admin, { ...NEW, role: 'ADMIN' })
      expect(res.status, '役割を添えた作成が断られた').toBe(201)
      const made = (await res.json()) as Account
      expect(made.role).toBe('MEMBER')
      expect(find(await list(env, admin), made.id)!.role).toBe('MEMBER')
    })
  })

  describe('REQ-164 既にあるメール', () => {
    // @covers REQ-164#duplicate-email
    it('既にあるメールと同じ値で作ると 409 で、一覧は増えない', async () => {
      const { env, admin } = await world(MEMBER)
      const res = await create(env, admin, { ...NEW, email: MEMBER.email })
      expect(res.status).toBe(409)
      expect((await list(env, admin)).length).toBe(2)
    })

    // @covers REQ-164#duplicate-email-after-folding
    it('空白と大文字小文字を畳むと既存と一致するメールでも 409 で、一覧は増えない', async () => {
      const { env, admin } = await world(MEMBER)
      const res = await create(env, admin, { ...NEW, email: '  HANAKO@Example.com ' })
      expect(res.status).toBe(409)
      expect((await list(env, admin)).length).toBe(2)
    })

    // @covers REQ-164#no-grants-on-conflict
    it('既にあるメールに開ける学びを添えても、権限は作られず既存の権限も変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      const res = await create(env, admin, { ...NEW, email: MEMBER.email, grants: [KNOWN.b] })
      expect(res.status).toBe(409)
      const accounts = await list(env, admin)
      expect(accounts.length).toBe(2)
      expect(find(accounts, MEMBER.id)!.grants).toEqual(MEMBER.grants)
    })
  })

  describe('REQ-165 一部だけの更新', () => {
    const before = { name: MEMBER.name, role: MEMBER.role, grants: MEMBER.grants }

    // @covers REQ-165#name-only
    it('名前だけ送ると名前だけ変わり、役割と権限は変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { name: '鈴木 花' })).status).toBe(200)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject({ ...before, name: '鈴木 花' })
    })

    // @covers REQ-165#role-only
    it('役割だけ送ると役割だけ変わり、名前と権限は変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { role: 'ADMIN' })).status).toBe(200)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject({ ...before, role: 'ADMIN' })
    })

    // @covers REQ-165#grants-replaced
    it('開ける学びの一覧だけ送ると、権限がその一覧に置き換わる（足す側と外す側が同時に起こる）', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { grants: [KNOWN.b] })).status).toBe(200)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject({ ...before, grants: [KNOWN.b] })
    })

    // @covers REQ-165#grants-emptied
    it('空の一覧を送ると権限が全て外れ、名前と役割は変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { grants: [] })).status).toBe(200)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject({ ...before, grants: [] })
    })

    // @covers REQ-165#all-fields
    it('名前・役割・開ける学びをまとめて送ると 3 つが同時に反映される', async () => {
      const { env, admin } = await world(MEMBER)
      const res = await update(env, admin, MEMBER.id, { name: '鈴木 花', role: 'ADMIN', grants: [KNOWN.b, KNOWN.a] })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject({ name: '鈴木 花', role: 'ADMIN', grants: ['ap', 'ip'] })
    })

    // @covers REQ-165#no-field
    it('どの項目も送らないと、何も変わらずに受け付けられる', async () => {
      const { env, admin } = await world(MEMBER)
      const res = await update(env, admin, MEMBER.id, {})
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject(before)
    })

    // @covers REQ-165#self-without-role
    it('自分自身に役割を含めず名前と開ける学びを送ると、断られずに反映され役割は管理者のまま', async () => {
      const { env, admin } = await world()
      expect((await update(env, admin, ADMIN.id, { name: '山田 太', grants: [KNOWN.a] })).status).toBe(200)
      expect(find(await list(env, admin), ADMIN.id)).toMatchObject({ name: '山田 太', role: 'ADMIN', grants: [KNOWN.a] })
      expect(await meStatus(env, admin), '自分のセッションが切れている').toBe(200)
    })
  })

  describe('REQ-166 他人の役割', () => {
    // @covers REQ-166#promote-to-admin
    it('他人の利用者に管理者を送ると管理者になる', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { role: 'ADMIN' })).status).toBe(200)
      expect(find(await list(env, admin), MEMBER.id)!.role).toBe('ADMIN')
    })

    // @covers REQ-166#demote-other-admin
    it('他人の管理者に利用者を送ると利用者になる', async () => {
      const { env, admin } = await world(ADMIN2)
      expect((await update(env, admin, ADMIN2.id, { role: 'MEMBER' })).status).toBe(200)
      expect(find(await list(env, admin), ADMIN2.id)!.role).toBe('MEMBER')
    })

    // @covers REQ-166#same-role-unchanged
    it('他人に今と同じ役割を送っても断られず、役割はその値のまま', async () => {
      const { env, admin } = await world(MEMBER, ADMIN2)
      expect((await update(env, admin, MEMBER.id, { role: 'MEMBER' })).status).toBe(200)
      expect((await update(env, admin, ADMIN2.id, { role: 'ADMIN' })).status).toBe(200)
      const accounts = await list(env, admin)
      expect(find(accounts, MEMBER.id)!.role).toBe('MEMBER')
      expect(find(accounts, ADMIN2.id)!.role).toBe('ADMIN')
    })
  })

  describe('REQ-167 自分の降格', () => {
    // @covers REQ-167#self-demotion-rejected
    it('自分に利用者の役割を送ると 400 で、役割は管理者のまま', async () => {
      const { env, admin } = await world()
      expect((await update(env, admin, ADMIN.id, { role: 'MEMBER' })).status).toBe(400)
      expect(find(await list(env, admin), ADMIN.id)!.role).toBe('ADMIN')
    })

    // @covers REQ-167#self-demotion-keeps-other-fields
    it('自分の降格に名前と開ける学びを添えても、名前も権限も変わらない', async () => {
      const { env, admin } = await world()
      expect((await update(env, admin, ADMIN.id, { role: 'MEMBER', name: '山田 太', grants: [KNOWN.a] })).status).toBe(400)
      expect(find(await list(env, admin), ADMIN.id)).toMatchObject({ name: ADMIN.name, role: 'ADMIN', grants: ADMIN.grants })
    })

    // @covers REQ-167#self-role-admin-passes
    it('自分に管理者の役割を送るのは断られない', async () => {
      const { env, admin } = await world()
      const res = await update(env, admin, ADMIN.id, { role: 'ADMIN' })
      expect(res.status).toBe(200)
      expect(find(await list(env, admin), ADMIN.id)!.role).toBe('ADMIN')
    })
  })

  describe('REQ-168 他人のパスワードの再設定', () => {
    const NEXT = 'haruno-kaze-2'

    // @covers REQ-168#password-replaced
    it('再設定すると相手は新しいパスワードでだけ入れる', async () => {
      const { env, admin } = await world(MEMBER)
      const res = await reset(env, admin, MEMBER.id, { password: NEXT })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(await loginStatus(env, MEMBER.email, NEXT), '新しいパスワードで入れない').toBe(200)
      expect(await loginStatus(env, MEMBER.email, MEMBER.password), '古いパスワードでまだ入れる').toBe(401)
    })

    // @covers REQ-168#sessions-terminated
    it('相手が複数の端末で開いているセッションがすべて終わる', async () => {
      const { db, env, admin } = await world(MEMBER)
      const first = await login(env, MEMBER.email, MEMBER.password)
      const second = await login(env, MEMBER.email, MEMBER.password)
      expect(await meStatus(env, first)).toBe(200)
      expect((await reset(env, admin, MEMBER.id, { password: NEXT })).status).toBe(200)
      expect(await meStatus(env, first), '1 台目のセッションが残っている').toBe(401)
      expect(await meStatus(env, second), '2 台目のセッションが残っている').toBe(401)
      expect(countRows(db, 'sessions', MEMBER.id)).toBe(0)
    })

    // @covers REQ-168#other-accounts-sessions-kept
    it('他のアカウント（呼び出した管理者自身を含む）のセッションは残る', async () => {
      const { env, admin } = await world(MEMBER, ADMIN2)
      const other = await login(env, ADMIN2.email, ADMIN2.password)
      await login(env, MEMBER.email, MEMBER.password)
      expect((await reset(env, admin, MEMBER.id, { password: NEXT })).status).toBe(200)
      expect(await meStatus(env, admin), '呼び出した管理者のセッションが切れた').toBe(200)
      expect(await meStatus(env, other), '関係ない管理者のセッションが切れた').toBe(200)
    })
  })

  describe('REQ-169 同じ学びの重ね書き', () => {
    // @covers REQ-169#duplicate-on-create
    it('作成で同じ学びが 2 回含まれる一覧を送ると、その学びの権限は 1 つだけ付く', async () => {
      const { env, admin } = await world()
      const res = await create(env, admin, { ...NEW, grants: [KNOWN.a, KNOWN.b, KNOWN.a] })
      expect(res.status).toBe(201)
      const made = (await res.json()) as Account
      expect([...made.grants].sort()).toEqual(['ap', 'ip'])
      expect(find(await list(env, admin), made.id)!.grants).toEqual(['ap', 'ip'])
    })

    // @covers REQ-169#duplicate-on-update
    it('更新で同じ学びが 2 回含まれる一覧を送ると、その学びの権限は 1 つだけ残る', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { grants: [KNOWN.b, KNOWN.a, KNOWN.b] })).status).toBe(200)
      expect(find(await list(env, admin), MEMBER.id)!.grants).toEqual(['ap', 'ip'])
    })

    // @covers REQ-169#same-key-only
    it('同じ学びだけが 3 回並ぶ一覧は 1 件に畳まれる', async () => {
      const { env, admin } = await world()
      const res = await create(env, admin, { ...NEW, grants: [KNOWN.a, KNOWN.a, KNOWN.a] })
      expect(res.status).toBe(201)
      const made = (await res.json()) as Account
      expect(made.grants).toEqual([KNOWN.a])
      expect(find(await list(env, admin), made.id)!.grants).toEqual([KNOWN.a])
    })
  })

  describe('REQ-170 他人の削除', () => {
    // @covers REQ-170#delete-other-member
    it('他人の利用者を削除すると一覧から外れる', async () => {
      const { env, admin } = await world(MEMBER)
      const res = await remove(env, admin, MEMBER.id)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect((await list(env, admin)).map((a) => a.id)).toEqual([ADMIN.id])
    })

    // @covers REQ-170#delete-other-admin
    it('他人の管理者も利用者と同じに消える', async () => {
      const { env, admin } = await world(ADMIN2)
      expect((await remove(env, admin, ADMIN2.id)).status).toBe(200)
      expect((await list(env, admin)).map((a) => a.id)).toEqual([ADMIN.id])
    })

    // @covers REQ-170#grants-removed
    it('権限の付いた相手を削除すると、その学びの権限も残らない', async () => {
      const { db, env, admin } = await world({ ...MEMBER, grants: [KNOWN.a, KNOWN.b] })
      expect(countRows(db, 'grants', MEMBER.id)).toBe(2)
      expect((await remove(env, admin, MEMBER.id)).status).toBe(200)
      expect(countRows(db, 'grants', MEMBER.id)).toBe(0)
    })

    // @covers REQ-170#sessions-removed
    it('別の端末でログイン中の相手を削除すると、そのセッションも残らない', async () => {
      const { db, env, admin } = await world(MEMBER)
      const theirs = await login(env, MEMBER.email, MEMBER.password)
      expect((await remove(env, admin, MEMBER.id)).status).toBe(200)
      expect(countRows(db, 'sessions', MEMBER.id)).toBe(0)
      expect(await meStatus(env, theirs)).toBe(401)
    })
  })

  describe('REQ-172 自分の削除', () => {
    // @covers REQ-172#self-delete-rejected
    it('自分の id を指す削除は 400 で、アカウントも権限も残る', async () => {
      const { env, admin } = await world()
      expect((await remove(env, admin, ADMIN.id)).status).toBe(400)
      expect(find(await list(env, admin), ADMIN.id)).toMatchObject({ role: 'ADMIN', grants: ADMIN.grants })
      expect(await meStatus(env, admin)).toBe(200)
    })
  })

  describe('REQ-403 自分のパスワードの再設定', () => {
    // @covers REQ-403#self-reset-rejected
    it('自分の id を指す再設定は 400 の理由つきで、パスワードは入れ替わらず、自分のどの端末のセッションも終わらない', async () => {
      const { db, env, admin } = await world()
      const otherDevice = await login(env, ADMIN.email, ADMIN.password)
      const NEXT = 'natsunoame9'
      const res = await reset(env, admin, ADMIN.id, { password: NEXT })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body), '断りの本文が {error} の形でない').toEqual(['error'])
      expect(String(body.error), '自分のパスワードはこの操作で変えられないことが日本語で示されない').toMatch(/[ぁ-んァ-ヶ一-龥]/)
      expect(await meStatus(env, admin), '呼び出した端末のセッションが終わった').toBe(200)
      expect(await meStatus(env, otherDevice), '別の端末のセッションが終わった').toBe(200)
      expect(countRows(db, 'sessions', ADMIN.id), '自分のセッションの数が変わった').toBe(2)
      expect(await loginStatus(env, ADMIN.email, ADMIN.password), '元のパスワードで入れない').toBe(200)
      expect(await loginStatus(env, ADMIN.email, NEXT), '送ったパスワードに入れ替わっている').toBe(401)
    })
  })

  describe('REQ-173〜175 存在しない相手', () => {
    // @covers REQ-173#update-unknown-id
    it('在らない id への更新は 404 で、どのアカウントの項目も権限も変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      const before = await list(env, admin)
      expect((await update(env, admin, UNKNOWN_ID, { name: '鈴木 花', role: 'ADMIN', grants: [KNOWN.b] })).status).toBe(404)
      expect(await list(env, admin)).toEqual(before)
    })

    // @covers REQ-174#reset-unknown-id
    it('在らない id へのパスワードの再設定は 404 で、どのパスワードも入れ替わらずどのセッションも終わらない', async () => {
      const { env, admin } = await world(MEMBER)
      const theirs = await login(env, MEMBER.email, MEMBER.password)
      expect((await reset(env, admin, UNKNOWN_ID, { password: 'haruno-kaze-2' })).status).toBe(404)
      expect(await meStatus(env, theirs)).toBe(200)
      expect(await meStatus(env, admin)).toBe(200)
      expect(await loginStatus(env, MEMBER.email, MEMBER.password)).toBe(200)
    })

    // @covers REQ-175#delete-unknown-id
    it('在らない id への削除は 404 で、どのアカウントも権限も消えない', async () => {
      const { env, admin } = await world(MEMBER)
      const before = await list(env, admin)
      expect((await remove(env, admin, UNKNOWN_ID)).status).toBe(404)
      expect(await list(env, admin)).toEqual(before)
    })
  })

  describe('REQ-176 利用者からの管理の操作', () => {
    /** 管理者 1 人・利用者 2 人（呼ぶ側と相手）。 */
    const TARGET = { ...ADMIN2, role: 'MEMBER', grants: [KNOWN.a] }
    const asMember = async () => {
      const w = await world(MEMBER, TARGET)
      return { ...w, member: await login(w.env, MEMBER.email, MEMBER.password) }
    }

    // @covers REQ-176#list-as-member
    it('利用者が一覧を求めると 403 で、一覧は返らない', async () => {
      const { env, member } = await asMember()
      const res = await app.request('/api/admin/accounts', { headers: { Cookie: member } }, env)
      expect(res.status).toBe(403)
      expect((await res.json()) as Record<string, unknown>).not.toHaveProperty('accounts')
    })

    // @covers REQ-176#create-as-member
    it('利用者が作成を求めると 403 で、アカウントも権限もできない', async () => {
      const { env, admin, member } = await asMember()
      expect((await create(env, member, { ...NEW, grants: [KNOWN.a] })).status).toBe(403)
      expect((await list(env, admin)).some((a) => a.email === NEW.email)).toBe(false)
    })

    // @covers REQ-176#update-as-member
    it('利用者が更新を求めると 403 で、相手の項目も権限も変わらない', async () => {
      const { env, admin, member } = await asMember()
      expect((await update(env, member, TARGET.id, { name: '別の名前', role: 'ADMIN', grants: [KNOWN.b] })).status).toBe(403)
      expect(find(await list(env, admin), TARGET.id)).toMatchObject({ name: TARGET.name, role: 'MEMBER', grants: [KNOWN.a] })
    })

    // @covers REQ-176#reset-as-member
    it('利用者がパスワードの再設定を求めると 403 で、相手のパスワードもセッションも変わらない', async () => {
      const { env, member } = await asMember()
      const theirs = await login(env, TARGET.email, TARGET.password)
      expect((await reset(env, member, TARGET.id, { password: 'haruno-kaze-2' })).status).toBe(403)
      expect(await meStatus(env, theirs)).toBe(200)
      expect(await loginStatus(env, TARGET.email, TARGET.password)).toBe(200)
      expect(await loginStatus(env, TARGET.email, 'haruno-kaze-2')).toBe(401)
    })

    // @covers REQ-176#delete-as-member
    it('利用者が削除を求めると 403 で、アカウントも権限も消えない', async () => {
      const { env, admin, member } = await asMember()
      expect((await remove(env, member, TARGET.id)).status).toBe(403)
      expect(find(await list(env, admin), TARGET.id)).toMatchObject({ grants: [KNOWN.a] })
    })

    // @covers REQ-176#forbidden-before-invalid
    it('利用者が形を満たさない本文を送っても、先に管理者だけが使えることが示される（403）', async () => {
      const { env, member } = await asMember()
      expect((await create(env, member, { email: 'hanako-example.com', name: '', password: 'mijikai' })).status).toBe(403)
    })
  })

  describe('REQ-177 作成の入力検証', () => {
    // @covers REQ-177#bad-email
    it('形を満たさないメールは 400 で、一覧は増えない', async () => {
      const { env, admin } = await world()
      expect((await create(env, admin, { ...NEW, email: 'hanako-example.com' })).status).toBe(400)
      expect((await list(env, admin)).length).toBe(1)
    })

    // @covers REQ-177#missing-required
    it('メール・名前・初期パスワードのどれが欠けても 400 で、一覧は増えない', async () => {
      const { env, admin } = await world()
      for (const key of ['email', 'name', 'password'] as const) {
        const body: Partial<typeof NEW> = { ...NEW }
        delete body[key]
        expect((await create(env, admin, body)).status, `${key} が欠けても通る`).toBe(400)
      }
      expect((await list(env, admin)).length).toBe(1)
    })

    // @covers REQ-177#bad-name
    it('名前が空・空白だけ・51 文字は 400 で、一覧は増えない', async () => {
      const { env, admin } = await world()
      for (const name of ['', '   ', 'あ'.repeat(51)]) {
        expect((await create(env, admin, { ...NEW, name })).status, `名前 ${JSON.stringify(name)} が通る`).toBe(400)
      }
      expect((await list(env, admin)).length).toBe(1)
    })

    // @covers REQ-177#bad-password
    it('初期パスワードが 7 文字・201 文字は 400 で、一覧は増えない', async () => {
      const { env, admin } = await world()
      for (const password of ['a'.repeat(7), 'a'.repeat(201)]) {
        expect((await create(env, admin, { ...NEW, password })).status, `${password.length} 文字が通る`).toBe(400)
      }
      expect((await list(env, admin)).length).toBe(1)
    })

    // @covers REQ-177#unknown-learning
    it('登録簿に無い学びが含まれると 400 で、アカウントも権限も作られない', async () => {
      const { env, admin } = await world()
      expect((await create(env, admin, { ...NEW, grants: [UNKNOWN_LEARNING] })).status).toBe(400)
      expect((await create(env, admin, { ...NEW, grants: [KNOWN.a, UNKNOWN_LEARNING] })).status, '実在する学びと混ざると通る').toBe(400)
      expect((await list(env, admin)).length).toBe(1)
    })

    // @covers REQ-177#malformed-body
    it('本文が JSON でないと 400 で、一覧は増えない', async () => {
      const { env, admin } = await world()
      expect((await app.request('/api/admin/accounts', rawBody('POST', admin), env)).status).toBe(400)
      expect((await list(env, admin)).length).toBe(1)
    })

    // @covers REQ-177#invalid-before-conflict
    it('既にあるメールと短い初期パスワードを同時に含むと、先に受け付けられない項目が示される（400）', async () => {
      const { env, admin } = await world()
      expect((await create(env, admin, { email: ADMIN.email, name: NEW.name, password: 'mijikai' })).status).toBe(400)
    })
  })

  describe('REQ-178 更新の入力検証', () => {
    const before = { name: MEMBER.name, role: MEMBER.role, grants: MEMBER.grants }

    // @covers REQ-178#bad-name
    it('名前が空・51 文字は 400 で、名前は変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      for (const name of ['', 'あ'.repeat(51)]) {
        expect((await update(env, admin, MEMBER.id, { name })).status, `名前 ${JSON.stringify(name)} が通る`).toBe(400)
      }
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject(before)
    })

    // @covers REQ-178#bad-role
    it('enum の外の役割は 400 で、役割は変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { role: 'OWNER' })).status).toBe(400)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject(before)
    })

    // @covers REQ-178#unknown-learning
    it('登録簿に無い学びが含まれると 400 で、権限は変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { grants: [KNOWN.b, UNKNOWN_LEARNING] })).status).toBe(400)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject(before)
    })

    // @covers REQ-178#malformed-body
    it('本文が JSON でないと 400 で、何も変わらない', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await app.request(`/api/admin/accounts/${MEMBER.id}`, rawBody('PUT', admin), env)).status).toBe(400)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject(before)
    })

    // @covers REQ-178#partially-valid-request
    it('形を満たす名前と満たさない学びが混ざると 400 で、名前も反映されない（部分適用なし）', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, MEMBER.id, { name: '鈴木 花', role: 'ADMIN', grants: [UNKNOWN_LEARNING] })).status).toBe(400)
      expect(find(await list(env, admin), MEMBER.id)).toMatchObject(before)
    })

    // @covers REQ-178#invalid-before-not-found
    it('在らない id と空の名前を同時に含むと、先に受け付けられない項目が示される（400）', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await update(env, admin, UNKNOWN_ID, { name: '' })).status).toBe(400)
    })
  })

  describe('REQ-179 パスワードの再設定の入力検証', () => {
    // @covers REQ-179#short-password
    it('7 文字のパスワードは 400 で、相手は元のパスワードで入れる', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await reset(env, admin, MEMBER.id, { password: 'a'.repeat(7) })).status).toBe(400)
      expect(await loginStatus(env, MEMBER.email, MEMBER.password)).toBe(200)
      expect(await loginStatus(env, MEMBER.email, 'a'.repeat(7))).toBe(401)
    })

    // @covers REQ-179#long-password
    it('201 文字のパスワードは 400 で、相手は元のパスワードで入れる', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await reset(env, admin, MEMBER.id, { password: 'a'.repeat(201) })).status).toBe(400)
      expect(await loginStatus(env, MEMBER.email, MEMBER.password)).toBe(200)
    })

    // @covers REQ-179#missing-password
    it('パスワードが欠けていると 400 で、相手は元のパスワードで入れる', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await reset(env, admin, MEMBER.id, {})).status).toBe(400)
      expect(await loginStatus(env, MEMBER.email, MEMBER.password)).toBe(200)
    })

    // @covers REQ-179#malformed-body
    it('本文が JSON でないと 400 で、相手は元のパスワードで入れる', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await app.request(`/api/admin/accounts/${MEMBER.id}/password`, rawBody('POST', admin), env)).status).toBe(400)
      expect(await loginStatus(env, MEMBER.email, MEMBER.password)).toBe(200)
    })

    // @covers REQ-179#sessions-kept-on-invalid
    it('相手がログイン中に受け付けられないパスワードを送っても、相手のセッションは残る', async () => {
      const { db, env, admin } = await world(MEMBER)
      const theirs = await login(env, MEMBER.email, MEMBER.password)
      expect((await reset(env, admin, MEMBER.id, { password: 'mijikai' })).status).toBe(400)
      expect(await meStatus(env, theirs)).toBe(200)
      expect(countRows(db, 'sessions', MEMBER.id)).toBe(1)
    })

    // @covers REQ-179#invalid-before-not-found
    it('在らない id と短いパスワードを同時に含むと、先に受け付けられない項目が示される（400）', async () => {
      const { env, admin } = await world(MEMBER)
      expect((await reset(env, admin, UNKNOWN_ID, { password: 'mijikai' })).status).toBe(400)
    })
  })
})
