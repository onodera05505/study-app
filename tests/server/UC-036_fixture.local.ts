/** UC-036（手元の配備に API と画面を当てる道具 5 つ）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行（操作名を snake_case にした `scripts/<名前>`）と、
 *  契約の先頭の決まり（request の各欄は同じ名前の引数。learning は第 1 引数）:
 *  - checkApi ＝ `bash scripts/check_api.sh [<learning>]`（手元に学びの配備を起こして当てる）
 *  - checkPortalApi ＝ `bash scripts/check_portal_api.sh`（手元にまなびばの配備を起こして当てる）
 *  - auditFixtures ＝ `node scripts/audit_fixtures.mjs [--base <場所>] [--json <ファイル>]`（起きている学びの配備に当てる）
 *  - auditScreens ＝ `bash scripts/audit_screens.sh [<learning>] [--out <置き場>] [--limit <数>]`
 *  - checkSsoFlow ＝ `python3 scripts/check_sso_flow.py`（起きているまなびばと学びの配備に当てる）
 *  `.sh` と `.py`・`.mjs` が同じ名前で並ぶ道具は、契約の summary（配備を起こす）と事前条件から、配備を起こす `.sh` を入口とした。
 *
 *  影の根（toolShadow）は、リポジトリを一時の置き場に写した物。読むだけの重い置き場（data・public・node_modules など）は
 *  リンクにし、ほかは写す。組み立ての出力（dist・portal/dist）は写さず、道具が影の根の中に作る。
 *  手元の保存先（`.wrangler`・`portal/.wrangler`。UC の事前条件「手元の保存先がそろっている」）は、この作業ツリーに無ければ
 *  同じリポジトリの主の作業ツリーの物を、影の根へ写す（APFS では複製の印だけ）。元の保存先は読むだけで書き換えない。
 *  道具は影の根を作業の場所にして回し、終わったら道具が起こしたプロセスをプロセスグループごと止める。
 *  外への通信: 道具が起こす wrangler の利用統計の送信は環境変数で止める。それ以外の外への口は道具の中にあり、ここでは塞げない。 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 登録簿（src/shared/targets.json）の学びの key。 */
export const REGISTRY_KEYS = Object.keys(JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Record<string, unknown>).filter(
  (k) => !k.startsWith('_'),
)

/** 写さずにリンクにする最上位の置き場（読むだけで重い物）。 */
const LINKED = new Set(['data', 'public', 'node_modules', '.harness', 'apm_modules'])
/** 影の根に置かない最上位の物（道具が作り直す物と作業の跡）。手元の保存先は別に写す。 */
const OMITTED = new Set(['.git', 'dist', 'coverage', 'full', 'backups', '.wrangler'])

const temps: string[] = []

/** 作った影の根をすべて消す。 */
export async function removeTemps(): Promise<void> {
  for (const dir of temps) sweepUnder(dir)
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** 影の根 1 つを消す（ほかの影の根は残す）。 */
export async function removeShadow(s: { root: string }): Promise<void> {
  const base = dirname(s.root)
  const i = temps.indexOf(base)
  if (i >= 0) temps.splice(i, 1)
  await rm(base, { recursive: true, force: true })
}

/** 同じリポジトリの主の作業ツリー（git の共通の置き場の親）。 */
function mainWorktree(): string | null {
  const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  return r.status === 0 ? dirname(r.stdout.trim()) : null
}

/** 手元の保存先（rel は `.wrangler` か `portal/.wrangler`）の在りか。この作業ツリー、無ければ主の作業ツリー。 */
export function localStore(rel: string): string | null {
  for (const base of [ROOT, mainWorktree()]) if (base && prepared(join(base, rel))) return join(base, rel)
  return null
}

/** 手元の保存先がそろっているか（D1 のどれかに構造の変更が当たっている）。置き場だけあって中身の無い保存先は、そろっていない。 */
function prepared(store: string): boolean {
  const dir = join(store, 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')
  if (!existsSync(dir)) return false
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sqlite') && n !== 'metadata.sqlite')
    .some((n) => {
      const db = new DatabaseSync(join(dir, n), { readOnly: true })
      try {
        return ((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get() as { n: number }).n ?? 0) > 0
      } catch {
        return false
      } finally {
        db.close()
      }
    })
}

export type Shadow = {
  root: string
  path: (rel: string) => string
  read: (rel: string) => string
  write: (rel: string, content: string) => void
}

const cloneInto = (from: string[], to: string) => {
  if (from.length === 0) return
  const args = process.platform === 'darwin' ? ['-cR', ...from, `${to}/`] : ['-R', '--reflink=auto', ...from, `${to}/`]
  const r = spawnSync('cp', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`影の根を写せない: ${r.stderr}`)
}

/** 影の根を作る。stores は手元の保存先も写すか（既定は写す）。 */
export function toolShadow(opts: { stores?: boolean } = {}): Shadow {
  const base = mkdtempSync(join(tmpdir(), 'uc036-'))
  temps.push(base)
  const root = join(base, 'root')
  mkdirSync(root)
  const cloned: string[] = []
  for (const name of readdirSync(ROOT)) {
    if (OMITTED.has(name)) continue
    if (LINKED.has(name)) symlinkSync(join(ROOT, name), join(root, name))
    else cloned.push(join(ROOT, name))
  }
  cloneInto(cloned, root)
  for (const rel of ['portal/dist', 'portal/.wrangler']) spawnSync('rm', ['-rf', join(root, rel)])
  if (opts.stores ?? true) {
    for (const rel of ['.wrangler', 'portal/.wrangler']) {
      const from = localStore(rel)
      if (!from) throw new Error(`手元の保存先 ${rel} が無い（UC-036 の事前条件。作業ツリーか主の作業ツリーに要る）`)
      cloneInto([from], dirname(join(root, rel)))
    }
  }
  const path = (rel: string) => join(root, rel)
  return {
    root,
    path,
    read: (rel) => readFileSync(path(rel), 'utf8'),
    write: (rel, content) => {
      mkdirSync(dirname(path(rel)), { recursive: true })
      writeFileSync(path(rel), content)
    },
  }
}

export type ToolRun = {
  status: number | null
  stdout: string
  stderr: string
  out: string
  /** 道具が終えた時点で、道具のプロセスグループに残っていたプロセスの数。 */
  leftover: number
  /** 道具を起こす直前に、watchPorts の口を掴んで（待ち受けて）いたプロセス。 */
  heldBefore: number[]
  /** 道具が終えた時点で、watchPorts の口を掴んで（待ち受けて）いたプロセス。 */
  portHolders: number[]
  /** 道具が終えた時点で、作業の場所が影の根の下にあったプロセス（道具のプロセスグループの外に移った子を含む。REQ-675）。 */
  underRoot: number[]
  timedOut: boolean
}

/**
 * 運用者のシェルと同じ環境（道具は運用者がシェルから回す）。テストの走り手（`npx vitest`）が子の環境に足した物を外す:
 * PATH の `node_modules/.bin` と、走り手の node の置き場が Volta の版の置き場（`$VOLTA_HOME/tools/image/`）ならその置き場、
 * npm が足す `npm_` で始まる変数、Volta が自分の下で起こした道具に付ける再帰の印（`_VOLTA_TOOL_RECURSION`）。
 * 外さないと、道具の `npx` が運用者の PATH の先頭の物（Volta なら `npx` の shim。shim が npm を子として起こす）でなく、
 * 走り手の node の置き場の npx に直に当たり、運用者の回と配備のプロセスの連なり（npx → npm exec → node wrangler → workerd）が変わる。
 */
function operatorEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('npm_') && k !== '_VOLTA_TOOL_RECURSION') env[k] = v
  const voltaImages = process.env.VOLTA_HOME ? join(process.env.VOLTA_HOME, 'tools', 'image') + '/' : null
  const runnerNode = dirname(process.execPath)
  env.PATH = (process.env.PATH ?? '')
    .split(':')
    .filter((d) => d !== '' && !d.endsWith('/node_modules/.bin') && !(voltaImages && d === runnerNode && d.startsWith(voltaImages)))
    .join(':')
  return env
}

