/**
 * 道具（`scripts/` の Python とシェル）を子プロセスで回す受け持ちの共通の部品。
 *
 * 使い方:
 * ```ts
 * const shadow = await shadowRoot({ copy: ['data/ip/topic_ids.json'], files: { 'data/ip/x.json': '{}' } })
 * try {
 *   const run = await runTool(['python3', 'scripts/check_source.py'], { cwd: shadow.root })
 *   return toolAnswer(run, (r) => ({ exitCode: r.code }))
 * } finally {
 *   await shadow.cleanup()
 * }
 * ```
 * - shadowRoot: 実例ごとに一時の置き場（影の根）を作り、前提のファイルを置く。リポジトリのファイルを書き換えない（REQ-570）。
 * - fakeCommands: 影の根の中に偽のコマンド（wrangler・npx・curl など）を置き、PATH の先頭に入れる環境を返す。
 *   本番の保存先・配備先・外の相手に届くコマンドは、これで偽物に向けてから回す（REQ-569）。
 * - runTool: 子プロセスで回す。同時に回す数を土台が絞るので、受け持ちは気にせず await してよい（受け持ちは parallel: true）。
 * - toolAnswer: 断りの名前の読み方（CLAUDE.md の「操作 → 入口」）。標準出力の全体を JSON として読み、読めなければ
 *   最後の空でない行を読み、その `error.code`。終了の状態が 0 なら応答を組む関数に渡す。0 でないのに名前が読めなければ
 *   unnamedStop の答え。
 * - unnamedStop: 道具が断りの名前を出さずに 0 でない終了の状態で止まったときの答え
 *   `{ response: { unnamedStop: { exitCode, stderr } } }`（終了の状態を最上位に持たないので、どの成功例にも合わない）。
 *   Python の Traceback を残して止まった（名前の無い例外）ときは Unanswerable を投げる。
 * - 子プロセスは道具ごとに自分のプロセスグループで起こし、時間切れでグループごと止める。受け渡し役が終わるとき
 *   （stopChildren・SIGTERM ほか）と、受け渡し役を起こした側が居なくなったとき（bindToCaller）も、残る子をグループごと止める。
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Unanswerable, type Answer } from './protocol'

/** リポジトリの根（このファイルから 3 つ上）。 */
export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

export type Shadow = {
  root: string
  /** 影の根の中のパス。 */
  path: (rel: string) => string
  write: (rel: string, content: string) => Promise<void>
  cleanup: () => Promise<void>
}

/**
 * 実例 1 件の影の根を作る。copy はリポジトリの根からの相対パス（ファイルかディレクトリ）を同じ相対パスに写す。
 * @implements REQ-569, REQ-570
 */
export async function shadowRoot(options: { copy?: string[]; files?: Record<string, string> } = {}): Promise<Shadow> {
  const root = await mkdtemp(join(tmpdir(), 'contract-adapter-'))
  const path = (rel: string) => join(root, rel)
  const write = async (rel: string, content: string) => {
    await mkdir(dirname(path(rel)), { recursive: true })
    await writeFile(path(rel), content)
  }
  for (const rel of options.copy ?? []) {
    await mkdir(dirname(path(rel)), { recursive: true })
    await cp(join(REPO_ROOT, rel), path(rel), { recursive: true })
  }
  for (const [rel, content] of Object.entries(options.files ?? {})) await write(rel, content)
  return { root, path, write, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * 影の根の `.fake-bin` に偽のコマンドを置き、PATH の先頭に入れた環境を返す。値はシェルの本文（#!/bin/sh の後ろ）。
 * @implements REQ-569
 */
export async function fakeCommands(shadow: Shadow, commands: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const bin = shadow.path('.fake-bin')
  await mkdir(bin, { recursive: true })
  for (const [name, body] of Object.entries(commands)) {
    const file = join(bin, name)
    await writeFile(file, `#!/bin/sh\n${body}\n`)
    await chmod(file, 0o755)
  }
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
}

export type ToolRun = { code: number; stdout: string; stderr: string }

/** 回っている子プロセス（受け渡し役が終わるときに止める）。 */
const live = new Set<ChildProcess>()

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // もう居ない
  }
}

/**
 * 受け渡し役が起こして回っている子プロセスを、プロセスグループごと止める。
 * @implements REQ-568
 */
export function stopChildren(): void {
  for (const child of live) killGroup(child)
  live.clear()
}

