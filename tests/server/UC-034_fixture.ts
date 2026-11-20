/** UC-034「入口の一覧を出し、契約と突き合わせられるようにする」のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: 操作 listEntries は `scripts/list_entries.ts`
 *  （`npx tsx scripts/list_entries.ts`、引数なし）。道具は自分のファイルの 1 つ上をリポジトリのルートとして読む。
 *  観測するのは、終了の状態と標準出力（1 行に 1 件の JSON。行の形の正本は `.harness/tools/lint-entries/README.md` の「一覧の形」）だけ。
 *
 *  - 今のリポジトリの実物に当てるときは、リポジトリの道具をそのまま回す（runReal）。
 *  - 小さい状態に当てるときは、影の根（entryShadow）を作る。影の根は、リポジトリの各物へのリンクに、
 *    学び側とまなびばの app（`src/server/index.ts`・`portal/src/index.ts`）・道具の置き場（`scripts/` の直下）・名前の表
 *    （`scripts/entry_names.json`）の差し替えを重ねる。道具 `scripts/list_entries.ts` はリンクでなく写しを置く
 *    （node はリンクを元の場所に解くので、リンクのままだと影の根でなくリポジトリを読んでしまう）。
 *    設定（harness.config.json）も写す。差し替えない物はリンクのまま（作り直しを最小にする）。 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error 原本の harness の依存なしの .mjs（型を持たない）。契約を lint spec・lint refs・run cases と同じ読み方で読む
import { parseStrictYaml } from '../../.harness/tools/_shared/strict-yaml.mjs'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const TOOL = 'scripts/list_entries.ts'
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
/** 名前の表の置き場（ADR-0014）。 */
export const TABLE = 'scripts/entry_names.json'

export type Json = Record<string, any>
export type RouteLine = { kind: 'http'; method: string; path: string }
export type ToolLine = { kind: 'local-store'; name: string }

export type ListRun = {
  status: number | null
  stdout: string
  stderr: string
  /** 標準出力の空でない行を JSON として読んだ物（読めない行は null） */
  lines: (Json | null)[]
  /** 断ったときの ToolError の error（標準出力の全体か最後の空でない行） */
  refusal: Json | undefined
}

const temps: string[] = []

/** 作った影の根をすべて消す。 */
export async function removeTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

function readJsonLine(text: string): Json | null {
  try {
    const v = JSON.parse(text) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
  } catch {
    return null
  }
}

