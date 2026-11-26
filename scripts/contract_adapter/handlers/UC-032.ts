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
 *
 * 配備の手続き deployPages（`bash scripts/deploy-pages.sh <学び>`）と保存先の回の確かめ checkD1Rounds（`bash scripts/check_d1_rounds.sh <学び> [--local]`）は、
 * UC-032 のテストの影の根と偽の配備の道具（tests/server/UC-032_fixture.ts の makeShadow・runProcedure）で回す。配信と保存先は偽物が受け、
 * 外への通信は塞ぐ（REQ-569）。手続きの中で呼ぶ、別の契約が形を持つ門の道具は、通る包みにする（門の判定は各門の契約の実例が見る）。前提:
 * - deployPages の ok: 本番と手元の保存先はどちらも構造の変更がすべて当たった状態で、ログイン中のアカウントは配備を持つアカウント
 * - deployPages の pinnedToolMissing: 向け先のアカウントの環境変数を与えず、固定した版の配備の道具を影の根から除く（別の版の偽物だけが残る）
 * - deployPages の envAccountDiffersWithoutPinnedTool: 向け先のアカウントの環境変数に配備を持つアカウントと違う値を与え、固定した版の配備の道具を除く
 * - checkD1Rounds の ok: 手元の保存先の、学ぶ順を持つ論点のどれもが回を持つ
 */

import { copyFile, rm } from 'node:fs/promises'
import {
  makeShadow,
  OTHER_ACCOUNT,
  runProcedure,
  withoutPinnedTool,
  type Shadow,
  type StorageSpec,
  type World,
} from '../../../tests/server/UC-032_fixture'
import { defineHandler, type Answer, type Operation } from '../kit/protocol'
import { answerOf, argsOf, inShadow, premise, unknownCase } from '../kit/td'
import { toolErrorCode } from '../kit/tool'

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
 * 配備の手続きを、UC-032 のテストの影の根と偽の配備の道具で 1 回回し、答えに読む（断りの名前があれば断り、無ければ終了の状態）。
 * world は外の世界の決め方（向け先のアカウントの環境変数など）、prepare は回す前に影の根を前提の形にする手（固定した版の道具を除くなど）。
 * @implements REQ-567, REQ-569, REQ-570
 */
export async function runDeployProcedure(
  script: string,
  args: string[],
  storage: { remote?: StorageSpec; local?: StorageSpec } = {},
  world: World = {},
  prepare: (shadow: Shadow) => void = () => {},
): Promise<Answer> {
  const shadow = makeShadow('adapter', { copy: ['scripts', 'src', 'public', 'portal'], remote: storage.remote, local: storage.local })
  try {
    prepare(shadow)
    const run = await runProcedure(shadow, script, args, world)
    const code = toolErrorCode(run.out)
    if (code !== null) return { error: code }
    return { response: { exitCode: run.code } }
  } finally {
    await rm(shadow.dir, { recursive: true, force: true })
  }
}

const DEPLOY_PAGES_PREMISE: Record<string, { world: World; pinned: boolean }> = {
  ok: { world: {}, pinned: true },
  pinnedToolMissing: { world: { accountEnv: null }, pinned: false },
  envAccountDiffersWithoutPinnedTool: { world: { accountEnv: OTHER_ACCOUNT }, pinned: false },
}

const deployPages: Operation = (line) => {
  const premise = DEPLOY_PAGES_PREMISE[line.case]
  if (!premise) unknownCase(line)
  return runDeployProcedure(
    'deploy-pages.sh',
    argsOf(line.request, { positional: ['learning'] }),
    {},
    premise.world,
    premise.pinned ? undefined : withoutPinnedTool,
  )
}

const checkD1Rounds: Operation = (line) => {
  if (line.case !== 'ok') unknownCase(line)
  const topics = [
    { sortOrder: 1, round: 'day-01' },
    { sortOrder: 2, round: 'day-01' },
    { sortOrder: null, round: null },
  ]
  return runDeployProcedure('check_d1_rounds.sh', argsOf(line.request, { positional: ['learning'] }), { remote: { topics }, local: { topics } })
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-032',
  parallel: true,
  operations: { checkRoadmapRegistry, checkSource, seedRemote, deployPages, checkD1Rounds },
})
