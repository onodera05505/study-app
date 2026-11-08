import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * UC-015 本番の検査（REQ-213〜222 のうち、検査そのものの振る舞い）。
 *
 * 本番の検査は `bash scripts/check_sso_prod.sh` を入口とし、外の配備には HTTP（curl）で、
 * 配備先の秘密の名前の一覧には wrangler CLI（契約 `listDeploymentSecretNames` の source）で触る。
 * ここでは PATH の先頭に置いた偽の `curl`・`npx` が外の世界を演じ、配備ごとの応答と秘密の名前の一覧を
 * 入力として与える。観測するのは、検査の終了状態・出力に挙がる配備と項目・偽物が受けた呼び出しの記録の 3 つ。
 * 本番には一切届かない（偽物が受けた URL をそのまま記録するだけ）。
 *
 * 出力の文言は照合しない（運用者が読む形で契約の語彙に無い）。問題として挙がったかは、
 * 全部そろった入力の出力との差分（増えた行）に、その配備・項目の名前が現れるかで見る。
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const CHECK = join(ROOT, 'scripts', 'check_sso_prod.sh')
const execFileAsync = promisify(execFile)

/** 秘密の値の番兵。環境変数と「値を読む」呼び出しの両方がこの値を返し、検査の出力に現れたら値が漏れている。 */
const SECRET_VALUE = 'STUB_SECRET_VALUE_7f3a9c1e_DO_NOT_PRINT'

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
/** 配備ごとに必要な秘密の名前（まなびばは共有秘密、学びは共有秘密とトークンの署名の秘密。用語集） */
const SHARED_SECRET = 'SSO_SECRET'
const SIGNING_SECRET = 'JWT_SECRET'

type HttpRule = { method?: string; url: string; status?: number; exit?: number; body?: string }
type SecretRule = { project: string; exit?: number; names?: string[] }
/** whoami の出方。table は accounts の行を並べた表、notLoggedIn はログインしていない旨、noTable はアカウントの表が無い出力。 */
type Whoami = { mode: 'table'; accounts: string[] } | { mode: 'notLoggedIn' } | { mode: 'noTable' }
type Scenario = { http?: HttpRule[]; secrets?: SecretRule[]; secretsExit?: number; account?: string; whoami?: Whoami; version?: string }
type Run = { code: number; out: string; lines: string[]; log: string[] }

const CURL_STUB = `#!/usr/bin/env bash
# 偽の curl。引数から method・URL・送る本文・出力の形（-w は状態コード、-D - はヘッダ、-o は本文を捨てる）を読み、
# シナリオの規則（method<TAB>URL か URL 前置き*<TAB>status<TAB>exit<TAB>body）に無い URL は既定の応答を返す。
method=GET; url=""; want_status=0; want_headers=0; discard_body=0; has_data=0; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -d|--data|--data-raw|--data-binary|--json) has_data=1; data="$2"; shift ;;
    -w) want_status=1; shift ;;
    -D) want_headers=1; shift ;;
    -o|--output) discard_body=1; shift ;;
    -A|-H|--user-agent|--header|-m|--max-time|--connect-timeout) shift ;;
    -I|--head) method=HEAD; want_headers=1 ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done
printf '%s %s data=%s body=%s\\n' "$method" "$url" "$has_data" "$data" >> "$STUB_LOG"
status=""; code=0; body=""
while IFS=$'\\t' read -r m pat st ex bd; do
  [ -n "$m" ] || continue
  [ "$m" = '*' ] || [ "$m" = "$method" ] || continue
  case "$pat" in
    *"*") prefix="\${pat%?}"; [ "\${url#"$prefix"}" != "$url" ] || continue ;;
    *) [ "$url" = "$pat" ] || continue ;;
  esac
  status="$st"; code="$ex"; body="$bd"; break
done < "$STUB_SCENARIO/http.rules"
if [ -z "$status" ]; then
  rest="\${url#*://}"
  case "$rest" in */*) path="/\${rest#*/}" ;; *) path="/" ;; esac
  case "$method $path" in
    "GET /api/health") status=200; body='{"ok":true}' ;;
    "GET /api/auth/config") status=200; body='{"sso":true,"portal":"'"$STUB_PORTAL_URL"'","app":"learning"}' ;;
    "POST /api/auth/login"|"POST /api/auth/register") status=404; body='{"error":"この学びはまなびばからログインします"}' ;;
    *) status=200; body='<!doctype html><title>entry</title>' ;;
  esac
fi
if [ "$code" != 0 ]; then
  [ "$want_status" = 1 ] && printf '000'
  exit "$code"
fi
if [ "$want_headers" = 1 ]; then
  printf 'HTTP/2 %s\\r\\n' "$status"
  printf 'content-security-policy: default-src %s\\r\\n' "'self'"
  printf 'strict-transport-security: max-age=31536000; includeSubDomains\\r\\n'
  printf 'x-frame-options: DENY\\r\\n'
  printf 'x-content-type-options: nosniff\\r\\n'
  printf 'referrer-policy: strict-origin-when-cross-origin\\r\\n'
  printf 'x-version: %s\\r\\n\\r\\n' "\${STUB_VERSION:-v1}"
fi
if [ "$want_status" = 1 ]; then printf '%s' "$status"; elif [ "$discard_body" = 0 ]; then printf '%s' "$body"; fi
`

