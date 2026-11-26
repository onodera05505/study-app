import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT,
  ENV_ACCOUNT_DIFFERS,
  OTHER_ACCOUNT,
  pagesCalls,
  redact,
  removeShadows,
  runTool,
  secretsPut,
  shadow39,
  storageCalls,
  type LogEntry,
  type Run,
  type Shadow39,
  type World,
} from './UC-039_fixture.local'

/** UC-016 まなびばの配備の手続き（契約 deployPortal。入口は `bash scripts/deploy_portal.sh [--setup]`）が、配備先のアカウントを照らすこと（REQ-676）。
 *
 *  囲いは UC-039 の土台（UC-039_fixture.local.ts の shadow39・runTool。その下は UC-032 の土台）: 影の根で手続きを回し、配備の道具（wrangler・npx）は
 *  偽物が受けて呼び出しを記録し、外への接続と本体のチェックアウトへの書き込みは OS の囲いが断つ。本物の配備の道具と本番には届かない。
 *  まなびばの組み立て（buildPortal ＝ `scripts/build_portal.py`）は、呼ばれたことを記録して 0 で返す包みに差し替える。
 *
 *  決めた配備のアカウント（正本は配備先の一覧 `scripts/pages_projects.json` の account_id）は、影の根の中で偽の値に置き換え、
 *  偽の配備の道具の whoami もその偽の値を答える。ログイン中の違うアカウントと向け先のアカウントの環境変数の値も偽の値。
 *  本物のアカウントの値はどの回にも渡らず、出力にも出ない。
 *
 *  固定した版の道具が無い回は、影の根から固定した版（node_modules/wrangler と node_modules/.bin/wrangler・wrangler2）を除き、別の版の道具だけを残す
 *  （PATH の wrangler と、npx wrangler の先はどちらも別の版の偽物）。その回は npx の呼び出しも記録する。 */

vi.setConfig({ testTimeout: 180_000 })
afterAll(removeShadows, 120_000)

/** 影の根の中で決めた配備のアカウントとして使う偽の値。 */
const DECIDED = 'fedcba9876543210fedcba9876543210'
const BUILD = 'build_portal.py'

/** 影の根の、リンクでない（写した）ファイルを集める。node_modules の下は見ない。 */
function copiedFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const at = join(dir, name)
    const st = lstatSync(at)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) copiedFiles(at, out)
    else if (st.isFile() && st.size < 8_000_000) out.push(at)
  }
  return out
}

/** まなびばの配備の手続きを回す影の根（組み立ては包み。決めた配備のアカウントは偽の値）。pinned が false なら固定した版の道具を除く。 */
function portalShadow(name: string, pinned: boolean): Shadow39 {
  const s = shadow39(`676-${name}`, { wrap: { [BUILD]: 0 } })
  const stubs = [join(s.root, 'node_modules', 'wrangler', 'bin', 'wrangler.orig.js'), join(s.dir, 'unpinned-wrangler.orig.js')]
  for (const f of [...copiedFiles(s.root), ...stubs]) {
    const text = readFileSync(f, 'latin1')
    if (!text.includes(ACCOUNT)) continue
    writeFileSync(f, text.split(ACCOUNT).join(DECIDED), 'latin1')
  }
  if (!pinned) withoutPinnedTool(s)
  return s
}

/** 影の根から固定した版の道具を除き、別の版の道具だけがある状態にする。npx は呼ばれたことを記録し、npx wrangler は別の版の偽物に渡す。 */
function withoutPinnedTool(s: Shadow39): void {
  rmSync(join(s.root, 'node_modules', 'wrangler'), { recursive: true, force: true })
  for (const name of ['wrangler', 'wrangler2']) rmSync(join(s.root, 'node_modules', '.bin', name), { force: true })
  const npx = join(s.bin, 'npx')
  writeFileSync(
    npx,
    `#!/usr/bin/env bash
args=""
for a in "$@"; do args="$args,\\"$a\\""; done
printf '{"tool":"npx","argv":[%s]}\\n' "\${args#,}" >> "$STUB_LOG"
for a in "$@"; do case "$a" in -*) ;; wrangler*) to=1; break ;; *) break ;; esac; done
if [ -n "$to" ]; then
  while [ $# -gt 0 ]; do case "$1" in wrangler*) shift; break ;; *) shift ;; esac; done
  exec "${join(s.dir, 'unpinned-wrangler.js')}" "$@"
fi
exec "${join(s.bin, 'npx-uc032')}" "$@"
`,
  )
  chmodSync(npx, 0o755)
}

