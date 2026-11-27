/** UC-035「テストを回して実行の記録を書き出す」のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の節: 記録つきの実行は `node tests/support/coverage/run.mjs`、小さな置き場は `TEST_RECORD_ROOT=<置き場>`
 *  （置き場に `scripts/`・`tests/*.test.ts`・`node_modules` へのリンク。記録は `<置き場>/coverage/lcov.info`）、Python の記録の環境の置き場は
 *  `TEST_RECORD_VENV`、子プロセスの生の記録の置き場は子に渡る `NODE_V8_COVERAGE` と `TEST_RECORD_RAW`（その下の `py/`・`sh/`）。
 *  リポジトリ全体は記録つきで回さない（数分かかる）。小さな置き場（recordPlace）を作り、その置き場だけを回す。
 *
 *  置き場の道具（Python・シェル・Node の 3 つ）は、動く関数と動かない関数を持ち、標準出力・標準エラー・終了の状態・書き出すファイルを持つ。
 *  置き場のテストは、道具を置き場の `scripts/` から回す物と、写しの置き場（一時の置き場の `scripts/`）へ写して回す物があり、
 *  道具が出した物を環境変数 `UC035_OBSERVED` のファイルに書く（記録つきと記録なしで同じかを外から比べるため）。 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const RUNNER = join(ROOT, 'tests', 'support', 'coverage', 'run.mjs')

const temps: string[] = []

/** 作った置き場をすべて消す。 */
export async function removeTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** 置き場の道具。動く関数（used・copied）と動かない関数（unused）を持つ。 */
export const TOOLS: Record<string, string> = {
  'scripts/uc035_tool.py': [
    'import sys',
    '',
    '',
    'def used(out):',
    "    with open(out, 'w') as f:",
    "        f.write('python wrote\\n')",
    "    print('python stdout')",
    "    print('python stderr', file=sys.stderr)",
    '',
    '',
    'def copied():',
    "    print('python from copy')",
    '',
    '',
    'def unused():',
    "    print('never')",
    "    print('never again')",
    '',
    '',
    "if __name__ == '__main__':",
    "    if sys.argv[1] == 'copy':",
    '        copied()',
    '    else:',
    '        used(sys.argv[2])',
    '    sys.exit(3)',
    '',
  ].join('\n'),
  'scripts/uc035_once.py': ['def once():', "    print('once')", '', '', "if __name__ == '__main__':", '    once()', ''].join('\n'),
  'scripts/uc035_tool.sh': [
    '#!/bin/bash',
    'echo "shell stdout"',
    'echo "shell stderr" >&2',
    'if [ "$1" = never ]; then',
    '  echo "never"',
    'fi',
    "printf 'shell wrote\\n' > \"$2\"",
    'exit 4',
    '',
  ].join('\n'),
  'scripts/uc035_tool.mjs': [
    "import { writeFileSync } from 'node:fs'",
    '',
    'export function used(out) {',
    "  writeFileSync(out, 'node wrote\\n')",
    "  console.log('node stdout')",
    "  console.error('node stderr')",
    '}',
    '',
    'export function unused() {',
    "  console.log('never')",
    '}',
    '',
    'used(process.argv[2])',
    'process.exit(5)',
    '',
  ].join('\n'),
}

/** 写しの置き場にだけある道具（写し元に同じファイルが無い）。 */
export const COPY_ONLY = 'scripts/uc035_only_in_copy.py'
const COPY_ONLY_BODY = ['def only():', "    print('only in copy')", '', '', "if __name__ == '__main__':", '    only()', ''].join('\n')

