/**
 * UC-015 の受け持ち（本番の確かめの 4 操作は `http` outbound、秘密の名前の一覧を取る listDeploymentSecretNames は他者の形を写した
 * `sdk` outbound。入口はどれも `bash scripts/check_sso_prod.sh`）。
 *
 * 確かめの道具を、代わりの配備先（偽の curl）と代わりの配備先のアカウント（偽の wrangler）に向けて例ごとに 1 回回す（kit/tc.ts の runProdCheck）。
 * 代わりの相手は、例の名前が指す配備と経路（またはアカウントと一覧）にだけ前提の答えを置き、ほかは全部そろった答えを返す。
 *
 * 応答は、道具が実際に送った要求の記録と、代わりの相手がその要求に返した物から読む（前提として置いた値をそのまま応答にしない）:
 * - 道具が例の要求（配備の URL と経路と method、または例の配備の一覧の取得）を送っていなければ、実装が応えなかった物として Unanswerable。
 * - 例の操作・配備（と path・route）に合う problems の項目（標準出力の最後の機械向けの 1 行。契約 CheckProblems）が code を持てば、その名前の断り。
 * - そうでなければ、代わりの相手がその要求に返した物を応答にする（届かなかった・一覧を取れなかったときは何も受け取っていないので空の応答）。
 * - 項目の有無が前提と合わない（問題の無い答えに名前の無い問題を挙げた・値の問題を挙げない）ときは、道具が受け取った答えを読めないとして Unanswerable。
 * 機械向けの行は名前を持つ問題があるときだけ出る（REQ-578）ので、どの例でも、例の操作が見ない配備（見張りの配備）の死活確認を
 * 届かなくしておき、行が必ず出るようにする。見張りの配備の項目は、例の配備の項目と混ざらない。
 */

import {
  deploymentUrl,
  projectOf,
  runProdCheck,
  type CheckProblem,
  type FakeAccount,
  type FakeHttpRule,
  type HttpCall,
  type ProdCheckRun,
} from '../kit/tc'
import { defineHandler, Unanswerable, type Answer, type ExampleLine, type Operation } from '../kit/protocol'

/** 見張りの配備（例が名指さない学び）。 */
const WATCH = 'cnv'
/** 届かない（curl の接続の失敗の終了の状態）。 */
const UNREACHABLE = 7
/** 配備を持たないアカウントの ID（wrongAccount の前提）。 */
const OTHER_ACCOUNT = '00000000000000000000000000000000'

/** 契約 readDeploymentHealthHeaders の headerMissing の例の配備が返すヘッダ（定められた 5 つのうち 2 つ）。 */
const HEADER_MISSING: Record<string, string> = {
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
}

type Premise = {
  /** 例の配備と経路に置く前提の答え。 */
  rule: Omit<FakeHttpRule, 'url'> & { path: string }
  /** その答えが契約の上で問題に当たるか（欠けたヘッダ・閉じていない経路）。 */
  problemValue?: boolean
}

const request = (line: ExampleLine) => line.request as { deployment: string; path?: string; route?: string }

/** URL をクエリと末尾の / を除いて比べる形にする（代わりの配備先の記録と同じ形）。 */
const normalize = (url: string) => url.split('?')[0].replace(/\/+$/, '')

/** 例の操作・配備（と path・route）に合う problems の項目。 */
function itemsOf(problems: CheckProblem[], line: ExampleLine): CheckProblem[] {
  const r = request(line)
  return problems.filter(
    (p) =>
      p.operation === line.operation &&
      p.deployment === r.deployment &&
      (r.path === undefined || p.path === r.path) &&
      (r.route === undefined || p.route === r.route),
  )
}

/** 見張りの配備を届かなくして道具を回し、機械向けの行が読めることを確かめる。 */
async function runWithWatch(rules: FakeHttpRule[], account: FakeAccount = {}): Promise<ProdCheckRun & { problems: CheckProblem[] }> {
  const run = await runProdCheck([{ url: `${await deploymentUrl(WATCH)}/api/health`, exit: UNREACHABLE }, ...rules], account)
  if (run.problems === null) throw new Unanswerable(`機械向けの 1 行が無い（終了の状態 ${run.code}、出力の末尾: ${run.stdoutTail.slice(0, 200)}）`)
  if (!run.problems.some((p) => p.deployment === WATCH)) throw new Unanswerable('見張りの配備の届かない死活確認が問題に挙がっていない')
  return { ...run, problems: run.problems }
}

/** 項目の有無が前提と合うか確かめる（合わなければ道具が受け取った答えを読めない）。 */
function expectItems(items: CheckProblem[], problemValue: boolean | undefined): void {
  if (problemValue && items.length === 0) throw new Unanswerable('前提の答えの値の問題を道具が挙げていない（受け取った答えを読めない）')
  if (!problemValue && items.length > 0) throw new Unanswerable(`前提の答えに問題の無い項目を、道具が名前の無い問題として挙げた: ${JSON.stringify(items)}`)
}

/**
 * 前提の答えを置いて道具を回し、道具が送った例の要求と、代わりの配備先がそれに返した物から答えを読む。
 * @implements REQ-567, REQ-568, REQ-569, REQ-570
 */
