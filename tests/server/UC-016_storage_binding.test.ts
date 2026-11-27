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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * UC-016 学び側の配備の手続き（`scripts/deploy-pages.sh <key>`）が、配信物の設定にその学びの key に結んだ保存先だけを
 * 結ぶこと（REQ-524）と、結んでいなければ配信しないまま止まること（REQ-543）。
 *
 * 学びの key に結んだ保存先の正本は ADR-0004 のとおり `wrangler.jsonc` の `env.<key>.d1_databases`。
 * 手続きは本物を回し、外の世界だけを偽物にする。リポジトリの写し（影の根）を一時の場所に作り、
 * - 配備の道具（wrangler）: 固定した版の位置（影の根の node_modules の wrangler）に偽物を置く。偽物は本物と同じ探し方で
 *   設定のファイルを見つけ（`--config`／`-c`、無ければ今いる場所から上へ `wrangler.json`・`wrangler.jsonc`・`wrangler.toml`）、
 *   配信（`pages deploy`）のときにはその設定が Pages に結ぶ保存先（最上位と `env.production`・`env.preview` の `d1_databases`）を記録する。
 *   保存先を名指す D1 の操作（`d1 migrations list <名前> --env <key>` など）は、その設定に名前の合う保存先が無ければ本物と同じく失敗する
 * - 組み立ての道具（vite）: 偽物が配信物の置き場を作る
 * - curl・PATH の wrangler・npx が取りに行く別の版: 外へ出さずに記録する
 * - 配信の前の門（ソースの門・登録簿の門・文書の索引の門・実データの描画の検査。UC-032 の REQ-560 が止める理由に挙げる物）:
 *   影の根の写しを、呼ばれたことを記録して「通った」（終了の状態 0）で返す包みに差し替える（先例は `UC-032_fixture.local.ts`）
 * 子のプロセスでは外への通信を塞ぐ（届かない代理・無効のトークン・node の外向きの接続を断る前置き）。本番には届かない。
 *
 * 偽の wrangler の `--env <名前>` の扱いは本物（4.140.0）に合わせる: 設定に `env` の節が 1 つでもあって名前の節が無ければ誤りで終わり、
 * `env` の節が 1 つも無ければ最上位の設定に倒す。`d1_databases` は `env` の節に継がない。呼ばれた操作は終了の状態ごと記録する。
 *
 * 影の根は、書き込みうる場所（scripts・public・src・portal）を写し、それ以外を元の場所へのリンクにする。
 * REQ-543 の入力では `wrangler.jsonc` だけを写して書き換える（最上位の既定の保存先は残す）。REQ-543 が止めたことは、
 * REQ-560 の止める理由（構造の変更の確かめと配信の前の門）がどれも止めていないのに配信せず失敗で終わることで見る。
 * - 学びの節が無い形: `env` の節を 1 つも残さず、保存先の名前が最上位の既定と同じ資格対策の学びを配る。本物の道具の下でも
 *   構造の変更の確かめは最上位の既定に倒れて通るので、偽の wrangler はそのまま答える
 * - 節に保存先が無い・空の形: 本物の道具の下では構造の変更の確かめが先に「確かめられない」になる（REQ-560 の範囲）。
 *   REQ-543 の判定だけを切り出すため、構造の変更の一覧（`d1 migrations list`）を「当たっていない物は無い」と答える世界で回す
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 保存先を key に結んだ学びのうち、最上位の既定と違う保存先を持つ学び（既定に倒す取り違えが観測できる）。 */
const LEARNING_KEY = 'ap'

const COPIED = new Set(['scripts', 'public', 'src', 'portal'])
const OMITTED = (name: string) =>
  ['node_modules', 'dist', '.wrangler', '.DS_Store'].includes(name) || name.startsWith('.worker-build')

