import { existsSync, readdirSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  ENV_ACCOUNT_DIFFERS, FAKE_SSO_SECRET, LEARNINGS, REGISTRY, ROOT, SEVERAL_ACCOUNTS, crashed, dbFile, firstIndex, learningDb, pagesCalls, portalDb, projectOf, redact, removeShadows, rows,
  runTool, secretsPut, shadow39, sql, storageCalls, storageWrites, wranglerCalls, wrappedCalls, type LogEntry, type Run, type Shadow39, type World,
} from './UC-039_fixture.local'
import { setLocation, startCounterparts } from './UC-039_counterparts'
import { hashPassword } from '../../src/server/lib/auth'

/** UC-039 本番の準備と保守の道具（bootstrap_personal.sh ほか 11 本）の境界。
 *  仕込みは影の根と偽の配備の道具（UC-039_fixture.local.ts）。本番・外の相手・本体のチェックアウトには届かない。
 *  配備先の一覧の値は表示しないので、比べた結果は真偽と数だけで出し、失敗の文は redact を通す。 */

vi.setConfig({ testTimeout: 180_000 })
afterAll(removeShadows)

const ok = (r: Run) => {
  expect(crashed(r), redact(r.out)).toBe(false)
  expect(r.code, redact(r.out)).toBe(0)
}
const failed = (r: Run) => {
  expect(crashed(r), redact(r.out)).toBe(false)
  expect(r.code, redact(r.out)).not.toBe(0)
}
const has = (r: Run, text: string) => r.out.includes(text)
/** 出力が登録簿の学びをすべて挙げているか（指定できる学びを示したか）。 */
const listsLearnings = (r: Run) => LEARNINGS.every((k) => new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(r.out))
const nonEmptyLines = (r: Run) => r.out.split('\n').filter((l) => l.trim() !== '')
/** 本番の用意の外の道具（finish_remote.sh が回す道具）を包みにする。 */
const FINISH_STEPS = [
  'build_target_dataset.py', 'build_seed.py', 'check_seed.py', 'd1_migrations.sh', 'seed_remote.sh', 'deploy-pages.sh',
  'align_app_settings.sh', 'verify_seed_remote.py', 'extract_user_data.py', 'backup_d1.sh', 'check_render.sh', 'check_d1_rounds.sh',
]
/** 控えの道具を、UC-032 の土台の包みから写しの本物に戻す（控えの道具そのものを、写し元と同じ名前のファイルで回す）。 */
const realBackup = (s: Shadow39): Shadow39 => {
  if (existsSync(s.path('scripts/_real_backup_d1.sh'))) renameSync(s.path('scripts/_real_backup_d1.sh'), s.path('scripts/backup_d1.sh'))
  return s
}
const backupFiles = (s: Shadow39) => (existsSync(s.path('backups')) ? readdirSync(s.path('backups')).filter((n) => n.endsWith('.sql')) : [])
/** 学びの保存先に模試の設定の行を置く。 */
const appSettings = (file: string) => sql(file, "INSERT INTO app_settings (id, mock_size, mock_time_limit_sec) VALUES ('default', 1, 1);")
/** 手元の閉じた口（届かない回の場所。接続は断られる）。 */
const CLOSED_PORT = 'https://127.0.0.1:9'
const mockOf = (key: string) => ({ size: REGISTRY[key].mockSize as number, sec: (REGISTRY[key].mockMinutes as number) * 60 })
/** 配備の道具の呼び出しのうち、アカウントを照らす問い合わせ（whoami）と版の問い合わせのほかの物。 */
const wranglerBeyondCheck = (r: Run) => wranglerCalls(r).filter((a) => !['whoami', '--version', '-v', 'version'].includes(a[0]))

