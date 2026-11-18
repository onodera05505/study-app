import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * UC-015 の REQ-578: 本番の検査（`bash scripts/check_sso_prod.sh`）が、挙げた問題に契約の errors に当たる物があるときだけ、
 * 標準出力の最後の行に機械向けの 1 行（契約 UC-015 の schemas.CheckProblems）を出す。
 *
 * 外の世界は PATH の先頭に置いた偽の `curl`・`npx`・`wrangler` が演じる（配備と経路ごとの応答・ヘッダ・届かないこと、
 * ログイン中のアカウント、配備ごとの秘密の名前の一覧と取得の失敗）。子のプロセスでは外への通信を 2 重に塞ぐ
 * （届かない代理と、node の外向きの接続を断る前置き）。本番にも外の相手にも届かない。
 *
 * 最後の行は、標準出力の最後の空でない行を JSON として読む（REQ-578 の境界の扱い）。項目の読み方は契約の CheckProblems:
 * `error.problems[]` の各項目が `deployment`（配備の key）・`operation`（その問題を見た操作の名前）・
 * `path`（openDeploymentEntry だけ）・`route`（probeRetiredPasswordRoute だけ）を持ち、契約の errors に当たる問題だけが `code` を持つ。
 * `error.code` は problems のうち code を持つ最初の項目の名前。理由の文言・人が読む一覧の文言・全体の終了の状態は照らさない。
 *
 * 「行を足す前の出力」（#human-list-unchanged）は、機械向けの行を足す前の版の検査（コミット BEFORE の
 * `scripts/check_sso_prod.sh`）を、そのファイルだけを差し替えた影の根で同じ偽物と同じ入力に対して回した出力。
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
/** 機械向けの行を足す前の版の検査を持つコミット。 */
const BEFORE = 'b9003414'

/** 登録簿（scripts/targets.py）と配備の値の正本（scripts/pages_projects.json）から配備を導く。 */
type Deployment = { key: string; url: string; project: string }
const pagesProjects = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as {
  account_id: string
  _portal: { project: string; url: string }
}
const targets = (...args: string[]) => execFileSync('python3', [join(ROOT, 'scripts', 'targets.py'), ...args], { cwd: ROOT, encoding: 'utf8' }).trim()
const ACCOUNT = pagesProjects.account_id
const PORTAL: Deployment = { key: '_portal', url: pagesProjects._portal.url, project: pagesProjects._portal.project }
const LEARNINGS: Deployment[] = targets('keys')
  .split(/\s+/)
  .map((key) => ({ key, url: targets('url', key), project: targets('project', key) }))
const byKey = (key: string) => {
  const found = [PORTAL, ...LEARNINGS].find((d) => d.key === key)
  if (!found) throw new Error(`登録簿に ${key} が無い`)
  return found
}
const IP = byKey('ip')
const ITC = byKey('itc')

/** 配備ごとに必要な秘密の名前（用語集の共有秘密とトークンの署名の秘密）。偽の wrangler は既定でこれをそろえて返す。 */
const SHARED_SECRET = 'SSO_SECRET'
const SIGNING_SECRET = 'JWT_SECRET'

/** 定められたセキュリティヘッダ（契約 readDeploymentHealthHeaders の ok の例）。偽の curl は既定でこれをそろえて返す。 */
const REQUIRED_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
/** 契約 readDeploymentHealthHeaders の headerMissing の例が返すヘッダ。 */
const HEADER_MISSING_EXAMPLE: Record<string, string> = {
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
}

/** 偽の curl への規則。url は完全一致か、末尾の `*` で前置き一致。exit は curl の終了の状態（届かない）。 */
type HttpRule = { method?: string; url: string; status?: number; exit?: number; body?: string; headers?: Record<string, string> }
/** 偽の wrangler への規則。exit が 0 でなければその配備の一覧の取得が失敗する。 */
type SecretRule = { project: string; exit?: number; names?: string[] }
type Scenario = { http?: HttpRule[]; secrets?: SecretRule[]; accounts?: string[] }
type Run = { code: number; stdout: string; stderr: string; out: string[] }

