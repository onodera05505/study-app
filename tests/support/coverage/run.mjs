/**
 * 実行の記録の足場（ADR-0015）: テストを 1 回回し、4 種類の記録（同じプロセスの TypeScript・子プロセスの Python・シェル・Node）を
 * 取って、置き場の coverage/lcov.info に 1 つに連ねて書き出す。
 *
 *     node tests/support/coverage/run.mjs [vitest に渡す引数（テストのファイルなど）...]
 *
 * - 置き場の根は TEST_RECORD_ROOT（省略するとこのリポジトリ）。テストはその根の下の物を回し、記録はその根の coverage/ に書く。
 *   回すたびに coverage/ を空にしてから始める（前の回の分を残さない）
 * - Python の記録の道具は仮想環境 TEST_RECORD_VENV（省略するとこのリポジトリの .venv/）。無いか、固定した版（requirements-dev.txt）が
 *   入っていなければ作って入れる。作れなければ理由を標準エラーに 1 行出し、テストを回さずに終了の状態 1 で終える
 * - 写しの置き場（影の根）で回した道具の記録は、パスの先頭を落として根に同じ相対パスのファイルがある物に戻し、無い物は捨てる
 * - 読めない記録（打ち切られた・書けなかった子プロセスが残した物）は飛ばし、飛ばした数を標準エラーに 1 行出す。それでは失敗にしない
 * - 終了の状態は vitest の終了の状態（記録を書き出せなければ 1）。記録を取る間、テストと道具の出力には何も足さない
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const SCOPE = ['src/', 'portal/src/', 'portal/static/', 'scripts/']
const require = createRequire(import.meta.url)

const say = (line) => process.stderr.write(`[実行の記録] ${line}\n`)

class SetupError extends Error {}

// 置き場の根は、リンクを解いた本当のパスで扱う（記録の道具は、動いたファイルをリンクを解いたパスで残し、
// 作業ディレクトリもリンクを解いたパスになる）。渡されたままのパスも、写し元へ戻すときの根として読む
const given = resolve(process.env.TEST_RECORD_ROOT || REPO)
const root = safeRealpath(given)
const rootVariants = [...new Set([root, given])]
const venv = resolve(process.env.TEST_RECORD_VENV || join(REPO, '.venv'))
const outDir = join(root, 'coverage')
// 生の記録の置き場は作業ツリーとその隣の外（OS の一時の置き場の下に回すたびに作り、合わせ終えたら消す）。
// テストは道具を作業ツリーとその隣への書き込みを断つ囲いの中で回すので、作業ツリーの中では記録を書けない
let raw = ''

function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 記録のパス → 根からの相対パス（範囲の中で、根に同じファイルがある物だけ）。写しの置き場のパスは先頭を 1 段ずつ落として探す。 */
function toSource(p) {
  if (!isAbsolute(p)) return null
  for (const r of rootVariants) {
    if (p.startsWith(r + sep)) {
      const rel = p.slice(r.length + 1)
      return SCOPE.some((s) => rel.startsWith(s)) && isFile(join(root, rel)) ? rel : null
    }
  }
  const parts = p.split(sep)
  for (let i = 1; i < parts.length; i++) {
    const rel = parts.slice(i).join('/')
    if (SCOPE.some((s) => rel.startsWith(s)) && isFile(join(root, rel))) return rel
  }
  return null
}

/** 固定した Python の記録の道具の版（requirements-dev.txt の coverage==x.y.z）。 */
function pinnedCoverage() {
  const m = readFileSync(join(REPO, 'requirements-dev.txt'), 'utf8').match(/^coverage==(\S+)/m)
  if (!m) throw new SetupError('requirements-dev.txt に coverage の固定した版が無い')
  return m[1]
}

