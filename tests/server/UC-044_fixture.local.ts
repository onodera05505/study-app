/** UC-044（手元に依らない検査を共有の置き場で回し、手元に依る検査を手元の入口に受け持たせる）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: 操作名を snake_case にした `scripts/<名前>.sh`・`.ts`・`.py` を子プロセスで回す
 *  （runPortableChecks ＝ `scripts/run_portable_checks.*`、classifyChecks ＝ `scripts/classify_checks.*`。`.ts` は `npx tsx`、`.sh` は bash、`.py` は python3）。
 *  request は空（契約）。観測するのは、終了の状態と、標準出力と標準エラーの文と、影の根に残った跡だけ。
 *
 *  影の根（makeShadow）は、要件の「手元に依らないテストと手元だけのテストを 1 つずつ持つ小さな作業ツリー」。git の作業ツリーで、
 *  - リポジトリの置き場のうち、テストの置き場（tests）・受け持ちの置き場（scripts/contract_adapter/handlers）・学びの置き場（data・public）と、
 *    手元の設定の置き場（.claude・brain・apm_modules）のほかを写す（道具の入口とテストの組の設定は、手元の作業ツリーの今の物）
 *  - テストの置き場には、手元に依らないテスト 1 つ・手元の物の土台 1 つ・それを読み込む手元だけのテスト 1 つだけを置き、
 *    受け持ちの置き場には、手元に依らない UC と手元だけの UC（手元の物の土台を読み込む）の受け持ちを 1 つずつ置く
 *  - 手元の物そのもの（囲い・手元の配備と保存先・追跡しないファイル）は置かない。手元の物の土台は名前だけが手元の物の土台で、中で何も使わない
 *  - テスト以外の検査（原本 harness・型・静的な門・入口の一覧）は、呼ばれたことを `.probe/calls.jsonl` に書いて 0 で返す記録係に差し替える。
 *    差し替える先は `harness.config.json` の `commands` が宣言するコマンドが指す物（typecheck の npm スクリプト・lint の 2 つの道具・
 *    list_entries の道具）と、原本 harness の入口 `.harness/bin/harness.mjs`
 *  - テストは回ると `.probe/<名前>` に印を書く（手元の物の土台は読み込まれると `.probe/local-fixture` に書く）
 *  依存（node_modules）はリポジトリの物へのリンク。この土台はリポジトリが追跡しない置き場を名指すので、手元の物の土台（REQ-679）。 */

import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 写さない置き場（根からの相対の頭）。 */
const NOT_COPIED = ['tests/', 'scripts/contract_adapter/handlers/', 'data/', 'public/', '.claude/', 'brain/', 'apm_modules/', 'full']

/** 影の根に置く UC の ID（番号から組む。リポジトリの UC と重ならない番号）。 */
export const ucId = (n: number) => ['UC', String(n)].join('-')
/** 手元に依らない UC（受け持ちが手元の物の土台を読み込まない）。 */
export const PORTABLE_UC = ucId(992)
/** 手元だけの UC（受け持ちが手元の物の土台を読み込む）。 */
export const LOCAL_UC = ucId(991)

/** 影の根の中の、仕込みのテストと土台（根からの相対）。 */
export const PORTABLE_TEST = 'tests/server/probe_portable.test.ts'
export const LOCAL_FIXTURE = 'tests/server/probe_fixture.local.ts'
export const LOCAL_TEST = 'tests/server/probe_local.local.test.ts'
/** 間接に読み込む形（indirect を指定したときだけ置く）: 手元の物の土台を読み込む、名前の付かない土台と、それだけを読み込む手元だけのテスト。 */
export const MID_FIXTURE = 'tests/server/probe_mid_fixture.ts'
export const INDIRECT_TEST = 'tests/server/probe_indirect.local.test.ts'

const temps: string[] = []

