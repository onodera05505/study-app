/**
 * UC-027 の受け持ち（作り手が手元で呼ぶ道具の入口 7 つ。local-store inbound）。
 *
 * 入口は CLAUDE.md の「操作 → 入口」の「道具を回す操作」の行（`scripts/<操作名を snake_case にした名前>`）と
 * 「道具の名前と違う操作」（checkFigureSpecs は render_material_figures.py、listDeliveredMaterials は material_generations.py）。
 * 引数は契約の先頭のコメント（request の各欄は同じ名前の引数、checkRender の learning だけは第 1 引数）。
 * 道具は実例ごとの影の根（kit/td.ts の projectShadow）を cwd にして回し、配備の道具（wrangler）は偽物に向ける。
 *
 * 前提（例の名前と契約の errors の when から）:
 * - 学びの置き場はリポジトリの今の写し。登録簿に無い学び（data/zzz）は、その断りだけに当たるよう資格対策の学び ip の写しを置く。
 *   学びの置き場が無い断り（NOT_FOUND）の例だけ、data/zzz を置かない
 * - 投入（seed.sql）は作業ツリーに追跡されないので、投入が要る例は影の根で組み立て（buildSeed）てから回す。組み立てた投入を読み・写すのは
 *   手元の物の土台（tests/server/UC-027_seed_fixture.local.ts）を通す
 * - planStops: 単元の構成の 1 つに、実在しない論点を足す（単元の構成の門の止める理由）
 * - withProblems・afterMissing: 論点 205 の図 1 の差し込み位置を、配る本文の教材に無い見出し `### しくみ` にする
 * - checkSeed の withProblems: 出典の試験名を登録簿の名前と違う名前にして組み立てた投入（--exam-name・--out）
 * - verifySeedRemote: ok は手元の保存先に組み立てた投入を流した状態、mismatch は本番の保存先（偽物）に何も流していない状態、
 *   seedMissing は突き合わせる投入が無い状態（投入を組み立てず、渡した投入のファイルも置かない）
 */

import { readdir } from 'node:fs/promises'
import { copySeed, readSeed } from '../../../tests/server/UC-027_seed_fixture.local'
import { defineHandler, type ExampleLine, type Operation } from '../kit/protocol'
import { answerOf, argsOf, flowInto, inShadow, premise, unknownCase, type ProjectShadow } from '../kit/td'

const py = (script: string, args: string[]) => ['python3', `scripts/${script}`, ...args]

/** 投入を組み立てる（前提）。 */
async function buildSeedIn(shadow: ProjectShadow, line: ExampleLine, data: string, extra: string[] = []): Promise<void> {
  premise(await shadow.run(py('build_seed.py', ['--data', data, ...extra])), `${data} の投入の組み立て`, line)
}

/** 論点 205 の図 1 の差し込み位置を、教材に無い見出しにする。 */
async function afterMissing(shadow: ProjectShadow, data: string): Promise<void> {
  const rel = `${data}/material_figures/205.json`
  const spec = await shadow.readJson(rel)
  const figure = (spec.figures as Array<Record<string, unknown>>).find((f) => f.id === 1)
  if (!figure) throw new Error('前提: 論点 205 の図 1 の仕様が無い')
  figure.after = '### しくみ'
  await shadow.writeJson(rel, spec)
}

/** 単元の構成の 1 つ（名前の順で最初）に実在しない論点を足す。 */
async function breakUnitPlan(shadow: ProjectShadow, data: string): Promise<void> {
  const files = (await readdir(shadow.path(`${data}/unit_plans`))).filter((n) => n.endsWith('.json')).sort()
  if (files.length === 0) throw new Error(`前提: ${data} に単元の構成が無い`)
  const rel = `${data}/unit_plans/${files[0]}`
  const plan = await shadow.readJson(rel)
  const groups = plan.groups as Array<{ topics: number[] }>
  groups[groups.length - 1].topics.push(999999)
  await shadow.writeJson(rel, plan)
}

const buildSeed: Operation = (line) => {
  const args = argsOf(line.request)
  switch (line.case) {
    case 'ok':
      return inShadow({ learnings: ['ip'] }, async (s) => answerOf(await s.run(py('build_seed.py', args))))
    case 'unchanged':
      return inShadow({ learnings: ['fe'] }, async (s) => answerOf(await s.run(py('build_seed.py', args))))
    case 'unknownLearning':
      return inShadow({}, async (s) => {
        await s.learning('ip', 'zzz')
        return answerOf(await s.run(py('build_seed.py', args)))
      })
    case 'planStops':
      return inShadow({ learnings: ['ap'] }, async (s) => {
        await breakUnitPlan(s, 'data/ap')
        return answerOf(await s.run(py('build_seed.py', args)))
      })
    case 'unknownLearningBeforePlanStops':
      return inShadow({}, async (s) => {
        await s.learning('ip', 'zzz')
        await breakUnitPlan(s, 'data/zzz')
        return answerOf(await s.run(py('build_seed.py', args)))
      })
    default:
      unknownCase(line)
  }
}

