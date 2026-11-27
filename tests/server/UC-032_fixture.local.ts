/** UC-032 の投入の手続き（`scripts/seed_remote.sh <学び> [--local]`）と学び側の配備の手続き（`scripts/deploy-pages.sh <学び>`）を、
 *  本番の保存先と配信先に届かない囲いの中で回す土台。
 *
 *  手続きは本物を回し、外の世界と、別の契約が形を持つ道具だけを偽物にする。リポジトリの写し（影の根）を一時の場所に作り、
 *  - 配備の道具（wrangler）: 影の根の node_modules（固定した版の位置）と PATH・npx の先に偽物を置く。呼ばれた引数を記録し、
 *    保存先は本番（`--remote` を付けたとき）と手元（付けないとき。本物の既定と同じ）の 2 つの SQLite で受ける。
 *    - `d1 migrations list`: 影の根の `migrations/*.sql` と、その保存先の `d1_migrations` の表を比べて、当たっていない構造の変更を本物と同じ形で示す
 *    - `d1 execute --command`: その保存先の SQLite で問い合わせを実行して、本物と同じ形（`--json` なら結果の配列）で返す
 *    - `d1 execute --file`: 投入として記録する。決めた回数だけ失敗する。`STUB_APPLY_FILE=1` のときはその保存先に当てる
 *    - `d1 export`: 控えとして記録する。決めたときは失敗する
 *    - `whoami`: 決めたアカウント・別のアカウント・確かめられない（失敗）のどれかを答える
 *    - `pages deploy`: 配信として記録する（配信はしない）
 *  - 組み立ての道具（vite）: 配信物の置き場を作るだけの偽物
 *  - curl: 外へ出さずに記録する
 *  - 別の契約が形を持つ道具（UC-027 の checkSeed・verifySeedRemote・checkRender、UC-032 の checkSource・checkRoadmapRegistry、
 *    文書の索引の門 `check_docs.py`、控えの道具 `backup_d1.sh`）: 影の根の写しを、呼ばれたことを記録して決めた終了の状態で返す
 *    包みに差し替える。`real` を選ぶと記録したうえで写しの本物に渡す
 *  子のプロセスでは外への通信を塞ぐ（届かない代理・無効のトークン・node の外向きの接続を断る前置き）。
 *
 *  影の根は、書き込みうる場所（scripts・src、配備では public・portal も）を写し、それ以外を元の場所へのリンクにする。
 *  `data` はディレクトリを作って学びごとにリンクし、投入を置く学びだけはディレクトリを作って中身をリンクし、投入（seed.sql）は写さずに仕込む。
 *  `backups` は空のディレクトリを作る（控えが元のリポジトリに書かれない）。
 *
 *  学ぶ順と回の置き場は DB のスキーマ（ADR-0004 の正本の migrations）の `topics.sort_order` と `topics.round`。 */

import { execFile } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 決めた配備のアカウント（正本は scripts/pages_projects.json の account_id）。 */
export const ACCOUNT = (JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as { account_id: string }).account_id
/** 決めたアカウントと違う、ログイン中のアカウント。 */
export const OTHER_ACCOUNT = '0123456789abcdef0123456789abcdef'

/** 登録簿（src/shared/targets.json）の学びの key。 */
export const REGISTRY_KEYS = Object.keys(JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Record<string, unknown>).filter(
  (k) => !k.startsWith('_'),
)

const PINNED_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
).packages['node_modules/wrangler']?.version ?? '0.0.0'

/** 構造の変更（migrations）のファイル名。名前の順が当てる順。 */
export const MIGRATIONS = readdirSync(join(ROOT, 'migrations'))
  .filter((n) => n.endsWith('.sql'))
  .sort()

/** 外向きの接続を断る前置き（NODE_OPTIONS の --require で子の node に入れる）。手元（loopback と UNIX ソケット）だけ通す。 */
const NET_GUARD = `const net = require('node:net')
const connect = net.Socket.prototype.connect
const LOCAL = new Set(['localhost', '127.0.0.1', '::1'])
net.Socket.prototype.connect = function (...args) {
  let o = args[0]
  if (Array.isArray(o)) o = o[0]
  let host = null
  let path = null
  if (o && typeof o === 'object') { host = o.host ?? (o.path ? null : 'localhost'); path = o.path ?? null }
  else if (typeof o === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost'
  else if (typeof o === 'string') path = o
  if (!path && host && !LOCAL.has(host)) throw new Error('テストの囲い: 外への接続を断った ' + host)
  return connect.apply(this, args)
}
`

