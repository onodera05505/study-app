/**
 * UC-019 の受け持ち（道具を回す 3 操作。outbound の read…・write… は持たない）。
 *
 * 入口（CLAUDE.md の「操作 → 入口」）: buildLearnerPack ＝ `scripts/build_learner_pack.py`、
 * gradeLearnerAnswers ＝ `scripts/grade_learner.py`、renderLearnerInstructions ＝ `scripts/render_prompts.py`。
 * request の欄は欄の名前のままの長い名前の引数、作業ディレクトリは実例ごとの作業場所（kit/ta.ts）。登録簿はリポジトリの物。
 *
 * 前提（実例ごとに作る）:
 * - ロードマップ型の学び eng は、リポジトリの data/eng を単位の ID の集まりで絞った写しにする（ロードマップの単位・今の確認問題・
 *   配る本文・説明テストの語・本文の図）。集まりは実例の応答が並べる単位（パックは単位 1、採点は単位 1 と 2）。
 * - 採点の前提の写し（eval/pack_cycle_<周>.json）は、絞った eng のロードマップと今の確認問題から契約の PackSnapshot の形で書く。
 * - 答えのファイルは実例の名前ごとに決める。eng_c11 の中身は契約の readLearnerAnswers の looseRows の例のまま。
 * - 契約の例が名指す作り物 tests/fixtures/learner-pack/<名前>/ は、同じ相対パスのまま作業場所へ写す。
 * - 例の request がリポジトリの data/eng/eval の答えを指すときは、そのファイルを写す。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { inPlace, type Place } from '../kit/ta'
import { REPO_ROOT } from '../kit/tool'

type Json = any

const ENG = 'data/eng'

/** リポジトリの data/eng を単位の ID の集まりで絞って、作業場所の data/eng に写す。 */
async function engWorld(place: Place, ids: number[]): Promise<{ units: Json[]; questions: Json[] }> {
  const read = async (rel: string) => JSON.parse(await readFile(join(REPO_ROOT, rel), 'utf8'))
  const keep = new Set(ids)

  const roadmap = await read(`${ENG}/roadmap.json`)
  const units = (roadmap.units as Json[]).filter((u) => keep.has(u.topic_id))
  await place.writeJson(`${ENG}/roadmap.json`, { ...roadmap, units })

  const questions: Json[] = []
  for (const name of (await readdir(join(REPO_ROOT, ENG, 'roadmap_questions'))).filter((n) => n.endsWith('.json')).sort()) {
    const bundle = await read(`${ENG}/roadmap_questions/${name}`)
    questions.push(...(bundle.questions as Json[]).filter((q) => keep.has(q.topic_id)))
  }
  await place.writeJson(`${ENG}/roadmap_questions/bundle_01.json`, { bundle: 1, questions })

  const delivered = await read(`${ENG}/materials_v3/roadmap.json`)
  const materials = (delivered.materials as Json[]).filter((m) => keep.has(m.topic_id))
  await place.writeJson(`${ENG}/materials_v3/roadmap.json`, { ...delivered, materials })

  const explain = await read(`${ENG}/explain_terms.json`)
  const terms = new Set(units.map((u) => u.term))
  await place.writeJson(`${ENG}/explain_terms.json`, { ...explain, terms: (explain.terms as Json[]).filter((t) => terms.has(t.term)) })

  for (const m of materials) {
    for (const [, sub] of `${m.explanation}\n${m.detail}`.matchAll(/\(\/figures\/materials\/eng\/([^)\s]+)\)/g)) {
      await place.copyFromRepo(`public/figures/materials/eng/${sub}`)
    }
  }
  return { units, questions }
}

/** 絞った eng から、その周のパックの写し（契約の PackSnapshot）を書く。 */
async function writeSnapshot(place: Place, cycle: number, world: { units: Json[]; questions: Json[] }) {
  const fieldOf = new Map(world.units.map((u) => [u.topic_id, u.field]))
  await place.writeJson(`${ENG}/eval/pack_cycle_${cycle}.json`, {
    cycle,
    units: world.units.map((u) => ({ order: u.order, topic_id: u.topic_id, term: u.term, field: u.field })),
    questions: world.questions.map((q) => ({ qid: q.qid, topic_id: q.topic_id, tests_goal: q.tests_goal, field: fieldOf.get(q.topic_id), answer: q.answer })),
  })
}

