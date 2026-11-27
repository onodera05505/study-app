import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * UC-015 本番の検査が、死活確認の応答に定められたセキュリティヘッダが載っているかを確かめること（REQ-523）。
 *
 * 本番の検査は `bash scripts/check_sso_prod.sh` を入口とし、外の配備には HTTP（curl）で、秘密の名前の一覧には
 * wrangler CLI で触る。PATH の先頭に置いた偽の `curl`・`npx`・`wrangler` が外の世界を演じ、配備と経路ごとに
 * 応答のヘッダを入力として与える（契約 `readDeploymentHealthHeaders`）。偽の curl は、ヘッダを受け取る curl の
 * 書き方（`-D`・`-i`・`-I`・`-w` の `%header{}` と `%{header_json}`）のどれで聞かれても同じヘッダを返す。
 * 子のプロセスでは外への通信を 2 重に塞ぐ（届かない代理と、node の外向きの接続を断る前置き）。本番には届かない。
 *
 * 出力の文言は照合しない。問題として挙がったかは、全部そろった入力の出力との差分（増えた行）に、
 * その配備の名前とヘッダの名前が現れるかで見る。
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const CHECK = join(ROOT, 'scripts', 'check_sso_prod.sh')
const execFileAsync = promisify(execFile)

/** 登録簿（scripts/targets.py）と配備の値の正本（scripts/pages_projects.json）から、見るべき配備を導く。 */
type Deployment = { key: string; label: RegExp; url: string; project: string }
const pagesProjects = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as {
  account_id: string
  _portal: { project: string; url: string }
}
const targets = (...args: string[]) => execFileSync('python3', [join(ROOT, 'scripts', 'targets.py'), ...args], { cwd: ROOT, encoding: 'utf8' }).trim()
const ACCOUNT = pagesProjects.account_id
const PORTAL: Deployment = {
  key: '_portal',
  label: new RegExp(`まなびば|_portal|${pagesProjects._portal.project}`),
  url: pagesProjects._portal.url,
  project: pagesProjects._portal.project,
}
const LEARNINGS: Deployment[] = targets('keys')
  .split(/\s+/)
  .map((key) => ({ key, label: new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)|${targets('project', key)}`), url: targets('url', key), project: targets('project', key) }))
const ALL = [PORTAL, ...LEARNINGS]
const byKey = (key: string) => {
  const found = ALL.find((d) => d.key === key)
  if (!found) throw new Error(`登録簿に ${key} が無い`)
  return found
}
const IP = byKey('ip')

/** 配備ごとに必要な秘密の名前（用語集）。偽の wrangler は全部の配備にこれをそろえて返す。 */
const SECRET_NAMES = ['SSO_SECRET', 'JWT_SECRET']

/** 定められたセキュリティヘッダ（NFR-001 の 5 つ。値は契約 readDeploymentHealthHeaders の ok の例）。 */
const REQUIRED_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}
const REQUIRED_NAMES = Object.keys(REQUIRED_HEADERS)

/** 契約の headerMissing の例が返すヘッダ（定められた 5 つのうち 2 つだけ）。 */
const HEADER_MISSING_EXAMPLE: Record<string, string> = {
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
}
const without = (names: string[]) => Object.fromEntries(Object.entries(REQUIRED_HEADERS).filter(([n]) => !names.includes(n)))
/** 名前の大文字・小文字を HTTP/1.1 の慣用の書き方にした 5 つのヘッダ。 */
const CAPITALIZED = Object.fromEntries(
  Object.entries(REQUIRED_HEADERS).map(([n, v]) => [n.replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase()), v]),
)

/** 偽の curl への規則。url は完全一致か、末尾の `*` で前置き一致。headers を与えないときは 5 つのヘッダがそろう。 */
type HttpRule = { method?: string; url: string; status?: number; exit?: number; body?: string; headers?: Record<string, string> }
type Scenario = { http?: HttpRule[] }
type Run = { code: number; out: string; lines: string[]; log: string[] }

/** 外向きの接続を断る前置き（NODE_OPTIONS の --require で子の node に入れる）。手元（loopback と UNIX ソケット）だけ通す。 */
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
fs.appendFileSync(process.env.STUB_LOG, method + ' ' + url + ' data=' + (hasData ? 1 : 0) + '\\n')
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

/** 偽の npx・wrangler。whoami は配備を持つアカウント、pages secret list は必要な名前がそろった一覧を返す。 */
const WRANGLER_STUB = `#!/usr/bin/env bash
printf 'wrangler %s\\n' "$*" >> "$STUB_LOG"
NL=$'\\n'
if [ "$1" = whoami ]; then
  out=" ⛅️ wrangler 4.0.0\${NL}👋 You are logged in with an OAuth Token.\${NL}"
  out+="┌──────────────┬──────────────────────────────────┐\${NL}│ Account Name │ Account ID                       │\${NL}"
  out+="│ Account 1    │ $STUB_ACCOUNT │\${NL}└──────────────┴──────────────────────────────────┘\${NL}"
  printf '%s' "$out"
  exit 0
fi
if [ "$1 $2 $3" = "pages secret list" ]; then
  out=" ⛅️ wrangler 4.0.0\${NL}"
  for n in $STUB_SECRET_NAMES; do out+="$n: Value Encrypted\${NL}"; done
  printf '%s' "$out"
  exit 0
fi
echo "stub: wrangler $* は想定外" >&2
exit 1
`
const NPX_STUB = `#!/usr/bin/env bash
case "$1" in
  wrangler) shift; exec "$STUB_BIN/wrangler" "$@" ;;
  wrangler@*) shift; exec "$STUB_BIN/wrangler" "$@" ;;
