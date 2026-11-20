/** UC-033「確定した契約の実例を実装に当て、契約どおりに応えない版を見つける」のテストの土台。
 *
 *  入口は 2 つ（`CLAUDE.md` の「操作 → 入口」）。
 *  - 確かめを回す入口 `npm run contract-run`（引数はそのまま contract-run に渡る。フラグと `--json` の形は
 *    `.harness/tools/run-cases/README.md`）。実装とアダプター（`scripts/contract_adapter/`）は壊さず、
 *    「合わない」「不備」「渡せない」は README が決めている口（`--root` の影の根。契約だけか、契約と道具 1 本を差し替える）だけで作る
 *  - 作り手の道具（`scripts/<操作名を snake_case にした名前>.py`）。子プロセスで回し、標準出力の断りの名前を読む
 *
 *  影の置き場の契約は、本物の契約の操作の定義（transport・wire・auth など）と実例の名前・入力をそのまま写し、
 *  照らす側（例の応答か名前）だけを差し替える。前提の状態を例ごとに用意するのはアダプターの仕事で、
 *  アダプターは例の名前と入力で前提を選ぶので、名前と入力を変えない（REQ-570）。
 *
 *  外へ何も送らないこと（REQ-569）は、子の側の外向きの通信をすべて、このプロセスが立てる記録する代理と、
 *  node の外向きの接続を記録して断る前置きに集めて、記録が空であることで見る（本番にも外の相手にも届かない）。 */

import { execFile, spawn } from 'node:child_process'
import { closeSync, cpSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error 原本の harness の依存なしの .mjs（型を持たない）。契約を spec-lint・trace-check・contract-run と同じ読み方で読む
import { parseStrictYaml } from '../../.harness/tools/_shared/strict-yaml.mjs'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

const temps: string[] = []
const tempDir = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `uc033-${name}-`))
  temps.push(dir)
  return dir
}

/** 作った一時の置き場をすべて消す。 */
export async function removeTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

// ---------------------------------------------------------------------------
// 本物の契約

type Json = Record<string, unknown>
export type Example = { request?: unknown; response?: unknown; error?: string; [k: string]: unknown }
export type Operation = Json & { owned?: boolean; auth?: string; examples?: Record<string, Example> }
export type Contract = { uc: string; status: string; file: string; operations: Record<string, Operation> }

const contractFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return contractFiles(p)
    return name === 'contract.yaml' && /^UC-\d{3}/.test(dir.split('/').pop() ?? '') ? [p] : []
  })

/** docs/goals の下のすべての契約（読み方は原本の strict-yaml）。 */
export const CONTRACTS: Contract[] = contractFiles(join(ROOT, 'docs', 'goals')).map((file) => {
  const { root, problems } = parseStrictYaml(readFileSync(file, 'utf8')) as { root: Json; problems: unknown[] }
  if (problems.length) throw new Error(`${file} を読めない: ${JSON.stringify(problems)}`)
  return {
    uc: String(root['x-uc']),
    status: String(root['x-status']),
    file,
    operations: (root.operations ?? {}) as Record<string, Operation>,
  }
})

const contractOf = (uc: string) => {
  const c = CONTRACTS.find((x) => x.uc === uc)
  if (!c) throw new Error(`${uc} の契約が無い`)
  return c
}

/** 本物の契約の操作の定義の写し。 */
export function realOp(uc: string, op: string): Operation {
  const o = contractOf(uc).operations[op]
  if (!o) throw new Error(`${uc} の契約に ${op} が無い`)
  return structuredClone(o)
}

/** 本物の契約の実例の写し。 */
export function realExample(uc: string, op: string, name: string): Example {
  const e = realOp(uc, op).examples?.[name]
  if (!e) throw new Error(`${uc} ${op} に実例 ${name} が無い`)
  return e
}

/** 本物の操作の定義に、決めた実例だけを持たせる。 */
export function opWith(uc: string, op: string, examples: Record<string, Example>, over: Partial<Operation> = {}): Operation {
  return { ...realOp(uc, op), ...over, examples }
}

