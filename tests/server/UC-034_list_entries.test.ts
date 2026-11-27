import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  type Json,
  type ListRun,
  ROOT,
  TABLE,
  camelName,

  expectListed,
  expectRefused,
  fixedInboundWires,
  honoApp,
  removeTemps,
  routeKey,
  routesOf,
  runReal,
  runShadow,
  sourceExtensions,
  tableKey,
  tailOf,
  throwingApp,
  toolsOf,
} from './UC-034_fixture'

/** UC-034 入口の一覧を出す道具（listEntries ＝ `npx tsx scripts/list_entries.ts`）の境界。
 *
 *  今のリポジトリの実物に当てるクラスは、期待を確定した契約の wire と道具の置き場の中身（と名前の表）から導く。
 *  小さい状態に当てるクラスは、影の根（UC-034_fixture.ts）で app・道具の置き場の直下・名前の表を差し替える。
 *  経路だけを見る影の根は、道具の置き場の直下を道具の写しだけにし、名前の表を置かない（道具の入口は listEntries だけになる）。 */

vi.setConfig({ testTimeout: 180_000 })

afterAll(async () => {
  await removeTemps()
})

/** 経路だけを見る影の根（道具の置き場は道具の写しだけ、名前の表なし）。 */
const appsOnly = (learning: string[], portal: string[] = []) =>
  runShadow({ learningApp: honoApp(learning), portalApp: honoApp(portal), scripts: {}, table: null })

/** 道具だけを見る影の根（app はどちらも経路を 1 つだけ持つ小さい物）。 */
const toolsOnly = (scripts: Record<string, string>, table: string | Json | null, nested: Record<string, string> = {}) =>
  runShadow({
    learningApp: honoApp([`app.get('/api/health', (c) => c.json({ ok: true }))`]),
    portalApp: honoApp([`app.get('/api/portal-health', (c) => c.json({ ok: true }))`]),
    scripts,
    nested,
    table,
  })

const toolNames = (r: ListRun) => toolsOf(r).map((t) => t.name).sort()
const routeKeys = (r: ListRun) => routesOf(r).map(routeKey).sort()
const count = <T>(xs: T[], x: T) => xs.filter((y) => y === x).length

let real: ListRun | undefined
const realRun = () => (real ??= runReal())