esac
printf 'npx %s\\n' "$*" >> "$STUB_LOG"
echo "stub: npx $1 は想定外" >&2
exit 1
`

/** 1 回の検査の上限。全部の入力を並行して回す beforeAll の上限より短くする。 */
const RUN_TIMEOUT = 240_000
const workDirs: string[] = []

const writeExecutable = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

/** 偽物を置いた bin と規則を作り、検査を 1 回回す。 */
const runCheck = async (name: string, scenario: Scenario): Promise<Run> => {
  const dir = mkdtempSync(join(tmpdir(), `uc015h-${name}-`))
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
    STUB_LOG: log,
    STUB_REQUIRED_HEADERS: JSON.stringify(REQUIRED_HEADERS),
    STUB_PORTAL_URL: PORTAL.url,
    STUB_ACCOUNT: ACCOUNT,
    STUB_SECRET_NAMES: SECRET_NAMES.join(' '),
  }
  let code = 0
  let out = ''
  try {
    const r = await execFileAsync('bash', [CHECK], { cwd: ROOT, env, maxBuffer: 1 << 24, timeout: RUN_TIMEOUT, killSignal: 'SIGKILL' })
    out = r.stdout + r.stderr
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean }
    if (e.killed) throw new Error(`${name}: 検査が ${RUN_TIMEOUT / 1000} 秒で終わらない`)
    code = typeof e.code === 'number' ? e.code : 1
    out = (e.stdout ?? '') + (e.stderr ?? '')
  }
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.length > 0)
  return { code, out, lines, log: calls }
}

/** 各テストが見る入力。全部そろった入力（pass）との差分で問題の行を取り出すので、pass は必ず含める。 */
const SCENARIOS = {
  pass: {},
  ipHeaderMissing: { http: [{ method: 'GET', url: `${IP.url}/api/health`, headers: HEADER_MISSING_EXAMPLE }] },
  portalReferrerMissing: { http: [{ method: 'GET', url: `${PORTAL.url}/api/health`, headers: without(['referrer-policy']) }] },
  ipHealthNoAnswer: { http: [{ url: `${IP.url}/api/health`, exit: 7 }] },
  capitalizedNames: { http: ALL.map((d) => ({ method: 'GET', url: `${d.url}/api/health`, headers: CAPITALIZED })) },
} satisfies Record<string, Scenario>
type ScenarioName = keyof typeof SCENARIOS

const runs = new Map<ScenarioName, Run>()
const run = (name: ScenarioName): Run => {
  const r = runs.get(name)
  if (!r) throw new Error(`${name} の実行結果が無い`)
  return r
}
/** 全部そろった入力の出力に無い行＝その入力で問題として挙がった行。 */
const raised = (name: ScenarioName): string[] => {
  const pass = new Set(run('pass').lines)
  return run(name).lines.filter((l) => !pass.has(l))
}
const mentions = (lines: string[], d: Deployment) => lines.some((l) => d.label.test(l))
const namesHeader = (lines: string[], header: string) => lines.some((l) => l.toLowerCase().includes(header))
const tail = (r: Run) => r.out.split('\n').slice(-40).join('\n')
const healthVisited = (r: Run, d: Deployment) => r.log.some((l) => l.startsWith(`GET ${d.url}/api/health `) || l.startsWith(`HEAD ${d.url}/api/health `))

beforeAll(async () => {
  expect(LEARNINGS.length, '登録簿から学びの配備が導けていない').toBeGreaterThanOrEqual(2)
  const entries = await Promise.all(
    (Object.entries(SCENARIOS) as Array<[ScenarioName, Scenario]>).map(async ([name, scenario]) => [name, await runCheck(name, scenario)] as const),
  )
  for (const [name, r] of entries) runs.set(name, r)
}, 480_000)

afterAll(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('UC-015 死活確認の応答のセキュリティヘッダ（偽の配備先に対して scripts/check_sso_prod.sh を回す）', () => {
  describe('REQ-523 定められたセキュリティヘッダが載っていなければ配備とヘッダの名前を挙げる', () => {
    // @covers REQ-523#all-present
    it('全ての配備の死活確認の応答に 5 つのヘッダがそろっていれば、どのヘッダも問題に挙げず検査が通る', () => {
      const r = run('pass')
      for (const d of ALL) expect(healthVisited(r, d), `${d.key} の死活確認を叩いていない`).toBe(true)
      expect(r.code, `ヘッダがそろっているのに検査が通らない:\n${tail(r)}`).toBe(0)
    })

    // @covers REQ-523#learning-header-missing
    it('学びの死活確認の応答からヘッダが欠けると、その学びと欠けたヘッダの名前を全部挙げ、載っているヘッダの名前は挙げない', () => {
      const lines = raised('ipHeaderMissing')
      expect(mentions(lines, IP), `欠けた配備（ip）が挙がっていない:\n${tail(run('ipHeaderMissing'))}`).toBe(true)
      const missing = REQUIRED_NAMES.filter((n) => !(n in HEADER_MISSING_EXAMPLE))
      for (const name of missing) expect(namesHeader(lines, name), `欠けたヘッダ ${name} が挙がっていない:\n${lines.join('\n')}`).toBe(true)
      // 載っているヘッダは問題に挙げない（欠けていないものまで挙げると、載っていないものを挙げたことにならない）
      for (const name of Object.keys(HEADER_MISSING_EXAMPLE)) {
        expect(namesHeader(lines, name), `載っているヘッダ ${name} を問題に挙げた:\n${lines.join('\n')}`).toBe(false)
      }
    })

    // @covers REQ-523#portal-header-missing
    it('まなびばの死活確認の応答からヘッダが 1 つ欠けると、まなびばとそのヘッダの名前を挙げる', () => {
      const lines = raised('portalReferrerMissing')
      expect(mentions(lines, PORTAL), `欠けた配備（まなびば）が挙がっていない:\n${tail(run('portalReferrerMissing'))}`).toBe(true)
      expect(namesHeader(lines, 'referrer-policy'), `欠けたヘッダ referrer-policy が挙がっていない:\n${lines.join('\n')}`).toBe(true)
    })

    // @covers REQ-523#no-answer
    it('死活確認が返らずヘッダが得られないと、その配備と定められたヘッダの名前を全部挙げる', () => {
      const lines = raised('ipHealthNoAnswer')
      expect(mentions(lines, IP), `届かない配備（ip）が挙がっていない:\n${tail(run('ipHealthNoAnswer'))}`).toBe(true)
      for (const name of REQUIRED_NAMES) expect(namesHeader(lines, name), `届かない配備のヘッダ ${name} が挙がっていない:\n${lines.join('\n')}`).toBe(true)
    })

    // @covers REQ-523#header-name-case-insensitive
    it('ヘッダの名前の大文字・小文字が違っても 5 つがそろっていれば載っている側として扱い、問題に挙げない', () => {
      const r = run('capitalizedNames')
      const lines = raised('capitalizedNames')
      for (const name of REQUIRED_NAMES) expect(namesHeader(lines, name), `載っているヘッダ ${name} を問題に挙げた:\n${lines.join('\n')}`).toBe(false)
      expect(r.code, `ヘッダがそろっているのに検査が通らない:\n${tail(r)}`).toBe(0)
    })
  })
})
