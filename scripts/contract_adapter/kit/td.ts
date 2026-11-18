/**
 * 道具を回す操作（UC-027・UC-030・UC-032 の inbound）の受け持ちが共有する部品。kit/tool.ts の上に、次の 3 つを足す。
 *
 * - projectShadow: リポジトリと同じ並びの影の根を実例ごとに作る。書きうる場所（scripts・src・portal と、前提として名指した
 *   学びの置き場・fixture）は写し（APFS では複製の印だけを作る写し）、それ以外は元の場所へのリンクにする。`data` と `tests` は
 *   ディレクトリを作り、`data` の名指していない学びだけをリンクにする。`backups` は空のディレクトリ。学びの置き場の写しは
 *   原本の PDF とページの画像（pdfs・pages）と、作業ツリーに追跡されない投入（seed.sql）を除く（投入は組み立てで書き出す）。
 * - 外の世界の偽物: 配備の道具（wrangler）を、影の根の node_modules（固定した版の位置）・PATH・npx の先の 3 か所で偽物にする。
 *   偽物は保存先を本番（`--remote`）と手元（付けないとき）の 2 つの SQLite で受け、構造の変更の確かめ・問い合わせ・投入を
 *   本物と同じ形で返す。curl は外へ出さない。子の環境は親の環境を引き継ぎ（外への通信を見張る変数を捨てない）、
 *   PATH の先頭と保存先の置き場と、効かない資格情報だけを足す（REQ-569）。
 * - answerOf: 道具を回した結果を答えに読む。断りの名前は kit/tool.ts の toolErrorCode（CLAUDE.md の「操作 → 入口」の読み方）、
 *   応答は標準出力の全体か最後の空でない行の JSON をそのまま使い、契約が exitCode を持つのでプロセスの終了の状態を添える
 *   （JSON が exitCode を持てばそちらを使う）。契約が応答として認める 0 でない終了の状態は、道具がその結果を標準出力に
 *   出したときだけ応答と読む（標準出力が空なら結果を出していない）。それ以外の名前の無い止まりは kit/tool.ts の unnamedStop の答え。
 *   Python の Traceback を残して止まった（名前の無い例外）ときは Unanswerable を投げる。
 */

import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { Unanswerable, type Answer, type ExampleLine } from './protocol'
import { REPO_ROOT, fakeCommands, runTool, shadowRoot, toolErrorCode, unnamedStop, type Shadow, type ToolRun } from './tool'

/** 書きうるので必ず写す最上位の置き場。 */
const ALWAYS_COPIED = ['scripts', 'src', 'portal']
/** 影の根に置かない最上位の物（作り直す物と、作業の跡）。 */
const OMITTED = new Set(['.git', 'data', 'tests', 'backups', 'node_modules', 'dist', 'full', '.wrangler', '.DS_Store'])
/** 学びの置き場の写しから除く物。 */
const LEARNING_EXCLUDED = new Set(['pdfs', 'pages', 'seed.sql'])

/** 写しの道具（複製の印だけを作る写しが使える所ではそれを使う）。 */
async function cloneTree(from: string[], to: string): Promise<void> {
  if (from.length === 0) return
  await mkdir(to, { recursive: true })
  const command = process.platform === 'darwin' ? ['cp', '-cR', ...from, `${to}/`] : ['cp', '-R', '--reflink=auto', ...from, `${to}/`]
  const run = await runTool(command, { timeoutMs: 60_000 })
  if (run.code !== 0) throw new Unanswerable(`前提の写しを作れない: ${run.stderr.trim().slice(0, 200)}`)
}

export type ProjectShadow = Shadow & {
  /** 影の根を cwd にし、偽物を PATH に入れた環境。 */
  env: NodeJS.ProcessEnv
  /** 手元の保存先と本番の保存先（偽物が受ける SQLite）。 */
  localDb: string
  remoteDb: string
  /** 影の根を cwd にして道具を回す（scripts/ の道具は影の根の写しを使う）。 */
  run: (command: string[], timeoutMs?: number) => Promise<ToolRun>
  /** 学びの置き場を、リポジトリの学び from の写しとして to（`data/<名前>`）に置く。 */
  learning: (from: string, to?: string) => Promise<void>
  readJson: (rel: string) => Promise<any>
  writeJson: (rel: string, value: unknown) => Promise<void>
}