const NPX_STUB = `#!/usr/bin/env bash
# 偽の npx（wrangler）。whoami はログイン中のアカウント、pages secret list は配備の秘密の名前の一覧を返す。
# それ以外の呼び出し（値を読む類）は、検知のために秘密の値の番兵を返す。
printf 'npx %s\\n' "$*" >> "$STUB_LOG"
[ "$1" = wrangler ] || { echo "stub: npx $1 は想定外" >&2; exit 1; }
shift
if [ "$1" = whoami ]; then
  printf ' ⛅️ wrangler 4.0.0\\nGetting User settings...\\n'
  case "$STUB_WHOAMI_MODE" in
    notLoggedIn) printf 'You are not authenticated. Please run wrangler login.\\n'; exit 0 ;;
    noTable) printf '👋 You are logged in with an OAuth Token.\\n'; exit 0 ;;
  esac
  printf '👋 You are logged in with an OAuth Token.\\n'
  printf '┌──────────────┬──────────────────────────────────┐\\n│ Account Name │ Account ID                       │\\n'
  n=0
  for a in $STUB_ACCOUNTS; do n=$((n+1)); printf '│ Account %s    │ %s │\\n' "$n" "$a"; done
  printf '└──────────────┴──────────────────────────────────┘\\n'
  exit 0
fi
if [ "$1 $2 $3" = "pages secret list" ]; then
  project=""
  while [ $# -gt 0 ]; do [ "$1" = --project-name ] && project="$2"; shift; done
  names="$STUB_DEFAULT_NAMES"; code="\${STUB_SECRETS_EXIT:-0}"
  while IFS=$'\\t' read -r p ex ns; do
    [ "$p" = "$project" ] && { code="$ex"; names="$ns"; break; }
  done < "$STUB_SCENARIO/secrets.rules"
  if [ "$code" != 0 ]; then
    echo "✘ [ERROR] A request to the Cloudflare API failed. Could not route to /pages/projects/$project [code: 7003]" >&2
    exit "$code"
  fi
  printf ' ⛅️ wrangler 4.0.0\\n'
  for n in $names; do printf '%s: Value Encrypted\\n' "$n"; done
  exit 0
fi
printf '%s\\n' "$SECRET_VALUE_SENTINEL"
exit 0
`

/** 偽の curl・npx を置いた bin と、シナリオの規則ファイルを作って検査を 1 回回す。 */
const runCheck = async (name: string, scenario: Scenario): Promise<Run> => {
  const dir = mkdtempSync(join(tmpdir(), `uc015-${name}-`))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), CURL_STUB)
  writeFileSync(join(bin, 'npx'), NPX_STUB)
  chmodSync(join(bin, 'curl'), 0o755)
  chmodSync(join(bin, 'npx'), 0o755)
  const http = (scenario.http ?? []).map((r) => [r.method ?? '*', r.url, String(r.status ?? 200), String(r.exit ?? 0), r.body ?? ''].join('\t')).join('\n')
  const secrets = (scenario.secrets ?? []).map((r) => [r.project, String(r.exit ?? 0), (r.names ?? []).join(' ')].join('\t')).join('\n')
  writeFileSync(join(dir, 'http.rules'), http + '\n')
  writeFileSync(join(dir, 'secrets.rules'), secrets + '\n')
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    STUB_SCENARIO: dir,
    STUB_LOG: log,
    STUB_ACCOUNTS: (scenario.whoami?.mode === 'table' ? scenario.whoami.accounts : [scenario.account ?? ACCOUNT]).join(' '),
    STUB_WHOAMI_MODE: scenario.whoami?.mode ?? 'table',
    STUB_SECRETS_EXIT: String(scenario.secretsExit ?? 0),
    STUB_DEFAULT_NAMES: `${SHARED_SECRET} ${SIGNING_SECRET}`,
    STUB_PORTAL_URL: PORTAL.url,
    STUB_VERSION: scenario.version ?? 'v1',
    SECRET_VALUE_SENTINEL: SECRET_VALUE,
    SSO_SECRET: SECRET_VALUE,
    JWT_SECRET: SECRET_VALUE,
  }
  let code = 0
  let out = ''
  try {
    const r = await execFileAsync('bash', [CHECK], { cwd: ROOT, env, maxBuffer: 1 << 24 })
    out = r.stdout + r.stderr
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    code = typeof e.code === 'number' ? e.code : 1
    out = (e.stdout ?? '') + (e.stderr ?? '')
  }
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.length > 0)
  return { code, out, lines, log: calls }
}

