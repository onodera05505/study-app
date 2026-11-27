/** UC-037（文書の検査）と UC-038（取り込み・分類・書き直し・手順書の結果の検査）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: 操作名を snake_case にした `scripts/<名前>.py` を子プロセスで回す
 *  （checkDocs ＝ `scripts/check_docs.py`、checkFeedbackLedger ＝ `scripts/check_feedback_ledger.py` ほか）。
 *  request の各欄は同じ名前の引数（契約の先頭の決まり）。観測するのは、終了の状態と、標準出力と標準エラーの文だけ。
 *
 *  影の根（toolShadow）は、リポジトリを一時の置き場に写した物。重い置き場（data・public・node_modules など）はリンクにし、
 *  ほかは写す（APFS では複製の印だけの写し）。前提はその上で書き換えて作り、リポジトリは書き換えない。
 *  道具は影の根の写しを、影の根を作業の場所にして回す（道具が自分の置き場から根を引いても、作業の場所から引いても、影の根を読む）。
 *  git を指定した影の根は git の作業ツリーで、索引にはリポジトリが追跡するパス（リポジトリの索引の並び）だけを入れる
 *  （リンクにした置き場の下のパスも、リポジトリが追跡していれば索引にある。写した追跡しないファイルは索引に無い）。 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 写さずにリンクにする最上位の置き場（重いか、道具が書かない物）。 */
const LINKED = new Set(['coverage', 'data', 'public', 'node_modules', '.harness', 'apm_modules', 'backups', 'full', 'dist', '.wrangler'])

const temps: string[] = []

/** 作った影の根をすべて消す。 */
export async function removeTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export type Shadow = {
  root: string
  path: (rel: string) => string
  read: (rel: string) => string
  write: (rel: string, content: string) => void
  remove: (rel: string) => void
  /** 道具を回す（`python3 scripts/<script> <args>`。作業の場所は影の根） */
  run: (script: string, args?: string[], env?: Record<string, string>) => ToolRun
}

export type ToolRun = { status: number | null; stdout: string; stderr: string; out: string }

/**
 * 影の根を作る。copyData は、リンクでなく写しにする学びの置き場の中の物（`data/` からの相対。`ap/classified` のように学びの中の 1 つの置き場でもよい）。
 */
export function toolShadow(opts: { copyData?: string[]; git?: boolean } = {}): Shadow {
  const base = mkdtempSync(join(tmpdir(), 'uc037-'))
  temps.push(base)
  const root = join(base, 'root')
  mkdirSync(root)
  const copyData = opts.copyData ?? []
  const cloned: string[] = []
  for (const name of readdirSync(ROOT)) {
    if (name === '.git') continue
    if (LINKED.has(name)) {
      if (name === 'data' && copyData.length) continue
      symlinkSync(join(ROOT, name), join(root, name))
    } else cloned.push(join(ROOT, name))
  }
  const cp = (from: string[], to: string) => {
    if (from.length === 0) return
    const args = process.platform === 'darwin' ? ['-cR', ...from, `${to}/`] : ['-R', '--reflink=auto', ...from, `${to}/`]
    const r = spawnSync('cp', args, { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`影の根を写せない: ${r.stderr}`)
  }
  cp(cloned, root)
  if (copyData.length) {
    /** dir（data からの相対）を、写す物の親の段だけディレクトリにして作る。 */
    const build = (dir: string) => {
      const from = join(ROOT, 'data', dir)
      const to = join(root, 'data', dir)
      mkdirSync(to, { recursive: true })
      const prefix = dir === '' ? '' : `${dir}/`
      for (const name of readdirSync(from)) {
        const rel = `${prefix}${name}`
        if (copyData.includes(rel)) cp([join(from, name)], to)
        else if (copyData.some((c) => c.startsWith(`${rel}/`))) build(rel)
        else symlinkSync(join(from, name), join(to, name))
      }
    }
    build('')
  }
  if (opts.git) trackLikeRepository(root)
  const path = (rel: string) => join(root, rel)
  return {
    root,
    path,
    read: (rel) => readFileSync(path(rel), 'utf8'),
    write: (rel, content) => {
      mkdirSync(dirname(path(rel)), { recursive: true })
      writeFileSync(path(rel), content)
    },
    remove: (rel) => rmSync(path(rel), { recursive: true, force: true }),
    run: (script, args = [], env = {}) => runTool(root, script, args, env),
  }
}

/** git を、手元の git の設定を読まずに回す。 */
function git(cwd: string, args: string[], input?: string): string {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が通らない: ${r.stderr}`)
  return r.stdout
}

/** root を git の作業ツリーにし、索引にリポジトリの索引の並び（パス・種類・中身の名前）をそのまま入れる。 */
function trackLikeRepository(root: string): void {
  git(root, ['init', '-q'])
  git(root, ['update-index', '-z', '--index-info'], git(ROOT, ['ls-files', '-s', '-z']))
}

/** root を作業の場所にして、root の写しの道具を回す。 */
export function runTool(root: string, script: string, args: string[] = [], env: Record<string, string> = {}): ToolRun {
  const file = join(root, 'scripts', script)
  if (!existsSync(file)) throw new Error(`入口 scripts/${script} が無い`)
  const r = spawnSync('python3', [file, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, env: { ...process.env, ...env } })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}`.split(root).join('<root>') }
}

/** リポジトリのまま道具を回す（読むだけの道具に限る）。 */
export const runReal = (script: string, args: string[] = []): ToolRun => runTool(ROOT, script, args)

/** 名前の無い例外で落ちていないこと（今の動きを写した要件は、名前の無い止まりを決めていない）。 */
export const crashed = (r: ToolRun) => /Traceback \(most recent call last\)/.test(r.stderr)