/** JSONC（行と塊のコメント・末尾のカンマ）を JSON として読む。文字列の中の `//` は残す。 */
const parseJsonc = (text: string): unknown => {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
      if (i === 0) break
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

type D1 = { binding?: string; database_name?: string; database_id?: string }
type WranglerConfig = { d1_databases?: D1[]; env?: Record<string, { d1_databases?: D1[] } | undefined> }
const REPO_CONFIG = parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')) as WranglerConfig
const OWN = REPO_CONFIG.env?.[LEARNING_KEY]?.d1_databases ?? []
const DEFAULT = REPO_CONFIG.d1_databases ?? []
/** 設定にある全部の保存先（最上位と全ての学びの節）。 */
const EVERY = [...DEFAULT, ...Object.values(REPO_CONFIG.env ?? {}).flatMap((e) => e?.d1_databases ?? [])]
const PROJECTS = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as Record<string, unknown> & { account_id: string }
const ACCOUNT = PROJECTS.account_id
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Record<string, { roadmap?: boolean } | undefined>
/** 保存先の名前が最上位の既定と同じ資格対策の学び（`env` の節が無いと本物の道具が最上位に倒し、構造の変更の確かめが通る学び）。 */
const DEFAULT_NAMED_KEY =
  Object.keys(REGISTRY).find(
    (k) =>
      !k.startsWith('_') &&
      REGISTRY[k]?.roadmap === false &&
      DEFAULT.some((d) => d.database_name !== undefined && d.database_name === (PROJECTS[k] as { db?: string } | undefined)?.db),
  ) ?? ''
const PINNED_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
).packages['node_modules/wrangler']?.version ?? '0.0.0'

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
const entry = { tool: TOOL, cwd: process.cwd(), argv }
// 呼ばれた操作は、終わるときに終了の状態ごと記録する
process.on('exit', (code) => {
  entry.exit = code
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
})
const log = () => {}
const valueOf = (...names) => {
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) return argv[i + 1]
      if (argv[i].startsWith(n + '=')) return argv[i].slice(n.length + 1)
    }
  }
  return null
}
const parseJsonc = ${parseJsonc.toString()}
const CONFIG_NAMES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']
const findConfig = () => {
  const given = valueOf('--config', '-c')
  if (given) return path.resolve(given)
  let d = process.cwd()
  for (;;) {
    for (const n of CONFIG_NAMES) if (fs.existsSync(path.join(d, n))) return path.join(d, n)
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}
/** 設定のファイルを読む。TOML は保存先の表だけを拾う。 */
const readConfig = (file) => {
  if (!file || !fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  if (!file.endsWith('.toml')) {
    try { return parseJsonc(text) } catch { return { unreadable: true } }
  }
  const cfg = { d1_databases: [], env: {} }
  let current = null
  for (const line of text.split('\\n')) {
    const header = line.match(/^\\s*\\[\\[\\s*(?:env\\.([\\w-]+)\\.)?d1_databases\\s*\\]\\]/)
    if (header) {
      current = {}
      if (header[1]) { cfg.env[header[1]] ??= { d1_databases: [] }; cfg.env[header[1]].d1_databases.push(current) }
      else cfg.d1_databases.push(current)
      continue
    }
    if (/^\\s*\\[/.test(line)) { current = null; continue }
    const kv = line.match(/^\\s*(binding|database_name|database_id)\\s*=\\s*"([^"]*)"/)
    if (kv && current) current[kv[1]] = kv[2]
  }
  return cfg
}
/** 本物と同じ --env の解き方。節があればその節（d1_databases は継がない）、節が無く env の節が 1 つでもあれば誤り、1 つも無ければ最上位。 */
const resolveEnv = (cfg, env) => {
  const envs = (cfg && cfg.env && typeof cfg.env === 'object') ? cfg.env : {}
  if (!env) return { ok: true, scope: cfg || {} }
  if (Object.prototype.hasOwnProperty.call(envs, env) && envs[env]) return { ok: true, scope: envs[env] }
  if (Object.keys(envs).length > 0) return { ok: false }
  console.warn('▲ [WARNING] No environment found in configuration with name "' + env + '". Using the top-level configuration.')
  return { ok: true, scope: cfg || {} }
}
const pagesBindings = (cfg) => {
  if (!cfg) return []
  return [...(cfg.d1_databases || []), ...((cfg.env && cfg.env.production && cfg.env.production.d1_databases) || []), ...((cfg.env && cfg.env.preview && cfg.env.preview.d1_databases) || [])]
}
if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
  log()
  console.log(VERSION)
  process.exit(0)
}
if (argv[0] === 'whoami') {
  log()
  console.log(' ⛅️ wrangler ' + VERSION)
  console.log('👋 You are logged in with an OAuth Token.')
  console.log('┌──────────────┬──────────────────────────────────┐')
  console.log('│ Account Name │ Account ID                       │')
  console.log('│ Personal     │ ' + ${JSON.stringify(ACCOUNT)} + ' │')
  console.log('└──────────────┴──────────────────────────────────┘')
  process.exit(0)
}
if (argv[0] === 'pages' && argv[1] === 'deploy') {
  const file = findConfig()
  entry.deploy = { configFile: file, d1: pagesBindings(readConfig(file)) }
  log()
  console.log('✨ Deployment complete! Take a peek over at https://stub.pages.dev')
  process.exit(0)
}
if (argv[0] === 'deploy' && argv.includes('--dry-run')) {
  log()
  const resolved = resolveEnv(readConfig(findConfig()), valueOf('--env', '-e'))
  if (!resolved.ok) {
    console.error('✘ [ERROR] No environment found in configuration with name "' + valueOf('--env', '-e') + '".')
    process.exit(1)
  }
  const outdir = valueOf('--outdir')
  if (outdir) {
    fs.mkdirSync(path.resolve(outdir), { recursive: true })
    fs.writeFileSync(path.join(path.resolve(outdir), 'index.js'), 'export default { fetch() { return new Response("stub") } }')
  }
  console.log('--dry-run: exiting now.')
  process.exit(0)
}
if (argv[0] === 'd1' && argv[1] !== 'list' && argv[1] !== 'create') {
  // 保存先を名指す D1 の操作。本物と同じく、設定（--env があればその節）に名前か binding の合う保存先が無ければ失敗する
  log()
  if (process.env.STUB_MIGRATIONS_PASS === '1' && argv[1] === 'migrations' && argv[2] === 'list') {
    // 構造の変更の確かめが通る世界: 当たっていない構造の変更は無いと答える
    entry.forced = true
    console.log('✅ No migrations to apply!')
    process.exit(0)
  }
  const name = argv[1] === 'migrations' ? argv[3] : argv[2]
  const env = valueOf('--env', '-e')
  const resolved = resolveEnv(readConfig(findConfig()) || {}, env)
  if (!resolved.ok) {
    console.error('✘ [ERROR] No environment found in configuration with name "' + env + '".')
    process.exit(1)
  }
  const list = resolved.scope.d1_databases || []
  if (!list.some((d) => d && (d.binding === name || d.database_name === name))) {
    console.error("✘ [ERROR] Couldn't find a D1 DB with the name or binding '" + name + "' in your wrangler.json file.")
    process.exit(1)
  }
  if (argv[1] === 'migrations' && argv[2] === 'list') console.log('✅ No migrations to apply!')
  process.exit(0)
}
if (argv[0] === 'pages' && argv[1] === 'secret' && argv[2] === 'list') {
  log()
  console.log('SSO_SECRET: Value Encrypted')
  console.log('JWT_SECRET: Value Encrypted')
  process.exit(0)
}
log()
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

/** 差し替える配信の前の門（影の根の scripts の中のファイル名 → 記録の名前）。REQ-560 が止める理由に挙げる門と検査。 */
const GATES = {
  check_source: 'check_source.py',
  check_roadmap_registry: 'check_roadmap_registry.py',
  check_docs: 'check_docs.py',
  check_render: 'check_render.sh',
} as const
type Gate = keyof typeof GATES

/** 門の包み。呼ばれたことを記録して「通った」で返す。 */
const gateWrapper = (gate: Gate, file: string) =>
  file.endsWith('.py')
    ? `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["STUB_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"tool": ${JSON.stringify(gate)}, "argv": sys.argv[1:], "exit": 0}) + "\\n")
sys.exit(0)
`
    : `#!/usr/bin/env bash
printf '{"tool":"${gate}","argv":"%s","exit":0}\\n' "$*" >> "$STUB_LOG"
exit 0
`

type Shadow = { dir: string; root: string; bin: string; log: string; guard: string; tmp: string }
type LogEntry = { tool: string; argv: string[] | string; exit?: number; forced?: boolean; deploy?: { configFile: string | null; d1: D1[] } }
type Run = { code: number; out: string; log: LogEntry[] }

const writeExecutable = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}
const shadows: string[] = []