/** 子の環境（運用者のシェルと同じ環境に、wrangler の利用統計の送信を止める変数を足す）。 */
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...operatorEnv(),
  WRANGLER_SEND_METRICS: 'false',
  NO_UPDATE_NOTIFIER: '1',
  ...extra,
})

/** プロセスグループに残っているプロセスの数。 */
function groupSize(pgid: number): number {
  const r = spawnSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' })
  return r.stdout.split('\n').filter((l) => l.trim() !== '').length
}

/** ports の口を待ち受けているプロセスの番号。 */
export function listeners(ports: readonly number[]): number[] {
  const out = new Set<number>()
  for (const port of ports) {
    const r = spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    for (const l of r.stdout.split('\n')) if (l.trim() !== '') out.add(Number(l.trim()))
  }
  return [...out].sort((a, b) => a - b)
}

/** 作業の場所が dir の下にあるプロセスの番号（このプロセス自身を除く）。 */
export function processesUnder(dir: string): number[] {
  let base: string
  try {
    base = realpathSync(dir)
  } catch {
    return []
  }
  const r = spawnSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8' })
  const out = new Set<number>()
  let pid = 0
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0 && pid !== process.pid && (line.slice(1) === base || line.slice(1).startsWith(`${base}/`))) out.add(pid)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * 作業の場所が dir の下にあるプロセスを止める（後片付け）。道具の子が別のプロセスグループに移っても、作業の場所は影の根の下に残るので、
 * グループごと止めるだけでは残るプロセスもここで止める。
 */
export function sweepUnder(dir: string): void {
  for (const pid of processesUnder(dir)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // もう居ない
    }
  }
}

/** 学びの API の検査の道具が立てる偽のまなびばの口（正本は scripts/check_api.py の SSO_FAKE_PORT）。 */
const API_FAKE_PORT = (() => {
  const m = /^SSO_FAKE_PORT\s*=\s*(\d+)/m.exec(readFileSync(join(ROOT, 'scripts', 'check_api.py'), 'utf8'))
  if (!m) throw new Error('scripts/check_api.py から SSO_FAKE_PORT を読めない')
  return Number(m[1])
})()

/** 道具と前提が使う手元の決まった口。 */
export const PORTS = {
  screens: 8787,
  learning: 8788,
  ssoPortal: 8790,
  portal: 8791,
  apiFake: API_FAKE_PORT,
  ssoFake: 8793,
} as const
/** すべての口（口を名指さない呼び方はこれを使う）。 */
export const ALL_PORTS: number[] = Object.values(PORTS)
/** 操作ごとに使う口（道具が起こす配備・道具が立てる偽物・前提の配備）。口の重ならない操作は並べて回せる。 */
export const PORTS_OF = {
  checkApi: [PORTS.learning, PORTS.apiFake],
  checkPortalApi: [PORTS.portal],
  auditFixtures: [PORTS.screens, PORTS.ssoFake],
  auditScreens: [PORTS.screens, PORTS.ssoFake],
  checkSsoFlow: [PORTS.ssoPortal, PORTS.learning],
} as const

/** 道具が手元の配備を起こす操作ごとの、その配備に使う口（REQ-675 の「道具が配備に使う口」）。 */
export const DEPLOY_PORT_OF = { checkApi: PORTS.learning, checkPortalApi: PORTS.portal, auditScreens: PORTS.screens } as const

/** 操作ごとの、影の根の配備の調べ口の番号（separateInspector。道具が配備を起こす操作だけ）。 */
export const INSPECTOR_OF = { checkApi: 9311, checkPortalApi: 9312, auditScreens: 9313 } as const

const lockOf = (port: number) => join(tmpdir(), `study-app-uc036-port-${port}.lock`)
/** 今の非同期の流れが持っている口（同じ流れの中で重ねて取るときは取り直さない）。 */
const holding = new AsyncLocalStorage<Set<number>>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 口 1 つの鍵を取る（置き場の作成で取る。持ち主のプロセスが居なくなった鍵は外す）。 */
async function acquire(port: number): Promise<void> {
  const lock = lockOf(port)
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), String(process.pid))
      return
    } catch {
      let owner = 0
      try {
        owner = Number(readFileSync(join(lock, 'pid'), 'utf8'))
      } catch {
        owner = 0
      }
      if (owner > 0 && !alive(owner)) rmSync(lock, { recursive: true, force: true })
      else await new Promise((ok) => setTimeout(ok, 250))
    }
  }
}