/** 手続きが書いてはいけないリポジトリのファイル（配備先の一覧・まなびばの配備の設定）の中身と、まなびばの置き場のファイルの並び（組み立ての出力が増えないか）。 */
function repoState(s: Shadow39) {
  const read = (rel: string) => (existsSync(s.path(rel)) ? readFileSync(s.path(rel), 'utf8') : null)
  const portalTree = copiedFiles(s.path('portal'))
    .map((f) => relative(s.root, f))
    .filter((f) => !f.split('/').includes('__pycache__'))
    .sort()
  return {
    projects: read('scripts/pages_projects.json'),
    portalConfig: read('portal/wrangler.jsonc'),
    portalTree,
    dist: existsSync(s.path('dist')) || existsSync(s.path('portal/dist')),
  }
}

const argsOf = (e: LogEntry): string[] => (Array.isArray(e.argv) ? e.argv : [e.argv])
const crashed = (r: Run) => /Traceback \(most recent call last\)/.test(r.out)
/** 照らす問い合わせ（固定した版の wrangler whoami）。 */
const isCheck = (e: LogEntry) => e.tool === 'pinned' && argsOf(e)[0] === 'whoami'
/** 照らす問い合わせの最初の位置（無ければ -1）。 */
const checkAt = (r: Run) => r.log.findIndex(isCheck)
/** 照らす問い合わせのほかに呼んだ物（配備の道具のどの版も・版の問い合わせも・npx も・組み立ても・外への要求も）。 */
const actions = (r: Run) => r.log.filter((e) => !isCheck(e))
const describeActions = (r: Run) => redact(actions(r).map((e) => `${e.tool} ${argsOf(e).slice(0, 3).join(' ')}`).join('\n'))

/** 手続きを回し、回す前と後のリポジトリのファイルの様子と一緒に返す。 */
async function deploy(name: string, args: string[], world: World, pinned = true) {
  const s = portalShadow(name, pinned)
  const before = repoState(s)
  const r = await runTool(s, 'deploy_portal.sh', args, world)
  return { s, r, before, after: repoState(s) }
}

/** 照らす問い合わせ（checks 回。0 か 1）のほかは何もせず、リポジトリのファイルを書かず、配信しないまま失敗で終えた。 */
function refusedForAccount(x: Awaited<ReturnType<typeof deploy>>, checks: 0 | 1) {
  const { r } = x
  expect(crashed(r), redact(r.out)).toBe(false)
  expect(r.code, `失敗で終わっていない:\n${redact(r.out)}`).not.toBe(0)
  expect(r.log.filter(isCheck).length, `照らす問い合わせの回数が違う:\n${redact(r.out)}`).toBe(checks)
  expect(actions(r).length, `照らすほかに何かをした:\n${describeActions(r)}`).toBe(0)
  expect(r.log.filter((e) => e.tool === BUILD).length, 'まなびばを組み立てた').toBe(0)
  expect(pagesCalls(r).filter((a) => a[1] === 'deploy').length, '配信した').toBe(0)
  expect(x.after.projects === x.before.projects, '配備先の一覧を書き換えた').toBe(true)
  expect(x.after.portalConfig === x.before.portalConfig, 'まなびばの配備の設定を書き換えた').toBe(true)
  expect(x.after.portalTree, 'まなびばの置き場にファイルを書いた').toEqual(x.before.portalTree)
  expect(x.after.dist, '組み立ての出力を書いた').toBe(x.before.dist)
}
const shows = (r: Run, value: string) => r.out.includes(value)