/** リポジトリの影の根を作る。editConfig を与えると wrangler.jsonc を写して書き換える。 */
const makeShadow = (name: string, editConfig?: (c: WranglerConfig) => void): Shadow => {
  const dir = mkdtempSync(join(tmpdir(), `uc016s-${name}-`))
  shadows.push(dir)
  const root = join(dir, 'root')
  const bin = join(dir, 'bin')
  mkdirSync(root)
  mkdirSync(bin)
  for (const entry of readdirSync(ROOT)) {
    if (OMITTED(entry)) continue
    const from = join(ROOT, entry)
    if (entry === 'wrangler.jsonc' && editConfig) {
      const cfg = structuredClone(REPO_CONFIG)
      editConfig(cfg)
      writeFileSync(join(root, entry), JSON.stringify(cfg, null, 2))
    } else if (COPIED.has(entry)) {
      cpSync(from, join(root, entry), {
        recursive: true,
        filter: (src) => !/\/(node_modules|dist|\.wrangler)(\/|$)/.test(src.slice(from.length)),
      })
    } else symlinkSync(from, join(root, entry))
  }
  // 配信の前の門を、通ったと返す包みに差し替える（写しの本物は _real_ を付けて残す）
  for (const [gate, file] of Object.entries(GATES) as Array<[Gate, string]>) {
    const at = join(root, 'scripts', file)
    if (existsSync(at)) renameSync(at, join(root, 'scripts', `_real_${file}`))
    writeExecutable(at, gateWrapper(gate, file))
  }
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
  const guard = join(dir, 'net-guard.cjs')
  writeFileSync(guard, NET_GUARD)
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp)
  return { dir, root, bin, log, guard, tmp }
}

