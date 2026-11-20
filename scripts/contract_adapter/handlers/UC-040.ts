/**
 * UC-040 の受け持ち（フィードバックを取り出して印を付ける道具 feedback ＝ `python3 scripts/feedback.py <command> [<学び>] [<id> ...] [--名前 ...]`）。
 * 入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行。request の各欄は同じ名前の引数（契約の先頭の決まり: command は
 * 第 1 引数、learning は第 2 引数、ids は続く引数、ほかは kit/td.ts の argsOf で `--名前`）。応答は終了の状態（契約の exitCode）。
 * 道具は断りの種類の名前を出さない（errors: []）。
 * 前提: 本番の保存先には届かせない。道具は実例ごとの影の根（kit/td.ts の projectShadow）で回し、配備の道具（wrangler・npx）は
 * 影の根の偽物が受ける（保存先は migrations を当てただけの空の SQLite）。
 * - ok（summary）: どの学びの保存先にもフィードバックが無い
 */

import { defineHandler, Unanswerable } from '../kit/protocol'
import { argsOf, inShadow } from '../kit/td'
import { toolAnswer } from '../kit/tool'

/** 契約の request を道具の引数にする。 */
function argumentsOf(request: Record<string, unknown> | null): string[] {
  const { command, learning, ids, ...rest } = request ?? {}
  return [
    ...(command === undefined ? [] : [String(command)]),
    ...(learning === undefined ? [] : [String(learning)]),
    ...(Array.isArray(ids) ? ids.map(String) : []),
    ...argsOf(rest),
  ]
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-040',
  parallel: true,
  operations: {
    feedback: async (line) => {
      if (line.case !== 'ok') throw new Unanswerable(`UC-040 feedback の例 ${line.case} の前提を知らない`)
      return inShadow({}, async (shadow) => {
        const run = await shadow.run(['python3', 'scripts/feedback.py', ...argumentsOf(line.request)], 120_000)
        return toolAnswer(run, (r) => ({ exitCode: r.code }))
      })
    },
  },
})
