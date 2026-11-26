/**
 * 検査の振り分けを確かめる（`npx tsx scripts/classify_checks.ts`。引数は無い）。
 *
 * テストのファイル（tests の下の `*.test.ts`・`*.test.tsx`）と、契約の受け渡し役の受け持ちの UC を、
 * 手元の物の土台を直にか間接に読み込むかどうかで、手元だけの物と手元に依らない物のどちらか一方に分けて示す。
 * - 手元の物の土台は、tests の下のテストでないファイルのうち、名前が `.local.ts` で終わる物
 * - 手元だけのテストのファイルは、名前が `.local.test.ts`・`.local.test.tsx` で終わる物（単体テストの組 local が回す）。
 *   ほかのテストのファイルは手元に依らない物（単体テストの組 portable が回す。組の正本は vitest.config.ts）
 * - 受け持ちは scripts/contract_adapter/handlers の `UC-nnn.ts` と `UC-nnn.<部分>.ts`。そのどれかが手元の物の土台を読み込む UC は手元だけ。
 *   契約（docs/goals の下の contract.yaml）を持つほかの UC は、受け持ちが無くても手元に依らない物に数える（契約の実例の確かめが無いことを示すのは run cases）
 * - 読み込みは、静的に書いた import・export … from・import('…')・require('…') の相対の名前だけを辿る。文字列から組み立てた名前は辿らない
 *
 * 名前と中身の食い違いがあれば、それをすべて挙げて終了の状態 1 で終える。食い違いは 3 つ。
 * - 手元の物の土台を読み込むのに、手元だけの名前を持たないテストのファイル
 * - 手元だけの名前を持つのに、手元の物の土台を読み込まないテストのファイル
 * - 手元の物を中で直に使うのに、手元の物の土台の名前を持たない土台。手元の物を使うとは、コメントを除いた中身が次のどれかを持つこと
 *   - 囲いの道具 `sandbox-exec` か、配備の道具 `wrangler` を起こす文字列
 *   - 手元の保存先 `.wrangler` か、家の置き場（homedir()・process.env.HOME・`~/`）を名指す
 *   - git が無視するパスを名指す文字列（`/` を含むか `.` で始まる物を、根からか、`./`・`../` ならそのファイルの置き場から読む）。
 *     共有の置き場の検査の環境が持つ物（宣言した依存の node_modules と、ワークフローが固定した版で取る原本 harness の .harness）は除く
 *   - 契約の実例の確かめ（contract-run か run cases）を、同じ配列の中に `--uc` を持たずに起こす（UC を絞らないので、手元だけの UC の実例も回る）
 * 土台が手元の物を使っていることは、その土台の中だけで見る。テストのファイルの中は見ない（テストのファイルは土台を通して手元の物を使う決まり）。
 *
 * 出力は標準出力。通ったときは 4 つの組（手元に依らないテストのファイル・手元だけのテストのファイル・手元に依らない UC・手元だけの UC）を、
 * 組の見出しの行と、その下の 2 字下げの名前の行（テストのファイルは根からの相対パス、UC は ID）で出す。
 * scripts/run_portable_checks.sh がこの形を読む。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TESTS_DIR = 'tests'
const HANDLERS_DIR = 'scripts/contract_adapter/handlers'
const GOALS_DIR = 'docs/goals'

const TEST_FILE = /\.test\.tsx?$/
const LOCAL_TEST_FILE = /\.local\.test\.tsx?$/
const SOURCE_FILE = /\.(?:ts|tsx|mts)$/
const LOCAL_FIXTURE = /\.local\.ts$/
const HANDLER_FILE = /^(UC-\d{3})(?:\.[^.]+)*\.ts$/
/** 共有の置き場の検査の環境が持つ、git が無視する置き場（根からの相対の頭）。 */
const PROVIDED = ['node_modules/', '.harness/']
/** 読み込みの名前を辿るときに試す後ろ。 */
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx']

const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/')

/** dir の下のファイルを、根からの相対パスで返す（node_modules と . で始まる置き場は見ない）。 */
function walk(dir: string): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  const out: string[] = []
  for (const name of readdirSync(abs).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const child = `${dir}/${name}`
    if (statSync(join(ROOT, child)).isDirectory()) out.push(...walk(child))
    else out.push(child)
  }
  return out
}

type Parsed = { code: string; strings: string[] }

/** ソースを、コメントを除いた中身と、文字列の値（テンプレートは式の外の部分）に分ける。 */
function parse(text: string): Parsed {
  let code = ''
  const strings: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      code += ' '
      continue
    }
    // 正規表現の字句（中の引用符を文字列の始まりと読まない）。直前の字が式の始まりを示すときだけ正規表現と読む
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]$|^$/.test(code.trimEnd().slice(-1))) {
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== '\n') {
        const d = text[j]
        if (d === '\\') j++
        else if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        j++
      }
      code += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let value = ''
      let j = i + 1
      let depth = 0
      while (j < n) {
        const d = text[j]
        if (d === '\\') {
          value += text[j + 1] ?? ''
          j += 2
          continue
        }
        if (c === '`' && depth === 0 && d === '$' && text[j + 1] === '{') {
          depth = 1
          value += '\u0000'
          j += 2
          continue
        }
        if (depth > 0) {
          if (d === '{') depth++
          else if (d === '}') depth--
          j++
          continue
        }
        if (d === c || (c !== '`' && d === '\n')) break
        value += d
        j++
      }
      for (const piece of value.split('\u0000')) strings.push(piece)
      code += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    code += c
    i++
  }
  return { code, strings }
}

