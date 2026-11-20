/**
 * 入口の一覧を出す（契約 UC-034 の listEntries。導き方は docs/adr/ADR-0014-entries-from-apps-and-tools.md）。
 *
 *     npx tsx scripts/list_entries.ts
 *
 * 標準出力に 1 行 1 件の JSON を出す（行の形の正本は .harness/tools/lint-entries/README.md の「一覧の形」）。
 * - 経路: 学び側（src/server/index.ts）とまなびば（portal/src/index.ts）の既定の app に登録された経路を、
 *   どの method にも立つ中継ぎ（ALL の登録）を除いて {"kind":"http","method","path"} で出す。パラメーターは {名前} と書く
 * - 道具: 道具の置き場（scripts/）の直下のソースのファイル（harness.config.json の source.extensions の拡張子）を
 *   {"kind":"local-store","name"} で出す。名前は、名前の表（scripts/entry_names.json）に挙げたファイルは表の名前だけ、
 *   ほかはファイル名から拡張子を除いて camelCase にした物。表には直下でないファイルも挙げられる
 * 同じ入口（経路は method と path の組、道具は名前）は 1 回だけ出す。
 *
 * リポジトリのルートはこのファイルの 1 つ上の置き場で、呼んだ作業ディレクトリに依らない。
 * 断るときは入口を 1 件も出さず、標準出力に共有の形の ToolError（{"error":{"code","reason",…}}）を 1 行で出して終了の状態 1 で終える。
 * 断りの種類の名前の出所は src/shared/error-codes.json（ADR-0012）。人が読む理由は標準エラーにも出す。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS_DIR = 'scripts'
const NAMES_TABLE = 'scripts/entry_names.json'
const APPS = ['src/server/index.ts', 'portal/src/index.ts']

type Entry = { kind: 'http'; method: string; path: string } | { kind: 'local-store'; name: string }

/** 断り。code は出所のファイルにある断りの種類の名前。 */
class Refused extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(reason)
  }
}

/** 断りの種類の名前の出所（src/shared/error-codes.json）。 */
function errorCodes(): Record<string, string> {
  return JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'error-codes.json'), 'utf8')) as Record<string, string>
}

/** 名前を出所から引く。出所に無い名前は引けない（落ちる）。 */
function code(name: string): string {
  const value = errorCodes()[name]
  if (typeof value !== 'string') throw new Error(`断りの種類の名前 ${name} が src/shared/error-codes.json に無い`)
  return value
}

/** Hono の path の書き方（:name、:name{正規表現}、:name?）を、契約の wire.path の書き方（{name}）に直す。 */
function toContractPath(path: string): string {
  let out = ''
  let i = 0
  while (i < path.length) {
    const m = path[i] === ':' ? /^[A-Za-z0-9_]+/.exec(path.slice(i + 1)) : null
    if (!m) {
      out += path[i++]
      continue
    }
    i += 1 + m[0].length
    // 正規表現は、中に { } を含んでも対になる閉じ括弧までを 1 つとして読み飛ばす
    if (path[i] === '{') {
      let depth = 0
      do {
        if (path[i] === '\\') i++
        else if (path[i] === '{') depth++
        else if (path[i] === '}') depth--
        i++
      } while (i < path.length && depth > 0)
    }
    if (path[i] === '?') i++
    out += `{${m[0]}}`
  }
  return out
}

/** ファイル名（拡張子を除く）を camelCase にした名前。区切りは _ と -。 */
function toolName(file: string): string {
  const base = file.slice(0, file.length - extname(file).length)
  const words = base.split(/[_-]+/).filter((w) => w !== '')
  return words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('')
}

/** 設定（harness.config.json）がソースとする拡張子。 */
function sourceExtensions(): string[] {
  const config = JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8')) as { source?: { extensions?: unknown } }
  const ext = config.source?.extensions
  if (!Array.isArray(ext) || !ext.every((e) => typeof e === 'string')) throw new Error('harness.config.json の source.extensions が文字列の並びでない')
  return ext as string[]
}

/**
 * 名前の表（ファイル → 操作の名前の並び。ファイルは道具の置き場 scripts/ からの相対パス。ADR-0014）。表が無ければ空。
 * JSON として読めないか、表の形（空でない文字列の鍵 → 空でない文字列の 1 つ以上の並び）でなければ INVALID_INPUT、
 * 表に挙げたファイルが無ければ NOT_FOUND で断る。
 */