describe('UC-034 学び側とまなびばの経路と作り手と運用の道具を入口の一覧に出す', () => {
  describe('app に登録された経路を、中継ぎを除いて経路の入口として出す（REQ-585）', () => {
    // @covers REQ-585#contract-routes-listed
    it('今のリポジトリで、確定した契約の受ける側の http の操作の method と path が、どれも経路の入口の行として出る', () => {
      const r = realRun()
      expectListed(r, expect)
      const listed = new Set(routeKeys(r))
      const wires = fixedInboundWires()
      expect(wires.length, '確定した契約に受ける側の http の操作が無い（仕込みの確かめ）').toBeGreaterThan(0)
      const missing = wires.filter((w) => !listed.has(routeKey(w))).map((w) => `${w.uc} ${w.operation}: ${routeKey(w)}`)
      expect(missing, `一覧に出ていない経路:\n${tailOf(r)}`).toEqual([])
    })

    // @covers REQ-585#both-apps-routes
    it('学び側とまなびばの両方の app の登録が、それぞれ経路の入口として出る', () => {
      const r = appsOnly([`app.get('/api/learning-only', (c) => c.text('l'))`], [`app.post('/api/portal-only', (c) => c.text('p'))`])
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['GET /api/learning-only', 'POST /api/portal-only'])
    })

    // @covers REQ-585#load-output-not-in-list
    it('app の読み込みの途中で標準出力に何か書かれても、一覧の行に混ざらない', () => {
      const r = appsOnly(
        [`console.log('学び側の app の読み込みの途中の出力')`, `app.get('/api/learning-only', (c) => c.text('l'))`],
        [`console.log('まなびばの app の読み込みの途中の出力')`, `app.post('/api/portal-only', (c) => c.text('p'))`],
      )
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['GET /api/learning-only', 'POST /api/portal-only'])
      expect(r.stdout, '読み込みの途中の出力が一覧に混ざった').not.toContain('読み込みの途中の出力')
    })

    // @covers REQ-585#method-per-registration
    it('同じ path に method の違う登録があれば、method ごとに 1 行ずつ出る', () => {
      const r = appsOnly([
        `app.get('/api/items', (c) => c.text('g'))`,
        `app.post('/api/items', (c) => c.text('p'))`,
        `app.delete('/api/items', (c) => c.text('d'))`,
      ])
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['DELETE /api/items', 'GET /api/items', 'POST /api/items'])
    })

    // @covers REQ-585#params-in-braces
    it('パラメーターを持つ path は、パラメーターを {名前} と書いて出る（パラメーターが 1 つ・2 つ）', () => {
      const r = appsOnly([
        `app.get('/api/topics/:id', (c) => c.text('t'))`,
        `app.put('/api/members/:accountId/learnings/:learningKey', (c) => c.text('m'))`,
      ])
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['GET /api/topics/{id}', 'PUT /api/members/{accountId}/learnings/{learningKey}'])
    })

    // @covers REQ-585#param-pattern-dropped
    it('正規表現つきのパラメーター（正規表現の中に { } を含む物を含む）は、正規表現を除いて {名前} と書いて出る（場合ごと）', () => {
      const r = appsOnly([
        `app.get('/api/plain/:id{[0-9]+}', (c) => c.text('p'))`,
        `app.get('/api/braced/:id{[0-9]{2}}', (c) => c.text('b'))`,
        `app.get('/api/two/:year{[0-9]{4}}/:no{[0-9]{1,3}}', (c) => c.text('t'))`,
      ])
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['GET /api/braced/{id}', 'GET /api/plain/{id}', 'GET /api/two/{year}/{no}'])
    })

    // @covers REQ-585#middleware-excluded
    it('どの method にも立つ中継ぎの登録（全部の path・一部の path に掛ける物）は、行として出ない', () => {
      const r = appsOnly(
        [
          `app.use('*', async (_c, next) => { await next() })`,
          `app.use('/api/*', async (_c, next) => { await next() })`,
          `app.get('/api/health', (c) => c.json({ ok: true }))`,
        ],
        [`app.use('*', async (_c, next) => { await next() })`, `app.get('/api/me', (c) => c.text('me'))`],
      )
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['GET /api/health', 'GET /api/me'])
    })
  })

  describe('道具の置き場の道具を、ファイル名か名前の表の名前で道具の入口として出す（REQ-586）', () => {
    // @covers REQ-586#tools-listed
    it('今のリポジトリで、直下のソースのファイルは表に無ければファイル名から導いた名前で、表に挙げたファイルは表の名前で、どれも出る', () => {
      const r = realRun()
      expectListed(r, expect)
      const table = existsSync(join(ROOT, TABLE)) ? (JSON.parse(readFileSync(join(ROOT, TABLE), 'utf8')) as Record<string, string[]>) : {}
      const exts = new Set(sourceExtensions())
      const expected = new Set<string>()
      for (const name of readdirSync(join(ROOT, 'scripts'))) {
        if (statSync(join(ROOT, 'scripts', name)).isDirectory() || !exts.has(extname(name))) continue
        if (!(tableKey(name) in table)) expected.add(camelName(name))
      }
      for (const names of Object.values(table)) for (const n of names) expected.add(n)
      expect(new Set(toolNames(r)), tailOf(r)).toEqual(expected)
    })

    // @covers REQ-586#file-name-camel-case
    it('直下のソースのファイルは、拡張子を除き _ と - の区切りを camelCase にした名前で出る（拡張子の違うファイルを含む）', () => {
      const r = toolsOnly({ 'check_seed_twice.py': '', 'deploy-the-pages.sh': '', 'audit_fixtures_now.mjs': '', 'render_one.ts': '' }, null)
      expectListed(r, expect)
      expect(toolNames(r)).toEqual(['auditFixturesNow', 'checkSeedTwice', 'deployThePages', 'listEntries', 'renderOne'].sort())
    })

    // @covers REQ-586#non-source-files-not-listed
    it('直下のソースでないファイル（データ・文書・名前の表自身）と、表に挙げていない直下でないファイルは出ない', () => {
      const r = toolsOnly(
        { 'run_me.py': '', 'pages_data.json': '{}', 'notes.md': '# 覚え書き', 'words.txt': 'x' },
        {},
        { 'uc034_sub/helper_tool.py': '' },
      )
      expectListed(r, expect)
      expect(toolNames(r)).toEqual(['listEntries', 'runMe'])
    })

    // @covers REQ-586#table-names-only
    it('表に挙げた直下のファイルは、表の名前だけ（複数なら全部）で出て、ファイル名から導いた名前では出ない', () => {
      const r = toolsOnly(
        { 'odd_named_tool.py': '', 'single_tool.sh': '', 'plain_tool.py': '' },
        { [tableKey('odd_named_tool.py')]: ['renderSomething', 'checkSomething'], [tableKey('single_tool.sh')]: ['otherName'] },
      )
      expectListed(r, expect)
      expect(toolNames(r)).toEqual(['checkSomething', 'listEntries', 'otherName', 'plainTool', 'renderSomething'].sort())
    })

    // @covers REQ-586#table-nested-file
    it('表に挙げた直下でないファイルは、表の名前で出る', () => {
      const r = toolsOnly({ 'plain_tool.py': '' }, { [tableKey('uc034_sub/main.ts')]: ['answerSomething'] }, { 'uc034_sub/main.ts': '' })
      expectListed(r, expect)
      expect(toolNames(r)).toEqual(['answerSomething', 'listEntries', 'plainTool'])
    })

    // @covers REQ-586#table-key-other-spelling
    it('表の鍵が同じファイルを別の書き方の相対パス（./ で始まる・.. を含む）で指しても、そのファイルは表の名前だけで出る（場合ごと）', () => {
      for (const [label, key, nested] of [
        ['./ で始まる', './odd_named_tool.py', {}],
        ['.. を含む', 'uc034_sub/../odd_named_tool.py', { 'uc034_sub/keep.txt': '' }],
      ] as const) {
        const r = toolsOnly({ 'odd_named_tool.py': '', 'plain_tool.py': '' }, { [key]: ['renderSomething'] }, { ...nested })
        try {
          expectListed(r, expect)
          expect(toolNames(r)).toEqual(['listEntries', 'plainTool', 'renderSomething'])
        } catch (e) {
          throw new Error(`${label}: ${(e as Error).message}`)
        }
      }
    })

    // @covers REQ-586#no-table-file-names
    it('名前の表が無いときは、直下のソースのファイルが全部ファイル名から導いた名前で出る', () => {
      const r = toolsOnly({ 'first_tool.py': '', 'second-tool.sh': '' }, null)
      expectListed(r, expect)
      expect(toolNames(r)).toEqual(['firstTool', 'listEntries', 'secondTool'])
    })
  })

  describe('同じ入口を 2 回以上出さない（REQ-587）', () => {
    // @covers REQ-587#real-no-duplicates
    it('今のリポジトリの一覧に、同じ経路も同じ道具の名前も 2 回出ない', () => {
      const r = realRun()
      expectListed(r, expect)
      const routes = routeKeys(r)
      const tools = toolNames(r)
      expect(routes.filter((k) => count(routes, k) > 1), tailOf(r)).toEqual([])
      expect(tools.filter((n) => count(tools, n) > 1), tailOf(r)).toEqual([])
    })

    // @covers REQ-587#same-route-registered-twice
    it('1 つの app に同じ method と path の登録が 2 つあっても、1 行だけ出る', () => {
      const r = appsOnly([`app.get('/api/twice', (c) => c.text('1'))`, `app.get('/api/twice', (c) => c.text('2'))`])
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['GET /api/twice'])
    })

    // @covers REQ-587#same-route-in-both-apps
    it('学び側とまなびばの app に同じ method と path の登録があっても、1 行だけ出る', () => {
      const r = appsOnly([`app.get('/api/health', (c) => c.json({ ok: true }))`], [`app.get('/api/health', (c) => c.json({ ok: true }))`])
      expectListed(r, expect)
      expect(routeKeys(r)).toEqual(['GET /api/health'])
    })

    // @covers REQ-587#files-same-name
    it('拡張子だけが違う 2 つのファイル、区切りの書き方だけが違う 2 つのファイルが同じ名前になっても、1 行だけ出る', () => {
      const r = toolsOnly({ 'check_thing.py': '', 'check_thing.sh': '', 'deploy_site.sh': '', 'deploy-site.py': '' }, null)
      expectListed(r, expect)
      expect(toolNames(r)).toEqual(['checkThing', 'deploySite', 'listEntries'])
    })

    // @covers REQ-587#table-name-equals-file-name
    it('表の名前が、表に無いほかのファイルから導いた名前と同じでも、1 行だけ出る', () => {
      const r = toolsOnly({ 'odd_named_tool.py': '', 'shared_name.py': '' }, { [tableKey('odd_named_tool.py')]: ['sharedName'] })
      expectListed(r, expect)
      expect(toolNames(r)).toEqual(['listEntries', 'sharedName'])
    })
  })

  describe('名前の表が読めないか、表に挙げたファイルが無ければ、入口を 1 件も出さずに断る（REQ-588）', () => {
    // @covers REQ-588#table-not-json
    it('名前の表が JSON として読めないと、INVALID_INPUT で断り、入口を 1 件も出さない', () => {
      expectRefused(toolsOnly({ 'plain_tool.py': '' }, '{ "plain_tool.py": ['), 'INVALID_INPUT', expect)
    })

    // @covers REQ-588#table-not-shape
    it('名前の表が表の形でない（最上位が配列・名前の並びが配列でない・名前が文字列でない）と、INVALID_INPUT で断り、入口を 1 件も出さない（場合ごと）', () => {
      for (const [label, table] of [
        ['最上位が配列', JSON.stringify([{ [tableKey('plain_tool.py')]: ['plainName'] }])],
        ['名前の並びが配列でない', JSON.stringify({ [tableKey('plain_tool.py')]: 'plainName' })],
        ['名前が文字列でない', JSON.stringify({ [tableKey('plain_tool.py')]: [1] })],
      ] as const) {
        const r = toolsOnly({ 'plain_tool.py': '' }, table)
        try {
          expectRefused(r, 'INVALID_INPUT', expect)
        } catch (e) {
          throw new Error(`${label}: ${(e as Error).message}`)
        }
      }
    })

    // @covers REQ-588#listed-file-missing
    it('名前の表に挙げたファイルが無い（直下・直下でない）と、NOT_FOUND で断り、入口を 1 件も出さない（場合ごと）', () => {
      for (const [label, key] of [
        ['直下', tableKey('no_such_tool.py')],
        ['直下でない', tableKey('uc034_sub/no_such_main.ts')],
      ] as const) {
        const r = toolsOnly({ 'plain_tool.py': '' }, { [key]: ['missingName'] })
        try {
          expectRefused(r, 'NOT_FOUND', expect)
        } catch (e) {
          throw new Error(`${label}: ${(e as Error).message}`)
        }
      }
    })

    // @covers REQ-588#shape-before-missing-file
    it('名前の表が表の形でなく、無いファイルも挙げていると、INVALID_INPUT で断る', () => {
      const r = toolsOnly({ 'plain_tool.py': '' }, { [tableKey('no_such_tool.py')]: 'missingName' })
      expectRefused(r, 'INVALID_INPUT', expect)
    })
  })

  describe('学び側かまなびばの app を読み込めなければ、入口を 1 件も出さずに断る（REQ-589）', () => {
    // @covers REQ-589#learning-app-unloadable
    it('学び側の app を読み込めないと、INTERNAL で断り、入口を 1 件も出さない', () => {
      const r = runShadow({ learningApp: throwingApp, portalApp: honoApp([`app.get('/api/me', (c) => c.text('me'))`]), scripts: { 'plain_tool.py': '' }, table: null })
      expectRefused(r, 'INTERNAL', expect)
    })

    // @covers REQ-589#portal-app-unloadable
    it('まなびばの app を読み込めないと、INTERNAL で断り、入口を 1 件も出さない', () => {
      const r = runShadow({ learningApp: honoApp([`app.get('/api/health', (c) => c.json({ ok: true }))`]), portalApp: throwingApp, scripts: { 'plain_tool.py': '' }, table: null })
      expectRefused(r, 'INTERNAL', expect)
    })

    // @covers REQ-589#missing-file-before-app-unloadable
    it('名前の表に挙げたファイルが無く、app も読み込めないと、NOT_FOUND で断る', () => {
      const r = runShadow({
        learningApp: throwingApp,
        portalApp: throwingApp,
        scripts: { 'plain_tool.py': '' },
        table: { [tableKey('no_such_tool.py')]: ['missingName'] },
      })
      expectRefused(r, 'NOT_FOUND', expect)
    })
  })
})