/** 仮想環境を用意し、子の Python が起動のたびに記録を始める印（.pth）を置く。作れなければ SetupError。 */
function prepareVenv() {
  const version = pinnedCoverage()
  const py = join(venv, 'bin', 'python3')
  const ready = () =>
    isFile(py) &&
    spawnSync(py, ['-c', `import coverage,sys; sys.exit(0 if coverage.__version__ == ${JSON.stringify(version)} else 3)`], { stdio: 'ignore' }).status === 0
  if (!ready()) {
    const step = (cmd, args, what) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' })
      if (r.error || r.status !== 0) {
        const why = (r.error?.message || r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() || `終了の状態 ${r.status}`
        throw new SetupError(`${what}（${why}）`)
      }
    }
    if (!isFile(py)) step('python3', ['-m', 'venv', '--system-site-packages', venv], `仮想環境 ${venv} を作れない`)
    step(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', `coverage==${version}`], `coverage ${version} を ${venv} に入れられない`)
    if (!ready()) throw new SetupError(`${venv} の coverage が固定した版 ${version} にならない`)
  }
  const site = spawnSync(py, ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).stdout.trim()
  if (!site) throw new SetupError(`${venv} の site-packages を読めない`)
  // 起動のたびに記録を始める部品。記録の置き場に書けないときは黙ってあきらめ、道具の出す物を変えない
  copyFileSync(join(HERE, 'test_record_start.py'), join(site, 'test_record_start.py'))
  writeFileSync(join(site, 'zz_test_record.pth'), 'import test_record_start\n')
  return py
}

function prepareRaw() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  raw = mkdtempSync(join(realpathSync(tmpdir()), 'test-record-'))
  for (const d of ['py', 'sh', 'v8', 'ts']) mkdirSync(join(raw, d), { recursive: true })
  writeFileSync(
    join(raw, 'coveragerc'),
    [
      '[run]',
      'parallel = True',
      `data_file = ${join(raw, 'py', '.coverage')}`,
      'include = */scripts/*',
      'branch = False',
      'disable_warnings = no-data-collected, module-not-measured, module-not-imported, couldnt-parse, no-ctracer',
      '',
    ].join('\n'),
  )
}

function runVitest(args) {
  const bin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const r = spawnSync(process.execPath, [bin, 'run', '--config', join(HERE, 'vitest.config.mjs'), ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TEST_RECORD_ROOT: root, TEST_RECORD_RAW: raw, TEST_RECORD_VENV: venv },
  })
  return r.status ?? 1
}

/** Python: 生のデータを写し元に直して lcov に。飛ばした数を返す。 */
function pythonRecord(py) {
  const out = join(raw, 'py.lcov')
  const r = spawnSync(py, [join(HERE, 'py_record.py'), root, join(raw, 'py'), out], { encoding: 'utf8', env: { ...process.env, COVERAGE_PROCESS_START: '' } })
  if (r.status !== 0) throw new Error(`Python の記録を lcov に直せない（${(r.stderr || '').trim().split('\n').pop()}）`)
  return { lcov: readFileSync(out, 'utf8'), skipped: Number(r.stdout.trim().split('\n').pop()) || 0 }
}