/** 道具を root で回す（引数なし）。 */
function runAt(root: string): ListRun {
  const r = spawnSync(TSX, [join(root, TOOL)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
  const stdout = r.stdout ?? ''
  const nonEmpty = stdout.split('\n').filter((l) => l.trim() !== '')
  const lines = nonEmpty.map(readJsonLine)
  const errorOf = (j: Json | null) => (j && j.error && typeof j.error === 'object' ? (j.error as Json) : undefined)
  const refusal = errorOf(readJsonLine(stdout.trim())) ?? errorOf(nonEmpty.length ? readJsonLine(nonEmpty[nonEmpty.length - 1]) : null)
  return { status: r.status, stdout, stderr: r.stderr ?? '', lines, refusal }
}

/** 今のリポジトリの実物で一覧を出す。 */
export const runReal = (): ListRun => runAt(ROOT)

/** 失敗のときに読む、出力の末尾。 */
export const tailOf = (r: ListRun) => `終了 ${r.status}\n${r.stdout}\n${r.stderr}`.split('\n').slice(-30).join('\n')

/** 入口の行（kind を持つ行）。 */
export const entriesOf = (r: ListRun): Json[] => r.lines.filter((l): l is Json => l !== null && typeof l.kind === 'string')
export const routesOf = (r: ListRun): RouteLine[] => entriesOf(r).filter((l) => l.kind === 'http') as RouteLine[]
export const toolsOf = (r: ListRun): ToolLine[] => entriesOf(r).filter((l) => l.kind === 'local-store') as ToolLine[]
export const routeKey = (l: { method: string; path: string }) => `${l.method} ${l.path}`

/** 一覧を出して終えた形: 終了 0・どの行も JSON で、経路は kind・method・path だけ、道具は kind・name だけを持つ。 */
export function expectListed(r: ListRun, expectFn: (v: unknown, m?: string) => any) {
  expectFn(r.status, tailOf(r)).toBe(0)
  for (const [i, l] of r.lines.entries()) {
    expectFn(l, `${i + 1} 行目が JSON のオブジェクトでない:\n${tailOf(r)}`).not.toBeNull()
    const keys = Object.keys(l!).sort()
    if (l!.kind === 'http') expectFn(keys, `${i + 1} 行目`).toEqual(['kind', 'method', 'path'])
    else expectFn([l!.kind, keys], `${i + 1} 行目`).toEqual(['local-store', ['kind', 'name']])
  }
}

/** 断った形: 終了 0 でない・標準出力の ToolError の code・理由が空でない・入口の行を 1 件も出さない。 */
export function expectRefused(r: ListRun, code: string, expectFn: (v: unknown, m?: string) => any) {
  expectFn(r.status, tailOf(r)).not.toBe(0)
  expectFn(r.refusal?.code, tailOf(r)).toBe(code)
  expectFn(String(r.refusal?.reason ?? '').length, tailOf(r)).toBeGreaterThan(0)
  expectFn(entriesOf(r), `入口を出した:\n${tailOf(r)}`).toEqual([])
}

// ---------------------------------------------------------------------------
// 置き場の中身から導く期待（実装から写さない）

/** 設定がソースとする拡張子（harness.config.json の source.extensions）。 */
export const sourceExtensions = (): string[] =>
  (JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8')) as Json).source.extensions as string[]

/** ファイル名から拡張子を除いて camelCase にした名前（区切りは `_` と `-`）。 */
export const camelName = (file: string): string => {
  const base = file.slice(0, file.length - extname(file).length)
  return base.replace(/[_-]+([A-Za-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

/** 名前の表の鍵（表に挙げるファイルの書き方）。道具の置き場 `scripts/` からの相対パス（ADR-0014）。 */
export const tableKey = (relFromScripts: string) => relFromScripts

/** 確定した契約の、受ける側の http の操作の wire（学び側とまなびばの経路）。 */
export function fixedInboundWires(): Array<{ uc: string; operation: string; method: string; path: string }> {
  const goals = join(ROOT, 'docs', 'goals')
  const out: Array<{ uc: string; operation: string; method: string; path: string }> = []
  for (const goal of readdirSync(goals)) {
    const gdir = join(goals, goal)
    if (!statSync(gdir).isDirectory() || goal.startsWith('.') || goal.startsWith('_')) continue
    for (const uc of readdirSync(gdir)) {
      const file = join(gdir, uc, 'contract.yaml')
      if (!existsSync(file)) continue
      const { root } = parseStrictYaml(readFileSync(file, 'utf8')) as { root: Json }
      if (root['x-status'] !== 'fixed') continue
      for (const [operation, op] of Object.entries((root.operations ?? {}) as Record<string, Json>)) {
        if (op.transport !== 'http' || op.direction !== 'inbound' || !op.wire) continue
        out.push({ uc: String(root['x-uc']), operation, method: String(op.wire.method), path: String(op.wire.path) })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 影の根

/** Hono の小さい app のソース。lines は `app` への登録の文（例: `app.get('/api/x', (c) => c.text('x'))`）。 */
export const honoApp = (lines: string[]) => [`import { Hono } from 'hono'`, `const app = new Hono()`, ...lines, `export default app`, ''].join('\n')

/** 読み込むと例外を投げる app のソース。 */
export const throwingApp = `throw new Error('UC-034 のテストの仕込み: 読み込めない app')\nexport default {}\n`

export type ShadowOptions = {
  /** 学び側の app（`src/server/index.ts`）のソース。省くとリポジトリの物 */
  learningApp?: string
  /** まなびばの app（`portal/src/index.ts`）のソース。省くとリポジトリの物 */
  portalApp?: string
  /** 道具の置き場の直下に置くファイル（名前 → 中身）。与えると、直下のファイルはこれと道具の写しだけになる（ディレクトリはリンクのまま）。省くとリポジトリの物 */
  scripts?: Record<string, string>
  /** 道具の置き場の下のディレクトリに置くファイル（`scripts/` からの相対パス → 中身） */
  nested?: Record<string, string>
  /** 名前の表の中身（文字列はそのまま、オブジェクトは JSON）。null で表を置かない。省くとリポジトリの物 */
  table?: string | Json | null
}

/** dir の子をリンクで写し、except の名前だけ除く。 */
function linkChildren(from: string, to: string, except: Set<string>) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) if (!except.has(name)) symlinkSync(join(from, name), join(to, name))
}

/** 影の根を作り、そのパスを返す。 */
export function entryShadow(opts: ShadowOptions = {}): string {
  if (opts.scripts !== undefined && opts.table === undefined) throw new Error('仕込み: 直下のファイルを差し替えるときは、名前の表も決める（null で置かない）')
  const base = mkdtempSync(join(tmpdir(), 'uc034-'))
  temps.push(base)
  const root = join(base, 'root')
  // 差し替える置き場（src/server・portal/src・scripts）の親は、ディレクトリにして子をリンクにする
  linkChildren(ROOT, root, new Set(['.git', 'src', 'portal', 'scripts', 'harness.config.json']))
  cpSync(join(ROOT, 'harness.config.json'), join(root, 'harness.config.json'))
  linkChildren(join(ROOT, 'src'), join(root, 'src'), new Set(['server']))
  linkChildren(join(ROOT, 'src', 'server'), join(root, 'src', 'server'), new Set(['index.ts']))
  linkChildren(join(ROOT, 'portal'), join(root, 'portal'), new Set(['src']))
  linkChildren(join(ROOT, 'portal', 'src'), join(root, 'portal', 'src'), new Set(['index.ts']))
  if (opts.learningApp === undefined) symlinkSync(join(ROOT, 'src', 'server', 'index.ts'), join(root, 'src', 'server', 'index.ts'))
  else writeFileSync(join(root, 'src', 'server', 'index.ts'), opts.learningApp)
  if (opts.portalApp === undefined) symlinkSync(join(ROOT, 'portal', 'src', 'index.ts'), join(root, 'portal', 'src', 'index.ts'))
  else writeFileSync(join(root, 'portal', 'src', 'index.ts'), opts.portalApp)

  // 道具の置き場: 道具は写し、表は差し替え、直下のファイルは与えた物だけ（与えなければリポジトリの物のリンク）
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  for (const name of readdirSync(join(ROOT, 'scripts'))) {
    const src = join(ROOT, 'scripts', name)
    const isDir = statSync(src).isDirectory()
    if (`scripts/${name}` === TOOL || `scripts/${name}` === TABLE) continue
    if (isDir) symlinkSync(src, join(scripts, name))
    else if (opts.scripts === undefined) symlinkSync(src, join(scripts, name))
  }
  if (existsSync(join(ROOT, TOOL))) cpSync(join(ROOT, TOOL), join(root, TOOL))
  for (const [name, body] of Object.entries(opts.scripts ?? {})) writeFileSync(join(scripts, name), body)
  for (const [rel, body] of Object.entries(opts.nested ?? {})) {
    const target = join(scripts, rel)
    const top = rel.split('/')[0]
    // 既存のディレクトリ（リンク）の中には書かず、無い名前のディレクトリを作って置く
    if (existsSync(join(ROOT, 'scripts', top))) throw new Error(`仕込み: scripts/${top} はリポジトリにあるので、別の名前のディレクトリに置く`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
  if (opts.table === undefined) {
    if (existsSync(join(ROOT, TABLE))) cpSync(join(ROOT, TABLE), join(root, TABLE))
  } else if (opts.table !== null) {
    writeFileSync(join(root, TABLE), typeof opts.table === 'string' ? opts.table : JSON.stringify(opts.table, null, 2))
  }
  return root
}

/** 影の根で一覧を出す。 */
export const runShadow = (opts: ShadowOptions = {}): ListRun => runAt(entryShadow(opts))