/**
 * 口の鍵を取って body を回す。ports を省くとすべての口。鍵は口ごとにあり、プロセスとテストのファイルをまたいで効く
 * （口の重なる物どうしだけが順番を待つ）。番号の小さい口から取るので、待ち合いで止まらない。同じ非同期の流れの中で既に持つ口は取り直さない。
 */
export async function withPorts<T>(body: () => Promise<T>, ports: readonly number[] = ALL_PORTS): Promise<T> {
  const mine = holding.getStore() ?? new Set<number>()
  const need = [...new Set(ports)].filter((p) => !mine.has(p)).sort((x, y) => x - y)
  const got: number[] = []
  try {
    for (const p of need) {
      await acquire(p)
      got.push(p)
    }
    return await holding.run(new Set([...mine, ...need]), body)
  } finally {
    for (const p of got) rmSync(lockOf(p), { recursive: true, force: true })
  }
}

/** このプロセスが起こして、まだ止めていない道具のプロセスグループ。 */
const liveGroups = new Set<number>()
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // もう居ない
  }
}
/** このプロセスが終わるとき（時間切れで止められたときを含む）、起こした道具のプロセスグループを孫ごと止める。 */
let exitHooked = false
function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  const stopAll = () => {
    for (const pid of liveGroups) killGroup(pid)
    liveGroups.clear()
  }
  process.on('exit', stopAll)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      stopAll()
      if (process.listenerCount(signal) === 1) process.exit(1)
    })
  }
}

/**
 * 道具のプロセスグループの見張りを、このプロセスと別のグループで起こす。このプロセスが居なくなったら（呼んだ側が時間切れで
 * このプロセスのグループを止めた・強く止められたときを含む）、道具のプロセスグループを孫ごと止め、影の根の置き場を消して終わる。
 * 道具が普通に終わったときは、見張りをこのプロセスが止める。
 */
function guardGroup(pgid: number, shadowBase: string): ChildProcess {
  // 影の根の置き場も、止めたあとに消す（置き場の名前は引数で渡し、シェルの文に埋め込まない）
  const script =
    'while kill -0 "$1" 2>/dev/null; do sleep 1; done; kill -9 -"$2" 2>/dev/null; ' +
    'base=$(cd "$3" 2>/dev/null && pwd -P); [ -n "$base" ] && lsof -d cwd -Fpn 2>/dev/null | awk -v b="$base" \'/^p/ { p = substr($0, 2) } /^n/ { n = substr($0, 2); if (n == b || index(n, b "/") == 1) print p }\' | xargs kill -9 2>/dev/null; ' +
    'sleep 1; rm -rf -- "$3"; exit 0'
  const w = spawn('/bin/sh', ['-c', script, 'uc036-guard', String(process.pid), String(pgid), shadowBase], { detached: true, stdio: 'ignore' })
  w.unref()
  return w
}

/**
 * 影の根を作業の場所にして道具を回す（command の先頭は bash・python3・node、2 番目は `scripts/` からの相対の道具）。
 * 道具が終わったら、道具のプロセスグループに残ったプロセスの数を数えて（leftover）、グループごと止める。口の鍵（withPorts）を取って回す。
 */
export function runTool(
  shadow: Shadow,
  command: string[],
  opts: {
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
    ports?: readonly number[]
    /** 道具を起こす直前と終えた時点で、待ち受けているプロセスを取る口。 */
    watchPorts?: readonly number[]
  } = {},
): Promise<ToolRun> {
  return withPorts(() => runUnlocked(shadow, command, opts), opts.ports ?? ALL_PORTS)
}

function runUnlocked(shadow: Shadow, command: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; watchPorts?: readonly number[] }): Promise<ToolRun> {
  hookExit()
  const watched = opts.watchPorts ?? []
  const heldBefore = listeners(watched)
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: shadow.root,
      env: childEnv(opts.env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.pid !== undefined) liveGroups.add(child.pid)
    const watchdog = child.pid === undefined ? undefined : guardGroup(child.pid, dirname(shadow.root))
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const kill = () => killGroup(child.pid!)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs ?? 600_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const leftover = groupSize(child.pid!)
      const portHolders = listeners(watched)
      const underRoot = processesUnder(dirname(shadow.root))
      kill()
      sweepUnder(dirname(shadow.root))
      liveGroups.delete(child.pid!)
      if (watchdog?.pid !== undefined) killGroup(watchdog.pid)
      // パイプを握った孫を止めたあとに close を待たずに返す
      setTimeout(() => {
        resolve({
          status: code,
          stdout,
          stderr,
          out: `${stdout}\n${stderr}`.split(shadow.root).join('<root>'),
          leftover,
          heldBefore,
          portHolders,
          underRoot,
          timedOut,
        })
      }, 200)
    })
  })
}

export const checkApi = (s: Shadow, learning?: string, env?: NodeJS.ProcessEnv) =>
  runTool(s, ['bash', 'scripts/check_api.sh', ...(learning ? [learning] : [])], { env, watchPorts: [DEPLOY_PORT_OF.checkApi] })
export const checkPortalApi = (s: Shadow, env?: NodeJS.ProcessEnv) =>
  runTool(s, ['bash', 'scripts/check_portal_api.sh'], { env, watchPorts: [DEPLOY_PORT_OF.checkPortalApi] })
export const auditFixtures = (s: Shadow, args: string[], env?: NodeJS.ProcessEnv) =>
  runTool(s, ['node', 'scripts/audit_fixtures.mjs', ...args], {
    timeoutMs: 120_000,
    env,
  })
export const auditScreens = (s: Shadow, args: string[], env?: NodeJS.ProcessEnv) =>
  runTool(s, ['bash', 'scripts/audit_screens.sh', ...args], {
    timeoutMs: 900_000,
    env,
    watchPorts: [DEPLOY_PORT_OF.auditScreens],
  })

/**
 * 影の根の外に、空の一時の置き場を作る（REQ-668。道具を回す環境の TMPDIR にこれを渡し、回した後に残る物を見る）。
 * 道具が示す場所と比べるので、シンボリックリンクを解いた実の場所を返す（macOS の /var は /private/var を指す）。
 */
export function emptyTemp(s: Shadow): string {
  const dir = join(dirname(s.root), `tmp-${temps.length}-${Date.now()}`)
  mkdirSync(dir)
  return realpathSync(dir)
}