const FN_DEF = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{?/
const NOT_COMMAND = new Set(['', '{', '}', 'fi', 'done', 'esac', ';;', 'then', 'do', 'else'])

/** シェル: 命令ごとの記録を lcov に。範囲のソースのファイルの行だけを入れ、偽の道具の行は入れない。 */
function shellRecord() {
  const log = join(raw, 'sh', 'trace.log')
  const lines = new Map() // 相対パス → Map(行 → 回数)
  const inFn = new Map() // 相対パス → Map(関数 → 命令の数)
  let skipped = 0
  if (existsSync(log)) {
    for (const rec of readFileSync(log, 'utf8').split('\n')) {
      if (rec === '') continue
      const f = rec.split('\t')
      if (f.length !== 4 || !/^\d+$/.test(f[2])) {
        skipped++
        continue
      }
      const [start, src, line, fn] = f
      // ファイルを持たない命令（bash -c の文字列など）は範囲のソースでないので入れない
      if (src === '') continue
      const rel = toSource(isAbsolute(src) ? src : resolve(start, src))
      if (!rel || extname(rel) !== '.sh') continue
      if (!lines.has(rel)) lines.set(rel, new Map())
      const m = lines.get(rel)
      m.set(Number(line), (m.get(Number(line)) ?? 0) + 1)
      if (fn && fn !== 'source') {
        if (!inFn.has(rel)) inFn.set(rel, new Map())
        inFn.get(rel).set(fn, (inFn.get(rel).get(fn) ?? 0) + 1)
      }
    }
  }
  const recs = []
  for (const [rel, hits] of [...lines.entries()].sort()) {
    const text = readFileSync(join(root, rel), 'utf8').split('\n')
    const fns = []
    const da = new Map()
    text.forEach((l, i) => {
      const m = l.match(FN_DEF)
      if (m) fns.push([i + 1, m[1]])
      else if (!NOT_COMMAND.has(l.trim()) && !l.trim().startsWith('#')) da.set(i + 1, 0)
    })
    for (const [n, c] of hits) da.set(n, (da.get(n) ?? 0) + c)
    const called = inFn.get(rel) ?? new Map()
    const r = [`SF:${rel}`]
    for (const [n, name] of fns) r.push(`FN:${n},${name}`)
    for (const [, name] of fns) r.push(`FNDA:${called.get(name) ?? 0},${name}`)
    r.push(`FNF:${fns.length}`, `FNH:${fns.filter(([, name]) => called.get(name)).length}`)
    for (const [n, c] of [...da.entries()].sort((a, b) => a[0] - b[0])) r.push(`DA:${n},${c}`)
    r.push(`LF:${da.size}`, `LH:${[...da.values()].filter((c) => c > 0).length}`, 'end_of_record')
    recs.push(r.join('\n'))
  }
  return { lcov: recs.length ? recs.join('\n') + '\n' : '', skipped }
}

/** Node: 子の V8 の記録を範囲のファイルだけに絞り、写し元のパスへ戻して、c8 で lcov に（ソースマップで TypeScript の行に戻す）。 */
function nodeRecord() {
  const dir = join(raw, 'v8')
  const kept = join(raw, 'v8-kept')
  mkdirSync(kept, { recursive: true })
  const mapUrl = (u) => {
    const p = u.startsWith('file://') ? fileURLToPath(u) : u.startsWith('/') ? u : null
    const rel = p ? toSource(p) : null
    return rel ? pathToFileURL(join(root, rel)).href : null
  }
  let skipped = 0
  let n = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    let j
    try {
      j = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (!Array.isArray(j.result)) throw new Error('result が無い')
    } catch {
      skipped++
      continue
    }
    const result = []
    for (const r of j.result) {
      const u = typeof r.url === 'string' ? mapUrl(r.url) : null
      if (u) result.push({ ...r, url: u })
    }
    if (!result.length) continue
    const smc = {}
    for (const [k, v] of Object.entries(j['source-map-cache'] ?? {})) {
      const u = mapUrl(k)
      if (!u) continue
      const sources = (v?.data?.sources ?? []).map((s) => {
        const m = mapUrl(s)
        return m ? (s.startsWith('file://') ? m : fileURLToPath(m)) : s
      })
      smc[u] = { ...v, url: u, data: v?.data ? { ...v.data, sources } : v?.data }
    }
    writeFileSync(join(kept, name), JSON.stringify({ result, 'source-map-cache': smc }))
    n++
  }
  if (n === 0) return { lcov: '', skipped }
  let c8
  try {
    c8 = join(dirname(require.resolve('c8/package.json')), 'bin', 'c8.js')
  } catch {
    throw new Error('Node の記録を lcov に直す道具（c8）が入っていない（package.json の devDependencies。npm install で入れる）')
  }
  const out = join(raw, 'node')
  const r = spawnSync(
    process.execPath,
    [c8, 'report', '--temp-directory', kept, '--reports-dir', out, '--reporter', 'lcovonly', '--exclude-node-modules', ...SCOPE.flatMap((s) => ['--include', `${s}**`])],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: '' } },
  )
  if (r.status !== 0) throw new Error(`Node の記録を lcov に直せない（${(r.stderr || '').trim().split('\n').pop()}）`)
  return { lcov: existsSync(join(out, 'lcov.info')) ? readFileSync(join(out, 'lcov.info'), 'utf8') : '', skipped }
}

/**
 * 4 種類の記録を連ねた lcov で、同じファイルの同じ始まりの行の関数を同じ関数とみなし、どれかの記録で呼ばれていれば、
 * その行の関数をどの記録でも呼ばれたと載せる（ADR-0015 の合わせ方）。記録の道具ごとに関数の名前の付け方が違う
 * （同じプロセスの記録は constructor・(anonymous_N)、子の Node の記録はクラスの名前・推した名前）ので、連ねるだけだと
 * 片方の 0 回が門に「呼ばれていない」と落ちる。行ごとの回数は足し直さず、節・関数・名前は落とさず書き換えない。
 * 呼ばれた行の関数の回数は、その行のどれかの記録の回数の最大にする。
 * @implements REQ-666
 */