export type ExampleKey = { uc: string; operation: string; case: string }
export const keyOf = (e: ExampleKey) => `${e.uc} ${e.operation}.${e.case}`

/** 確かめが渡すべき実例（確定した契約の、自分の持ち物の操作の実例）の全件。 */
export function ownedFixedExamples(): ExampleKey[] {
  return CONTRACTS.filter((c) => c.status === 'fixed').flatMap((c) =>
    Object.entries(c.operations)
      .filter(([, o]) => o.owned !== false)
      .flatMap(([operation, o]) => Object.keys(o.examples ?? {}).map((name) => ({ uc: c.uc, operation, case: name }))),
  )
}

// ---------------------------------------------------------------------------
// 影の置き場（契約だけを差し替える）

export type ShadowContract = { uc: string; status?: 'fixed' | 'draft'; operations: Record<string, Operation> }

const writeGoals = (goals: string, contracts: ShadowContract[]) => {
  contracts.forEach((c, i) => {
    const dir = join(goals, `GOAL-99-shadow`, `${c.uc}-shadow-${i + 1}`)
    mkdirSync(dir, { recursive: true })
    // 値は JSON の流れの形で 1 行に書く（strict-yaml の部分集合の内）
    const text = [`x-uc: ${c.uc}`, `x-status: ${c.status ?? 'fixed'}`, `operations: ${JSON.stringify(c.operations)}`, ''].join('\n')
    writeFileSync(join(dir, 'contract.yaml'), text)
  })
}

/** 契約だけを差し替えた影の根を作り、`--root` に渡すパスで返す（道具はどれも本物のまま）。
 *  確かめの道具は、`--docs` が設定の `docs.goals_dir` と別の場所を指すと断るので、契約は影の根の `docs/goals` に置く。 */
export function shadowSpec(contracts: ShadowContract[]): string {
  return shadowRoot({ contracts, tools: {} })
}

/** 影の根: リポジトリの各物へのリンクに、契約（docs/goals）と道具の差し替え（scripts/<名前>）を重ねる。
 *  アダプターの置き場（scripts/contract_adapter）はリンクでなく写し（node はリンクを元の場所に解くので、
 *  リンクのままだと影の根の道具でなく元の道具を回してしまう）。設定（harness.config.json）も写す。 */
export function shadowRoot(opts: { contracts: ShadowContract[]; tools: Record<string, string> }): string {
  const root = join(tempDir('root'), 'root')
  mkdirSync(root)
  const skip = new Set(['.git', 'docs', 'scripts', 'harness.config.json'])
  for (const name of readdirSync(ROOT)) if (!skip.has(name)) symlinkSync(join(ROOT, name), join(root, name))
  for (const name of ['harness.config.json']) cpSync(join(ROOT, name), join(root, name))
  mkdirSync(join(root, 'docs'))
  for (const name of readdirSync(join(ROOT, 'docs'))) if (name !== 'goals') symlinkSync(join(ROOT, 'docs', name), join(root, 'docs', name))
  writeGoals(join(root, 'docs', 'goals'), opts.contracts)
  mkdirSync(join(root, 'scripts'))
  for (const name of readdirSync(join(ROOT, 'scripts'))) {
    if (name in opts.tools) continue
    if (name === 'contract_adapter') cpSync(join(ROOT, 'scripts', name), join(root, 'scripts', name), { recursive: true })
    else symlinkSync(join(ROOT, 'scripts', name), join(root, 'scripts', name))
  }
  for (const [name, body] of Object.entries(opts.tools)) writeFileSync(join(root, 'scripts', name), body)
  return root
}

// ---------------------------------------------------------------------------
// 確かめを回す

