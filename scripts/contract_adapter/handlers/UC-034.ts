/**
 * UC-034 の受け持ち（入口の一覧を出す道具 listEntries。入口は `npx tsx scripts/list_entries.ts`、引数なし）。
 *
 * 道具は自分のファイルの 1 つ上をリポジトリのルートとして読むので、前提の状態は影の根（リポジトリの各物へのリンクに差し替えを重ねた物）で作り、
 * 影の根に道具の写しを置いて回す（リンクのままだと node が元の場所に解き、リポジトリを読んでしまう）。
 * - ok: リポジトリのまま回す（読むだけで書かない）
 * - tableUnreadable: 名前の表 `scripts/entry_names.json` を、JSON として読めない中身に差し替える
 * - listedFileMissing: 名前の表を、無いファイルを挙げた表に差し替える
 * - appUnloadable: 学び側の app（`src/server/index.ts`）を、読み込むと例外を投げる物に差し替える
 * 応答は、終了の状態と、標準出力の行を順に JSON として読んだ entries。断りの名前は kit/tool.ts の toolErrorCode の読み方。
 */

import { cp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineHandler, Unanswerable, type Answer, type ExampleLine, type Operation } from '../kit/protocol'
import { REPO_ROOT, runTool, shadowRoot, toolErrorCode, unnamedStop, type ToolRun } from '../kit/tool'

const TOOL = 'scripts/list_entries.ts'
const TABLE = 'scripts/entry_names.json'
const LEARNING_APP = 'src/server/index.ts'

/** 標準出力の行を順に JSON として読む。読めない行があれば null。 */
function entriesOf(stdout: string): unknown[] | null {
  const out: unknown[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      return null
    }
  }
  return out
}

/** 道具を回した結果を答えに読む。 */
function answerOf(run: ToolRun): Answer {
  const code = toolErrorCode(run.stdout)
  if (code !== null) return { error: code }
  if (run.code !== 0) return unnamedStop(run)
  const entries = entriesOf(run.stdout)
  if (entries === null) throw new Unanswerable(`一覧の行が JSON として読めない: ${run.stdout.slice(0, 200)}`)
  return { response: { exitCode: run.code, entries } }
}

const tsx = (root: string) => [join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), join(root, TOOL)]

/** from の子を to にリンクで写し、except の名前だけ除く。 */
async function linkChildren(from: string, to: string, except: string[]): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const name of await readdir(from)) if (!except.includes(name)) await symlink(join(from, name), join(to, name))
}

/**
 * replace（リポジトリの根からの相対パス → 中身）を差し替えた影の根で道具を回す。差し替えるファイルの親の各段はディレクトリにし、兄弟はリンクにする。
 * @implements REQ-567, REQ-570
 */
async function inShadow(replace: Record<string, string>): Promise<Answer> {
  const shadow = await shadowRoot()
  try {
    const files = { ...replace }
    if (!existsSync(join(REPO_ROOT, TOOL))) throw new Unanswerable(`入口 ${TOOL} が無い`)
    const placed = new Set([TOOL, ...Object.keys(files)])
    /** dir（相対）の下を、placed に入る物の親の段だけディレクトリにして作る。 */
    const build = async (dir: string): Promise<void> => {
      const from = join(REPO_ROOT, dir)
      const to = join(shadow.root, dir)
      const deeper = new Set([...placed].filter((p) => p.startsWith(dir === '' ? '' : `${dir}/`)).map((p) => p.slice(dir === '' ? 0 : dir.length + 1).split('/')[0]))
      await linkChildren(from, to, ['.git', ...deeper])
      for (const name of deeper) {
        const rel = dir === '' ? name : `${dir}/${name}`
        if (placed.has(rel)) continue
        if (existsSync(join(REPO_ROOT, rel)) && statSync(join(REPO_ROOT, rel)).isDirectory()) await build(rel)
      }
    }
    await build('')
    await cp(join(REPO_ROOT, TOOL), shadow.path(TOOL))
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(join(shadow.path(rel), '..'), { recursive: true })
      await writeFile(shadow.path(rel), body)
    }
    return answerOf(await runTool(tsx(shadow.root), { cwd: shadow.root, timeoutMs: 120_000 }))
  } finally {
    await shadow.cleanup()
  }
}

const listEntries: Operation = async (line: ExampleLine) => {
  switch (line.case) {
    case 'ok':
      if (!existsSync(join(REPO_ROOT, TOOL))) throw new Unanswerable(`入口 ${TOOL} が無い`)
      return answerOf(await runTool(tsx(REPO_ROOT), { cwd: REPO_ROOT, timeoutMs: 120_000 }))
    case 'tableUnreadable':
      return inShadow({ [TABLE]: '{ "list_entries.ts": [' })
    case 'listedFileMissing':
      return inShadow({ [TABLE]: JSON.stringify({ 'uc034_no_such_tool.py': ['uc034MissingName'] }) })
    case 'appUnloadable':
      return inShadow({ [LEARNING_APP]: `throw new Error('契約の実例の前提: 読み込めない app')\nexport default {}\n` })
    default:
      throw new Unanswerable(`UC-034 listEntries の例 ${line.case} の前提を知らない`)
  }
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-034',
  parallel: true,
  operations: { listEntries },
})