const NET_GUARD = `const net = require('node:net')
const connect = net.Socket.prototype.connect
const LOCAL = new Set(['localhost', '127.0.0.1', '::1'])
net.Socket.prototype.connect = function (...args) {
  let o = args[0]
  if (Array.isArray(o)) o = o[0]
  let host = null
  let path = null
  if (o && typeof o === 'object') { host = o.host ?? (o.path ? null : 'localhost'); path = o.path ?? null }
  else if (typeof o === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost'
  else if (typeof o === 'string') path = o
  if (!path && host && !LOCAL.has(host)) throw new Error('テストの囲い: 外への接続を断った ' + host)
  return connect.apply(this, args)
}
`

/** 偽の curl（node）。引数から method・URL・ヘッダと本文と -w の出し方を読み、規則に合う応答を返す。 */
const CURL_STUB = `#!${process.execPath}
const fs = require('node:fs')
const argv = process.argv.slice(2)
const VALUE_SHORT = new Set(['o', 'w', 'D', 'X', 'd', 'H', 'A', 'm', 'u', 'e', 'b', 'c', 'r', 'T', 'F', 'x', 'U', 'K', 'E'])
const VALUE_LONG = new Set(['--output', '--write-out', '--dump-header', '--request', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '--header', '--user-agent', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '--user', '--referer', '--cookie', '--cookie-jar', '--url', '--proxy', '--config', '--resolve', '--connect-to', '--max-redirs', '--form'])
let method = null, url = null, writeOut = null, dumpHeader = null, output = null, include = false, head = false, fail = false, hasData = false
const take = (flag, value) => {
  switch (flag) {
    case '-X': case '--request': method = value; break
    case '-w': case '--write-out': writeOut = value; break
    case '-D': case '--dump-header': dumpHeader = value; break
    case '-o': case '--output': output = value; break
    case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-urlencode': case '--json': case '-F': case '--form': hasData = true; break
    case '--url': url = value; break
  }
}
const flag = (f) => {
  switch (f) {
    case '-i': case '--include': include = true; break
    case '-I': case '--head': head = true; break
    case '-f': case '--fail': case '--fail-with-body': fail = true; break
  }
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const eq = a.indexOf('=')
    if (eq > 0) { take(a.slice(0, eq), a.slice(eq + 1)); continue }
    if (VALUE_LONG.has(a)) { take(a, argv[++i]); continue }
    flag(a)
    continue
  }
  if (a.startsWith('-') && a.length > 1) {
    for (let j = 1; j < a.length; j++) {
      const c = a[j]
      if (VALUE_SHORT.has(c)) { const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i]; take('-' + c, v); break }
      flag('-' + c)
    }
    continue
  }
  if (/^https?:\\/\\//.test(a)) url = a
}
if (!method) method = head ? 'HEAD' : hasData ? 'POST' : 'GET'
fs.appendFileSync(process.env.STUB_LOG, method + ' ' + url + '\\n')
const rules = JSON.parse(fs.readFileSync(process.env.STUB_RULES, 'utf8'))
const REQUIRED = JSON.parse(process.env.STUB_REQUIRED_HEADERS)
const match = (r) => {
  if (r.method && r.method !== method) return false
  return r.url.endsWith('*') ? (url || '').startsWith(r.url.slice(0, -1)) : url === r.url
}
const rule = rules.find(match) || {}
const rest = (url || '').replace(/^[a-z]+:\\/\\//, '')
const path = rest.includes('/') ? rest.slice(rest.indexOf('/')).split('?')[0] : '/'
let status = rule.status, body = rule.body
if (status === undefined || body === undefined) {
  let s = 200, b = '<!doctype html><title>entry</title>'
  if (method === 'GET' && path === '/api/health') b = '{"ok":true}'
  else if (method === 'GET' && path === '/api/auth/config') b = JSON.stringify({ sso: true, portal: process.env.STUB_PORTAL_URL, app: 'learning' })
  else if (method === 'POST' && (path === '/api/auth/login' || path === '/api/auth/register')) { s = 404; b = '{"error":"この学びはまなびばからログインします"}' }
  if (status === undefined) status = s
  if (body === undefined) body = b
}
const headers = { 'content-type': path.startsWith('/api/') ? 'application/json' : 'text/html', ...(rule.headers || REQUIRED) }
const exit = rule.exit || 0
const out = []
const headerBlock = () => 'HTTP/2 ' + status + '\\r\\n' + Object.entries(headers).map(([n, v]) => n + ': ' + v + '\\r\\n').join('') + '\\r\\n'
const lower = Object.fromEntries(Object.entries(headers).map(([n, v]) => [n.toLowerCase(), v]))
const expand = (fmt) => {
  if (fmt.startsWith('@')) fmt = fs.readFileSync(fmt.slice(1), 'utf8')
  return fmt
    .replace(/\\\\n/g, '\\n').replace(/\\\\t/g, '\\t').replace(/\\\\r/g, '\\r')
    .replace(/%header\\{([^}]+)\\}/g, (_m, n) => (exit ? '' : lower[n.toLowerCase()] ?? ''))
    .replace(/%\\{([a-z_]+)\\}/g, (_m, k) => {
      if (k === 'http_code' || k === 'response_code') return exit ? '000' : String(status)
      if (k === 'header_json') return exit ? '{}' : JSON.stringify(Object.fromEntries(Object.entries(headers).map(([n, v]) => [n.toLowerCase(), [v]])))
      if (k === 'url_effective') return url || ''
      if (k === 'exitcode') return String(exit)
      if (k === 'http_version') return '2'
      return ''
    })
}
if (exit) {
  if (writeOut !== null) out.push(expand(writeOut))
  process.stdout.write(out.join(''))
  process.stderr.write('curl: (' + exit + ') Failed to connect\\n')
  process.exit(exit)
}
const failed = fail && status >= 400
if (dumpHeader !== null) {
  if (dumpHeader === '-') out.push(headerBlock())
  else fs.writeFileSync(dumpHeader, headerBlock())
}
if ((include || head) && dumpHeader !== '-') out.push(headerBlock())
if (!head && !failed) {
  if (output !== null && output !== '-') fs.writeFileSync(output, body)
  else out.push(body)
}
if (writeOut !== null) out.push(expand(writeOut))
process.stdout.write(out.join(''))
process.exit(failed ? 22 : 0)
`