const REAL_NPX = (process.env.PATH ?? '')
  .split(delimiter)
  .map((p) => join(p, 'npx'))
  .find((p) => existsSync(p)) ?? 'npx'

/** 外の世界の決め方。migrationsPass は構造の変更の一覧を「当たっていない物は無い」と答える世界。 */
type World = { migrationsPass?: boolean }

/** 影の根で学び側の配備の手続きを 1 回回す。 */
const runDeploy = (shadow: Shadow, key: string, world: World = {}): Promise<Run> =>
  new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${shadow.bin}${delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `--require ${shadow.guard}`,
      STUB_LOG: shadow.log,
      STUB_UNPINNED: join(shadow.dir, 'unpinned-wrangler.js'),
      STUB_MIGRATIONS_PASS: world.migrationsPass ? '1' : '0',
      REAL_NPX,
      CLOUDFLARE_API_TOKEN: 'stub-invalid-token-do-not-use',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      TMPDIR: shadow.tmp,
      TMP: shadow.tmp,
      TEMP: shadow.tmp,
      XDG_CONFIG_HOME: join(shadow.dir, 'xdg'),
      WRANGLER_SEND_METRICS: 'false',
      CI: '1',
    }
    execFile('bash', [join(shadow.root, 'scripts', 'deploy-pages.sh'), key], { cwd: shadow.root, env, maxBuffer: 1 << 26, timeout: 540_000 }, (error, stdout, stderr) => {
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

const deploysOf = (r: Run) => r.log.filter((e) => e.deploy !== undefined)
const isWrangler = (e: LogEntry) => e.tool === 'pinned' || e.tool === 'unpinned'
const argvOf = (e: LogEntry) => (Array.isArray(e.argv) ? e.argv : [e.argv])
const idsOf = (list: D1[]) => [...new Set(list.map((d) => d.database_id ?? `name:${d.database_name ?? ''}`))].sort()
const tail = (r: Run) => r.out.split('\n').slice(-40).join('\n')

const runs: Record<string, Run> = {}
const run = (name: string) => {
  const r = runs[name]
  if (!r) throw new Error(`${name} の実行結果が無い`)
  return r
}

beforeAll(async () => {
  const inputs: Array<[string, string, ((c: WranglerConfig) => void) | undefined, World]> = [
    ['bound', LEARNING_KEY, undefined, {}],
    // env の節を 1 つも残さない（その学びの節も無い）。本物の道具は最上位に倒すので、構造の変更の確かめは通る
    ['envMissing', DEFAULT_NAMED_KEY, (c) => { delete c.env }, {}],
    ['databasesMissing', LEARNING_KEY, (c) => { delete c.env?.[LEARNING_KEY]?.d1_databases }, { migrationsPass: true }],
    ['databasesEmpty', LEARNING_KEY, (c) => { const e = c.env?.[LEARNING_KEY]; if (e) e.d1_databases = [] }, { migrationsPass: true }],
  ]
  await Promise.all(inputs.map(async ([name, key, edit, world]) => { runs[name] = await runDeploy(makeShadow(name, edit), key, world) }))
}, 600_000)

/** REQ-560 の止める理由（構造の変更の確かめと配信の前の門）と、配備の道具の操作のどれも止めていない。 */
const expectNoOtherStop = (r: Run) => {
  const failed = r.log.filter((e) => isWrangler(e) && e.exit !== 0).map((e) => `${argvOf(e).join(' ')} → ${e.exit ?? '記録なし'}`)
  expect(failed, `配備の道具の操作が失敗している（構造の変更の確かめなど、REQ-543 でない物が止めた）:\n${tail(r)}`).toEqual([])
  const gates = r.log.filter((e) => (Object.keys(GATES) as string[]).includes(e.tool))
  expect(gates.filter((e) => e.exit !== 0), '配信の前の門が止めている').toEqual([])
}

/** 影の根を消す時間の上限（1 つに数千のファイルを持ち、並行して回っていると既定の上限より長く掛かる）。 */
const CLEANUP_TIMEOUT_MS = 120_000

afterAll(async () => {
  await Promise.all(shadows.map((dir) => rm(dir, { recursive: true, force: true })))
}, CLEANUP_TIMEOUT_MS)

describe('UC-016 配信物に結ぶ保存先（偽の配備の道具で学び側の配備の手続きを回す）', () => {
  describe('REQ-524 配信物の設定にその学びの key に結んだ保存先だけを結ぶ', () => {
    // @covers REQ-524#own-storage-only
    it('既定と違う保存先を key に結んだ学びを配信すると、配信に渡る設定の保存先はその学びの保存先とちょうど一致する', () => {
      expect(OWN.length, '仕込み: その学びの key に保存先が結んでいない').toBeGreaterThan(0)
      expect(idsOf(OWN), '仕込み: その学びの保存先が既定と同じで取り違えが観測できない').not.toEqual(idsOf(DEFAULT))
      const r = run('bound')
      const deployed = deploysOf(r)
      expect(deployed.length, `配信していない:\n${tail(r)}`).toBeGreaterThan(0)
      for (const e of deployed) {
        const bound = e.deploy?.d1 ?? []
        expect(idsOf(bound), `配信に渡る設定（${e.deploy?.configFile ?? '見つからない'}）の保存先がその学びの保存先と違う`).toEqual(idsOf(OWN))
        const others = idsOf(EVERY).filter((id) => !idsOf(OWN).includes(id))
        expect(idsOf(bound).filter((id) => others.includes(id)), '既定や別の学びの保存先を結んでいる').toEqual([])
      }
    })
  })

  describe('REQ-543 学びの key に保存先が結んでいなければ配信しないまま止まる', () => {
    // @covers REQ-543#learning-env-missing
    it('設定にその学びの key の節が無いと、構造の変更の確かめと門が止めなくても、配信せず、手続きは失敗で終わる', () => {
      expect(DEFAULT_NAMED_KEY, '仕込み: 保存先の名前が最上位の既定と同じ資格対策の学びが無い').not.toBe('')
      expect(REPO_CONFIG.env?.[DEFAULT_NAMED_KEY]?.d1_databases?.length, '仕込み: その学びが元の設定で保存先を key に結んでいない').toBeGreaterThan(0)
      expect(DEFAULT.length, '仕込み: 最上位の既定の保存先が無い').toBeGreaterThan(0)
      const r = run('envMissing')
      expect(r.log.some((e) => isWrangler(e) && argvOf(e)[0] === 'd1' && e.forced), '仕込み: 構造の変更の確かめを差し替えている').toBe(false)
      expectNoOtherStop(r)
      expect(deploysOf(r), '保存先が結んでいないのに配信している').toEqual([])
      expect(r.code, `保存先が結んでいないのに手続きが成功で終わった:\n${tail(r)}`).not.toBe(0)
    })

    // @covers REQ-543#databases-missing
    it('その学びの key の節に保存先の項目が無いと、構造の変更の確かめと門が止めなくても、配信せず、手続きは失敗で終わる', () => {
      const r = run('databasesMissing')
      expectNoOtherStop(r)
      expect(deploysOf(r), '保存先が結んでいないのに配信している').toEqual([])
      expect(r.code, `保存先が結んでいないのに手続きが成功で終わった:\n${tail(r)}`).not.toBe(0)
    })

    // @covers REQ-543#databases-empty
    it('その学びの key の節の保存先の項目が空だと、構造の変更の確かめと門が止めなくても、配信せず、手続きは失敗で終わる', () => {
      const r = run('databasesEmpty')
      expectNoOtherStop(r)
      expect(deploysOf(r), '保存先が結んでいないのに配信している').toEqual([])
      expect(r.code, `保存先が結んでいないのに手続きが成功で終わった:\n${tail(r)}`).not.toBe(0)
    })
  })
})
