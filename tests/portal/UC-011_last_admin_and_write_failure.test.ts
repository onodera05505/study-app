import { describe, expect, it } from 'vitest'
import app from '../../portal/src/index'
import { hashPassword } from '../../src/server/lib/auth'
import { portalD1, sqliteOf, type DatabaseSync } from './repay_UC-014_sqlite_d1'

/**
 * UC-011 最後の管理者を外さない（REQ-404）と、書き込みの途中で保存に失敗したら何も残さない（REQ-405）。
 *
 * まなびばの migrations を当てた共通の偽の D1 を、境界（D1 の口）でだけ包む。
 * - 重なり: 書き込みの文（INSERT・UPDATE・DELETE・REPLACE）を最初に出した求めを、もう 1 つの求めも書き込みの文に
 *   達するまで待たせ、両方が書き込みの前の検査を通ったあとに書き込む状態を作る（UC.md の並行性の行）。
 * - 保存の失敗: 対象の求めが出す k 番目の書き込みの文を失敗させ、k を 1 から書き込みが尽きるまで動かす。
 * 観測は境界（listAccounts・signIn・getMe）と、権限とセッションの表の行の数。
 */

const ADMIN = { id: '8a0f1d62-3c47-4b10-9f85-d2e6a1c70b33', email: 'yudai@example.com', name: '山田 太郎', password: 'harunokaze8', role: 'ADMIN', createdAt: 1758000000, grants: ['ap', 'ip'] }
const ADMIN2 = { id: '3e9a7c21-5b84-4f06-a1d3-7c2b9e4f8a10', email: 'jiro@example.com', name: '佐藤 次郎', password: 'akinokoe10', role: 'ADMIN', createdAt: 1758300000, grants: ['ip'] }
const ADMIN3 = { id: '5e2b9c71-0d4a-4f36-a8c2-7b1e6f0d9a88', email: 'saburo@example.com', name: '高橋 三郎', password: 'fuyunoyuki7', role: 'ADMIN', createdAt: 1758400000, grants: [] as string[] }
const MEMBER = { id: '1c7e4b05-9a26-4d83-b7f1-6e0c3a9d2544', email: 'hanako@example.com', name: '鈴木 花子', password: 'natsunoame9', role: 'MEMBER', createdAt: 1758600000, grants: ['ip'] }

type Person = typeof ADMIN
type Env = Parameters<typeof app.request>[2]
type Account = { id: string; email: string; name: string; role: string; createdAt: number; grants: string[] }

const assets = { fetch: async () => new Response('') }
const JAPANESE = /[ぁ-んァ-ヶ一-龥]/
const WRITE = /^\s*(insert|update|delete|replace)\b/i

/** 包んだ文が持つ元の文と SQL。batch はこれを取り出して元の D1 に渡す。 */
const ORIGINAL = Symbol('original')
type Wrapped = { [ORIGINAL]: { statement: D1PreparedStatement; sql: string } }

/**
 * D1 の口を包み、書き込みの文の前に差し込みを置けるようにする。
 * batch は 1 つのトランザクションなので、差し込みは batch の中の書き込みの文ごとに batch を流す前に呼ぶ
 * （待たせてもトランザクションを開いたまま他の求めを走らせない）。
 */
class Hooked {
  /** 書き込みの文が実行される直前に呼ばれる。投げればその文（batch ならその batch 全体）は失敗する。 */
  beforeWrite: ((sql: string) => Promise<void> | void) | null = null

  constructor(readonly inner: D1Database) {}

  private async hook(sql: string) {
    if (WRITE.test(sql) && this.beforeWrite) await this.beforeWrite(sql)
  }

  private wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = {
      [ORIGINAL]: { statement, sql },
      bind: (...values: unknown[]) => this.wrap(statement.bind(...values), sql),
      first: async (column?: string) => {
        await this.hook(sql)
        return column === undefined ? statement.first() : statement.first(column)
      },
      all: async () => {
        await this.hook(sql)
        return statement.all()
      },
      run: async () => {
        await this.hook(sql)
        return statement.run()
      },
      raw: async (options?: { columnNames?: boolean }) => {
        await this.hook(sql)
        return (statement.raw as (o?: { columnNames?: boolean }) => Promise<unknown[]>)(options)
      },
    }
    return wrapped as unknown as D1PreparedStatement
  }

  prepare(sql: string) {
    return this.wrap(this.inner.prepare(sql), sql)
  }

  /** 本物の D1 は batch を 1 つずつ流す。偽の D1 の batch は途中で待つので、ここで 1 本ずつに並べる。 */
  private queue: Promise<unknown> = Promise.resolve()

  async batch(statements: D1PreparedStatement[]) {
    const originals = statements.map((s) => (s as unknown as Wrapped)[ORIGINAL])
    for (const { sql } of originals) await this.hook(sql)
    const run = this.queue.then(() => this.inner.batch(originals.map((o) => o.statement)))
    this.queue = run.catch(() => undefined)
    return run
  }

  exec(sql: string) {
    return this.inner.exec(sql)
  }

  dump() {
    return this.inner.dump()
  }
}

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