/** 偽の wrangler。whoami はログイン中のアカウントの表、pages secret list は規則の一覧か取得の失敗を返す。 */
const WRANGLER_STUB = `#!/usr/bin/env bash
printf 'wrangler %s\\n' "$*" >> "$STUB_LOG"
NL=$'\\n'
if [ "$1" = whoami ]; then
  out=" ⛅️ wrangler 4.0.0\${NL}👋 You are logged in with an OAuth Token.\${NL}"
  out+="┌──────────────┬──────────────────────────────────┐\${NL}│ Account Name │ Account ID                       │\${NL}"
  n=0
  for a in $STUB_ACCOUNTS; do n=$((n+1)); out+="│ Account $n    │ $a │\${NL}"; done
  out+="└──────────────┴──────────────────────────────────┘\${NL}"
  printf '%s' "$out"
  exit 0
fi
if [ "$1 $2 $3" = "pages secret list" ]; then
  project=""
  while [ $# -gt 0 ]; do
    case "$1" in --project-name) project="$2"; shift ;; --project-name=*) project="\${1#--project-name=}" ;; esac
    shift
  done
  names="$STUB_DEFAULT_NAMES"; code=0
  while IFS=$'\\t' read -r p ex ns; do
    [ "$p" = "$project" ] && { code="$ex"; names="$ns"; break; }
  done < "$STUB_SECRETS"
  if [ "$code" != 0 ]; then
    echo "✘ [ERROR] A request to the Cloudflare API failed. Could not route to /pages/projects/$project [code: 7003]" >&2
    exit "$code"
  fi
  out=" ⛅️ wrangler 4.0.0\${NL}"
  for n in $names; do out+="$n: Value Encrypted\${NL}"; done
  printf '%s' "$out"
  exit 0
fi
echo "stub: wrangler $* は想定外" >&2
exit 1
`
const NPX_STUB = `#!/usr/bin/env bash
case "$1" in
  wrangler|wrangler@*) shift; exec "$STUB_BIN/wrangler" "$@" ;;
esac
echo "stub: npx $1 は想定外" >&2
exit 1
`

