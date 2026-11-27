/** UC-039 の本番の SSO の一巡（check_sso_prod_smoke.py）が向かう「本番のまなびばと学び」の代わりの相手。
 *
 *  まなびばと学び側の本物の app（portal/src/index.ts の createApp・src/server/index.ts の既定の app）を、手元（127.0.0.1）の HTTPS の口で受ける
 *  （まなびばの Cookie は Secure なので HTTPS で受ける）。証明書はその場で作る手元だけの認証局が署名した物で、道具の Python には起動の前置き
 *  （Counterparts.env の PYTHONPATH と UC039_TEST_CA）でその認証局を信じさせる。
 *  学び側の app がまなびばへ送る交換の要求は、この口を通さずにまなびばの app へ直に渡す（テストのプロセスの fetch を差し替える）。
 *  保存先は影の根の偽の配備の道具が向ける SQLite のファイル（UC-039_fixture.local.ts の dbFile の本番の側）と同じ物で、道具が wrangler で作った
 *  一時のアカウントを、代わりの相手がそのまま読む。影の根の配備先の一覧（scripts/pages_projects.json）のまなびばと学びの場所を、
 *  この口に書き換える（本物の一覧の値は読まない・出さない）。道具は OS の囲いの中で、手元のほかへは届かない。 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, Server } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import portalApp, { createApp } from '../../portal/src/index'
import app from '../../src/server/index'
import { d1Of } from './UC-002_sqlite_fixture'
import { dbFile, learningDb, portalDb, projectOf, type Shadow39 } from './UC-039_fixture.local'

void portalApp

const SECRET = 'uc039-counterpart-sso-secret-0123456789'
const assets = { fetch: async () => new Response('not found', { status: 404 }) }

export type Counterparts = { portalUrl: string; learningUrl: string; requests: string[]; env: Record<string, string>; close: () => Promise<void> }

async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  return new Request(new URL(req.url ?? '/', base), { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body })
}

/** その場で作る証明書（手元だけの認証局と、それが署名した 127.0.0.1 の証明書）と、道具の Python にその認証局を信じさせる前置き。 */
function makeCert(): { dir: string; key: string; cert: string; ca: string } {
  const dir = mkdtempSync(join(tmpdir(), 'uc039-cert-'))
  const at = (n: string) => join(dir, n)
  writeFileSync(at('ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=uc039-test-ca\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
  writeFileSync(at('ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nauthorityKeyIdentifier=keyid\n')
  const run = (args: string[]) => {
    const r = spawnSync('openssl', args, { encoding: 'utf8', cwd: dir })
    if (r.status !== 0) throw new Error(`仕込み: 証明書を作れない: ${r.stderr}`)
  }
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-config', 'ca.cnf'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 's.csr', '-subj', '/CN=127.0.0.1'])
  run(['x509', '-req', '-in', 's.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'c.pem', '-days', '1', '-extfile', 'ext'])
  // Python の ssl は SSL_CERT_FILE を既定の確かめに使わないことがあるので、起動の前置き（sitecustomize）で手元の認証局を足す
  writeFileSync(
    at('sitecustomize.py'),
    [
      'import os, ssl',
      "_ca = os.environ.get('UC039_TEST_CA')",
      'if _ca:',
      '    _orig = ssl.create_default_context',
      '    def _ctx(*a, **k):',
      '        c = _orig(*a, **k)',
      '        c.load_verify_locations(_ca)',
      '        return c',
      '    ssl.create_default_context = _ctx',
      '    ssl._create_default_https_context = _ctx',
      '',
    ].join('\n'),
  )
  return { dir, key: readFileSync(at('k.pem'), 'utf8'), cert: at('c.pem'), ca: at('ca.pem') }
}

function listen(tls: { key: string; cert: string }, handle: (r: Request) => Promise<Response>, requests: string[], label: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    let base = ''
    const server = createServer({ key: tls.key, cert: readFileSync(tls.cert, 'utf8') }, async (req, res) => {
      requests.push(`${label} ${req.method} ${req.url}`)
      try {
        const request = await toRequest(req, base)
        if (process.env.UC039_DEBUG) requests.push(`  ← ${JSON.stringify(Object.fromEntries(request.headers))} ${await request.clone().text()}`)
        const response = await handle(request)
        // ヘッダの名前は、よくある書き方（語の頭を大文字）で返す
        const title = (k: string) => k.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase())
        const out: Record<string, string | string[]> = {}
        response.headers.forEach((v, k) => {
          if (k !== 'set-cookie') out[title(k)] = v
        })
        const cookies = response.headers.getSetCookie()
        if (cookies.length) out['Set-Cookie'] = cookies
        if (process.env.UC039_DEBUG) requests.push(`  → ${response.status} ${JSON.stringify(out)}`)
        res.writeHead(response.status, out)
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
      }
    })
    ;(server as unknown as Server).listen(0, '127.0.0.1', () => {
      base = `https://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve({ server, url: base })
    })
  })
}

/** 影の根の配備先の一覧の、key の項の場所を書き換える（値は表示しない）。null で場所を外す。 */
export function setLocation(s: Shadow39, key: string, url: string | null): void {
  const file = s.path('scripts/pages_projects.json')
  const p = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
  if (url === null) delete p[key].url
  else p[key].url = url
  writeFileSync(file, JSON.stringify(p, null, 2))
}

/** まなびばと学び key の代わりの相手を立て、影の根の配備先の一覧をそこへ向ける。 */
export async function startCounterparts(s: Shadow39, key: string): Promise<Counterparts> {
  const requests: string[] = []
  const portalDbFile = portalDb(s, 'remote')
  const learningDbFile = learningDb(s, 'remote', key)
  void dbFile
  const open = (file: string) => d1Of(new DatabaseSync(file, { enableForeignKeyConstraints: false })) as unknown as D1Database
  const tls = makeCert()
  let learningUrl = ''
  let portalUrl = ''
  const learnings = (JSON.parse(readFileSync(s.path('portal/src/learnings.json'), 'utf8')) as Array<Record<string, unknown>>).map(
    (l): Record<string, unknown> => ({ ...l, url: 'https://127.0.0.1:9' }),
  )
  const portalHono = createApp(learnings as never)
  const portalFetch = async (r: Request): Promise<Response> => portalHono.fetch(r, { DB: open(portalDbFile), ASSETS: assets, SSO_SECRET: SECRET } as never)
  // 学び側の app がまなびばへ送る要求は、まなびばの app へ直に渡す
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    if (portalUrl && req.url.startsWith(portalUrl)) {
      requests.push(`learning→portal ${req.method} ${new URL(req.url).pathname}`)
      return portalFetch(req)
    }
    return realFetch(input, init)
  }) as typeof fetch
  const learning = await listen(
    tls,
    async (r): Promise<Response> => app.fetch(r, { DB: open(learningDbFile), ASSETS: assets, JWT_SECRET: 'uc039-jwt', SSO_PORTAL_URL: portalUrl, SSO_SECRET: SECRET, EXAM: key } as never),
    requests,
    'learning',
  )
  learningUrl = learning.url
  for (const l of learnings) if (l.key === key) l.url = learningUrl
  const portal = await listen(tls, portalFetch, requests, 'portal')
  portalUrl = portal.url
  setLocation(s, '_portal', portalUrl)
  setLocation(s, key, learningUrl)
  void projectOf
  return {
    portalUrl,
    learningUrl,
    requests,
    env: { PYTHONPATH: tls.dir, UC039_TEST_CA: tls.ca, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    close: async () => {
      globalThis.fetch = realFetch
      await Promise.all([learning, portal].map((x) => new Promise<void>((r) => x.server.close(() => r()))))
      rmSync(tls.dir, { recursive: true, force: true })
    },
  }
}
