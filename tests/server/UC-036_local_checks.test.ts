import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  REGISTRY_KEYS,
  auditScreens,
  checkApi,
  checkPortalApi,
  checkSsoFlow,
  crashed,
  learningDbs,
  removeTemps,
  rowsOf,
  serveWrong,
  stripResponseHeader,
  toolShadow,
  usersOf,
  withDb,
  withPorts,
  fencedEnv,
  runTool,
  startSsoPair,
  type Shadow,
  type ToolRun,
} from './UC-036_fixture'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

/** UC-036 手元の配備に API と画面を当てる道具の境界（入口と影の根は UC-036_fixture.ts）。
 *  道具は手元に配備を起こす（wrangler dev。決まった口を使う）ので、このファイルのテストは 1 つずつ順に回す。
 *  観測は終了の状態と、道具が挙げた物（ヘッダの名前・学びの key）が出力に出ること、書き出したファイル、影の根の手元の保存先の行。 */

vi.setConfig({ testTimeout: 900_000 })

afterAll(async () => {
  await removeTemps()
})

const HEADER = 'X-Frame-Options'

function expectEnded(r: ToolRun, status: number) {
  expect(r.timedOut, r.out).toBe(false)
  expect(crashed(r), r.out).toBe(false)
  expect(r.status, r.out.slice(-6000)).toBe(status)
}

// ---------------------------------------------------------------------------
// 画面の採取（auditScreens）を同じ影の根で 2 回回し、REQ-599 と REQ-600 のクラスで結果を使い回す。
// 1 回目は組を絞らずに撮る（道具が自分で作る読み込み中と失敗の状態の組を含めるため）。2 回目は --limit で絞る

const AUDIT = 'audit_'
const LIMIT = 2
type Screens = { shadow: Shadow; before: Record<string, Record<string, Set<string>>>; afterFirst: Record<string, Record<string, Set<string>>>; usersFirst: Record<string, unknown>; usersSecond: Record<string, unknown>; first: ToolRun; second: ToolRun; firstShots: string[]; secondShots: string[] }
let screens: Promise<Screens> | undefined
const pngs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.png')).sort() : [])
const snapshot = (s: Shadow) => Object.fromEntries(learningDbs(s).map((f) => [f, withDb(f, rowsOf)]))
const usersAll = (s: Shadow) => Object.fromEntries(learningDbs(s).map((f) => [f, withDb(f, usersOf)]))

function screensRuns(): Promise<Screens> {
  screens ??= withPorts(async () => {
    const shadow = toolShadow()
    // 写した手元の保存先から検査用のアカウント（audit_ で始まる）を除き、居ない状態から始める
    for (const f of learningDbs(shadow)) {
      withDb(f, (db) => {
        const ids = (db.prepare(`SELECT id FROM users WHERE email LIKE '${AUDIT}%'`).all() as { id: string }[]).map((u) => u.id)
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
        for (const id of ids) {
          for (const t of tables) {
            const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
            if (t !== 'users' && cols.includes('user_id')) {
              if (t === 'sessions' && tables.includes('session_questions')) db.prepare('DELETE FROM session_questions WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)').run(id)
              db.prepare(`DELETE FROM "${t}" WHERE user_id = ?`).run(id)
            }
          }
          db.prepare('DELETE FROM users WHERE id = ?').run(id)
        }
      })
    }
    const before = snapshot(shadow)
    const first = await auditScreens(shadow, ['ip', '--out', shadow.path('screens1')])
    const afterFirst = snapshot(shadow)
    const usersFirst = usersAll(shadow)
    const second = await auditScreens(shadow, ['ip', '--out', shadow.path('screens2'), '--limit', String(LIMIT)])
    return { shadow, before, afterFirst, usersFirst, usersSecond: usersAll(shadow), first, second, firstShots: pngs(shadow.path('screens1')), secondShots: pngs(shadow.path('screens2')) }
  })
  return screens
}
const auditUsers = (users: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(users).map(([f, us]) => [f, (us as { id: string; email: string }[]).filter((u) => u.email.startsWith(AUDIT))]))