const parsedCache = new Map<string, Parsed>()
function parsed(file: string): Parsed {
  let p = parsedCache.get(file)
  if (!p) {
    p = parse(readFileSync(join(ROOT, file), 'utf8'))
    parsedCache.set(file, p)
  }
  return p
}

const IMPORTS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
]

/** file が静的に読み込む、根の中のファイル（根からの相対）。 */
function importsOf(file: string): string[] {
  const { code } = parsed(file)
  const out = new Set<string>()
  for (const re of IMPORTS) {
    for (const m of code.matchAll(re)) {
      const spec = m[2]
      if (!spec.startsWith('.')) continue
      const base = resolve(join(ROOT, dirname(file)), spec)
      for (const suffix of RESOLVE_SUFFIXES) {
        const abs = base + suffix
        if (existsSync(abs) && statSync(abs).isFile()) {
          if (!relative(ROOT, abs).startsWith('..')) out.add(rel(abs))
          break
        }
      }
    }
  }
  return [...out]
}

/** file が直にか間接に読み込む手元の物の土台のうち、最初に見つかった物（無ければ null）。 */
function localFixtureReached(file: string, seen = new Set<string>()): string | null {
  seen.add(file)
  for (const dep of importsOf(file)) {
    if (LOCAL_FIXTURE.test(dep) && dep.startsWith(`${TESTS_DIR}/`)) return dep
    if (seen.has(dep) || !SOURCE_FILE.test(dep)) continue
    const via = localFixtureReached(dep, seen)
    if (via) return via
  }
  return null
}

/** file が target を直にか間接に読み込むか。 */
function reaches(file: string, target: string, seen = new Set<string>()): boolean {
  seen.add(file)
  for (const dep of importsOf(file)) {
    if (dep === target) return true
    if (!seen.has(dep) && SOURCE_FILE.test(dep) && reaches(dep, target, seen)) return true
  }
  return false
}

/** git が無視するパス（根からの相対）。 */
function ignoredPaths(paths: string[]): Set<string> {
  if (!paths.length) return new Set()
  const r = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd: ROOT,
    input: `${paths.join('\0')}\0`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore が通らない: ${r.stderr}`)
  return new Set((r.stdout ?? '').split('\0').filter(Boolean))
}

/** 土台の中の、パスとして読める文字列を、根からの相対に直した物。 */
function pathLiterals(file: string): string[] {
  const out = new Set<string>()
  for (const s of parsed(file).strings) {
    const v = s.trim()
    if (!v || /\s/.test(v) || v === '.' || v === '..') continue
    if (!(v.includes('/') || v.startsWith('.'))) continue
    if (v.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(v)) continue
    const abs = v.startsWith('./') || v.startsWith('../') ? resolve(join(ROOT, dirname(file)), v) : resolve(ROOT, v)
    const r = relative(ROOT, abs)
    if (!r || r.startsWith('..')) continue
    const p = r.split(sep).join('/')
    if (PROVIDED.some((d) => p === d.slice(0, -1) || p.startsWith(d))) continue
    out.add(p)
  }
  return [...out]
}

/** 契約の実例の確かめを UC を絞らずに起こすか（起こす文字列の後ろの、同じ配列の中に `--uc` が無い）。 */
function runsAllCases(code: string): boolean {
  const starts = [...code.matchAll(/(['"`])contract-run\1|(['"`])run cases\2|(['"`])run\3\s*,\s*(['"`])cases\4/g)]
  return starts.some((m) => {
    const from = m.index ?? 0
    const end = code.indexOf(']', from)
    const segment = code.slice(from, end < 0 ? undefined : end)
    return !/(['"`])--uc\1/.test(segment)
  })
}

/** 配備の道具 wrangler を起こすか（子のプロセスの最初の名前が wrangler か、npx の最初の引数が wrangler か、wrangler を起こすシェルの行の文字列）。
 *  wrangler という名前の偽物を置くだけの土台は数えない。 */