/** 道具の標準出力から ToolError を読む（全体を JSON として読み、読めなければ最後の空でない行。CLAUDE.md の「操作 → 入口」）。 */
export function toolErrorOf(stdout: string): { code: string; reason: string } | null {
  const read = (text: string) => {
    try {
      const e = (JSON.parse(text) as { error?: { code?: unknown; reason?: unknown } })?.error
      return e && typeof e.code === 'string' ? { code: e.code, reason: typeof e.reason === 'string' ? e.reason : '' } : null
    } catch {
      return null
    }
  }
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  return read(stdout.trim()) ?? (lines.length > 0 ? read(lines[lines.length - 1]) : null)
}

// ---------------------------------------------------------------------------
// 配備が成功の状態で読めない答えを返す場合（REQ-667）

/** 書き換える問い合わせ（GET の経路の正規表現）と、代わりに返す本文（空の本文か、期待した欄を持たない JSON）。 */
export type AnswerRewrite = { path: string; body: string }

/** 問い合わせごとに、書き換えた答えを返したことを数える手元の口（書き換えた問い合わせの経路を 1 件ずつ受ける）。 */
export async function hitCounter(): Promise<{ url: string; hits: () => string[]; close: () => Promise<void> }> {
  const got: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      got.push(body)
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((ok, ng) => {
    server.once('error', ng)
    server.listen(0, '127.0.0.1', ok)
  })
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/hit`,
    hits: () => [...got],
    close: () =>
      new Promise((ok) => {
        server.close(() => ok())
        server.closeAllConnections()
      }),
  }
}

/** 答えの書き換えの本体（配備の包みとこのプロセスの中の包みで同じ文を使う）。元の答えが 2xx の GET だけを書き換える。 */
const REWRITE_BODY = `
  const url = new URL(req.url)
  const rule = req.method === 'GET' && res.status >= 200 && res.status < 300 ? RULES.find((r) => new RegExp(r.path).test(url.pathname)) : undefined
  if (!rule) return res
  if (HIT) {
    try {
      await fetch(HIT, { method: 'POST', body: url.pathname + url.search })
    } catch {
      // 数える口に届かなくても答えは書き換える
    }
  }
  return new Response(rule.body, { status: res.status, headers: { 'content-type': 'application/json' } })
`

/**
 * 影の根の学び側の配備の設定（wrangler.jsonc の写し）の入口を、元の入口の答えのうち rules に当たる 2xx の GET の答えを書き換える包みに
 * 差し替える（画面の採取が起こす配備に使う）。入口のコードは読まず、元の入口の default export の fetch をそのまま呼ぶ。
 * hitUrl があれば、書き換えるたびにその経路をそこへ送る。
 */
export function rewriteAnswers(s: Shadow, rules: AnswerRewrite[], hitUrl?: string): void {
  const config = 'wrangler.jsonc'
  const text = s.read(config)
  const m = text.match(/"main"\s*:\s*"([^"]+)"/)
  if (!m) throw new Error(`${config} に main が無い`)
  const original = m[1]
  const wrapper = `${dirname(original)}/__uc036_rewrite_answers.ts`
  const rel = `./${original.split('/').pop()!.replace(/\.ts$/, '')}`
  s.write(
    wrapper,
    [
      `import worker from '${rel}'`,
      `export * from '${rel}'`,
      `const target = worker as unknown as { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> }`,
      `const RULES: { path: string; body: string }[] = ${JSON.stringify(rules)}`,
      `const HIT: string | null = ${JSON.stringify(hitUrl ?? null)}`,
      `export default {`,
      `  ...(worker as object),`,
      `  async fetch(req: Request, env: unknown, ctx: unknown): Promise<Response> {`,
      `    const res = await target.fetch(req, env, ctx)`,
      REWRITE_BODY,
      `  },`,
      `}`,
      '',
    ].join('\n'),
  )
  s.write(config, text.replace(m[0], `"main": "${wrapper}"`))
}

/** app の答えのうち rules に当たる 2xx の GET の答えを書き換える包み（このプロセスの中に立てる配備に使う）。 */
export function rewrittenApp(app: FetchApp, rules: AnswerRewrite[], hitUrl?: string): FetchApp {
  const rewrite = new Function('RULES', 'HIT', 'req', 'res', `return (async () => {${REWRITE_BODY}})()`) as (
    rules: AnswerRewrite[],
    hit: string | null,
    req: Request,
    res: Response,
  ) => Promise<Response>
  return {
    fetch: async (req, env, ctx) => rewrite(rules, hitUrl ?? null, req, await app.fetch(req, env, ctx)),
  }
}
export const checkSsoFlow = (s: Shadow) => runTool(s, ['python3', 'scripts/check_sso_flow.py'], { timeoutMs: 120_000 })

/**
 * 影の根の配備の設定（wrangler.jsonc・portal/wrangler.jsonc の写し）に、手元の配備の調べ口（inspector）の番号を足す。
 * 配備の道具は調べ口を既定の 1 つの番号で開くので、2 つの道具が同時に配備を起こすと、その口を取り合って起動に失敗する。
 * 影の根ごとに違う番号にすると、口の重ならない道具を並べて回せる（リポジトリの設定は変えない。配備の口と動きは変わらない）。
 */
export function separateInspector(s: Shadow, port: number): void {
  for (const rel of ['wrangler.jsonc', 'portal/wrangler.jsonc']) {
    if (!existsSync(s.path(rel))) continue
    const text = s.read(rel)
    if (/"inspector_port"/.test(text)) throw new Error(`${rel} に既に inspector_port がある`)
    const at = text.indexOf('{')
    s.write(rel, `${text.slice(0, at + 1)}\n  "dev": { "inspector_port": ${port} },${text.slice(at + 1)}`)
  }
}

/** 道具が起こしていない、既に応じている手元の配備の代わり（REQ-675）。 */
export type ExistingDeployment = {
  pid: number
  /** プロセスが生きているか。 */
  alive: () => boolean
  /** 口の死活確認（/api/health）に 200 で応じるか。 */
  responds: () => Promise<boolean>
  close: () => Promise<void>
}

/** 口の /api/health に GET を 1 回当てて、200 で応じたか。 */
function healthy(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
      res.resume()
      ok(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => ok(false))
  })
}

/**
 * port の手元の口に、このプロセスとも道具とも別のプロセスグループで、作業の場所を影の根の外に置いて、どの要求にも 200 の {"ok": true} で応える小さなプロセスを起こす
 * （死活確認に応じる）。このプロセスが居なくなれば自分で終わる。呼ぶ側が口の鍵（withPorts）を持つ。応じるまで待って返す。
 */
export async function startExistingDeployment(port: number): Promise<ExistingDeployment> {
  hookExit()
  const script = [
    "const http = require('node:http')",
    `const parent = ${process.pid}`,
    "http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{\"ok\": true}') })",
    `  .listen(${port}, '127.0.0.1')`,
    'setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 1000)',
  ].join('\n')
  // 作業の場所は影の根の外（OS の一時の置き場）に置く。道具の居残りの見方（作業の場所が影の根の下にあるプロセス）に映らないように
  const child = spawn(process.execPath, ['-e', script], { cwd: tmpdir(), detached: true, stdio: 'ignore' })
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new Error('前提: 既に応じている配備の代わりを起こせない')
  liveGroups.add(pid)
  const close = async () => {
    killGroup(pid)
    liveGroups.delete(pid)
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 100))
  }
  for (let i = 0; ; i++) {
    if (await healthy(port)) break
    if (i >= 100) {
      await close()
      throw new Error(`前提: 口 ${port} の既に応じている配備の代わりが応じない`)
    }
    await new Promise((ok) => setTimeout(ok, 100))
  }
  return { pid, alive: () => alive(pid), responds: () => healthy(port), close }
}

/** 学び key の登録簿の画面の名（src/shared/targets.json の title。画面の見出し（index.html の title）に出る名）。 */
export function screenNameOf(key: string): string {
  const entry = (JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Record<string, { title?: unknown }>)[key]
  if (!entry || typeof entry.title !== 'string') throw new Error(`前提: 登録簿に学び ${key} の画面の名が無い`)
  return entry.title
}

/**
 * 道具が起こしていない、道具が配備に使う口を掴むプロセスを起こす（REQ-675）。このプロセスとも道具とも別のプロセスグループで、作業の場所を
 * 影の根の外（OS の一時の置き場）に置く。このプロセスが居なくなれば自分で終わる。handler は要求ごとに呼ぶ node の文（req・res・held を使う）。
 * 呼ぶ側が口の鍵（withPorts）を持つ。口を待ち受けるまで待って返す。
 */
async function startForeignProcess(port: number, handler: string, log: string): Promise<{ pid: number; close: () => Promise<void> }> {
  hookExit()
  const script = [
    "const http = require('node:http')",
    "const fs = require('node:fs')",
    `const parent = ${process.pid}`,
    `const LOG = ${JSON.stringify(log)}`,
    'const held = []',
    'let released = false',
    "const ok = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{\"ok\": true}') }",
    "process.on('SIGUSR2', () => { released = true; for (const res of held.splice(0)) { try { ok(res) } catch {} } })",
    'http.createServer((req, res) => {',
    '  req.resume()',
    "  try { fs.appendFileSync(LOG, JSON.stringify({ method: req.method, path: (req.url || '/').split('?')[0] }) + '\\n') } catch {}",
    `  ${handler}`,
    `}).listen(${port}, '127.0.0.1')`,
    'setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 1000)',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script], { cwd: tmpdir(), detached: true, stdio: 'ignore' })
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new Error('前提: 口を掴むプロセスを起こせない')
  liveGroups.add(pid)
  const close = async () => {
    killGroup(pid)
    liveGroups.delete(pid)
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 100))
  }
  for (let i = 0; ; i++) {
    if (listeners([port]).includes(pid)) break
    if (i >= 100 || !alive(pid)) {
      await close()
      throw new Error(`前提: 口 ${port} を掴むプロセスが口を待ち受けない`)
    }
    await new Promise((ok) => setTimeout(ok, 100))
  }
  return { pid, close }
}

/** 口を掴むプロセスが受けた要求（受けた順。経路は問い合わせの文字列を除く）。 */
export type ReceivedRequest = { method: string; path: string }
const readLog = (log: string): ReceivedRequest[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as ReceivedRequest)
    : []
/** 受けた要求の記録のファイル（止めたあとも読めるよう、影の根の外の置き場に置き、removeTemps で消す）。 */
const logOf = (what: string, port: number) => {
  const dir = mkdtempSync(join(tmpdir(), `uc036-${what}-${port}-`))
  temps.push(dir)
  return join(dir, 'requests.jsonl')
}

/** 道具が起こしていない、既に応じている手元の配備のうち、撮る学びと同じ画面の名を返す物の代わり（REQ-675）。 */
export type SameLearningDeployment = ExistingDeployment & {
  /** 受けた要求（死活確認・画面の名の要求を含む）。 */
  requests: () => ReceivedRequest[]
}

/**
 * port の手元の口に、死活確認（/api/health）にすぐ 200 で応じ、`/api/` の下でない GET（画面）には学び key の登録簿の画面の名を見出し（title）に持つ
 * 画面を返し、ほかの要求には 200 の {"ok": true} で応える、道具が起こしていないプロセスを起こす（startForeignProcess の囲い）。受けた要求を記録する。
 */
export async function startSameLearningDeployment(port: number, key: string): Promise<SameLearningDeployment> {
  const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${screenNameOf(key)}</title></head><body><div id="root"></div></body></html>`
  const log = logOf('same', port)
  const handler = [
    "const path = (req.url || '/').split('?')[0]",
    "if (req.method === 'GET' && !path.startsWith('/api/')) {",
    `  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(${JSON.stringify(page)}); return`,
    '}',
    'ok(res)',
  ].join('\n  ')
  const p = await startForeignProcess(port, handler, log)
  if (!(await healthy(port))) {
    await p.close()
    throw new Error(`前提: 口 ${port} の同じ画面の名の配備の代わりが死活確認に応じない`)
  }
  return { pid: p.pid, alive: () => alive(p.pid), responds: () => healthy(port), requests: () => readLog(log), close: p.close }
}

