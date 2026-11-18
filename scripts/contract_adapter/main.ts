/**
 * 契約の実例を実装に渡す受け渡し役（contract-run のアダプター。`npx tsx scripts/contract_adapter/main.ts` で回す）。
 *
 * 標準入力の 1 行が 1 実例（UC-033 の契約 ExampleLine）。UC ごとの受け持ち `handlers/UC-nnn.ts` に振り分け、
 * 1 実例に 1 行の答え `{"id","response"}` か `{"id","error"}` を標準出力に返す。自分の出力はすべて標準エラーへ。
 *
 * - 受け持ちは、入力に来た UC のファイル `handlers/UC-nnn.ts`（操作を分けて置くなら `handlers/UC-nnn.<名前>.ts` も）だけを
 *   読み込む（ファイルを置けば拾われる。書き方は kit/protocol.ts）。
 * - JSON として読めない行、受け持ちの無い UC・操作の行が 1 つでもあれば、どの実例も回さず、その行を標準エラーに挙げて
 *   0 でない終了の状態で終える（UC-033 の契約の INVALID_INPUT）。
 * - 道具が断りの名前を出さずに 0 でない終了の状態で止まった実例・実装が名前の無い断りの応答を返した実例には、
 *   実装が返した物を、終了の状態や状態の番号を最上位に持たない入れ物に入れて答える（形は kit/protocol.ts の項目 2）。
 *   確かめがその実例を合わない物として挙げる。
 * - 受け持ちが実装に渡せなかった実例（実装が何も返さない（名前の無い例外・時間切れ）か、前提を作れないとき。
 *   Unanswerable などで投げた物）には答えを書かず、ほかを回し終えてから
 *   その実例を標準エラーの末尾に挙げて 0 でない終了の状態で終える（contract-run は標準エラーの末尾 20 行を見せる）。
 * - 起こした子のプロセスは受け渡し役より長く残さない。contract-run が時間切れで受け渡し役を止めたら（起こした側が
 *   居なくなったら）、子をプロセスグループごと止めて終える（kit/tool.ts の bindToCaller）。
 * - 回し始める実例ごとに「▶ UC 操作.例の名前」を標準エラーに出す（時間切れのときにどこで止まったかが分かる）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { blockedAttempts, sealOutside } from './kit/outside'
import { bindToCaller } from './kit/tool'
import type { Answer, ExampleLine, Handler } from './kit/protocol'

const HANDLERS_DIR = join(import.meta.dirname, 'handlers')

const say = (text: string) => process.stderr.write(`${text}\n`)
const label = (line: ExampleLine) => `${line.uc} ${line.operation}.${line.case}`

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** UC の受け持ちを読み込み、操作を 1 つにまとめる（`UC-nnn.ts` と、操作を分けて置く `UC-nnn.<名前>.ts`）。 */
async function loadHandler(uc: string): Promise<Handler | null> {
  const files = existsSync(HANDLERS_DIR)
    ? readdirSync(HANDLERS_DIR).filter((name) => name === `${uc}.ts` || (name.startsWith(`${uc}.`) && name.endsWith('.ts')))
    : []
  if (files.length === 0) return null
  const merged: Handler = { uc, operations: {} }
  const parallel = new Set<string>()
  for (const name of files.sort()) {
    const handler = ((await import(pathToFileURL(join(HANDLERS_DIR, name)).href)) as { default?: Handler }).default
    if (!handler || handler.uc !== uc) throw new Error(`handlers/${name} の default export が ${uc} の受け持ちでない`)
    for (const [operation, run] of Object.entries(handler.operations)) {
      if (merged.operations[operation]) throw new Error(`${uc} の操作 ${operation} を 2 つのファイルが受け持っている（handlers/${name}）`)
      merged.operations[operation] = run
      if (handler.parallel) parallel.add(operation)
    }
  }
  merged.parallelOperations = parallel
  return merged
}

/**
 * 標準入力の実例を受け持ちに振り分けて回し、答えを返す。
 * @operation UC-033#answerContractExamples
 * @implements REQ-567, REQ-568, REQ-569, REQ-570
 */
export async function answerContractExamples(input: string): Promise<number> {
  sealOutside()
  const lines: ExampleLine[] = []
  const refused: string[] = []
  input.split('\n').forEach((text, index) => {
    if (text.trim() === '') return
    try {
      lines.push(JSON.parse(text) as ExampleLine)
    } catch {
      refused.push(`${index + 1} 行目が JSON として読めない: ${text.slice(0, 80)}`)
    }
  })

  const handlers = new Map<string, Handler | null>()
  for (const uc of new Set(lines.map((line) => line.uc))) handlers.set(uc, await loadHandler(uc))
  for (const line of lines) {
    const handler = handlers.get(line.uc)
    if (!handler) refused.push(`受け持ちの無い UC: ${label(line)}（handlers/${line.uc}.ts が無い）`)
    else if (!handler.operations[line.operation]) refused.push(`受け持ちの無い操作: ${label(line)}`)
  }
  if (refused.length > 0) {
    say(`INVALID_INPUT: 当たる入口の無い行が ${refused.length} 件ある。どの実例も回さない`)
    for (const text of refused.slice(0, 18)) say(`  ${text}`)
    return 2
  }

  const failed: string[] = []
  const answer = async (line: ExampleLine) => {
    say(`▶ ${label(line)}`)
    let result: Answer
    try {
      result = await handlers.get(line.uc)!.operations[line.operation](line)
    } catch (error) {
      failed.push(`${label(line)}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    process.stdout.write(`${JSON.stringify({ id: line.id, ...result })}\n`)
  }

  const isParallel = (line: ExampleLine) => handlers.get(line.uc)!.parallelOperations?.has(line.operation) ?? false
  const serial = lines.filter((line) => !isParallel(line))
  const parallel = lines.filter(isParallel)
  const runSerial = async () => {
    for (const line of serial) await answer(line)
  }
  // 並行の受け持ちの同時数は kit/tool.ts の runTool が絞るので、ここでは全部を一度に始める
  await Promise.all([runSerial(), ...parallel.map(answer)])

  const attempts = blockedAttempts()
  if (attempts.length > 0) say(`外へ出ようとして塞いだ要求が ${attempts.length} 件: ${[...new Set(attempts)].slice(0, 3).join(' / ')}`)
  if (failed.length > 0) {
    say(`実装に渡せなかった実例が ${failed.length} 件（答えを返していない）:`)
    for (const text of failed.slice(-18)) say(`  ${text}`)
    return 1
  }
  return 0
}

bindToCaller()
process.exitCode = await answerContractExamples(await readStdin())
// 実装が残したタイマーなどで終われないときも、答えを書き終えたら終える
setTimeout(() => process.exit(), 2000).unref()
