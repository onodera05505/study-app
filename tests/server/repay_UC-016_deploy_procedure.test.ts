import { execFile, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * UC-016 配備の手続き（学び側 `scripts/deploy-pages.sh <key>`・まなびば `scripts/deploy_portal.sh`）が、
 * 版の印を配信物に書き出してから、プロジェクトが固定した版の配備の道具で配信すること（REQ-224〜226・351・352）。
 *
 * 手続きは本物を回し、外の世界だけを偽物にする。リポジトリの写し（影の根）を一時の場所に作り、
 * - 配備の道具（wrangler）: 固定した版の位置（影の根の node_modules の wrangler）に置く偽物と、それ以外の版
 *   （PATH の wrangler と、npx が取りに行く版）の偽物を分け、どちらが呼ばれたかと、配信に渡された配信物の
 *   版の印（`version.json`。契約 fetchVersionStamp の wire の path）を記録する
 * - 組み立ての道具（vite）: 偽物が `public/` の中身と、入力ごとの目印を入れた入口を配信物に置く
 * - curl: 外へ出さずに記録する
 * 本物の配信先には届かない（偽物が受けるだけで、本物の道具が呼ばれても無効のトークンと届かない代理で失敗する）。
 *
 * 影の根は、書き込みうる場所（scripts・public・src・portal）を写し、それ以外を元の場所へのリンクにする。
 * 配信物と組み立ての出力の置き場（dist など）は写さず、手続きが新しく作る。
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const LEARNING_KEY = 'ip'

/** 写す（書き込まれても元に響かない）場所と、影の根に置かない場所。 */
const COPIED = new Set(['scripts', 'public', 'src', 'portal'])
const OMITTED = (name: string) =>
  ['node_modules', 'dist', '.wrangler', '.DS_Store'].includes(name) || name.startsWith('.worker-build')

/** 固定した版の値の正本は package-lock.json（REQ-351 の検証しない。偽物が --version に答えるのに使うだけ）。 */
const PINNED_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
).packages['node_modules/wrangler']?.version ?? '0.0.0'
const ACCOUNT = (JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as { account_id: string }).account_id

/** 偽の wrangler。tool は 'pinned'（固定した版の位置に置いた物）か 'unpinned'（別の版）。 */
const wranglerStub = (tool: 'pinned' | 'unpinned') => `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const TOOL = ${JSON.stringify(tool)}
const VERSION = ${JSON.stringify(tool === 'pinned' ? PINNED_VERSION : '9.9.9-unpinned')}
const argv = process.argv.slice(2)
const entry = { tool: TOOL, cwd: process.cwd(), argv }
const VALUE_FLAGS = new Set(['--project-name', '--branch', '--commit-hash', '--commit-message', '--config', '-c', '--env', '-e', '--cwd'])
const outputDirFromConfig = () => {
  const i = argv.findIndex((a) => a === '--config' || a === '-c')
  const named = i >= 0 ? [path.resolve(argv[i + 1])] : ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'].map((f) => path.resolve(f))
  for (const file of named) {
    if (!fs.existsSync(file)) continue
    const m = fs.readFileSync(file, 'utf8').match(/pages_build_output_dir["']?\\s*[=:]\\s*["']([^"']+)["']/)
    if (m) return path.resolve(path.dirname(file), m[1])
  }
  return null
}
if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
  console.log(VERSION)
  process.exit(0)
}
if (argv[0] === 'whoami') {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
  console.log(' ⛅️ wrangler ' + VERSION)
  console.log('👋 You are logged in with an OAuth Token.')
  console.log('┌──────────────┬──────────────────────────────────┐')
  console.log('│ Account Name │ Account ID                       │')
  console.log('│ Personal     │ ' + ${JSON.stringify(ACCOUNT)} + ' │')
  console.log('└──────────────┴──────────────────────────────────┘')
  process.exit(0)
}
if (argv[0] === 'pages' && argv[1] === 'deploy') {
  const rest = argv.slice(2)
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (VALUE_FLAGS.has(rest[i])) { i++; continue }
    if (!rest[i].startsWith('-')) positional.push(rest[i])
  }
  const dir = positional.length ? path.resolve(positional[0]) : outputDirFromConfig()
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
  entry.deploy = { dir, versionJson: dir ? read('version.json') : null, indexHtml: dir ? read('index.html') : null }
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
  console.log('✨ Deployment complete! Take a peek over at https://stub.pages.dev')
  process.exit(0)
}
if (argv[0] === 'deploy' && argv.includes('--dry-run')) {
  // 本物の wrangler は --dry-run --outdir で Worker を 1 ファイルにまとめた index.js を置く
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
  const i = argv.findIndex((a) => a === '--outdir' || a.startsWith('--outdir='))
  if (i >= 0) {
    const out = path.resolve(argv[i].includes('=') ? argv[i].slice('--outdir='.length) : argv[i + 1])
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'index.js'), 'export default { fetch() { return new Response("stub") } }')
  }
  console.log('--dry-run: exiting now.')
  process.exit(0)
}
if (argv[0] === 'd1' && argv[1] === 'migrations' && argv[2] === 'list') {
  // 本物の wrangler が、未適用の migrations が無いときに出す行
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
  console.log(' ⛅️ wrangler ' + VERSION)
  console.log('✅ No migrations to apply!')
  process.exit(0)
}
if (argv[0] === 'pages' && argv[1] === 'secret' && argv[2] === 'list') {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
  console.log('SSO_SECRET: Value Encrypted')
  console.log('JWT_SECRET: Value Encrypted')
  process.exit(0)
}
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
process.exit(0)
`