async function answerHttp(line: ExampleLine, premise: Premise, read: (call: HttpCall) => Record<string, unknown>): Promise<Answer> {
  const r = request(line)
  const method = premise.rule.method ?? 'GET'
  const url = normalize(`${await deploymentUrl(r.deployment)}${premise.rule.path}`)
  const run = await runWithWatch([{ ...premise.rule, url }])
  const sent = run.calls.filter((c): c is HttpCall => c.kind === 'http' && c.method === method && c.url === url)
  if (sent.length === 0) throw new Unanswerable(`道具が ${method} ${url} を送っていない（実装が応えなかった）`)
  const items = itemsOf(run.problems, line)
  const named = items.find((p) => typeof p.code === 'string' && p.code !== '')
  if (named) return { error: named.code! }
  expectItems(items, premise.problemValue)
  const call = sent[0]
  return { response: call.exit === 0 ? read(call) : {} }
}

/** 本文を JSON のオブジェクトとして読む（読めなければ空）。 */
const bodyOf = (call: HttpCall): Record<string, unknown> => {
  try {
    const value = JSON.parse(call.body) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const checkDeploymentHealth: Operation = async (line) => {
  const rule = line.case === 'noAnswer' ? { path: '/api/health', exit: UNREACHABLE } : { path: '/api/health', status: 200 }
  return answerHttp(line, { rule }, bodyOf)
}

const readDeploymentHealthHeaders: Operation = async (line) => {
  const headers = (call: HttpCall) => ({ headers: call.headers })
  if (line.case === 'noAnswer') return answerHttp(line, { rule: { path: '/api/health', exit: UNREACHABLE } }, headers)
  if (line.case === 'headerMissing') return answerHttp(line, { rule: { path: '/api/health', headers: HEADER_MISSING }, problemValue: true }, headers)
  return answerHttp(line, { rule: { path: '/api/health' } }, headers)
}

const openDeploymentEntry: Operation = async (line) => {
  const path = String(request(line).path)
  const status = (call: HttpCall) => ({ status: call.status })
  if (line.case === 'notOpenable') return answerHttp(line, { rule: { path, status: 404 } }, status)
  return answerHttp(line, { rule: { path, status: 200 } }, status)
}

const probeRetiredPasswordRoute: Operation = async (line) => {
  const path = `/api/auth/${String(request(line).route)}`
  const status = (call: HttpCall) => ({ status: call.status })
  if (line.case === 'noAnswer') return answerHttp(line, { rule: { method: 'POST', path, exit: UNREACHABLE } }, status)
  // 開いている経路は、空の本文を決められた形の外として断る（400）
  const code = line.case === 'registerOpen' ? 400 : 404
  return answerHttp(line, { rule: { method: 'POST', path, status: code }, problemValue: code !== 404 }, status)
}

/** listDeploymentSecretNames の例の名前 → 代わりの配備先のアカウントの前提（契約の errors の when）。 */
function accountPremise(line: ExampleLine): { account: FakeAccount; problemValue?: boolean } {
  const { deployment } = request(line)
  switch (line.case) {
    case 'noSecretsConfigured':
      return { account: { projects: { [deployment]: { names: [] } } }, problemValue: true }
    case 'wrongAccount':
      return { account: { accountId: OTHER_ACCOUNT, listExit: 1 } }
    case 'listUnavailable':
      return { account: { projects: { [deployment]: { exit: 1 } } } }
    case 'notLoggedIn':
      return { account: { loggedIn: false, listExit: 1 } }
    default:
      return { account: {} }
  }
}

/**
 * 前提のアカウントを置いて道具を回し、道具が送った一覧の取得と、代わりの配備先のアカウントがそれに返した物から答えを読む。
 * 断りの名前は、道具が代わりのアカウントに何か（ログイン中のアカウントの確認か、例の配備の一覧の取得）を送ったときだけ読む。
 * @implements REQ-567, REQ-568, REQ-569, REQ-570
 */
const listDeploymentSecretNames: Operation = async (line) => {
  const project = await projectOf(request(line).deployment)
  const premise = accountPremise(line)
  const run = await runWithWatch([], premise.account)
  const asked = run.calls.filter((c) => c.kind === 'wrangler' && (c.command === 'whoami' || c.project === project))
  if (asked.length === 0) throw new Unanswerable(`道具が配備先のアカウントに何も送っていない（${project} の一覧もアカウントの確認も無い）`)
  const items = itemsOf(run.problems, line)
  const named = items.find((p) => typeof p.code === 'string' && p.code !== '')
  if (named) return { error: named.code! }
  const list = run.calls.find((c) => c.kind === 'wrangler' && c.command === 'pages secret list' && c.project === project)
  if (!list || list.kind !== 'wrangler') throw new Unanswerable(`道具が ${project} の秘密の名前の一覧を取りに行っていない（実装が応えなかった）`)
  expectItems(items, premise.problemValue)
  return { response: list.exit === 0 ? { names: list.names } : {} }
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-015',
  parallel: true,
  operations: { checkDeploymentHealth, readDeploymentHealthHeaders, openDeploymentEntry, probeRetiredPasswordRoute, listDeploymentSecretNames },
})
