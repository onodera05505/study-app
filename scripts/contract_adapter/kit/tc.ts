/**
 * 画面の手元の保存（`local-store` の操作）を実例ごとに回す部品。
 *
 * 入口は CLAUDE.md の「操作 → 入口（R-1204）」の `local-store` の行（`src/client/lib/` の export。`read…` は `get…`、
 * `save…` は `set…` に読み替え）と「規則に従わない入口」（markSessionExpired は `api`）。
 *
 * - deviceWorld(): 端末の記憶の代わり（localStorage・sessionStorage）を実例ごとに新しく作って置き、画面の部品を
 *   読み直す（モジュールの中に残る状態をほかの実例と共有しない）。アダプターは node の 1 プロセスで回るので、
 *   これを使う受け持ちは順に 1 件ずつ回す（parallel にしない）。
 * - 端末の記憶が使えない前提は、代わりの記憶の読み・書き・消すが例外を投げることで作る（鍵の名前に頼らない）。
 * - 覚えた値が読めない前提は、覚えた値を持つ鍵を値で探して壊れた値に置き換える（鍵の名前は仕様ではない）。
 * - 断りは投げられた値の `code` で読む。名前を持たずに投げたときは Unanswerable にする（土台が失敗で終える）。
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Unanswerable, type Answer } from './protocol'

type ApiModule = typeof import('../../../src/client/lib/api')
type LastPageModule = typeof import('../../../src/client/lib/lastPage')
type FeedbackDraftModule = typeof import('../../../src/client/lib/feedbackDraft')

const CLIENT_LIB = join(import.meta.dirname, '..', '..', '..', 'src', 'client', 'lib')

/** 端末の記憶の代わり。blocked の読み・書きは例外を投げる（端末の記憶が使えない）。
 *  実装（src/client/lib）が呼ぶ読み・書き・消す（getItem・setItem・removeItem）だけを持つ。length・key・clear は実装が呼ばないので置かない。 */
class MemoryStorage {
  #items = new Map<string, string>()
  readBlocked = false
  writeBlocked = false

  #refuseRead() {
    if (this.readBlocked) throw new Error('端末の記憶が使えない（前提: 読めない）')
  }
  #refuseWrite() {
    if (this.writeBlocked) throw new Error('端末の記憶が使えない（前提: 書けない）')
  }
  getItem(key: string): string | null {
    this.#refuseRead()
    return this.#items.has(key) ? this.#items.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.#refuseWrite()
    this.#items.set(String(key), String(value))
  }
  removeItem(key: string): void {
    this.#refuseWrite()
    this.#items.delete(key)
  }
  /** 前提を作る側だけが使う（塞いでいても見える）。 */
  entries(): [string, string][] {
    return [...this.#items.entries()]
  }
  /** 前提を作る側だけが使う（塞いでいても書ける）。 */
  put(key: string, value: string): void {
    this.#items.set(key, value)
  }
}

export type DeviceWorld = {
  api: ApiModule
  lastPage: LastPageModule
  feedbackDraft: FeedbackDraftModule
  /** 端末の記憶の読み（blockReads）・書き（blockWrites）を使えなくする。 */
  blockReads: () => void
  blockWrites: () => void
  /** needle を含む値を持つ鍵を探し、壊れた値に置き換える。見つからなければ Unanswerable。 */
  corrupt: (needle: string) => void
}

let generation = 0

function install(name: 'localStorage' | 'sessionStorage', storage: MemoryStorage): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: storage })
}

async function fresh<T>(file: string): Promise<T> {
  return (await import(`${pathToFileURL(join(CLIENT_LIB, file)).href}?tc=${generation}`)) as T
}

/**
 * 端末の記憶の代わりを新しく置き、画面の部品を読み直す。
 * @implements REQ-570
 */