/** 作った影の根をすべて消す。 */
export async function removeTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** git を、手元の git の設定を読まずに回す。 */
function git(root: string, args: string[]): string {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が通らない: ${r.stderr}`)
  return r.stdout
}

/** テストが回ったときに印を書く行（影の根の .probe/<name>）。 */
const markLine = (name: string) =>
  `mkdirSync(new URL('../../.probe/', import.meta.url), { recursive: true }); writeFileSync(new URL('../../.probe/${name}', import.meta.url), '1')`

/** 回ると印を書くテストのファイルの中身。imports は先頭に足す読み込みの行。 */
export const probeTest = (mark: string, opts: { imports?: string[]; fails?: boolean } = {}) =>
  [
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    "import { expect, it } from 'vitest'",
    ...(opts.imports ?? []),
    '',
    `it('仕込みのテスト（${mark}）', () => {`,
    `  ${markLine(mark)}`,
    `  expect(${opts.fails ? 'false' : 'true'}).toBe(true)`,
    '})',
    '',
  ].join('\n')

/** 受け持ちの中身。imports は先頭に足す読み込みの行。 */
const handler = (uc: string, imports: string[] = []) =>
  [...imports, "import { defineHandler } from '../kit/protocol'", '', `export default defineHandler({ uc: '${uc}', operations: {} })`, ''].join('\n')

const RECORD_JS = (tool: string) => `import { appendFileSync, mkdirSync } from 'node:fs'
const dir = new URL('../../.probe/', import.meta.url)
mkdirSync(dir, { recursive: true })
const tool = ${tool}
appendFileSync(new URL('calls.jsonl', dir), JSON.stringify({ tool, argv: process.argv.slice(${tool === 'process.argv[2]' ? 3 : 2}) }) + '\\n')
`
const RECORD_PY = (tool: string) => `#!/usr/bin/env python3
import json, os, sys
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".probe")
os.makedirs(d, exist_ok=True)
with open(os.path.join(d, "calls.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"tool": ${JSON.stringify(tool)}, "argv": sys.argv[1:]}) + "\\n")
`
const RECORD_TS = (tool: string) => `import { appendFileSync, mkdirSync } from 'node:fs'
const dir = new URL('../.probe/', import.meta.url)
mkdirSync(dir, { recursive: true })
appendFileSync(new URL('calls.jsonl', dir), JSON.stringify({ tool: ${JSON.stringify(tool)}, argv: process.argv.slice(2) }) + '\\n')
`

export type Shadow44 = {
  root: string
  /** 手元だけのテストのファイル（根からの相対）。 */
  localTest: string
  /** 手元だけの UC の ID。 */
  localUc: string
  portableTest: string
  portableUc: string
  path: (rel: string) => string
  /** ファイルを置いて、git の索引に足す。 */
  add: (rel: string, content: string) => void
}

export type ShadowOptions = {
  /** 手元に依らない仕込みのテストを落ちる物にする。 */
  portableFails?: boolean
  /** 間接に読み込む形（MID_FIXTURE と INDIRECT_TEST）も置く。 */
  indirect?: boolean
  /** ほかに置くファイル（根からの相対 → 中身）。git の索引に足す。 */
  files?: Record<string, string>
}

/** 影の根を作る（上の説明の小さな作業ツリー）。 */
export function makeShadow(opts: ShadowOptions = {}): Shadow44 {
  const base = mkdtempSync(join(tmpdir(), 'uc044-'))
  temps.push(base)
  const root = join(base, 'root')
  mkdirSync(root)
  const listed = git(ROOT, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((rel) => rel && !NOT_COPIED.some((p) => rel === p || rel.startsWith(p)))
  for (const rel of new Set(listed)) {
    const from = join(ROOT, rel)
    if (!existsSync(from) && !lstatSync(from, { throwIfNoEntry: false })) continue
    const to = join(root, rel)
    mkdirSync(dirname(to), { recursive: true })
    const st = lstatSync(from)
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
    else if (st.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE)
  }
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'))

  const path = (rel: string) => join(root, rel)
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(path(rel)), { recursive: true })
    writeFileSync(path(rel), content)
  }
  // テスト以外の検査を記録係に差し替える
  put('.harness/bin/harness.mjs', RECORD_JS("'harness'"))
  put('.harness/bin/record.mjs', RECORD_JS('process.argv[2]'))
  put('scripts/check_source.py', RECORD_PY('check_source'))
  put('scripts/check_docs.py', RECORD_PY('check_docs'))
  put('scripts/list_entries.ts', RECORD_TS('list_entries'))
  const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8')) as { scripts: Record<string, string> }
  pkg.scripts.typecheck = 'node .harness/bin/record.mjs typecheck'
  put('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
  // 仕込みのテストと土台と受け持ち
  put(PORTABLE_TEST, probeTest('portable', { fails: opts.portableFails }))
  put(LOCAL_FIXTURE, `import { mkdirSync, writeFileSync } from 'node:fs'\n\n${markLine('local-fixture')}\n\nexport const PROBE = 'local'\n`)
  put(LOCAL_TEST, probeTest('local', { imports: ["import { PROBE } from './probe_fixture.local'", 'void PROBE'] }))
  put(`scripts/contract_adapter/handlers/${PORTABLE_UC}.ts`, handler(PORTABLE_UC))
  put(`scripts/contract_adapter/handlers/${LOCAL_UC}.ts`, handler(LOCAL_UC, ["import { PROBE } from '../../../tests/server/probe_fixture.local'", 'void PROBE']))
  if (opts.indirect) {
    put(MID_FIXTURE, "export { PROBE } from './probe_fixture.local'\n")
    put(INDIRECT_TEST, probeTest('indirect', { imports: ["import { PROBE } from './probe_mid_fixture'", 'void PROBE'] }))
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) put(rel, content)

  git(root, ['init', '-q'])
  writeFileSync(join(root, '.git', 'info', 'exclude'), '/node_modules\n/.harness/\n/.probe/\n')
  git(root, ['add', '-A'])
  return {
    root,
    localTest: LOCAL_TEST,
    localUc: LOCAL_UC,
    portableTest: PORTABLE_TEST,
    portableUc: PORTABLE_UC,
    path,
    add: (rel, content) => {
      put(rel, content)
      git(root, ['add', '-f', '--', rel])
    },
  }
}

export type Run = { status: number | null; stdout: string; stderr: string; out: string }

/** 操作の入口を影の根の中で引く（scripts/<名前>.sh・.ts・.py の順）。無ければ投げる。 */
export function entryOf(root: string, name: string): string[] {
  for (const [ext, command] of [
    ['.sh', ['bash']],
    ['.ts', ['npx', 'tsx']],
    ['.py', ['python3']],
  ] as const) {
    const file = join(root, 'scripts', `${name}${ext}`)
    if (existsSync(file)) return [...command, file]
  }
  throw new Error(`入口 scripts/${name}.(sh|ts|py) が無い`)
}

/** 道具に渡す環境（親のテストの組の環境（VITEST で始まる物・TEST・NODE_ENV）を除いた物）。 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^VITEST/.test(k) && k !== 'TEST' && k !== 'NODE_ENV') env[k] = v
  return env
}

/** 影の根を作業の場所にして、影の根の写しの道具を回す。 */
export function runTool(s: Shadow44, name: string): Run {
  const [command, ...args] = entryOf(s.root, name)
  const env = childEnv()
  const r = spawnSync(command, args, { cwd: s.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, env })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}`.split(s.root).join('<root>') }
}

export const runPortableChecks = (s: Shadow44) => runTool(s, 'run_portable_checks')
export const classifyChecks = (s: Shadow44) => runTool(s, 'classify_checks')

/** 失敗の文に載せる出力（末尾）。 */
export const outOf = (r: Run) => `終了 ${r.status}\n${r.out.slice(-3000)}`

/** 記録係に残った呼び出し（呼ばれた順）。 */
export type Call = { tool: string; argv: string[] }
export function calls(s: Shadow44): Call[] {
  const file = s.path('.probe/calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Call)
}
/** 原本 harness の呼び出しのうち、契約の実例の確かめ（run cases）。 */
export const runCasesCalls = (s: Shadow44) => calls(s).filter((c) => c.tool === 'harness' && c.argv.includes('run') && c.argv.includes('cases'))

/** 仕込みのテスト（や土台）が回ったか（印が残ったか）。 */
export const ran = (s: Shadow44, mark: string) => existsSync(s.path(`.probe/${mark}`))

/** 出力の中で、name を含む行が置かれた組（「手元だけ」か「手元に依らない」。用語集の語）。
 *  行そのものに組の語があればその組、無ければ、その行より前で最後に組の語が出た行の組と読む。 */
export function groupsOf(out: string, name: string): Set<'local' | 'portable'> {
  const label = (line: string): 'local' | 'portable' | null => {
    const l = line.lastIndexOf('手元だけ')
    const p = line.lastIndexOf('手元に依らない')
    if (l < 0 && p < 0) return null
    return l > p ? 'local' : 'portable'
  }
  const groups = new Set<'local' | 'portable'>()
  let current: 'local' | 'portable' | null = null
  for (const line of out.split('\n')) {
    const own = label(line.split(name).join(''))
    if (line.includes(name)) {
      const g = own ?? current
      if (g) groups.add(g)
    }
    if (own) current = own
  }
  return groups
}