const attachMaterialFigures: Operation = (line) => {
  const args = argsOf(line.request)
  switch (line.case) {
    case 'ok':
      return inShadow({ learnings: ['ip'] }, async (s) => answerOf(await s.run(py('attach_material_figures.py', args)), [0, 1]))
    case 'withProblems':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        await afterMissing(s, 'data/ip')
        return answerOf(await s.run(py('attach_material_figures.py', args)), [0, 1])
      })
    case 'missing':
      return inShadow({}, async (s) => answerOf(await s.run(py('attach_material_figures.py', args)), [0, 1]))
    default:
      unknownCase(line)
  }
}

const checkFigureSpecs: Operation = (line) => {
  const args = argsOf(line.request)
  switch (line.case) {
    case 'ok':
      return inShadow({ learnings: ['ip'] }, async (s) => answerOf(await s.run(py('render_material_figures.py', args)), [0, 1]))
    case 'afterMissing':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        await afterMissing(s, 'data/ip')
        return answerOf(await s.run(py('render_material_figures.py', args)), [0, 1])
      })
    case 'missing':
      return inShadow({}, async (s) => answerOf(await s.run(py('render_material_figures.py', args)), [0, 1]))
    default:
      unknownCase(line)
  }
}

const checkRender: Operation = (line) => {
  const args = argsOf(line.request, { positional: ['learning'] })
  const run = (s: ProjectShadow) => s.run(['bash', 'scripts/check_render.sh', ...args], 120_000)
  switch (line.case) {
    case 'ok':
      return inShadow({ learnings: ['ip'] }, async (s) => answerOf(await run(s), [0, 1]))
    case 'unknownLearning':
      return inShadow({}, async (s) => {
        await s.learning('ip', 'zzz')
        return answerOf(await run(s), [0, 1])
      })
    default:
      unknownCase(line)
  }
}

const checkSeed: Operation = (line) => {
  const args = argsOf(line.request)
  const run = (s: ProjectShadow) => s.run(py('check_seed.py', args))
  switch (line.case) {
    case 'ok':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        await buildSeedIn(s, line, 'data/ip')
        return answerOf(await run(s), [0, 1])
      })
    case 'withProblems':
      return inShadow({ learnings: ['ap'] }, async (s) => {
        await buildSeedIn(s, line, 'data/ap', ['--exam-name', '登録簿と違う試験名', '--out', 'data/ap/seed_wrong_citation.sql'])
        return answerOf(await run(s), [0, 1])
      })
    case 'seedMissing':
      return inShadow({ learnings: ['ip'] }, async (s) => answerOf(await run(s), [0, 1]))
    case 'unknownLearning':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        await s.learning('ip', 'zzz')
        await buildSeedIn(s, line, 'data/ip')
        return answerOf(await run(s), [0, 1])
      })
    case 'seedMissingBeforeUnknownLearning':
      return inShadow({}, async (s) => {
        await s.learning('ip', 'zzz')
        return answerOf(await run(s), [0, 1])
      })
    default:
      unknownCase(line)
  }
}

const verifySeedRemote: Operation = (line) => {
  const args = argsOf(line.request)
  const run = (s: ProjectShadow) => s.run(py('verify_seed_remote.py', args), 120_000)
  switch (line.case) {
    case 'ok':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        await buildSeedIn(s, line, 'data/ip')
        flowInto(s.localDb, await readSeed(s.root, 'ip'))
        return answerOf(await run(s), [0, 1])
      })
    case 'mismatch':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        await buildSeedIn(s, line, 'data/ip')
        return answerOf(await run(s), [0, 1])
      })
    case 'seedMissing':
      // 学びの置き場の写しは投入を持たず、渡した投入のファイルも置かない
      return inShadow({ learnings: ['ip'] }, async (s) => answerOf(await run(s), [0, 1]))
    case 'unknownLearning':
      return inShadow({ learnings: ['ip'] }, async (s) => {
        await buildSeedIn(s, line, 'data/ip')
        await s.learning('ip', 'zzz')
        await copySeed(s.root, 'ip', 'zzz')
        return answerOf(await run(s), [0, 1])
      })
    default:
      unknownCase(line)
  }
}

const listDeliveredMaterials: Operation = (line) => {
  const args = argsOf(line.request)
  const run = (s: ProjectShadow) => s.run(py('material_generations.py', args))
  switch (line.case) {
    case 'ok':
    case 'refusalOnlyPasses':
      return inShadow({ learnings: ['ip'] }, async (s) => answerOf(await run(s)))
    case 'unknownLearning':
      return inShadow({}, async (s) => {
        await s.learning('ip', 'zzz')
        return answerOf(await run(s))
      })
    default:
      unknownCase(line)
  }
}

/**
 * @implements REQ-567, REQ-569, REQ-570
 */
export default defineHandler({
  uc: 'UC-027',
  parallel: true,
  operations: { buildSeed, attachMaterialFigures, checkFigureSpecs, checkRender, checkSeed, verifySeedRemote, listDeliveredMaterials },
})
