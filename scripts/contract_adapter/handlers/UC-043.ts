/**
 * UC-043 の受け持ち（コミットの件名の検査を入れる道具。入口は CLAUDE.md の「道具を回す操作」の行: installGithooks ＝ `bash scripts/install_githooks.sh`）。
 *
 * 道具はクローンの git の設定（フックの置き場）を書き換えるので、リポジトリでは回さない。実例ごとに一時の置き場に git init した別のクローンを作り、
 * 道具とリポジトリの中のフックの置き場（`.githooks`）を写して、その中で回す。利用者の git の設定（HOME）も一時の置き場に向ける。
 * 応答は終了の状態（契約の exitCode）。道具は断りの種類の名前を出さない（errors: []）。
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHandler, Unanswerable, type Operation } from '../kit/protocol'
import { REPO_ROOT, runTool, toolAnswer } from '../kit/tool'

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
const installGithooks: Operation = async (line) => {
  if (line.case !== 'ok') throw new Unanswerable(`UC-043 installGithooks の例 ${line.case} の前提を知らない`)
  const base = await realpath(await mkdtemp(join(tmpdir(), `contract-adapter-${process.pid}-uc043-`)))
  try {
    const clone = join(base, 'clone')
    const home = join(base, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = contract-adapter\n\temail = contract-adapter@example.invalid\n')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(home, '.config') }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    const init = spawnSync('git', ['init', '-q', clone], { env, encoding: 'utf8' })
    if (init.status !== 0) throw new Unanswerable(`前提のクローンを作れない: ${init.stderr}`)
    await mkdir(join(clone, 'scripts'), { recursive: true })
    await cp(join(REPO_ROOT, 'scripts', 'install_githooks.sh'), join(clone, 'scripts', 'install_githooks.sh'))
    await cp(join(REPO_ROOT, '.githooks'), join(clone, '.githooks'), { recursive: true })
    const run = await runTool(['bash', join(clone, 'scripts', 'install_githooks.sh')], { cwd: clone, env, timeoutMs: 60_000 })
    return toolAnswer(run, (r) => ({ exitCode: r.code }))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-043',
  parallel: true,
  operations: { installGithooks },
})
