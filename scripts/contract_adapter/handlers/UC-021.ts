/**
 * UC-021 の受け持ち（学び全体の門 checkRoadmap ＝ `python3 scripts/check_roadmap.py --data <学びの置き場> [--solutions <独立解答> ...]`）。
 * 入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行。引数は request の各欄と同じ名前（kit/td.ts の argsOf。
 * solutions は名前の後ろに値を並べる）。応答は標準出力の最後の行の JSON（kit/td.ts の answerOf。止める理由ありの 1 も応答）。
 *
 * 前提: 契約の実例は、リポジトリにある学びの置き場と fixture をそのまま名指す（data/itc・data/ip・
 * tests/fixtures/gate-no-roadmap/eng・tests/fixtures/gate-broken-roadmap/eng・data/itc/eval/ の独立解答）。
 * 道具は実例ごとの影の根（kit/td.ts の projectShadow）を作業ディレクトリにして回し、名指された学び（data/<key>）と
 * fixture だけを写す。前提の値を作らず、道具が写しを読んで返した物を答えにする。
 * - pass（ecl）: リポジトリの ecl の学び全体
 * - badArguments: 引数を渡さない
 * - unknownLearning（zzz）: 登録簿にも置き場にも無い学び
 * - notRoadmap（ip）・notRoadmapBeforeSolutionsMissing: リポジトリの ip（資格対策。ロードマップを持たない）
 * - roadmapMissing・roadmapUnreadable・roadmapUnreadableBeforeSolutionsMissing: tests/fixtures の置き場
 * - solutionsMissing（solve_Z.json は無い）・solutionsUnreadable（cycle_3.json は周の結果で、独立解答の形でない）
 */

import { defineHandler } from '../kit/protocol'
import { REPO_ROOT } from '../kit/tool'
import { answerOf, argsOf, inShadow } from '../kit/td'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** request が名指すパスから、写す学び（data/<key>）と fixture の置き場（tests/fixtures/<名前>）を引く。 */
function namedPlaces(request: Record<string, unknown> | null): { learnings: string[]; copy: string[] } {
  const paths = [request?.data, ...(Array.isArray(request?.solutions) ? (request.solutions as unknown[]) : [])].filter(
    (p): p is string => typeof p === 'string',
  )
  const learnings = new Set<string>()
  const copy = new Set<string>()
  for (const p of paths) {
    const learning = /^data\/([a-z]+)(?:\/|$)/.exec(p)?.[1]
    if (learning && existsSync(join(REPO_ROOT, 'data', learning))) learnings.add(learning)
    const fixture = /^(tests\/fixtures\/[^/]+)(?:\/|$)/.exec(p)?.[1]
    if (fixture && existsSync(join(REPO_ROOT, fixture))) copy.add(fixture)
  }
  return { learnings: [...learnings], copy: [...copy] }
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-021',
  parallel: true,
  operations: {
    checkRoadmap: async (line) =>
      inShadow(namedPlaces(line.request), async (shadow) =>
        answerOf(await shadow.run(['python3', 'scripts/check_roadmap.py', ...argsOf(line.request)], 120_000), [0, 1]),
      ),
  },
})