export async function deviceWorld(): Promise<DeviceWorld> {
  generation += 1
  const local = new MemoryStorage()
  const session = new MemoryStorage()
  install('localStorage', local)
  install('sessionStorage', session)
  const stores = [local, session]
  return {
    api: await fresh<ApiModule>('api.ts'),
    lastPage: await fresh<LastPageModule>('lastPage.ts'),
    feedbackDraft: await fresh<FeedbackDraftModule>('feedbackDraft.ts'),
    blockReads: () => stores.forEach((s) => (s.readBlocked = true)),
    blockWrites: () => stores.forEach((s) => (s.writeBlocked = true)),
    corrupt: (needle) => {
      for (const store of stores) {
        const hit = store.entries().find(([, value]) => value.includes(needle))
        if (hit) return store.put(hit[0], '{壊れた値')
      }
      throw new Unanswerable(`前提の覚えた値（${needle} を含む）が端末の記憶に無い`)
    },
  }
}

/**
 * 操作を呼び、返した物を答えにする。投げた値が `code` を持てばその名前の断り、持たなければ Unanswerable。
 * @implements REQ-568
 */
export async function answerFrom(run: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<Answer> {
  try {
    return { response: await run() }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === 'string' && code !== '') return { error: code }
    throw new Unanswerable(`名前を持たない失敗: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---- 本番の確かめ（UC-015）を偽の配備先に向けて回す部品 ----

/**
 * 偽の curl（bash。呼び出しが多いので起動の軽い bash で書く）。引数から method・URL・出力の形（-w の状態コード、-D のヘッダ、
 * -o の本文の行き先、-i・-I）を読み、規則（http.rules: method<TAB>URL<TAB>status<TAB>exit<TAB>ヘッダのファイル。空の欄は「-」。
 * タブは read の区切りで続くと 1 つに畳まれるので、欄を空にしない）に合う応答を返す。
 * 規則に無い URL は全部そろった応答（死活確認は生きている印、認証の形は SSO の設定、パスワードの経路は 404、ほかは 200）。
 */
const FAKE_CURL = String.raw`method=""; url=""; write_out=""; dump=""; output=""; include=0; head=0; has_data=0
while [ $# -gt 0 ]; do
  case "$1" in
    -X|--request) method="$2"; shift ;;
    -d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form) has_data=1; shift ;;
    -w|--write-out) write_out="$2"; shift ;;
    -D|--dump-header) dump="$2"; shift ;;
    -o|--output) output="$2"; shift ;;
    -A|-H|-m|-u|-e|-b|-c|-x|-r|-T|-K|-E|--user-agent|--header|--max-time|--connect-timeout|--retry|--retry-delay|--retry-max-time|--user|--referer|--cookie|--cookie-jar|--proxy|--config|--resolve|--connect-to|--max-redirs) shift ;;
    --url) url="$2"; shift ;;
    -i|--include) include=1 ;;
    -I|--head) head=1 ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done
[ -n "$method" ] || { if [ "$head" = 1 ]; then method=HEAD; elif [ "$has_data" = 1 ]; then method=POST; else method=GET; fi; }
norm="@{url%%\?*}"; while [ "@{norm%/}" != "$norm" ]; do norm="@{norm%/}"; done
status=""; code=0; hfile="$TC_FAKE_HEADERS"
while IFS=$'\t' read -r m u st ex hf; do
  [ -n "$u" ] || continue
  [ "$m" = '*' ] || [ "$m" = "$method" ] || continue
  [ "$u" = "$norm" ] || continue
  [ "$st" = - ] || status="$st"; code="$ex"; [ "$hf" = - ] || hfile="$hf"; break
done < "$TC_FAKE_RULES"
rest="@{url#*://}"
case "$rest" in */*) path="/@{rest#*/}" ;; *) path="/" ;; esac
path="@{path%%\?*}"
body='<!doctype html><title>entry</title>'; dstatus=200; ctype='text/html'
case "$method $path" in
  "GET /api/health"|"HEAD /api/health") body='{"ok":true}'; ctype='application/json' ;;
  "GET /api/auth/config") body='{"sso":true,"portal":"'"$TC_FAKE_PORTAL_URL"'","app":"learning"}'; ctype='application/json' ;;
  "POST /api/auth/login"|"POST /api/auth/register") dstatus=404; body='{"error":"この学びはまなびばからログインします"}'; ctype='application/json' ;;
