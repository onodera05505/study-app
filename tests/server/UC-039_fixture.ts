/** UC-039（本番の準備と保守の道具）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: 操作名を snake_case にした `scripts/<名前>.sh` か `.py` を子プロセスで回す
 *  （bootstrapPersonal ＝ bootstrap_personal.sh、finishRemote ＝ finish_remote.sh、alignAppSettings ＝ align_app_settings.sh、
 *  backupD1 ＝ backup_d1.sh、d1Migrations ＝ d1_migrations.sh、extractUserData ＝ extract_user_data.py、
 *  portalMigrateAccounts ＝ portal_migrate_accounts.py、buildPortal ＝ build_portal.py、setSsoSecret ＝ set_sso_secret.sh、
 *  checkSsoProdSmoke ＝ check_sso_prod_smoke.py、targets ＝ targets.py）。request の各欄は同じ名前の引数（契約の先頭の決まり）。
 *
 *  囲いは UC-032 の土台（UC-032_fixture.ts の makeShadow・runCommand）をそのまま使う: 影の根に scripts・src・portal を写し（ほかはリンク。書き込みは OS の囲いが断つ）、
 *  配備の道具（wrangler・npx）と curl は偽物で受けて呼び出しを記録し、保存先は本番（--remote）と手元の 2 つの SQLite で受け、
 *  外への接続は断つ。この土台は、その上でさらに次を固める（リポジトリを書き換えないため）。
 *  - 影の根の最上位のファイルのリンクを写しに替え、migrations と contracts と backups を影の根の中に置く
 *  - 手元の秘密のファイル（`.env`・`.sso_secret`・`.dev.vars` で始まる物）は影の根に置かない。共有秘密が要るテストは偽の値を置く
 *  - wrap に挙げた scripts の道具は、呼ばれたことを記録して決めた終了の状態で返す包みに差し替える（本物は回さない）
 *
 *  配備先の一覧（scripts/pages_projects.json）と手元の秘密の値は出力に出さない。テストは真偽と数だけで比べ、
 *  失敗の文には redact を通した物だけを載せる。 */

import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ACCOUNT,
  OTHER_ACCOUNT,
  ROOT,
  makeShadow,
  makeStorage,
  removeShadows,
  runCommand,
  type LogEntry,
  type Run,
  type Shadow,
  type ShadowOptions,
  type StorageSpec,
  type World,
} from './UC-032_fixture'

export { ACCOUNT, OTHER_ACCOUNT, ROOT, removeShadows, type LogEntry, type Run, type Shadow, type World }

const PROJECTS = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as Record<string, any>
export const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Record<string, any>
/** 登録簿の学びの key。 */
export const LEARNINGS = Object.keys(REGISTRY).filter((k) => !k.startsWith('_'))

/** 配備先の一覧の値（表示しない値）。 */
const SECRET_VALUES: string[] = (() => {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.length >= 3) out.add(v)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  walk(PROJECTS)
  return [...out].sort((a, b) => b.length - a.length)
})()
/** 学びの配備先の一覧の値（保存先の名前・配信先の名前）。テストの中で比べるだけに使い、表示しない。 */
export const projectOf = (key: string): { db?: string; project?: string; url?: string } => PROJECTS[key] ?? {}

/** 出力から配備先の一覧の値を伏せる。 */
export function redact(text: string): string {
  let out = text
  for (const v of SECRET_VALUES) out = out.split(v).join('<値>')
  return out.replace(/[0-9a-f]{32}/g, '<値>').slice(-1500)
}

/** 偽の共有秘密（手元に置く値。本物ではない）。 */
export const FAKE_SSO_SECRET = 'uc039-fake-sso-secret-0123456789abcdef'

/** 偽の wrangler の前に置く包み（bash）。
 *  - d1 の呼び出しは、影の置き場の db/<remote|local>/<保存先の名前>.sqlite があればそこに向ける（無ければ UC-032 の土台の共通の保存先）
 *  - STUB_APPLY_MIGRATIONS=1 のとき、d1 migrations apply は migrations のすべてを当てたと記録する
 *  - STUB_PROJECTS_EXIST=1 のとき、pages project list は配備先の一覧のすべての配信先を挙げる
 *  - pages secret put <名前> は、本物と同じく標準入力から値を読み、影の置き場の secrets/<名前>.<n> に残す
 *  - STUB_EXPORT_ROWS=<n> のとき、d1 export の書き出した控えのファイルの末尾に投入の文（INSERT）を n 行足す
 *  - STUB_WHOAMI_SEVERAL=1 のとき、whoami は 2 つのアカウントを並べる（1 番目は決めたアカウントと違う物、2 番目は UC-032 の土台が答える物） */
