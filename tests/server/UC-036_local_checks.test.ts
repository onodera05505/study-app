import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  REGISTRY_KEYS,
  auditFixtures,
  auditScreens,
  emptyTemp,
  hitCounter,
  rewriteAnswers,
  startAuditDeployment,
  toolErrorOf,
  DEPLOY_PORT_OF,
  startExistingDeployment,
  startSameLearningDeployment,
  startSlowHolder,
  type ExistingDeployment,
  type AnswerRewrite,
  checkApi,
  checkPortalApi,
  checkSsoFlow,
  crashed,
  learningDbOf,
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
import { join } from 'node:path'

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

/** 空の一時の置き場を TMPDIR に渡して道具を回した回（REQ-668 と REQ-675 で結果を使い回す）。 */
type TempRun = { r: ToolRun; temp: string }
const once = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined
  return () => (p ??= f())
}
const withTemp = (prepare: (s: Shadow) => void, run: (s: Shadow, temp: string) => Promise<ToolRun>) =>
  once(async (): Promise<TempRun> => {
    const s = toolShadow()
    prepare(s)
    const temp = emptyTemp(s)
    return { r: await run(s, temp), temp }
  })
const tempRuns = {
  checkApiSuccess: withTemp(
    () => {},
    (s, temp) => checkApi(s, 'ip', { TMPDIR: temp }),
  ),
  checkApiFailure: withTemp(
    (s) => stripResponseHeader(s, 'wrangler.jsonc', HEADER),
    (s, temp) => checkApi(s, 'ip', { TMPDIR: temp }),
  ),
  portalApiSuccess: withTemp(
    () => {},
    (s, temp) => checkPortalApi(s, { TMPDIR: temp }),
  ),
  portalApiFailure: withTemp(
    (s) => stripResponseHeader(s, 'portal/wrangler.jsonc', HEADER),
    (s, temp) => checkPortalApi(s, { TMPDIR: temp }),
  ),
  screensSuccess: withTemp(
    () => {},
    (s, temp) => auditScreens(s, ['ip', '--out', s.path('screens'), '--limit', '1'], { TMPDIR: temp }),
  ),
}

