/**
 * UC-019 の道具の中の読み書きの受け持ち（outbound の read…・write… の 19 操作）。
 *
 * 入口（CLAUDE.md の「操作 → 入口」の「道具の中の読み書き」、ADR-0013）: `@operation UC-019#<操作名>` を持つ
 * `scripts/` の Python の関数（操作名の snake_case）を、request の欄をキーワード引数にして呼ぶ（kit/py.ts）。
 * 作業ディレクトリは実例ごとの作業場所（kit/ta.ts の w/）。契約のパスは相対なら作業ディレクトリが起点。登録簿はリポジトリの物。
 *
 * 前提（実例ごとに作る。契約の操作の定義・errors の when・例の名前から導く）:
 * - ロードマップ型の学び eng の置き場は、契約の例が示す 1 単位の世界として書く（ロードマップ・今の確認問題・説明テストの語・
 *   配る本文・本文の図。中身は契約の readRoadmap・readRoadmapQuestions・readExplainTerms・readDeliveredBody の ok の例のまま）。
 *   ファイルの置き場所は道具を回す受け持ち（handlers/UC-019.ts）と同じ。
 * - 周の写し・周の結果・答え・説明テストの採点のファイルは、例の名前の条件に当たるように置く（無い・読めない・既にある）。
 *   中身を持つ物は契約の例のまま（周 6 の結果はリポジトリの data/eng/eval/cycle_6.json の写し）。
 * - 例が名指すリポジトリの作り物 tests/fixtures/learner-pack/<名前>/ は、同じ相対パスのまま写す。
 * - パックの部品（一覧・単位・確認問題・説明テスト）を書く例は、buildLearnerPack が部品を書く前に作るパックの出力先を空で置く。
 * - 学習者役への指示の雛形はリポジトリの scripts/prompts/roadmap_learner.md の写し。
 * - 学び ip は置かない（ロードマップ・確認問題・語の一覧・配る本文が無い学び）。
 */

import { mkdir } from 'node:fs/promises'
import { defineHandler, type ExampleLine } from '../kit/protocol'
import type { Place } from '../kit/ta'
import { BROKEN_JSON, copyFixtureDirs, ioEntry, type Preconditions } from '../kit/ta2'

const ENG = 'data/eng'
const TERM = 'コンピュータの 5 つの働き'
const FIELD = 'コンピュータの仕組み'

/** 契約の readRoadmap の ok の例が示すロードマップ（章で束ねる学び、1 単位）。 */
const ROADMAP = {
  group_by: 'chapter',
  units: [
    {
      order: 1,
      round: 1,
      chapter: 'コンピュータを形づくる部品',
      topic_id: 1,
      term: TERM,
      field: FIELD,
      middle: 'コンピュータを形づくる部品',
      summary: 'どんなコンピュータも、受け取る・覚える・…',
    },
  ],
}

/** 契約の readRoadmapQuestions の ok の例が示す今の確認問題。 */
const QUESTIONS = {
  bundle: 1,
  questions: [
    {
      qid: 't1-1',
      topic_id: 1,
      term: TERM,
      stem: '…',
      choices: { ア: '…', イ: '…', ウ: '…', エ: '…' },
      answer: 'イ',
      reason: '制御は部品の動く順と中身を指図する働きで…',
      choice_notes: { イ: '正解。どの部品がいつ動くかを決めて指図するのが制御に当たる。' },
      tests_goal: 1,
    },
  ],
}

/** 契約の readExplainTerms の ok の例が示す説明テストの語の一覧。 */
const EXPLAIN_TERMS = { terms: [{ term: TERM, goal: 1 }] }

/** 契約の readDeliveredBody の ok の例が示す配る本文（最も後の世代 materials_v3 に置く）。 */
const DELIVERED = {
  materials: [
    {
      topic_id: 1,
      term: TERM,
      explanation: `**${TERM}**は…`,
      detail: '### しくみ\n![…](/figures/materials/eng/1-1.svg)\n…',
    },
  ],
}

/** 契約の readPackSnapshot の ok の例が示す写しの中身（周の番号だけ置き場ごとに変える）。 */
const snapshotOf = (cycle: number) => ({
  cycle,
  units: [{ order: 1, topic_id: 1, term: TERM, field: FIELD }],
  questions: [{ qid: 't1-1', topic_id: 1, tests_goal: 1, field: FIELD, answer: 'イ' }],
})

/** 契約の readLearnerAnswers の ok の例が示す答え（data/eng/eval/learner_c7_answers.json）。 */
const ANSWERS_C7 = {
  answers: { 't17-1': 'ウ', 't17-2': 'ア' },
  units: [{ topic_id: 17, minutes: 6, understood: 3, confusing: '2 進数と 16 進数（単位名のみ）と少し混ざりかけた', unknown_terms: [] }],
}