export type Verdict = ExampleKey & { verdict: 'pass' | 'fail' | 'skip'; detail?: string }
export type ContractRunResult = {
  code: number
  stdout: string
  stderr: string
  /** `--json` の results（標準出力が JSON として読めなければ null） */
  results: Verdict[] | null
  summary: { pass: number; fail: number; skip: number } | null
  /** 開始から終了までの秒数 */
  seconds: number
  /** 受け渡し役が標準エラーに書いた行の写し（CONTRACT_ADAPTER_NOTES。各行は「実例の名前 タブ 行」） */
  notes: string
}

/** 呼ぶ側が `--timeout` を渡さないときに確かめへ渡す、全実行の上限（秒）。原本の既定（120 秒）は、記録つきの全体の中
 *  （子のプロセスに記録の仕掛けが付き、ほかのテストと並ぶ）で機械の負荷が高い回に足りず、アダプタ異常で結果が読めなくなる。
 *  既定の 120 秒の中で終わることは、検査の一式の run cases の段が見る。 */
export const RUN_TIMEOUT_S = 300
/** 確かめに渡した上限（秒）から、テスト側で止める時刻（ミリ秒）。確かめが自分の上限で止まって結果を書き終える猶予を足す。 */
export const limitMsFor = (timeoutS: number) => (timeoutS + 30) * 1000
/** 上限を渡さずに contractRun を `runs` 回回すテスト（`it`・`beforeAll`）の上限（ミリ秒）。 */
export const runsTestMs = (runs = 1) => runs * limitMsFor(RUN_TIMEOUT_S) + 30_000

/** 引数の `--timeout <秒>`（`--timeout=<秒>`）の値。無ければ undefined。 */
const timeoutOf = (args: string[]): number | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout') return Number(args[i + 1])
    if (args[i].startsWith('--timeout=')) return Number(args[i].slice('--timeout='.length))
  }
  return undefined
}

/** `npm run contract-run -- <args>` を 1 回回す。`limitMs` を過ぎたら止めて code を -1 にする。
 *  `args` に `--timeout` が無ければ RUN_TIMEOUT_S を渡す（上限そのものを確かめるテストは自分の値を渡し、そのまま使う）。
 *  `limitMs` の既定は、渡した上限に limitMsFor の猶予を足した物。
 *  標準出力はパイプでなく一時のファイルに向け、終わってから読む（原本の道具は書いた直後に終わり、パイプへの
 *  書き出しを待たないので、64KB を超える `--json` の結果がパイプでは切れる）。 */
export function contractRun(args: string[], opts: { env?: Record<string, string>; limitMs?: number } = {}): Promise<ContractRunResult> {
  const given = timeoutOf(args)
  if (given === undefined) args = [...args, '--timeout', String(RUN_TIMEOUT_S)]
  const limitMs = opts.limitMs ?? limitMsFor(given ?? RUN_TIMEOUT_S)
  const started = Date.now()
  const outFile = join(tempDir('stdout'), 'stdout.txt')
  // 受け渡し役の理由の写しを置くこの回だけのファイル（run cases は、正常に終わった受け渡し役の標準エラーを見せない）
  const notesFile = join(tempDir('notes'), 'notes.txt')
  writeFileSync(notesFile, '')
  const outFd = openSync(outFile, 'w')
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', '--silent', 'contract-run', '--', ...args], {
      cwd: ROOT,
      env: { ...process.env, npm_config_update_notifier: 'false', NO_UPDATE_NOTIFIER: '1', CONTRACT_ADAPTER_NOTES: notesFile, ...opts.env },
      stdio: ['ignore', outFd, 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, limitMs)
    let done = false
    const finish = (exitCode: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      closeSync(outFd)
      const stdout = readFileSync(outFile, 'utf8')
      const code = killed ? -1 : (exitCode ?? 1)
      type Parsed = { results?: Verdict[]; summary?: ContractRunResult['summary'] }
      const parsed = ((): Parsed | null => {
        try {
          return JSON.parse(stdout) as Parsed
        } catch {
          return null
        }
      })()
      resolve({
        code,
        stdout,
        stderr,
        results: Array.isArray(parsed?.results) ? parsed.results : null,
        summary: parsed?.summary ?? null,
        seconds: (Date.now() - started) / 1000,
        notes: readFileSync(notesFile, 'utf8'),
      })
    }
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(1)
    })
    child.on('close', (exitCode) => finish(exitCode))
  })
}