/** 契約 openDeploymentEntry の成功の例が配備ごとに挙げる入口の経路（まなびばは path の enum の全部、学びは /）。 */
const ENTRY_PATHS = { portal: ['/', '/app.js', '/style.css'], learning: ['/'] }

/** 偽物が受けた呼び出しの 1 行を、その配備の項目（契約の operation の名前）に読み替える。その配備の呼び出しでなければ null。 */
const operationOf = (line: string, d: Deployment): string | null => {
  if (line.startsWith('npx ')) {
    return line.startsWith('npx wrangler pages secret list') && line.includes(`--project-name ${d.project}`) ? 'listDeploymentSecretNames' : null
  }
  const [method, url] = line.split(' ')
  if (!url || !url.startsWith(`${d.url}/`)) return null
  const path = url.slice(d.url.length)
  if (method === 'GET' && path === '/api/health') return 'checkDeploymentHealth'
  if (method === 'GET' && path === '/api/auth/config') return 'getAuthConfig'
  if (method === 'POST' && /^\/api\/auth\/(login|register)$/.test(path)) return 'probeRetiredPasswordRoute'
  if (method === 'GET' && !path.startsWith('/api/')) return 'openDeploymentEntry'
  return `契約に無い呼び出し:${line}`
}
const OPERATION_NAMES = ['checkDeploymentHealth', 'openDeploymentEntry', 'probeRetiredPasswordRoute', 'listDeploymentSecretNames', 'getAuthConfig']

const IP = byKey('ip')
const ITC = byKey('itc')
const HEAD = LEARNINGS[0]
const TAIL = LEARNINGS[LEARNINGS.length - 1]

/** 各テストが見る入力。全部そろった入力（pass）との差分で問題の行を取り出すので、pass は必ず含める。 */
const SCENARIOS: Record<string, Scenario> = {
  pass: {},
  portalHealthBodyFalse: { http: [{ url: `${PORTAL.url}/api/health`, status: 200, body: '{"ok":false}' }] },
  ipHealthBodyNotMark: { http: [{ url: `${IP.url}/api/health`, status: 200, body: '<!doctype html><title>maintenance</title>' }] },
  ipDead: { http: [{ url: `${IP.url}*`, exit: 7 }] },
  headDead: { http: [{ url: `${HEAD.url}*`, exit: 7 }] },
  tailDead: { http: [{ url: `${TAIL.url}*`, exit: 7 }] },
  ipHealthOnlyDead: { http: [{ url: `${IP.url}/api/health`, exit: 7 }] },
  portalAppJs500: { http: [{ url: `${PORTAL.url}/app.js`, status: 500 }] },
  headEntryUnreachable: { http: [{ method: 'GET', url: `${HEAD.url}/`, exit: 7 }] },
  ipEntry404: { http: [{ url: `${IP.url}/`, status: 404 }] },
  twoProblems: { http: [{ url: `${IP.url}/`, status: 404 }], secrets: [{ project: PORTAL.project, names: [] }] },
  ipSigningMissing: { secrets: [{ project: IP.project, names: [SHARED_SECRET] }] },
  itcEmpty: { secrets: [{ project: ITC.project, names: [] }] },
  portalSharedMissing: { secrets: [{ project: PORTAL.project, names: [] }] },
  ipExtraName: { secrets: [{ project: IP.project, names: [SHARED_SECRET, SIGNING_SECRET, 'EXTRA_NAME_NOT_REQUIRED'] }] },
  wrongAccount: { account: 'ffffffffffffffffffffffffffffffff' },
  ipListUnavailable: { secrets: [{ project: IP.project, exit: 1 }] },
  wrongAccountAndUnavailable: { account: 'ffffffffffffffffffffffffffffffff', secrets: [{ project: IP.project, exit: 1 }] },
  versionOld: { version: 'old', secrets: [{ project: IP.project, names: [SHARED_SECRET] }] },
  versionNew: { version: 'new', secrets: [{ project: IP.project, names: [SHARED_SECRET] }] },
  notLoggedIn: { whoami: { mode: 'notLoggedIn' }, secretsExit: 1 },
  accountNotShown: { whoami: { mode: 'noTable' }, secretsExit: 1 },
  ownerAmongAccounts: { whoami: { mode: 'table', accounts: ['ffffffffffffffffffffffffffffffff', ACCOUNT] } },
  retiredRoutesOpen: {
    http: [
      { method: 'POST', url: `${IP.url}/api/auth/register`, status: 400, body: '{"error":"入力が正しくありません"}' },
      { method: 'POST', url: `${TAIL.url}/api/auth/login`, exit: 7 },
    ],
  },
}