const RUN_TIMEOUT = 240_000
const workDirs: string[] = []

const writeExecutable = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

/** 機械向けの行を足す前の版の検査だけを差し替えた影の根（ほかはリポジトリへのリンク）。 */
const beforeRoot = (): string => {
  const root = join(mkdtempSync(join(tmpdir(), 'uc015m-before-')), 'root')
  workDirs.push(join(root, '..'))
  mkdirSync(root)
  for (const name of readdirSync(ROOT)) if (name !== 'scripts' && name !== '.git') symlinkSync(join(ROOT, name), join(root, name))
  mkdirSync(join(root, 'scripts'))
  for (const name of readdirSync(join(ROOT, 'scripts'))) if (name !== 'check_sso_prod.sh') symlinkSync(join(ROOT, 'scripts', name), join(root, 'scripts', name))
  writeFileSync(join(root, 'scripts', 'check_sso_prod.sh'), execFileSync('git', ['show', `${BEFORE}:scripts/check_sso_prod.sh`], { cwd: ROOT }))
  return root
}

/** 偽物を置いた bin と規則を作り、検査を 1 回回す（root はリポジトリか影の根）。 */
const runCheck = (name: string, scenario: Scenario, root = ROOT): Promise<Run> => {
  const dir = mkdtempSync(join(tmpdir(), `uc015m-${name}-`))
  workDirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeExecutable(join(bin, 'curl'), CURL_STUB)
  writeExecutable(join(bin, 'wrangler'), WRANGLER_STUB)
  writeExecutable(join(bin, 'npx'), NPX_STUB)
  const guard = join(dir, 'net-guard.cjs')
  writeFileSync(guard, NET_GUARD)
  const rules = join(dir, 'http.json')
  writeFileSync(rules, JSON.stringify(scenario.http ?? []))
  const secrets = join(dir, 'secrets.tsv')
  writeFileSync(secrets, (scenario.secrets ?? []).map((r) => [r.project, String(r.exit ?? 0), (r.names ?? []).join(' ')].join('\t')).join('\n') + '\n')
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp)
  const env = {
    ...process.env,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    NODE_OPTIONS: `--require ${guard}`,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    CLOUDFLARE_API_TOKEN: 'stub-invalid-token-do-not-use',
    STUB_BIN: bin,
    STUB_RULES: rules,
    STUB_SECRETS: secrets,
    STUB_LOG: log,
    STUB_REQUIRED_HEADERS: JSON.stringify(REQUIRED_HEADERS),
    STUB_PORTAL_URL: PORTAL.url,
    STUB_ACCOUNTS: (scenario.accounts ?? [ACCOUNT]).join(' '),
    STUB_DEFAULT_NAMES: `${SHARED_SECRET} ${SIGNING_SECRET}`,
  }
  return new Promise((resolve, reject) => {
    execFile('bash', [join(root, 'scripts', 'check_sso_prod.sh')], { cwd: root, env, maxBuffer: 1 << 24, timeout: RUN_TIMEOUT, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const e = error as (Error & { code?: unknown; killed?: boolean }) | null
      if (e?.killed) return reject(new Error(`${name}: 検査が ${RUN_TIMEOUT / 1000} 秒で終わらない`))
      const out = stdout.split('\n').filter((l) => l.trim() !== '')
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr, out })
    })
  })
}

