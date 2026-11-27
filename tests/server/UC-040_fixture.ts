/** UC-040（フィードバックを取り出して処理の状態を付ける）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: 操作 feedback ＝ `scripts/feedback.py` を子プロセスで回す。
 *  request の各欄は同じ名前の引数（契約の先頭の決まり: command は第 1 引数、学びは第 2 引数、ids は続く引数、ほかは `--名前`）。
 *  観測するのは、終了の状態・標準出力と標準エラーの文・保存先の行・受け箱のファイルだけ。
 *
 *  本番の保存先と配備先には届かない。影の根（一時の置き場）に scripts と src/shared を写し、data は学びごとの空の置き場を作る
 *  （受け箱はそこに書かれ、リポジトリの data は書き換えない）。配備の道具（wrangler・npx）は PATH の先頭の偽物で受ける。
 *  - `whoami`: 決めた配備のアカウント（scripts/pages_projects.json の account_id）でログインしている、と答える
 *  - `d1 execute <保存先の名前> [--remote] --command <SQL> [--json]`: 本番（--remote）と手元（付けないとき）で別の、保存先の名前ごとの
 *    SQLite で問い合わせを実行し、本物と同じ形（--json なら結果の配列）で返す。保存先は migrations をすべて当てた構造を持つ
 *  - FAIL_DBS に挙げた保存先の名前への問い合わせは、毎回 `✘ [ERROR] FAKE-D1-FAILURE <名前>` を標準エラーに出して失敗する
 *  - ほかの呼び出しは受けずに失敗する。呼ばれた引数は影の根の calls.jsonl に 1 行ずつ残す
 *  外への通信は、届かない代理と無効のトークンで塞ぐ。保存先の名前は値なので、テストは学びの key から引くだけで表示しない。 */

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

const PROJECTS = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as Record<string, any>
const ACCOUNT: string = PROJECTS.account_id
/** 学びの key → 保存先の名前（値は表示しない）。 */
export const dbOf = (learning: string): string => PROJECTS[learning].db
/** 保存先を持つ学びの key。 */
export const LEARNINGS = Object.keys(PROJECTS).filter((k) => !k.startsWith('_') && typeof PROJECTS[k] === 'object' && PROJECTS[k].db)

/** 学び側の保存先の構造（migrations をすべて当てた物。正本は migrations）。 */
const MIGRATIONS = readdirSync(join(ROOT, 'migrations'))
  .filter((n) => n.endsWith('.sql'))
  .sort()
  .map((n) => readFileSync(join(ROOT, 'migrations', n), 'utf8'))

/** 偽の配備の道具（Python）。 */
const FAKE_WRANGLER = String.raw`import json, os, sqlite3, sys
args = sys.argv[1:]
with open(os.path.join(os.environ['UC040_ROOT'], 'calls.jsonl'), 'a', encoding='utf-8') as f:
    f.write(json.dumps(args, ensure_ascii=False) + '\n')
def value_of(name):
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
        if a.startswith(name + '='):
            return a[len(name) + 1:]
    return None
if args[:1] in (['--version'], ['-v'], ['version']):
    print('3.0.0'); sys.exit(0)
if args[:1] == ['whoami']:
    print('You are logged in with an API Token.')
    print('| Account Name | Account ID |')
    print('| Personal | ' + os.environ['UC040_ACCOUNT'] + ' |')
    sys.exit(0)
if args[:2] == ['d1', 'execute']:
    rest = [a for a in args[2:]]
    name = None
    skip = False
    for i, a in enumerate(rest):
        if skip:
            skip = False; continue
        if a in ('--command', '--file', '--config', '-c', '--env', '-e', '--persist-to'):
            skip = True; continue
        if a.startswith('-'):
            continue
        name = a; break
    if name in [n for n in os.environ.get('FAIL_DBS', '').split(',') if n]:
        print('✘ [ERROR] FAKE-D1-FAILURE ' + name, file=sys.stderr); sys.exit(1)
    side = 'remote' if '--remote' in args else 'local'
    path = os.path.join(os.environ['UC040_ROOT'], '.storage', side, (name or '_') + '.sqlite')
    if not os.path.exists(path):
        print('✘ [ERROR] 偽の保存先に無い: ' + str(name), file=sys.stderr); sys.exit(1)
    db = sqlite3.connect(path); db.row_factory = sqlite3.Row
    sql = value_of('--command') or ''
    out = []
    try:
        for st in [s for s in sql.split(';') if s.strip()]:
            cur = db.execute(st)
            rows = [dict(r) for r in cur.fetchall()]
            out.append({'results': rows, 'success': True, 'meta': {'changes': cur.rowcount if cur.rowcount > 0 else 0, 'rows_read': len(rows)}})
        db.commit()
    except sqlite3.Error as e:
        print('✘ [ERROR] ' + str(e), file=sys.stderr); sys.exit(1)
    if '--json' in args:
        print(json.dumps(out, ensure_ascii=False))
    else:
        for o in out:
            for r in o['results']:
                print(' | '.join('' if v is None else str(v) for v in r.values()))
    sys.exit(0)
print('偽の wrangler は受けない: ' + ' '.join(args), file=sys.stderr)
sys.exit(1)
`

export type Feedback = { id: string; body: string; status?: string; note?: string | null; kind?: string; page?: string; topic_id?: number | null }
export type StoredRow = { id: string; status: string; note: string | null; body: string }
export type ToolRun = { status: number | null; stdout: string; stderr: string; out: string }

