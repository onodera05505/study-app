/**
 * UC-032 の受け持ち（配備と投入の前に回す道具の入口 3 つ。local-store inbound）。
 *
 * 入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行（check_roadmap_registry.py・check_source.py・seed_remote.sh）。
 * 引数は契約の先頭のコメント（request の各欄は同じ名前の引数、learning は第 1 引数、seedRemote の local は第 2 引数の --local）。
 * 道具は実例ごとの影の根（kit/td.ts の projectShadow）を cwd にして、影の根の scripts の写しを回す。
 *
 * seedRemote は本番に触る手続きなので、配備の道具（wrangler）は影の根の node_modules・PATH・npx の先のどれも偽物にし、
 * 保存先は偽物が受ける 2 つの SQLite（本番と手元）にする。手続きの中の流す前の投入の検査と投入後の突き合わせは
 * 写しの本物を回す。前提（例の名前と契約の errors の when から）:
 * - ok: 組み立てたあと（影の根で ip の投入を組み立てる）。保存先は構造の変更がすべて当たった状態
 * - unknownLearning: 登録簿に無い学び zzz の置き場に、組み立てた投入を置く（その断りだけに当たる）
 * - seedMissing・mistypedLocalBeforeSeedMissing: fe の置き場の写しに投入を置かない（組み立てる前）
 */

import { copyFile } from 'node:fs/promises'
import { defineHandler, type Operation } from '../kit/protocol'
import { answerOf, argsOf, inShadow, premise, unknownCase } from '../kit/td'

const checkRoadmapRegistry: Operation = (line) => {
  if (!['ok', 'okQualification', 'noLearning', 'unknownLearning'].includes(line.case)) unknownCase(line)
  const args = argsOf(line.request, { positional: ['learning'] })
  return inShadow({}, async (s) => answerOf(await s.run(['python3', 'scripts/check_roadmap_registry.py', ...args]), [0, 1]))
}

const checkSource: Operation = (line) => {
  if (!['ok', 'unknownArgument'].includes(line.case)) unknownCase(line)
  const args = argsOf(line.request)
  return inShadow({}, async (s) => answerOf(await s.run(['python3', 'scripts/check_source.py', ...args]), [0, 1]))
}

const seedRemote: Operation = (line) => {
  const args = argsOf(line.request, { positional: ['learning'] })
  const run = (s: Parameters<Parameters<typeof inShadow>[1]>[0]) => s.run(['bash', 'scripts/seed_remote.sh', ...args], 180_000)
  switch (line.case) {
    case 'ok':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        premise(await s.run(['python3', 'scripts/build_seed.py', '--data', 'data/ip']), 'ip の投入の組み立て', line)
        return answerOf(await run(s), [0, 1])
      })
    case 'unknownLearning':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        premise(await s.run(['python3', 'scripts/build_seed.py', '--data', 'data/ip']), 'ip の投入の組み立て', line)
        await s.learning('ip', 'zzz')
        await copyFile(s.path('data/ip/seed.sql'), s.path('data/zzz/seed.sql'))
        return answerOf(await run(s), [0, 1])
      })
    case 'seedMissing':
    case 'mistypedLocalBeforeSeedMissing':
      return inShadow({ learnings: ['fe'] }, async (s) => answerOf(await run(s), [0, 1]))
    default:
      unknownCase(line)
  }
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-032',
  parallel: true,
  operations: { checkRoadmapRegistry, checkSource, seedRemote },
})