/** describe をまたいで使い回す回（画面の採取の失敗の回を REQ-667 と REQ-668 で使う）。 */
const shared: { fixturesWrongShape: () => Promise<{ r: ToolRun; hits: string[]; shots: string[]; temp: string }> } = {
  fixturesWrongShape: () => Promise.reject(new Error('REQ-667 の describe が先に定義されていない')),
}

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

    /** @covers REQ-664#other-files-kept */
    it('出力先に前の回の写しと一覧と一緒に採取が書いていない文字のファイルがあると、写しと一覧を消して撮り、そのファイルは中身ごと残る', async () => {
      const s = toolShadow()
      const NOTES = 'notes.txt'
      const notes = '採取が書いていない覚え書き\n'
      s.write(`screens-other/${OLD}`, '前の回の写し')
      s.write('screens-other/manifest.json', JSON.stringify({ shots: [{ file: OLD }] }))
      s.write(`screens-other/${NOTES}`, notes)
      const r = await auditScreens(s, ['ip', '--out', s.path('screens-other'), '--limit', '1'])
      expectEnded(r, 0)
      const shots = pngs(s.path('screens-other'))
      expect(shots, '前の回の写しが残っている').not.toContain(OLD)
      expect(shots.length, r.out.slice(-2000)).toBe(1)
      expect(s.read('screens-other/manifest.json'), '一覧が前の回の写しを挙げている').not.toContain(OLD)
      expect(existsSync(s.path(`screens-other/${NOTES}`)), `${NOTES} が消えた`).toBe(true)
      expect(s.read(`screens-other/${NOTES}`), `${NOTES} の中身が変わった`).toBe(notes)
    })
  })

  describe('画面の採取に登録簿に無い学びを指定する（REQ-674）', () => {
    /** @covers REQ-674#unknown-learning */
    it('登録簿に無い学び（zzz）を指定すると、配備を起こさず、出力先に写しも一覧も書かず、登録簿の学びをすべて示して失敗で終える', async () => {
      const s = toolShadow({ stores: false })
      const out = s.path('screens-unknown')
      // 道具が失敗の回の記録を残しても影の根の中に収まるよう、一時の置き場を影の根の隣の空の置き場にする
      const r = await auditScreens(s, ['zzz', '--out', out, '--limit', '1'], { TMPDIR: emptyTemp(s) })
      expectEnded(r, 1)
      for (const key of REGISTRY_KEYS) expect(r.out, `指定できる学び ${key} を示していない`).toContain(key)
      expect(existsSync(s.path('.wrangler')), '配備を起こした（手元の保存先ができた）').toBe(false)
      expect(existsSync(s.path('dist')), '配備のために組み立てた').toBe(false)
      expect(pngs(out), '写しを撮った').toEqual([])
      expect(existsSync(join(out, 'manifest.json')), '一覧を書いた').toBe(false)
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

  describe('配備が成功の状態で読めない答えを返す（REQ-667）', () => {
    /** 論点の一覧（listTopics。UC-002 の契約の GET /api/topics）。検査用のアカウントの用意に要る問い合わせ。 */
    const TOPIC_LIST = '^/api/topics$'
    /** 単元の一覧（listCategories。UC-002 の契約の GET /api/categories）。撮る画面の組み立てに要る問い合わせ。 */
    const CATEGORY_LIST = '^/api/categories$'
    /** 論点の詳細（getTopicDetail。UC-002 の契約の GET /api/topics/{id}）のうち、影の根の学び ip の保存先で番号の最も小さい論点の 1 件。 */
    const oneTopicDetail = (sh: Shadow) => {
      const f = learningDbOf(sh, 'ip')
      if (!f) throw new Error('前提: 影の根に学び ip の手元の保存先が無い')
      const { id } = withDb(f, (db) => db.prepare('SELECT MIN(id) AS id FROM topics').get() as { id: number })
      return `^/api/topics/${id}$`
    }
    /** 中身の無い答え（本文が空）と、JSON として読めるが期待した一覧の欄を持たない答え。 */
    const EMPTY = ''
    const NO_LIST = '{"structure":null}'
    /** 期待した一覧の欄を配列で持つが、その要素に null を含む答え（論点の一覧の topics と、単元の一覧の categories）。 */
    const NULL_TOPIC = '{"topics":[null]}'
    const NULL_CATEGORY = '{"categories":[null]}'

    type Rewritten = { r: ToolRun; hits: string[]; shots: string[]; temp: string }
    const runs = new Map<string, Promise<Rewritten>>()
    /** 学び ip の配備の答えを rules で書き換え、組を 2 つに絞って画面を採取する（一時の置き場は空の置き場にする。REQ-668 と結果を使い回す）。 */
    const screensWith = (name: string, rulesOf: AnswerRewrite[] | ((sh: Shadow) => AnswerRewrite[])) => {
      if (!runs.has(name))
        runs.set(
          name,
          withPorts(async () => {
            const s = toolShadow()
            const counter = await hitCounter()
            try {
              rewriteAnswers(s, typeof rulesOf === 'function' ? rulesOf(s) : rulesOf, counter.url)
              const temp = emptyTemp(s)
              const r = await auditScreens(s, ['ip', '--out', s.path('screens'), '--limit', '2'], { TMPDIR: temp })
              return { r, hits: counter.hits(), shots: pngs(s.path('screens')), temp }
            } finally {
              await counter.close()
            }
          }),
        )
      return runs.get(name)!
    }
    /** 写しを撮らずに、書き換えた問い合わせ（経路 path）を示して UPSTREAM_UNAVAILABLE で失敗で終えたか。 */
    const expectRefused = (x: Rewritten, path: string) => {
      expect(x.hits.length, `書き換えた答えを返していない（問い合わせが来ていない）: ${x.r.out.slice(-2000)}`).toBeGreaterThan(0)
      expectEnded(x.r, 1)
      expect(x.shots, '写しを撮った').toEqual([])
      const e = toolErrorOf(x.r.stdout)
      expect(e?.code, `断りの名前が無い: ${x.r.stdout.slice(-2000)}`).toBe('UPSTREAM_UNAVAILABLE')
      expect(e?.reason, '読めなかった問い合わせを示していない').toContain(path)
    }
    shared.fixturesWrongShape = () => screensWith('fixtures-wrong-shape', [{ path: TOPIC_LIST, body: NO_LIST }])

    /** @covers REQ-667#fixtures-empty-answer */
    it('画面の採取で、論点の一覧が成功の状態で本文の無い答えを返すと、写しを撮らずに、その問い合わせを示して UPSTREAM_UNAVAILABLE で失敗で終える', async () => {
      expectRefused(await screensWith('fixtures-empty', [{ path: TOPIC_LIST, body: EMPTY }]), '/api/topics')
    })

    /** @covers REQ-667#fixtures-wrong-shape */
    it('画面の採取で、論点の一覧が成功の状態で一覧の欄（topics）を持たない答えを返すと、写しを撮らずに、その問い合わせを示して UPSTREAM_UNAVAILABLE で失敗で終える', async () => {
      expectRefused(await shared.fixturesWrongShape(), '/api/topics')
    })

    /** @covers REQ-667#screens-wrong-shape */
    it('画面の採取で、単元の一覧が成功の状態で一覧の欄（categories）を持たない答えを返すと、写しを撮らずに、その問い合わせを示して UPSTREAM_UNAVAILABLE で失敗で終える', async () => {
      expectRefused(await screensWith('screens-wrong-shape', [{ path: CATEGORY_LIST, body: '{}' }]), '/api/categories')
    })

    /** @covers REQ-667#fixtures-item-wrong-shape */
    it('画面の採取で、論点の一覧が成功の状態で一覧の欄（topics）は持つが要素に null を含む答えを返すと、写しを撮らずに、その問い合わせを示して UPSTREAM_UNAVAILABLE で失敗で終える', async () => {
      expectRefused(await screensWith('fixtures-item-wrong-shape', [{ path: TOPIC_LIST, body: NULL_TOPIC }]), '/api/topics')
    })

    /** @covers REQ-667#screens-item-wrong-shape */
    it('画面の採取で、単元の一覧が成功の状態で一覧の欄（categories）は持つが要素に null を含む答えを返すと、写しを撮らずに、その問い合わせを示して UPSTREAM_UNAVAILABLE で失敗で終える', async () => {
      expectRefused(await screensWith('screens-item-wrong-shape', [{ path: CATEGORY_LIST, body: NULL_CATEGORY }]), '/api/categories')
    })

    /** @covers REQ-667#fixtures-alone-wrong-shape */
    it('検査用のアカウントの用意を単独で回し、論点の一覧が成功の状態で一覧の欄を持たない答えを返すと、その問い合わせを示して UPSTREAM_UNAVAILABLE で失敗で終える', async () => {
      await withPorts(async () => {
        const s = toolShadow()
        const counter = await hitCounter()
        const close = await startAuditDeployment(s, 'ip', 8787, { rules: [{ path: TOPIC_LIST, body: NO_LIST }], hitUrl: counter.url })
        try {
          const r = await auditFixtures(s, ['--base', 'http://127.0.0.1:8787', '--json', s.path('fixtures.json')])
          expect(counter.hits().length, `書き換えた答えを返していない（問い合わせが来ていない）: ${r.out.slice(-2000)}`).toBeGreaterThan(0)
          expectEnded(r, 1)
          const e = toolErrorOf(r.stdout)
          expect(e?.code, `断りの名前が無い: ${r.stdout.slice(-2000)}`).toBe('UPSTREAM_UNAVAILABLE')
          expect(e?.reason, '読めなかった問い合わせを示していない').toContain('/api/topics')
        } finally {
          await close()
          await counter.close()
        }
      })
    })

    /** @covers REQ-667#topic-detail-skipped */
    it('論点の詳細が成功の状態で期待と違う形の答えを返しても、断らずにその 1 件を飛ばして撮り、成功で終える', async () => {
      const x = await screensWith('topic-detail', (sh) => [{ path: oneTopicDetail(sh), body: '{}' }])
      expect(x.hits.length, `書き換えた論点の詳細を問い合わせていない: ${x.r.out.slice(-2000)}`).toBeGreaterThan(0)
      expectEnded(x.r, 0)
      expect(toolErrorOf(x.r.stdout), '断った').toBeNull()
      expect(x.shots.length, x.r.out.slice(-2000)).toBeGreaterThan(0)
    })
  })

  describe('道具がその回に一時の置き場に作る記録（REQ-668）', () => {
    /**
     * 道具の回の記録でない物: 道具が起こす実行環境（Node と wrangler）が一時の置き場に置き、回をまたいで使い回す控え
     * （Node のコンパイルの控えと、wrangler の新しい版の確かめの控え）。
     */
    const RUNTIME_CACHES = new Set(['node-compile-cache', 'update-check'])
    /** 回した後に一時の置き場に残る、道具の回の記録（置き場は回す前に空）。 */
    const leftIn = (temp: string) => readdirSync(temp).filter((n) => !RUNTIME_CACHES.has(n))
    /** 道具の出力が示す、一時の置き場の中で今も在る場所。 */
    const shownKept = (r: ToolRun, temp: string) => {
      const text = `${r.stdout}\n${r.stderr}`
      const forms = [temp, temp.replace(/^\/private\//, '/')]
      const found: string[] = []
      for (const form of forms) {
        const re = new RegExp(`${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s'"、。）),]*`, 'g')
        for (const m of text.matchAll(re)) found.push(m[0])
      }
      return found.filter((p) => !forms.includes(p.replace(/\/+$/, '')) && existsSync(p))
    }
    const expectKept = (r: ToolRun, temp: string) => {
      expect(leftIn(temp).length, `一時の置き場に記録が残っていない: ${r.out.slice(-2000)}`).toBeGreaterThan(0)
      expect(shownKept(r, temp).length, `残した記録の場所を示していない: ${r.out.slice(-2000)}`).toBeGreaterThan(0)
    }

    /** @covers REQ-668#check-api-success-removed */
    it('学びの API の検査が成功で終えると、その回が一時の置き場に作った記録は残らない', async () => {
      const { r, temp } = await tempRuns.checkApiSuccess()
      expectEnded(r, 0)
      expect(leftIn(temp), '一時の置き場に残った物').toEqual([])
    })

    /** @covers REQ-668#check-api-failure-kept */
    it('学びの API の検査が失敗で終えると、その回が一時の置き場に作った記録が残り、その場所が出力に示される', async () => {
      const { r, temp } = await tempRuns.checkApiFailure()
      expectEnded(r, 1)
      expectKept(r, temp)
    })

    /** @covers REQ-668#portal-api-success-removed */
    it('まなびばの API の検査が成功で終えると、その回が一時の置き場に作った記録は残らない', async () => {
      const { r, temp } = await tempRuns.portalApiSuccess()
      expectEnded(r, 0)
      expect(leftIn(temp), '一時の置き場に残った物').toEqual([])
    })

    /** @covers REQ-668#portal-api-failure-kept */
    it('まなびばの API の検査が失敗で終えると、その回が一時の置き場に作った記録が残り、その場所が出力に示される', async () => {
      const { r, temp } = await tempRuns.portalApiFailure()
      expectEnded(r, 1)
      expectKept(r, temp)
    })

    /** @covers REQ-668#screens-success-removed */
    it('画面の採取が成功で終えると、その回が一時の置き場に作った記録は残らない', async () => {
      const { r, temp } = await tempRuns.screensSuccess()
      expectEnded(r, 0)
      expect(leftIn(temp), '一時の置き場に残った物').toEqual([])
    })

    /** @covers REQ-668#screens-failure-kept */
    it('画面の採取が失敗で終えると（論点の一覧が読めない答えを返す配備）、その回が一時の置き場に作った記録が残り、その場所が出力に示される', async () => {
      const x = await shared.fixturesWrongShape()
      expect(x.r.status, x.r.out.slice(-2000)).toBe(1)
      expectKept(x.r, x.temp)
    })
  })

  describe('道具がその回に起こした手元の配備のプロセス（REQ-675）', () => {
    /**
     * 道具が自分で配備を起こした回（道具を起こす直前に、配備に使う口を待ち受けるプロセスが無かった）で、道具が終えた時点で、
     * 道具のプロセスグループに属するプロセスが 1 つも無く、配備に使う口を待ち受けるプロセスも無く、作業の場所が影の根の下にあるプロセスも無い
     * （どれも土台が後片付けをする前に取った物）。
     */
    const expectNoneLeft = (r: ToolRun, status: number) => {
      expectEnded(r, status)
      expect(r.heldBefore, '前提: 道具を起こす前から配備に使う口を掴むプロセスがある（道具が自分で配備を起こした回でない）').toEqual([])
      expect(r.leftover, `道具が終えた時点で、道具のプロセスグループに残ったプロセスの数: ${r.out.slice(-1500)}`).toBe(0)
      expect(r.portHolders, '道具が終えた時点で、配備に使う口を掴んでいるプロセス').toEqual([])
      expect(r.underRoot, '道具が終えた時点で、作業の場所が影の根の下にあるプロセス').toEqual([])
    }

    // @covers REQ-675#check-api-success-stopped
    it('学びの API の検査が自分で配備を起こして成功で終えると、終えた時点でその回が起こした配備のプロセスが 1 つも残っていない', async () => {
      expectNoneLeft((await tempRuns.checkApiSuccess()).r, 0)
    })

    // @covers REQ-675#check-api-failure-stopped
    it('学びの API の検査が自分で配備を起こして失敗で終える（配備がセキュリティヘッダを 1 つ外した応答を返す）と、終えた時点でその回が起こした配備のプロセスが 1 つも残っていない', async () => {
      expectNoneLeft((await tempRuns.checkApiFailure()).r, 1)
    })

    // @covers REQ-675#portal-api-success-stopped
    it('まなびばの API の検査が自分で配備を起こして成功で終えると、終えた時点でその回が起こした配備のプロセスが 1 つも残っていない', async () => {
      expectNoneLeft((await tempRuns.portalApiSuccess()).r, 0)
    })

    // @covers REQ-675#portal-api-failure-stopped
    it('まなびばの API の検査が自分で配備を起こして失敗で終える（配備がセキュリティヘッダを 1 つ外した応答を返す）と、終えた時点でその回が起こした配備のプロセスが 1 つも残っていない', async () => {
      expectNoneLeft((await tempRuns.portalApiFailure()).r, 1)
    })

    // @covers REQ-675#screens-success-stopped
    it('画面の採取が自分で配備を起こして成功で終えると、終えた時点でその回が起こした配備のプロセスが 1 つも残っていない', async () => {
      expectNoneLeft((await tempRuns.screensSuccess()).r, 0)
    })

    // @covers REQ-675#screens-failure-stopped
    it('画面の採取が自分で配備を起こして失敗で終える（論点の一覧が読めない答えを返す配備）と、終えた時点でその回が起こした配備のプロセスが 1 つも残っていない', async () => {
      expectNoneLeft((await shared.fixturesWrongShape()).r, 1)
    })

    /**
     * 道具を回す前に、道具が配備に使う口を、道具と別のプロセスグループで作業の場所を影の根の外に置いたプロセス（道具が起こしていないプロセス）に
     * 掴ませておき、道具を回す。道具の終わり方は問わない。道具が終えた時点でそのプロセスが生きているかを取り、afterTool（答えずに持っていた
     * プロセスに答えさせる）のあとに、口の死活確認に応じるかを返す。
     */
    const withForeign = <P extends ExistingDeployment>(start: () => Promise<P>, run: (s: Shadow) => Promise<ToolRun>, afterTool: (p: P) => void = () => {}) =>
      withPorts(async () => {
        const foreign = await start()
        try {
          const r = await run(toolShadow())
          const aliveAtEnd = foreign.alive()
          afterTool(foreign)
          return { r, alive: aliveAtEnd, responds: await foreign.responds(), pid: foreign.pid, foreign }
        } finally {
          await foreign.close()
        }
      })
    const withExisting = (port: number, run: (s: Shadow) => Promise<ToolRun>) => withForeign(() => startExistingDeployment(port), run)
    const withSlowHolder = (port: number, run: (s: Shadow) => Promise<ToolRun>) =>
      withForeign(
        () => startSlowHolder(port),
        run,
        (p) => p.release(),
      )
    const expectKeptAlive = (x: { r: ToolRun; alive: boolean; responds: boolean; pid: number }) => {
      expect(x.r.timedOut, x.r.out.slice(-1500)).toBe(false)
      expect(crashed(x.r), x.r.out.slice(-1500)).toBe(false)
      expect(x.r.heldBefore, '前提: 道具が起こしていないプロセスが口を掴んでいない').toContain(x.pid)
      expect(x.alive, `道具が、道具が起こしていないプロセスを止めた: ${x.r.out.slice(-1500)}`).toBe(true)
      expect(x.responds, '道具が終えたあと、道具が起こしていないプロセスが口に応じない').toBe(true)
    }
    const screensOne = (s: Shadow) => auditScreens(s, ['ip', '--out', s.path('screens'), '--limit', '1'], { TMPDIR: emptyTemp(s) })

    // @covers REQ-675#check-api-existing-kept
    it('学びの API の検査の口で道具が起こしていない配備が既に応じていると、道具が終えたあともその配備のプロセスが生きていて口に応じる', async () => {
      expectKeptAlive(await withExisting(DEPLOY_PORT_OF.checkApi, (s) => checkApi(s, 'ip')))
    })

    // @covers REQ-675#portal-api-existing-kept
    it('まなびばの API の検査の口で道具が起こしていない配備が既に応じていると、道具が終えたあともその配備のプロセスが生きていて口に応じる', async () => {
      expectKeptAlive(await withExisting(DEPLOY_PORT_OF.checkPortalApi, (s) => checkPortalApi(s)))
    })

    // @covers REQ-675#screens-existing-kept
    it('画面の採取の口で道具が起こしていない、撮る学びと画面の名が違う（画面の名を返さない）配備が既に応じていると、道具が終えたあともその配備のプロセスが生きていて口に応じる', async () => {
      expectKeptAlive(await withExisting(DEPLOY_PORT_OF.auditScreens, screensOne))
    })

    // @covers REQ-675#screens-same-learning-kept
    it('画面の採取の口で道具が起こしていない、撮る学び ip と同じ画面の名を返す配備が既に応じていると、道具はその配備へ死活確認と画面の名のほかの要求を当て、終えたあともその配備のプロセスが生きていて口に応じる', async () => {
      const x = await withForeign(() => startSameLearningDeployment(DEPLOY_PORT_OF.auditScreens, 'ip'), screensOne)
      const others = x.foreign.requests().filter((q) => q.path !== '/api/health' && !(q.method === 'GET' && !q.path.startsWith('/api/')))
      expect(others.length, `既に応じている同じ画面の名の配備へ、死活確認と画面の名のほかの要求が来ていない（使って進んでいない）: ${x.r.out.slice(-1500)}`).toBeGreaterThan(0)
      expectKeptAlive(x)
    })

    // @covers REQ-675#check-api-slow-held-kept
    it('学びの API の検査の口を道具が起こしていないプロセスが掴み、道具が終えるまで死活確認に答えないと、終えたあともそのプロセスが生きていて口に応じる', async () => {
      expectKeptAlive(await withSlowHolder(DEPLOY_PORT_OF.checkApi, (s) => checkApi(s, 'ip', { TMPDIR: emptyTemp(s) })))
    })

    // @covers REQ-675#portal-api-slow-held-kept
    it('まなびばの API の検査の口を道具が起こしていないプロセスが掴み、道具が終えるまで死活確認に答えないと、終えたあともそのプロセスが生きていて口に応じる', async () => {
      expectKeptAlive(await withSlowHolder(DEPLOY_PORT_OF.checkPortalApi, (s) => checkPortalApi(s, { TMPDIR: emptyTemp(s) })))
    })

    // @covers REQ-675#screens-slow-held-kept
    it('画面の採取の口を道具が起こしていないプロセスが掴み、道具が終えるまで死活確認に答えないと、終えたあともそのプロセスが生きていて口に応じる', async () => {
      expectKeptAlive(await withSlowHolder(DEPLOY_PORT_OF.auditScreens, screensOne))
    })
  })
})