/** 偽の wrangler。tool は 'pinned'（固定した版の位置に置いた物）か 'unpinned'（別の版）。 */
const wranglerStub = (tool: 'pinned' | 'unpinned') => `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const TOOL = ${JSON.stringify(tool)}
const VERSION = ${JSON.stringify(tool === 'pinned' ? PINNED_VERSION : '9.9.9-unpinned')}
const argv = process.argv.slice(2)
const side = argv.includes('--remote') ? 'remote' : 'local'
const entry = { tool: TOOL, cwd: process.cwd(), argv, side }
const log = () => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
const valueOf = (...names) => {
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) return argv[i + 1]
      if (argv[i].startsWith(n + '=')) return argv[i].slice(n.length + 1)
    }
  }
  return null
}
const dbPath = () => (side === 'remote' ? process.env.STUB_DB_REMOTE : process.env.STUB_DB_LOCAL)
const openDb = () => {
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(dbPath(), { enableForeignKeyConstraints: false })
}
/** 本物の wrangler の表の形で行を出す。 */
const table = (rows) => {
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const cells = rows.map((r) => cols.map((c) => String(r[c] === null ? 'null' : r[c])))
  const w = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)))
  const line = (l, m, r) => l + w.map((n) => '─'.repeat(n + 2)).join(m) + r
  console.log(line('┌', '┬', '┐'))
  console.log('│ ' + cols.map((c, i) => c.padEnd(w[i])).join(' │ ') + ' │')
  console.log(line('├', '┼', '┤'))
  for (const r of cells) console.log('│ ' + r.map((c, i) => c.padEnd(w[i])).join(' │ ') + ' │')
  console.log(line('└', '┴', '┘'))
}
/** 書いてよい場所（影の置き場）の中か。 */
const inSandbox = (p) => {
  try {
    let d = path.dirname(path.resolve(p))
    while (!fs.existsSync(d)) d = path.dirname(d)
    return fs.realpathSync(d).startsWith(fs.realpathSync(process.env.STUB_SANDBOX))
  } catch { return false }
}
if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
  log()
  console.log(VERSION)
  process.exit(0)
}
if (argv[0] === 'whoami') {
  log()
  const who = process.env.STUB_WHOAMI || 'decided'
  if (who === 'fail') {
    console.error('✘ [ERROR] Failed to retrieve your account information. You are not authenticated.')
    process.exit(1)
  }
  const id = who === 'other' ? ${JSON.stringify(OTHER_ACCOUNT)} : ${JSON.stringify(ACCOUNT)}
  console.log(' ⛅️ wrangler ' + VERSION)
  console.log('👋 You are logged in with an OAuth Token.')
  console.log('┌──────────────┬──────────────────────────────────┐')
  console.log('│ Account Name │ Account ID                       │')
  if (who === 'several') console.log('│ Other        │ ' + ${JSON.stringify(OTHER_ACCOUNT)} + ' │')
  console.log('│ Personal     │ ' + id + ' │')
  console.log('└──────────────┴──────────────────────────────────┘')
  process.exit(0)
}
if (argv[0] === 'pages' && argv[1] === 'deploy') {
  entry.deploy = true
  log()
  console.log('✨ Deployment complete! Take a peek over at https://stub.pages.dev')
  process.exit(0)
}
if (argv[0] === 'deploy' && argv.includes('--dry-run')) {
  log()
  const outdir = valueOf('--outdir')
  if (outdir && inSandbox(path.join(path.resolve(outdir), 'x'))) {
    fs.mkdirSync(path.resolve(outdir), { recursive: true })
    fs.writeFileSync(path.join(path.resolve(outdir), 'index.js'), 'export default { fetch() { return new Response("stub") } }')
  }
  console.log('--dry-run: exiting now.')
  process.exit(0)
}
if (argv[0] === 'd1' && argv[1] === 'migrations' && argv[2] === 'list') {
  log()
  if (process.env.STUB_MIGRATIONS_FAIL === '1') {
    console.error('✘ [ERROR] A request to the Cloudflare API failed. (テストの囲い: 構造の変更を確かめられない)')
    process.exit(1)
  }
  const files = fs.readdirSync(process.env.STUB_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()
  const db = openDb()
  let applied = []
  try { applied = db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name) } catch {}
  const pending = files.filter((f) => !applied.includes(f))
  console.log(' ⛅️ wrangler ' + VERSION)
  if (!pending.length) {
    console.log('✅ No migrations to apply!')
  } else {
    console.log('Migrations to be applied:')
    table(pending.map((name) => ({ Name: name })))
  }
  process.exit(0)
}
if (argv[0] === 'd1' && argv[1] === 'migrations') {
  // 構造の変更を当てる操作は記録だけして当てない
  log()
  process.exit(0)
}
if (argv[0] === 'd1' && argv[1] === 'execute') {
  const file = valueOf('--file')
  if (file) {
    entry.seed = { file: path.resolve(file) }
    log()
    const counter = path.join(process.env.STUB_SANDBOX, 'seed-attempts-' + side)
    const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1
    fs.writeFileSync(counter, String(n))
    if (n <= Number(process.env.STUB_SEED_FAILS || '0')) {
      console.error('✘ [ERROR] A request to the Cloudflare API failed. (テストの囲い: 投入の ' + n + ' 回目を失敗させた)')
      process.exit(1)
    }
    if (process.env.STUB_APPLY_FILE === '1') {
      const db = openDb()
      db.exec(fs.readFileSync(path.resolve(file), 'utf8'))
    }
    console.log('🚣 Executed queries')
    process.exit(0)
  }
  const sql = valueOf('--command')
  log()
  if (process.env.STUB_QUERY_FAIL === '1') {
    console.error('✘ [ERROR] A request to the Cloudflare API failed. (テストの囲い: 保存先を読めない)')
    process.exit(1)
  }
  let rows = []
  try {
    const db = openDb()
    const body = String(sql || '').trim().replace(/;\\s*$/, '')
    if (/^\\s*(select|with|pragma)\\b/i.test(body) && !body.includes(';')) rows = db.prepare(body).all()
    else db.exec(String(sql || ''))
  } catch (e) {
    console.error('✘ [ERROR] ' + e.message)
    process.exit(1)
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify([{ results: rows, success: true, meta: { served_by: 'stub', duration: 0, changes: 0, rows_read: rows.length } }], null, 2))
  } else {
    console.log('🚣 Executed 1 command')
    table(rows)
  }
  process.exit(0)
}
if (argv[0] === 'd1' && argv[1] === 'export') {
  entry.backup = true
  log()
  if (process.env.STUB_BACKUP_FAIL === '1') {
    console.error('✘ [ERROR] A request to the Cloudflare API failed. (テストの囲い: 控えを取れない)')
    process.exit(1)
  }
  const out = valueOf('--output', '-o')
  if (out) {
    if (!inSandbox(out)) {
      console.error('✘ テストの囲い: 影の置き場の外には書かない ' + out)
      process.exit(1)
    }
    fs.writeFileSync(path.resolve(out), '-- テストの囲いの控え\\n')
  }
  process.exit(0)
}
if (argv[0] === 'pages' && argv[1] === 'secret' && argv[2] === 'list') {
  log()
  console.log('SSO_SECRET: Value Encrypted')
  console.log('JWT_SECRET: Value Encrypted')
  process.exit(0)
}
log()
if (argv[0] === 'd1' && (argv[1] === 'list' || argv[1] === 'info')) console.log('[]')
process.exit(0)
`