/** 偽の vite。build で配信物の置き場を作り、public の中身と目印（STUB_CONTENT）を入れた入口を置く。
 *  STUB_BLOCK_STAMP=1 のときは配信物の version.json の位置を書き込めない形（ディレクトリ）にする。 */
const VITE_STUB = `#!/usr/bin/env node
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
const content = process.env.STUB_CONTENT || 'content'
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><title>' + content + '</title>')
fs.mkdirSync(path.join(out, 'assets'), { recursive: true })
fs.writeFileSync(path.join(out, 'assets', 'app-' + content + '.js'), 'console.log(' + JSON.stringify(content) + ')')
if (process.env.STUB_BLOCK_STAMP === '1') fs.mkdirSync(path.join(out, 'version.json'), { recursive: true })
process.exit(0)
`

/** 偽の npx。本物と同じく、今いる場所から上へ node_modules/.bin を探して見つかればそれを使い、
 *  無ければ（取りに行くのを止められていなければ）別の版を取りに行く。wrangler 以外は本物の npx に渡す。 */
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
    exec node "$STUB_UNPINNED" "$@" ;;
esac
exec "$REAL_NPX" "\${orig[@]}"
`

const CURL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "{\\"tool\\":\\"curl\\",\\"argv\\":\\"$*\\"}" >> "$STUB_LOG"
for a in "$@"; do [ "$a" = -w ] && { printf '200'; exit 0; }; done
printf '{}'
`

/** 影の根を、リポジトリの索引の並び（追跡する物）だけを持ち、履歴（コミット）を持たない git の作業ツリーにする。
 *  版を見分ける元の値（git の履歴）は読めず、追跡の確かめ（文書の検査・登録簿の整合）はリポジトリと同じ答えになる。 */