const WRANGLER_FRONT = String.raw`#!/usr/bin/env bash
if [ "$1" = whoami ] && [ "$STUB_WHOAMI_SEVERAL" = 1 ]; then
  set -o pipefail
  "__ORIG__" "$@" | awk -v other="__OTHER__" '/│ Personal/ { print "│ Other        │ " other " │" } { print }'
  exit $?
fi
if [ "$1" = d1 ]; then
  name="$3"; [ "$2" = migrations ] && name="$4"
  side=local; for a in "$@"; do [ "$a" = --remote ] && side=remote; done
  f="$STUB_SANDBOX/db/$side/$name.sqlite"
  if [ -f "$f" ]; then if [ "$side" = remote ]; then export STUB_DB_REMOTE="$f"; else export STUB_DB_LOCAL="$f"; fi; fi
  if [ "$2" = migrations ] && [ "$3" = apply ] && [ "$STUB_APPLY_MIGRATIONS" = 1 ]; then
    db="$STUB_DB_LOCAL"; [ "$side" = remote ] && db="$STUB_DB_REMOTE"
    for m in "$STUB_MIGRATIONS_DIR"/*.sql; do
      python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)", (sys.argv[2],)); c.commit()' "$db" "$(basename "$m")"
    done
  fi
fi
if [ "$1" = pages ] && [ "$2" = project ] && [ "$3" = list ] && [ "$STUB_PROJECTS_EXIST" = 1 ]; then
  python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); [print("│ " + v["project"] + " │ " + v["project"] + ".pages.dev │ No │ 1 day ago │") for k, v in p.items() if isinstance(v, dict) and v.get("project")]' "$STUB_SANDBOX/root/scripts/pages_projects.json"
fi
if [ "$1" = pages ] && [ "$2" = secret ] && [ "$3" = put ]; then
  d="$STUB_SANDBOX/secrets"; mkdir -p "$d"
  n=$(ls "$d" | grep -c "^$4\." || true)
  cat > "$d/$4.$n"
fi
if [ "$1" = d1 ] && [ "$2" = export ] && [ -n "$STUB_EXPORT_ROWS" ]; then
  "__ORIG__" "$@"; code=$?
  out=""; prev=""
  for a in "$@"; do
    case "$prev" in --output|-o) out="$a" ;; esac
    case "$a" in --output=*) out=$(printf '%s' "$a" | sed 's/^--output=//') ;; esac
    prev="$a"
  done
  if [ "$code" = 0 ] && [ -n "$out" ] && [ -f "$out" ]; then
    for i in $(seq 1 "$STUB_EXPORT_ROWS"); do printf 'INSERT INTO "uc039_rows" VALUES(%s);\n' "$i" >> "$out"; done
  fi
  exit "$code"
fi
exec "__ORIG__" "$@"
`

export type Shadow39 = Shadow & {
  /** 影の根の中のパス。 */
  path: (rel: string) => string
  write: (rel: string, content: string) => void
}

const pythonWrap = (name: string, code: number) => `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["STUB_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"tool": ${JSON.stringify(name)}, "argv": sys.argv[1:], "mode": "wrapped"}) + "\\n")
sys.exit(${code})
`
const bashWrap = (name: string, code: number) => `#!/usr/bin/env bash
args=""
for a in "$@"; do args="$args,\\"$a\\""; done
printf '{"tool":"${name}","argv":[%s],"mode":"wrapped"}\\n' "\${args#,}" >> "$STUB_LOG"
exit ${code}
`