const runs = new Map<string, Run>()
const run = (name: keyof typeof SCENARIOS): Run => {
  const r = runs.get(name)
  if (!r) throw new Error(`${name} の実行結果が無い`)
  return r
}
/** 全部そろった入力の出力に無い行＝その入力で問題として挙がった行（と、途中で止まって欠けた行の変わり）。 */
const raised = (name: keyof typeof SCENARIOS): string[] => {
  const pass = new Set(run('pass').lines)
  return run(name).lines.filter((l) => !pass.has(l))
}
/** 全部そろった入力にはあって、その入力では出なくなった行。 */
const dropped = (name: keyof typeof SCENARIOS): string[] => {
  const fail = new Set(run(name).lines)
  return run('pass').lines.filter((l) => !fail.has(l))
}
const mentions = (lines: string[], d: Deployment) => lines.some((l) => d.label.test(l))
const got = (r: Run, method: string, url: string) => r.log.some((l) => l.startsWith(`${method} ${url} `))
const listedSecrets = (r: Run, d: Deployment) => r.log.some((l) => l.startsWith('npx wrangler pages secret list') && l.includes(`--project-name ${d.project}`))

beforeAll(async () => {
  expect(LEARNINGS.length, '登録簿から学びの配備が導けていない').toBeGreaterThanOrEqual(2)
  const entries = await Promise.all(Object.entries(SCENARIOS).map(async ([name, scenario]) => [name, await runCheck(name, scenario)] as const))
  for (const [name, r] of entries) runs.set(name, r)
}, 480_000)