/** 置き場のテスト: 道具を回し、出した物を UC035_OBSERVED に書く。 */
const TOOLS_TEST = `import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it as check } from 'vitest'

const place = join(import.meta.dirname, '..')
const observed: Record<string, unknown> = {}
const out = (name: string) => join(place, 'out', name)
mkdirSync(join(place, 'out'), { recursive: true })

const run = (name: string, command: string[], file: string) => {
  const r = spawnSync(command[0], command.slice(1), { cwd: place, encoding: 'utf8' })
  observed[name] = { stdout: r.stdout, stderr: r.stderr, status: r.status, file: readFileSync(file, 'utf8') }
}

afterAll(() => {
  if (process.env.UC035_OBSERVED) writeFileSync(process.env.UC035_OBSERVED, JSON.stringify(observed, null, 2))
})

check('Python の道具を置き場から回す', () => {
  run('python', ['python3', 'scripts/uc035_tool.py', 'used', out('python.txt')], out('python.txt'))
  expect(observed.python).toBeDefined()
})

check('シェルの道具を置き場から回す', () => {
  run('shell', ['bash', 'scripts/uc035_tool.sh', 'used', out('shell.txt')], out('shell.txt'))
  expect(observed.shell).toBeDefined()
})

check('Node の道具を置き場から回す', () => {
  run('node', ['node', 'scripts/uc035_tool.mjs', out('node.txt')], out('node.txt'))
  expect(observed.node).toBeDefined()
})

check('Python の道具を写しの置き場へ写して回す', () => {
  const copy = mkdtempSync(join(tmpdir(), 'uc035-copy-'))
  try {
    mkdirSync(join(copy, 'scripts'))
    cpSync(join(place, 'scripts', 'uc035_tool.py'), join(copy, 'scripts', 'uc035_tool.py'))
    writeFileSync(join(copy, ${JSON.stringify(COPY_ONLY)}), ${JSON.stringify(COPY_ONLY_BODY)})
    const a = spawnSync('python3', ['scripts/uc035_tool.py', 'copy'], { cwd: copy, encoding: 'utf8' })
    const b = spawnSync('python3', [${JSON.stringify(COPY_ONLY)}], { cwd: copy, encoding: 'utf8' })
    observed.copy = { status: a.status, stdout: a.stdout, onlyStatus: b.status }
    expect(a.stdout).toContain('python from copy')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})
`

const ONCE_TEST = `import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it as check } from 'vitest'

check('一度だけの道具を回す', () => {
  const r = spawnSync('python3', ['scripts/uc035_once.py'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' })
  expect(r.stdout).toContain('once')
})
`

/** 読めない記録の数（Node・Python）。置き場のテストが記録つきのときに書く。 */
export const BROKEN = { node: 4, python: 3 }

/** 置き場のテスト: 打ち切られたか書けなかった子プロセスの代わりに、生の記録の置き場へ読めない記録を書く（UC035_BROKEN があり、記録つきのときだけ）。 */
const BROKEN_TEST = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it as check } from 'vitest'

check('生の記録の置き場へ読めない記録を書く', () => {
  let written = 0
  if (process.env.UC035_BROKEN && process.env.NODE_V8_COVERAGE) {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true })
    for (let i = 0; i < ${BROKEN.node}; i++) {
      writeFileSync(join(process.env.NODE_V8_COVERAGE, \`coverage-9999\${i}-1-0.json\`), '{ "result": [ { "url": ')
      written++
    }
  }
  if (process.env.UC035_BROKEN && process.env.TEST_RECORD_RAW) {
    mkdirSync(join(process.env.TEST_RECORD_RAW, 'py'), { recursive: true })
    for (let i = 0; i < ${BROKEN.python}; i++) {
      writeFileSync(join(process.env.TEST_RECORD_RAW, 'py', \`.coverage.uc035broken.\${i}\`), 'not a record')
      written++
    }
  }
  expect(written >= 0).toBe(true)
})
`

export type Place = {
  dir: string
  path: (rel: string) => string
  write: (rel: string, content: string) => void
  remove: (rel: string) => void
}

/** 小さな置き場を作る。scripts/ に道具、tests/ に置き場のテスト、node_modules はリポジトリへのリンク。 */
export function recordPlace(): Place {
  // 一時の置き場はリンクを解いた本当のパスで渡す（macOS の /var は /private/var へのリンク）
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'uc035-place-')))
  temps.push(base)
  const dir = join(base, 'place')
  mkdirSync(dir)
  const path = (rel: string) => join(dir, rel)
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(path(rel)), { recursive: true })
    writeFileSync(path(rel), content)
  }
  for (const [rel, body] of Object.entries(TOOLS)) write(rel, body)
  write('tests/tools.test.ts', TOOLS_TEST)
  write('tests/once.test.ts', ONCE_TEST)
  write('tests/broken.test.ts', BROKEN_TEST)
  symlinkSync(join(ROOT, 'node_modules'), path('node_modules'))
  return { dir, path, write, remove: (rel) => rmSync(path(rel), { recursive: true, force: true }) }
}