async function world(...people: Person[]) {
  const inner = await portalD1()
  const db = sqliteOf(inner)
  for (const p of people) await seed(db, p)
  const hooked = new Hooked(inner)
  const env = { DB: hooked as unknown as D1Database, ASSETS: assets, SSO_SECRET: 'shared' } as unknown as Env
  return { db, env, hooked }
}

const json = (method: string, body: unknown, cookie?: string) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
})

async function login(env: Env, p: Person) {
  const res = await app.request('/api/login', json('POST', { email: p.email, password: p.password }), env)
  expect(res.status, `ログインできない: ${p.email}`).toBe(200)
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

const loginStatus = async (env: Env, email: string, password: string) =>
  (await app.request('/api/login', json('POST', { email, password }), env)).status
const meStatus = async (env: Env, cookie: string) => (await app.request('/api/me', { headers: { Cookie: cookie } }, env)).status

async function list(env: Env, cookie: string): Promise<Account[]> {
  const res = await app.request('/api/admin/accounts', { headers: { Cookie: cookie } }, env)
  expect(res.status, '一覧が取れない').toBe(200)
  return ((await res.json()) as { accounts: Account[] }).accounts
}

const update = (env: Env, cookie: string, id: string, body: unknown) => app.request(`/api/admin/accounts/${id}`, json('PUT', body, cookie), env)
const remove = (env: Env, cookie: string, id: string) => app.request(`/api/admin/accounts/${id}`, { method: 'DELETE', headers: { Cookie: cookie } }, env)
const create = (env: Env, cookie: string, body: unknown) => app.request('/api/admin/accounts', json('POST', body, cookie), env)
const reset = (env: Env, cookie: string, id: string, body: unknown) => app.request(`/api/admin/accounts/${id}/password`, json('POST', body, cookie), env)

/** 表の中のアカウントと権限とセッション（D1 の中身そのもの）。 */
const tables = (db: DatabaseSync) => ({
  accounts: db.prepare('SELECT id, email, name, role, password_hash FROM accounts ORDER BY id').all(),
  grants: db.prepare('SELECT account_id, learning FROM grants ORDER BY account_id, learning').all(),
  sessions: db.prepare('SELECT account_id FROM sessions ORDER BY account_id').all(),
})

const adminCount = (db: DatabaseSync) => Number((db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE role = 'ADMIN'`).get() as { n: number }).n)

/**
 * 2 つの求めを重ねる。どちらかが最初の書き込みの文に達したら、もう一方も達するか（または一定の時間が過ぎるまで）
 * 待たせてから両方を進める。両方とも書き込みの前の検査を通ったあとに書き込む状態になる。
 */
async function overlap(hooked: Hooked, first: () => Promise<Response> | Response, second: () => Promise<Response> | Response) {
  let arrived = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const timer = setTimeout(() => release(), 300)
  hooked.beforeWrite = async () => {
    arrived += 1
    if (arrived >= 2) release()
    await gate
  }
  try {
    return await Promise.all([first(), second()])
  } finally {
    clearTimeout(timer)
    hooked.beforeWrite = null
  }
}

/** 断られた求めの応答: 409 と、最後の管理者は外せないことの日本語の理由。 */
async function expectLastAdminRefusal(res: Response, label: string) {
  expect(res.status, `${label}: 最後の管理者を外す求めが 409 で断られない`).toBe(409)
  const body = (await res.json()) as Record<string, unknown>
  expect(Object.keys(body), `${label}: 断りの本文が {error} の形でない`).toEqual(['error'])
  expect(String(body.error), `${label}: 理由が日本語で示されない`).toMatch(JAPANESE)
}

/** 2 つの応答のうち、通った側と断られた側を分ける（どちらが先に書き込むかは決めない）。 */
const split = (results: Response[]) => {
  const passed = results.filter((r) => r.status === 200)
  const refused = results.filter((r) => r.status !== 200)
  expect(passed.length, `通った求めが 1 つでない（${results.map((r) => r.status).join(', ')}）`).toBe(1)
  expect(refused.length).toBe(1)
  return { passed: passed[0], refused: refused[0], refusedIndex: results.indexOf(refused[0]) }
}

describe('UC-011 最後の管理者は外せない（REQ-404）', () => {
  // @covers REQ-404#race-mutual-demotion
  it('2 人の管理者が互いの役割を同時に外すと、片方だけが通り、断られた求めは役割も名前も権限も変えない', async () => {
    const { db, env, hooked } = await world(ADMIN, ADMIN2)
    const a = await login(env, ADMIN)
    const b = await login(env, ADMIN2)
    const results = await overlap(
      hooked,
      () => update(env, a, ADMIN2.id, { role: 'MEMBER', name: '佐藤 次', grants: ['ap'] }),
      () => update(env, b, ADMIN.id, { role: 'MEMBER', name: '山田 太', grants: ['ap'] }),
    )
    const { refused, refusedIndex } = split(results)
    await expectLastAdminRefusal(refused, '互いの降格')
    expect(adminCount(db), '管理者が 0 人になった').toBe(1)
    // 断られた求めの相手（＝管理者のまま残った人）は、名前も権限も送られる前のまま
    const survivor = refusedIndex === 0 ? ADMIN2 : ADMIN
    const rows = await list(env, await login(env, survivor))
    expect(rows.find((r) => r.id === survivor.id)).toMatchObject({ role: 'ADMIN', name: survivor.name, grants: survivor.grants })
  })

  // @covers REQ-404#race-mutual-delete
  it('2 人の管理者が互いのアカウントを同時に削除すると、片方だけが通り、断られた求めはアカウントも権限も消さない', async () => {
    const { db, env, hooked } = await world(ADMIN, ADMIN2)
    const a = await login(env, ADMIN)
    const b = await login(env, ADMIN2)
    const results = await overlap(
      hooked,
      () => remove(env, a, ADMIN2.id),
      () => remove(env, b, ADMIN.id),
    )
    const { refused, refusedIndex } = split(results)
    await expectLastAdminRefusal(refused, '互いの削除')
    expect(adminCount(db), '管理者が 0 人になった').toBe(1)
    const survivor = refusedIndex === 0 ? ADMIN2 : ADMIN
    const rows = await list(env, await login(env, survivor))
    expect(rows.map((r) => r.id)).toEqual([survivor.id])
    expect(rows[0].grants).toEqual(survivor.grants)
  })

  // @covers REQ-404#race-demotion-and-delete
  it('一方が相手の役割を外し、相手が同時に一方を削除しても、片方だけが通り管理者が 1 人残る', async () => {
    const { db, env, hooked } = await world(ADMIN, ADMIN2)
    const a = await login(env, ADMIN)
    const b = await login(env, ADMIN2)
    const results = await overlap(
      hooked,
      () => update(env, a, ADMIN2.id, { role: 'MEMBER' }),
      () => remove(env, b, ADMIN.id),
    )
    const { refused } = split(results)
    await expectLastAdminRefusal(refused, '降格と削除の重なり')
    expect(adminCount(db), '管理者が 0 人になった').toBe(1)
  })

  // @covers REQ-404#not-last-admin-passes
  it('3 人の管理者のうち 2 人が互いの役割を同時に外しても、3 人目が残るので両方とも通る', async () => {
    const { db, env, hooked } = await world(ADMIN, ADMIN2, ADMIN3)
    const a = await login(env, ADMIN)
    const b = await login(env, ADMIN2)
    const results = await overlap(
      hooked,
      () => update(env, a, ADMIN2.id, { role: 'MEMBER' }),
      () => update(env, b, ADMIN.id, { role: 'MEMBER' }),
    )
    expect(results.map((r) => r.status), '0 人にならない降格が断られた').toEqual([200, 200])
    expect(adminCount(db)).toBe(1)
  })

  // @covers REQ-404#self-demotion-before-conflict
  it('自分自身の降格は、重なった求めで管理者が 0 人になる場合にも、先に自分の役割を下げられないことで断る（400）', async () => {
    const { db, env, hooked } = await world(ADMIN, ADMIN2)
    const a = await login(env, ADMIN)
    const results = await overlap(
      hooked,
      () => update(env, a, ADMIN2.id, { role: 'MEMBER' }),
      () => update(env, a, ADMIN.id, { role: 'MEMBER' }),
    )
    expect(results[1].status, '自分の降格が 400 で断られない（契約の errors の並び）').toBe(400)
    expect(adminCount(db), '管理者が 0 人になった').toBeGreaterThanOrEqual(1)
  })
})

/**
 * 対象の求めが出す k 番目の書き込みの文を失敗させ、k を 1 から書き込みが尽きるまで動かす。
 * どの k でも、求めは成功を返さず、表の中身は求めの前と同じ。
 */
async function expectNothingLeftOnFailure(
  label: string,
  prepare: () => Promise<{ db: DatabaseSync; hooked: Hooked; act: () => Promise<Response> | Response; extra?: () => Promise<void> }>,
) {
  let failedAt = 0
  for (let k = 1; k <= 30; k++) {
    const { db, hooked, act, extra } = await prepare()
    const before = tables(db)
    let writes = 0
    hooked.beforeWrite = () => {
      writes += 1
      if (writes === k) throw new Error('保存に失敗した（検査が差し込んだ失敗）')
    }
    const res = await act()
    hooked.beforeWrite = null
    if (writes < k) {
      // k 番目の書き込みが無かった＝失敗を差し込めなかったので、ここで尽きた
      expect(failedAt, `${label}: 書き込みの文が 1 つも無い（失敗を差し込めない）`).toBeGreaterThan(0)
      return
    }
    failedAt = k
    expect(res.status, `${label}（${k} 番目の書き込みで失敗）: 成功を返した`).toBeGreaterThanOrEqual(500)
    expect(tables(db), `${label}（${k} 番目の書き込みで失敗）: 書き込みが残っている`).toEqual(before)
    if (extra) await extra()
  }
  throw new Error(`${label}: 書き込みの文が 30 を超えた`)
}

describe('UC-011 書き込みの途中で保存に失敗したら何も残さない（REQ-405）', () => {
  // @covers REQ-405#create-failure-leaves-nothing
  it('アカウントの作成の途中で保存に失敗すると、アカウントも権限も残らない', async () => {
    await expectNothingLeftOnFailure('作成', async () => {
      const { db, env, hooked } = await world(ADMIN)
      const a = await login(env, ADMIN)
      return { db, hooked, act: () => create(env, a, { email: 'shiro@example.com', name: '伊藤 四郎', password: 'harunokaze8', grants: ['ap', 'ip'] }) }
    })
  })

  // @covers REQ-405#update-failure-leaves-nothing
  it('名前・役割・権限の更新の途中で保存に失敗すると、どの項目も権限も変わらない', async () => {
    await expectNothingLeftOnFailure('更新', async () => {
      const { db, env, hooked } = await world(ADMIN, MEMBER)
      const a = await login(env, ADMIN)
      return { db, hooked, act: () => update(env, a, MEMBER.id, { name: '鈴木 花', role: 'ADMIN', grants: ['ap'] }) }
    })
  })

  // @covers REQ-405#reset-failure-leaves-nothing
  it('パスワードの再設定の途中で保存に失敗すると、パスワードは入れ替わらず相手のセッションも残る', async () => {
    await expectNothingLeftOnFailure('再設定', async () => {
      const { db, env, hooked } = await world(ADMIN, MEMBER)
      const a = await login(env, ADMIN)
      const theirs = await login(env, MEMBER)
      return {
        db,
        hooked,
        act: () => reset(env, a, MEMBER.id, { password: 'haruno-kaze-2' }),
        extra: async () => {
          expect(await meStatus(env, theirs), '相手のセッションが終わった').toBe(200)
          expect(await loginStatus(env, MEMBER.email, MEMBER.password), '元のパスワードで入れない').toBe(200)
        },
      }
    })
  })

  // @covers REQ-405#delete-failure-leaves-nothing
  it('アカウントの削除の途中で保存に失敗すると、アカウントも権限もセッションも残る', async () => {
    await expectNothingLeftOnFailure('削除', async () => {
      const { db, env, hooked } = await world(ADMIN, MEMBER)
      const a = await login(env, ADMIN)
      await login(env, MEMBER)
      return { db, hooked, act: () => remove(env, a, MEMBER.id) }
    })
  })
})