describe('UC-015 本番の検査（偽の配備先に対して scripts/check_sso_prod.sh を回す）', () => {
  describe('REQ-213 死活確認を認証なしで叩く', () => {
    // @covers REQ-213#every-deployment-visited
    it('登録簿のまなびばと全ての学びについて、死活確認を叩いている（1 つも抜けない）', () => {
      const r = run('pass')
      for (const d of ALL) expect(got(r, 'GET', `${d.url}/api/health`), `${d.key} の死活確認を叩いていない`).toBe(true)
      const visited = new Set(r.log.filter((l) => l.startsWith('GET ') && l.includes('/api/health ')).map((l) => l.split(' ')[1]))
      expect([...visited].sort()).toEqual(ALL.map((d) => `${d.url}/api/health`).sort())
    })
  })

  describe('REQ-214 入口の画面を認証なしで外から開く', () => {
    // @covers REQ-214#portal-entry-opens
    it('まなびばの入口（/）を開き、200 なら問題にせず全体が通る', () => {
      const r = run('pass')
      expect(got(r, 'GET', `${PORTAL.url}/`), 'まなびばの / を開いていない').toBe(true)
      expect(r.code).toBe(0)
      expect(mentions(raised('pass'), PORTAL)).toBe(false)
    })

    // @covers REQ-214#learning-entry-opens
    it('各学びの入口（/）を開き、200 なら問題にせず全体が通る', () => {
      const r = run('pass')
      for (const d of LEARNINGS) expect(got(r, 'GET', `${d.url}/`), `${d.key} の / を開いていない`).toBe(true)
      expect(r.code).toBe(0)
    })

    // @covers REQ-214#every-entry-path-visited
    it('配備ごとに開く入口の経路の集合が、契約 openDeploymentEntry の成功の例の集合と等しい（抜けも余りも無い）', () => {
      const r = run('pass')
      const opened = (d: Deployment) => [
        ...new Set(
          r.log
            .filter((l) => l.startsWith(`GET ${d.url}/`) && !l.includes('/api/'))
            .map((l) => l.split(' ')[1].slice(d.url.length)),
        ),
      ].sort()
      expect(opened(PORTAL), 'まなびばの入口の経路').toEqual([...ENTRY_PATHS.portal].sort())
      for (const d of LEARNINGS) expect(opened(d), `${d.key} の入口の経路`).toEqual([...ENTRY_PATHS.learning].sort())
    })
  })

  describe('REQ-215 秘密の名前の一覧を確かめる（値は読まない・出さない）', () => {
    // @covers REQ-215#names-complete
    it('必要な名前がすべて一覧にある配備は問題にならず、全体が通る', () => {
      const r = run('pass')
      expect(r.code).toBe(0)
      for (const d of ALL) expect(listedSecrets(r, d), `${d.key} の秘密の名前の一覧を取っていない`).toBe(true)
      expect(raised('pass')).toEqual([])
    })

    // @covers REQ-215#names-only
    it('配備先への呼び出しは、ログイン中のアカウントの確認と名前の一覧だけ（値を取る呼び出しをしない）', () => {
      const wrangler = run('pass').log.filter((l) => l.startsWith('npx '))
      expect(wrangler.length).toBeGreaterThan(0)
      for (const call of wrangler) expect(call, '名前の一覧の外の呼び出し').toMatch(/^npx wrangler (whoami|pages secret list( |$))/)
    })

    // @covers REQ-215#value-absent-from-result
    it('検査の出力のどこにも秘密の値が現れない（環境にある値も、値を返す呼び出しの戻りも）', () => {
      for (const name of ['pass', 'ipSigningMissing', 'itcEmpty', 'wrongAccount'] as const) {
        expect(run(name).out, `${name} の出力に秘密の値`).not.toContain(SECRET_VALUE)
      }
    })

    // @covers REQ-215#empty-list
    it('一覧が空の配備は、値を読まずに名前の判定だけで足りない側に落ちる', () => {
      const r = run('itcEmpty')
      expect(r.code).not.toBe(0)
      expect(mentions(raised('itcEmpty'), ITC)).toBe(true)
      expect(r.out).not.toContain(SECRET_VALUE)
      expect(r.log.filter((l) => l.startsWith('npx '))).toEqual(expect.arrayContaining([expect.stringMatching(/^npx wrangler pages secret list/)]))
    })

    // @covers REQ-215#required-names-from-one-place
    it('登録簿の配備ごとに秘密の名前の一覧を取りに行き、名前の判定が配備の数だけ行われる（配備を足して定義を足し忘れると落ちる）', () => {
      const r = run('pass')
      const projects = r.log
        .filter((l) => l.startsWith('npx wrangler pages secret list'))
        .map((l) => l.match(/--project-name (\S+)/)?.[1])
      expect([...new Set(projects)].sort()).toEqual(ALL.map((d) => d.project).sort())
    })

    // @covers REQ-215#version-independent
    it('配信の進行中で応える版が違っても、秘密の名前の判定は変わらない（名前は配備に付く）', () => {
      const oldRun = run('versionOld')
      const newRun = run('versionNew')
      expect(oldRun.code).not.toBe(0)
      expect(newRun.code).toBe(oldRun.code)
      expect(mentions(raised('versionOld'), IP)).toBe(true)
      expect(raised('versionNew')).toEqual(raised('versionOld'))
      expect(newRun.log.filter((l) => l.startsWith('npx '))).toEqual(oldRun.log.filter((l) => l.startsWith('npx ')))
    })
  })

  describe('REQ-216 全部そろっていれば全体が通ったことを返す', () => {
    // @covers REQ-216#all-pass-overall-pass
    it('見た全ての配備と項目に足りない物が無ければ、終了状態 0 で、結びの行が失敗のときと違う', () => {
      const pass = run('pass')
      expect(pass.code).toBe(0)
      expect(pass.lines.length).toBeGreaterThan(0)
      expect(pass.lines.at(-1)).not.toBe(run('ipEntry404').lines.at(-1))
    })

    // @covers REQ-216#seen-items-listed
    it('結果に、見た配備ごとに見た項目が operation の名前で現れ、その集合が検査の叩いた operation の集合と等しい', () => {
      const r = run('pass')
      for (const d of ALL) {
        const called = new Set(r.log.map((l) => operationOf(l, d)).filter((x): x is string => x !== null))
        expect(called.size, `${d.key} を 1 つも叩いていない`).toBeGreaterThan(0)
        const lines = r.lines.filter((l) => d.label.test(l))
        const listed = new Set(OPERATION_NAMES.filter((op) => lines.some((l) => l.includes(op))))
        expect([...listed].sort(), `${d.key} の結果に出た項目`).toEqual([...called].sort())
      }
      // 学び側の死活確認と入口の経路を含む
      for (const d of LEARNINGS) {
        const lines = r.lines.filter((l) => d.label.test(l))
        expect(lines.some((l) => l.includes('checkDeploymentHealth')), `${d.key} の死活確認が結果に無い`).toBe(true)
        expect(lines.some((l) => l.includes('openDeploymentEntry')), `${d.key} の入口の経路が結果に無い`).toBe(true)
      }
    })
  })

  describe('REQ-217 死活確認が返らない・期待と違う', () => {
    // @covers REQ-217#no-answer
    it('配備に届かず死活確認が返らないと、その配備を問題として挙げ、全体を失敗にする', () => {
      const r = run('ipDead')
      expect(r.code).not.toBe(0)
      expect(raised('ipDead'), 'ip を名指しした問題の行が無い').toSatisfy((lines: string[]) => mentions(lines, IP))
    })

    // @covers REQ-217#body-not-alive-mark
    it('応答は届くが本文が生きている印でないと、状態コードが 200 でもその配備を問題として挙げる（まなびばも学びも）', () => {
      for (const [name, d] of [['portalHealthBodyFalse', PORTAL], ['ipHealthBodyNotMark', IP]] as const) {
        const r = run(name)
        expect(r.code, `${d.key}: 本文が印でないのに全体が通っている`).not.toBe(0)
        expect(mentions(raised(name), d), `${d.key}: 問題の行に配備の名前が無い`).toBe(true)
      }
    })

    // @covers REQ-217#only-failing-deployment-named
    it('一部の配備だけが通らないとき、問題に挙がるのはその配備だけで、通った配備は挙がらない', () => {
      const lines = raised('ipDead')
      expect(mentions(lines, IP)).toBe(true)
      for (const d of ALL.filter((x) => x.key !== IP.key)) expect(mentions(lines, d), `${d.key} が問題に混ざっている`).toBe(false)
    })
  })

  describe('REQ-218 入口の画面が開けない', () => {
    // @covers REQ-218#path-not-openable
    it('入口を成す経路が 200 を返さないと、問題として挙げ全体を失敗にする', () => {
      const r = run('portalAppJs500')
      expect(r.code).not.toBe(0)
      expect(raised('portalAppJs500').some((l) => l.includes('/app.js'))).toBe(true)
    })

    // @covers REQ-218#deployment-unreachable
    it('入口の経路に届かず状態コードが得られないときも、その配備と経路を問題として挙げる', () => {
      const r = run('headEntryUnreachable')
      expect(r.code).not.toBe(0)
      expect(mentions(raised('headEntryUnreachable'), HEAD), `${HEAD.key} を名指しした問題の行が無い`).toBe(true)
    })

    // @covers REQ-218#deployment-and-path-named
    it('問題の行に、配備と経路の両方が入る', () => {
      const portalLines = raised('portalAppJs500').filter((l) => l.includes('/app.js'))
      expect(portalLines.length).toBeGreaterThan(0)
      expect(mentions(portalLines, PORTAL)).toBe(true)
      const ipLines = raised('ipEntry404').filter((l) => IP.label.test(l))
      expect(ipLines.length).toBeGreaterThan(0)
      expect(ipLines.some((l) => l.includes('/'))).toBe(true)
    })
  })

  describe('REQ-219 問題を見つけても打ち切らない', () => {
    // @covers REQ-219#continue-after-dead-deployment
    it('先頭の配備でも末尾の配備でも、死活確認が通らない配備の後ろの配備と項目を全部見る', () => {
      for (const [name, dead] of [['headDead', HEAD], ['tailDead', TAIL]] as const) {
        const r = run(name)
        for (const d of ALL.filter((x) => x.key !== dead.key)) {
          expect(got(r, 'GET', `${d.url}/api/health`), `${name}: ${d.key} の死活確認を見ていない`).toBe(true)
          expect(got(r, 'GET', `${d.url}/`), `${name}: ${d.key} の入口を見ていない`).toBe(true)
        }
        for (const d of ALL) expect(listedSecrets(r, d), `${name}: ${d.key} の秘密の名前を見ていない`).toBe(true)
      }
    })

    // @covers REQ-219#continue-across-items
    it('1 つの配備の死活確認が通らなくても、その配備の入口の画面と秘密の名前を続けて見る', () => {
      const r = run('ipHealthOnlyDead')
      expect(got(r, 'GET', `${IP.url}/`), 'ip の入口を見ていない').toBe(true)
      expect(listedSecrets(r, IP), 'ip の秘密の名前を見ていない').toBe(true)
    })

    // @covers REQ-219#all-problems-reported
    it('問題が 2 つ以上あるとき、結果にそのすべてが挙がる（最初の 1 つで止まらない）', () => {
      const lines = raised('twoProblems')
      expect(run('twoProblems').code).not.toBe(0)
      expect(mentions(lines, IP), '入口の問題（ip）が挙がっていない').toBe(true)
      expect(lines.some((l) => PORTAL.label.test(l) && l.includes(SHARED_SECRET)), '秘密の問題（まなびば）が挙がっていない').toBe(true)
    })
  })

  describe('REQ-220 問題が 1 つでもあれば全体を失敗にする', () => {
    // @covers REQ-220#one-problem-overall-fail
    it('問題が 1 つだけでも終了状態が 0 でない', () => {
      expect(run('ipEntry404').code).not.toBe(0)
    })

    // @covers REQ-220#problems-listed
    it('失敗の結果に、足りなかった配備と項目の名前がすべて挙がる', () => {
      const lines = raised('twoProblems')
      expect(mentions(lines, IP)).toBe(true)
      expect(mentions(lines, PORTAL)).toBe(true)
      expect(lines.some((l) => l.includes(SHARED_SECRET))).toBe(true)
    })

    // @covers REQ-220#fail-from-any-item-kind
    it('死活確認・入口の画面・秘密の名前のどの項目の問題でも、等しく全体が失敗になる', () => {
      for (const name of ['portalHealthBodyFalse', 'portalAppJs500', 'ipSigningMissing'] as const) {
        expect(run(name).code, `${name} で全体が通っている`).not.toBe(0)
      }
    })

    // @covers REQ-220#no-state-change
    it('検査は読むだけで、配備の状態を変える要求を出さない（HTTP は GET と契約が挙げるパスワードの経路の閉鎖の確認だけ、CLI は一覧だけ）', () => {
      for (const name of ['pass', 'twoProblems'] as const) {
        const r = run(name)
        for (const call of r.log) {
          if (call.startsWith('npx ')) {
            expect(call, `${name}: 読むだけでない CLI の呼び出し`).toMatch(/^npx wrangler (whoami|pages secret list( |$))/)
            continue
          }
          const [method, url] = call.split(' ')
          const allowed = method === 'GET' || (method === 'POST' && /\/api\/auth\/(login|register)$/.test(url))
          expect(allowed, `${name}: 状態を変えうる要求 ${call}`).toBe(true)
        }
      }
    })
  })

  describe('REQ-221 必要な秘密の名前が一覧に無い', () => {
    // @covers REQ-221#one-name-missing
    it('必要な名前のうち 1 つだけ無い配備を、その名前を挙げて問題にし、全体を失敗にする', () => {
      const r = run('ipSigningMissing')
      expect(r.code).not.toBe(0)
      expect(raised('ipSigningMissing').some((l) => IP.label.test(l) && l.includes(SIGNING_SECRET))).toBe(true)
    })

    // @covers REQ-221#all-names-missing
    it('必要な名前が 1 つも無い配備では、必要な名前のすべてが挙がる', () => {
      const lines = raised('itcEmpty').filter((l) => ITC.label.test(l))
      expect(lines.some((l) => l.includes(SHARED_SECRET)), `${SHARED_SECRET} が挙がっていない`).toBe(true)
      expect(lines.some((l) => l.includes(SIGNING_SECRET)), `${SIGNING_SECRET} が挙がっていない`).toBe(true)
    })

    // @covers REQ-221#deployment-and-name-named
    it('問題の行に、配備と欠けている秘密の名前の両方が入る', () => {
      expect(raised('portalSharedMissing').some((l) => PORTAL.label.test(l) && l.includes(SHARED_SECRET))).toBe(true)
    })

    // @covers REQ-221#no-value-in-problem
    it('欠けている名前を挙げるとき、その配備にある他の秘密の値を出さない', () => {
      const r = run('ipSigningMissing')
      expect(r.code).not.toBe(0)
      expect(r.out).not.toContain(SECRET_VALUE)
    })

    // @covers REQ-221#extra-names-ignored
    it('必要な名前に無い名前が一覧に余分にあっても問題にしない', () => {
      const r = run('ipExtraName')
      expect(r.code).toBe(0)
      expect(raised('ipExtraName')).toEqual([])
    })
  })

  describe('REQ-222 秘密の名前の一覧を取れない', () => {
    // @covers REQ-222#forbidden-wrong-account
    it('ログイン中のアカウントが配備を持つアカウントと違うと、取れなかった配備を名指しして問題にし、全体を失敗にする', () => {
      const r = run('wrongAccount')
      expect(r.code).not.toBe(0)
      const lines = raised('wrongAccount')
      expect(lines.length).toBeGreaterThan(0)
      for (const d of ALL) expect(mentions(lines, d), `${d.key} が取れなかった配備として挙がっていない`).toBe(true)
    })

    // @covers REQ-222#list-unavailable
    it('一覧の取得そのものが失敗すると、その配備を問題として挙げ、全体を失敗にする', () => {
      const r = run('ipListUnavailable')
      expect(r.code).not.toBe(0)
      expect(mentions(raised('ipListUnavailable'), IP)).toBe(true)
    })

    // @covers REQ-222#account-unknown-not-forbidden
    it('ログインしていない・ログイン中のアカウントが分からないときは、アカウント違いに挙げず、一覧の取得を試みて取得の失敗の側に挙げる', () => {
      for (const name of ['notLoggedIn', 'accountNotShown'] as const) {
        const r = run(name)
        expect(r.code, `${name}: 一覧が取れないのに全体が通っている`).not.toBe(0)
        for (const d of ALL) {
          expect(listedSecrets(r, d), `${name}: ${d.key} の一覧の取得を試みていない（アカウント違いに倒している）`).toBe(true)
          expect(mentions(raised(name), d), `${name}: ${d.key} が取れなかった配備として挙がっていない`).toBe(true)
        }
        expect(raised(name), `${name}: アカウント違いと同じ問題の挙げ方になっている`).not.toEqual(raised('wrongAccount'))
      }
    })

    // @covers REQ-222#any-logged-in-account-owns
    it('複数のアカウントにログインしていてそのうち 1 つが配備を持つときは、アカウント違いに挙げず一覧を取りに行く', () => {
      const r = run('ownerAmongAccounts')
      for (const d of ALL) expect(listedSecrets(r, d), `${d.key} の一覧を取りに行っていない`).toBe(true)
      expect(raised('ownerAmongAccounts')).toEqual([])
      expect(r.code).toBe(0)
    })

    // @covers REQ-222#forbidden-precedes-unavailable
    it('別のアカウントでログインしていて取得も失敗しうる入力では、挙がる理由はアカウントの側（取得の失敗は挙がらない）', () => {
      expect(run('wrongAccountAndUnavailable').code).not.toBe(0)
      expect(raised('wrongAccountAndUnavailable')).toEqual(raised('wrongAccount'))
    })

    // @covers REQ-222#not-judged-complete
    it('一覧が取れなかった配備を「そろっている」とは判定せず、そろったときに出ていたその配備の確認が消える', () => {
      const r = run('ipListUnavailable')
      expect(r.code).not.toBe(0)
      expect(mentions(dropped('ipListUnavailable'), IP), 'ip の確認が、取れないのに出たまま').toBe(true)
    })
  })

  describe('REQ-350 学び側のパスワードでのログインと登録の経路が閉じているか', () => {
    const PROBE_ROUTES = ['login', 'register'] as const
    const probed = (r: Run, d: Deployment, route: string) => got(r, 'POST', `${d.url}/api/auth/${route}`)

    // @covers REQ-350#retired-routes-closed-pass
    it('どの学びでもログインと登録の経路が受け持たない経路として断られれば、問題に挙げない', () => {
      const r = run('pass')
      for (const d of LEARNINGS) for (const route of PROBE_ROUTES) expect(probed(r, d, route), `${d.key} の ${route} を叩いていない`).toBe(true)
      expect(r.code).toBe(0)
      expect(raised('pass')).toEqual([])
    })

    // @covers REQ-350#retired-route-open-raised
    it('どちらかの経路が受け持たない経路の断り以外を返す・届かないとき、その配備とその経路を問題に挙げ全体を失敗にする', () => {
      // ip の登録は 400（開いている）、末尾の学びのログインは届かない
      expect(IP.key, '仕込み: ip と末尾の学びが同じ').not.toBe(TAIL.key)
      const r = run('retiredRoutesOpen')
      expect(r.code, '経路が開いているのに全体が通っている').not.toBe(0)
      const lines = raised('retiredRoutesOpen')
      for (const [d, route] of [[IP, 'register'], [TAIL, 'login']] as const) {
        expect(lines.filter((l) => d.label.test(l)).some((l) => l.includes(route)), `${d.key} の ${route} を名指しした問題の行が無い`).toBe(true)
      }
      for (const other of LEARNINGS.filter((x) => x.key !== IP.key && x.key !== TAIL.key)) {
        expect(mentions(lines, other), `開いていない ${other.key} が問題に混ざっている`).toBe(false)
      }
    })

    // @covers REQ-350#no-state-changing-probe
    it('確かめの要求は決められた形を満たさない空の本文（{}）だけを送り、まなびばには送らない', () => {
      for (const name of ['pass', 'retiredRoutesOpen'] as const) {
        const posted = run(name).log.filter((l) => l.startsWith('POST '))
        expect(posted.length, `${name}: 確かめの要求を送っていない`).toBeGreaterThan(0)
        for (const call of posted) {
          const [, url] = call.split(' ')
          expect(url, `${name}: パスワードの経路以外への POST ${call}`).toMatch(/\/api\/auth\/(login|register)$/)
          expect(url.startsWith(`${PORTAL.url}/`), `${name}: まなびばに送っている ${call}`).toBe(false)
          const body = call.match(/ body=(.*)$/)?.[1] ?? ''
          const sent = (() => {
            try {
              return JSON.parse(body) as unknown
            } catch {
              return body
            }
          })()
          expect(sent, `${name}: 空のオブジェクトでない本文 ${call}`).toEqual({})
        }
      }
    })
  })
})