type Problem = { deployment?: unknown; operation?: unknown; path?: unknown; route?: unknown; code?: unknown }
type MachineLine = { error: { code?: unknown; reason?: unknown; problems?: Problem[] } }

/** 標準出力の最後の空でない行を JSON として読み、機械向けの 1 行の形なら返す。 */
const machineLine = (r: Run): MachineLine | undefined => {
  const last = r.out.at(-1)
  if (last === undefined) return undefined
  try {
    const v = JSON.parse(last) as MachineLine
    return v && typeof v === 'object' && v.error && typeof v.error === 'object' ? v : undefined
  } catch {
    return undefined
  }
}

/** 機械向けの行があり、その形の核（名前・理由・問題の並び、error.code は code を持つ最初の項目の名前）が契約どおりであること。 */
const expectLine = (r: Run, label: string): Problem[] => {
  const line = machineLine(r)
  expect(line, `${label}: 標準出力の最後の行が機械向けの 1 行でない:\n${r.out.slice(-10).join('\n')}`).toBeDefined()
  const problems = line?.error.problems ?? []
  expect(Array.isArray(problems) && problems.length > 0, `${label}: problems が空`).toBe(true)
  expect(typeof line?.error.reason === 'string' && line.error.reason !== '', `${label}: 理由が無い`).toBe(true)
  expect(line?.error.code, `${label}: error.code が code を持つ最初の項目の名前でない`).toBe(problems.find((p) => p.code !== undefined)?.code)
  return problems
}

/** 配備・操作（と path・route）が合う項目。 */
const itemsOf = (problems: Problem[], deployment: string, operation: string, at: { path?: string; route?: string } = {}) =>
  problems.filter(
    (p) =>
      p.deployment === deployment &&
      p.operation === operation &&
      (at.path === undefined || p.path === at.path) &&
      (at.route === undefined || p.route === at.route),
  )

/** その配備と項目に、決めた名前が添う項目があること。 */
const expectNamed = (problems: Problem[], deployment: string, operation: string, code: string, at: { path?: string; route?: string } = {}) => {
  const items = itemsOf(problems, deployment, operation, at)
  expect(items.length, `${deployment} ${operation} ${JSON.stringify(at)} が並んでいない: ${JSON.stringify(problems)}`).toBeGreaterThan(0)
  expect(
    items.map((p) => p.code),
    `${deployment} ${operation} ${JSON.stringify(at)} の名前`,
  ).toContain(code)
}

const OTHER_ACCOUNT = 'ffffffffffffffffffffffffffffffff'