/** 契約の例が名指す作り物（tests/fixtures/learner-pack/<名前>/）を、request の data から引いて写す。 */
async function copyFixtureOf(place: Place, line: ExampleLine) {
  const data = String(line.request?.data ?? '')
  const m = /^(tests\/fixtures\/learner-pack\/[a-z0-9-]+)\//.exec(data)
  if (m) await place.copyFromRepo(m[1])
}

/** request の answers がリポジトリの data/eng/eval の答えを指すとき、そのファイルを写す。 */
async function copyRepoAnswers(place: Place, line: ExampleLine) {
  const answers = line.request?.answers
  if (typeof answers === 'string' && answers.startsWith(`${ENG}/eval/`)) await place.copyFromRepo(answers)
}

const BROKEN_JSON = '{ "cycle": \n'

// ---- buildLearnerPack ----

/** 例の名前 → 前提。共通の前提（作り物の写し）は呼ぶ前に済ませる。 */
const PACK: Record<string, (place: Place) => Promise<void>> = {
  ok: async (p) => void (await engWorld(p, [1])),
  badArguments: async (p) => void (await engWorld(p, [1])),
  notRoadmap: async () => {},
  outInsideData: async (p) => void (await engWorld(p, [1])),
  outInsideOtherLearning: async (p) => void (await engWorld(p, [1])),
  outNotEmpty: async (p) => {
    await engWorld(p, [1])
    await p.write('docs/memo.txt', '既にある中身\n')
  },
  sameCycle: async (p) => {
    await engWorld(p, [1])
    await p.copyFromRepo(`${ENG}/eval/cycle_6.json`)
  },
  questionsMissing: async () => {},
  questionsUnreadable: async () => {},
  explainTermsUnreadable: async () => {},
  roadmapRowBroken: async () => {},
  materialsUnreadable: async () => {},
  bodyMissing: async () => {},
  figureMissing: async () => {},
  figureNameCollision: async () => {},
  figureNotWellFormed: async () => {},
  figureNotDrawable: async () => {},
  abbreviatedArgument: async (p) => void (await engWorld(p, [1])),
  figureLineMalformed: async () => {},
  bodyMissingBeforeFigureLineMalformed: async () => {},
  figureLineMalformedBeforeFigureMissing: async () => {},
  badArgumentsBeforeNotRoadmap: async () => {},
  notRoadmapBeforeOutInside: async () => {},
  outInsideBeforeSameCycle: async (p) => {
    await engWorld(p, [1])
    await p.copyFromRepo(`${ENG}/eval/cycle_6.json`)
  },
}

// ---- gradeLearnerAnswers ----

/** 周 8 の答え: 単位 1 は 2 問のうち 1 問、単位 2 は 2 問とも正しい。理解の段は単位 1 だけ、単位 2 は分だけを書く。 */
const ANSWERS_C8 = {
  answers: { 't1-1': 'イ', 't1-2': 'イ', 't2-1': 'イ', 't2-2': 'ア' },
  units: [{ topic_id: 1, understood: 3 }, { topic_id: 2, minutes: 4 }],
}
/** 周 9 の答え: t1-1・t1-2・t2-1 の選んだ答えが、正解の並びを 1 つずらした並び。 */
const ANSWERS_C9 = {
  answers: { 't1-1': 'ウ', 't1-2': 'イ', 't2-1': 'エ', 't2-2': 'ア' },
  units: [{ topic_id: 1, understood: 3 }, { topic_id: 2, understood: 3 }],
}
/** 周 10 の答え: t1-1・t1-2・t2-1 は誤答だが、選んだ答えをずらしても正解の並びに重ならない。 */
const ANSWERS_C10 = {
  answers: { 't1-1': 'ウ', 't1-2': 'ウ', 't2-1': 'ウ', 't2-2': 'ア' },
  units: [{ topic_id: 1, understood: 3 }, { topic_id: 2, understood: 3 }],
}
/** 周 11 の答え（契約の readLearnerAnswers の looseRows の例）。 */
const ANSWERS_C11 = { answers: {}, units: [{ understood: 3 }, { topic_id: '17' }, { topic_id: 999 }, { topic_id: 2, understood: 5 }] }
/** 周 14 の答え: t1-2 に選択肢の外の答え。 */
const ANSWERS_C14 = { answers: { 't1-1': 'イ', 't1-2': 'オ', 't2-1': 'イ', 't2-2': 'ア' }, units: [] }