export function alignCalledFunctions(text, rootDir = root) {
  const fileKey = (sf) => {
    const p = sf.trim()
    for (const r of [rootDir, safeRealpath(rootDir)]) if (p.startsWith(r + sep)) return p.slice(r.length + 1)
    return p
  }
  // 記録の節ごとに、関数を「名前と、同じ名前の中の何番目か」で数える（同じ名前の関数が 1 つの節に 2 つ以上あっても取り違えない。
  // lcov は同じ名前の FN と FNDA を同じ並びで書く）
  const sections = text.split(/(?<=^end_of_record$\n?)/m)
  const parsed = sections.map((sec) => {
    const lines = sec.split('\n')
    const sf = lines.find((l) => l.startsWith('SF:'))
    const starts = new Map() // 名前 → 始まりの行の並び（FN の順）
    const counts = new Map() // 名前 → 回数の並び（FNDA の順）
    for (const l of lines) {
      let m = /^FN:(\d+)(?:,\d+)?,(.*)$/.exec(l)
      if (m) {
        if (!starts.has(m[2])) starts.set(m[2], [])
        starts.get(m[2]).push(Number(m[1]))
        continue
      }
      m = /^FNDA:(\d+),(.*)$/.exec(l)
      if (m) {
        if (!counts.has(m[2])) counts.set(m[2], [])
        counts.get(m[2]).push(Number(m[1]))
      }
    }
    return { sec, lines, key: sf ? fileKey(sf.slice(3)) : null, starts, counts }
  })
  // ファイルごと・始まりの行ごとに、どれかの記録で呼ばれた回数の最大
  const called = new Map()
  for (const r of parsed) {
    if (!r.key) continue
    if (!called.has(r.key)) called.set(r.key, new Map())
    const byLine = called.get(r.key)
    for (const [name, at] of r.starts) {
      const ns = r.counts.get(name) ?? []
      at.forEach((line, k) => {
        if ((ns[k] ?? 0) > 0) byLine.set(line, Math.max(byLine.get(line) ?? 0, ns[k]))
      })
    }
  }
  return parsed
    .map((r) => {
      if (!r.key || r.starts.size === 0) return r.sec
      const byLine = called.get(r.key)
      // 0 回の関数だけを、同じ始まりの行がほかの記録で呼ばれていれば、その回数に上げる（回数を下げることはしない）
      const lifted = new Map()
      let changed = false
      for (const [name, at] of r.starts) {
        const ns = [...(r.counts.get(name) ?? [])]
        at.forEach((line, k) => {
          if ((ns[k] ?? 0) === 0 && (byLine.get(line) ?? 0) > 0 && k < ns.length) {
            ns[k] = byLine.get(line)
            changed = true
          }
        })
        lifted.set(name, ns)
      }
      if (!changed) return r.sec
      const seen = new Map()
      const hit = [...lifted.values()].reduce((sum, ns) => sum + ns.filter((n) => n > 0).length, 0)
      return r.lines
        .map((l) => {
          const m = /^FNDA:\d+,(.*)$/.exec(l)
          if (m && lifted.has(m[1])) {
            const k = seen.get(m[1]) ?? 0
            seen.set(m[1], k + 1)
            return `FNDA:${lifted.get(m[1])[k]},${m[1]}`
          }
          if (l.startsWith('FNH:')) return `FNH:${hit}`
          return l
        })
        .join('\n')
    })
    .join('')
}

function main() {
  let py
  try {
    prepareRaw()
    py = prepareVenv()
  } catch (e) {
    if (!(e instanceof SetupError)) throw e
    say(`Python の道具の記録を取る環境を作れない: ${e.message}`)
    return 1
  }
  const status = runVitest(process.argv.slice(2))
  try {
    const ts = join(raw, 'ts', 'lcov.info')
    const parts = [existsSync(ts) ? readFileSync(ts, 'utf8') : '']
    const p = pythonRecord(py)
    const s = shellRecord()
    const n = nodeRecord()
    parts.push(p.lcov, s.lcov, n.lcov)
    const joined = parts.filter((x) => x !== '').map((x) => (x.endsWith('\n') ? x : x + '\n')).join('')
    writeFileSync(join(outDir, 'lcov.info'), alignCalledFunctions(joined))
    const skipped = p.skipped + s.skipped + n.skipped
    if (skipped > 0) say(`読めない記録を ${skipped} 件飛ばした（Python ${p.skipped}・シェル ${s.skipped}・Node ${n.skipped}）`)
  } catch (e) {
    say(`記録を書き出せない: ${e.message}`)
    return 1
  }
  return status
}

// コマンドとして回したときだけ実行する（合わせる段を、ほかから読み込んで確かめられるように）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } finally {
    // 生の記録の置き場は合わせ終えたら消す（残すのは coverage/lcov.info だけ）
    if (raw) rmSync(raw, { recursive: true, force: true })
  }
}