/** 各テストが見る入力。 */
const SCENARIOS = {
  pass: {},
  // 死活確認だけが返らない（ヘッダも同じ経路なので得られない）
  ipHealthNoAnswer: { http: [{ url: `${IP.url}/api/health`, exit: 7 }] },
  // 入口の画面の経路 1 つが届かない（まなびばの /app.js）
  portalAppJsNoAnswer: { http: [{ method: 'GET', url: `${PORTAL.url}/app.js`, exit: 7 }] },
  // 学び側のパスワードでのログインの経路だけが届かない
  ipLoginNoAnswer: { http: [{ method: 'POST', url: `${IP.url}/api/auth/login`, exit: 7 }] },
  // ログイン中のアカウントのどれもその配備を持たない
  wrongAccount: { accounts: [OTHER_ACCOUNT] },
  // ip の秘密の名前の一覧の取得が失敗する
  ipListUnavailable: { secrets: [{ project: IP.project, exit: 1 }] },
  // 名前を持たない問題だけ（足りない秘密の名前・欠けたヘッダ・閉じていない経路）
  unnamedOnly: {
    secrets: [{ project: IP.project, names: [SHARED_SECRET] }],
    http: [
      { method: 'GET', url: `${IP.url}/api/health`, headers: HEADER_MISSING_EXAMPLE },
      { method: 'POST', url: `${ITC.url}/api/auth/register`, status: 400, body: '{"error":"入力が正しくありません"}' },
    ],
  },
  // 名前を持つ問題（まなびばの /app.js が届かない）と、名前を持たない問題が並ぶ
  mixed: {
    secrets: [{ project: IP.project, names: [SHARED_SECRET] }],
    http: [
      { method: 'GET', url: `${PORTAL.url}/app.js`, exit: 7 },
      { method: 'GET', url: `${IP.url}/api/health`, headers: HEADER_MISSING_EXAMPLE },
      { method: 'POST', url: `${ITC.url}/api/auth/register`, status: 400, body: '{"error":"入力が正しくありません"}' },
    ],
  },
} satisfies Record<string, Scenario>
type ScenarioName = keyof typeof SCENARIOS
/** 行を足す前の版でも回す入力（名前を持つ問題がある物）。 */
const COMPARED: ScenarioName[] = ['ipHealthNoAnswer', 'wrongAccount', 'mixed']

const runs = new Map<ScenarioName, Run>()
const befores = new Map<ScenarioName, Run>()
const run = (name: ScenarioName): Run => {
  const r = runs.get(name)
  if (!r) throw new Error(`${name} の実行結果が無い`)
  return r
}

beforeAll(async () => {
  const root = beforeRoot()
  const [now, then] = await Promise.all([
    Promise.all((Object.entries(SCENARIOS) as Array<[ScenarioName, Scenario]>).map(async ([n, s]) => [n, await runCheck(n, s)] as const)),
    Promise.all(COMPARED.map(async (n) => [n, await runCheck(`before-${n}`, SCENARIOS[n], root)] as const)),
  ])
  for (const [n, r] of now) runs.set(n, r)
  for (const [n, r] of then) befores.set(n, r)
}, 480_000)

