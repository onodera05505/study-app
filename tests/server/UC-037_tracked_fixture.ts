/** UC-037 の文書の検査（checkDocs ＝ `python3 scripts/check_docs.py [--root <根>]`）を、git の作業ツリーにした影の根で回す土台。
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行。
 *
 *  影の根は、リポジトリが追跡するファイル（git の索引にあるパス）だけを写し、その上で `git init` と `git add -A` をして作る。
 *  学びの置き場（data・public）は重いので、元へのリンクにする（索引にはリンクが 1 つ載る）。
 *  道具は、影の根を作業の場所にし、`--root` に影の根を渡し、HOME を空の一時の置き場にして回す（手元の共通の置き場を読ませない）。
 *  観測するのは、終了の状態と、標準出力と標準エラーの文だけ。 */

import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 写さずに元へのリンクにする最上位の置き場。 */
const LINKED = ['data', 'public']

const temps: string[] = []

export async function removeTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** git を、手元の git の設定を読まずに回す。 */
export function git(root: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  return { status: r.status, stdout: r.stdout ?? '' }
}

export type Run = { status: number | null; stdout: string; stderr: string; out: string }

export type TrackedShadow = {
  root: string
  path: (rel: string) => string
  read: (rel: string) => string
  /** ファイルを置く（git の索引には足さない）。 */
  write: (rel: string, content: string) => void
  /** git の索引に足す。 */
  track: (rel: string) => void
  /** git の索引にあるか。 */
  tracked: (rel: string) => boolean
  /** git が無視するか。 */
  ignored: (rel: string) => boolean
  checkDocs: () => Run
}

export function trackedShadow(): TrackedShadow {
  const base = mkdtempSync(join(tmpdir(), 'uc037-git-'))
  temps.push(base)
  const root = join(base, 'root')
  const home = join(base, 'home')
  mkdirSync(root)
  mkdirSync(home)
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\0')
  for (const rel of listed) {
    if (!rel || LINKED.some((d) => rel.startsWith(`${d}/`))) continue
    const from = join(ROOT, rel)
    const st = lstatSync(from, { throwIfNoEntry: false })
    if (!st) continue
    const to = join(root, rel)
    mkdirSync(dirname(to), { recursive: true })
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
    else if (st.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE)
  }
  for (const d of LINKED) if (existsSync(join(ROOT, d))) symlinkSync(join(ROOT, d), join(root, d))
  const must = (args: string[]) => {
    const r = git(root, args)
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} が通らない`)
  }
  must(['init', '-q'])
  must(['add', '-A'])
  const path = (rel: string) => join(root, rel)
  return {
    root,
    path,
    read: (rel) => readFileSync(path(rel), 'utf8'),
    write: (rel, content) => {
      mkdirSync(dirname(path(rel)), { recursive: true })
      writeFileSync(path(rel), content)
    },
    track: (rel) => must(['add', '-f', '--', rel]),
    tracked: (rel) => git(root, ['ls-files', '--error-unmatch', '--', rel]).status === 0,
    ignored: (rel) => git(root, ['check-ignore', '-q', '--', rel]).status === 0,
    checkDocs: () => {
      const r = spawnSync('python3', [path('scripts/check_docs.py'), '--root', root], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300_000,
        env: { ...process.env, HOME: home },
      })
      const stdout = r.stdout ?? ''
      const stderr = r.stderr ?? ''
      return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}`.split(root).join('<root>') }
    },
  }
}

/** 名前の無い例外で落ちていないこと。 */
export const crashed = (r: Run) => /Traceback \(most recent call last\)/.test(r.stderr)