export type Shadow = {
  root: string
  /** 保存先（本番か手元）に行を置く。 */
  put: (learning: string, rows: Feedback[], side?: 'remote' | 'local') => void
  /** 保存先の行を読む。 */
  rows: (learning: string, side?: 'remote' | 'local') => StoredRow[]
  /** 受け箱のファイル（data/<学び>/feedback/ の下の JSON）の中身を、ファイル名 → 中身で返す。 */
  inbox: (learning: string) => Record<string, string>
  /** 道具を回す（`python3 scripts/feedback.py <args>`。作業の場所は影の根）。failDbs の学びの保存先は毎回失敗する。 */
  run: (args: string[], failLearnings?: string[]) => ToolRun
}

const temps: string[] = []
/** 作った影の根をすべて消す。 */
export function removeTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function storage(file: string): void {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try {
    for (const sql of MIGRATIONS) for (const st of sql.split(/-->\s*statement-breakpoint/)) if (st.trim()) db.exec(st)
  } finally {
    db.close()
  }
}

/** 影の根を作る。すべての学びの本番と手元の保存先は、空の feedback の表を持つ。 */
export function shadow(): Shadow {
  const base = mkdtempSync(join(tmpdir(), 'uc040-'))
  temps.push(base)
  const root = join(base, 'root')
  mkdirSync(join(root, 'src'), { recursive: true })
  const copy = process.platform === 'darwin' ? ['-cR'] : ['-R']
  const cp = spawnSync('cp', [...copy, join(ROOT, 'scripts'), `${root}/`])
  if (cp.status !== 0) cpSync(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true })
  cpSync(join(ROOT, 'src', 'shared'), join(root, 'src', 'shared'), { recursive: true })
  cpSync(join(ROOT, 'migrations'), join(root, 'migrations'), { recursive: true })
  for (const key of LEARNINGS) mkdirSync(join(root, 'data', key), { recursive: true })
  for (const side of ['remote', 'local']) {
    mkdirSync(join(root, '.storage', side), { recursive: true })
    for (const key of LEARNINGS) storage(join(root, '.storage', side, `${dbOf(key)}.sqlite`))
  }
  const bin = join(root, '.fake-bin')
  mkdirSync(bin)
  writeFileSync(join(root, '.storage', 'wrangler.py'), FAKE_WRANGLER)
  const shim = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  shim('wrangler', `exec python3 "${join(root, '.storage', 'wrangler.py')}" "$@"`)
  shim(
    'npx',
    `while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) break ;; esac; done\ncase "$1" in wrangler*) shift; exec python3 "${join(root, '.storage', 'wrangler.py')}" "$@" ;; esac\necho "偽の npx は受けない: $*" >&2\nexit 127`,
  )
  shim('curl', 'echo "外へは出ない" >&2\nexit 7')
  const sqlite = (learning: string, side: string) => join(root, '.storage', side, `${dbOf(learning)}.sqlite`)
  return {
    root,
    put: (learning, rows, side = 'remote') => {
      const db = new DatabaseSync(sqlite(learning, side), { enableForeignKeyConstraints: false })
      try {
        db.exec("INSERT OR IGNORE INTO users (id, email, name, password_hash) VALUES ('u1', 'u1@example.invalid', '利用者一', 'x')")
        const insert = db.prepare('INSERT INTO feedback (id, user_id, kind, page, topic_id, body, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        rows.forEach((r, i) =>
          insert.run(r.id, 'u1', r.kind ?? 'improve', r.page ?? '/topics', r.topic_id ?? null, r.body, r.status ?? 'new', r.note ?? null, 1_760_000_000 + i),
        )
      } finally {
        db.close()
      }
    },
    rows: (learning, side = 'remote') => {
      const db = new DatabaseSync(sqlite(learning, side))
      try {
        return db.prepare('SELECT id, status, note, body FROM feedback ORDER BY id').all() as unknown as StoredRow[]
      } finally {
        db.close()
      }
    },
    inbox: (learning) => {
      const dir = join(root, 'data', learning, 'feedback')
      if (!existsSync(dir)) return {}
      return Object.fromEntries(
        readdirSync(dir)
          .filter((n) => n.endsWith('.json'))
          .map((n) => [n, readFileSync(join(dir, n), 'utf8')]),
      )
    },
    run: (args, failLearnings = []) => {
      const r = spawnSync('python3', [join(root, 'scripts', 'feedback.py'), ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `${bin}:${(process.env.PATH ?? '').split(':').filter((p) => !p.includes('node_modules')).join(':')}`,
          UC040_ROOT: root,
          UC040_ACCOUNT: ACCOUNT,
          FAIL_DBS: failLearnings.map(dbOf).join(','),
          CLOUDFLARE_API_TOKEN: 'uc040-invalid-token',
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          HTTPS_PROXY: 'http://127.0.0.1:9',
          HTTP_PROXY: 'http://127.0.0.1:9',
          NO_PROXY: '',
          WRANGLER_SEND_METRICS: 'false',
        },
      })
      const stdout = r.stdout ?? ''
      const stderr = r.stderr ?? ''
      return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}` }
    },
  }
}

/** 偽の配備の道具が受けた呼び出し（引数の並び）。 */
export function calls(s: Shadow): string[][] {
  const file = join(s.root, 'calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as string[])
}

/** 偽の保存先が出す失敗の文。 */
export const FAILURE_TEXT = 'FAKE-D1-FAILURE'
/** 道具が名前の無い例外で止まったか。 */
export const crashed = (r: ToolRun) => /Traceback \(most recent call last\)/.test(r.stderr)
