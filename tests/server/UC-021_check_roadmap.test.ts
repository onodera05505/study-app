import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  BANNED, BROKEN_MATERIAL_FILE, BROKEN_QUESTION_FILE, DUPLICATE_MATERIAL_FILE, KINDS, LIMITS, REGISTRY, SUPPLEMENT,
  acceptAt, acceptedEng, cleanupWorkspaces, addSupplement, allQuestions, answersWith, bannedAt, bannedMsg, cleanEng, cleanMsg, cluedEng, errorCode,
  findingsAbout, learning, materialAt, once, perfectAnswers, questionsAt, runGate, runIn, stopAt, stoppedEng, unitAt, unitNeedles,
  warnAt, warnedEng, workspace, writeLearning,
  type Json, type Learning, type Question, type Run, type StopDefect, type WarnPlace,
  CHOICES, wrongOf,
} from './UC-021_fixture'

/** UC-021 ロードマップ型の学び全体を教材の門にかける入口（checkRoadmap ＝ `python3 scripts/check_roadmap.py --data <学びの置き場> [--solutions ...]`）の境界。
 *  仕込みは一時の作業場の学び（UC-021_fixture.ts）。観測するのは終了の状態と、標準出力の最後の行の機械向けの 1 行だけ。
 *  同じ仕込みで確かめられるクラスは、1 回の実行の結果を使い回す（once）。 */

vi.setConfig({ testTimeout: 60_000 })
afterAll(cleanupWorkspaces)

const CLEAN = once(() => runGate(cleanEng()))
const CLEAN_MSG = once(() => runGate(cleanMsg()))
const STOPPED_L = once(() => stoppedEng())
const STOPPED = once(() => runGate(STOPPED_L()))
const BANNED_L = once(() => bannedMsg())
const BANNED_RUN = once(() => runGate(BANNED_L()))
const WARNED_L = once(() => warnedEng())
const WARNED = once(() => runGate(WARNED_L()))
const ACCEPTED_L = once(() => acceptedEng())
const ACCEPTED = once(() => runGate(ACCEPTED_L()))
const SUPPLEMENTED = once(() => {
  const l = learning('eng', 12)
  const s = addSupplement(l)
  return { l, s, r: runGate(l) }
})
const CLUED_L = once(() => cluedEng(10, true))
const CLUED = once(() => runGate(CLUED_L()))
const FEW = once(() => runGate(cluedEng(9, false)))

/** 独立解答を添えた学び（eng 10 単位、20 問）。 */
const SOLVED_L = once(() => learning('eng', 10))
const SOLVED_WITHIN = once(() => runGate(SOLVED_L(), { 'solve_perfect.json': { answers: perfectAnswers(SOLVED_L()) }, 'solve_four.json': answersWith(SOLVED_L(), 4) }))
const SOLVED_OVER = once(() =>
  runGate(SOLVED_L(), {
    'solve_perfect.json': { answers: perfectAnswers(SOLVED_L()) },
    'solve_five.json': answersWith(SOLVED_L(), 5),
    'solve_blank.json': answersWith(SOLVED_L(), 4, 1),
  }),
)
const SOLVED_SUPPLEMENT = once(() => {
  const l = learning('eng', 10)
  const s = addSupplement(l)
  const a = answersWith(l, 4)
  for (const q of l.questions[SUPPLEMENT.file]) a.answers[q.qid] = q.answer === 'エ' ? 'ア' : 'エ'
  return { s, r: runGate(l, { 'solve_supp.json': a }) }
})