/** 契約の readLearnerAnswers の looseRows の例が示す答え（行の中身は問わずに読む）。 */
const ANSWERS_C11 = { answers: {}, units: [{ understood: 3 }, { topic_id: '17' }, { topic_id: 999 }, { topic_id: 2, understood: 5 }] }

/** 契約の readExplainGrades の ok の例が示す採点。 */
const GRADES_C6 = { grades: { CPU: 2 } }

/** 学び eng の置き場（1 単位の世界）と本文の図の画像を書く。 */
async function engWorld(p: Place): Promise<void> {
  await p.writeJson(`${ENG}/roadmap.json`, ROADMAP)
  await p.writeJson(`${ENG}/roadmap_questions/bundle_01.json`, QUESTIONS)
  await p.writeJson(`${ENG}/explain_terms.json`, EXPLAIN_TERMS)
  await p.writeJson(`${ENG}/materials_v3/roadmap.json`, DELIVERED)
  await p.copyFromRepo('public/figures/materials/eng/1-1.svg')
}

const none = async () => {}
const eng = async (p: Place) => engWorld(p)
/** パックの部品を書く前提: 学び eng の置き場と、buildLearnerPack が部品を書く前に作るパックの出力先（空）。 */
const packOut = async (p: Place, line: ExampleLine) => {
  await engWorld(p)
  await mkdir(p.abs(String(line.request?.out)), { recursive: true })
}
/** 学びの置き場に、リポジトリの同じ相対パスのファイルを写す（読めない前提の Markdown など）。 */
const repoFile = (rel: string) => async (p: Place) => {
  await engWorld(p)
  await p.copyFromRepo(rel)
}
const engWith = (rel: string, content: string | object) => async (p: Place) => {
  await engWorld(p)
  if (typeof content === 'string') await p.write(rel, content)
  else await p.writeJson(rel, content)
}

/** 作り物の写しは、どの例でも先に済ませる。 */
const fixtures = (p: Place, line: ExampleLine) => copyFixtureDirs(p, line, 'learner-pack')
const io = (table: Preconditions) => ioEntry(table, fixtures)

/**
 * @implements REQ-567, REQ-570, REQ-579
 */
export default defineHandler({
  uc: 'UC-019',
  parallel: true,
  operations: {
    readLearnerTemplate: io({ ok: (p) => p.copyFromRepo('scripts/prompts/roadmap_learner.md') }),
    readRegistryLearning: io({ ok: none, notRoadmap: none, missing: none }),
    readRoadmap: io({ ok: eng, missing: none, unreadable: none }),
    readRoadmapQuestions: io({ ok: eng, missing: none, unreadable: none }),
    readExplainTerms: io({ ok: eng, missing: none, unreadable: none }),
    readDeliveredBody: io({ ok: eng, missing: none, unreadable: none }),
    readFigure: io({ ok: eng, okInFixture: none, missing: eng }),
    writePackRoadmap: io({ ok: packOut }),
    writePackUnit: io({ ok: packOut }),
    writePackQuiz: io({ ok: packOut }),
    writePackExplain: io({ ok: packOut }),
    writePackFigure: io({
      ok: eng,
      keepsSubpath: async (p) => {
        await engWorld(p)
        await p.copyFromRepo('public/figures/materials/eng/1-1.svg', 'public/figures/materials/eng/a/1-1.svg')
      },
      notDrawable: none,
      notWellFormed: none,
    }),
    readLearnerAnswers: io({
      looseRows: engWith('../learner_packs/eng_c11/learner_answers.json', ANSWERS_C11),
      ok: engWith(`${ENG}/eval/learner_c7_answers.json`, ANSWERS_C7),
      missing: eng,
      unreadable: repoFile(`${ENG}/eval/learner_c7_report.md`),
    }),
    readExplainGrades: io({
      ok: engWith(`${ENG}/eval/explain_c6_grade.json`, GRADES_C6),
      missing: eng,
      unreadable: repoFile(`${ENG}/eval/learner_c6_report.md`),
    }),
    readPackSnapshot: io({
      ok: engWith(`${ENG}/eval/pack_cycle_8.json`, snapshotOf(8)),
      missing: eng,
      unreadable: engWith(`${ENG}/eval/pack_cycle_12.json`, BROKEN_JSON),
    }),
    readCycleResult: io({
      ok: repoFile(`${ENG}/eval/cycle_6.json`),
      missing: eng,
      unreadable: engWith(`${ENG}/eval/cycle_14.json`, BROKEN_JSON),
    }),
    writePackSnapshot: io({
      exists: engWith(`${ENG}/eval/pack_cycle_6.json`, snapshotOf(6)),
      ok: eng,
    }),
    writeCycleResult: io({
      exists: repoFile(`${ENG}/eval/cycle_6.json`),
      ok: eng,
    }),
    writeLearnerInstructions: io({ ok: eng }),
  },
})