const withoutHistory = (root: string) => {
  const git = (cwd: string, args: string[], input?: string) => {
    const r = spawnSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} が通らない: ${r.stderr}`)
    return r.stdout
  }
  git(root, ['init', '-q'])
  git(root, ['update-index', '-z', '--index-info'], git(ROOT, ['ls-files', '-s', '-z']))
  const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  if (head.status === 0) throw new Error('仕込み: 履歴の無い影の根で、git が今のコミットを読めてしまう')
}

type Shadow = { dir: string; root: string; bin: string; log: string }
type ShadowOptions = { pinned: boolean; noHistory?: boolean; stampBlocked?: boolean }
type LogEntry = { tool: string; cwd?: string; argv: string[] | string; deploy?: { dir: string | null; versionJson: string | null; indexHtml: string | null } }
type Run = { code: number; out: string; log: LogEntry[] }

const writeExecutable = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

/** 作った影の根（終わったら消す）。 */
const shadows: string[] = []

/** リポジトリの影の根を作る。 */
const makeShadow = (name: string, opts: ShadowOptions): Shadow => {
  const dir = mkdtempSync(join(tmpdir(), `uc016-${name}-`))
  shadows.push(dir)
  const root = join(dir, 'root')
  const bin = join(dir, 'bin')
  mkdirSync(root)
  mkdirSync(bin)
  for (const entry of readdirSync(ROOT)) {
    if (OMITTED(entry)) continue
    if (entry === '.git' && opts.noHistory) continue
    const from = join(ROOT, entry)
    if (COPIED.has(entry)) {
      cpSync(from, join(root, entry), {
        recursive: true,
        filter: (src) => !/\/(node_modules|dist|\.wrangler)(\/|$)/.test(src.slice(from.length)),
      })
    } else symlinkSync(from, join(root, entry))
  }
  // まだ版の印が無い状態から始める（一度も配信していない）
  rmSync(join(root, 'public', 'version.json'), { recursive: true, force: true })
  if (opts.stampBlocked) mkdirSync(join(root, 'public', 'version.json'))

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
  if (opts.pinned) {
    const pkg = join(modules, 'wrangler')
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'wrangler', version: PINNED_VERSION, bin: { wrangler: 'bin/wrangler.js', wrangler2: 'bin/wrangler.js' } }))
    writeExecutable(join(pkg, 'bin', 'wrangler.js'), wranglerStub('pinned'))
    symlinkSync(join(pkg, 'bin', 'wrangler.js'), join(dotBin, 'wrangler'))
    symlinkSync(join(pkg, 'bin', 'wrangler.js'), join(dotBin, 'wrangler2'))
  }

  const unpinned = join(dir, 'unpinned-wrangler.js')
  writeExecutable(unpinned, wranglerStub('unpinned'))
  writeExecutable(join(bin, 'wrangler'), `#!/usr/bin/env bash\nexec node "${unpinned}" "$@"\n`)
  writeExecutable(join(bin, 'npx'), NPX_STUB)
  writeExecutable(join(bin, 'curl'), CURL_STUB)
  if (opts.noHistory) withoutHistory(root)
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  return { dir, root, bin, log }
}

const REAL_NPX = (process.env.PATH ?? '')
  .split(delimiter)
  .map((p) => join(p, 'npx'))
  .find((p) => existsSync(p)) ?? 'npx'