/** 通した応答（終了の状態 0、機械向けの 1 行の exitCode 0、止める理由 0 件）。 */
function expectPassed(r: Run) {
  expect(r.json, `機械向けの 1 行が無い: ${r.stdout.slice(-400)}${r.stderr.slice(-400)}`).not.toBeNull()
  expect(r.json.stops, JSON.stringify(r.json.stops)).toEqual([])
  expect(r.json.exitCode).toBe(0)
  expect(r.code).toBe(0)
}
/** 止めた応答で、kind の止める理由が needles のどれかを挙げていること。 */
function expectStop(r: Run, kind: string, ...needles: (string | number)[]) {
  expect(r.json, `機械向けの 1 行が無い: ${r.stdout.slice(-400)}${r.stderr.slice(-400)}`).not.toBeNull()
  expect(r.code).toBe(1)
  expect(r.json.exitCode).toBe(1)
  const hits = findingsAbout(r.json.stops, kind, ...needles)
  expect(hits.length, `${kind} の止める理由が ${needles.join('・')} を挙げていない: ${JSON.stringify(r.json.stops)}`).toBeGreaterThan(0)
}
/** 止めずに、kind の警告が needles のどれかを挙げていること。 */
function expectWarning(r: Run, kind: string, ...needles: (string | number)[]) {
  expectPassed(r)
  const hits = findingsAbout(r.json.warnings, kind, ...needles)
  expect(hits.length, `${kind} の警告が ${needles.join('・')} を挙げていない: ${JSON.stringify(r.json.warnings)}`).toBeGreaterThan(0)
}
/** 止める理由にも警告にも、needles を挙げた指摘が無いこと（kinds を渡せばその種類だけを見る）。 */
function expectNotFlagged(r: Run, needles: (string | number)[], kinds: string[] | null = null) {
  expect(r.json, `機械向けの 1 行が無い: ${r.stdout.slice(-400)}${r.stderr.slice(-400)}`).not.toBeNull()
  const all: Json[] = [...(r.json.stops ?? []), ...(r.json.warnings ?? [])]
  const hits = all.filter((f) => (kinds === null || kinds.includes(f.kind)) && findingsAbout([f], null, ...needles).length > 0)
  expect(hits, `${needles.join('・')} を挙げた指摘がある`).toEqual([])
}
/** 何も確かめずに断った応答（断りの名前が code で、止める理由も警告も返さない）。 */
function expectRefused(r: Run, code: string) {
  expect(errorCode(r), `断りの名前が無い: ${r.stdout.slice(-400)}${r.stderr.slice(-400)}`).toBe(code)
  expect(r.code).not.toBe(0)
  expect(r.json?.stops, '断ったのに止める理由を返した').toBeUndefined()
  expect(r.json?.warnings, '断ったのに警告を返した').toBeUndefined()
}
const stopUnit = (d: StopDefect) => unitNeedles(unitAt(STOPPED_L(), stopAt(d)))
const warnUnit = (p: WarnPlace) => unitNeedles(unitAt(WARNED_L(), warnAt(p)))
const qidAt = (l: Learning, i: number, n = 0) => questionsAt(l, i)[n].qid
/** 場合の名前を付けて失敗を投げ直す。 */
function labelled(label: string, f: () => void) {
  try {
    f()
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`)
  }
}

describe('UC-021 ロードマップ型の学び全体を配る前に教材の門で確かめる（checkRoadmap）', () => {
  describe('止める理由が無ければ警告の有無によらず通し、見た数と警告を返す（REQ-374）', () => {
    // @covers REQ-374#pass-without-solutions
    it('止める理由の無い学び全体を、独立解答を添えずにかけると通し、警告も無い', () => {
      const r = CLEAN()
      expectPassed(r)
      expect(r.json.warnings).toEqual([])
    })
    // @covers REQ-374#pass-with-solutions
    it('食い違いが閾値の内の独立解答を添えてかけると通す', () => {
      expectPassed(SOLVED_WITHIN())
    })
    // @covers REQ-374#pass-with-warnings
    it('警告だけが当たる学び全体は通し、警告ごとに種類と箇所を返す', () => {
      const r = WARNED()
      expectPassed(r)
      expect(r.json.warnings.length).toBeGreaterThan(0)
      for (const f of r.json.warnings) {
        expect(typeof f.kind === 'string' && f.kind.length > 0, JSON.stringify(f)).toBe(true)
        expect(typeof f.where === 'string' && f.where.length > 0, JSON.stringify(f)).toBe(true)
      }
    })
    // @covers REQ-374#counts
    it('見た論点の数はロードマップの単位の数、問題の数はその単位の確認問題の数で、補足の論点は数えない', () => {
      const { l, r } = SUPPLEMENTED()
      expect(r.json?.topics, r.stdout.slice(-400)).toBe(l.roadmap.units.length)
      expect(r.json.questions).toBe(allQuestions(l).length)
    })
  })

  describe('登録簿に無い学び・ロードマップ型でない学び・ロードマップが無いか読めない学びは何も確かめずに断る（REQ-375）', () => {
    // @covers REQ-375#unknown-learning
    it('登録簿に無い学び（zzz）は INVALID_INPUT で断る', () => {
      const dir = workspace()
      writeLearning(dir, learning('eng', 6), 'data/zzz')
      expectRefused(runIn(dir, 'data/zzz'), 'INVALID_INPUT')
    })
    // @covers REQ-375#exam-learning
    it('資格対策の学び（ip）は、ロードマップ型の置き場の形を持っていても INVALID_INPUT で断る', () => {
      const dir = workspace()
      writeLearning(dir, learning('eng', 6), 'data/ip')
      expectRefused(runIn(dir, 'data/ip'), 'INVALID_INPUT')
    })
    // @covers REQ-375#learning-dir-missing
    it('置き場の無いロードマップ型の学びは、ロードマップが無いとして NOT_FOUND で断る', () => {
      expectRefused(runIn(workspace(), 'data/eng'), 'NOT_FOUND')
    })
    // @covers REQ-375#roadmap-missing
    it('ロードマップの無い学びは NOT_FOUND で断る', () => {
      const l = learning('eng', 6)
      l.omit.push('roadmap.json')
      expectRefused(runGate(l), 'NOT_FOUND')
    })
    // @covers REQ-375#roadmap-not-json
    it('JSON として読めないロードマップは INVALID_INPUT で断る', () => {
      const l = learning('eng', 6)
      l.raw['roadmap.json'] = '{"units": ['
      expectRefused(runGate(l), 'INVALID_INPUT')
    })
    // @covers REQ-375#roadmap-without-units
    it('units の無いロードマップは INVALID_INPUT で断る', () => {
      const l = learning('eng', 6)
      l.raw['roadmap.json'] = JSON.stringify({ group_by: 'chapter' })
      expectRefused(runGate(l), 'INVALID_INPUT')
    })
    // @covers REQ-375#not-roadmap-before-roadmap-missing
    it('ロードマップ型でなく、ロードマップも無い学び（ip）は、ロードマップ型でないとして INVALID_INPUT で断る', () => {
      const dir = workspace()
      const l = learning('eng', 6)
      l.omit.push('roadmap.json')
      writeLearning(dir, l, 'data/ip')
      expectRefused(runIn(dir, 'data/ip'), 'INVALID_INPUT')
    })
    // @covers REQ-375#roadmap-unreadable-before-solution-missing
    it('ロードマップが読めず、添えた独立解答のファイルも無いときは、ロードマップが読めないとして INVALID_INPUT で断る', () => {
      const l = learning('eng', 6)
      l.raw['roadmap.json'] = '{"units": ['
      expectRefused(runGate(l, { 'solve_z.json': null }), 'INVALID_INPUT')
    })
  })

  describe('添えた独立解答のファイルのどれかが無いか読めないときは何も確かめずに断る（REQ-376）', () => {
    // @covers REQ-376#solution-missing
    it('添えた独立解答のファイルが無ければ NOT_FOUND で断る', () => {
      const l = learning('eng', 6)
      expectRefused(runGate(l, { 'solve_a.json': { answers: perfectAnswers(l) }, 'solve_z.json': null }), 'NOT_FOUND')
    })
    // @covers REQ-376#solution-not-json
    it('JSON として読めない独立解答は INVALID_INPUT で断る', () => {
      expectRefused(runGate(learning('eng', 6), { 'solve_z.json': '{"answers": {' }), 'INVALID_INPUT')
    })
    // @covers REQ-376#solution-without-answers
    it('answers を持たない独立解答（周の結果のファイル）は INVALID_INPUT で断る', () => {
      expectRefused(runGate(learning('eng', 6), { 'cycle_3.json': { cycle: 3, score: '12/12', rate: 1 } }), 'INVALID_INPUT')
    })
    // @covers REQ-376#answer-outside-choices
    it('ア〜エでない答えを持つ独立解答は INVALID_INPUT で断る', () => {
      const l = learning('eng', 6)
      const answers = perfectAnswers(l)
      answers[allQuestions(l)[0].qid] = 'オ'
      expectRefused(runGate(l, { 'solve_z.json': { answers } }), 'INVALID_INPUT')
    })
    // @covers REQ-376#missing-before-unreadable
    it('読めない独立解答と無い独立解答を添えたときは、無いとして NOT_FOUND で断る', () => {
      expectRefused(runGate(learning('eng', 6), { 'solve_broken.json': '{"answers": {', 'solve_z.json': null }), 'NOT_FOUND')
    })
    // @covers REQ-376#refused-before-checking
    it('止める理由のある学びでも、添えた独立解答が無ければ確かめずに断る', () => {
      const l = learning('eng', 6)
      delete l.materials['bundle_01.json']
      expectRefused(runGate(l, { 'solve_z.json': null }), 'NOT_FOUND')
    })
  })

  describe('情報の量は止める理由にも警告にもしない（REQ-377）', () => {
    // @covers REQ-377#long-material
    it('説明が 60 文・詳しい解説が 10 の見出しと 60 文を超え、要約が 200 字の単位を挙げない', () => {
      expectNotFlagged(ACCEPTED(), unitNeedles(unitAt(ACCEPTED_L(), acceptAt('long'))))
    })
    // @covers REQ-377#short-material
    it('説明と詳しい解説の各節と要約が 1 文か 2 字の単位を挙げない', () => {
      expectNotFlagged(ACCEPTED(), unitNeedles(unitAt(ACCEPTED_L(), acceptAt('short'))))
    })
    // @covers REQ-377#many-items
    it('箇条書きが 30 項目・比較の項目が 20 項目の単位を挙げない', () => {
      expectNotFlagged(ACCEPTED(), unitNeedles(unitAt(ACCEPTED_L(), acceptAt('manyItems'))))
    })
  })

  describe('表の列・行の数とセルの字数が表示の制約の外なら、止めずに警告する（REQ-378）', () => {
    // @covers REQ-378#too-many-columns
    it('列が上限を 1 超える表を tableTooWide で警告する', () => {
      expectWarning(WARNED(), 'tableTooWide', ...warnUnit('tableTooWide'))
    })
    // @covers REQ-378#too-few-columns
    it('列が下限に 1 満たない表を tableTooNarrow で警告する', () => {
      expectWarning(WARNED(), 'tableTooNarrow', ...warnUnit('tableTooNarrow'))
    })
    // @covers REQ-378#too-few-rows
    it('行（ヘッダを含む）が下限に 1 満たない表を tableTooShort で警告する', () => {
      expectWarning(WARNED(), 'tableTooShort', ...warnUnit('tableTooShort'))
    })
    // @covers REQ-378#too-many-rows
    it('行（ヘッダを含み区切りの行を数えない）が上限を 1 超える表を tableTooLong で警告する', () => {
      expectWarning(WARNED(), 'tableTooLong', ...warnUnit('tableTooLong'))
    })
    // @covers REQ-378#cell-too-long
    it('セルの字数が上限を 1 超える表を tableCellLong で警告する', () => {
      expectWarning(WARNED(), 'tableCellLong', ...warnUnit('tableCellLong'))
    })
    // @covers REQ-378#within-limits
    it('列・行が上限ちょうどでセルが上限ちょうどの表と、列・行が下限ちょうどの表は警告しない', () => {
      const kinds = KINDS.warnings.filter((k) => k.startsWith('table'))
      for (const p of ['tableAtMax', 'tableAtMin'] as const) expectNotFlagged(ACCEPTED(), unitNeedles(unitAt(ACCEPTED_L(), acceptAt(p))), kinds)
    })
  })

  describe('教材が必須の要素を欠くと止める（REQ-379）', () => {
    // @covers REQ-379#keyword-line-missing
    it('説明に登録簿の見分けの語の行が無い教材を止める', () => {
      expectStop(STOPPED(), 'missingElement', ...stopUnit('noKeywordLine'))
    })
    // @covers REQ-379#mechanism-heading-missing
    it('詳しい解説に「しくみ」の見出しが無い教材を止める', () => {
      expectStop(STOPPED(), 'missingElement', ...stopUnit('noMechanismHeading'))
    })
    // @covers REQ-379#required-field-empty
    it('説明が空の教材を止める', () => {
      expectStop(STOPPED(), 'missingElement', ...stopUnit('emptyExplanation'))
    })
    // @covers REQ-379#required-field-missing
    it('詳しい解説の欄が無い教材を止める', () => {
      expectStop(STOPPED(), 'missingElement', ...stopUnit('noDetailField'))
    })
  })

  describe('教材のファイルが読めない・重複・論点名の食い違い・教材の無い単位は止める（REQ-380）', () => {
    // @covers REQ-380#material-file-unreadable
    it('JSON として読めない教材のファイルを、そのファイルを挙げて止める', () => {
      expectStop(STOPPED(), 'unreadableOutput', BROKEN_MATERIAL_FILE.replace(/\.json$/, ''))
    })
    // @covers REQ-380#duplicate-material
    it('同じ論点の教材が 2 つのファイルにあると止める', () => {
      expectStop(STOPPED(), 'duplicate', ...stopUnit('duplicateMaterial'), DUPLICATE_MATERIAL_FILE.replace(/\.json$/, ''))
    })
    // @covers REQ-380#term-mismatch
    it('教材の論点名がロードマップの論点名と食い違うと止める', () => {
      expectStop(STOPPED(), 'termMismatch', ...stopUnit('termMismatch'))
    })
    // @covers REQ-380#unit-without-material
    it('教材の無い単位を止める', () => {
      expectStop(STOPPED(), 'missingMaterial', ...stopUnit('noMaterial'))
    })
  })

  describe('崩れた表と、見出しの階層の外の見出しは止める（REQ-381）', () => {
    // @covers REQ-381#table-without-separator
    it('区切りの行が無い表を brokenTable で止める', () => {
      expectStop(STOPPED(), 'brokenTable', ...stopUnit('tableWithoutSeparator'))
    })
    // @covers REQ-381#table-cells-uneven
    it('行ごとのセルの数がそろわない表を brokenTable で止める', () => {
      expectStop(STOPPED(), 'brokenTable', ...stopUnit('tableUneven'))
    })
    // @covers REQ-381#heading-shallower
    it('詳しい解説の「##」の見出しを headingLevel で止める', () => {
      expectStop(STOPPED(), 'headingLevel', ...stopUnit('headingShallower'))
    })
    // @covers REQ-381#heading-deeper
    it('詳しい解説の「####」の見出しを headingLevel で止める', () => {
      expectStop(STOPPED(), 'headingLevel', ...stopUnit('headingDeeper'))
    })
  })

  describe('出典の名前が集めた資料の名前と集計の名前のどれにも無ければ止める（REQ-382）', () => {
    // @covers REQ-382#unknown-source
    it('集めた資料に無く集計の名前でもない出典を unknownSource で止める', () => {
      expectStop(STOPPED(), 'unknownSource', ...stopUnit('unknownSourceName'))
    })
    // @covers REQ-382#general-knowledge
    it('「一般常識」の出典を unknownSource で止める', () => {
      expectStop(STOPPED(), 'unknownSource', ...stopUnit('generalKnowledgeSource'))
    })
    // @covers REQ-382#collected-source
    it('集めた資料の名前の出典は止めない', () => {
      expectPassed(CLEAN())
      expect(findingsAbout(CLEAN().json.stops, 'unknownSource')).toEqual([])
    })
    // @covers REQ-382#tally-source
    it('「〜の集計」と、括弧に英小文字の鍵を添えた「〜の集計（public）」の出典は止めない', () => {
      for (const p of ['tallySource', 'tallySourceWithKey'] as const) {
        expectNotFlagged(ACCEPTED(), unitNeedles(unitAt(ACCEPTED_L(), acceptAt(p))), ['unknownSource'])
      }
    })
  })

  describe('用語として示した語がロードマップの論点名に無ければ止める（REQ-383）', () => {
    // @covers REQ-383#unresolved-term
    it('ロードマップに無い語を用語として示した教材を、その語を挙げて止める', () => {
      const m = materialAt(STOPPED_L(), stopAt('unresolvedTerm'))
      const word = /\[\[([^\]]+)\]\]/.exec(m.detail!)![1]
      expectStop(STOPPED(), 'unresolvedTerm', word)
    })
    // @covers REQ-383#known-term
    it('ロードマップの論点名を用語として示した教材は止めない', () => {
      expectPassed(CLEAN())
      expect(findingsAbout(CLEAN().json.stops, 'unresolvedTerm')).toEqual([])
    })
  })

  describe('教材・要約・確認問題の正解の側に登録簿が禁じた書き方があれば止める（REQ-384）', () => {
    const banned = (...needles: (string | number)[]) => {
      const r = BANNED_RUN()
      expectStop(r, 'bannedPattern', ...needles)
      const hits = findingsAbout(r.json.stops, 'bannedPattern', ...needles)
      expect(hits.some((f) => String(f.reason).includes(BANNED.reason)), `禁じた理由が無い: ${JSON.stringify(hits)}`).toBe(true)
    }
    // @covers REQ-384#in-material
    it('教材の禁じた書き方を、その論点と禁じた理由を挙げて止める', () => {
      banned(...unitNeedles(unitAt(BANNED_L(), bannedAt('material'))))
    })
    // @covers REQ-384#in-summary
    it('要約の禁じた書き方を、その単位と禁じた理由を挙げて止める', () => {
      banned(...unitNeedles(unitAt(BANNED_L(), bannedAt('summary'))))
    })
    // @covers REQ-384#in-correct-choice
    it('正解の選択肢の禁じた書き方を、その問題と禁じた理由を挙げて止める', () => {
      banned(qidAt(BANNED_L(), bannedAt('correctChoice')))
    })
    // @covers REQ-384#in-correct-note
    it('正解の説明の禁じた書き方を、その問題と禁じた理由を挙げて止める', () => {
      banned(qidAt(BANNED_L(), bannedAt('correctNote')))
    })
    // @covers REQ-384#in-wrong-choice
    it('誤答の選択肢の禁じた書き方は止めない', () => {
      const r = BANNED_RUN()
      expect(r.json, r.stderr.slice(-400)).not.toBeNull()
      expect(findingsAbout(r.json.stops, 'bannedPattern', qidAt(BANNED_L(), bannedAt('wrongChoice')))).toEqual([])
    })
  })

  describe('前提が自分より後ろにある単位と、要約の無い単位は止める（REQ-385）', () => {
    // @covers REQ-385#prereq-after
    it('学ぶ順で自分より後ろの単位を前提に挙げた単位を止める', () => {
      expectStop(STOPPED(), 'prereqAfter', ...stopUnit('prereqAfter'))
    })
    // @covers REQ-385#summary-missing
    it('要約の欄の無い単位を止める', () => {
      expectStop(STOPPED(), 'summaryMissing', ...stopUnit('noSummary'))
    })
    // @covers REQ-385#summary-empty
    it('要約が空の単位を止める', () => {
      expectStop(STOPPED(), 'summaryMissing', ...stopUnit('emptySummary'))
    })
    // @covers REQ-385#prereq-before
    it('自分より前の単位を前提に挙げた単位は止めない', () => {
      expectPassed(CLEAN())
      expect(findingsAbout(CLEAN().json.stops, 'prereqAfter')).toEqual([])
    })
  })

  describe('章で束ねる学びの章の番号・名前と、印を持つ学びの印が欠けると止める（REQ-386）', () => {
    // @covers REQ-386#chapter-number-missing
    it('章の番号の無い単位を止める', () => {
      expectStop(STOPPED(), 'chapterMissing', ...stopUnit('noRound'))
    })
    // @covers REQ-386#chapter-name-missing
    it('章の名前の無い単位を止める', () => {
      expectStop(STOPPED(), 'chapterMissing', ...stopUnit('noChapter'))
    })
    // @covers REQ-386#tier-missing
    it('印の無い単位を止める', () => {
      expectStop(STOPPED(), 'tierMissing', ...stopUnit('noTier'))
    })
    // @covers REQ-386#tier-not-in-registry
    it('登録簿の段に無い印の単位を止める', () => {
      expectStop(STOPPED(), 'tierMissing', ...stopUnit('tierOutside'))
    })
    // @covers REQ-386#day-learning
    it('日で束ねる学び（msg）の、章の番号と名前を持たない単位は止めない', () => {
      const r = CLEAN_MSG()
      expectPassed(r)
      expect(findingsAbout(r.json.stops, 'chapterMissing')).toEqual([])
    })
    // @covers REQ-386#tierless-learning
    it('印を持たない学び（msg）の、印の無い単位は止めない', () => {
      const r = CLEAN_MSG()
      expectPassed(r)
      expect(findingsAbout(r.json.stops, 'tierMissing')).toEqual([])
    })
  })

  describe('確認問題のファイル・形・到達基準・識別子・単位ごとの数の誤りは止める（REQ-387）', () => {
    // @covers REQ-387#question-file-unreadable
    it('JSON として読めない確認問題のファイルを、そのファイルを挙げて止める', () => {
      expectStop(STOPPED(), 'unreadableOutput', BROKEN_QUESTION_FILE.replace(/\.json$/, ''))
    })
    // @covers REQ-387#choices-not-four
    it('選択肢がア〜エの 4 つでない問題を questionShape で止める', () => {
      expectStop(STOPPED(), 'questionShape', qidAt(STOPPED_L(), stopAt('choicesNotFour')))
    })
    // @covers REQ-387#answer-outside-choices
    it('正解がア〜エでない問題を questionShape で止める', () => {
      expectStop(STOPPED(), 'questionShape', qidAt(STOPPED_L(), stopAt('answerOutside')))
    })
    // @covers REQ-387#correct-note-rule
    it('正解の説明が「正解」で始まらず、誤答の説明が「正解」で始まる問題を questionShape で止める', () => {
      expectStop(STOPPED(), 'questionShape', qidAt(STOPPED_L(), stopAt('correctNoteNotSeikai')))
    })
    // @covers REQ-387#unknown-goal
    it('学びの到達基準に無い番号を測る問題を unknownGoal で止める', () => {
      expectStop(STOPPED(), 'unknownGoal', qidAt(STOPPED_L(), stopAt('unknownGoal')))
    })
    // @covers REQ-387#duplicate-qid
    it('識別子が重なる問題を duplicateQid で止める', () => {
      expectStop(STOPPED(), 'duplicateQid', qidAt(STOPPED_L(), stopAt('duplicateQid')))
    })
    // @covers REQ-387#too-many-questions
    it('問題が 1 単位あたりの数より多い単位を questionCount で止める', () => {
      expectStop(STOPPED(), 'questionCount', ...stopUnit('threeQuestions'))
    })
    // @covers REQ-387#too-few-questions
    it('問題が 1 単位あたりの数より少ない単位を questionCount で止める', () => {
      expectStop(STOPPED(), 'questionCount', ...stopUnit('oneQuestion'))
    })
  })

  describe('独立解答のどれか 1 つの食い違いの割合が閾値を超えたら止める（REQ-388）', () => {
    // @covers REQ-388#at-threshold
    it('食い違いが 20 問中 4 問（閾値ちょうど）の独立解答は止めない', () => {
      const r = SOLVED_WITHIN()
      expectPassed(r)
      expect(findingsAbout(r.json.stops, 'independentMismatch')).toEqual([])
    })
    // @covers REQ-388#over-threshold
    it('食い違いが 20 問中 5 問の独立解答を、そのファイルと食い違った問題を挙げて止める', () => {
      const r = SOLVED_OVER()
      expectStop(r, 'independentMismatch', 'solve_five')
      const hit = findingsAbout(r.json.stops, 'independentMismatch', 'solve_five')
      const text = hit.map((f) => `${f.where} ${f.reason}`).join(' ')
      for (const q of allQuestions(SOLVED_L()).slice(0, 5)) expect(text, `食い違った問題 ${q.qid} を挙げていない`).toContain(q.qid)
    })
    // @covers REQ-388#unanswered-counted
    it('食い違い 4 問と未回答 1 問の独立解答を、未回答を食い違いに数えて止める', () => {
      expectStop(SOLVED_OVER(), 'independentMismatch', 'solve_blank')
    })
    // @covers REQ-388#each-solution-alone
    it('3 つの独立解答の合計では閾値の内でも、閾値を超えた 1 つで止め、食い違いの無い独立解答は挙げない', () => {
      const r = SOLVED_OVER()
      expectStop(r, 'independentMismatch', 'solve_five')
      expect(findingsAbout(r.json.stops, 'independentMismatch', 'solve_perfect')).toEqual([])
    })
    // @covers REQ-388#supplement-not-counted
    it('補足の論点の問題の答えは食い違いに数えない（ロードマップの単位の 20 問中 4 問の食い違いは止めない）', () => {
      const { r } = SOLVED_SUPPLEMENT()
      expectPassed(r)
      expect(findingsAbout(r.json.stops, 'independentMismatch')).toEqual([])
    })
  })

  describe('教材か要約の書き方がロードマップ型の教材の警告に当たれば、止めずに警告する（REQ-389）', () => {
    // @covers REQ-389#avoid-word-in-material
    it('教材の、登録簿の避ける語を avoidWord で警告する', () => {
      expectWarning(WARNED(), 'avoidWord', ...warnUnit('avoidWordInMaterial'))
    })
    // @covers REQ-389#avoid-word-in-summary
    it('要約の、登録簿の避ける語を avoidWord で警告する', () => {
      expectWarning(WARNED(), 'avoidWord', ...warnUnit('avoidWordInSummary'))
    })
    // @covers REQ-389#usage-section-missing
    it('詳しい解説に登録簿の使い方の見出しが無い教材を usageSectionMissing で警告する', () => {
      expectWarning(WARNED(), 'usageSectionMissing', ...warnUnit('usageSectionMissing'))
    })
    // @covers REQ-389#unclosed-emphasis
    it('閉じていない強調の記号がある教材を unclosedEmphasis で警告する', () => {
      expectWarning(WARNED(), 'unclosedEmphasis', ...warnUnit('unclosedEmphasis'))
    })
  })

  describe('確認問題に読まずに当てられる手がかりが閾値を超えてあれば、止めずに警告する（REQ-390）', () => {
    // @covers REQ-390#answer-position-bias
    it('20 問中 10 問の正解がアの学びを answerPositionBias で警告する', () => {
      expectWarning(CLUED(), 'answerPositionBias')
    })
    // @covers REQ-390#pair-never-same
    it('同じ単位の 2 問の正解の記号がどの単位でも重ならない学びを pairAnswerNeverSame で警告する', () => {
      expectWarning(CLUED(), 'pairAnswerNeverSame')
    })
    // @covers REQ-390#answer-longest
    it('正解がいつも最も長い選択肢の学びを answerLongest で警告する', () => {
      expectWarning(CLUED(), 'answerLongest')
    })
    // @covers REQ-390#verbatim-body
    it('正解の選択肢が教材の説明と閾値の字数以上続けて一致する問題を verbatimBody で警告する', () => {
      expectWarning(CLUED(), 'verbatimBody', qidAt(CLUED_L(), 0))
    })
    // @covers REQ-390#verbatim-summary
    it('正解の選択肢が要約と閾値の字数以上続けて一致する問題を verbatimSummary で警告する', () => {
      expectWarning(CLUED(), 'verbatimSummary', qidAt(CLUED_L(), 1))
    })
    // @covers REQ-390#below-min-questions
    it('問題が偏りの警告の最小の数に満たない学びでは、正解の位置・2 問の重なり・最も長い正解を警告しない', () => {
      const r = FEW()
      expectPassed(r)
      for (const kind of ['answerPositionBias', 'pairAnswerNeverSame', 'answerLongest']) expect(findingsAbout(r.json.warnings, kind), kind).toEqual([])
    })
  })

  describe('前提がロードマップに無い単位と、最も低い段が末尾にそろわない章は、止めずに警告する（REQ-391）', () => {
    // @covers REQ-391#prereq-unknown
    it('ロードマップに無い単位を前提に挙げた単位を prereqUnknown で警告する', () => {
      expectWarning(WARNED(), 'prereqUnknown', ...warnUnit('prereqUnknown'))
    })
    // @covers REQ-391#lowest-tier-not-last
    it('最も低い段の単位が末尾にそろわない章を lowestTierNotLast で警告する', () => {
      const l = WARNED_L()
      const u = unitAt(l, 6)
      expectWarning(WARNED(), 'lowestTierNotLast', u.chapter!, `第 ${u.round} 章`, `第${u.round}章`, ...unitNeedles(u), ...unitNeedles(unitAt(l, 11)))
    })
    // @covers REQ-391#lowest-tier-last
    it('どの章も最も低い段の単位が末尾にそろい、前提がロードマップにある学びは警告しない', () => {
      const r = CLEAN()
      expectPassed(r)
      expect(findingsAbout(r.json.warnings, 'lowestTierNotLast')).toEqual([])
      expect(findingsAbout(r.json.warnings, 'prereqUnknown')).toEqual([])
    })
  })

  describe('ロードマップの外の補足の論点の教材と確認問題は、止める理由にも警告にもしない（REQ-392）', () => {
    // @covers REQ-392#supplement-material
    it('補足の論点の教材を挙げない', () => {
      const { s, r } = SUPPLEMENTED()
      expectPassed(r)
      expectNotFlagged(r, [...unitNeedles(s), SUPPLEMENT.file.replace(/\.json$/, '')])
    })
    // @covers REQ-392#supplement-questions
    it('補足の論点の確認問題を挙げない', () => {
      const { r } = SUPPLEMENTED()
      expectPassed(r)
      expectNotFlagged(r, [`t${SUPPLEMENT.topic_id}-1`, `t${SUPPLEMENT.topic_id}-2`])
    })
  })

  describe('引数の誤りは何も確かめずに断る（REQ-375）', () => {
    // @covers REQ-375#bad-arguments
    it('学びの置き場の引数が無い・知らない名前の引数・値の無い学びの置き場の引数は INVALID_INPUT で断る（場合ごと）', () => {
      const dir = workspace()
      writeLearning(dir, learning('eng', 6))
      const cases: [string, string | null, string[]][] = [
        ['学びの置き場の引数が無い', null, []],
        ['知らない名前の引数', 'data/eng', ['--unknownArgument', 'x']],
        ['値の無い学びの置き場の引数', null, ['--data']],
      ]
      for (const [label, data, args] of cases) labelled(label, () => expectRefused(runIn(dir, data, args), 'INVALID_INPUT'))
    })
  })

  describe('集めた資料のファイルの項目が持つ資料の名前の出典は止めない（REQ-382）', () => {
    // @covers REQ-382#nested-source
    it('集めた資料のファイルの topics・themes・weights の項目が持つ資料（sources、無ければ examples）の名前の出典は止めない', () => {
      const l = learning('eng', 12)
      const names = [`${l.fresh(6)}の解説`, `${l.fresh(6)}の記事`, `${l.fresh(6)}の要覧`]
      l.sources['nested.json'] = {
        collector: 'nested',
        topics: [{ name: l.fresh(3), sources: [{ name: names[0], fetched: true }] }],
        themes: [{ name: l.fresh(3), examples: [{ name: names[1] }] }],
        weights: [{ item: l.fresh(3), sources: [{ name: names[2] }] }],
      }
      names.forEach((name, i) => (materialAt(l, i).sources = [{ name, where: `${l.fresh(5)}の項目` }]))
      const r = runGate(l)
      expectPassed(r)
      expect(findingsAbout(r.json.stops, 'unknownSource'), JSON.stringify(r.json.stops)).toEqual([])
    })
  })

  describe('確認問題の正解の根拠の禁じた書き方は止め、問題文のは止めない（REQ-384）', () => {
    // @covers REQ-384#in-reason
    it('正解の根拠（reason）の禁じた書き方を、その問題と禁じた理由を挙げて止める', () => {
      const l = learning('msg', 6)
      const q = questionsAt(l, 0)[0]
      q.reason = `${l.fresh(4)}${BANNED.text}${l.fresh(4)}です。`
      const r = runGate(l)
      expectStop(r, 'bannedPattern', q.qid)
      expect(findingsAbout(r.json.stops, 'bannedPattern', q.qid).some((f) => String(f.reason).includes(BANNED.reason)), JSON.stringify(r.json.stops)).toBe(true)
    })
    // @covers REQ-384#in-stem
    it('問題文の禁じた書き方は止めない', () => {
      const l = learning('msg', 6)
      const q = questionsAt(l, 0)[0]
      q.stem = `${l.fresh(4)}${BANNED.text}${l.fresh(4)}はどれか。`
      const r = runGate(l)
      expect(r.json, r.stderr.slice(-400)).not.toBeNull()
      expect(findingsAbout(r.json.stops, 'bannedPattern', q.qid)).toEqual([])
    })
  })

  describe('誤答の説明の「正解」の印（REQ-387）', () => {
    // @covers REQ-387#wrong-note-marked
    it('誤答の説明が「正解。」の印で始まる問題を questionShape で止める', () => {
      const l = learning('eng', 12)
      const q = questionsAt(l, 0)[0]
      q.choice_notes[wrongOf(q.answer)] = `正解。${l.fresh(8)}です。`
      expectStop(runGate(l), 'questionShape', q.qid)
    })
    // @covers REQ-387#wrong-note-starts-with-word
    it('誤答の説明が印でなく文として「正解」で始まる（「正解の動かし方を…」）問題は止めない', () => {
      const l = learning('eng', 12)
      const q = questionsAt(l, 0)[0]
      q.choice_notes[wrongOf(q.answer)] = `正解の動かし方を${l.fresh(6)}と取り違えています。`
      const r = runGate(l)
      expect(r.json, r.stderr.slice(-400)).not.toBeNull()
      expect(findingsAbout(r.json.stops, 'questionShape', q.qid), JSON.stringify(r.json.stops)).toEqual([])
    })
  })

  describe('文末の調子の少数派と、出典の where の番号つきの項目名を警告する（REQ-389）', () => {
    /** 学ぶ順の先頭 k 単位の教材の文末を常体にした eng（n 単位）。 */
    const plainUnits = (n: number, k: number) => {
      const l = learning('eng', n)
      for (let i = 0; i < k; i++) {
        const m = materialAt(l, i)
        m.explanation = m.explanation!.replace(/です。/g, 'である。')
        m.detail = m.detail!.replace(/です。/g, 'である。')
      }
      return l
    }
    // @covers REQ-389#style-minority
    it('教材が styleMinUnits 以上の学びで、文末の調子が学びの多数と違う単位が styleMinorityShare 未満なら、その単位を styleMinority で警告する', () => {
      const k = Math.ceil(12 * LIMITS.styleMinorityShare) - 1
      const l = plainUnits(12, k)
      expectWarning(runGate(l), 'styleMinority', ...unitNeedles(unitAt(l, 0)))
    })
    // @covers REQ-389#style-minority-many
    it('多数と違う単位が styleMinorityShare 以上の割合なら styleMinority で警告しない', () => {
      const r = runGate(plainUnits(12, Math.ceil(12 * LIMITS.styleMinorityShare)))
      expect(r.json, r.stderr.slice(-400)).not.toBeNull()
      expect(findingsAbout(r.json.warnings, 'styleMinority'), JSON.stringify(r.json.warnings)).toEqual([])
    })
    // @covers REQ-389#style-few-units
    it('教材が styleMinUnits − 1 の学びでは、多数と違う単位が 1 つでも styleMinority で警告しない', () => {
      const r = runGate(plainUnits(LIMITS.styleMinUnits - 1, 1))
      expect(r.json, r.stderr.slice(-400)).not.toBeNull()
      expect(findingsAbout(r.json.warnings, 'styleMinority'), JSON.stringify(r.json.warnings)).toEqual([])
    })
    // @covers REQ-389#source-where-code
    it('出典の where に番号つきの項目名（「第 3 章」）がある教材を sourceWhereCode で警告する', () => {
      const l = learning('eng', 12)
      materialAt(l, 0).sources = [{ name: l.sourceName, where: '第 3 章' }]
      expectWarning(runGate(l), 'sourceWhereCode', ...unitNeedles(unitAt(l, 0)))
    })
    // @covers REQ-389#source-where-tech-word
    it('技術の略語と版番号（「TLS 1.3」）だけの where は sourceWhereCode で警告しない', () => {
      const l = learning('eng', 12)
      materialAt(l, 0).sources = [{ name: l.sourceName, where: 'TLS 1.3' }]
      const r = runGate(l)
      expect(r.json, r.stderr.slice(-400)).not.toBeNull()
      expect(findingsAbout(r.json.warnings, 'sourceWhereCode'), JSON.stringify(r.json.warnings)).toEqual([])
    })
  })

  describe('確認問題の形の手がかり（正解の長さの上位 2 つ・読点・言い切る語・かぎ括弧・問題文の「教材」・2 問とも最長）（REQ-390）', () => {
    /** eng 12 単位（24 問）の各問題を edit で書き換えて門にかける。 */
    const clue = (edit: (q: Question, i: number, l: Learning) => void) => {
      const l = learning('eng', 12)
      allQuestions(l).forEach((q, i) => edit(q, i, l))
      return { l, r: runGate(l) }
    }
    const wrongs = (q: Question) => CHOICES.filter((c) => c !== q.answer)
    // @covers REQ-390#answer-top-two-length
    it('正解が 2 番目に長い誤答より長い問題の割合が answerTopTwoShare を超える学びを answerTopTwoLength で警告する', () => {
      const { r } = clue((q, _, l) => {
        const [w1] = wrongs(q)
        q.choices[w1] = l.fresh(12)
        q.choices[q.answer] = l.fresh(11)
      })
      expectWarning(r, 'answerTopTwoLength')
    })
    // @covers REQ-390#answer-commas
    it('正解の選択肢の読点の数の平均が、誤答の平均（下限 answerCommasFloor）の answerCommasRatio 倍を超える学びを answerCommas で警告する', () => {
      const { r } = clue((q, _, l) => (q.choices[q.answer] = `${l.fresh(4)}、${l.fresh(4)}`))
      expectWarning(r, 'answerCommas')
    })
    // @covers REQ-390#absolute-words-wrong
    it('言い切る語を含む選択肢が absoluteMinChoices 以上あり、その中の誤答の割合が absoluteWrongShare を超える学びを absoluteWordsWrong で警告する', () => {
      const word = LIMITS.absoluteWords[0] as string
      const { r } = clue((q, i, l) => {
        if (i < LIMITS.absoluteMinChoices) q.choices[wrongs(q)[0]] = `${word}${l.fresh(10 - word.length)}`
      })
      expectWarning(r, 'absoluteWordsWrong')
    })
    // @covers REQ-390#absolute-words-few
    it('言い切る語を含む選択肢が absoluteMinChoices − 1 の学びは、すべて誤答でも absoluteWordsWrong で警告しない', () => {
      const word = LIMITS.absoluteWords[0] as string
      const { r } = clue((q, i, l) => {
        if (i < LIMITS.absoluteMinChoices - 1) q.choices[wrongs(q)[0]] = `${word}${l.fresh(10 - word.length)}`
      })
      expect(r.json, r.stderr.slice(-400)).not.toBeNull()
      expect(findingsAbout(r.json.warnings, 'absoluteWordsWrong'), JSON.stringify(r.json.warnings)).toEqual([])
    })
    // @covers REQ-390#quote-only-in-answer
    it('「「」を含む選択肢が正解の 1 つだけの問題を quoteOnlyInAnswer で警告する', () => {
      const { l, r } = clue((q, i, l2) => {
        if (i === 0) q.choices[q.answer] = `「${l2.fresh(5)}」と言う`
      })
      expectWarning(r, 'quoteOnlyInAnswer', allQuestions(l)[0].qid)
    })
    // @covers REQ-390#stem-says-material
    it('問題文に「教材」を含む問題を stemSaysMaterial で警告する', () => {
      const { l, r } = clue((q, i, l2) => {
        if (i === 0) q.stem = `${l2.fresh(6)}について教材が述べることはどれか。`
      })
      expectWarning(r, 'stemSaysMaterial', allQuestions(l)[0].qid)
    })
    // @covers REQ-390#both-longest-in-unit
    it('2 問とも正解がほかのどの選択肢より長い単位が bothLongestMinUnits 以上ある学びを bothLongestInUnit で警告する', () => {
      const { r } = clue((q, i, l) => {
        if (i < 2 * LIMITS.bothLongestMinUnits) q.choices[q.answer] = l.fresh(11)
      })
      expectWarning(r, 'bothLongestInUnit')
    })
  })

  describe('結果を返すとき、人が読む行のあとの最後の行に機械向けの 1 行を出す（REQ-595）', () => {
    // @covers REQ-595#line-when-passed
    it('通したときの最後の行は、終了の状態と同じ exitCode・見た数・空の止める理由と警告・契約の閾値を持つ', () => {
      const r = CLEAN()
      expect(r.json, r.stdout.slice(-400)).not.toBeNull()
      expect(r.json.exitCode).toBe(r.code)
      expect(r.json.exitCode).toBe(0)
      expect(r.json.topics).toBe(12)
      expect(r.json.questions).toBe(24)
      expect(r.json.stops).toEqual([])
      expect(r.json.warnings).toEqual([])
      expect(r.json.limits).toEqual(LIMITS)
    })
    // @covers REQ-595#line-when-stopped
    it('止めたときの最後の行は、exitCode 1 と、契約の種類・箇所・理由を持つ止める理由と警告を並べる', () => {
      const r = STOPPED()
      expect(r.json, r.stdout.slice(-400)).not.toBeNull()
      expect(r.code).toBe(1)
      expect(r.json.exitCode).toBe(1)
      expect(r.json.stops.length).toBeGreaterThan(0)
      for (const [list, kinds] of [[r.json.stops, KINDS.stops], [r.json.warnings, KINDS.warnings]] as const) {
        for (const f of list) {
          expect(kinds, JSON.stringify(f)).toContain(f.kind)
          expect(typeof f.where === 'string' && f.where.length > 0, JSON.stringify(f)).toBe(true)
          expect(typeof f.reason === 'string' && f.reason.length > 0, JSON.stringify(f)).toBe(true)
        }
      }
      expect(r.json.limits).toEqual(LIMITS)
    })
    // @covers REQ-595#warning-kinds
    it('警告だけのときの最後の行の警告は、契約の種類・箇所・理由を持つ', () => {
      const r = WARNED()
      expect(r.json, r.stdout.slice(-400)).not.toBeNull()
      for (const f of r.json.warnings) {
        expect(KINDS.warnings, JSON.stringify(f)).toContain(f.kind)
        expect(typeof f.reason === 'string' && f.reason.length > 0, JSON.stringify(f)).toBe(true)
      }
    })
    // @covers REQ-595#human-lines-kept
    it('人が読む結果の行は最後の行より前に残り、機械向けの行は最後の 1 行だけ', () => {
      for (const r of [CLEAN(), STOPPED()]) {
        expect(r.lines.length, r.stdout).toBeGreaterThanOrEqual(2)
        const json = r.lines.filter((line) => {
          try {
            const v = JSON.parse(line)
            return v !== null && typeof v === 'object'
          } catch {
            return false
          }
        })
        expect(json, '機械向けの行が最後の 1 行のほかにもある').toHaveLength(1)
        expect(json[0]).toBe(r.lines[r.lines.length - 1])
      }
    })
  })
})