export type RecordRun = { status: number | null; stdout: string; stderr: string; out: string; seconds: number }

/** 置き場を記録つきで回す（入口 run.mjs、作業の場所はリポジトリ）。 */
export function runRecorded(place: Place, env: Record<string, string> = {}, timeoutMs = 240_000): RecordRun {
  const started = Date.now()
  const r = spawnSync('node', [RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, TEST_RECORD_ROOT: place.dir, ...env },
  })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}`, seconds: (Date.now() - started) / 1000 }
}

/** 置き場を記録なしで回す（vitest をそのまま、置き場を根にして）。 */
export function runPlain(place: Place, env: Record<string, string> = {}): RecordRun {
  const started = Date.now()
  const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'vitest'), ['run', '--root', place.dir], {
    cwd: place.dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}`, seconds: (Date.now() - started) / 1000 }
}

// ---------------------------------------------------------------------------
// 実行の記録（lcov）を読む

export type FileRecord = { sf: string; lines: Map<number, number>; functions: Map<string, number> }

/** lcov の節を読む（SF ごと。同じ SF の節が 2 つあれば 2 つとも返す）。 */
export function readLcov(text: string): FileRecord[] {
  const out: FileRecord[] = []
  let cur: FileRecord | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      cur = { sf: line.slice(3).trim(), lines: new Map(), functions: new Map() }
      out.push(cur)
    } else if (cur && line.startsWith('DA:')) {
      const [n, c] = line.slice(3).split(',')
      cur.lines.set(Number(n), Number(c))
    } else if (cur && line.startsWith('FNDA:')) {
      const [c, ...name] = line.slice(5).split(',')
      cur.functions.set(name.join(','), Number(c))
    } else if (line.startsWith('end_of_record')) cur = null
  }
  return out
}

/** 置き場の記録（`<置き場>/coverage/lcov.info`）。無ければ null。 */
export const placeRecord = (place: Place): FileRecord[] | null =>
  existsSync(place.path('coverage/lcov.info')) ? readLcov(readFileSync(place.path('coverage/lcov.info'), 'utf8')) : null

/** rel（置き場からの相対）を指す節。SF は相対でも絶対でも、置き場の中のそのファイルを指していればよい。 */
export const sectionsOf = (place: Place, records: FileRecord[], rel: string) =>
  records.filter((r) => r.sf === rel || r.sf === place.path(rel) || r.sf.endsWith(`/${rel}`))

/** 道具のソースの、その文字列を含む行の番号（1 始まり）。 */
export const lineOf = (rel: string, needle: string): number => {
  const i = TOOLS[rel].split('\n').findIndex((l) => l.includes(needle))
  if (i < 0) throw new Error(`仕込み: ${rel} に「${needle}」が無い`)
  return i + 1
}

/** 節の中でその行が動いた回数（どの節にも行が無ければ undefined）。 */
export const hitsOf = (sections: FileRecord[], line: number): number | undefined => {
  const hits = sections.map((s) => s.lines.get(line)).filter((h): h is number => h !== undefined)
  return hits.length ? Math.max(...hits) : undefined
}