describe('UC-039 学びとまなびばを本番に用意して出し、本番の保存先を手入れする', () => {
  describe('本番の用意は、配信先が無ければ作り、構造の変更を当て、署名の秘密を新しい乱数で置き、登録の鍵は置かない（REQ-612）', () => {
    // @covers REQ-612#prepares-learning
    it('配信先の無い学びに、配信先を作り、本番の保存先に構造の変更を当て、署名の秘密を置く', async () => {
      const s = shadow39('612a')
      const r = await runTool(s, 'bootstrap_personal.sh', ['fe'])
      ok(r)
      const p = projectOf('fe')
      expect(pagesCalls(r).some((a) => a[1] === 'project' && a[2] === 'create' && a.includes(p.project!)), '配信先を作っていない').toBe(true)
      expect(storageCalls(r).some((a) => a[1] === 'migrations' && a[2] === 'apply' && a.includes(p.db!) && a.includes('--remote')), '本番の保存先に構造の変更を当てていない').toBe(true)
      expect((secretsPut(s).JWT_SECRET ?? []).length, '署名の秘密を置いていない').toBe(1)
    })
    // @covers REQ-612#existing-project-kept
    it('配信先が既にある学びには、配信先を作らない', async () => {
      const s = shadow39('612b')
      const r = await runTool(s, 'bootstrap_personal.sh', ['fe'], {}, { STUB_PROJECTS_EXIST: '1' })
      ok(r)
      expect(pagesCalls(r).some((a) => a[1] === 'project' && a[2] === 'create'), '既にある配信先を作った').toBe(false)
    })
    // @covers REQ-612#fresh-random-secret
    it('署名の秘密は回すたびに新しい乱数で、学びごとに別の値を置く', async () => {
      const s = shadow39('612c')
      ok(await runTool(s, 'bootstrap_personal.sh', ['fe', 'eng']))
      ok(await runTool(s, 'bootstrap_personal.sh', ['fe']))
      const values = secretsPut(s).JWT_SECRET ?? []
      expect(values.length).toBe(3)
      expect(new Set(values).size, '同じ値を置いた').toBe(3)
      for (const v of values) expect(v.length, '乱数にしては短い').toBeGreaterThanOrEqual(32)
    })
    // @covers REQ-612#no-signup-code
    it('登録の鍵（手元のファイルと配備先の一覧にある値）は配信先に置かない', async () => {
      const s = shadow39('612d')
      s.write('.env.fe', 'SIGNUP_CODE=uc039-fake-signup-code\n')
      const r = await runTool(s, 'bootstrap_personal.sh', ['fe'])
      ok(r)
      const put = secretsPut(s)
      expect(Object.keys(put).some((n) => /SIGNUP|CODE/i.test(n)), '登録の鍵の名前の秘密を置いた').toBe(false)
      const codes = ['uc039-fake-signup-code', String((projectOf('fe') as any).signup_code ?? '')].filter((v) => v.length >= 3)
      expect(Object.values(put).flat().some((v) => codes.includes(v)), '登録の鍵の値を置いた').toBe(false)
    })
  })

  describe('本番の用意で、アカウント違い・学びの指定なし・登録簿に無い学びは、どれも用意せずに失敗で終える（REQ-613）', () => {
    const nothingPrepared = (r: Run) => {
      failed(r)
      expect(pagesCalls(r).length, '配信先に触った').toBe(0)
      expect(storageCalls(r).length, '保存先に触った').toBe(0)
      expect(nonEmptyLines(r).length, '理由を示していない').toBeGreaterThan(0)
    }
    // @covers REQ-613#other-account
    it('ログイン中のアカウントが決めたアカウントと違えば、どの学びも用意しない', async () => {
      nothingPrepared(await runTool(shadow39('613a'), 'bootstrap_personal.sh', ['fe'], { whoami: 'other' }))
    })
    // @covers REQ-613#no-learning
    it('学びを 1 つも指定しなければ、何も用意しない', async () => {
      nothingPrepared(await runTool(shadow39('613b'), 'bootstrap_personal.sh', []))
    })
    // @covers REQ-613#unknown-learning-among
    it('登録簿に無い学びが 1 つでも混ざれば、ほかの学びも用意しない', async () => {
      nothingPrepared(await runTool(shadow39('613c'), 'bootstrap_personal.sh', ['fe', 'zzz']))
    })
    // @covers REQ-613#env-account-differs
    it('向け先のアカウントの環境変数が決めたアカウントと違えば、ログイン中の並びに決めたアカウントがあっても、照らすほかは何もせず、どの学びも用意しない', async () => {
      const r = await runTool(shadow39('613e'), 'bootstrap_personal.sh', ['fe'], ENV_ACCOUNT_DIFFERS)
      nothingPrepared(r)
      expect(wranglerBeyondCheck(r).length, `照らすほかに配備の道具を呼んだ: ${redact(r.out)}`).toBe(0)
    })
    // @covers REQ-613#several-accounts-listed
    it('ログイン中に 2 つのアカウントが見え、決めたアカウントが並びの 2 番目にあれば、合うとして学びの用意に進む', async () => {
      const r = await runTool(shadow39('613d'), 'bootstrap_personal.sh', ['fe'], {}, SEVERAL_ACCOUNTS)
      ok(r)
      const p = projectOf('fe')
      expect(storageCalls(r).some((a) => a[1] === 'migrations' && a[2] === 'apply' && a.includes(p.db!) && a.includes('--remote')), '学びの用意（本番の保存先に構造の変更を当てる）に進んでいない').toBe(true)
    })
  })

  describe('本番に出す後半は、組み立てと検査・構造の変更・投入・配信・記録の復元・模試の設定をこの順に回す（REQ-614）', () => {
    const order = (r: Run, restore: boolean) => {
      const at = (pred: (tool: string, a: string[]) => boolean) =>
        r.log.findIndex((e) => pred(e.tool, Array.isArray(e.argv) ? e.argv : [e.argv]))
      const steps = [
        at((t) => t === 'build_seed.py' || t === 'build_target_dataset.py'),
        at((t) => t === 'check_seed.py'),
        at((t, a) => (t === 'd1_migrations.sh' && a.includes('apply')) || (t !== 'd1_migrations.sh' && a[0] === 'd1' && a[1] === 'migrations' && a[2] === 'apply')),
        at((t) => t === 'seed_remote.sh'),
        at((t) => t === 'deploy-pages.sh'),
        ...(restore ? [at((t, a) => a[0] === 'd1' && a[1] === 'execute' && a.some((x) => x.includes('restore_ip.sql')))] : []),
        at((t) => t === 'align_app_settings.sh'),
      ]
      return steps
    }
    // @covers REQ-614#order-without-restore
    it('記録の控えが無ければ、復元を飛ばして残りをこの順に回す', async () => {
      const s = shadow39('614a', { wrap: Object.fromEntries(FINISH_STEPS.map((f) => [f, 0])) })
      const r = await runTool(s, 'finish_remote.sh', ['ip'])
      ok(r)
      const steps = order(r, false)
      expect(steps.every((i) => i >= 0), `回していない段がある: ${steps.join(',')}`).toBe(true)
      expect([...steps].sort((a, b) => a - b), `順が違う: ${steps.join(',')}`).toEqual(steps)
      expect(wranglerCalls(r).some((a) => a[1] === 'execute' && a.some((x) => x.includes('--file'))), '控えが無いのに復元した').toBe(false)
    })
    // @covers REQ-614#order-with-restore
    it('利用者の記録の控えがあれば、配信のあとに本番の保存先へ復元し、そのあと模試の設定を揃える', async () => {
      const s = shadow39('614b', { wrap: Object.fromEntries(FINISH_STEPS.map((f) => [f, 0])) })
      s.write('backups/restore_ip.sql', 'PRAGMA defer_foreign_keys=TRUE;\n')
      const r = await runTool(s, 'finish_remote.sh', ['ip'])
      ok(r)
      const steps = order(r, true)
      expect(steps.every((i) => i >= 0), `回していない段がある: ${steps.join(',')}`).toBe(true)
      expect([...steps].sort((a, b) => a - b), `順が違う: ${steps.join(',')}`).toEqual(steps)
    })
  })

  describe('後半・模試の設定・控え・構造の変更の道具に登録簿に無い学びを指定すると、保存先に触らずに指定できる学びを示して失敗で終える（REQ-615）', () => {
    const refused = (r: Run) => {
      failed(r)
      expect(storageCalls(r).length, '保存先に触った').toBe(0)
      expect(listsLearnings(r), `指定できる学びを示していない: ${redact(r.out)}`).toBe(true)
    }
    /** 控えの断り: 学びの指定の誤りを示すが、指定できる学びは並べない。 */
    const refusedWithoutList = (r: Run) => {
      failed(r)
      expect(storageCalls(r).length, '保存先に触った').toBe(0)
      expect(r.out.trim().length, '学びの指定の誤りを示していない').toBeGreaterThan(0)
      expect(listsLearnings(r), `指定できる学びを並べた: ${redact(r.out)}`).toBe(false)
    }
    // @covers REQ-615#finish-remote
    it('本番に出す後半', async () => {
      refused(await runTool(shadow39('615a', { wrap: Object.fromEntries(FINISH_STEPS.map((f) => [f, 0])) }), 'finish_remote.sh', ['zzz']))
    })
    // @covers REQ-615#align-app-settings
    it('模試の設定の揃え', async () => {
      refused(await runTool(shadow39('615b'), 'align_app_settings.sh', ['zzz']))
    })
    // @covers REQ-615#backup
    it('控えに登録簿に無い学びを渡すと、保存先に触らずに学びの指定の誤りを示して失敗で終える（指定できる学びは示さない）', async () => {
      refusedWithoutList(await runTool(realBackup(shadow39('615c')), 'backup_d1.sh', ['zzz'], { modes: { backup_d1: 'real' } }))
    })
    // @covers REQ-615#migrations
    it('構造の変更', async () => {
      refused(await runTool(shadow39('615d'), 'd1_migrations.sh', ['zzz', 'check']))
    })
  })

  describe('模試の設定を揃えると、本番ではアカウントを確かめ、問題数と制限時間を登録簿の値に書き換えて確かめる（REQ-616）', () => {
    // @covers REQ-616#other-account
    it('本番を指すときにアカウントが違えば、保存先に触らずに失敗で終える', async () => {
      const s = shadow39('616a')
      appSettings(learningDb(s, 'remote', 'ap'))
      const r = await runTool(s, 'align_app_settings.sh', ['ap'], { whoami: 'other' })
      failed(r)
      expect(storageCalls(r).length, '保存先に触った').toBe(0)
      expect(rows(dbFile(s, 'remote', projectOf('ap').db!), 'SELECT mock_size FROM app_settings')[0].mock_size).toBe(1)
    })
    // @covers REQ-616#remote-rewritten
    it('本番を指してアカウントが正しければ、本番の保存先の問題数と制限時間を登録簿の値にする', async () => {
      const s = shadow39('616b')
      const file = learningDb(s, 'remote', 'ap')
      appSettings(file)
      ok(await runTool(s, 'align_app_settings.sh', ['ap']))
      const row = rows(file, 'SELECT mock_size, mock_time_limit_sec FROM app_settings')[0]
      expect(row.mock_size).toBe(mockOf('ap').size)
      expect(row.mock_time_limit_sec).toBe(mockOf('ap').sec)
    })
    // @covers REQ-616#env-account-differs
    it('本番を指すときに、向け先のアカウントの環境変数が決めたアカウントと違えば、ログイン中の並びに決めたアカウントがあっても、照らすほかは何もせず、保存先に触らずに失敗で終える', async () => {
      const s = shadow39('616f')
      appSettings(learningDb(s, 'remote', 'ap'))
      const r = await runTool(s, 'align_app_settings.sh', ['ap'], ENV_ACCOUNT_DIFFERS)
      failed(r)
      expect(nonEmptyLines(r).length, '理由を示していない').toBeGreaterThan(0)
      expect(storageCalls(r).length, '保存先に触った').toBe(0)
      expect(wranglerBeyondCheck(r).length, `照らすほかに配備の道具を呼んだ: ${redact(r.out)}`).toBe(0)
      expect(rows(dbFile(s, 'remote', projectOf('ap').db!), 'SELECT mock_size FROM app_settings')[0].mock_size, '保存先の問題数を書き換えた').toBe(1)
    })
    // @covers REQ-616#several-accounts-listed
    it('本番を指すときに、ログイン中に 2 つのアカウントが見え、決めたアカウントが並びの 2 番目にあれば、合うとして保存先の書き換えに進む', async () => {
      const s = shadow39('616e')
      const file = learningDb(s, 'remote', 'ap')
      appSettings(file)
      ok(await runTool(s, 'align_app_settings.sh', ['ap'], {}, SEVERAL_ACCOUNTS))
      const row = rows(file, 'SELECT mock_size, mock_time_limit_sec FROM app_settings')[0]
      expect(row.mock_size, '本番の保存先の問題数を書き換えていない').toBe(mockOf('ap').size)
      expect(row.mock_time_limit_sec, '本番の保存先の制限時間を書き換えていない').toBe(mockOf('ap').sec)
    })
    // @covers REQ-616#local-rewritten
    it('手元を指すと、手元の保存先を登録簿の値にし、本番には触らない', async () => {
      const s = shadow39('616c')
      const local = learningDb(s, 'local', 'ap')
      const remote = learningDb(s, 'remote', 'ap')
      appSettings(local)
      appSettings(remote)
      ok(await runTool(s, 'align_app_settings.sh', ['ap', '--local']))
      expect(rows(local, 'SELECT mock_size FROM app_settings')[0].mock_size).toBe(mockOf('ap').size)
      expect(rows(remote, 'SELECT mock_size FROM app_settings')[0].mock_size).toBe(1)
    })
    // @covers REQ-616#not-applied-fails
    it('書き換えたあとの値が登録簿の値と違えば、失敗で終える', async () => {
      const s = shadow39('616d')
      const file = learningDb(s, 'local', 'ap')
      appSettings(file)
      // 書き換えを保存先が受け付けない（書き換えたあとに元の値へ戻す）
      sql(file, "CREATE TRIGGER uc039_revert AFTER UPDATE ON app_settings BEGIN UPDATE app_settings SET mock_size = 1, mock_time_limit_sec = 1 WHERE id = NEW.id; END;")
      failed(await runTool(s, 'align_app_settings.sh', ['ap', '--local']))
    })
  })

  describe('控えは、指定した学び（省略で全部）の本番の保存先を丸ごと書き出し、行が少なすぎれば警告する（REQ-617）', () => {
    // @covers REQ-617#one-learning
    it('学びを指定すると、その学びの本番の保存先を控えのファイルに書き出す', async () => {
      const s = realBackup(shadow39('617a'))
      const r = await runTool(s, 'backup_d1.sh', ['ip'], { modes: { backup_d1: 'real' } })
      ok(r)
      const exports = storageCalls(r).filter((a) => a[1] === 'export')
      expect(exports.length).toBe(1)
      expect(exports[0].includes(projectOf('ip').db!) && exports[0].includes('--remote'), '本番の ip の保存先を書き出していない').toBe(true)
      expect(backupFiles(s).length).toBe(1)
    })
    // @covers REQ-617#all-by-default
    it('学びを省略すると、登録簿の学び全部の本番の保存先を書き出す', async () => {
      const s = realBackup(shadow39('617b'))
      const r = await runTool(s, 'backup_d1.sh', [], { modes: { backup_d1: 'real' } })
      ok(r)
      const exported = new Set(storageCalls(r).filter((a) => a[1] === 'export' && a.includes('--remote')).map((a) => a[2]))
      const expected = LEARNINGS.map((k) => projectOf(k).db).filter((d): d is string => Boolean(d))
      expect(expected.every((d) => exported.has(d)), '書き出していない学びがある').toBe(true)
    })
    // @covers REQ-617#few-rows-warned
    it('控えの中の行が少なすぎれば警告を示す', async () => {
      const r = await runTool(realBackup(shadow39('617c')), 'backup_d1.sh', ['ip'], { modes: { backup_d1: 'real' } })
      ok(r)
      expect(has(r, '警告'), '警告を示していない').toBe(true)
    })
    // @covers REQ-617#enough-rows-not-warned
    it('控えの中の投入の文の行が道具の決めた数（100）ちょうどなら、警告を示さない', async () => {
      const s = realBackup(shadow39('617d'))
      const r = await runTool(s, 'backup_d1.sh', ['ip'], { modes: { backup_d1: 'real' } }, { STUB_EXPORT_ROWS: '100' })
      ok(r)
      expect(backupFiles(s).length, '控えのファイルを書いていない').toBe(1)
      const written = readFileSync(s.path(`backups/${backupFiles(s)[0]}`), 'utf8')
      expect(written.split('\n').filter((l) => /^\s*INSERT/i.test(l)).length, '仕込み: 控えの投入の文が 100 行でない').toBe(100)
      expect(has(r, '警告'), `警告を示した: ${redact(r.out)}`).toBe(false)
    })
  })

  describe('構造の変更を当てると、残りが無ければ何もせず、本番では控えを取ってから当て、残るか一覧が取れなければ失敗（REQ-618）', () => {
    // @covers REQ-618#nothing-pending
    it('当たっていない変更が無ければ、控えも適用もせずに成功で終える', async () => {
      const r = await runTool(shadow39('618a'), 'd1_migrations.sh', ['ip', 'apply'], { modes: { backup_d1: 'real' } })
      ok(r)
      expect(storageCalls(r).some((a) => a[1] === 'export' || (a[1] === 'migrations' && a[2] === 'apply')), '何かをした').toBe(false)
    })
    // @covers REQ-618#backup-before-apply
    it('本番に当たっていない変更があれば、控えを取ってから当て、残りが無くなれば成功で終える', async () => {
      const s = shadow39('618b', { remote: { applied: 10 } })
      const r = await runTool(s, 'd1_migrations.sh', ['ip', 'apply'], { modes: { backup_d1: 'real' } }, { STUB_APPLY_MIGRATIONS: '1' })
      ok(r)
      const calls = storageCalls(r)
      const exportAt = calls.findIndex((a) => a[1] === 'export' && a.includes('--remote'))
      const applyAt = calls.findIndex((a) => a[1] === 'migrations' && a[2] === 'apply' && a.includes('--remote'))
      expect(exportAt >= 0 && applyAt >= 0 && exportAt < applyAt, `控えのあとに当てていない: ${exportAt},${applyAt}`).toBe(true)
    })
    // @covers REQ-618#still-pending-fails
    it('当てたあとも当たっていない変更が残れば、失敗で終える', async () => {
      failed(await runTool(shadow39('618c', { remote: { applied: 10 } }), 'd1_migrations.sh', ['ip', 'apply'], { modes: { backup_d1: 'real' } }))
    })
    // @covers REQ-618#list-unavailable-fails
    it('当たっていない変更の一覧を確かめられなければ、失敗で終える', async () => {
      failed(await runTool(shadow39('618d'), 'd1_migrations.sh', ['ip', 'apply'], { migrationsFail: true, modes: { backup_d1: 'real' } }))
    })
  })

  describe('控えから利用者のデータを抜き出すと、利用者の表だけを外部キーの順に書き出し、投入に無い物を指す行を落として数を示す（REQ-619）', () => {
    const SCHEMA = readdirSync(join(ROOT, 'migrations'))
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .map((n) => readFileSync(join(ROOT, 'migrations', n), 'utf8').replace(/-->\s*statement-breakpoint/g, ''))
      .join('\n')
    const PQ = (id: string) =>
      `INSERT INTO "past_questions" ("id","exam","exam_label","number","text","choices","answer","citation") VALUES('${id}','r1','令和1年',1,'問','[]','ア','出典');`
    const extract = once(async () => {
      const s = shadow39('619')
      const backup = [
        'PRAGMA defer_foreign_keys=TRUE;',
        SCHEMA,
        `INSERT INTO "syllabus_items" ("id","name","field","major_no","major","middle_no","middle") VALUES(1,'項目','分野',1,'大',1,'中');`,
        `INSERT INTO "topics" ("id","term","syllabus_item_id") VALUES(1,'論点一',1);`,
        `INSERT INTO "topics" ("id","term","syllabus_item_id") VALUES(99,'消えた論点',1);`,
        PQ('q-kept'),
        PQ('q-gone'),
        `INSERT INTO "users" ("id","email","name","password_hash") VALUES('u1','u1@example.invalid','利用者一','x');`,
        `INSERT INTO "progress" ("user_id","topic_id","status") VALUES('u1',1,2);`,
        `INSERT INTO "progress" ("user_id","topic_id","status") VALUES('u1',99,2);`,
        `INSERT INTO "sessions" ("id","user_id","kind","status","question_count") VALUES('s1','u1','drill','finished',2);`,
        `INSERT INTO "session_questions" ("id","session_id","question_id","idx","snapshot") VALUES('sq1','s1','q-kept',0,'{}');`,
        `INSERT INTO "session_questions" ("id","session_id","question_id","idx","snapshot") VALUES('sq2','s1','q-gone',1,'{}');`,
      ].join('\n')
      s.write('backups/ip.sql', backup)
      s.write(
        'backups/seed_ip.sql',
        [
          `INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, '項目', '分野', 1, '大', 1, '中');`,
          `INSERT INTO topics (id, term, syllabus_item_id) VALUES (1, '論点一', 1);`,
          `INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, citation) VALUES ('q-kept', 'r1', '令和1年', 1, '問', '[]', 'ア', '出典');`,
        ].join('\n'),
      )
      const r = await runTool(s, 'extract_user_data.py', ['backups/ip.sql', '--seed', 'backups/seed_ip.sql', '--out', 'backups/restore_ip.sql'])
      const out = existsSync(s.path('backups/restore_ip.sql')) ? readFileSync(s.path('backups/restore_ip.sql'), 'utf8') : ''
      return { r, out, lines: out.split('\n').filter((l) => /^\s*INSERT/i.test(l)) }
    })
    const tableOf = (line: string) => /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i.exec(line)?.[1]
    /** 過去問の ID の形（<回>-q<番号>）でない ID の問題を指す受験の行だけを持つ控え。 */
    const extractOddId = once(async () => {
      const s = shadow39('619-odd')
      const backup = [
        'PRAGMA defer_foreign_keys=TRUE;',
        SCHEMA,
        `INSERT INTO "syllabus_items" ("id","name","field","major_no","major","middle_no","middle") VALUES(1,'項目','分野',1,'大',1,'中');`,
        `INSERT INTO "topics" ("id","term","syllabus_item_id") VALUES(1,'論点一',1);`,
        PQ('2024r06-q1'),
        PQ('legacy_question_9'),
        `INSERT INTO "users" ("id","email","name","password_hash") VALUES('u1','u1@example.invalid','利用者一','x');`,
        `INSERT INTO "sessions" ("id","user_id","kind","status","question_count") VALUES('s1','u1','drill','finished',2);`,
        `INSERT INTO "session_questions" ("id","session_id","question_id","idx","snapshot") VALUES('sq1','s1','2024r06-q1',0,'{}');`,
        `INSERT INTO "session_questions" ("id","session_id","question_id","idx","snapshot") VALUES('sq9','s1','legacy_question_9',1,'{}');`,
      ].join('\n')
      s.write('backups/ip.sql', backup)
      s.write(
        'backups/seed_ip.sql',
        [
          `INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, '項目', '分野', 1, '大', 1, '中');`,
          `INSERT INTO topics (id, term, syllabus_item_id) VALUES (1, '論点一', 1);`,
          `INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, citation) VALUES ('2024r06-q1', 'r1', '令和1年', 1, '問', '[]', 'ア', '出典');`,
        ].join('\n'),
      )
      const r = await runTool(s, 'extract_user_data.py', ['backups/ip.sql', '--seed', 'backups/seed_ip.sql', '--out', 'backups/restore_ip.sql'])
      const out = existsSync(s.path('backups/restore_ip.sql')) ? readFileSync(s.path('backups/restore_ip.sql'), 'utf8') : ''
      return { r, lines: out.split('\n').filter((l) => /^\s*INSERT/i.test(l)) }
    })
    // @covers REQ-619#user-tables-only
    it('投入で作れる表（論点・問題・シラバス）は書き出さず、利用者の表を書き出す', async () => {
      const { r, lines } = await extract()
      ok(r)
      const tables = new Set(lines.map(tableOf))
      for (const t of ['topics', 'past_questions', 'syllabus_items']) expect(tables.has(t), `${t} を書き出した`).toBe(false)
      for (const t of ['users', 'progress', 'sessions', 'session_questions']) expect(tables.has(t), `${t} を書き出していない`).toBe(true)
    })
    // @covers REQ-619#foreign-key-order
    it('参照される表を参照する表より先に書き出す（利用者 → 進捗・受験 → 受験の問題）', async () => {
      const { lines } = await extract()
      const first = (t: string) => lines.findIndex((l) => tableOf(l) === t)
      expect(first('users') < first('progress') && first('users') < first('sessions') && first('sessions') < first('session_questions'), '外部キーの順でない').toBe(true)
    })
    // @covers REQ-619#any-id-form-dropped
    it('過去問の ID の形でない ID で、渡した投入に無い問題を指す受験の行も落とし、落とした数に数える', async () => {
      const { r, lines } = await extractOddId()
      ok(r)
      expect(lines.some((l) => tableOf(l) === 'session_questions' && l.includes('legacy_question_9')), '形の違う ID の、投入に無い問題を指す行を落としていない').toBe(false)
      expect(lines.some((l) => tableOf(l) === 'session_questions' && l.includes('2024r06-q1')), 'ある問題を指す行まで落とした').toBe(true)
      expect(/落と[^\n]*session_questions\s*1/.test(r.out), `落とした数に数えていない: ${redact(r.out)}`).toBe(true)
    })

    // @covers REQ-619#dangling-dropped
    it('渡した投入に無い論点と問題を指す行は落とし、落とした数を示す', async () => {
      const { r, lines } = await extract()
      expect(lines.some((l) => tableOf(l) === 'progress' && /\b99\b/.test(l)), '無い論点を指す進捗を落としていない').toBe(false)
      expect(lines.some((l) => tableOf(l) === 'session_questions' && l.includes('q-gone')), '無い問題を指す行を落としていない').toBe(false)
      expect(lines.some((l) => tableOf(l) === 'session_questions' && l.includes('q-kept')), 'ある問題を指す行まで落とした').toBe(true)
      expect(/落と[^\n]*progress\s*1/.test(r.out) && /落と[^\n]*session_questions\s*1/.test(r.out), `落とした数を示していない: ${redact(r.out)}`).toBe(true)
    })
  })

  describe('まなびばへ移すと、同じメールを束ねて権限を付け、除くメールと既にある物を飛ばし、試すだけなら書き換えない（REQ-620）', () => {
    const prepare = (name: string) => {
      const s = shadow39(name)
      for (const k of LEARNINGS) learningDb(s, 'local', k)
      const user = (id: string, email: string) => `INSERT INTO users (id, email, name, password_hash) VALUES ('${id}', '${email}', '${id}', 'h-${id}');`
      sql(learningDb(s, 'local', 'ip'), user('ip1', 'a@example.invalid') + user('ip2', 'b@example.invalid') + user('ip3', 'skip@example.invalid'))
      sql(learningDb(s, 'local', 'mkt'), user('mk1', 'a@example.invalid') + user('mk2', 'c@example.invalid'))
      const portal = portalDb(s, 'local')
      sql(portal, "INSERT INTO accounts (id, email, name, password_hash) VALUES ('acc-c', 'c@example.invalid', 'C', 'hc'); INSERT INTO grants (account_id, learning) VALUES ('acc-c', 'mkt');")
      return { s, portal }
    }
    const args = (...more: string[]) => ['--admin', 'a@example.invalid', '--skip', 'skip@example.invalid', '--local', ...more]
    const migrated = once(async () => {
      const { s, portal } = prepare('620a')
      const r = await runTool(s, 'portal_migrate_accounts.py', args(), { applySeed: true })
      return { r, portal }
    })
    // @covers REQ-620#same-email-bundled
    it('2 つの学びにいる同じメールを 1 つのアカウントに束ね、両方の学びの権限を付ける', async () => {
      const { r, portal } = await migrated()
      ok(r)
      const a = rows(portal, "SELECT id FROM accounts WHERE email = 'a@example.invalid'")
      expect(a.length).toBe(1)
      const grants = rows(portal, `SELECT learning FROM grants WHERE account_id = '${a[0].id}'`).map((x) => x.learning)
      expect(grants.includes('ip') && grants.includes('mkt'), '束ねた学びの権限が無い').toBe(true)
      expect(rows(portal, "SELECT learning FROM grants g JOIN accounts a ON a.id = g.account_id WHERE a.email = 'b@example.invalid'").map((x) => x.learning)).toEqual(['ip'])
    })
    // @covers REQ-620#skip-email
    it('除くと指定したメールは移さない', async () => {
      const { portal } = await migrated()
      expect(rows(portal, "SELECT id FROM accounts WHERE email = 'skip@example.invalid'").length).toBe(0)
    })
    // @covers REQ-620#existing-kept
    it('既にあるアカウントと権限は飛ばす（作り直さず重ねない）', async () => {
      const { portal } = await migrated()
      const c = rows(portal, "SELECT id FROM accounts WHERE email = 'c@example.invalid'")
      expect(c.map((x) => x.id)).toEqual(['acc-c'])
      expect(rows(portal, "SELECT learning FROM grants WHERE account_id = 'acc-c'").length).toBe(1)
    })
    // @covers REQ-620#dry-run
    it('試すだけの指定では、投入の文を示すだけで何も書き換えない', async () => {
      const { s, portal } = prepare('620d')
      const r = await runTool(s, 'portal_migrate_accounts.py', args('--dry-run'), { applySeed: true })
      ok(r)
      expect(/INSERT/i.test(r.out), '投入の文を示していない').toBe(true)
      expect(rows(portal, 'SELECT email FROM accounts').length, '書き換えた').toBe(1)
      expect(storageWrites(r).length, '保存先に書いた').toBe(0)
    })
  })

  describe('まなびばを組み立てると、学びの一覧を組み、秘密を載せずに静的なファイルとともに書き出す（REQ-621）', () => {
    const built = once(async () => {
      const s = shadow39('621')
      s.write('.sso_secret.local', `${FAKE_SSO_SECRET}\n`)
      s.write('.env.ip', 'SIGNUP_CODE=uc039-fake-signup-code\n')
      const r = await runTool(s, 'build_portal.py', [])
      const dist = s.path('portal/dist')
      const files = existsSync(dist) ? readdirSync(dist) : []
      const text = [readFileSync(s.path('portal/src/learnings.json'), 'utf8'), ...files.map((f) => readFileSync(join(dist, f), 'utf8'))].join('\n')
      return { r, files, text, list: JSON.parse(readFileSync(s.path('portal/src/learnings.json'), 'utf8')) as unknown }
    })
    // @covers REQ-621#learning-list
    it('登録簿と配備先の一覧から学びの一覧を組み、静的なファイルとともに書き出す', async () => {
      const { r, files, list } = await built()
      ok(r)
      const keys = JSON.stringify(list)
      expect(['ip', 'mkt', 'eng'].every((k) => keys.includes(`"${k}"`)), '学びの一覧に学びが無い').toBe(true)
      expect(files.includes('index.html'), '静的なファイルを書き出していない').toBe(true)
    })
    // @covers REQ-621#no-secrets
    it('学びの一覧と書き出したファイルに、秘密（共有秘密・登録の鍵）を載せない', async () => {
      const { text } = await built()
      const secrets = [FAKE_SSO_SECRET, 'uc039-fake-signup-code', ...LEARNINGS.map((k) => String((projectOf(k) as any).signup_code ?? '')).filter((v) => v.length >= 3)]
      expect(secrets.some((v) => text.includes(v)), '秘密を載せた').toBe(false)
    })
  })

  describe('共有秘密は手元の値を学び全部の配信先に置き、無ければどこにも置かずに失敗で終える（REQ-622）', () => {
    // @covers REQ-622#all-learnings
    it('手元の共有秘密の値を、登録簿の学び全部の配信先に置く', async () => {
      const s = shadow39('622a')
      s.write('.sso_secret.local', `${FAKE_SSO_SECRET}\n`)
      const r = await runTool(s, 'set_sso_secret.sh', [])
      ok(r)
      const puts = pagesCalls(r).filter((a) => a[1] === 'secret' && a[2] === 'put' && a[3] === 'SSO_SECRET')
      const projects = new Set(puts.map((a) => a[a.indexOf('--project-name') + 1]))
      const expected = LEARNINGS.map((k) => projectOf(k).project).filter((p): p is string => Boolean(p))
      expect(expected.every((p) => projects.has(p)), '置いていない学びがある').toBe(true)
      expect((secretsPut(s).SSO_SECRET ?? []).every((v) => v === FAKE_SSO_SECRET), '手元の値と違う値を置いた').toBe(true)
    })
    // @covers REQ-622#no-local-secret
    it('手元に共有秘密の値が無ければ、どこにも置かずに失敗で終える', async () => {
      const r = await runTool(shadow39('622b'), 'set_sso_secret.sh', [])
      failed(r)
      expect(pagesCalls(r).filter((a) => a[1] === 'secret').length, '秘密を置いた').toBe(0)
    })
  })

  describe('本番の SSO の一巡は、一時のアカウントで確かめ、終わったら消し、食い違いがあれば失敗で終える（REQ-623）', () => {
    // 届かない回: 配備先の一覧のまなびばと学びの場所を手元の閉じた口に向ける（本番の場所は使わない）。確かめは必ず食い違う
    const smoke = once(async () => {
      const s = shadow39('623')
      sql(learningDb(s, 'local', 'mkt'), "INSERT INTO users (id, email, name, password_hash) VALUES ('ac', 'apicheck@example.com', 'ac', '100000:aabb:ccdd');")
      portalDb(s, 'remote')
      learningDb(s, 'remote', 'mkt')
      setLocation(s, '_portal', CLOSED_PORT)
      setLocation(s, 'mkt', CLOSED_PORT)
      const r = await runTool(s, 'check_sso_prod_smoke.py', ['mkt'], { applySeed: true })
      return { r }
    })
    // @covers REQ-623#unreachable-fails
    it('本番のまなびばに届かず確かめが食い違えば、失敗で終える', async () => {
      const { r } = await smoke()
      expect(r.code, redact(r.out)).not.toBe(0)
    })

    /** まなびばと学びの代わりの相手（本物の app を手元の HTTPS の口で受ける）に向けて回す。手元の確かめの利用者は道具が知るパスワードで置く。 */
    const matched = once(async () => {
      const s = shadow39('623-match')
      sql(learningDb(s, 'local', 'mkt'), `INSERT INTO users (id, email, name, password_hash) VALUES ('ac', 'apicheck@example.com', 'ac', '${await hashPassword('apicheck-pass-1234')}');`)
      const c = await startCounterparts(s, 'mkt')
      const portal = portalDb(s, 'remote')
      const learning = learningDb(s, 'remote', 'mkt')
      const usersBefore = rows(learning, 'SELECT id FROM users').map((x) => String(x.id)).sort()
      try {
        const r = await runTool(s, 'check_sso_prod_smoke.py', ['mkt'], { applySeed: true }, c.env)
        return { s, r, requests: [...c.requests], portal, learning, usersBefore }
      } finally {
        await c.close()
      }
    })
    /** 標準出力の ToolError の名前（無ければ undefined）。 */
    const refusalCode = (r: Run) => {
      for (const line of r.out.split('\n').reverse()) {
        try {
          const v = JSON.parse(line) as { error?: { code?: string } }
          if (v?.error?.code) return v.error.code
        } catch {
          // JSON の行でない
        }
      }
      return undefined
    }

    // @covers REQ-623#all-match-passes
    it('確かめがすべて一致すれば成功で終える（まなびばと学びの場所を配備先の一覧の代わりの相手に向けて起こす）', async () => {
      const { r } = await matched()
      ok(r)
    })

    // @covers REQ-623#location-from-tool
    it('写しの置き場に置いた道具は、その置き場の保存先の設定と配備の道具を使い、元のリポジトリの物を使わない', async () => {
      const { s, r } = await matched()
      const calls = r.log.filter((e) => e.tool === 'pinned' || e.tool === 'unpinned')
      expect(calls.length, '配備の道具を呼んでいない').toBeGreaterThan(0)
      expect(calls.filter((e) => e.tool !== 'pinned').length, '写しの置き場の配備の道具でない物を呼んだ').toBe(0)
      const root = realpathSync(s.root)
      expect(calls.filter((e) => !String(e.cwd ?? '').startsWith(root) && !String(e.cwd ?? '').startsWith(s.root)).map((e) => redact(String(e.cwd))), '写しの置き場の外で配備の道具を呼んだ').toEqual([])
    })

    // @covers REQ-623#temporary-account-removed
    it('確かめが終われば、作った一時のアカウントと学びに残った記録を消す', async () => {
      const { r, requests, portal, learning, usersBefore } = await matched()
      ok(r)
      const created = wranglerCalls(r).some((a) => a[1] === 'execute' && /INSERT/i.test(a.join(' ')) && /accounts/i.test(a.join(' ')))
      expect(created, '一時のアカウントを作っていない').toBe(true)
      expect(requests.some((x) => x.startsWith('learning→portal ')), '一時のアカウントで学びに入っていない（学び側の記録ができていない）').toBe(true)
      expect(rows(portal, 'SELECT id FROM accounts').length, '一時のアカウントが残った').toBe(0)
      const usersAfter = rows(learning, 'SELECT id FROM users').map((x) => String(x.id)).sort()
      expect(usersAfter, '学びに一時の利用者の記録が残った').toEqual(usersBefore)
    })

    // @covers REQ-623#portal-from-registry
    it('まなびばの場所は配備先の一覧のまなびばの項の場所で、一覧の場所を替えると要求の宛先が替わる', async () => {
      const { requests } = await matched()
      expect(requests.some((x) => x.startsWith('portal ')), '一覧に置いたまなびばの場所に要求が届いていない').toBe(true)
    })

    // @covers REQ-623#location-missing-refused
    it('配備先の一覧にまなびばか指定した学びの場所が無ければ、何もせずに NOT_FOUND で断る（場合ごと）', async () => {
      for (const key of ['_portal', 'mkt']) {
        const s = shadow39(`623-missing-${key.replace('_', '')}`)
        setLocation(s, key, null)
        const r = await runTool(s, 'check_sso_prod_smoke.py', ['mkt'], { applySeed: true })
        expect(r.code, `${key}: ${redact(r.out)}`).not.toBe(0)
        expect(refusalCode(r), `${key}: NOT_FOUND で断っていない: ${redact(r.out)}`).toBe('NOT_FOUND')
        expect(wranglerCalls(r).length, `${key}: 保存先に触った`).toBe(0)
      }
    })
  })

  describe('登録簿の値を問うと 1 行で答え、登録の鍵は答えず、有無を答え、登録簿に無い学びの値は失敗で終える（REQ-624）', () => {
    // @covers REQ-624#keys
    it('学びの一覧を 1 行で答える', async () => {
      const r = await runTool(shadow39('624a'), 'targets.py', ['keys'])
      ok(r)
      const lines = nonEmptyLines(r)
      expect(lines.length).toBe(1)
      expect(LEARNINGS.every((k) => lines[0].split(/\s+/).includes(k)), '一覧に無い学びがある').toBe(true)
    })
    // @covers REQ-624#value-of-learning
    it('指定した学びの名前・種類・保存先・配信先・場所を、それぞれ 1 行で答える', async () => {
      const s = shadow39('624b')
      const expected: Record<string, string | undefined> = {
        title: REGISTRY.ip.title,
        kind: REGISTRY.ip.kind,
        db: projectOf('ip').db,
        project: projectOf('ip').project,
        url: projectOf('ip').url,
      }
      for (const [what, value] of Object.entries(expected)) {
        const r = await runTool(s, 'targets.py', [what, 'ip'])
        ok(r)
        const lines = nonEmptyLines(r)
        expect(lines.length, what).toBe(1)
        expect(lines[0].trim() === value, `${what} の値が違う`).toBe(true)
      }
    })
    // @covers REQ-624#has
    it('登録簿にあるかを問われたら有無を答える', async () => {
      const s = shadow39('624c')
      const yes = await runTool(s, 'targets.py', ['has', 'ip'])
      const no = await runTool(s, 'targets.py', ['has', 'zzz'])
      ok(yes)
      expect(crashed(no)).toBe(false)
      expect(nonEmptyLines(yes).length).toBe(1)
      expect(nonEmptyLines(no).length).toBe(1)
      expect(nonEmptyLines(yes)[0] !== nonEmptyLines(no)[0], '有と無を同じに答えた').toBe(true)
    })
    // @covers REQ-624#unknown-learning-fails
    it('登録簿に無い学びの値を問われたら、理由を示して失敗で終える', async () => {
      const r = await runTool(shadow39('624d'), 'targets.py', ['title', 'zzz'])
      failed(r)
      expect(nonEmptyLines(r).length, '理由を示していない').toBeGreaterThan(0)
    })
    // @covers REQ-624#no-signup-code
    it('学び側での登録の鍵は答えない', async () => {
      const s = shadow39('624e')
      s.write('.env.ip', 'SIGNUP_CODE=uc039-fake-signup-code\n')
      const codes = ['uc039-fake-signup-code', String((projectOf('ip') as any).signup_code ?? '')].filter((v) => v.length >= 3)
      for (const what of ['code', 'signup_code', 'signupCode']) {
        const r = await runTool(s, 'targets.py', [what, 'ip'])
        expect(codes.some((c) => r.out.includes(c)), `${what} で登録の鍵を答えた`).toBe(false)
      }
    })
  })

  describe('本番に向けて回す後半・控え・構造の変更・アカウントを移す・共有秘密・SSO の一巡は、ログイン中のアカウントが違えば照らすほかは何もせずに失敗で終える（REQ-673）', () => {
    // ログイン中のアカウントは偽の配備の道具（UC-032 の土台の whoami）が答える。world.whoami が 'other' なら決めたアカウントと違う値、
    // 既定（'decided'）なら決めたアカウントを答える。値は表示しない
    const isWrangler = (e: LogEntry) => e.tool === 'pinned' || e.tool === 'unpinned'
    const argsOf = (e: LogEntry): string[] => (Array.isArray(e.argv) ? e.argv : [e.argv])
    /** 照らす問い合わせ（wrangler whoami）の最初の位置（無ければ -1）。 */
    const checkAt = (r: Run) => firstIndex(r, (e, a) => isWrangler(e) && a[0] === 'whoami')
    /** 照らす問い合わせのほかに、配備の道具・外への要求・包みにした段のどれかを呼んだ記録（照らす前の版の問い合わせは数えない。
     *  照らす問い合わせが無ければ、版の問い合わせはどれも照らす前の物として数えない）。 */
    const actions = (r: Run) => {
      const found = checkAt(r)
      const at = found < 0 ? r.log.length : found
      return r.log.filter((e, i) => {
        if (isWrangler(e)) {
          const a = argsOf(e)
          if (a[0] === 'whoami') return false
          if (i < at && (a[0] === '--version' || a[0] === '-v' || a[0] === 'version')) return false
          return true
        }
        return true
      })
    }
    const describeActions = (r: Run) => redact(actions(r).map((e) => `${e.tool} ${argsOf(e).slice(0, 3).join(' ')}`).join('\n'))
    /** アカウントが違えば、照らすほかは何もせずに理由を示して失敗で終えた。 */
    const refusedForAccount = (r: Run) => {
      failed(r)
      expect(actions(r).length, `照らすほかに何かをした:\n${describeActions(r)}`).toBe(0)
      expect(nonEmptyLines(r).length, '理由を示していない').toBeGreaterThan(0)
    }
    /** 照らしたあとで、pred に当たる次の段の呼び出しが起きた。 */
    const proceededAfterCheck = (r: Run, pred: (e: LogEntry, a: string[]) => boolean, what: string) => {
      const at = checkAt(r)
      expect(at, `アカウントを照らしていない: ${redact(r.out)}`).toBeGreaterThanOrEqual(0)
      const next = r.log.findIndex((e, i) => i > at && pred(e, argsOf(e)))
      expect(next, `照らしたあとで${what}に進んでいない: ${redact(r.out)}`).toBeGreaterThan(at)
    }
    const d1Call = (sub: string, more: (a: string[]) => boolean = () => true) => (e: LogEntry, a: string[]) => isWrangler(e) && a[0] === 'd1' && a[1] === sub && more(a)
    const toolCall = (files: string[]) => (e: LogEntry) => files.includes(e.tool)
    const wrapAll = () => ({ wrap: Object.fromEntries(FINISH_STEPS.map((f) => [f, 0])) })

    // @covers REQ-673#finish-remote-other-account
    it('本番に出す後半でアカウントが違えば、投入の組み立て・保存先・配信先のどれにも触らずに失敗で終える', async () => {
      const s = shadow39('673-finish-other', wrapAll())
      const r = await runTool(s, 'finish_remote.sh', ['ip'], { whoami: 'other' })
      refusedForAccount(r)
      for (const f of FINISH_STEPS) expect(wrappedCalls(r, f).length, `${f} を回した`).toBe(0)
      expect(storageCalls(r).length + pagesCalls(r).length, '保存先か配信先に触った').toBe(0)
    })
    // @covers REQ-673#finish-remote-account-matches
    it('本番に出す後半でアカウントが合えば、照らしたあとで後半の最初の段（投入の組み立て）に進む', async () => {
      const s = shadow39('673-finish-match', wrapAll())
      const r = await runTool(s, 'finish_remote.sh', ['ip'])
      proceededAfterCheck(r, toolCall(['build_target_dataset.py', 'build_seed.py']), '投入の組み立て')
    })

    // @covers REQ-673#backup-other-account
    it('控えでアカウントが違えば、保存先に触らず控えのファイルを書かずに失敗で終える', async () => {
      const s = realBackup(shadow39('673-backup-other'))
      const r = await runTool(s, 'backup_d1.sh', ['ip'], { modes: { backup_d1: 'real' }, whoami: 'other' })
      refusedForAccount(r)
      expect(storageCalls(r).length, '保存先に触った').toBe(0)
      expect(backupFiles(s).length, '控えのファイルを書いた').toBe(0)
    })
    // @covers REQ-673#backup-account-matches
    it('控えでアカウントが合えば、照らしたあとで保存先の書き出しに進む', async () => {
      const s = realBackup(shadow39('673-backup-match'))
      const r = await runTool(s, 'backup_d1.sh', ['ip'], { modes: { backup_d1: 'real' } })
      proceededAfterCheck(r, d1Call('export', (a) => a.includes('--remote')), '本番の保存先の書き出し')
    })

    // @covers REQ-673#migrations-other-account
    it('構造の変更で本番を指してアカウントが違えば、一覧の問い合わせも適用もせずに失敗で終える', async () => {
      const s = shadow39('673-mig-other', { remote: { applied: 10 } })
      const r = await runTool(s, 'd1_migrations.sh', ['ip', 'apply'], { modes: { backup_d1: 'real' }, whoami: 'other' })
      refusedForAccount(r)
      expect(storageCalls(r).length, '保存先に触った').toBe(0)
    })
    // @covers REQ-673#migrations-account-matches
    it('構造の変更で本番を指してアカウントが合えば、照らしたあとで一覧の問い合わせに進む', async () => {
      const r = await runTool(shadow39('673-mig-match'), 'd1_migrations.sh', ['ip', 'check'], { modes: { backup_d1: 'real' } })
      proceededAfterCheck(r, d1Call('migrations', (a) => a[2] === 'list' && a.includes('--remote')), '本番の一覧の問い合わせ')
    })
    // @covers REQ-673#migrations-local-not-checked
    it('構造の変更で手元を指すときは、アカウントを照らさずに一覧の問い合わせに進む', async () => {
      // ログイン中のアカウントは違う物にしておき、照らさずに進むことを見る
      const r = await runTool(shadow39('673-mig-local'), 'd1_migrations.sh', ['ip', 'check', '--local'], { modes: { backup_d1: 'real' }, whoami: 'other' })
      expect(checkAt(r), 'アカウントを照らした').toBe(-1)
      expect(storageCalls(r).some((a) => a[1] === 'migrations' && a[2] === 'list' && !a.includes('--remote')), `手元の一覧の問い合わせに進んでいない: ${redact(r.out)}`).toBe(true)
    })

    /** 学び側の利用者とまなびばの保存先を、指した側（本番・手元）に置く。 */
    const accountsWorld = (name: string, side: 'remote' | 'local') => {
      const s = shadow39(name)
      for (const k of LEARNINGS) learningDb(s, side, k)
      sql(learningDb(s, side, 'ip'), "INSERT INTO users (id, email, name, password_hash) VALUES ('ip1', 'a@example.invalid', 'ip1', 'h-ip1');")
      return { s, portal: portalDb(s, side) }
    }
    // @covers REQ-673#migrate-accounts-other-account
    it('アカウントを移す道具で本番を指してアカウントが違えば、まなびばの保存先に何も書かずに失敗で終える', async () => {
      const { s, portal } = accountsWorld('673-migrate-other', 'remote')
      const r = await runTool(s, 'portal_migrate_accounts.py', ['--admin', 'a@example.invalid'], { applySeed: true, whoami: 'other' })
      refusedForAccount(r)
      expect(storageWrites(r).length, '保存先に書いた').toBe(0)
      expect(rows(portal, 'SELECT id FROM accounts').length, 'まなびばにアカウントを書いた').toBe(0)
    })
    // @covers REQ-673#migrate-accounts-account-matches
    it('アカウントを移す道具で本番を指してアカウントが合えば、照らしたあとで移す段（保存先の読み書き）に進む', async () => {
      const { s } = accountsWorld('673-migrate-match', 'remote')
      const r = await runTool(s, 'portal_migrate_accounts.py', ['--admin', 'a@example.invalid'], { applySeed: true })
      proceededAfterCheck(r, (e, a) => isWrangler(e) && a[0] === 'd1' && a.includes('--remote'), '本番の保存先を読み書きする段')
    })
    // @covers REQ-673#migrate-accounts-local-not-checked
    it('アカウントを移す道具で手元を指すときは、アカウントを照らさずに移す段に進む', async () => {
      const { s } = accountsWorld('673-migrate-local', 'local')
      const r = await runTool(s, 'portal_migrate_accounts.py', ['--admin', 'a@example.invalid', '--local'], { applySeed: true, whoami: 'other' })
      expect(checkAt(r), 'アカウントを照らした').toBe(-1)
      expect(storageCalls(r).some((a) => !a.includes('--remote')), `手元の保存先を読み書きする段に進んでいない: ${redact(r.out)}`).toBe(true)
    })

    // @covers REQ-673#sso-secret-other-account
    it('共有秘密を置くときにアカウントが違えば、どの配信先にも置かずに失敗で終える', async () => {
      const s = shadow39('673-secret-other')
      s.write('.sso_secret.local', `${FAKE_SSO_SECRET}\n`)
      const r = await runTool(s, 'set_sso_secret.sh', [], { whoami: 'other' })
      refusedForAccount(r)
      expect(pagesCalls(r).filter((a) => a[1] === 'secret').length, '秘密を置いた').toBe(0)
      expect(Object.keys(secretsPut(s)).length, '秘密を置いた').toBe(0)
    })
    // @covers REQ-673#sso-secret-account-matches
    it('共有秘密を置くときにアカウントが合えば、照らしたあとで配信先に置く段に進む', async () => {
      const s = shadow39('673-secret-match')
      s.write('.sso_secret.local', `${FAKE_SSO_SECRET}\n`)
      const r = await runTool(s, 'set_sso_secret.sh', [])
      proceededAfterCheck(r, (e, a) => isWrangler(e) && a[0] === 'pages' && a[1] === 'secret' && a[2] === 'put', '配信先に置く段')
    })

    /** まなびばと学びの代わりの相手に向けて SSO の一巡を回す（手元の確かめの利用者を置く）。 */
    const smokeAgainstCounterparts = async (name: string, world: World, env: Record<string, string> = {}) => {
      const s = shadow39(name)
      sql(learningDb(s, 'local', 'mkt'), `INSERT INTO users (id, email, name, password_hash) VALUES ('ac', 'apicheck@example.com', 'ac', '${await hashPassword('apicheck-pass-1234')}');`)
      const c = await startCounterparts(s, 'mkt')
      const portal = portalDb(s, 'remote')
      try {
        const r = await runTool(s, 'check_sso_prod_smoke.py', ['mkt'], { applySeed: true, ...world }, { ...c.env, ...env })
        return { r, requests: [...c.requests], portal }
      } finally {
        await c.close()
      }
    }
    /** 標準出力の ToolError の名前（無ければ undefined）。 */
    const refusal = (r: Run) => {
      for (const line of r.out.split('\n').reverse()) {
        try {
          const v = JSON.parse(line) as { error?: { code?: string } }
          if (v?.error?.code) return v.error.code
        } catch {
          // JSON の行でない
        }
      }
      return undefined
    }
    // @covers REQ-673#sso-smoke-other-account
    it('本番の SSO の一巡でアカウントが違えば、一時のアカウントを作らず、まなびばにも学びにも要求を送らずに FORBIDDEN で断る', async () => {
      const { r, requests, portal } = await smokeAgainstCounterparts('673-smoke-other', { whoami: 'other' })
      expect(r.code, redact(r.out)).not.toBe(0)
      expect(refusal(r), `FORBIDDEN で断っていない: ${redact(r.out)}`).toBe('FORBIDDEN')
      expect(actions(r).length, `照らすほかに何かをした:\n${describeActions(r)}`).toBe(0)
      expect(requests.length, 'まなびばか学びに要求を送った').toBe(0)
      expect(rows(portal, 'SELECT id FROM accounts').length, '一時のアカウントを作った').toBe(0)
    })
    // @covers REQ-673#sso-smoke-account-matches
    it('本番の SSO の一巡でアカウントが合えば、照らしたあとで一時のアカウントを作る段に進む', async () => {
      const { r } = await smokeAgainstCounterparts('673-smoke-match', {})
      proceededAfterCheck(
        r,
        (e, a) => isWrangler(e) && a[0] === 'd1' && a[1] === 'execute' && /INSERT/i.test(a.join(' ')) && /accounts/i.test(a.join(' ')),
        '一時のアカウントを作る段',
      )
    })

    // @covers REQ-673#several-accounts-listed
    it('6 つの道具のそれぞれで、本番を指し、ログイン中に 2 つのアカウントが見え、決めたアカウントが並びの 2 番目にあれば、照らしたあとで次の段に進む', async () => {
      const env = SEVERAL_ACCOUNTS
      const runs: Array<{ tool: string; check: () => Promise<void> }> = [
        {
          tool: 'finish_remote.sh',
          check: async () => {
            const r = await runTool(shadow39('673-several-finish', wrapAll()), 'finish_remote.sh', ['ip'], {}, env)
            proceededAfterCheck(r, toolCall(['build_target_dataset.py', 'build_seed.py']), '投入の組み立て')
          },
        },
        {
          tool: 'backup_d1.sh',
          check: async () => {
            const r = await runTool(realBackup(shadow39('673-several-backup')), 'backup_d1.sh', ['ip'], { modes: { backup_d1: 'real' } }, env)
            proceededAfterCheck(r, d1Call('export', (a) => a.includes('--remote')), '本番の保存先の書き出し')
          },
        },
        {
          tool: 'd1_migrations.sh',
          check: async () => {
            const r = await runTool(shadow39('673-several-mig'), 'd1_migrations.sh', ['ip', 'check'], { modes: { backup_d1: 'real' } }, env)
            proceededAfterCheck(r, d1Call('migrations', (a) => a[2] === 'list' && a.includes('--remote')), '本番の一覧の問い合わせ')
          },
        },
        {
          tool: 'portal_migrate_accounts.py',
          check: async () => {
            const { s } = accountsWorld('673-several-migrate', 'remote')
            const r = await runTool(s, 'portal_migrate_accounts.py', ['--admin', 'a@example.invalid'], { applySeed: true }, env)
            proceededAfterCheck(r, (e, a) => isWrangler(e) && a[0] === 'd1' && a.includes('--remote'), '本番の保存先を読み書きする段')
          },
        },
        {
          tool: 'set_sso_secret.sh',
          check: async () => {
            const s = shadow39('673-several-secret')
            s.write('.sso_secret.local', `${FAKE_SSO_SECRET}\n`)
            const r = await runTool(s, 'set_sso_secret.sh', [], {}, env)
            proceededAfterCheck(r, (e, a) => isWrangler(e) && a[0] === 'pages' && a[1] === 'secret' && a[2] === 'put', '配信先に置く段')
          },
        },
        {
          tool: 'check_sso_prod_smoke.py',
          check: async () => {
            const { r } = await smokeAgainstCounterparts('673-several-smoke', {}, env)
            proceededAfterCheck(
              r,
              (e, a) => isWrangler(e) && a[0] === 'd1' && a[1] === 'execute' && /INSERT/i.test(a.join(' ')) && /accounts/i.test(a.join(' ')),
              '一時のアカウントを作る段',
            )
          },
        },
      ]
      // 道具ごとに確かめ、進まなかった道具をまとめて挙げる（1 つ目で止めず、6 つすべての結果を出す）
      const missed: string[] = []
      for (const { tool, check } of runs) {
        try {
          await check()
        } catch (e) {
          missed.push(`${tool}: ${redact(String((e as Error).message ?? e))}`)
        }
      }
      expect(missed, `照らしたあとで次の段に進まなかった道具:\n${missed.join('\n\n')}`).toEqual([])
    }, 900_000)

    // @covers REQ-673#env-account-differs
    it('6 つの道具のそれぞれで、本番を指し、向け先のアカウントの環境変数が決めたアカウントと違えば、ログイン中の並びに決めたアカウントがあっても、照らすほかは何もせずに理由を示して失敗で終える', async () => {
      const world = ENV_ACCOUNT_DIFFERS
      const runs: Array<{ tool: string; check: () => Promise<void> }> = [
        {
          tool: 'finish_remote.sh',
          check: async () => {
            const r = await runTool(shadow39('673-env-finish', wrapAll()), 'finish_remote.sh', ['ip'], world)
            refusedForAccount(r)
            for (const f of FINISH_STEPS) expect(wrappedCalls(r, f).length, `${f} を回した`).toBe(0)
          },
        },
        {
          tool: 'backup_d1.sh',
          check: async () => {
            const s = realBackup(shadow39('673-env-backup'))
            const r = await runTool(s, 'backup_d1.sh', ['ip'], { modes: { backup_d1: 'real' }, ...world })
            refusedForAccount(r)
            expect(backupFiles(s).length, '控えのファイルを書いた').toBe(0)
          },
        },
        {
          tool: 'd1_migrations.sh',
          check: async () => {
            const r = await runTool(shadow39('673-env-mig', { remote: { applied: 10 } }), 'd1_migrations.sh', ['ip', 'apply'], { modes: { backup_d1: 'real' }, ...world })
            refusedForAccount(r)
          },
        },
        {
          tool: 'portal_migrate_accounts.py',
          check: async () => {
            const { s, portal } = accountsWorld('673-env-migrate', 'remote')
            const r = await runTool(s, 'portal_migrate_accounts.py', ['--admin', 'a@example.invalid'], { applySeed: true, ...world })
            refusedForAccount(r)
            expect(rows(portal, 'SELECT id FROM accounts').length, 'まなびばにアカウントを書いた').toBe(0)
          },
        },
        {
          tool: 'set_sso_secret.sh',
          check: async () => {
            const s = shadow39('673-env-secret')
            s.write('.sso_secret.local', `${FAKE_SSO_SECRET}\n`)
            const r = await runTool(s, 'set_sso_secret.sh', [], world)
            refusedForAccount(r)
            expect(Object.keys(secretsPut(s)).length, '秘密を置いた').toBe(0)
          },
        },
        {
          tool: 'check_sso_prod_smoke.py',
          check: async () => {
            const { r, requests, portal } = await smokeAgainstCounterparts('673-env-smoke', world)
            refusedForAccount(r)
            expect(requests.length, 'まなびばか学びに要求を送った').toBe(0)
            expect(rows(portal, 'SELECT id FROM accounts').length, '一時のアカウントを作った').toBe(0)
          },
        },
      ]
      // 道具ごとに確かめ、止まらなかった道具をまとめて挙げる（1 つ目で止めず、6 つすべての結果を出す）
      const missed: string[] = []
      for (const { tool, check } of runs) {
        try {
          await check()
        } catch (e) {
          missed.push(`${tool}: ${redact(String((e as Error).message ?? e))}`)
        }
      }
      expect(missed, `照らすほかは何もせずに失敗で終えなかった道具:\n${missed.join('\n\n')}`).toEqual([])
    }, 900_000)
  })
})

/** 同じ仕込みで 1 回だけ回す。 */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => (p ??= make())
}