/** 偽の vite。build で配信物の置き場を作り、public の中身と入口を置く。 */
const VITE_STUB = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: 'vite', cwd: process.cwd(), argv }) + '\\n')
if (argv[0] !== 'build') process.exit(0)
const at = argv.indexOf('--outDir')
const out = path.resolve(at >= 0 ? argv[at + 1] : 'dist')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
if (fs.existsSync('public')) fs.cpSync('public', out, { recursive: true })
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><title>stub</title>')
process.exit(0)
`

/** 偽の npx。今いる場所から上へ node_modules/.bin を探して見つかればそれを使い、無ければ wrangler は別の版の偽物、
 *  それ以外は本物の npx に渡す（本物の npx も外への接続は断たれている）。 */
const NPX_STUB = `#!/usr/bin/env bash
orig=("$@")
no_install=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-install|--no) no_install=1; shift ;;
    -y|--yes|-q|--quiet) shift ;;
    -p|--package) shift 2 ;;
    --package=*) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
cmd="$1"; shift
name="\${cmd%@*}"; [ -n "$name" ] || name="$cmd"
d="$PWD"
while :; do
  if [ -x "$d/node_modules/.bin/$name" ]; then exec "$d/node_modules/.bin/$name" "$@"; fi
  [ "$d" = / ] && break
  d="$(dirname "$d")"
