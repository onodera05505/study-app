/** UC-043（コミットの件名の検査を入れる道具）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: installGithooks ＝ `bash scripts/install_githooks.sh`（引数なし）。
 *  道具は git の設定（フックの置き場）を書き換えるので、作業ツリーと本体のクローンでは回さない。一時の置き場に `git init` した
 *  別のクローン（makeClone）を作り、道具とリポジトリの中のフックの置き場（`.githooks`）を写して、その中で回す。
 *  手元の利用者の git の設定（HOME の .gitconfig）も一時の置き場に向け、システムの設定は読ませない。
 *  macOS では OS の囲い（sandbox-exec）で、外への接続と、作業ツリーとその隣（本体）の置き場への書き込みを断つ。 */

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const TOOL = 'scripts/install_githooks.sh'
/** リポジトリの中のフックの置き場。 */
export const HOOKS = '.githooks'

const SANDBOX: string | null =
  process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
    ? `(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(deny file-write* (subpath ${JSON.stringify(dirname(ROOT))}))`
    : null

const temps: string[] = []
export async function removeTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
}

export type Clone = { dir: string; home: string; env: NodeJS.ProcessEnv }
export type ToolRun = { status: number | null; stdout: string; stderr: string; out: string }

/** 一時の置き場に git init したクローンを作り、道具とフックの置き場を写す（フックは実行できない印で置く）。 */
export function makeClone(): Clone {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'uc043-')))
  temps.push(base)
  const dir = join(base, 'clone')
  const home = join(base, 'home')
  mkdirSync(dir)
  mkdirSync(home)
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = uc043\n\temail = uc043@example.invalid\n')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(home, '.config') }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  const init = spawnSync('git', ['init', '-q', dir], { env, encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`仕込み: git init できない: ${init.stderr}`)
  mkdirSync(join(dir, 'scripts'))
  cpSync(join(ROOT, TOOL), join(dir, TOOL))
  cpSync(join(ROOT, HOOKS), join(dir, HOOKS), { recursive: true })
  for (const name of readdirSync(join(dir, HOOKS))) chmodSync(join(dir, HOOKS, name), 0o644)
  return { dir, home, env }
}

/** クローンを作業の場所にして道具を回す（囲いの中）。 */
export function runInstall(c: Clone): ToolRun {
  const args = SANDBOX ? ['-p', SANDBOX, 'bash', join(c.dir, TOOL)] : [join(c.dir, TOOL)]
  const r = spawnSync(SANDBOX ? 'sandbox-exec' : 'bash', args, { cwd: c.dir, env: c.env, encoding: 'utf8', timeout: 60_000 })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}` }
}

/** クローンの git の設定の値（無ければ null）。 */
export function gitConfig(c: Clone, key: string): string | null {
  const r = spawnSync('git', ['-C', c.dir, 'config', '--local', '--get', key], { env: c.env, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/** フックの置き場のファイルが実行できるか（ファイル名 → 真偽）。 */
export function executable(c: Clone): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const name of readdirSync(join(c.dir, HOOKS))) out[name] = (statSync(join(c.dir, HOOKS, name)).mode & 0o111) !== 0
  return out
}

/** 利用者の git の設定（HOME の .gitconfig）の中身。 */
export const userConfig = (c: Clone) => (existsSync(join(c.home, '.gitconfig')) ? readFileSync(join(c.home, '.gitconfig'), 'utf8') : null)