/** 影の根を作って固める。wrap は包みに差し替える scripts のファイル名 → 返す終了の状態。 */
export function shadow39(name: string, opts: Partial<ShadowOptions> & { wrap?: Record<string, number> } = {}): Shadow39 {
  const s = makeShadow(`uc039-${name}`, { copy: ['scripts', 'src', 'portal'], ...opts })
  for (const entry of readdirSync(s.root)) {
    const at = join(s.root, entry)
    if (!lstatSync(at).isSymbolicLink()) continue
    if (/^\.(env|sso_secret|dev\.vars)/.test(entry)) {
      unlinkSync(at)
      continue
    }
    const target = join(ROOT, entry)
    const dir = existsSync(target) && lstatSync(target).isDirectory()
    if (!dir || ['migrations', 'contracts'].includes(entry)) {
      unlinkSync(at)
      if (existsSync(target)) cpSync(target, at, { recursive: true })
    }
  }
  for (const secret of readdirSync(join(s.root, 'portal')).filter((n) => /^\.(env|dev\.vars|sso)/.test(n))) rmSync(join(s.root, 'portal', secret), { force: true })
  // 秘密を置く呼び出し（pages secret put <名前>）は、本物と同じく標準入力から値を読み、影の根の secrets/<名前>.<n> に残してから偽物に渡す
  for (const stub of [join(s.root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), join(s.dir, 'unpinned-wrangler.js')]) {
    const orig = stub.replace(/\.js$/, '.orig.js')
    renameSync(stub, orig)
    writeFileSync(stub, WRANGLER_FRONT.split('__ORIG__').join(orig).split('__OTHER__').join(OTHER_ACCOUNT))
    chmodSync(stub, 0o755)
  }
  // npx wrangler は、作業の場所によらず影の根の偽物に渡す（UC-032 の偽の npx は作業の場所から node_modules を探すので、
  // 影の根の外を作業の場所にした道具が本物に届きうる）。ほかは UC-032 の偽の npx に渡す
  renameSync(join(s.bin, 'npx'), join(s.bin, 'npx-uc032'))
  writeFileSync(
    join(s.bin, 'npx'),
    `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in -*) ;; wrangler*) shift_to=1; break ;; *) break ;; esac; done\nif [ -n "$shift_to" ]; then\n  while [ $# -gt 0 ]; do case "$1" in wrangler*) shift; break ;; *) shift ;; esac; done\n  exec "${join(s.root, 'node_modules', '.bin', 'wrangler')}" "$@"\nfi\nexec "${join(s.bin, 'npx-uc032')}" "$@"\n`,
  )
  chmodSync(join(s.bin, 'npx'), 0o755)
  for (const [file, code] of Object.entries(opts.wrap ?? {})) {
    const at = join(s.root, 'scripts', file)
    writeFileSync(at, file.endsWith('.py') ? pythonWrap(file, code) : bashWrap(file, code))
    chmodSync(at, 0o755)
  }
  return {
    ...s,
    path: (rel) => join(s.root, rel),
    write: (rel, content) => {
      const at = join(s.root, rel)
      mkdirSync(dirname(at), { recursive: true })
      rmSync(at, { force: true })
      writeFileSync(at, content)
    },
  }
}

/** runTool の env に渡すと、ログイン中に 2 つのアカウントが見え、決めたアカウントが並びの 2 番目にある（world.whoami は既定の 'decided' のまま）。 */
export const SEVERAL_ACCOUNTS: Record<string, string> = { STUB_WHOAMI_SEVERAL: '1' }

/** 道具を囲う OS の決まり（macOS の sandbox-exec）。手元（localhost。テストが立てる代わりの相手）のほかへの接続をすべて断ち、作業ツリーとその隣（本体のチェックアウト）の置き場への
 *  書き込みを断つ。道具が影の根の外の決まった場所を作業の場所にしても、本体と本番に届かない（check_sso_prod_smoke.py は
 *  本体のチェックアウトを作業の場所にして wrangler を呼ぶことが、2026-11-19 に観測された）。macOS 以外では偽物と代理の遮断だけで囲う。 */
const SANDBOX: string | null =
  process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
    ? `(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))(deny file-write* (subpath ${JSON.stringify(dirname(ROOT))}))`
    : null