describe('UC-036 配る前に手元の配備に API と画面を当てる', () => {
  describe('学びの API の検査（checkApi）（REQ-596・REQ-597）', () => {
    /** @covers REQ-597#unknown-learning */
    it('登録簿に無い学び（zzz）を指定すると、配備を起こさずに、指定できる学びを示して失敗で終える', async () => {
      const s = toolShadow({ stores: false })
      const r = await checkApi(s, 'zzz')
      expectEnded(r, 1)
      for (const key of REGISTRY_KEYS) expect(r.out, `指定できる学び ${key} を示していない`).toContain(key)
      expect(existsSync(s.path('.wrangler')), '配備を起こした（手元の保存先ができた）').toBe(false)
      expect(existsSync(s.path('dist')), '配備のために組み立てた').toBe(false)
    })

    /** @covers REQ-596#consistent-passes */
    it('手元の保存先がそろった学び ip の配備が契約と登録簿に合えば、成功で終える', async () => {
      expectEnded(await checkApi(toolShadow(), 'ip'), 0)
    })

    /** @covers REQ-596#security-header-differs */
    it('学びの配備の応答からセキュリティヘッダ（X-Frame-Options）を外すと、そのヘッダを挙げて失敗で終える', async () => {
      const s = toolShadow()
      stripResponseHeader(s, 'wrangler.jsonc', HEADER)
      const r = await checkApi(s, 'ip')
      expectEnded(r, 1)
      expect(r.out, `${HEADER} を挙げていない`).toContain(HEADER)
    })
  })

  describe('まなびばの API の検査（checkPortalApi）（REQ-598）', () => {
    /** @covers REQ-598#consistent-passes */
    it('手元の保存先がそろったまなびばの配備が要件に合えば、成功で終える', async () => {
      expectEnded(await checkPortalApi(toolShadow()), 0)
    })

    /** @covers REQ-598#security-header-differs */
    it('まなびばの配備の応答からセキュリティヘッダ（X-Frame-Options）を外すと、そのヘッダを挙げて失敗で終える', async () => {
      const s = toolShadow()
      stripResponseHeader(s, 'portal/wrangler.jsonc', HEADER)
      const r = await checkPortalApi(s)
      expectEnded(r, 1)
      expect(r.out, `${HEADER} を挙げていない`).toContain(HEADER)
    })
  })

  describe('検査用のアカウントの用意（画面の採取が API を通して用意する）（REQ-599）', () => {
    /** @covers REQ-599#creates-accounts */
    it('検査用のアカウントが居ない保存先に、進み具合の違う検査用のアカウントを作る', async () => {
      const r = await screensRuns()
      expectEnded(r.first, 0)
      const created = Object.entries(auditUsers(r.usersFirst)).flatMap(([f, us]) => (us as { id: string }[]).map((u) => ({ f, id: u.id })))
      expect(created.length, `作られた検査用のアカウントが 2 つ未満: ${r.first.out.slice(-3000)}`).toBeGreaterThanOrEqual(2)
      const shape = created.map(({ f, id }) =>
        withDb(f, (db) => {
          const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(id) as { n: number }).n
          return `${n('progress')}/${n('sessions')}`
        }),
      )
      expect(new Set(shape).size, `進み具合がどれも同じ: ${shape.join(' ')}`).toBeGreaterThan(1)
    })

    /** @covers REQ-599#existing-not-recreated */
    it('検査用のアカウントが既に居る保存先にもう一度用意すると、同じアカウントを作り直さない', async () => {
      const r = await screensRuns()
      expectEnded(r.second, 0)
      expect(auditUsers(r.usersSecond)).toEqual(auditUsers(r.usersFirst))
    })

    /** @covers REQ-599#keeps-data */
    it('用意する前から手元の保存先にあった行は、用意した後もすべて残る', async () => {
      const r = await screensRuns()
      expectEnded(r.first, 0)
      for (const [f, tables] of Object.entries(r.before)) {
        for (const [t, rows] of Object.entries(tables)) {
          const lost = [...rows].filter((row) => !r.afterFirst[f]?.[t]?.has(row))
          expect(lost.length, `${t} から消えた行: ${lost.slice(0, 3).join(' ')}`).toBe(0)
        }
      }
    })
  })

  describe('画面の採取（auditScreens）（REQ-600）', () => {
    /** @covers REQ-600#shots-with-list */
    it('学び ip の画面の組ごとに写しを撮り、撮った写しを挙げた一覧とともに書き出して終える', async () => {
      const r = await screensRuns()
      expectEnded(r.first, 0)
      expect(r.firstShots.length, r.first.out.slice(-3000)).toBeGreaterThan(0)
      const list = readdirSync(r.shadow.path('screens1')).filter((n) => n.endsWith('.json'))
      expect(list.length, '一覧が書き出されていない').toBeGreaterThan(0)
      const text = list.map((n) => readFileSync(r.shadow.path(`screens1/${n}`), 'utf8')).join('\n')
      for (const shot of r.firstShots) expect(text, `${shot} が一覧に無い`).toContain(shot.replace(/\.png$/, ''))
    })

    /** @covers REQ-600#tool-made-states */
    it('組を絞らずに撮ると、道具が自分で作る読み込み中と失敗の状態の組も撮り、撮れなかった組と読み込み中のまま撮れた数を挙げる', async () => {
      const r = await screensRuns()
      expect(crashed(r.first), r.first.out).toBe(false)
      expect([0, 1], r.first.out.slice(-3000)).toContain(r.first.status)
      const manifest = JSON.parse(readFileSync(r.shadow.path('screens1/manifest.json'), 'utf8')) as {
        shots: { file: string | null; state: string; expectFailure: boolean; error: unknown; account: string; width: number }[]
        summary: Record<string, unknown>
      }
      // 失敗を期待して道具が作った状態（応答の遅れ・500・通信断）の組を、3 種以上撮って写しを書き出している
      const made = manifest.shots.filter((x) => x.expectFailure)
      expect(new Set(made.map((x) => x.state)).size, `道具が作った状態の種類: ${[...new Set(made.map((x) => x.state))].join(' ')}`).toBeGreaterThanOrEqual(3)
      for (const x of made.filter((y) => y.file)) expect(existsSync(r.shadow.path(`screens1/${x.file}`)), `${x.file} が無い`).toBe(true)
      // 撮れなかった組は、出力にその組（アカウントと幅）を挙げる
      for (const x of manifest.shots.filter((y) => y.error)) {
        expect(r.first.stdout.split('\n').some((l) => l.includes(x.account) && l.includes(String(x.width))), `撮れなかった組 ${x.account}/${x.width} を挙げていない`).toBe(true)
      }
      // 読み込み中のまま撮れた写しの数を一覧に挙げる（0 件でも数として持つ）
      expect(typeof manifest.summary.stuckLoading, '読み込み中のまま撮れた写しの数が一覧に無い').toBe('number')
    })

    /** @covers REQ-600#existing-accounts */
    it('検査用のアカウントが既に居る学びでも、画面の組ごとに写しを撮って一覧とともに書き出して終える', async () => {
      const r = await screensRuns()
      expectEnded(r.second, 0)
      expect(r.secondShots.length, r.second.out.slice(-3000)).toBe(LIMIT)
    })
  })

  describe('画面の採取の出力先にある前の回の写し（REQ-664）', () => {
    /** 前の回の写しを模した物（画面の写しと同じ名前の形）。 */
    const OLD = 'audit_old__home__375__light__normal.png'
    /** 出力先に前の回の写しを置いて、組を 1 つに絞って採取する（keep なら残す指定を付ける）。 */
    const withPrevious = async (keep: boolean) => {
      const s = toolShadow()
      s.write(`screens-prev/${OLD}`, '前の回の写し')
      const r = await auditScreens(s, ['ip', '--out', s.path('screens-prev'), '--limit', '1', ...(keep ? ['--keep'] : [])])
      return { r, shots: pngs(s.path('screens-prev')) }
    }

    /** @covers REQ-664#previous-shots-removed */
    it('出力先に前の回の写しがあると、それを消してから撮る', async () => {
      const { r, shots } = await withPrevious(false)
      expectEnded(r, 0)
      expect(shots, '前の回の写しが残っている').not.toContain(OLD)
      expect(shots.length, r.out.slice(-2000)).toBe(1)
    })

    /** @covers REQ-664#keep-previous */
    it('残すと指定すると、前の回の写しを消さずに撮る', async () => {
      const { r, shots } = await withPrevious(true)
      expectEnded(r, 0)
      expect(shots, '前の回の写しが消えた').toContain(OLD)
      expect(shots.filter((n) => n !== OLD).length, r.out.slice(-2000)).toBe(1)
    })
  })

  describe('手元の SSO の一巡（checkSsoFlow）（REQ-629）', () => {
    /** 事前条件の状態を起こして一巡を 1 回回し、一巡の前と後のまなびばのアカウントを取る（2 つのクラスで使い回す）。 */
    let flow: Promise<{ r: ToolRun; before: string[]; after: string[] }> | undefined
    const flowRun = () =>
      (flow ??= withPorts(async () => {
        const s = toolShadow({ stores: false })
        const pair = await startSsoPair()
        try {
          const before = pair.accounts()
          const r = await runTool(s, ['python3', 'scripts/check_sso_flow.py'], { timeoutMs: 120_000, env: fencedEnv(s) })
          return { r, before, after: pair.accounts() }
        } finally {
          await pair.close()
        }
      }))

    /** @covers REQ-629#consistent-passes */
    it('事前条件の状態にある手元のまなびばと学び mkt で一巡を回すと、成功で終える', async () => {
      const { r } = await flowRun()
      expectEnded(r, 0)
    })

    /** @covers REQ-629#temp-accounts-removed */
    it('一巡の後、まなびばのアカウントは一巡の前と同じで、一巡が作った一時のアカウントは残らない', async () => {
      const { r, before, after } = await flowRun()
      expectEnded(r, 0)
      expect(after).toEqual(before)
    })

    /** @covers REQ-629#mismatch-fails */
    it('起きているまなびばと学びの配備がどの要求にも同じ 200 で応える（要件と食い違う）と、失敗で終える', async () => {
      await withPorts(async () => {
        const closers = [await serveWrong(8790), await serveWrong(8788)]
        try {
          const r = await checkSsoFlow(toolShadow({ stores: false }))
          expect(r.timedOut, r.out).toBe(false)
          expect(r.status, r.out.slice(-3000)).toBe(1)
        } finally {
          for (const close of closers) await close()
        }
      })
    })
  })
})
