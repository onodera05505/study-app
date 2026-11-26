/**
 * UC-039 の受け持ち（本番の準備と保守の道具 11 本。入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行:
 * 操作名を snake_case にした `scripts/<名前>.sh` か `.py`）。request の各欄は同じ名前の引数（契約の先頭の決まり:
 * 学びは第 1 引数、d1Migrations の mode は第 2 引数、targets の what と key は第 1・第 2 引数、extractUserData の backup は第 1 引数、
 * ほかは `--名前`（dryRun は --dry-run））。応答は終了の状態（契約の exitCode）。道具は断りの種類の名前を出さない（errors: []）。
 *
 * 囲いは UC-039 のテストの土台（tests/server/UC-039_fixture.local.ts の shadow39・runTool）をそのまま使う: 影の根、偽の配備の道具、
 * 保存先の名前ごとの偽の保存先、外への接続と本体のチェックアウトへの書き込みを断つ OS の囲い。本番・外の相手には届かない。
 * 前提（例の名前ごと。どれも ok）:
 * - bootstrapPersonal（fe）: 配信先は無い
 * - finishRemote（ip）: 後半が回す各段の道具（別の契約が形を持つ）は、呼ばれたことを記録して 0 で返す包み
 * - alignAppSettings（ap・手元）: 手元の ap の保存先に模試の設定の行がある
 * - backupD1（ip）: 本番の保存先は空
 * - d1Migrations（ip・check・手元）: 手元の保存先に構造の変更がすべて当たっている
 * - extractUserData: 控え（backups/ip.sql）と投入（data/ip/seed.sql）に、論点 1 つと利用者 1 人と進捗 1 行
 * - portalMigrateAccounts（試すだけ・手元）: 手元の学びの保存先とまなびばの保存先は空
 * - buildPortal: リポジトリの登録簿と配備先の一覧のまま
 * - setSsoSecret: 手元に偽の共有秘密を置く
 * - checkSsoProdSmoke: ok は、まなびばと学びの代わりの相手（tests/server/UC-039_counterparts.ts。本物の app を手元の HTTPS の口で受ける）を立て、
 *   影の根の配備先の一覧をそこへ向け、手元の確かめの利用者を置いて回す。locationMissing は、配備先の一覧に場所の無い学び（zzz）を渡す。
 *   wrongAccount は、ok と同じ代わりの相手と確かめの利用者を置き、偽の配備の道具が決めたアカウントと違うアカウントを答える（world.whoami = other）
 *   ようにして回す（道具が断らずに進んでも、代わりの相手のほかには届かない）
 * - targets（keys）: リポジトリの登録簿のまま
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LEARNINGS, ROOT, placeFakeSsoSecret, learningDb, portalDb, runTool, shadow39, sql, removeShadows, type Run, type Shadow39, type World,
} from '../../../tests/server/UC-039_fixture.local'
import { defineHandler, Unanswerable, type Answer, type ExampleLine, type Operation } from '../kit/protocol'
import { toolAnswer } from '../kit/tool'
import { startCounterparts } from '../../../tests/server/UC-039_counterparts'
import { hashPassword } from '../../../src/server/lib/auth'

type Request = Record<string, unknown>

const flag = (name: string) => `--${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`
/** 契約の request を道具の引数にする（positional の欄を先に、その順で。ほかは --名前）。 */
function argumentsOf(request: Request | null, positional: string[]): string[] {
  const body = request ?? {}
  const out: string[] = []
  for (const key of positional) {
    const v = body[key]
    if (Array.isArray(v)) out.push(...v.map(String))
    else if (v !== undefined && v !== null) out.push(String(v))
  }
  for (const [key, v] of Object.entries(body)) {
    if (positional.includes(key) || v === undefined || v === null || v === false) continue
    if (v === true) out.push(flag(key))
    else out.push(flag(key), String(v))
  }
  return out
}

/** 囲いの記録は標準出力と標準エラーを合わせた文なので、断りの名前は最後の JSON の行（ToolError）から読む。 */
const answer = (r: Run): Answer => {
  for (const line of r.out.split('\n').reverse()) {
    try {
      const code = (JSON.parse(line) as { error?: { code?: unknown } })?.error?.code
      if (typeof code === 'string' && code !== '') return { error: code }
    } catch {
      // JSON の行でない
    }
  }
  return toolAnswer({ code: r.code, stdout: r.out, stderr: r.out }, (run) => ({ exitCode: run.code }))
}

const FINISH_STEPS = [
  'build_target_dataset.py', 'build_seed.py', 'check_seed.py', 'd1_migrations.sh', 'seed_remote.sh', 'deploy-pages.sh',
  'align_app_settings.sh', 'verify_seed_remote.py', 'extract_user_data.py', 'backup_d1.sh', 'check_render.sh', 'check_d1_rounds.sh',
]
const SCHEMA = () =>
  readdirSync(join(ROOT, 'migrations'))
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => readFileSync(join(ROOT, 'migrations', n), 'utf8').replace(/-->\s*statement-breakpoint/g, ''))
    .join('\n')