done
case "$name" in
  wrangler*)
    if [ "$no_install" = 1 ]; then echo "npx: $name が入っていない" >&2; exit 1; fi
    exec "$STUB_UNPINNED" "$@" ;;
esac
exec "$REAL_NPX" "\${orig[@]}"
`

const CURL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "{\\"tool\\":\\"curl\\",\\"argv\\":\\"$*\\"}" >> "$STUB_LOG"
for a in "$@"; do [ "$a" = -w ] && { printf '200'; exit 0; }; done
printf '{}'
`

/** 差し替える道具（影の根の scripts の中のファイル名 → 記録の名前）。 */
export const TOOLS = {
  check_seed: 'check_seed.py',
  verify_seed_remote: 'verify_seed_remote.py',
  backup_d1: 'backup_d1.sh',
  check_source: 'check_source.py',
  check_roadmap_registry: 'check_roadmap_registry.py',
  check_docs: 'check_docs.py',
  check_render: 'check_render.sh',
} as const
export type Tool = keyof typeof TOOLS
/** 道具の振る舞い。pass は記録して 0、fail は記録して 1、real は記録して写しの本物に渡す。 */
export type ToolMode = 'pass' | 'fail' | 'real'

const pythonWrapper = (tool: Tool, real: string) => `#!/usr/bin/env python3
import json, os, sys
mode = os.environ.get(${JSON.stringify(`STUB_MODE_${tool}`)}, "pass")
with open(os.environ["STUB_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"tool": ${JSON.stringify(tool)}, "cwd": os.getcwd(), "argv": sys.argv[1:], "mode": mode}) + "\\n")
if mode == "real":
    real = os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(real)})
    os.execv(sys.executable, [sys.executable, real, *sys.argv[1:]])
if mode == "fail":
    print("テストの囲い: ${tool} が問題を示した", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
`

const bashWrapper = (tool: Tool, real: string) => `#!/usr/bin/env bash
mode="\${STUB_MODE_${tool}:-pass}"
args=""
for a in "$@"; do args="$args,\\"$a\\""; done
printf '{"tool":"${tool}","argv":[%s],"mode":"%s"}\\n' "\${args#,}" "$mode" >> "$STUB_LOG"
if [ "$mode" = real ]; then exec bash "$(dirname "$0")/${real}" "$@"; fi
if [ "$mode" = fail ]; then echo "テストの囲い: ${tool} が問題を示した" >&2; exit 1; fi
exit 0
`

/** 保存先の仕込み。applied は当てた構造の変更の数（既定は全部）。topics は論点の行（学ぶ順と回）。 */
export type StorageSpec = {
  applied?: number
  topics?: Array<{ sortOrder: number | null; round: string | null }>
}

/** migrations を先頭から applied 本当てた SQLite を作り、d1_migrations にその名前を記録し、論点の行を入れる。 */
export function makeStorage(file: string, spec: StorageSpec = {}): void {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
  const n = spec.applied ?? MIGRATIONS.length
  for (const name of MIGRATIONS.slice(0, n)) {
    db.exec(readFileSync(join(ROOT, 'migrations', name), 'utf8'))
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
  }
  const insert = db.prepare('INSERT INTO topics (term, syllabus_item_id, sort_order, round) VALUES (?, 1, ?, ?)')
  ;(spec.topics ?? []).forEach((t, i) => insert.run(`論点${i + 1}`, t.sortOrder, t.round))
  db.close()
}

