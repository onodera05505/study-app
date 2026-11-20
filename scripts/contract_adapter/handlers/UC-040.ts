/**
 * UC-040 の受け持ち（フィードバックを取り出して印を付ける道具 feedback ＝ `python3 scripts/feedback.py <command> [<学び>] [<id> ...] [--名前 ...]`）。
 * 入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行。request の各欄は同じ名前の引数（契約の先頭の決まり: command は
 * 第 1 引数、learning は第 2 引数、ids は続く引数、ほかは kit/td.ts の argsOf で `--名前`）。応答は終了の状態（契約の exitCode）。
 * 道具は断りの種類の名前を出さない（errors: []）。
 * 前提: 本番の保存先には届かせない。道具は実例ごとの影の根（kit/td.ts の projectShadow）で回し、配備の道具（wrangler・npx）は
 * 影の根の偽物が受ける（保存先は migrations を当てただけの空の SQLite）。登録簿の学びの置き場（`data/<学び>`）はすべて写しにする
 * （道具は受け箱を `data/<学び>/feedback/` に書くので、本体の置き場へのリンクにしない）。
 * - ok（summary）: どの学びの保存先にもフィードバックが無い
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineHandler, Unanswerable } from '../kit/protocol'
import { argsOf, inShadow } from '../kit/td'
import { REPO_ROOT, toolAnswer } from '../kit/tool'

/** 登録簿（src/shared/targets.json）の学びのうち、リポジトリに置き場（data/<学び>）がある物。影の根では写しにする。 */
const LEARNINGS: string[] = Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'shared', 'targets.json'), 'utf8')) as Record<string, unknown>).filter(
  (key) => !key.startsWith('_') && existsSync(join(REPO_ROOT, 'data', key)),
)

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
      return inShadow({ learnings: LEARNINGS }, async (shadow) => {
        const run = await shadow.run(['python3', 'scripts/feedback.py', ...argumentsOf(line.request)], 120_000)
        return toolAnswer(run, (r) => ({ exitCode: r.code }))
      })
    },
  },
})