/** 道具が起こしていない、口を掴んで死活確認に答えないプロセス（REQ-675）。 */
export type SlowHolder = ExistingDeployment & {
  /** 答えずに持っている要求に 200 で答え、これより後の要求にはすぐ 200 で答えるようにする（道具が終えたあとに呼ぶ）。 */
  release: () => void
}

/**
 * port の手元の口を掴み、release を呼ぶまでどの要求（死活確認を含む）にも答えずに持ち、release のあとは 200 の {"ok": true} で答える、
 * 道具が起こしていないプロセスを起こす（startForeignProcess の囲い）。待つ時間の長さに依らない（答えないのは release までずっと）。
 */
export async function startSlowHolder(port: number): Promise<SlowHolder> {
  const log = logOf('slow', port)
  const p = await startForeignProcess(port, 'if (released) ok(res); else held.push(res)', log)
  return {
    pid: p.pid,
    alive: () => alive(p.pid),
    responds: () => healthy(port),
    release: () => {
      try {
        process.kill(p.pid, 'SIGUSR2')
      } catch {
        // もう居ない（alive が false を返す）
      }
    },
    close: p.close,
  }
}

/** 名前の無い例外で落ちたか。 */
export const crashed = (r: ToolRun) => /Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)$/m.test(r.stderr)