/** 結果の中の 1 件（無ければ undefined）。 */
export const verdictOf = (run: ContractRunResult, k: ExampleKey) =>
  run.results?.find((r) => r.uc === k.uc && r.operation === k.operation && r.case === k.case)

/** 失敗のときに読む、出力の末尾。 */
export const tailOf = (run: ContractRunResult) => `${run.stdout}\n${run.stderr}`.split('\n').slice(-40).join('\n')

/** 合わなかった実例ごとに、確かめの出力（標準出力の JSON でない行と標準エラー）からその実例を名指しする行を前後 2 行ごと拾い、
 *  落ちたテストのメッセージにする。全実例を回すと出力は長く、tailOf の末尾 40 行に入るとは限らないため。
 *  run cases は、アダプターが正常に終われば、アダプターの標準エラー（受け渡し役が書く理由）を自分の出力に流さない
 *  （アダプターの異常のときだけ末尾 20 行を出す。`.harness/tools/run-cases/README.md`）。拾えないときはそう書く。 */
export function explainNotPassed(run: ContractRunResult, notPassed: Verdict[]): string {
  if (notPassed.length === 0) return ''
  const lines = [...(run.results === null ? run.stdout.split('\n') : []), ...run.stderr.split('\n')]
  const around = (needle: string) => {
    const hit = new Set<number>()
    lines.forEach((line, i) => {
      if (!line.includes(needle)) return
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) hit.add(j)
    })
    return [...hit].sort((x, y) => x - y).map((i) => `    | ${lines[i]}`)
  }
  const notes = run.notes.split('\n').filter((line) => line !== '')
  const parts = notPassed.map((r) => {
    const found = around(`${r.operation}.${r.case}`)
    const said = notes.filter((line) => line.startsWith(`${keyOf(r)}\t`) || line.includes(`${r.operation}.${r.case}`))
    return [
      `- ${r.verdict} ${keyOf(r)}  ${r.detail ?? ''}`,
      ...(said.length > 0
        ? ['  受け渡し役がこの実例について書いた行（CONTRACT_ADAPTER_NOTES）:', ...said.map((line) => `    | ${line.replace(/^[^\t]*\t/, '')}`)]
        : ['  受け渡し役がこの実例について書いた行は無い']),
      ...(found.length > 0
        ? ['  確かめの出力でこの実例を名指しする行:', ...found]
        : ['  確かめの出力にこの実例を名指しする行は無い（run cases は、正常に終わったアダプターの標準エラーを流さない）']),
    ].join('\n')
  })
  const stderrTail = run.stderr.split('\n').filter((l) => l.trim() !== '').slice(-20)
  return [
    `合わなかった実例 ${notPassed.length} 件（終了 ${run.code}）:`,
    ...parts,
    `確かめの標準エラーの末尾 ${stderrTail.length} 行:`,
    ...stderrTail.map((l) => `    | ${l}`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 外へ送られたものの記録（REQ-569）

/** 外向きの接続を記録して断る前置き（NODE_OPTIONS の --require で子の node に入れる）。手元（loopback と UNIX ソケット）だけ通す。 */
const NET_WITNESS = `const net = require('node:net')
const fs = require('node:fs')
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
  if (!path && host && !LOCAL.has(host)) {
    fs.appendFileSync(process.env.UC033_WITNESS_LOG, JSON.stringify({ via: 'node', to: host }) + '\\n')
    throw new Error('UC-033 のテストの囲い: 外への接続を断った ' + host)
  }
  return connect.apply(this, args)
}
`

export type Witness = {
  /** 子に渡す環境（代理・前置き・無効のトークン） */
  env: Record<string, string>
  /** 外へ送られかけたもの（代理が受けた要求と、前置きが断った接続） */
  sent: () => string[]
  close: () => Promise<void>
}

/** 外へ送られたものを記録する囲いを開く。代理は受けた要求を記録して、どこへもつながずに断る。 */
export async function openWitness(): Promise<Witness> {
  const dir = tempDir('witness')
  const log = join(dir, 'sent.jsonl')
  const guard = join(dir, 'witness.cjs')
  writeFileSync(log, '')
  writeFileSync(guard, NET_WITNESS)
  const record = (to: string) => writeFileSync(log, `${JSON.stringify({ via: 'proxy', to })}\n`, { flag: 'a' })
  const proxy: Server = createServer((req, res) => {
    record(`${req.method} ${req.url}`)
    res.writeHead(502).end()
  })
  proxy.on('connect', (req, socket) => {
    record(`CONNECT ${req.url}`)
    // 断ったことを答えてから閉じる（黙って切ると、つなぎ直しを繰り返す相手がある）
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  const port = (proxy.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}`
  return {
    env: {
      NODE_OPTIONS: `--require ${guard}`,
      UC033_WITNESS_LOG: log,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: url,
      HTTP_PROXY: url,
      ALL_PROXY: url,
      https_proxy: url,
      http_proxy: url,
      all_proxy: url,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      CLOUDFLARE_API_TOKEN: 'uc033-invalid-token-do-not-use',
      WRANGLER_SEND_METRICS: 'false',
      XDG_CONFIG_HOME: join(dir, 'xdg'),
    },
    sent: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== ''),
    close: () => new Promise<void>((r) => proxy.close(() => r())),
  }
}

// ---------------------------------------------------------------------------
// 作り手の道具（REQ-571）

export type ToolRun = { code: number; stdout: string; stderr: string }

/** 道具を子プロセスで 1 回回す（`scripts/<名前>` を python3 で。作業の場所は cwd）。 */
export function runTool(script: string, args: string[], cwd = ROOT): Promise<ToolRun> {
  return new Promise((resolve) => {
    execFile('python3', [join(ROOT, 'scripts', script), ...args], { cwd, maxBuffer: 1 << 24, timeout: 60_000 }, (error, stdout, stderr) => {
      const e = error as (Error & { code?: unknown }) | null
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr })
    })
  })
}

/** 道具の断りの名前の読み方（`CLAUDE.md` の「操作 → 入口」）: 標準出力の全体を JSON として読み、
 *  読めなければ最後の空でない行を JSON として読んで、その `error.code`。読めなければ undefined。 */
export function refusalOf(stdout: string): { code?: unknown; reason?: unknown } | undefined {
  const read = (text: string) => {
    try {
      const v = JSON.parse(text) as { error?: { code?: unknown; reason?: unknown } }
      return v && typeof v === 'object' && v.error && typeof v.error === 'object' ? v.error : undefined
    } catch {
      return undefined
    }
  }
  const whole = read(stdout)
  if (whole) return whole
  const last = stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .pop()
  return last === undefined ? undefined : read(last)
}

/** 学びの置き場を写した作業の場所。`data/<学び>/` の中身は元へのリンクで、`omit` の物を置かず、`replace` の物を中身で置く。
 *  `src` も元へのリンクにする（登録簿の場所を作業の場所から読む道具でも同じ登録簿を読む）。 */
export function dataShadow(learning: string, opts: { omit?: string[]; replace?: Record<string, string> } = {}): string {
  const cwd = tempDir('data')
  const dir = join(cwd, 'data', learning)
  mkdirSync(dir, { recursive: true })
  const omit = new Set([...(opts.omit ?? []), ...Object.keys(opts.replace ?? {})])
  for (const name of readdirSync(join(ROOT, 'data', learning))) if (!omit.has(name)) symlinkSync(join(ROOT, 'data', learning, name), join(dir, name))
  for (const [name, body] of Object.entries(opts.replace ?? {})) writeFileSync(join(dir, name), body)
  symlinkSync(join(ROOT, 'src'), join(cwd, 'src'))
  return cwd
}