export type ShadowOptions = {
  /** 写す場所。配備は public と portal も書くので写す。 */
  copy: Array<'scripts' | 'src' | 'public' | 'portal'>
  /** 中身をリンクしたディレクトリを作る学び（その学びの seed.sql は写さない）。 */
  ownData?: string[]
  /** 学び → 仕込む投入（seed.sql）の中身。 */
  seeds?: Record<string, string>
  remote?: StorageSpec
  local?: StorageSpec
}

export type Shadow = { dir: string; root: string; bin: string; log: string; guard: string; tmp: string }

const OMITTED = (name: string) =>
  ['node_modules', 'dist', '.wrangler', '.DS_Store', '.git', 'backups', 'data'].includes(name) || name.startsWith('.worker-build')

const writeExecutable = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

const shadows: string[] = []

/** リポジトリの影の根を作る。 */
export function makeShadow(name: string, opts: ShadowOptions): Shadow {
  const dir = mkdtempSync(join(tmpdir(), `uc032-${name}-`))
  shadows.push(dir)
  const root = join(dir, 'root')
  const bin = join(dir, 'bin')
  mkdirSync(root)
  mkdirSync(bin)
  const copied = new Set<string>(opts.copy)
  for (const entry of readdirSync(ROOT)) {
    if (OMITTED(entry)) continue
    const from = join(ROOT, entry)
    if (copied.has(entry)) {
      cpSync(from, join(root, entry), {
        recursive: true,
        filter: (src) => !/\/(node_modules|dist|\.wrangler)(\/|$)/.test(src.slice(from.length)),
      })
    } else symlinkSync(from, join(root, entry))
  }
  mkdirSync(join(root, 'backups'))
  // 学びの置き場: 学びごとにリンクし、投入を置く学びだけはディレクトリを作る
  const data = join(root, 'data')
  mkdirSync(data)
  const own = new Set([...(opts.ownData ?? []), ...Object.keys(opts.seeds ?? {})])
  for (const entry of readdirSync(join(ROOT, 'data'))) {
    if (!own.has(entry)) {
      symlinkSync(join(ROOT, 'data', entry), join(data, entry))
      continue
    }
    mkdirSync(join(data, entry))
    for (const child of readdirSync(join(ROOT, 'data', entry))) {
      if (child === 'seed.sql') continue
      symlinkSync(join(ROOT, 'data', entry, child), join(data, entry, child))
    }
  }
  for (const key of own) if (!existsSync(join(data, key))) mkdirSync(join(data, key))
  for (const [key, sql] of Object.entries(opts.seeds ?? {})) writeFileSync(join(data, key, 'seed.sql'), sql)

  // 別の契約が形を持つ道具を包みに差し替える（写しの本物は _real_ を付けて残す）
  if (copied.has('scripts')) {
    for (const [tool, file] of Object.entries(TOOLS) as Array<[Tool, string]>) {
      const at = join(root, 'scripts', file)
      const real = `_real_${file}`
      if (existsSync(at)) renameSync(at, join(root, 'scripts', real))
      writeExecutable(at, file.endsWith('.py') ? pythonWrapper(tool, real) : bashWrapper(tool, real))
    }
  }

  // 配備の道具と組み立ての道具
  const modules = join(root, 'node_modules')
  const dotBin = join(modules, '.bin')
  mkdirSync(dotBin, { recursive: true })
  const realModules = join(ROOT, 'node_modules')
  for (const entry of readdirSync(realModules)) {
    if (entry === '.bin' || entry === 'wrangler' || entry === '.vite' || entry === '.cache') continue
    symlinkSync(join(realModules, entry), join(modules, entry))
  }
  for (const entry of readdirSync(join(realModules, '.bin'))) {
    if (/^(wrangler|wrangler2|vite)$/.test(entry)) continue
    symlinkSync(realpathSync(join(realModules, '.bin', entry)), join(dotBin, entry))
  }
  writeExecutable(join(dotBin, 'vite'), VITE_STUB)
  const pkg = join(modules, 'wrangler')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'wrangler', version: PINNED_VERSION, bin: { wrangler: 'bin/wrangler.js', wrangler2: 'bin/wrangler.js' } }))
  writeExecutable(join(pkg, 'bin', 'wrangler.js'), wranglerStub('pinned'))
  symlinkSync(join(pkg, 'bin', 'wrangler.js'), join(dotBin, 'wrangler'))
  symlinkSync(join(pkg, 'bin', 'wrangler.js'), join(dotBin, 'wrangler2'))
  writeExecutable(join(dir, 'unpinned-wrangler.js'), wranglerStub('unpinned'))
  writeExecutable(join(bin, 'wrangler'), `#!/usr/bin/env bash\nexec "${join(dir, 'unpinned-wrangler.js')}" "$@"\n`)
  writeExecutable(join(bin, 'npx'), NPX_STUB)
  writeExecutable(join(bin, 'curl'), CURL_STUB)

  makeStorage(join(dir, 'remote.sqlite'), opts.remote)
  makeStorage(join(dir, 'local.sqlite'), opts.local)

  const guard = join(dir, 'net-guard.cjs')
  writeFileSync(guard, NET_GUARD)
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp)
  return { dir, root, bin, log, guard, tmp }
}