function startsWrangler(code: string, strings: string[]): boolean {
  if (/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(['"`])wrangler\1/.test(code)) return true
  if (/(['"`])npx\1\s*,\s*\[\s*(?:(['"`])-[^'"`]*\2\s*,\s*)*(['"`])wrangler\3/.test(code)) return true
  return strings.some((s) => /^(?:npx\s+(?:-\S+\s+)*)?wrangler\s+[a-z]/.test(s.trim()))
}

/** 土台が中で直に使う手元の物（無ければ空）。ignored は git が無視するパスの集まり。 */
function localUses(file: string, ignored: Set<string>): string[] {
  const { code, strings } = parsed(file)
  const uses: string[] = []
  if (strings.some((s) => s.includes('sandbox-exec'))) uses.push('囲いの道具 sandbox-exec を起こす')
  if (startsWrangler(code, strings)) uses.push('配備の道具 wrangler を起こす')
  if (strings.some((s) => /(?:^|\/)\.wrangler(?:\/|$)/.test(s.trim()))) uses.push('手元の保存先 .wrangler を名指す')
  if (/\bhomedir\s*\(|\bprocess\.env\.HOME\b|\bprocess\.env\[\s*['"]HOME['"]\s*\]/.test(code) || strings.some((s) => s.startsWith('~/')))
    uses.push('家の置き場を名指す')
  const named = pathLiterals(file).filter((p) => ignored.has(p))
  if (named.length) uses.push(`git が無視するパス ${named.join('・')} を名指す`)
  if (runsAllCases(code)) uses.push('契約の実例の確かめを UC を絞らずに起こす')
  return uses
}

/** 契約を持つ UC の ID。 */
function contractUcs(): string[] {
  const out = new Set<string>()
  for (const file of walk(GOALS_DIR)) {
    if (!file.endsWith('/contract.yaml')) continue
    const m = /^x-uc:\s*['"]?(UC-\d{3})\b/m.exec(readFileSync(join(ROOT, file), 'utf8'))
    const folder = /\/(UC-\d{3})[^/]*\/contract\.yaml$/.exec(file)
    const uc = m?.[1] ?? folder?.[1]
    if (uc) out.add(uc)
  }
  return [...out]
}

function main(): number {
  const files = walk(TESTS_DIR)
  const tests = files.filter((f) => TEST_FILE.test(f))
  const fixtures = files.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f))

  const mismatches: string[] = []
  const portableTests: string[] = []
  const localTests: string[] = []
  for (const t of tests) {
    const via = localFixtureReached(t)
    const named = LOCAL_TEST_FILE.test(t)
    if (via && !named) mismatches.push(`手元の物の土台を読み込むのに手元だけの名前を持たないテストのファイル: ${t}（読み込む手元の物の土台: ${via}）`)
    else if (!via && named) mismatches.push(`手元だけの名前を持つのに手元の物の土台を読み込まないテストのファイル: ${t}`)
    ;(via ? localTests : portableTests).push(t)
  }

  const candidates = new Set<string>()
  for (const f of fixtures) if (!LOCAL_FIXTURE.test(f)) for (const p of pathLiterals(f)) candidates.add(p)
  const ignored = ignoredPaths([...candidates])
  const handlerFiles = new Map<string, string[]>()
  for (const f of walk(HANDLERS_DIR)) {
    const m = HANDLER_FILE.exec(f.slice(HANDLERS_DIR.length + 1))
    if (!m) continue
    handlerFiles.set(m[1], [...(handlerFiles.get(m[1]) ?? []), f])
  }
  const handlers = [...handlerFiles.values()].flat()

  for (const f of fixtures) {
    if (LOCAL_FIXTURE.test(f)) continue
    const uses = localUses(f, ignored)
    if (!uses.length) continue
    // 名前を直すと手元だけに移る物（この土台を直にか間接に読み込むテストのファイルと土台と受け持ち）も添える
    const users = [...fixtures, ...tests, ...handlers].filter((u) => u !== f && reaches(u, f))
    mismatches.push(
      [`手元の物を使うのに手元の物の土台の名前を持たない土台: ${f}（${uses.join('。')}）`, ...users.map((u) => `    この土台を読み込む物: ${u}`)].join('\n'),
    )
  }
  const ucs = [...new Set([...contractUcs(), ...handlerFiles.keys()])].sort()
  const localUcs = ucs.filter((uc) => (handlerFiles.get(uc) ?? []).some((f) => localFixtureReached(f)))
  const portableUcs = ucs.filter((uc) => !localUcs.includes(uc))

  if (mismatches.length) {
    for (const m of mismatches) console.log(`✘ ${m}`)
    console.log(`名前と中身の食い違い ${mismatches.length} 件。名前を直すまで、どのテストも回さない`)
    return 1
  }
  const section = (title: string, names: string[]) => {
    console.log(`${title}（${names.length} 件）:`)
    for (const name of names) console.log(`  ${name}`)
  }
  section('手元に依らないテストのファイル（単体テストの組 portable が回す）', portableTests)
  section('手元だけのテストのファイル（単体テストの組 local が回し、手元の入口 npm test が受け持つ）', localTests)
  section('手元に依らない UC（契約の実例を共有の置き場でも回す）', portableUcs)
  section('手元だけの UC（契約の実例は手元の入口 npm test が受け持つ）', localUcs)
  return 0
}

process.exitCode = main()