/**
 * 実例 1 件の影の根を作る。learnings は写す学び（リポジトリの data/<key> を data/<key> に）、copy は写すリポジトリの相対パス
 * （tests/fixtures/... など。親はディレクトリを作る）。
 * @implements REQ-569, REQ-570
 */
export async function projectShadow(options: { learnings?: string[]; copy?: string[] } = {}): Promise<ProjectShadow> {
  const shadow = await shadowRoot()
  const root = shadow.root
  try {
    const top = await readdir(REPO_ROOT)
    const copied = top.filter((name) => ALWAYS_COPIED.includes(name))
    await cloneTree(
      copied.map((name) => join(REPO_ROOT, name)),
      root,
    )
    for (const name of top) {
      if (OMITTED.has(name) || copied.includes(name) || name.startsWith('.worker-build')) continue
      await symlink(join(REPO_ROOT, name), join(root, name))
    }
    await mkdir(join(root, 'backups'))
    await mkdir(join(root, 'tests'))
    const own = new Set(options.learnings ?? [])
    await mkdir(join(root, 'data'))
    for (const name of await readdir(join(REPO_ROOT, 'data'))) {
      if (!own.has(name)) await symlink(join(REPO_ROOT, 'data', name), join(root, 'data', name))
    }
    for (const rel of options.copy ?? []) {
      const parent = join(root, rel, '..')
      await cloneTree([join(REPO_ROOT, rel)], parent)
    }
    await layNodeModules(root)
    const tmp = shadow.path('.tmp')
    await mkdir(tmp)
    const localDb = shadow.path('.storage/local.sqlite')
    const remoteDb = shadow.path('.storage/remote.sqlite')
    await mkdir(shadow.path('.storage'))
    makeStorage(localDb)
    makeStorage(remoteDb)
    const fake = shadow.path('.storage/wrangler.py')
    await writeFile(fake, FAKE_WRANGLER)
    const base = await fakeCommands(shadow, {
      wrangler: `exec python3 "${fake}" "$@"`,
      npx: npxBody(fake),
      curl: `echo "契約の実例の確かめでは外へ出ない（curl $*）" >&2\nexit 7`,
    })
    // npm run が PATH に足すリポジトリの node_modules/.bin（本物の wrangler がある）を外す
    const repoBin = join(REPO_ROOT, 'node_modules', '.bin')
    const env: NodeJS.ProcessEnv = {
      ...base,
      PATH: (base.PATH ?? '')
        .split(':')
        .filter((entry) => entry !== repoBin)
        .join(':'),
      TD_DB_LOCAL: localDb,
      TD_DB_REMOTE: remoteDb,
      TD_SANDBOX: root,
      TD_MIGRATIONS: join(REPO_ROOT, 'migrations'),
      TD_WRANGLER_VERSION: PINNED_WRANGLER,
      TD_ACCOUNT: ACCOUNT,
      CLOUDFLARE_API_TOKEN: 'contract-adapter-invalid-token',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      WRANGLER_SEND_METRICS: 'false',
      XDG_CONFIG_HOME: shadow.path('.xdg'),
      TMPDIR: tmp,
    }
    for (const key of own) await cloneLearning(root, key, key)
    const project: ProjectShadow = {
      ...shadow,
      env,
      localDb,
      remoteDb,
      run: (command, timeoutMs) => runTool(command, { cwd: root, env, timeoutMs }),
      learning: (from, to = from) => cloneLearning(root, from, to),
      readJson: async (rel) => JSON.parse(await readFile(shadow.path(rel), 'utf8')),
      writeJson: async (rel, value) => shadow.write(rel, `${JSON.stringify(value, null, 2)}\n`),
    }
    return project
  } catch (error) {
    await shadow.cleanup()
    throw error
  }
}

/** 学びの置き場をリポジトリの写しとして置く（pdfs・pages・seed.sql を除く）。 */
async function cloneLearning(root: string, from: string, to: string): Promise<void> {
  const source = join(REPO_ROOT, 'data', from)
  if (!existsSync(source)) throw new Unanswerable(`前提の学びの置き場がリポジトリに無い: data/${from}`)
  const target = join(root, 'data', to)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const children = (await readdir(source)).filter((name) => !LEARNING_EXCLUDED.has(name))
  await cloneTree(
    children.map((name) => join(source, name)),
    target,
  )
}