afterAll(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('UC-015 本番が生きていることと秘密がそろっていることを機械で確かめる', () => {
  describe('REQ-578 契約の errors に当たる問題があるときだけ、標準出力の最後の行に機械向けの 1 行を出す', () => {
    // @covers REQ-578#health-unreachable-named
    it('死活確認が返らない配備が 1 つあると、最後の行にその配備の死活確認の項目が UPSTREAM_UNAVAILABLE を添えて並ぶ', () => {
      const problems = expectLine(run('ipHealthNoAnswer'), '死活確認が返らない')
      expectNamed(problems, IP.key, 'checkDeploymentHealth', 'UPSTREAM_UNAVAILABLE')
      expect(itemsOf(problems, PORTAL.key, 'checkDeploymentHealth'), '返った配備の死活確認が並んでいる').toEqual([])
    })

    // @covers REQ-578#each-http-item-named
    it('死活確認のヘッダ・入口の画面の経路・学び側のパスワードでの経路のそれぞれが届かないと、その配備と項目（経路の違いを含む）に UPSTREAM_UNAVAILABLE が添う', () => {
      // ヘッダ（死活確認に届かずヘッダが得られない）
      expectNamed(expectLine(run('ipHealthNoAnswer'), 'ヘッダが得られない'), IP.key, 'readDeploymentHealthHeaders', 'UPSTREAM_UNAVAILABLE')
      // 入口の画面の経路（届かないのは /app.js だけ）
      const entry = expectLine(run('portalAppJsNoAnswer'), '入口の経路が届かない')
      expectNamed(entry, PORTAL.key, 'openDeploymentEntry', 'UPSTREAM_UNAVAILABLE', { path: '/app.js' })
      for (const path of ['/', '/style.css']) expect(itemsOf(entry, PORTAL.key, 'openDeploymentEntry', { path }), `開けた経路 ${path} が並んでいる`).toEqual([])
      // 学び側のパスワードでの経路（届かないのは login だけ）
      const route = expectLine(run('ipLoginNoAnswer'), 'パスワードでの経路が届かない')
      expectNamed(route, IP.key, 'probeRetiredPasswordRoute', 'UPSTREAM_UNAVAILABLE', { route: 'login' })
      expect(itemsOf(route, IP.key, 'probeRetiredPasswordRoute', { route: 'register' }), '閉じている経路 register が並んでいる').toEqual([])
    })

    // @covers REQ-578#secret-list-named
    it('秘密の名前の一覧を、アカウントがその配備を持たないため見られないと FORBIDDEN、取得が失敗すると UPSTREAM_UNAVAILABLE が、その配備の項目に添う', () => {
      expectNamed(expectLine(run('wrongAccount'), 'アカウント違い'), IP.key, 'listDeploymentSecretNames', 'FORBIDDEN')
      const unavailable = expectLine(run('ipListUnavailable'), '一覧の取得の失敗')
      expectNamed(unavailable, IP.key, 'listDeploymentSecretNames', 'UPSTREAM_UNAVAILABLE')
      expect(itemsOf(unavailable, IP.key, 'listDeploymentSecretNames').map((p) => p.code), '取得の失敗がアカウント違いに読める').not.toContain('FORBIDDEN')
    })

    // @covers REQ-578#unnamed-alongside
    it('名前を持つ問題と名前を持たない問題（足りない秘密の名前・欠けたヘッダ・閉じていない経路）が並び、名前は前者にだけ添う', () => {
      const problems = expectLine(run('mixed'), '混ざった入力')
      expectNamed(problems, PORTAL.key, 'openDeploymentEntry', 'UPSTREAM_UNAVAILABLE', { path: '/app.js' })
      const unnamed = [
        itemsOf(problems, IP.key, 'listDeploymentSecretNames'),
        itemsOf(problems, IP.key, 'readDeploymentHealthHeaders'),
        itemsOf(problems, ITC.key, 'probeRetiredPasswordRoute', { route: 'register' }),
      ]
      for (const items of unnamed) {
        expect(items.length, `名前を持たない問題が並んでいない: ${JSON.stringify(problems)}`).toBeGreaterThan(0)
        for (const p of items) expect(p.code, `名前を持たない問題に名前が添っている: ${JSON.stringify(p)}`).toBeUndefined()
      }
      expect(machineLine(run('mixed'))?.error.code).toBe('UPSTREAM_UNAVAILABLE')
    })

    // @covers REQ-578#human-list-unchanged
    it('機械向けの行の前の出力が、同じ入力で行を足す前の版の出力と同じ', () => {
      for (const name of COMPARED) {
        const now = run(name)
        const then = befores.get(name)
        expect(then, `${name} の行を足す前の版の結果が無い`).toBeDefined()
        expect(machineLine(now), `${name}: 機械向けの行が無い`).toBeDefined()
        expect(now.out.slice(0, -1), `${name}: 標準出力の人が読む一覧が変わった`).toEqual(then?.out)
        expect(now.stderr, `${name}: 標準エラーが変わった`).toBe(then?.stderr)
      }
    })

    // @covers REQ-578#no-line-without-named
    it('問題が無い入力と、名前を持たない問題だけの入力では、機械向けの行を出さない', () => {
      expect(machineLine(run('pass')), '問題が無いのに機械向けの行を出した').toBeUndefined()
      expect(machineLine(run('unnamedOnly')), '名前を持たない問題だけで機械向けの行を出した').toBeUndefined()
      // 名前を持たない問題が挙がる入力であること（行を出さないのが、問題を見落としたせいでないこと）
      expect(run('unnamedOnly').out, '名前を持たない問題が人が読む一覧に挙がっていない').not.toEqual(run('pass').out)
    })
  })
})