/** 影の根から固定した版の配備の道具（node_modules/wrangler と node_modules/.bin/wrangler・wrangler2）を除き、別の版の道具だけがある状態にする。
 *  PATH の wrangler と npx wrangler の先は別の版の偽物のまま。npx は呼ばれたこと（tool 'npx'）を記録してから、もとの偽の npx に渡す。 */
export function withoutPinnedTool(shadow: Shadow): void {
  rmSync(join(shadow.root, 'node_modules', 'wrangler'), { recursive: true, force: true })
  for (const name of ['wrangler', 'wrangler2']) rmSync(join(shadow.root, 'node_modules', '.bin', name), { force: true })
  const npx = join(shadow.bin, 'npx')
  const inner = join(shadow.dir, 'npx-uc032')
  renameSync(npx, inner)
  writeExecutable(
    npx,
    `#!/usr/bin/env bash
args=""
for a in "$@"; do args="$args,\\"$a\\""; done
printf '{"tool":"npx","argv":[%s]}\\n' "\${args#,}" >> "$STUB_LOG"
exec "${inner}" "$@"
`,
  )
}

/** 1 回の呼び出しの外の世界の決め方。 */
export type World = {
  modes?: Partial<Record<Tool, ToolMode>>
  /** ログイン中のアカウント（偽の whoami の答え）。'several' は 2 つを並べ、1 番目は決めたアカウントと違う物、2 番目は決めたアカウント */
  whoami?: 'decided' | 'other' | 'fail' | 'several'
  /** 子に渡す CLOUDFLARE_ACCOUNT_ID（向け先のアカウントの環境変数）。null は渡さない（親の環境の値も外す）。
   *  省くと whoami に合わせた値（'other' なら違う値、'fail' なら渡さない、ほかは決めたアカウント） */
  accountEnv?: string | null
  migrationsFail?: boolean
  queryFail?: boolean
  seedFails?: number
  backupFail?: boolean
  applySeed?: boolean
  /** 代理を通さない宛先（手元の代わりの相手に向ける回だけ）。既定は空で、どの宛先も閉じた代理を通る */
  noProxy?: string
}

export type LogEntry = {
  tool: string
  argv: string[] | string
  cwd?: string
  side?: 'remote' | 'local'
  deploy?: boolean
  seed?: { file: string }
  backup?: boolean
  mode?: string
}
export type Run = { code: number; out: string; log: LogEntry[] }

const REAL_NPX = (process.env.PATH ?? '')
  .split(delimiter)
  .map((p) => join(p, 'npx'))
  .find((p) => existsSync(p)) ?? 'npx'

/** 影の根で scripts の手続き（bash）を 1 回回す。 */
export function runProcedure(shadow: Shadow, script: string, args: string[], world: World = {}): Promise<Run> {
  return runCommand(shadow, 'bash', [join(shadow.root, 'scripts', script), ...args], world)
}