esac
[ -n "$status" ] || status="$dstatus"
# 届いた要求と返した物の記録（method・URL・状態・終了の状態・ヘッダのファイル・content-type・本文。タブ区切り）
printf 'http\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$method" "$norm" "$status" "$code" "$hfile" "$ctype" "$body" >> "$TC_FAKE_LOG"
CR=$'\r'; NL=$'\n'
wo_code="$status"; [ "$code" != 0 ] && wo_code=000
wo="$write_out"; wo="@{wo//\\n/$NL}"; wo="@{wo//%\{http_code\}/$wo_code}"; wo="@{wo//%\{response_code\}/$wo_code}"
if [ "$code" != 0 ]; then
  [ -n "$write_out" ] && printf '%s' "$wo"
  echo "curl: ($code) Failed to connect" >&2
  exit "$code"
fi
block="HTTP/2 $status$CR@{NL}content-type: $ctype$CR$NL"
while IFS= read -r line; do [ -n "$line" ] && block+="$line$CR$NL"; done < "$hfile"
block+="$CR$NL"
out=""
if [ -n "$dump" ]; then if [ "$dump" = - ]; then out+="$block"; else printf '%s' "$block" > "$dump"; fi; fi
if { [ "$include" = 1 ] || [ "$head" = 1 ]; } && [ "$dump" != - ]; then out+="$block"; fi
if [ "$head" = 0 ]; then
  if [ -n "$output" ] && [ "$output" != - ]; then printf '%s' "$body" > "$output"; else out+="$body"; fi
fi
[ -n "$write_out" ] && out+="$wo"
printf '%s' "$out"
`.replaceAll('@{', '$' + '{')

/**
 * 偽の wrangler（npx wrangler も同じ）。配備先のアカウントの代わり。
 * - whoami: TC_FAKE_ACCOUNT が空ならログインしていない（アカウントの表を出さない）。空でなければその ID のアカウントでログイン中。
 * - pages secret list: 規則（secret.rules: プロジェクト名<TAB>終了の状態<TAB>空白区切りの名前。名前が無いときは「-」）に合う
 *   プロジェクトはその規則、ほかは TC_FAKE_LIST_EXIT（0 なら TC_FAKE_SECRET_NAMES の一覧）で答える。
 * 受けた要求と返した物は TC_FAKE_LOG に「wrangler<TAB>コマンド<TAB>プロジェクト名<TAB>終了の状態<TAB>名前」で残す。
 */
const FAKE_WRANGLER = String.raw`[ "$1" = wrangler ] && shift
case "$1" in wrangler@*) shift ;; esac
NL=$'\n'
if [ "$1" = whoami ]; then
  printf 'wrangler\twhoami\t-\t0\t\n' >> "$TC_FAKE_LOG"
  out=" ⛅️ wrangler 4.0.0@NL@Getting User settings...@NL@"
  if [ -z "$TC_FAKE_ACCOUNT" ]; then
    out+="You are not authenticated. Please run 'wrangler login'.@NL@"
    printf '%s' "$out"
    exit 0
  fi
  out+="👋 You are logged in with an OAuth Token.@NL@"
  out+="┌──────────────┬──────────────────────────────────┐@NL@│ Account Name │ Account ID                       │@NL@"
  out+="│ Account 1    │ $TC_FAKE_ACCOUNT │@NL@└──────────────┴──────────────────────────────────┘@NL@"
  printf '%s' "$out"
  exit 0