/**
 * 影の根の配備の設定（wrangler.jsonc・portal/wrangler.jsonc）の入口を、元の入口の応答から name の応答ヘッダを外す包みに差し替える。
 * 入口のコードは読まず、元の入口の default export の fetch をそのまま呼ぶ（名前のある export も引き継ぐ）。
 */
export function stripResponseHeader(s: Shadow, config: 'wrangler.jsonc' | 'portal/wrangler.jsonc', name: string): void {
  const text = s.read(config)
  const m = text.match(/"main"\s*:\s*"([^"]+)"/)
  if (!m) throw new Error(`${config} に main が無い`)
  const dir = dirname(config) === '.' ? '' : `${dirname(config)}/`
  const original = m[1]
  const wrapper = `${dirname(original)}/__uc036_strip_header.ts`
  const rel = `./${original.split('/').pop()!.replace(/\.ts$/, '')}`
  s.write(
    `${dir}${wrapper}`,
    [
      `import worker from '${rel}'`,
      `export * from '${rel}'`,
      `const target = worker as unknown as { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> }`,
      `export default {`,
      `  ...(worker as object),`,
      `  async fetch(req: Request, env: unknown, ctx: unknown): Promise<Response> {`,
      `    const res = await target.fetch(req, env, ctx)`,
      `    const out = new Response(res.body, res)`,
      `    out.headers.delete(${JSON.stringify(name)})`,
      `    return out`,
      `  },`,
      `}`,
      '',
    ].join('\n'),
  )
  s.write(config, text.replace(m[0], `"main": "${wrapper}"`))
}

// ---------------------------------------------------------------------------
// 手元の保存先（影の根に写した学び側の D1）と、起きている配備の代わりの偽物

/** 影の根の学び側の手元の保存先の SQLite のファイル（利用者の表を持つ物だけ）。 */
export function learningDbs(s: Shadow): string[] {
  const dir = s.path('.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sqlite') && n !== 'metadata.sqlite')
    .map((n) => join(dir, n))
    .filter((f) => {
      const db = new DatabaseSync(f)
      try {
        return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get() !== undefined
      } finally {
        db.close()
      }
    })
}

/** f の SQLite を開いて body に渡し、閉じる。 */
export function withDb<T>(f: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(f)
  try {
    return body(db)
  } finally {
    db.close()
  }
}

/** 保存先の全部の表の行を、表ごとに行の JSON の集まりで取る。 */
export function rowsOf(db: DatabaseSync): Record<string, Set<string>> {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all() as { name: string }[]
  ).map((t) => t.name)
  const out: Record<string, Set<string>> = {}
  for (const t of tables) out[t] = new Set((db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]).map((r) => JSON.stringify(r)))
  return out
}

/** 利用者の表（users）の id と email。 */
export const usersOf = (db: DatabaseSync) =>
  db.prepare('SELECT id, email FROM users ORDER BY email').all() as {
    id: string
    email: string
  }[]

/** port の手元の口に、どの要求にも 200 の {"ok": true} で応える偽物を立てる（起きている配備の、要件と食い違う代わり）。 */
export async function serveWrong(port: number): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok": true}')
  })
  await new Promise<void>((ok, ng) => {
    server.once('error', ng)
    server.listen(port, '127.0.0.1', ok)
  })
  return () => new Promise((ok) => server.close(() => ok()))
}

// ---------------------------------------------------------------------------
// 手元の SSO の一巡の前提（UC-036 の事前条件。起こし方の正本は scripts/check_sso_flow.py の頭の説明）:
// まなびば（8790）と学び mkt（8788）を同じ手元用の共有秘密で起こし、学び側の利用者をまなびばのアカウントに手元で移して
// 検査用の管理者を作る。ここでは配備の道具（wrangler dev）を起こさず、まなびばと学び側の app をこのプロセスの中で手元の口に立てる。
// まなびばの保存先は、影の根に写した手元の保存先（portal/.wrangler）に、アカウントの移しの道具を `--local` で回した物を使う。

/** 事前条件の値。正本の scripts/check_sso_flow.py から読む（口・学び・メールとパスワード・共有秘密・トークンの署名の秘密）。 */
export const SSO_FLOW = (() => {
  const text = readFileSync(join(ROOT, 'scripts', 'check_sso_flow.py'), 'utf8')
  const pick = (re: RegExp, what: string) => {
    const m = re.exec(text)
    if (!m) throw new Error(`scripts/check_sso_flow.py から ${what} を読めない`)
    return m[1]
  }
  return {
    portalPort: Number(pick(/^PORTAL\s*=\s*"http:\/\/127\.0\.0\.1:(\d+)"/m, 'まなびばの口')),
    learningPort: Number(pick(/APP\s*=\s*"http:\/\/127\.0\.0\.1:(\d+)"/m, '学びの口')),
    learning: pick(/wrangler dev --env ([a-z]+)/, '学び'),
    secret: pick(/SSO_SECRET:(\S+)/, '共有秘密'),
    jwtSecret: pick(/JWT_SECRET:(\S+)/, 'トークンの署名の秘密'),
    admin: pick(/^EMAIL\s*=\s*"([^"]+)"/m, 'メール'),
    password: pick(/\bPW\s*=\s*"([^"]+)"/, 'パスワード'),
  }
})()

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

