/**
 * UC-036 の受け持ち（手元の配備に API と画面を当てる道具 5 つ。入口は CLAUDE.md の「道具を回す操作」の行と契約の先頭の決まり）:
 * checkApi ＝ `bash scripts/check_api.sh [<learning>]`、checkPortalApi ＝ `bash scripts/check_portal_api.sh`、
 * auditFixtures ＝ `node scripts/audit_fixtures.mjs [--base] [--json]`、auditScreens ＝ `bash scripts/audit_screens.sh [<learning>] [--out] [--limit]`、
 * checkSsoFlow ＝ `python3 scripts/check_sso_flow.py`。応答は終了の状態（契約の exitCode）。断りは auditFixtures と auditScreens だけが標準出力の ToolError で名前を出す（UPSTREAM_UNAVAILABLE）。
 *
 * 前提（UC の事前条件と、失敗例の配備の答え）は、テストの土台（tests/server/UC-036_fixture.local.ts）と同じ道具立てで、実例ごとに作る:
 * - 影の根: リポジトリの写しに、手元の保存先（`.wrangler`・`portal/.wrangler`）の写しを置く（元は書き換えない）
 * - auditFixtures: 学び ip の配備を、まなびばの場所と共有秘密を手元の SSO の偽物の値にして、既定の口 8787 に起こしておく
 *   （配備の道具は起こさず、学び側の app を影の根の手元の保存先でこのプロセスの中に立てる。学び側から偽物へは手元の口だけに届く fetch で届ける）
 * - checkSsoFlow: 事前条件の状態を作る。手元のまなびばと手元の学び（口・学び・共有秘密・メールとパスワードの正本は scripts/check_sso_flow.py）を
 *   このプロセスの中に立て、まなびばの契約の操作で、一巡の道具が使うメールとパスワードで学びの権限を持つ管理者を作っておく（土台の startSsoPair）。
 *   前提を作れなければ、実装に渡せなかった実例として挙げる
 * - auditScreens の写しの書き出し先は影の根の中（request に out が無ければ足す）
 * - unreadableAnswer（auditFixtures・auditScreens）: 学び ip の配備が、検査用のアカウントの用意に要る論点の一覧（UC-002 の listTopics、
 *   GET /api/topics）に成功の状態で本文の無い答えを返すようにしておく（auditFixtures はこのプロセスの中の app の答えを、
 *   auditScreens は影の根の配備の設定の入口を包んで書き換える。土台の startAuditDeployment・rewriteAnswers）
 * - 知らない実例の名前は、実装に渡せなかった実例として挙げる
 * 道具は決まった口で配備を起こすので、実例ごとに使う口（土台の PORTS_OF）の鍵をテストと同じ withPorts で取る。口の重ならない実例は並べて回る。
 */

import { join } from 'node:path'
import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { argsOf } from '../kit/td'
import { toolAnswer } from '../kit/tool'
import { withFetch } from '../kit/outside'
import {
  fencedEnv,
  INSPECTOR_OF,
  localFetch,
  separateInspector,
  PORTS_OF,
  removeShadow,
  rewriteAnswers,
  runTool,
  startAuditDeployment,
  startSsoPair,
  toolShadow,
  withPorts,
  type Shadow,
  type ToolRun,
} from '../../../tests/server/UC-036_fixture.local'

const answer = (r: ToolRun) => {
  if (r.timedOut) throw new Unanswerable(`道具が時間内に終わらない: ${r.out.slice(-300)}`)
  return toolAnswer({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }, (x) => ({ exitCode: x.code }))
}

/** 手元の口だけに届く fetch（withFetch）を使う実例どうしの順番待ちの仮の鍵の番号（口としては使わない）。 */
const FETCH_LOCK = 1

type Prepare = (shadow: Shadow) => Promise<() => Promise<void>>

/** 検査用のアカウントの用意に要る論点の一覧（UC-002 の listTopics）に、成功の状態で本文の無い答えを返す書き換え。 */
const EMPTY_TOPIC_LIST = [{ path: '^/api/topics$', body: '' }]

const tool =
  (
    ports: readonly number[],
    command: (shadow: Shadow, line: ExampleLine) => string[],
    options: { prepare?: Prepare; cases?: Record<string, Prepare>; fenced?: boolean; localOnly?: boolean; inspector?: number } = {},
  ): Operation =>
  async (line: ExampleLine) => {
    const prepare = line.case === 'ok' ? options.prepare : options.cases?.[line.case]
    if (line.case !== 'ok' && !prepare) throw new Unanswerable(`UC-036 ${line.operation} の例 ${line.case} の前提を知らない`)
    // 手元の口だけに届く fetch はプロセスに 1 つの差し替えなので、それを使う実例どうしは仮の鍵（FETCH_LOCK）でも順番を待つ
    const locks = options.localOnly ? [...ports, FETCH_LOCK] : ports
    return withPorts(async () => {
      const shadow = toolShadow()
      if (options.inspector !== undefined) separateInspector(shadow, options.inspector)
      try {
        let release: () => Promise<void> = async () => {}
        try {
          if (prepare) release = await prepare(shadow)
        } catch (e) {
          throw new Unanswerable(`UC-036 ${line.operation}.${line.case} の前提を作れない: ${String((e as Error).message ?? e).slice(0, 600)}`)
        }
        try {
          const run = () =>
            runTool(shadow, command(shadow, line), {
              timeoutMs: 900_000,
              env: options.fenced ? fencedEnv(shadow) : undefined,
              ports,
            })
          return answer(options.localOnly ? await withFetch(localFetch as typeof fetch, run) : await run())
        } finally {
          await release()
        }
      } finally {
        await removeShadow(shadow)
      }
    }, locks)
  }

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-036',
  parallel: true,
  operations: {
    checkApi: tool(PORTS_OF.checkApi, (_, line) => ['bash', 'scripts/check_api.sh', ...argsOf(line.request, { positional: ['learning'] })], {
      inspector: INSPECTOR_OF.checkApi,
    }),
    checkPortalApi: tool(PORTS_OF.checkPortalApi, (_, line) => ['bash', 'scripts/check_portal_api.sh', ...argsOf(line.request)], {
      inspector: INSPECTOR_OF.checkPortalApi,
    }),
    auditFixtures: tool(PORTS_OF.auditFixtures, (_, line) => ['node', 'scripts/audit_fixtures.mjs', ...argsOf(line.request)], {
      prepare: (shadow) => startAuditDeployment(shadow),
      cases: { unreadableAnswer: (shadow) => startAuditDeployment(shadow, 'ip', 8787, { rules: EMPTY_TOPIC_LIST }) },
      localOnly: true,
    }),
    auditScreens: tool(
      PORTS_OF.auditScreens,
      (shadow, line) => [
        'bash',
        'scripts/audit_screens.sh',
        ...argsOf(
          {
            ...(line.request ?? {}),
            out: line.request?.out ?? join(shadow.root, 'screens'),
          },
          { positional: ['learning'] },
        ),
      ],
      {
        inspector: INSPECTOR_OF.auditScreens,
        cases: {
          unreadableAnswer: async (shadow) => {
            rewriteAnswers(shadow, EMPTY_TOPIC_LIST)
            return async () => {}
          },
        },
      },
    ),
    checkSsoFlow: tool(PORTS_OF.checkSsoFlow, (_, line) => ['python3', 'scripts/check_sso_flow.py', ...argsOf(line.request)], {
      prepare: async () => {
        const pair = await startSsoPair()
        return pair.close
      },
      fenced: true,
      localOnly: true,
    }),
  },
})