fi
if [ "$1 $2 $3" = "pages secret list" ]; then
  project=""; prev=""
  for a in "$@"; do
    [ "$prev" = --project-name ] && project="$a"
    case "$a" in --project-name=*) project="@{a#--project-name=}" ;; esac
    prev="$a"
  done
  ex="$TC_FAKE_LIST_EXIT"; names="$TC_FAKE_SECRET_NAMES"
  while IFS=$'\t' read -r p e n; do
    [ "$p" = "$project" ] || continue
    ex="$e"; names="$n"; [ "$names" = - ] && names=""
    break
  done < "$TC_FAKE_SECRET_RULES"
  [ "$ex" = 0 ] || names=""
  printf 'wrangler\tpages secret list\t%s\t%s\t%s\n' "$project" "$ex" "$names" >> "$TC_FAKE_LOG"
  if [ "$ex" != 0 ]; then
    echo "✘ [ERROR] A request to the Cloudflare API (/pages/projects/$project) failed." >&2
    exit "$ex"
  fi
  out=" ⛅️ wrangler 4.0.0@NL@"
  for n in $names; do out+="$n: Value Encrypted@NL@"; done
  printf '%s' "$out"
  exit 0
fi
printf 'wrangler\t%s\t-\t1\t\n' "$*" >> "$TC_FAKE_LOG"
echo "偽の wrangler: $* は受けない" >&2
exit 1
`.replaceAll('@NL@', '$' + '{NL}').replaceAll('@{', '$' + '{')

/** 子の node の外向きの接続を断る前置き（NODE_OPTIONS の --require で入れる）。手元（loopback と UNIX ソケット）だけ通す。 */
const NET_GUARD = String.raw`const net = require('node:net')
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
  if (!path && host && !LOCAL.has(host)) throw new Error('契約の実例の確かめ: 外への接続を断った ' + host)
  return connect.apply(this, args)
}
`

/** 定められたセキュリティヘッダ（契約 readDeploymentHealthHeaders の ok の例の値）。 */
export const REQUIRED_HEALTH_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

/** ヘッダを「名前: 値」の行に並べる（偽の curl が読むヘッダのファイル）。 */
const headerLines = (headers: Record<string, string>) => Object.entries(headers).map(([n, v]) => `${n}: ${v}\n`).join('')

/** 配備ごとに必要な秘密の名前（用語集。まなびばは共有秘密、学びは共有秘密とトークンの署名の秘密）。 */
const SECRET_NAMES = ['SSO_SECRET', 'JWT_SECRET']

/** 偽の配備先の 1 つの応答の規則。url は完全一致。exit を与えると届かない（curl の終了の状態）。 */
export type FakeHttpRule = { method?: string; url: string; status?: number; exit?: number; headers?: Record<string, string> }

/** 機械向けの 1 行の problems の 1 項目（UC-015 の契約 CheckProblems）。 */
export type CheckProblem = { deployment: string; operation: string; path?: string; route?: string; code?: string }

/** 代わりの配備先が受けた要求 1 つと、その要求に返した物（exit が 0 でなければ届かなかった。status は返していない）。 */
export type HttpCall = { kind: 'http'; method: string; url: string; status: number; exit: number; headers: Record<string, string>; body: string }

/** 代わりの配備先のアカウントが受けた要求 1 つと、その要求に返した物（names は終了の状態が 0 のときだけ）。 */
export type WranglerCall = { kind: 'wrangler'; command: string; project: string | null; exit: number; names: string[] }

export type ProdCall = HttpCall | WranglerCall

/**
 * 代わりの配備先のアカウントの前提。既定はログイン中で、配備を持つアカウント（scripts/pages_projects.json の account_id）、
 * どの配備の一覧も必要な名前のそろった物を返す。
 * - loggedIn: false でログインしていない（アカウントが分からない）。
 * - accountId: ログイン中のアカウントの ID（配備を持たないアカウントにするときに与える）。
 * - listExit: projects に無い配備の一覧の取得の終了の状態（0 でなければ失敗）。
 * - projects: 配備の key ごとの一覧の取得の答え（exit が 0 でなければ失敗、names はその配備の秘密の名前）。
 */
export type FakeAccount = {
  loggedIn?: boolean
  accountId?: string
  listExit?: number
  projects?: Record<string, { exit?: number; names?: string[] }>
}

export type ProdCheckRun = { code: number; problems: CheckProblem[] | null; calls: ProdCall[]; stdoutTail: string }

let deploymentUrls: Map<string, string> | null = null

/**
 * 配備の key → URL（値の正本は scripts/pages_projects.json と登録簿 scripts/targets.py）。
 * @implements REQ-569
 */
export async function deploymentUrl(key: string): Promise<string> {
  if (!deploymentUrls) {
    const { readFile } = await import('node:fs/promises')
    const { execFileSync } = await import('node:child_process')
    const { REPO_ROOT } = await import('./tool')
    const projects = JSON.parse(await readFile(join(REPO_ROOT, 'scripts/pages_projects.json'), 'utf8')) as Record<string, { url?: string }>
    const urls = new Map<string, string>([['_portal', String(projects._portal?.url ?? '')]])
    const targets = (...args: string[]) => execFileSync('python3', [join(REPO_ROOT, 'scripts/targets.py'), ...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    for (const k of targets('keys').split(/\s+/)) urls.set(k, targets('url', k))
    deploymentUrls = urls
  }
  const url = deploymentUrls.get(key)
  if (!url) throw new Unanswerable(`配備 ${key} の URL が登録簿に無い`)
  return url
}

/** 標準出力の最後の空でない行を機械向けの 1 行として読む（REQ-578 の境界の扱い）。読めなければ null。 */
function lastLineProblems(stdout: string): CheckProblem[] | null {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return null
  try {
    const problems = (JSON.parse(lines[lines.length - 1]) as { error?: { problems?: unknown } })?.error?.problems
    return Array.isArray(problems) ? (problems as CheckProblem[]) : null
  } catch {
    return null
  }
}

/** ヘッダのファイルの「名前: 値」の行を、名前を小文字にした鍵で読む。 */
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return headers
}

/** 代わりの相手の記録（TC_FAKE_LOG）を読む。ヘッダのファイルは影の根を消す前に読む。 */
async function readCalls(logText: string): Promise<ProdCall[]> {
  const { readFile } = await import('node:fs/promises')
  const calls: ProdCall[] = []
  for (const line of logText.split('\n')) {
    const f = line.split('\t')
    if (f[0] === 'http' && f.length >= 8) {
      const [, method, url, status, exit, hfile, ctype, ...body] = f
      const headers = hfile && hfile !== '-' ? parseHeaders(await readFile(hfile, 'utf8').catch(() => '')) : {}
      if (Number(exit) === 0) headers['content-type'] = ctype
      calls.push({ kind: 'http', method, url, status: Number(status), exit: Number(exit), headers: Number(exit) === 0 ? headers : {}, body: Number(exit) === 0 ? body.join('\t') : '' })
    } else if (f[0] === 'wrangler' && f.length >= 4) {
      const [, command, project, exit, names = ''] = f
      calls.push({ kind: 'wrangler', command, project: project === '-' ? null : project, exit: Number(exit), names: names.split(' ').filter((n) => n !== '') })
    }
  }
  return calls
}

/**
 * 配備の key → Pages プロジェクト名（値の正本は scripts/pages_projects.json）。
 * @implements REQ-569
 */
export async function projectOf(key: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { REPO_ROOT } = await import('./tool')
  const projects = JSON.parse(await readFile(join(REPO_ROOT, 'scripts/pages_projects.json'), 'utf8')) as Record<string, { project?: string }>
  const project = projects[key]?.project
  if (!project) throw new Unanswerable(`配備 ${key} の Pages プロジェクト名が scripts/pages_projects.json に無い`)
  return project
}

/**
 * 本番の確かめ（`bash scripts/check_sso_prod.sh`）を、代わりの配備先（偽の curl）と代わりの配備先のアカウント（偽の wrangler）に向けて 1 回回す。
 * 返す calls は、道具が実際に送った要求と、代わりの相手がその要求に返した物の記録（受け持ちは応答をここから読む）。
 * 子には親の環境変数を引き継ぎ、PATH の先頭に偽物を置き、子の node の外向きの接続と代理の無い通信を塞ぐ。本番にも外の相手にも届かない。
 * @implements REQ-567, REQ-569, REQ-570
 */
export async function runProdCheck(rules: FakeHttpRule[], account: FakeAccount = {}): Promise<ProdCheckRun> {
  const { shadowRoot, fakeCommands, runTool, REPO_ROOT } = await import('./tool')
  const { readFile } = await import('node:fs/promises')
  const shadow = await shadowRoot({
    files: {
      'net-guard.cjs': NET_GUARD,
      'curl.sh': FAKE_CURL,
      'wrangler.sh': FAKE_WRANGLER,
      'calls.log': '',
      'tmp/.keep': '',
      'headers/required': headerLines(REQUIRED_HEALTH_HEADERS),
    },
  })
  try {
    const lines: string[] = []
    for (const [i, rule] of rules.entries()) {
      let headerFile = '-'
      if (rule.headers) {
        headerFile = shadow.path(`headers/rule-${i}`)
        await shadow.write(`headers/rule-${i}`, headerLines(rule.headers))
      }
      lines.push([rule.method ?? '*', rule.url.split('?')[0].replace(/\/+$/, ''), rule.status ?? '-', rule.exit ?? 0, headerFile].join('\t'))
    }
    await shadow.write('http.rules', `${lines.join('\n')}\n`)
    const secretRules: string[] = []
    for (const [key, answer] of Object.entries(account.projects ?? {})) {
      const names = answer.names ?? SECRET_NAMES
      secretRules.push([await projectOf(key), answer.exit ?? 0, names.length > 0 ? names.join(' ') : '-'].join('\t'))
    }
    await shadow.write('secret.rules', `${secretRules.join('\n')}\n`)
    const projects = JSON.parse(await readFile(join(REPO_ROOT, 'scripts/pages_projects.json'), 'utf8')) as { account_id: string }
    const base = await fakeCommands(shadow, {
      curl: `exec bash "${shadow.path('curl.sh')}" "$@"`,
      wrangler: `exec bash "${shadow.path('wrangler.sh')}" "$@"`,
      npx: `case "$1" in wrangler|wrangler@*) exec bash "${shadow.path('wrangler.sh')}" "$@" ;; esac\necho "偽の npx: $1 は受けない" >&2\nexit 1`,
    })
    // 親の環境変数は引き継ぎ、外への口を塞ぐ物は足すだけにする（代理が無ければ届かない代理を置く）
    const deadProxy = 'http://127.0.0.1:9'
    const env: NodeJS.ProcessEnv = {
      ...base,
      NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} --require ${shadow.path('net-guard.cjs')}`.trim(),
      HTTPS_PROXY: base.HTTPS_PROXY ?? deadProxy,
      HTTP_PROXY: base.HTTP_PROXY ?? deadProxy,
      ALL_PROXY: base.ALL_PROXY ?? deadProxy,
      TMPDIR: shadow.path('tmp'),
      TC_FAKE_LOG: shadow.path('calls.log'),
      TC_FAKE_RULES: shadow.path('http.rules'),
      TC_FAKE_HEADERS: shadow.path('headers/required'),
      TC_FAKE_PORTAL_URL: await deploymentUrl('_portal'),
      TC_FAKE_ACCOUNT: account.loggedIn === false ? '' : (account.accountId ?? projects.account_id),
      TC_FAKE_SECRET_NAMES: SECRET_NAMES.join(' '),
      TC_FAKE_SECRET_RULES: shadow.path('secret.rules'),
      TC_FAKE_LIST_EXIT: String(account.listExit ?? 0),
    }
    const run = await runTool(['bash', 'scripts/check_sso_prod.sh'], { cwd: REPO_ROOT, env, timeoutMs: 90_000 })
    const calls = await readCalls(await readFile(shadow.path('calls.log'), 'utf8'))
    return { code: run.code, problems: lastLineProblems(run.stdout), calls, stdoutTail: run.stdout.trim().split('\n').slice(-3).join(' / ') }
  } finally {
    await shadow.cleanup()
  }
}