/** 自分の先祖のプロセス（親から根の手前まで）。 */
function ancestors(): number[] {
  const found: number[] = []
  let pid = process.ppid
  while (pid > 1 && found.length < 32) {
    found.push(pid)
    try {
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    } catch {
      break
    }
  }
  return found
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 受け渡し役を起こした側（contract-run と、その間の npx・tsx）が居なくなったら、子を止めて受け渡し役を終える。
 * 止められる知らせ（SIGTERM・SIGINT・SIGHUP）を受けたときと、受け渡し役が終わるときも子を止める。
 * contract-run は時間切れで直接の子だけを止めるので、受け渡し役と道具が残らないようにする（確かめの --timeout で全体が終わる）。
 * @implements REQ-568
 */
export function bindToCaller(intervalMs = 200): void {
  const watched = ancestors()
  const lost = (code: number) => {
    stopChildren()
    process.exit(code)
  }
  const timer = setInterval(() => {
    if (watched.some((pid) => !alive(pid))) {
      process.stderr.write('受け渡し役を起こした側が居なくなった。子を止めて終える\n')
      lost(1)
    }
  }, intervalMs)
  timer.unref()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => lost(1))
  process.on('exit', stopChildren)
}

let running = 0
const waiting: Array<() => void> = []
const LIMIT = Math.max(2, availableParallelism())

async function slot<T>(body: () => Promise<T>): Promise<T> {
  if (running >= LIMIT) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  try {
    return await body()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/**
 * 道具を子プロセスで回す（同時に回す数は土台が絞る）。timeoutMs を過ぎたら止めて Unanswerable を投げる。
 * @implements REQ-568, REQ-570
 */
export function runTool(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): Promise<ToolRun> {
  return slot(
    () =>
      new Promise<ToolRun>((resolvePromise, reject) => {
        // 自分のプロセスグループで起こす（道具が起こした孫ごと止められるように）
        const child = spawn(command[0], command.slice(1), {
          cwd: options.cwd ?? REPO_ROOT,
          env: options.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        })
        live.add(child)
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        const timer = setTimeout(() => {
          killGroup(child)
          live.delete(child)
          reject(new Unanswerable(`道具が ${options.timeoutMs ?? 60_000} ms で応えない: ${command.join(' ')}`))
        }, options.timeoutMs ?? 60_000)
        child.on('error', (error) => {
          clearTimeout(timer)
          live.delete(child)
          reject(new Unanswerable(`道具を起動できない: ${command.join(' ')}: ${error.message}`))
        })
        child.on('exit', () => {
          // 道具が終わったあとに残った孫も止める（パイプを握ったまま残ると close が来ない）
          killGroup(child)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          live.delete(child)
          resolvePromise({ code: code ?? 1, stdout, stderr })
        })
        // 標準入力を読まずに先に終わった道具への書き込み（EPIPE）で受け渡し役を落とさない（終わりは close で受ける）
        child.stdin.on('error', () => {})
        child.stdin.end(options.input ?? '')
      }),
  )
}

/**
 * 道具の標準出力から断りの名前（ToolError の error.code）を読む。読めなければ null。
 * @implements REQ-567, BR-064
 */
export function toolErrorCode(stdout: string): string | null {
  const read = (text: string): string | null => {
    try {
      const code = (JSON.parse(text) as { error?: { code?: unknown } })?.error?.code
      return typeof code === 'string' && code.length > 0 ? code : null
    } catch {
      return null
    }
  }
  const whole = read(stdout.trim())
  if (whole !== null) return whole
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  return lines.length > 0 ? read(lines[lines.length - 1]) : null
}

/**
 * 道具を回した結果を答えに読む。名前があれば断り、終了の状態が 0 なら応答、どちらでもなければ名前を出さない断り。
 * @implements REQ-567, REQ-568, BR-064
 */
export function toolAnswer(run: ToolRun, response: (run: ToolRun) => Record<string, unknown>): Answer {
  const code = toolErrorCode(run.stdout)
  if (code !== null) return { error: code }
  if (run.code === 0) return { response: response(run) }
  return unnamedStop(run)
}

/**
 * 道具が断りの名前を出さずに 0 でない終了の状態で止まったときの答え。道具が返した終了の状態と標準エラーの末尾を、
 * 最上位に終了の状態を持たない入れ物 `unnamedStop` に入れて返す（どの成功例の応答にも含まれないので、確かめはその実例を
 * 合わない物として挙げ、ほかの実例は回り続ける）。Python の Traceback を残して止まった（名前の無い例外）ときは、
 * 実装が何も返さなかったとして Unanswerable を投げる。
 * @implements REQ-568, BR-064
 */
export function unnamedStop(run: ToolRun): Answer {
  const tail = (run.stderr || run.stdout).trim().split('\n').slice(-2).join(' / ').slice(0, 200)
  if (/Traceback \(most recent call last\)/.test(run.stderr)) {
    throw new Unanswerable(`道具が名前の無い例外で止まった（終了の状態 ${run.code}）: ${tail}`)
  }
  process.stderr.write(`  道具が名前を出さずに止まった（終了の状態 ${run.code}）: ${tail}\n`)
  return { response: { unnamedStop: { exitCode: run.code, stderr: tail } } }
}