/** 囲いの環境（子の node の外向きの接続を断ち、代理を届かない所に向け、資格情報を無効にする。手元の口は代理を通さない）。 */
export function fencedEnv(s: Shadow): NodeJS.ProcessEnv {
  const guard = join(dirname(s.root), 'net-guard.cjs')
  if (!existsSync(guard)) writeFileSync(guard, NET_GUARD)
  return {
    NODE_OPTIONS: `--require ${guard}`,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    CLOUDFLARE_API_TOKEN: 'fenced-invalid-token-do-not-use',
  }
}

/** 既にある SQLite のファイルを D1 の口で包む（prepare → bind → first / all / run / raw、batch、exec）。 */
export function d1OfFile(db: DatabaseSync): unknown {
  type Param = string | number | bigint | null | Uint8Array
  const toParam = (v: unknown): Param =>
    v === undefined || v === null
      ? null
      : typeof v === 'boolean'
        ? v
          ? 1
          : 0
        : typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v instanceof Uint8Array
          ? v
          : String(v)
  const meta = () => {
    const row = db.prepare('select changes() as changes, last_insert_rowid() as last_row_id').get() as { changes: number; last_row_id: number }
    return {
      changes: row.changes,
      last_row_id: row.last_row_id,
      duration: 0,
      rows_read: 0,
      rows_written: 0,
      size_after: 0,
      changed_db: row.changes > 0,
    }
  }
  const statement = (sql: string, params: Param[] = []): any => ({
    bind: (...values: unknown[]) => statement(sql, values.map(toParam)),
    first: async (column?: string) => {
      const row = (db.prepare(sql).get(...params) as Record<string, unknown> | undefined) ?? null
      return row === null ? null : column === undefined ? row : (row[column] ?? null)
    },
    all: async () => ({
      results: db.prepare(sql).all(...params),
      success: true,
      meta: meta(),
    }),
    run: async () => ({
      results: db.prepare(sql).all(...params),
      success: true,
      meta: meta(),
    }),
    raw: async (options?: { columnNames?: boolean }) => {
      const st = db.prepare(sql)
      st.setReturnArrays(true)
      const rows = st.all(...params)
      return options?.columnNames ? [st.columns().map((c) => c.name), ...rows] : rows
    },
  })
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      db.exec('BEGIN')
      try {
        const out = []
        for (const st of statements) out.push(await st.all())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    exec: async (sql: string) => {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
}

type FetchApp = {
  fetch: (req: Request, env: unknown, ctx: unknown) => Response | Promise<Response>
}

/** app を env の束縛で手元の口 port に立てる。 */
export async function listenApp(app: FetchApp, env: unknown, port: number): Promise<() => Promise<void>> {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) for (const x of v) headers.append(k, x)
    }
    try {
      const r = await app.fetch(
        new Request(`http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url ?? '/'}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' || chunks.length === 0 ? undefined : Buffer.concat(chunks),
          redirect: 'manual',
        }),
        env,
        ctx,
      )
      if (process.env.UC036_TRACE) process.stderr.write(`[${port}] ${req.method} ${req.url} → ${r.status} ${r.headers.get('location') ?? ''}\n`)
      // 見出しの名前は配備の道具（workerd）と同じく語の頭を大文字にして返す（大文字と小文字を区別して読む呼び手がある）
      const canonical = (k: string) => k.replace(/(^|-)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
      const out: Record<string, string | string[]> = {}
      r.headers.forEach((v, k) => {
        if (k !== 'set-cookie') out[canonical(k)] = v
      })
      const cookies = (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
      if (cookies.length) out['Set-Cookie'] = cookies
      res.writeHead(r.status, out)
      res.end(Buffer.from(await r.arrayBuffer()))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(e))
    }
  })
  await new Promise<void>((ok, ng) => {
    server.once('error', ng)
    server.listen(port, '127.0.0.1', ok)
  })
  return () =>
    new Promise((ok) => {
      // 開いたままの接続（keep-alive）も切って、口をすぐに空ける
      server.close(() => ok())
      server.closeAllConnections()
    })
}

export type SsoPair = {
  /** まなびばの保存先（このプロセスの中の SQLite）。 */
  portalSqlite: DatabaseSync
  /** まなびばのアカウントのメール（並べた物）。 */
  accounts: () => string[]
  close: () => Promise<void>
}

/** 前提を作るときだけ使う、最初の管理者（まなびばに管理者を作る API は管理者のセッションを要るので、保存先に直に置く）。 */
const BOOTSTRAP = {
  id: 'uc036-bootstrap-admin',
  email: 'uc036-bootstrap@example.com',
  session: 'uc036-bootstrap-session',
}

/**
 * SSO の一巡の前提の状態（UC-036 の事前条件）を起こす（呼ぶ側が口の鍵 withPorts を持つ）:
 * 手元のまなびば（このプロセスの中の app と SQLite）と手元の学び（同じ）を決まった口に立て、同じ共有秘密を与え、学び側にはまなびばの場所と
 * トークンの署名の秘密を与える。まなびばには、最初の管理者を保存先に直に置いてから、まなびばの契約の操作（createAccount・updateAccount）で、
 * 一巡の道具が使うメールとパスワードで学びの権限を持つ管理者を作る。前提を作れなければ投げる。
 */
export async function startSsoPair(): Promise<SsoPair> {
  const { createApp } = await import('../../portal/src/index')
  const learningApp = (await import('../../src/server/index')).default as unknown as FetchApp
  const { learningD1, portalD1, sqliteOf } = await import('../portal/repay_UC-014_sqlite_d1')
  // 学びの登録簿はまなびばの配備と同じ物（portal/src/learnings.json）。入口の行き先は渡すだけで、そこへは届けない
  const registry = JSON.parse(readFileSync(join(ROOT, 'portal', 'src', 'learnings.json'), 'utf8')) as { key: string; url: string }[]
  if (!registry.some((l) => l.key === SSO_FLOW.learning)) throw new Error(`前提: まなびばの学びの登録簿に ${SSO_FLOW.learning} が無い`)
  const portalApp = createApp(registry as never) as unknown as FetchApp & {
    request: (p: string, i: RequestInit, e: unknown) => Promise<Response>
  }
  const portalDb = await portalD1()
  const portalSqlite = sqliteOf(portalDb)
  portalSqlite
    .prepare('insert into accounts (id, email, name, password_hash, role) values (?, ?, ?, ?, ?)')
    .run(BOOTSTRAP.id, BOOTSTRAP.email, '前提の管理者', 'not-used-for-login', 'ADMIN')
  portalSqlite.prepare('insert into sessions (id, account_id, expires_at) values (?, ?, ?)').run(BOOTSTRAP.session, BOOTSTRAP.id, 4_100_000_000_000)
  const portalEnv = {
    DB: portalDb,
    ASSETS: { fetch: async () => new Response('') },
    SSO_SECRET: SSO_FLOW.secret,
  }
  const asBootstrap = (method: string, path: string, body: unknown) =>
    portalApp.request(
      path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: `mb_session=${BOOTSTRAP.session}`,
        },
        body: JSON.stringify(body),
      },
      portalEnv,
    )
  const created = await asBootstrap('POST', '/api/admin/accounts', {
    email: SSO_FLOW.admin,
    name: '検査用の管理者',
    password: SSO_FLOW.password,
    grants: [SSO_FLOW.learning],
  })
  if (created.status !== 201) throw new Error(`前提: 検査用の管理者を作れない（createAccount ${created.status}）: ${await created.text()}`)
  const { id } = (await created.json()) as { id: string }
  const promoted = await asBootstrap('PUT', `/api/admin/accounts/${id}`, {
    role: 'ADMIN',
  })
  if (promoted.status !== 200) throw new Error(`前提: 検査用のアカウントを管理者にできない（updateAccount ${promoted.status}）: ${await promoted.text()}`)
  // 最初の管理者のセッションは前提を作るためだけの物なので消す（一巡の道具が見るのは検査用の管理者だけ）
  portalSqlite.prepare('delete from sessions where id = ?').run(BOOTSTRAP.session)
  const learningEnv = {
    EXAM: SSO_FLOW.learning,
    DB: await learningD1(),
    JWT_SECRET: SSO_FLOW.jwtSecret,
    SSO_PORTAL_URL: `http://127.0.0.1:${SSO_FLOW.portalPort}`,
    SSO_SECRET: SSO_FLOW.secret,
    ASSETS: { fetch: async () => new Response('') },
  }
  const closers = [await listenApp(portalApp, portalEnv, SSO_FLOW.portalPort), await listenApp(learningApp, learningEnv, SSO_FLOW.learningPort)]
  return {
    portalSqlite,
    accounts: () => (portalSqlite.prepare('select email from accounts order by email').all() as { email: string }[]).map((r) => r.email),
    close: async () => {
      for (const c of closers) await c()
    },
  }
}

/** 手元の口（127.0.0.1・localhost）にだけ届く fetch（外への口を塞いだプロセスの中で、手元の相手に届けるため）。 */
export function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init)
  const url = new URL(req.url)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return Promise.reject(new TypeError(`手元の口でない: ${req.url}`))
  return req.arrayBuffer().then(
    (body) =>
      new Promise<Response>((ok, ng) => {
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => (headers[k] = v))
        const r = http.request(
          {
            host: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: req.method,
            headers,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c as Buffer))
            res.on('end', () => {
              const h = new Headers()
              for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === 'string') h.set(k, v)
                else if (Array.isArray(v)) for (const x of v) h.append(k, x)
              }
              ok(new Response(res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode ?? 500, headers: h }))
            })
          },
        )
        r.on('error', ng)
        if (body.byteLength > 0) r.write(Buffer.from(body))
        r.end()
      }),
  )
}