/** 影の根の node_modules。中身は元へのリンクで、wrangler だけを固定した版の位置に置いた偽物にする。 */
async function layNodeModules(root: string): Promise<void> {
  const real = join(REPO_ROOT, 'node_modules')
  if (!existsSync(real)) return
  const modules = join(root, 'node_modules')
  const bin = join(modules, '.bin')
  await mkdir(bin, { recursive: true })
  for (const name of await readdir(real)) {
    if (['.bin', 'wrangler', '.vite', '.cache'].includes(name)) continue
    await symlink(join(real, name), join(modules, name))
  }
  if (existsSync(join(real, '.bin'))) {
    for (const name of await readdir(join(real, '.bin'))) {
      if (name === 'wrangler' || name === 'wrangler2') continue
      await symlink(realpathSync(join(real, '.bin', name)), join(bin, name))
    }
  }
  const pkg = join(modules, 'wrangler')
  await mkdir(join(pkg, 'bin'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'wrangler', version: PINNED_WRANGLER, bin: { wrangler: 'bin/wrangler' } }))
  await writeFile(join(pkg, 'bin', 'wrangler'), `#!/bin/sh\nexec python3 "$TD_SANDBOX/.storage/wrangler.py" "$@"\n`, { mode: 0o755 })
  await writeFile(join(pkg, 'bin', 'wrangler.js'), `#!/bin/sh\nexec python3 "$TD_SANDBOX/.storage/wrangler.py" "$@"\n`, { mode: 0o755 })
  await symlink(join(pkg, 'bin', 'wrangler'), join(bin, 'wrangler'))
  await symlink(join(pkg, 'bin', 'wrangler'), join(bin, 'wrangler2'))
}

/** 偽の npx。今いる場所から上へ node_modules/.bin を探して使い、wrangler が無ければ偽物、それ以外は入れずに本物の npx に渡す。 */
const npxBody = (fake: string) => `orig="$*"
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes|-q|--quiet|--no|--no-install) shift ;;
    -p|--package) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
name="$1"; [ $# -gt 0 ] && shift
base="\${name%@*}"; [ -n "$base" ] || base="$name"
d="$PWD"
while :; do
  if [ -x "$d/node_modules/.bin/$base" ]; then exec "$d/node_modules/.bin/$base" "$@"; fi
  [ "$d" = / ] && break
  d="$(dirname "$d")"
done
case "$base" in
  wrangler*) exec python3 "${fake}" "$@" ;;
esac
for p in $(echo "$PATH" | tr ':' ' '); do
  if [ -x "$p/npx" ] && [ "$p" != "$(dirname "$0")" ]; then exec "$p/npx" --no "$base" "$@"; fi
done
echo "npx が見つからない: $orig" >&2
exit 127`

/** 固定した wrangler の版（package-lock の node_modules/wrangler）。 */
const PINNED_WRANGLER: string = (() => {
  try {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string }> }
    return lock.packages?.['node_modules/wrangler']?.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 決めた配備のアカウント（正本は scripts/pages_projects.json の account_id）。 */
const ACCOUNT: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as { account_id?: string }).account_id ?? ''
  } catch {
    return ''
  }
})()

/** migrations をすべて当て、当てた名前を d1_migrations に記録した保存先（流す前の状態）。 */
function makeStorage(file: string): void {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try {
    db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
    const dir = join(REPO_ROOT, 'migrations')
    const names = existsSync(dir) ? readdirSyncSorted(dir) : []
    for (const name of names) {
      for (const statement of readFileSync(join(dir, name), 'utf8').split(/-->\s*statement-breakpoint/)) if (statement.trim()) db.exec(statement)
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
    }
  } finally {
    db.close()
  }
}

