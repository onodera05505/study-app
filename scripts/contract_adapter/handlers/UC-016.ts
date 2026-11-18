/**
 * UC-016 の受け持ち（fetchVersionStamp。画面が自分の配備の配信物から版の印を取りに行く `http` outbound）。
 *
 * 入口は `src/client/lib/version.ts` の rememberBuild・checkForUpdate（CLAUDE.md の「操作 → 入口」）。どちらも取れた印を返さないので、
 * 印は入口のふるまいから読む:
 * 1. 例ごとに入口の module を読み直し（最初の印を持たない画面）、配信物を前提の物にして rememberBuild を呼ぶ。
 * 2. 配信物を別の印（見比べ用）に替えて checkForUpdate を呼ぶ。知らせが出なければ、最初の印は覚えられていない（印は null）。
 * 3. 知らせが出たら、配信物を前提の物に戻して checkForUpdate を呼ぶ。知らせが出なければ、覚えた印の build は前提の build と同じ。
 * 入口から読めるのは build だけで、配信の時点（at）は読めないので応答に含めない（含めると読んでいない値を作ることになる）。
 * 配信物（前提）: ok は build と at を持つ印、noStamp は印の形を持たない中身、unreachable は届かない。
 * 画面の外への口は偽の配信物に向け、要求が契約の wire（GET /version.json）であることを確かめる。
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from '../kit/tool'
import { withFetch } from '../kit/outside'
import { defineHandler, Unanswerable, type Operation } from '../kit/protocol'

type Shelf = { kind: 'stamp'; body: unknown } | { kind: 'unreachable' }

const PREMISE: Record<string, Shelf> = {
  ok: { kind: 'stamp', body: { build: 'c1ffde6', at: '2026-10-01T04:12:30Z' } },
  noStamp: { kind: 'stamp', body: { note: '版の印の形を持たない中身' } },
  unreachable: { kind: 'unreachable' },
}
const PROBE: Shelf = { kind: 'stamp', body: { build: 'contract-adapter-probe', at: '2026-10-02T00:00:00Z' } }

let windows = 0

const fetchVersionStamp: Operation = async (line) => {
  const premise = PREMISE[line.case]
  if (!premise) throw new Unanswerable(`${line.case}: 前提の配信物を決められない例の名前`)
  let shelf: Shelf = premise
  const requests: string[] = []
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input instanceof Request ? input.url : input), 'https://learning.invalid/'), init)
    requests.push(`${request.method} ${new URL(request.url).pathname}`)
    if (shelf.kind === 'unreachable') throw new TypeError('配信物に届かない（前提）')
    return new Response(JSON.stringify(shelf.body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch

  const url = pathToFileURL(join(REPO_ROOT, 'src/client/lib/version.ts')).href
  const version = (await import(`${url}?window=${++windows}`)) as { rememberBuild: () => Promise<unknown>; checkForUpdate: () => Promise<boolean> }

  return withFetch(fake, async () => {
    await version.rememberBuild()
    shelf = PROBE
    const differsFromProbe = await version.checkForUpdate()
    let stamp: { build: string } | null = null
    if (differsFromProbe) {
      shelf = premise
      const differsFromPremise = await version.checkForUpdate()
      if (premise.kind !== 'stamp' || differsFromPremise) throw new Unanswerable('覚えた印の build を入口のふるまいから読めない')
      stamp = { build: (premise.body as { build: string }).build }
    }
    const wrong = requests.filter((r) => r !== 'GET /version.json')
    if (wrong.length > 0) throw new Unanswerable(`契約の wire と違う要求: ${wrong.join(', ')}`)
    return { response: { versionStamp: stamp } }
  })
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-016',
  operations: { fetchVersionStamp },
})