describe('UC-016 まなびばの配備の手続きは、配備先のアカウントを照らしてから配信する', () => {
  describe('REQ-676 向け先かログイン中のアカウントが決めたアカウントと違うか、固定した版の道具が無いか確かめられなければ、照らすほかは何もせず配信しない', () => {
    // @covers REQ-676#other-account
    it('配備先に決めたアカウントと違うアカウントだけでログインしていると、両方のアカウントを示し、照らす問い合わせのほかは何もせずに、配信しないまま失敗で終わる', async () => {
      const x = await deploy('other', [], { whoami: 'other' })
      refusedForAccount(x, 1)
      expect(shows(x.r, OTHER_ACCOUNT), 'ログイン中のアカウントを示していない').toBe(true)
      expect(shows(x.r, DECIDED), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-676#account-unverifiable
    it('固定した版の道具は入っているが、ログイン中のアカウントを確かめられないと、決めたアカウントを示し、照らす 1 回のほかは配備の道具（版の問い合わせも）を呼ばずに、配信しないまま失敗で終わる', async () => {
      const x = await deploy('unverifiable', [], { whoami: 'fail' })
      refusedForAccount(x, 1)
      expect(shows(x.r, DECIDED), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-676#setup-other-account
    it('初回の用意（--setup）を指定し、決めたアカウントと違うアカウントだけでログインしていると、保存先を作らず、構造の変更を当てず、共有秘密を置かず、照らす問い合わせのほかは何もせずに失敗で終わる', async () => {
      const x = await deploy('setup-other', ['--setup'], { whoami: 'other' })
      refusedForAccount(x, 1)
      expect(storageCalls(x.r).length, '保存先に触った（作った・構造の変更を当てた）').toBe(0)
      expect(pagesCalls(x.r).filter((a) => a[1] === 'secret').length, '共有秘密に触った').toBe(0)
      expect(Object.keys(secretsPut(x.s)).length, '共有秘密を置いた').toBe(0)
    })

    // @covers REQ-676#several-accounts-listed
    it('ログイン中に 2 つのアカウントが見え、決めたアカウントが並びの 2 番目にあれば、合うとして、アカウントを照らしたあとでまなびばの組み立てに進む', async () => {
      const { r } = await deploy('several', [], { whoami: 'several' })
      const at = checkAt(r)
      expect(at, `アカウントを照らしていない:\n${redact(r.out)}`).toBeGreaterThanOrEqual(0)
      const builds = r.log.map((e, i) => ({ e, i })).filter(({ e, i }) => i > at && e.tool === BUILD)
      expect(builds.length, `照らしたあとでまなびばの組み立てに進んでいない:\n${redact(r.out)}`).toBe(1)
    })

    // @covers REQ-676#env-account-differs
    it('向け先のアカウントの環境変数が決めたアカウントと違えば、固定した版の道具が入っていてログイン中の並びに決めたアカウントがあっても、配備の道具を 1 回も呼ばず（版の問い合わせも）、組み立ても配信もしないまま、向け先と決めたアカウントを示して失敗で終わる', async () => {
      const x = await deploy('env-differs', [], ENV_ACCOUNT_DIFFERS)
      refusedForAccount(x, 0)
      expect(shows(x.r, OTHER_ACCOUNT), '食い違ったアカウント（向け先のアカウント）を示していない').toBe(true)
      expect(shows(x.r, DECIDED), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-676#pinned-tool-missing
    it('環境変数を与えず、固定した版の道具が無く別の版の道具だけがあると、確かめられないとして決めたアカウントを示し、どの版の道具も npx も呼ばずに、配信しないまま失敗で終わる', async () => {
      const x = await deploy('pinned-missing', [], {}, false)
      refusedForAccount(x, 0)
      expect(shows(x.r, DECIDED), '決めたアカウントを示していない').toBe(true)
    })

    // @covers REQ-676#env-account-differs-without-pinned-tool
    it('向け先のアカウントの環境変数が決めたアカウントと違い、固定した版の道具が無く別の版の道具だけがあると、固定した版が無いことより先に向け先と決めたアカウントを示し、どの版の道具も npx も呼ばずに、配信しないまま失敗で終わる', async () => {
      const x = await deploy('env-differs-unpinned', [], ENV_ACCOUNT_DIFFERS, false)
      refusedForAccount(x, 0)
      expect(shows(x.r, OTHER_ACCOUNT), '食い違ったアカウント（向け先のアカウント）を示していない').toBe(true)
      expect(shows(x.r, DECIDED), '決めたアカウントを示していない').toBe(true)
    })
  })
})