/** 説明テストの採点: 2 語のうち 1 語が 2 点、1 語が 1 点。 */
const EXPLAIN_C8 = { grades: { 'コンピュータの 5 つの働き': 2, CPU: 1 } }

/** 周の写しと答えをそろえた採点の前提。 */
const graded =
  (cycle: number, answers: Json | null, extra: (p: Place) => Promise<void> = async () => {}) =>
  async (p: Place, line: ExampleLine) => {
    const world = await engWorld(p, [1, 2])
    await writeSnapshot(p, cycle, world)
    if (answers !== null) await p.writeJson(String(line.request?.answers), answers)
    await extra(p)
  }

const GRADE: Record<string, (place: Place, line: ExampleLine) => Promise<void>> = {
  ok: graded(8, ANSWERS_C8),
  okWithExplain: graded(8, ANSWERS_C8, (p) => p.writeJson('../learner_packs/eng_c8/explain_grade.json', EXPLAIN_C8)),
  shiftSuspect: graded(9, ANSWERS_C9),
  notShiftSuspect: graded(10, ANSWERS_C10),
  badArguments: async (p) => void (await engWorld(p, [1, 2])),
  previousResultUnreadable: graded(15, ANSWERS_C8, (p) => p.write(`${ENG}/eval/cycle_14.json`, BROKEN_JSON)),
  notRoadmap: async () => {},
  questionsMissing: async () => {},
  questionsUnreadable: async () => {},
  noSnapshot: async (p) => void (await engWorld(p, [1, 2])),
  snapshotUnreadable: async (p, line) => {
    await engWorld(p, [1, 2])
    await p.write(`${ENG}/eval/pack_cycle_12.json`, BROKEN_JSON)
    await p.writeJson(String(line.request?.answers), ANSWERS_C8)
  },
  resultExists: graded(8, ANSWERS_C8, (p) => p.copyFromRepo(`${ENG}/eval/cycle_8.json`)),
  answersMissing: graded(13, null),
  answerOutOfChoices: graded(14, ANSWERS_C14),
  selfReportRows: graded(11, ANSWERS_C11),
  notRoadmapBeforeNoSnapshot: async () => {},
  noSnapshotBeforeResultExists: async (p) => {
    await engWorld(p, [1, 2])
    await p.copyFromRepo(`${ENG}/eval/cycle_6.json`)
  },
}

// ---- renderLearnerInstructions ----

const RENDER: Record<string, (place: Place) => Promise<void>> = {
  ok: (p) => p.copyFromRepo('data/itc/roadmap.json'),
  okChapter: async (p) => void (await engWorld(p, [1, 2])),
  placeholderUnfilled: async () => {},
  badArguments: async () => {},
  unknownLearning: async () => {},
  notRoadmap: async () => {},
  badArgumentsBeforeNotRoadmap: async () => {},
}

/** 例の名前から前提を引き、作業場所で道具を回す。 */
function entry(script: string, table: Record<string, (place: Place, line: ExampleLine) => Promise<void>>): Operation {
  return (line) => {
    const prepare = table[line.case]
    if (!prepare) throw new Unanswerable(`${line.operation}.${line.case}: 前提を決められない例の名前`)
    return inPlace(line, script, async (place) => {
      await copyFixtureOf(place, line)
      await copyRepoAnswers(place, line)
      await prepare(place, line)
    })
  }
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-019',
  parallel: true,
  operations: {
    buildLearnerPack: entry('build_learner_pack.py', PACK),
    gradeLearnerAnswers: entry('grade_learner.py', GRADE),
    renderLearnerInstructions: entry('render_prompts.py', RENDER),
  },
})