/** 影の根で配備の手続きを 1 回回す。content は組み立ての道具が配信物に入れる目印（中身の違い）。 */
const runDeploy = (shadow: Shadow, script: string, args: string[], content: string, opts: ShadowOptions): Promise<Run> =>
  new Promise((resolve) => {
    writeFileSync(shadow.log, '')
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${shadow.bin}${delimiter}${process.env.PATH ?? ''}`,
      STUB_LOG: shadow.log,
      STUB_CONTENT: content,
      STUB_UNPINNED: join(shadow.dir, 'unpinned-wrangler.js'),
      STUB_BLOCK_STAMP: opts.stampBlocked ? '1' : '0',
      REAL_NPX,
      CLOUDFLARE_API_TOKEN: 'stub-invalid-token-do-not-use',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      XDG_CONFIG_HOME: join(shadow.dir, 'xdg'),
      WRANGLER_SEND_METRICS: 'false',
      CI: '1',
    }
    execFile('bash', [join(shadow.root, 'scripts', script), ...args], { cwd: shadow.root, env, maxBuffer: 1 << 26, timeout: 540_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0
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
const wranglerCalls = (r: Run) => r.log.filter((e) => e.tool === 'pinned' || e.tool === 'unpinned')
/** 配信に渡された配信物の版の印（契約 fetchVersionStamp の versionStamp の形）。読めなければ null。 */
const stampOf = (r: Run): { build: string; at?: string } | null => {
  const deployed = deploysOf(r)
  const raw = deployed[deployed.length - 1]?.deploy?.versionJson
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as { build?: unknown; at?: unknown }
    if (typeof s.build !== 'string' || s.build.length === 0) return null
    return { build: s.build, ...(typeof s.at === 'string' ? { at: s.at } : {}) }
  } catch {
    return null
  }
}
const tail = (r: Run) => r.out.split('\n').slice(-40).join('\n')

const runs: Record<string, Run> = {}
const run = (name: string) => {
  const r = runs[name]
  if (!r) throw new Error(`${name} の実行結果が無い`)
  return r
}

beforeAll(async () => {
  const sequence = async (name: string, opts: ShadowOptions, script: string, args: string[], contents: Array<[string, string]>) => {
    const shadow = makeShadow(name, opts)
    for (const [runName, content] of contents) runs[runName] = await runDeploy(shadow, script, args, content, opts)
  }
  await Promise.all([
    // 学び側: 1 回目（まだ印が無い）→ 中身を変えて 2 回目 → 同じ中身で 3 回目
    sequence('learning', { pinned: true }, 'deploy-pages.sh', [LEARNING_KEY], [
      ['learningFirst', 'content-a'],
      ['learningNext', 'content-b'],
      ['learningSameAgain', 'content-b'],
    ]),
    // 版を見分ける元の値（git の履歴）が読めない配備で、同じ中身を 2 回（追跡する物の索引はある）
    sequence('learning-nohistory', { pinned: true, noHistory: true }, 'deploy-pages.sh', [LEARNING_KEY], [
      ['noSourceFirst', 'content-a'],
      ['noSourceAgain', 'content-a'],
    ]),
    // 版の印を配信物に書き出せない配備
    sequence('learning-blocked', { pinned: true, stampBlocked: true }, 'deploy-pages.sh', [LEARNING_KEY], [['stampBlocked', 'content-a']]),
    // 固定した版の道具が入っていない配備（別の版だけが PATH と npx の先にある）
    sequence('learning-unpinned', { pinned: false }, 'deploy-pages.sh', [LEARNING_KEY], [['learningUnpinned', 'content-a']]),
    sequence('portal', { pinned: true }, 'deploy_portal.sh', [], [['portal', 'content-a']]),
    sequence('portal-unpinned', { pinned: false }, 'deploy_portal.sh', [], [['portalUnpinned', 'content-a']]),
  ])
}, 600_000)

/** 影の根を消す時間の上限。影の根は 1 つに数千のファイル（public の写しと、組み立ての道具がそれを写した配信物）を持ち、
 *  ほかのテストファイルと並行して回っているときは、消すのにフックの既定の上限より長く掛かる。 */
const CLEANUP_TIMEOUT_MS = 120_000

afterAll(async () => {
  await Promise.all(shadows.map((dir) => rm(dir, { recursive: true, force: true })))
}, CLEANUP_TIMEOUT_MS)

describe('UC-016 配備の手続き（偽の配備の道具と組み立ての道具で回す）', () => {
  describe('REQ-224 新しい版の配信で版の印を書き出す', () => {
    // @covers REQ-224#first-release
    it('まだ印が無い状態で配信すると、配信に渡した配信物に版の印（版を見分ける値を持つ version.json）が置かれる', () => {
      const r = run('learningFirst')
      expect(deploysOf(r).length, `配信していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(stampOf(r), `配信物に版の印が無い:\n${tail(r)}`).not.toBeNull()
    })

    // @covers REQ-224#after-previous
    it('前の版の印がある状態で中身の違う版を配信すると、前の印と見分けられる印に置き換わる', () => {
      const first = stampOf(run('learningFirst'))
      const next = stampOf(run('learningNext'))
      expect(first, '仕込み: 前の版に印が無い').not.toBeNull()
      expect(next, `次の版に印が無い:\n${tail(run('learningNext'))}`).not.toBeNull()
      expect(run('learningNext').log.some((e) => e.deploy?.indexHtml?.includes('content-b')), '仕込み: 次の版の中身が配信されていない').toBe(true)
      expect(next, '前の版と同じ印が書き出された').not.toEqual(first)
    })
  })

  describe('REQ-225 同じ中身の出し直しでも前の版と見分けられる印', () => {
    // @covers REQ-225#same-content-redeploy
    it('同じ中身の版を出し直すと、前の版の印と見分けられる印が書き出される', () => {
      const before = stampOf(run('learningNext'))
      const again = stampOf(run('learningSameAgain'))
      expect(before, '仕込み: 前の版に印が無い').not.toBeNull()
      expect(again, `出し直した版に印が無い:\n${tail(run('learningSameAgain'))}`).not.toBeNull()
      expect(again, '出し直した版の印が前の版と同じ').not.toEqual(before)
    })

    // @covers REQ-225#source-value-unreadable
    it('版を見分ける元の値が読めなくても、版の印が書き出され、同じ中身の前の版と見分けられる', () => {
      const first = stampOf(run('noSourceFirst'))
      const again = stampOf(run('noSourceAgain'))
      expect(first, `元の値が読めないと版の印が書き出されない:\n${tail(run('noSourceFirst'))}`).not.toBeNull()
      expect(again, `元の値が読めないと版の印が書き出されない:\n${tail(run('noSourceAgain'))}`).not.toBeNull()
      expect(again, '元の値が読めないとき、出し直した版の印が前の版と同じ').not.toEqual(first)
    })
  })

  describe('REQ-226 版の印を書き出せなければ本番に出さない', () => {
    // @covers REQ-226#write-fails-blocks-release
    it('版の印を配信物に書き出せないと、配備の手続きは失敗で終わり、配信を呼ばない', () => {
      const r = run('stampBlocked')
      expect(r.code, `書き出せないのに手続きが成功で終わった:\n${tail(r)}`).not.toBe(0)
      expect(deploysOf(r), '印の無い版を配信している').toEqual([])
    })
  })

  describe('REQ-351 固定した版の配備の道具で配信する', () => {
    // @covers REQ-351#learning-uses-pinned-tool
    it('学び側の配備の手続きは、固定した版の配備の道具で配信し、別の版の道具を呼ばない', () => {
      const r = run('learningFirst')
      expect(deploysOf(r).length, `配信していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(deploysOf(r).map((e) => e.tool), '固定した版でない道具で配信している').toEqual(deploysOf(r).map(() => 'pinned'))
      expect(wranglerCalls(r).filter((e) => e.tool !== 'pinned'), '別の版の道具を呼んでいる').toEqual([])
    })

    // @covers REQ-351#portal-uses-pinned-tool
    it('まなびばの配備の手続きは、設定を組む場所がリポジトリの外でも、固定した版の配備の道具で配信する', () => {
      const r = run('portal')
      expect(deploysOf(r).length, `配信していない:\n${tail(r)}`).toBeGreaterThan(0)
      expect(deploysOf(r).map((e) => e.tool), '固定した版でない道具で配信している').toEqual(deploysOf(r).map(() => 'pinned'))
      expect(wranglerCalls(r).filter((e) => e.tool !== 'pinned'), '別の版の道具を呼んでいる').toEqual([])
    })
  })

  describe('REQ-352 固定した版が入っていなければ配信せずに止まる', () => {
    // @covers REQ-352#learning-stops-without-pinned-tool
    it('固定した版の道具が入っていないと、学び側の配備の手続きは別の版に倒さず、何も配信せず失敗で終わる', () => {
      const r = run('learningUnpinned')
      expect(deploysOf(r), '固定した版が無いのに配信している').toEqual([])
      expect(r.code, `固定した版が無いのに手続きが成功で終わった:\n${tail(r)}`).not.toBe(0)
    })

    // @covers REQ-352#portal-stops-without-pinned-tool
    it('固定した版の道具が入っていないと、まなびばの配備の手続きは別の版に倒さず、何も配信せず失敗で終わる', () => {
      const r = run('portalUnpinned')
      expect(deploysOf(r), '固定した版が無いのに配信している').toEqual([])
      expect(r.code, `固定した版が無いのに手続きが成功で終わった:\n${tail(r)}`).not.toBe(0)
    })
  })
})