function readdirSyncSorted(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

/**
 * 保存先に投入を流した状態にする（流したあとの DB の前提）。
 * @implements REQ-570
 */
export function flowInto(dbFile: string, sql: string): void {
  const db = new DatabaseSync(dbFile, { enableForeignKeyConstraints: true })
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

/** 偽の wrangler（python3）。保存先は TD_DB_REMOTE（--remote）と TD_DB_LOCAL（付けないとき）。 */
const FAKE_WRANGLER = `import json, os, sqlite3, sys
args = sys.argv[1:]
side = 'remote' if '--remote' in args else 'local'
db_path = os.environ['TD_DB_REMOTE' if side == 'remote' else 'TD_DB_LOCAL']

def _value_of(*names):
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(n + '='):
                return a[len(n) + 1:]
    return None

def _table(rows):
    if not rows:
        return
    cols = list(rows[0].keys())
    cells = [[('null' if r[c] is None else str(r[c])) for c in cols] for r in rows]
    w = [max([len(c)] + [len(r[i]) for r in cells]) for i, c in enumerate(cols)]
    line = lambda l, m, r: l + m.join('─' * (n + 2) for n in w) + r
    print(line('┌', '┬', '┐'))
    print('│ ' + ' │ '.join(c.ljust(w[i]) for i, c in enumerate(cols)) + ' │')
    print(line('├', '┼', '┤'))
    for r in cells:
        print('│ ' + ' │ '.join(v.ljust(w[i]) for i, v in enumerate(r)) + ' │')
    print(line('└', '┴', '┘'))

def _statements(sql):
    out, buf = [], ''
    for part in sql.replace(';', ';\\n').split('\\n'):
        buf += part + '\\n'
        if sqlite3.complete_statement(buf):
            out.append(buf)
            buf = ''
    if buf.strip():
        out.append(buf)
    return out

if args[:1] in (['--version'], ['-v'], ['version']):
    print(os.environ.get('TD_WRANGLER_VERSION', '0.0.0'))
    sys.exit(0)
if args[:1] == ['whoami']:
    print(' ⛅️ wrangler ' + os.environ.get('TD_WRANGLER_VERSION', '0.0.0'))
    print('👋 You are logged in with an API Token.')
    print('┌──────────────┬──────────────────────────────────┐')
    print('│ Account Name │ Account ID                       │')
    print('│ Personal     │ ' + os.environ.get('TD_ACCOUNT', '') + ' │')
    print('└──────────────┴──────────────────────────────────┘')
    sys.exit(0)
if args[:3] == ['d1', 'migrations', 'list']:
    files = sorted(n for n in os.listdir(os.environ['TD_MIGRATIONS']) if n.endswith('.sql'))
    db = sqlite3.connect(db_path)
    try:
        applied = [r[0] for r in db.execute('SELECT name FROM d1_migrations')]
    except sqlite3.Error:
        applied = []
    pending = [f for f in files if f not in applied]
    print(' ⛅️ wrangler ' + os.environ.get('TD_WRANGLER_VERSION', '0.0.0'))
    if not pending:
        print('✅ No migrations to apply!')
    else:
        print('Migrations to be applied:')
        _table([{'Name': n} for n in pending])
    sys.exit(0)
if args[:2] == ['d1', 'migrations']:
    sys.exit(0)
if args[:2] == ['d1', 'execute']:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    file = _value_of('--file')
    if file:
        db.execute('PRAGMA foreign_keys = ON')
        with open(file, encoding='utf-8') as f:
            db.executescript(f.read())
        db.commit()
        print('🚣 Executed queries')
        sys.exit(0)
    sql = _value_of('--command') or ''
    out = []
    try:
        for st in _statements(sql):
            rows = [dict(r) for r in db.execute(st).fetchall()]
            out.append({'results': rows, 'success': True, 'meta': {'served_by': 'contract-adapter', 'changes': 0, 'rows_read': len(rows)}})
        db.commit()
    except sqlite3.Error as e:
        print('✘ [ERROR] ' + str(e), file=sys.stderr)
        sys.exit(1)
    if '--json' in args:
        print(json.dumps(out, ensure_ascii=False))
    else:
        print('🚣 Executed ' + str(len(out)) + ' command(s)')
        for o in out:
            _table(o['results'])
    sys.exit(0)
if args[:2] == ['d1', 'export']:
    target = _value_of('--output', '-o')
    if target:
        full = os.path.realpath(os.path.abspath(target))
        if not full.startswith(os.path.realpath(os.environ['TD_SANDBOX'])):
            print('✘ 影の根の外には書かない: ' + target, file=sys.stderr)
            sys.exit(1)
        with open(full, 'w', encoding='utf-8') as f:
            f.write('-- 契約の実例の確かめの控え\\n')
    sys.exit(0)
if args[:2] in (['d1', 'list'], ['d1', 'info']):
    print('[]')
    sys.exit(0)
print('契約の実例の確かめの偽の wrangler は受けない: ' + ' '.join(args), file=sys.stderr)
sys.exit(1)
`

/** 契約の request の欄の名前を引数の名前にする（大文字の前に - を入れた小文字）。 */
const flagOf = (key: string) => `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`

/**
 * 契約の request を道具の引数にする。positional は第 1 引数にする欄、repeated は値ごとに名前を繰り返す配列の欄
 * （ほかの配列は名前の後ろに値を並べる）。真の真偽値は名前だけ、偽は渡さない。
 * @implements REQ-567
 */
export function argsOf(request: Record<string, unknown> | null, options: { positional?: string[]; repeated?: string[] } = {}): string[] {
  const body = request ?? {}
  const out: string[] = []
  for (const key of options.positional ?? []) if (body[key] !== undefined) out.push(String(body[key]))
  for (const [key, value] of Object.entries(body)) {
    if ((options.positional ?? []).includes(key) || value === undefined || value === null || value === false) continue
    if (value === true) out.push(flagOf(key))
    else if (Array.isArray(value)) {
      if ((options.repeated ?? []).includes(key)) for (const item of value) out.push(flagOf(key), String(item))
      else out.push(flagOf(key), ...value.map(String))
    } else out.push(flagOf(key), String(value))
  }
  return out
}

/** 標準出力の全体か、最後の空でない行の JSON の物（読めなければ null）。 */
function lastJson(stdout: string): Record<string, unknown> | null {
  const read = (text: string) => {
    try {
      const value = JSON.parse(text) as unknown
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const whole = read(stdout.trim())
  if (whole) return whole
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  return lines.length > 0 ? read(lines[lines.length - 1]) : null
}

/**
 * 道具を回した結果を答えに読む。exitCodes は契約が応答として認める終了の状態。
 * @implements REQ-567, REQ-568, BR-064
 */
export function answerOf(run: ToolRun, exitCodes: number[] = [0]): Answer {
  const code = toolErrorCode(run.stdout)
  if (code !== null) return { error: code }
  const crashed = /Traceback \(most recent call last\)/.test(run.stderr)
  // 0 でない終了の状態は、道具が結果を標準出力に出したときだけ応答（何も出さずに止まったのは名前の無い止まり）
  const shown = run.code === 0 || run.stdout.trim() !== ''
  if (exitCodes.includes(run.code) && shown && !crashed) return { response: { exitCode: run.code, ...(lastJson(run.stdout) ?? {}) } }
  if (crashed) {
    const tail = (run.stderr || run.stdout).trim().split('\n').slice(-3).join(' / ')
    throw new Unanswerable(`道具が名前の無い例外で止まった（終了の状態 ${run.code}）: ${tail.slice(0, 300)}`)
  }
  return unnamedStop(run)
}

/**
 * 影の根を作って body を回し、終われば消す。
 * @implements REQ-570
 */
export async function inShadow(
  options: { learnings?: string[]; copy?: string[] },
  body: (shadow: ProjectShadow) => Promise<Answer>,
): Promise<Answer> {
  const shadow = await projectShadow(options)
  try {
    return await body(shadow)
  } finally {
    await shadow.cleanup()
  }
}

/**
 * 前提の手順（投入の組み立てなど）が通らなかったら、例の前提を作れないとして止める。
 * @implements REQ-570
 */
export function premise(run: ToolRun, what: string, line: ExampleLine): void {
  if (run.code === 0) return
  const tail = (run.stderr || run.stdout).trim().split('\n').slice(-3).join(' / ')
  throw new Unanswerable(`${line.case}: 前提（${what}）を作れない（終了の状態 ${run.code}）: ${tail.slice(0, 300)}`)
}

/**
 * 例の名前ごとの前提が無いときに止める（前提を決められない例は実装に渡さない）。
 * @implements REQ-568
 */
export function unknownCase(line: ExampleLine): never {
  throw new Unanswerable(`${line.operation}.${line.case}: 前提を決められない例の名前`)
}