const SEED_IP = [
  `INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, '項目', '分野', 1, '大', 1, '中');`,
  `INSERT INTO topics (id, term, syllabus_item_id) VALUES (1, '論点一', 1);`,
].join('\n')

type Plan = {
  script: string
  positional: string[]
  shadow?: Parameters<typeof shadow39>[1]
  world?: World
  prepare?: (s: Shadow39, request: Request | null) => void
}

const PLANS: Record<string, Plan> = {
  bootstrapPersonal: { script: 'bootstrap_personal.sh', positional: ['learnings'] },
  finishRemote: { script: 'finish_remote.sh', positional: ['learning'], shadow: { wrap: Object.fromEntries(FINISH_STEPS.map((f) => [f, 0])) } },
  alignAppSettings: {
    script: 'align_app_settings.sh',
    positional: ['learning'],
    prepare: (s, req) => {
      const side = req?.local === true ? 'local' : 'remote'
      sql(learningDb(s, side, String(req?.learning)), "INSERT INTO app_settings (id, mock_size, mock_time_limit_sec) VALUES ('default', 1, 1);")
    },
  },
  backupD1: { script: 'backup_d1.sh', positional: ['learning'], world: { modes: { backup_d1: 'real' } } },
  d1Migrations: { script: 'd1_migrations.sh', positional: ['learning', 'mode'], world: { modes: { backup_d1: 'real' } } },
  extractUserData: {
    script: 'extract_user_data.py',
    positional: ['backup'],
    shadow: { seeds: { ip: SEED_IP } },
    prepare: (s, req) => {
      s.write(
        String(req?.backup),
        [
          'PRAGMA defer_foreign_keys=TRUE;',
          SCHEMA(),
          `INSERT INTO "syllabus_items" ("id","name","field","major_no","major","middle_no","middle") VALUES(1,'項目','分野',1,'大',1,'中');`,
          `INSERT INTO "topics" ("id","term","syllabus_item_id") VALUES(1,'論点一',1);`,
          `INSERT INTO "users" ("id","email","name","password_hash") VALUES('u1','u1@example.invalid','利用者一','x');`,
          `INSERT INTO "progress" ("user_id","topic_id","status") VALUES('u1',1,2);`,
        ].join('\n'),
      )
    },
  },
  portalMigrateAccounts: {
    script: 'portal_migrate_accounts.py',
    positional: [],
    prepare: (s, req) => {
      const side = req?.local === true ? 'local' : 'remote'
      for (const k of LEARNINGS) learningDb(s, side, k)
      portalDb(s, side)
    },
  },
  buildPortal: { script: 'build_portal.py', positional: [] },
  setSsoSecret: { script: 'set_sso_secret.sh', positional: [], prepare: (s) => placeFakeSsoSecret(s) },
  targets: { script: 'targets.py', positional: ['what', 'key'] },
}

function operation(name: string): Operation {
  return async (line: ExampleLine) => {
    if (line.case !== 'ok') throw new Unanswerable(`UC-039 ${line.operation} の例 ${line.case} の前提を知らない`)
    const plan = PLANS[name]
    const s = shadow39(`adapter-${name}`, plan.shadow ?? {})
    try {
      plan.prepare?.(s, line.request)
      return answer(await runTool(s, plan.script, argumentsOf(line.request, plan.positional), plan.world ?? {}))
    } finally {
      await removeShadows()
    }
  }
}

/** 本番の SSO の一巡を、代わりの相手に向けて回す（本番には届かない。道具は OS の囲いの中で、手元のほかへは出ない）。 */
const checkSsoProdSmoke: Operation = async (line: ExampleLine) => {
  if (!['ok', 'locationMissing', 'wrongAccount'].includes(line.case)) throw new Unanswerable(`UC-039 checkSsoProdSmoke の例 ${line.case} の前提を知らない`)
  const s = shadow39('adapter-smoke')
  try {
    const args = argumentsOf(line.request, ['learning'])
    if (line.case === 'locationMissing') return answer(await runTool(s, 'check_sso_prod_smoke.py', args, { applySeed: true }))
    const key = String(line.request?.learning ?? 'mkt')
    sql(learningDb(s, 'local', key), `INSERT INTO users (id, email, name, password_hash) VALUES ('ac', 'apicheck@example.com', 'ac', '${await hashPassword('apicheck-pass-1234')}');`)
    const c = await startCounterparts(s, key)
    try {
      const world: World = line.case === 'wrongAccount' ? { applySeed: true, whoami: 'other' } : { applySeed: true }
      return answer(await runTool(s, 'check_sso_prod_smoke.py', args, world, c.env))
    } finally {
      await c.close()
    }
  } finally {
    await removeShadows()
  }
}

export default defineHandler({
  uc: 'UC-039',
  // 土台が同期の子プロセス（spawnSync）で道具を回すので、受け渡し役の本体を止めないよう、自分のプロセスで 1 件ずつ回す
  ownProcess: true,
  operations: {
    ...Object.fromEntries(Object.keys(PLANS).map((name) => [name, operation(name)])),
    checkSsoProdSmoke,
  },
})
