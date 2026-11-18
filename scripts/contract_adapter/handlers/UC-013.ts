/**
 * UC-013 の受け持ち（まなびばから権限のある学びに入る）。`http` の操作だけを持つ（端末の記憶の操作は別の受け持ちが足す）。
 *
 * まなびばの操作（signIn・getMe・signOut・startSso・exchangeCode）はまなびばの app（default export）、listLearnings は小さい登録簿で組んだ
 * まなびばの app（createApp）、
 * 学び側の操作（getAuthConfig・signInWithCode）は学び側の app に渡す。
 * 前提: まなびばに山田（8a0f…・パスワード harunokaze8・権限 ip と ap）が居る。
 * 使い捨てコードは startSso（契約の操作）で発行し、その値を実例のコードに置き換える。
 * - 使用済み（usedCode）: 1 度換えてから渡す。
 * - 権限が外れた（revokedGrant・noGrant）: その学びの権限を持つ間に発行し、発行のあとで権限を外す。
 * 学び側は、まなびばの場所を登録簿のまなびばの入口に、共有秘密をまなびばと同じ値にした配備。外への口は手元のまなびばに向ける。
 */

import { createApp, type Learning } from '../../../portal/src/index'
import targets from '../../../src/shared/targets.json'
import { portalD1 } from '../../../tests/portal/repay_UC-014_sqlite_d1'
import { answerOf, pieces } from '../kit/http'
import { learningWorld } from '../kit/learning'
import { withFetch, withUuids } from '../kit/outside'
import { YUDAI } from '../kit/people'
import { portalWorld, SHARED_SECRET, type PortalEnv, type PortalWorld } from '../kit/portal'
import { deploymentUrl } from '../kit/tc'
import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'

const PORTAL_URL = (targets as unknown as { _portal: { url: string } })._portal.url
/** 学び側の実例が名指す本人の学びの記録の id（signInWithCode.ok の user.id）。 */
const LEARNER_ID = '4d2b8a10-9c61-4f03-8a7d-15b2e6c94f88'

async function portalWithYudai(grants: string[] = ['ip', 'ap']): Promise<{ world: PortalWorld; session: string }> {
  const world = await portalWorld()
  await world.account({ ...YUDAI, role: 'MEMBER', grants })
  return { world, session: world.session(YUDAI.id) }
}

/** 山田の使い捨てコードを app に宛てて発行し、値を code に置き換える。 */
async function issue(world: PortalWorld, session: string, app: string, code: string): Promise<void> {
  const res = await world.other(`/sso/start?app=${app}`, { headers: world.cookie(session) })
  const location = res.headers.get('Location') ?? ''
  const issued = new URL(location, PORTAL_URL).searchParams.get('code')
  if (!issued) throw new Unanswerable(`前提の使い捨てコードを発行できない: ${res.status} ${location}`)
  world.db.prepare('UPDATE sso_codes SET code = ? WHERE code = ?').run(code, issued)
}

async function exchangeOnce(world: PortalWorld, code: string, app: string): Promise<void> {
  const res = await world.other('/api/sso/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, app, secret: SHARED_SECRET }),
  })
  if (res.status !== 200) throw new Unanswerable(`前提の「使用済みのコード」を作れない: ${res.status} ${await res.text()}`)
}

/** 例の名前から、コードの前提（宛て先の学びと、使用済み・権限の外れ）を作る。 */
async function codePremise(line: ExampleLine, app: string): Promise<{ world: PortalWorld; session: string }> {
  const code = String(line.request?.code ?? '')
  const revoked = line.case === 'revokedGrant' || line.case === 'noGrant'
  const { world, session } = await portalWithYudai([...new Set(['ip', 'ap', ...(revoked ? [app] : [])])])
  if (code === '') return { world, session }
  await issue(world, session, app, code)
  if (/usedCode/i.test(line.case)) await exchangeOnce(world, code, app)
  if (revoked) world.db.prepare('DELETE FROM grants WHERE account_id = ? AND learning = ?').run(YUDAI.id, app)
  return { world, session }
}

const portalOp: Operation = async (line) => {
  if (line.operation === 'exchangeCode') {
    const app = String(line.request?.app ?? '')
    const { world } = await codePremise(line, app === 'zzz' ? 'ip' : app)
    const secret = line.request && 'secret' in line.request ? {} : { secret: SHARED_SECRET }
    return world.send({ ...line, request: { ...line.request, ...secret } }, null)
  }
  const { world, session } = await portalWithYudai()
  if (line.operation === 'startSso' && line.case === 'ok') {
    return withUuids(['3f1c9a52-7b0e-4a1d-9c3e-2f5b8d6a1e40'], () => world.send(line, session))
  }
  return world.send(line, line.auth === 'none' ? null : session)
}

/**
 * 学びの一覧（listLearnings）は、まなびばの app を小さい登録簿で組む入口 createApp に渡す（CLAUDE.md の「規則に従わない入口」）。
 * 前提の登録簿: 学び ip だけ（名前・種類・説明は契約の例の値、場所は登録簿の ip の URL）。
 * @implements REQ-567, REQ-570
 */
const listLearnings: Operation = async (line) => {
  const registry: Learning[] = [
    {
      key: 'ip',
      brand: 'IT パスポート 最短合格',
      url: await deploymentUrl('ip'),
      kind: '資格対策',
      desc: '過去問の出題頻度＝重要度の順に、最短で合格ラインへ',
    },
  ]
  const app = createApp(registry)
  const env = { ASSETS: { fetch: async () => new Response('') }, SSO_SECRET: SHARED_SECRET, DB: await portalD1() } as unknown as PortalEnv
  const { path, init } = pieces(line)
  return answerOf(await app.request(path, init, env), line)
}

const learningOp: Operation = async (line) => {
  if (line.operation === 'getAuthConfig') {
    const world = await learningWorld(line.case === 'noPortal' ? {} : { SSO_PORTAL_URL: PORTAL_URL, SSO_SECRET: SHARED_SECRET })
    return world.send(line, null)
  }
  const env: Record<string, unknown> = { SSO_PORTAL_URL: PORTAL_URL, SSO_SECRET: SHARED_SECRET }
  if (line.case === 'noSigningSecret') env.JWT_SECRET = undefined
  if (line.case === 'notConfigured') delete env.SSO_PORTAL_URL
  const learning = await learningWorld(env)
  learning.db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(LEARNER_ID, YUDAI.email, YUDAI.name, '-', 'MEMBER')
  const { world } = await codePremise(line, 'ip')
  const upstream: typeof globalThis.fetch =
    line.case === 'portalUnreachable'
      ? async () => {
          throw new TypeError('まなびばに届かない（前提）')
        }
      : world.asFetch
  return withFetch(upstream, () => learning.send(line, null))
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-013',
  operations: {
    signIn: portalOp,
    getMe: portalOp,
    signOut: portalOp,
    listLearnings,
    startSso: portalOp,
    exchangeCode: portalOp,
    getAuthConfig: learningOp,
    signInWithCode: learningOp,
  },
})