/** 影の根を作業の場所にして、囲いの中でコマンドを 1 回回す。 */
export function runCommand(shadow: Shadow, command: string, args: string[], world: World = {}): Promise<Run> {
  return new Promise((resolve) => {
    writeFileSync(shadow.log, '')
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${shadow.bin}${delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `--require ${shadow.guard}`,
      STUB_LOG: shadow.log,
      STUB_SANDBOX: shadow.dir,
      STUB_UNPINNED: join(shadow.dir, 'unpinned-wrangler.js'),
      STUB_DB_REMOTE: join(shadow.dir, 'remote.sqlite'),
      STUB_DB_LOCAL: join(shadow.dir, 'local.sqlite'),
      STUB_MIGRATIONS_DIR: join(shadow.root, 'migrations'),
      STUB_WHOAMI: world.whoami ?? 'decided',
      STUB_MIGRATIONS_FAIL: world.migrationsFail ? '1' : '0',
      STUB_QUERY_FAIL: world.queryFail ? '1' : '0',
      STUB_SEED_FAILS: String(world.seedFails ?? 0),
      STUB_BACKUP_FAIL: world.backupFail ? '1' : '0',
      STUB_APPLY_FILE: world.applySeed ? '1' : '0',
      REAL_NPX,
      CLOUDFLARE_API_TOKEN: 'stub-invalid-token-do-not-use',
      CLOUDFLARE_ACCOUNT_ID:
        world.accountEnv !== undefined
          ? (world.accountEnv ?? undefined)
          : world.whoami === 'other'
            ? OTHER_ACCOUNT
            : world.whoami === 'fail'
              ? undefined
              : ACCOUNT,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      // 親の環境の値を引き継がない（代理を通さない宛先が本番の名前に当たると、閉じた代理を迂回して外へ届く）
      NO_PROXY: world.noProxy ?? '',
      no_proxy: world.noProxy ?? '',
      TMPDIR: shadow.tmp,
      TMP: shadow.tmp,
      TEMP: shadow.tmp,
      XDG_CONFIG_HOME: join(shadow.dir, 'xdg'),
      WRANGLER_SEND_METRICS: 'false',
      CI: '1',
    }
    if (env.CLOUDFLARE_ACCOUNT_ID === undefined) delete env.CLOUDFLARE_ACCOUNT_ID
    for (const tool of Object.keys(TOOLS) as Tool[]) env[`STUB_MODE_${tool}`] = world.modes?.[tool] ?? 'pass'
    execFile(command, args, { cwd: shadow.root, env, maxBuffer: 1 << 26, timeout: 540_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      const log = readFileSync(shadow.log, 'utf8')
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => {
          try {
            return JSON.parse(l) as LogEntry
          } catch {
            return { tool: 'unparsed', argv: l }
          }
        })
      resolve({ code, out: `${stdout}${stderr}`, log })
    })
  })
}

const isWrangler = (e: LogEntry) => e.tool === 'pinned' || e.tool === 'unpinned'
const argvOf = (e: LogEntry): string[] => (Array.isArray(e.argv) ? e.argv : [e.argv])

/** 保存先に向けた操作（wrangler の d1）の記録。 */
export const storageCalls = (r: Run) => r.log.filter((e) => isWrangler(e) && argvOf(e)[0] === 'd1')
/** 投入（d1 execute --file）の記録。 */
export const seedRuns = (r: Run) => r.log.filter((e) => isWrangler(e) && e.seed !== undefined)
/** 控え（控えの道具か、d1 export）の記録。 */
export const backupRuns = (r: Run) => r.log.filter((e) => e.tool === 'backup_d1' || (isWrangler(e) && e.backup === true))
/** 配信（pages deploy）の記録。 */
export const deployRuns = (r: Run) => r.log.filter((e) => isWrangler(e) && e.deploy === true)
/** 包みに差し替えた道具の呼ばれた記録。 */
export const toolRuns = (r: Run, tool: Tool) => r.log.filter((e) => e.tool === tool)
/** 記録の中の位置。 */
export const indexOf = (r: Run, e: LogEntry) => r.log.indexOf(e)
export const argsOf = argvOf
export const tail = (r: Run) => r.out.split('\n').slice(-40).join('\n')

/** 作った影の根をすべて消す。 */
export async function removeShadows(): Promise<void> {
  await Promise.all(shadows.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** 本数を絞って並べて回す（影の根の写しと手続きが重いので一度に全部は回さない）。 */
export async function inBatches<T>(tasks: Array<() => Promise<T>>, size = 4): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < tasks.length; i += size) out.push(...(await Promise.all(tasks.slice(i, i + size).map((t) => t()))))
  return out
}