/** 道具を回す（.sh は bash、.py は python3。作業の場所は影の根。SANDBOX の囲いの中）。 */
export function runTool(s: Shadow39, script: string, args: string[] = [], world: World = {}, env: Record<string, string> = {}): Promise<Run> {
  const interpreter = script.endsWith('.py') ? 'python3' : 'bash'
  const [command, prefix] = SANDBOX ? ['sandbox-exec', ['-p', SANDBOX, interpreter]] : [interpreter, []]
  // 代理を通さない宛先は runCommand が既定で空にするので、env に置かれた物は world で渡す
  const noProxy = env.NO_PROXY ?? env.no_proxy
  if (noProxy !== undefined) world = { ...world, noProxy }
  // runCommand は呼んだときの process.env から子の環境を組むので、足す変数はその間だけ置く
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    return runCommand(s, command, [...prefix, join(s.root, 'scripts', script), ...args], world)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const isWrangler = (e: LogEntry) => e.tool === 'pinned' || e.tool === 'unpinned'
const argv = (e: LogEntry): string[] => (Array.isArray(e.argv) ? e.argv : [e.argv])
/** wrangler の呼び出し（引数の並び）。 */
export const wranglerCalls = (r: Run) => r.log.filter(isWrangler).map(argv)
/** 包みにした道具の呼び出し。 */
export const wrappedCalls = (r: Run, file: string) => r.log.filter((e) => e.tool === file).map(argv)
/** 記録の中で、pred に当たる最初の位置（無ければ -1）。 */
export const firstIndex = (r: Run, pred: (e: LogEntry, a: string[]) => boolean) => r.log.findIndex((e) => pred(e, argv(e)))
/** 保存先を書き換える wrangler の呼び出し（構造の変更の適用・--file の実行・更新の問い合わせ）。 */
export const storageWrites = (r: Run) =>
  wranglerCalls(r).filter(
    (a) =>
      a[0] === 'd1' &&
      ((a[1] === 'migrations' && a[2] === 'apply') || (a[1] === 'execute' && (a.includes('--file') || /\b(update|insert|delete|create|drop|alter)\b/i.test(a.join(' '))))),
  )
/** 保存先に向けた wrangler の呼び出し（d1 のすべて）。 */
export const storageCalls = (r: Run) => wranglerCalls(r).filter((a) => a[0] === 'd1')
/** 配信先に向けた wrangler の呼び出し（pages のすべて）。 */
export const pagesCalls = (r: Run) => wranglerCalls(r).filter((a) => a[0] === 'pages')
/** 道具が名前の無い例外で止まったか。 */
export const crashed = (r: Run) => /Traceback \(most recent call last\)/.test(r.out)
/** 置いた秘密（名前 → 置いた順の値）。値は表示しない。 */
export function secretsPut(s: Shadow39): Record<string, string[]> {
  const dir = join(s.dir, 'secrets')
  if (!existsSync(dir)) return {}
  const out: Record<string, string[]> = {}
  for (const f of readdirSync(dir).sort()) {
    const m = /^(.*)\.(\d+)$/.exec(f)
    if (!m) continue
    ;(out[m[1]] ??= [])[Number(m[2])] = readFileSync(join(dir, f), 'utf8').trim()
  }
  return out
}
/** 出力のファイルを読む。 */
export const readOut = (s: Shadow39, rel: string) => (existsSync(s.path(rel)) ? readFileSync(s.path(rel), 'utf8') : null)

/** 保存先の名前ごとの SQLite（影の置き場の db/<side>/<名前>.sqlite。偽の wrangler の包みがここに向ける）。 */
export const dbFile = (s: Shadow39, side: 'remote' | 'local', name: string) => join(s.dir, 'db', side, `${name}.sqlite`)
const PORTAL_SQL = readdirSync(join(ROOT, 'portal', 'migrations'))
  .filter((n) => n.endsWith('.sql'))
  .sort()
  .map((n) => readFileSync(join(ROOT, 'portal', 'migrations', n), 'utf8'))

/** 学び側の保存先を、保存先の名前ごとに作る（migrations をすべて当てた物）。 */
export function learningDb(s: Shadow39, side: 'remote' | 'local', key: string, spec: StorageSpec = {}): string {
  const file = dbFile(s, side, projectOf(key).db!)
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) makeStorage(file, spec)
  return file
}
/** まなびばの保存先を作る（portal/migrations をすべて当てた物）。 */
export function portalDb(s: Shadow39, side: 'remote' | 'local'): string {
  const file = dbFile(s, side, projectOf('_portal').db!)
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) {
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
    try {
      db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
      for (const sql of PORTAL_SQL) for (const st of sql.split(/-->\s*statement-breakpoint/)) if (st.trim()) db.exec(st)
    } finally {
      db.close()
    }
  }
  return file
}
/** SQLite に文を流す。 */
export function sql(file: string, text: string): void {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try {
    db.exec(text)
  } finally {
    db.close()
  }
}
/** SQLite から行を読む。 */
export function rows(file: string, query: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try {
    return db.prepare(query).all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}