function readNamesTable(): Map<string, string[]> {
  const at = join(ROOT, NAMES_TABLE)
  if (!existsSync(at)) return new Map()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(at, 'utf8'))
  } catch (e) {
    throw new Refused(code('INVALID_INPUT'), `名前の表 ${NAMES_TABLE} が JSON として読めない（${(e as Error).message}）`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Refused(code('INVALID_INPUT'), `名前の表 ${NAMES_TABLE} が表の形（ファイル → 操作の名前の並び）でない`)
  }
  const bad = Object.entries(raw as Record<string, unknown>)
    .filter(([file, names]) => file.trim() === '' || !Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string' && n.trim() !== ''))
    .map(([file]) => file)
  if (bad.length > 0) {
    throw new Refused(code('INVALID_INPUT'), `名前の表 ${NAMES_TABLE} の行が表の形（空でない操作の名前の 1 つ以上の並び）でない: ${bad.join(', ')}`)
  }
  // 鍵は道具の置き場からの相対パス。./ や .. を含む別の書き方は、同じファイルを指す 1 つの書き方にそろえる
  const table = new Map<string, string[]>()
  for (const [file, listed] of Object.entries(raw as Record<string, string[]>)) {
    const key = relative(join(ROOT, TOOLS_DIR), resolve(ROOT, TOOLS_DIR, file)).split(sep).join('/')
    table.set(key, [...(table.get(key) ?? []), ...listed])
  }
  const missing = [...table.keys()].filter((file) => !isFile(join(ROOT, TOOLS_DIR, file)))
  if (missing.length > 0) {
    throw new Refused(code('NOT_FOUND'), `名前の表 ${NAMES_TABLE} に挙げたファイルが無い: ${missing.join(', ')}`)
  }
  return table
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 道具の入口。直下のソースのファイルは表に無ければファイル名から、表に挙げたファイル（直下でない物を含む）は表の名前だけ。 */
function toolEntries(table: Map<string, string[]>, extensions: string[]): Entry[] {
  const names: string[] = []
  const direct = readdirSync(join(ROOT, TOOLS_DIR))
    .filter((f) => extensions.includes(extname(f)) && isFile(join(ROOT, TOOLS_DIR, f)))
    .sort()
  for (const f of direct) {
    if (!table.has(f)) names.push(toolName(f))
  }
  for (const [, listed] of [...table.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) names.push(...listed)
  return names.map((name) => ({ kind: 'local-store', name }))
}

/** app を読み込み、登録された経路（ALL を除く）を出す。読み込めなければ INTERNAL で断る。 */
async function routeEntries(): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const file of APPS) {
    let app: { routes?: Array<{ method: string; path: string }> }
    // app の読み込みが標準出力に何か書いても、一覧の行に混ぜない
    const log = console.log
    console.log = (...args: unknown[]) => console.error(...args)
    try {
      app = (await import(pathToFileURL(join(ROOT, file)).href)).default
    } catch (e) {
      throw new Refused(code('INTERNAL'), `app ${file} を読み込めない（${(e as Error).message}）`)
    } finally {
      console.log = log
    }
    if (!app || !Array.isArray(app.routes)) {
      throw new Refused(code('INTERNAL'), `app ${file} の既定の export が登録された経路を持たない`)
    }
    for (const r of app.routes) {
      if (r.method === 'ALL') continue
      entries.push({ kind: 'http', method: r.method, path: toContractPath(r.path) })
    }
  }
  return entries
}

/** 同じ入口（経路は method と path の組、道具は名前）を初出の 1 つだけ残す。 */
function unique(entries: Entry[]): Entry[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const key = e.kind === 'http' ? `http ${e.method} ${e.path}` : `local-store ${e.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function main(): Promise<number> {
  try {
    const table = readNamesTable()
    const tools = toolEntries(table, sourceExtensions())
    const routes = await routeEntries()
    process.stdout.write(unique([...routes, ...tools]).map((e) => JSON.stringify(e) + '\n').join(''))
    return 0
  } catch (e) {
    if (!(e instanceof Refused)) throw e
    console.error(e.reason)
    process.stdout.write(JSON.stringify({ error: { code: e.code, reason: e.reason, ...e.detail } }) + '\n')
    return 1
  }
}

process.exitCode = await main()