/** 影の根の学び側の手元の保存先のうち、学び key の物（構造の変更が最も多く当たり、論点の数が学びの置き場の論点の一覧と同じ物）。 */
export function learningDbOf(s: Shadow, key: string): string | null {
  const topics = (JSON.parse(readFileSync(join(ROOT, 'data', key, 'topics.json'), 'utf8')) as { topics: unknown[] }).topics.length
  let best: { f: string; mig: number } | null = null
  for (const f of learningDbs(s)) {
    const row = withDb(f, (db) => {
      try {
        const mig = (
          db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get() as {
            n: number
          }
        ).n
        const n = (db.prepare('SELECT COUNT(*) AS n FROM topics').get() as { n: number }).n
        return { mig, n }
      } catch {
        return null
      }
    })
    if (row && row.n === topics && (!best || row.mig > best.mig)) best = { f, mig: row.mig }
  }
  return best?.f ?? null
}

/**
 * 検査用のアカウントの用意（auditFixtures）の前提（UC-036 の事前条件）: 学び key の配備を、まなびばの場所を検査用のアカウントの道具が
 * 起こす手元の SSO の偽物の場所、共有秘密をその偽物と同じ値（正本は scripts/audit_fixtures.mjs）にして、port に起こす。
 * 配備の道具（wrangler dev）は起こさず、学び側の app を影の根に写した手元の保存先で、このプロセスの中で手元の口に立てる。
 * rewrite があれば、app の答えのうち当たる物を書き換えて返す（REQ-667 の、配備が成功の状態で読めない答えを返す場合）。
 */
export async function startAuditDeployment(
  s: Shadow,
  key = 'ip',
  port = 8787,
  rewrite?: { rules: AnswerRewrite[]; hitUrl?: string },
): Promise<() => Promise<void>> {
  const fake = (await import(join(ROOT, 'scripts', 'audit_fixtures.mjs'))) as {
    SSO_FAKE_URL: string
    SSO_FAKE_SECRET: string
  }
  const file = learningDbOf(s, key)
  if (!file) throw new Error(`前提: 影の根に学び ${key} の手元の保存先が無い`)
  const plain = (await import('../../src/server/index')).default as unknown as FetchApp
  const app = rewrite ? rewrittenApp(plain, rewrite.rules, rewrite.hitUrl) : plain
  const sqlite = new DatabaseSync(file)
  const env = {
    EXAM: key,
    DB: d1OfFile(sqlite),
    JWT_SECRET: 'audit-fixtures-local-only-not-a-secret',
    SSO_PORTAL_URL: fake.SSO_FAKE_URL,
    SSO_SECRET: fake.SSO_FAKE_SECRET,
    ASSETS: { fetch: async () => new Response('') },
  }
  const close = await listenApp(app, env, port)
  return async () => {
    await close()
    sqlite.close()
  }
}
