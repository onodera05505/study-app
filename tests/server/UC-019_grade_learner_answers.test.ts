import { describe, expect, it } from 'vitest'
import {
  DELIVERED_FILE, EXPLAIN_FILE, QUESTIONS_DIR, QUESTION_BUNDLES, ROADMAP_FILE, SNAPSHOT_8, UNITS,
  PNG, addFigureLine, grade, makeWorkspace, prepareGrade, question, resultFile, roadmapOf, snapshotFile, toolError, writeQuestions,
  type Json, type Run, type Workspace,
} from './uc019_fixture'

/** UC-019 学習者役の答えを採点する入口（gradeLearnerAnswers ＝ `python3 scripts/grade_learner.py`）の境界。
 *  周の写し（pack_cycle_<周>.json）は契約の PackSnapshot の形で直に置き、パックを作る入口には頼らない。
 *  観測するのは、標準出力の JSON と終了コード、学びの置き場の eval の下の周の結果（cycle_<周>.json）だけ。 */

/** 手本の答え: t5-1 正解・t5-2 誤答・t2-1 正解・t9-1 未回答。単位 5 は「人に説明できる」、単位 9 は「分からなかった」。 */
const BASE: Json = {
  answers: { 't5-1': 'イ', 't5-2': 'イ', 't2-1': 'ア' },
  units: [
    { topic_id: 5, minutes: 5, understood: 3, confusing: '単位二', unknown_terms: ['語A'] },
    { topic_id: 9, minutes: 3, understood: 1, unknown_terms: ['語B', '語A'] },
  ],
}
const withUnits = (units: Json[], answers: Json = BASE.answers) => ({ answers, units })
/** 全問正解の答え。 */
const ALL_CORRECT = { 't5-1': 'イ', 't5-2': 'エ', 't2-1': 'ア', 't9-1': 'ウ' }
/** 単位の参照（UnitRef）は任意の欄 confusing を持ちうるので、単位の ID と名前だけを比べる。 */
const refs = (xs: Json[]) => xs.map((x) => ({ topic_id: x.topic_id, term: x.term }))

/** 採点を止めたときの共通の観測: 終了 1・コード・その周の結果が残らない。 */
function expectStopped(r: Run, ws: Workspace, code: string, cycle = 8, key = 'eng') {
  expect(r.status).toBe(1)
  expect(r.code, r.stdout).toBe(code)
  expect(typeof toolError(r.json)?.reason === 'string' && toolError(r.json).reason.length > 0).toBe(true)
  expect(ws.exists(resultFile(cycle, key))).toBe(false)
}
const ok = (r: Run) => {
  expect(r.status, r.stdout + r.stderr).toBe(0)
  return r.json
}
const graded = (answers: Json = BASE, setup?: (ws: Workspace) => void, explain?: Json) => {
  const ws = makeWorkspace()
  prepareGrade(ws, answers)
  if (explain !== undefined) ws.write('answers/explain_grade.json', explain)
  setup?.(ws)
  return { ws, r: grade(ws, explain !== undefined ? { explain: 'answers/explain_grade.json' } : {}) }
}

describe('UC-019 学習者役の答えを採点する（gradeLearnerAnswers）', () => {
  describe('周の結果の中身（REQ-314）', () => {
    /** @covers REQ-314#tally-overall */
    it('写しの全問題で数えた正答を score と rate に出す', () => {
      const j = ok(graded().r)
      expect(j.cycle).toBe(8)
      expect(j.score).toBe('2/4')
      expect(j.rate).toBeCloseTo(0.5)
    })

    /** @covers REQ-314#tally-by-goal */
    it('写しの問題ごとの到達基準で数えた正答を by_goal に出す', () => {
      expect(ok(graded().r).by_goal).toEqual({ '1': '2/2', '2': '0/2' })
    })

    /** @covers REQ-314#tally-by-field */
    it('写しの問題ごとの分野で数えた正答を by_field に出す', () => {
      expect(ok(graded().r).by_field).toEqual({ 分野甲: '2/3', 分野乙: '0/1' })
    })

    /** @covers REQ-314#per-unit-all-units */
    it('per_unit は写しの全単位を、自己申告や問題の無い単位も含めて 1 つずつ持つ', () => {
      const j = ok(graded().r)
      expect(Object.keys(j.per_unit).sort()).toEqual(['2', '4', '5', '9'])
      expect(j.per_unit['5']).toMatchObject({ term: '単位五', field: '分野甲', correct: 1, total: 2, understood: 3, confusing: '単位二', unknown_terms: ['語A'], minutes: 5 })
      expect(j.per_unit['2']).toMatchObject({ term: '単位二', field: '分野甲', correct: 1, total: 1, understood: null })
      expect(j.per_unit['9']).toMatchObject({ term: '単位九', field: '分野乙', correct: 0, total: 1, understood: 1 })
      expect(j.per_unit['4']).toMatchObject({ term: '単位四', field: '分野乙', correct: 0, total: 0, understood: null })
    })

    /** @covers REQ-314#unanswered-is-wrong */
    it('答えの無い問題は誤答として数え、wrong に選んだ答え無しで挙げる', () => {
      const j = ok(graded().r)
      const wrong = Object.fromEntries((j.wrong as Json[]).map((w) => [w.qid, w]))
      expect(Object.keys(wrong).sort()).toEqual(['t5-2', 't9-1'])
      expect(wrong['t5-2']).toMatchObject({ picked: 'イ', answer: 'エ' })
      expect(wrong['t9-1'].answer).toBe('ウ')
      expect(wrong['t9-1'].picked ?? null).toBeNull()
    })

    /** @covers REQ-314#avg-over-reported */
    it('理解の段の平均は、理解の段を書いた単位だけで取る', () => {
      const j = ok(graded().r)
      expect(j.reported_units).toBe(2)
      expect(j.avg_understood).toBeCloseTo(2)
    })

    /** @covers REQ-314#avg-none-reported */
    it('理解の段を書いた単位が 1 つも無ければ、平均は 0 で数は 0', () => {
      const j = ok(graded(withUnits([{ topic_id: 5, minutes: 4 }])).r)
      expect(j.reported_units).toBe(0)
      expect(j.avg_understood).toBe(0)
    })

    /** @covers REQ-314#stuck-by-understood */
    it('理解の段が「分からなかった」単位は、全問正解でも詰まった単位に挙がる', () => {
      const j = ok(graded(withUnits([{ topic_id: 2, understood: 1 }], ALL_CORRECT)).r)
      expect(refs(j.stuck_units)).toEqual([{ topic_id: 2, term: '単位二' }])
    })

    /** @covers REQ-314#stuck-by-zero-correct */
    it('問題を持ちながら 1 問も正解しなかった単位は、理解の段が「分かった気がする」でも詰まった単位に挙がる', () => {
      const j = ok(graded(withUnits([{ topic_id: 9, understood: 2 }], { 't5-1': 'イ', 't5-2': 'エ', 't2-1': 'ア', 't9-1': 'ア' })).r)
      expect(refs(j.stuck_units)).toEqual([{ topic_id: 9, term: '単位九' }])
    })

    /** @covers REQ-314#not-stuck-without-questions */
    it('問題を持たず理解の段も「分からなかった」でない単位は詰まった単位に挙がらない', () => {
      const j = ok(graded(withUnits([{ topic_id: 4, understood: 2 }], ALL_CORRECT)).r)
      expect(j.stuck_units).toEqual([])
    })

    /** @covers REQ-314#overconfident */
    it('理解の段が「人に説明できる」なのに問題を間違えた単位は過信の単位に挙がる', () => {
      const j = ok(graded().r)
      expect(refs(j.overconfident_units)).toEqual([{ topic_id: 5, term: '単位五' }])
    })

    /** @covers REQ-314#not-overconfident */
    it('「人に説明できる」でも全問正解の単位と問題を持たない単位は過信の単位に挙がらない', () => {
      const j = ok(graded(withUnits([{ topic_id: 2, understood: 3 }, { topic_id: 4, understood: 3 }])).r)
      expect(j.overconfident_units).toEqual([])
    })

    /** @covers REQ-314#unknown-terms-collected */
    it('単位ごとの説明の無かった語を、重ねずに周の unknown_terms に集める', () => {
      const j = ok(graded().r)
      expect([...j.unknown_terms].sort()).toEqual(['語A', '語B'])
    })

    /** @covers REQ-314#explain-score */
    it('説明テストの採点を添えると、得点の合計 ÷（2 × 語の数）・2 点の語の数・語の数を explain に出す', () => {
      const j = ok(graded(BASE, undefined, { grades: { 単位五: 2, 単位九: 1, 単位二: 0 } }).r)
      expect(j.explain.n).toBe(3)
      expect(j.explain.can_explain).toBe(1)
      expect(j.explain.rate).toBeCloseTo(3 / 6)
    })

    /** @covers REQ-314#no-explain-no-field */
    it('説明テストの採点を添えなければ explain を持たない', () => {
      expect(ok(graded().r).explain).toBeUndefined()
    })

    /** @covers REQ-314#delta-from-latest-earlier */
    it('より小さい番号の周の結果があれば、そのうち最も大きい番号の物との差を出す（大きい番号の周は見ない）', () => {
      const j = ok(graded(BASE, (ws) => {
        ws.write(resultFile(3), { cycle: 3, rate: 0.9, avg_understood: 3 })
        ws.write(resultFile(5), { cycle: 5, rate: 0.25, avg_understood: 1.5 })
        ws.write(resultFile(9), { cycle: 9, rate: 0.1, avg_understood: 1 })
      }).r)
      expect(j.delta_rate).toBeCloseTo(0.25)
      expect(j.delta_understood).toBeCloseTo(0.5)
    })

    /** @covers REQ-314#no-earlier-no-delta */
    it('より小さい番号の周の結果が無ければ差を持たない', () => {
      const j = ok(graded(BASE, (ws) => ws.write(resultFile(9), { cycle: 9, rate: 0.1, avg_understood: 1 })).r)
      expect(j.delta_rate).toBeUndefined()
      expect(j.delta_understood).toBeUndefined()
    })

    /** @covers REQ-314#result-saved */
    it('周の結果を学びの置き場の eval の下の cycle_<周>.json に残し、中身は示した結果と同じ', () => {
      const { ws, r } = graded()
      const j = ok(r)
      expect(JSON.parse(ws.read(resultFile(8)))).toEqual(j)
      expect(j.shift_window).toBe(3)
    })

    /** @covers REQ-314#tallied-by-snapshot */
    it('パックを作った後に今の問題の到達基準や属する単位が変わっても、写しの到達基準・単位・分野で数える', () => {
      const j = ok(graded(BASE, (ws) => writeQuestions(ws, [
        question('t5-1', 9, 3, 'イ'), question('t5-2', 2, 3, 'エ'), question('t2-1', 9, 3, 'ア'), question('t9-1', 5, 3, 'ウ'),
      ])).r)
      expect(j.by_goal).toEqual({ '1': '2/2', '2': '0/2' })
      expect(j.per_unit['5']).toMatchObject({ correct: 1, total: 2 })
      expect(j.per_unit['9']).toMatchObject({ correct: 0, total: 1 })
    })
  })

  describe('いつもその周の写しで採点する（REQ-310）', () => {
    const changed = (ws: Workspace) => writeQuestions(ws, QUESTION_BUNDLES.flat().map((q) => (q.qid === 't5-2' ? { ...q, answer: 'ア' } : q)))

    /** @covers REQ-310#graded-by-snapshot-answer */
    it('今の正解が変わっていても、写しの正解を選んだ答えを正答に数える', () => {
      const ans = withUnits([], ALL_CORRECT)
      const j = ok(graded(ans, changed).r)
      expect(j.score).toBe('4/4')
      expect(j.wrong).toEqual([])
    })

    /** @covers REQ-310#changed-answers-listed */
    it('写しと今とで正解が変わった問題を changed_answers に挙げる', () => {
      expect(ok(graded(BASE, changed).r).changed_answers).toEqual(['t5-2'])
    })

    /** @covers REQ-310#no-change-empty */
    it('正解が変わった問題が無ければ changed_answers は空', () => {
      expect(ok(graded().r).changed_answers).toEqual([])
    })

    /** @covers REQ-310#removed-from-current-still-graded */
    it('今の確認問題から消えた写しの問題も採点に入る', () => {
      const j = ok(graded(BASE, (ws) => writeQuestions(ws, QUESTION_BUNDLES.flat().filter((q) => q.qid !== 't9-1'))).r)
      expect(j.score).toBe('2/4')
      expect((j.wrong as Json[]).map((w) => w.qid)).toContain('t9-1')
    })

    /** @covers REQ-310#added-to-current-not-graded */
    it('写しの後に今の確認問題に足された問題は、答えがあっても採点に入らない', () => {
      const ans = withUnits(BASE.units, { ...BASE.answers, 't2-2': 'ア' })
      const j = ok(graded(ans, (ws) => writeQuestions(ws, [...QUESTION_BUNDLES.flat(), question('t2-2', 2, 1, 'ア')])).r)
      expect(j.score).toBe('2/4')
      expect(j.per_unit['2']).toMatchObject({ correct: 1, total: 1 })
    })

    /** @covers REQ-310#roadmap-changed-irrelevant */
    it('パックを作った後にロードマップの並びや単位が変わっても、写しの単位で数える', () => {
      const j = ok(graded(BASE, (ws) => ws.write(ROADMAP_FILE, roadmapOf([...UNITS].reverse().filter((u) => u.topic_id !== 4).map((u, i) => ({ ...u, order: i + 1 }))))).r)
      expect(Object.keys(j.per_unit).sort()).toEqual(['2', '4', '5', '9'])
      expect(j.score).toBe('2/4')
    })

    /** @covers REQ-310#body-and-figure-not-read */
    it('配る本文や図の画像が今は欠けていても、採点は止まらず同じ結果になる', () => {
      const base = ok(graded().r)
      const j = ok(graded(BASE, (ws) => {
        ws.remove(DELIVERED_FILE)
        ws.remove('public/figures/materials/eng')
      }).r)
      expect(j).toEqual(base)
    })
  })

  /** @covers REQ-310#explain-terms-not-read */
  it('説明テストの語の一覧が今は読めなくても、採点は止まらず同じ結果になる', () => {
    const base = ok(graded().r)
    expect(ok(graded(BASE, (ws) => ws.write(EXPLAIN_FILE, '{ "terms": ')).r)).toEqual(base)
  })

  for (const [label, breakIt] of [
    ['配る本文の図が PNG に描けない', (ws: Workspace) => ws.write('public/figures/materials/eng/sub/2-1.svg', 'これは図ではない')],
    ['同じ PNG の名前になる図がある', (ws: Workspace) => {
      ws.write('public/figures/materials/eng/5-1.png', PNG)
      addFigureLine(ws, 4, '/figures/materials/eng/5-1.png')
    }],
    ['今のロードマップに欠けた行がある', (ws: Workspace) => ws.write(ROADMAP_FILE, roadmapOf(UNITS.map((u, i) => (i === 1 ? ({ ...u, term: undefined } as unknown as typeof u) : u))))],
  ] as const) {
    /** @covers REQ-310#pack-build-failures-not-read */
    it(`パックを作れない状態（${label}）でも、採点は止まらず同じ結果になる`, () => {
      const base = ok(graded().r)
      expect(ok(graded(BASE, breakIt).r)).toEqual(base)
    })
  }

  describe('自己申告の別名（REQ-311）', () => {
    for (const alias of ['understanding', 'understand']) {
      /** @covers REQ-311#understood-alias */
      it(`理解の段を別名 ${alias} で書いても understood として数える`, () => {
        const j = ok(graded(withUnits([{ topic_id: 5, [alias]: 3 }, { topic_id: 9, [alias]: 1 }])).r)
        expect(j.per_unit['5'].understood).toBe(3)
        expect(j.per_unit['9'].understood).toBe(1)
        expect(j.reported_units).toBe(2)
      })
    }

    /** @covers REQ-311#confusing-alias */
    it('混ざった単位を別名 confusing_with で書いても confusing として残す', () => {
      const j = ok(graded(withUnits([{ topic_id: 5, understood: 3, confusing_with: '単位二' }])).r)
      expect(j.per_unit['5'].confusing).toBe('単位二')
    })

    for (const alias of ['unclear_terms', 'unexplained_terms']) {
      /** @covers REQ-311#unknown-terms-alias */
      it(`説明の無かった語を別名 ${alias} で書いても unknown_terms として集める`, () => {
        const j = ok(graded(withUnits([{ topic_id: 5, understood: 3, [alias]: ['語C'] }])).r)
        expect(j.per_unit['5'].unknown_terms).toEqual(['語C'])
        expect(j.unknown_terms).toEqual(['語C'])
      })
    }

    /** @covers REQ-311#alias-equal-to-canonical */
    it('決めた名前と別名が同じ値で並ぶ行は、食い違いとせず採点する', () => {
      const j = ok(graded(withUnits([{ topic_id: 5, understood: 3, understanding: 3, unknown_terms: ['語C'], unclear_terms: ['語C'] }])).r)
      expect(j.per_unit['5'].understood).toBe(3)
      expect(j.per_unit['5'].unknown_terms).toEqual(['語C'])
    })
  })

  describe('自己申告の読めない行（REQ-312）', () => {
    /** 止まったことと周の結果が無いことを見て、挙がった行を index の順に、条件を並べ替えて返す。 */
    const rejects = (units: Json[], setup?: (ws: Workspace) => void) => {
      const { ws, r } = graded(withUnits(units), setup)
      expectStopped(r, ws, 'INVALID_INPUT')
      const rows = (toolError(r.json)?.rows ?? []) as Json[]
      return rows.map((x) => ({ index: x.index, conditions: [...x.conditions].sort() })).sort((x, y) => x.index - y.index)
    }

    /** @covers REQ-312#missing-id */
    it('単位の ID が無い行を missingId で挙げて採点を止める', () => {
      expect(rejects([{ topic_id: 5, understood: 3 }, { understood: 2 }])).toEqual([{ index: 1, conditions: ['missingId'] }])
    })

    for (const id of ['17', 1.5, true]) {
      /** @covers REQ-312#non-integer-id */
      it(`単位の ID が整数でない行（${JSON.stringify(id)}）を idNotInteger で挙げて採点を止める`, () => {
        expect(rejects([{ topic_id: id, understood: 2 }])).toEqual([{ index: 0, conditions: ['idNotInteger'] }])
      })
    }

    /** @covers REQ-312#id-not-in-snapshot */
    it('単位の ID が写しのロードマップに無い行は、今のロードマップにあっても idNotInSnapshot で挙げる', () => {
      const rows = rejects([{ topic_id: 88, understood: 2 }], (ws) => ws.write(ROADMAP_FILE, roadmapOf([...UNITS, { ...UNITS[3], order: 5, topic_id: 88, term: '単位八八' }])))
      expect(rows).toEqual([{ index: 0, conditions: ['idNotInSnapshot'] }])
    })

    /** @covers REQ-312#id-not-in-snapshot */
    it('単位の ID 999 が写しのロードマップに無ければ idNotInSnapshot で挙げる', () => {
      expect(rejects([{ topic_id: 5 }, { topic_id: 999, understood: 2 }])).toEqual([{ index: 1, conditions: ['idNotInSnapshot'] }])
    })

    /** @covers REQ-312#duplicate-id */
    it('同じ単位の ID の行が 2 つあれば、値が同じでも両方の行を duplicateId で挙げる', () => {
      expect(rejects([{ topic_id: 5, understood: 3 }, { topic_id: 5, understood: 3 }])).toEqual([
        { index: 0, conditions: ['duplicateId'] },
        { index: 1, conditions: ['duplicateId'] },
      ])
    })

    /** @covers REQ-312#canonical-alias-conflict */
    it('決めた名前と別名が違う値で並ぶ行を aliasConflict で挙げる', () => {
      expect(rejects([{ topic_id: 5, understood: 3, understanding: 2 }])).toEqual([{ index: 0, conditions: ['aliasConflict'] }])
    })

    /** @covers REQ-312#alias-alias-conflict */
    it('別名どうしが違う値で並ぶ行を aliasConflict で挙げる', () => {
      expect(rejects([{ topic_id: 5, unclear_terms: ['語A'], unexplained_terms: ['語B'] }])).toEqual([{ index: 0, conditions: ['aliasConflict'] }])
    })

    for (const [label, row] of [
      ['理解の段が 1〜3 の外', { understood: 4 }],
      ['別名の理解の段が 1〜3 の外', { understanding: 0 }],
      ['理解の段が整数でない', { understood: 2.5 }],
      ['読んだ分数が負', { minutes: -1 }],
      ['読んだ分数が数でない', { minutes: '5' }],
      ['混ざった単位が文字列でない', { confusing: 3 }],
      ['説明の無かった語が配列でない', { unknown_terms: '語A' }],
      ['説明の無かった語の要素が文字列でない', { unknown_terms: [1] }],
    ] as const) {
      /** @covers REQ-312#value-out-of-range */
      it(`欄の値が契約の自己申告の形の外の行（${label}）を valueOutOfRange で挙げる`, () => {
        expect(rejects([{ topic_id: 5, ...row }])).toEqual([{ index: 0, conditions: ['valueOutOfRange'] }])
      })
    }

    /** @covers REQ-312#multiple-conditions-in-row */
    it('1 つの行が複数の条件に当たれば、その行に当たった条件をすべて添える', () => {
      expect(rejects([{ topic_id: 999, understood: 4 }])).toEqual([{ index: 0, conditions: ['idNotInSnapshot', 'valueOutOfRange'] }])
    })

    /** @covers REQ-312#multiple-conditions-in-row */
    it('写しに無い同じ単位の ID の行が 2 つあれば、各行に idNotInSnapshot と duplicateId の両方を添える', () => {
      expect(rejects([{ topic_id: 999 }, { topic_id: 999 }])).toEqual([
        { index: 0, conditions: ['duplicateId', 'idNotInSnapshot'] },
        { index: 1, conditions: ['duplicateId', 'idNotInSnapshot'] },
      ])
    })

    /** @covers REQ-312#all-rows-listed */
    it('条件の違う読めない行が複数あれば、最初の 1 行で止めずにすべて挙げる', () => {
      expect(rejects([
        { understood: 3 },
        { topic_id: '17' },
        { topic_id: 999 },
        { topic_id: 5, confusing: 'a', confusing_with: 'b' },
        { topic_id: 2, minutes: -3 },
      ])).toEqual([
        { index: 0, conditions: ['missingId'] },
        { index: 1, conditions: ['idNotInteger'] },
        { index: 2, conditions: ['idNotInSnapshot'] },
        { index: 3, conditions: ['aliasConflict'] },
        { index: 4, conditions: ['valueOutOfRange'] },
      ])
    })
  })

  describe('記録のずれの疑い（REQ-313）', () => {
    /** 5 問の写し（周 9）。正解は ア・イ・ウ・エ・ア。 */
    const SHIFT_SNAPSHOT = {
      cycle: 9,
      units: SNAPSHOT_8.units,
      questions: [
        { qid: 'q1', topic_id: 5, tests_goal: 1, field: '分野甲', answer: 'ア' },
        { qid: 'q2', topic_id: 5, tests_goal: 1, field: '分野甲', answer: 'イ' },
        { qid: 'q3', topic_id: 2, tests_goal: 1, field: '分野甲', answer: 'ウ' },
        { qid: 'q4', topic_id: 9, tests_goal: 2, field: '分野乙', answer: 'エ' },
        { qid: 'q5', topic_id: 9, tests_goal: 2, field: '分野乙', answer: 'ア' },
      ],
    }
    const shift = (picked: string[]) => {
      const ws = makeWorkspace()
      writeQuestions(ws, SHIFT_SNAPSHOT.questions.map((q) => question(q.qid, q.topic_id, q.tests_goal, q.answer)))
      prepareGrade(ws, { answers: Object.fromEntries(picked.map((p, i) => [`q${i + 1}`, p])), units: [] }, SHIFT_SNAPSHOT)
      const j = ok(grade(ws, { cycle: 9 }))
      expect(j.shift_window).toBe(3)
      return [...j.shift_suspect].sort()
    }

    /** @covers REQ-313#shift-backward */
    it('3 問続けて誤答で、選んだ答えを 1 つ後ろへずらすと窓の正解に重なれば、その 3 問を挙げる', () => {
      expect(shift(['エ', 'ア', 'イ', 'エ', 'ア'])).toEqual(['q1', 'q2', 'q3'])
    })

    /** @covers REQ-313#shift-forward */
    it('3 問続けて誤答で、選んだ答えを 1 つ前へずらすと窓の正解に重なれば、その 3 問を挙げる', () => {
      expect(shift(['イ', 'ウ', 'ア', 'エ', 'ア'])).toEqual(['q1', 'q2', 'q3'])
    })

    /** @covers REQ-313#all-wrong-no-shift */
    it('続けて誤答でも、ずらして窓の正解に重ならなければ挙げない', () => {
      expect(shift(['エ', 'エ', 'エ', 'ア', 'ア'])).toEqual([])
    })

    for (const [label, picked] of [
      ['窓の中に正答が 1 つある', ['エ', 'ア', 'ウ', 'エ', 'ア']],
      ['ずれた誤答が 2 問しか続かない', ['ア', 'ア', 'イ', 'エ', 'ア']],
    ] as const) {
      /** @covers REQ-313#run-shorter-than-window */
      it(`ずらすと正解に重なる並びでも、${label}ときは挙げない`, () => {
        expect(shift([...picked])).toEqual([])
      })
    }
  })

  describe('登録簿に無い学びか、ロードマップを持たない学び（REQ-318）', () => {
    /** @covers REQ-318#exam-learning-grade */
    it('資格型の学びは、写しと確認問題を置いても INVALID_INPUT で断り、周の結果を残さない', () => {
      const ws = makeWorkspace()
      ws.write(snapshotFile(8, 'ip'), SNAPSHOT_8)
      ws.write('data/ip/roadmap.json', ws.read(ROADMAP_FILE))
      ws.write('data/ip/roadmap_questions/bundle_01.json', ws.read(`${QUESTIONS_DIR}/bundle_01.json`))
      ws.write('answers/learner.json', BASE)
      expectStopped(grade(ws, { data: 'data/ip' }), ws, 'INVALID_INPUT', 8, 'ip')
    })

    /** @covers REQ-318#unregistered-grade */
    it('登録簿に無い学びは INVALID_INPUT で断る', () => {
      const ws = makeWorkspace()
      ws.write(snapshotFile(8, 'zzz'), SNAPSHOT_8)
      ws.write('answers/learner.json', BASE)
      expectStopped(grade(ws, { data: 'data/zzz' }), ws, 'INVALID_INPUT', 8, 'zzz')
    })

    /** @covers REQ-318#roadmap-file-missing-grade */
    it('ロードマップ型でもロードマップのファイルが無ければ INVALID_INPUT で断る', () => {
      const { ws, r } = graded(BASE, (w) => w.remove(ROADMAP_FILE))
      expectStopped(r, ws, 'INVALID_INPUT')
    })

    /** @covers REQ-318#not-roadmap-before-questions-missing */
    it('資格型の学びで確認問題も無いときは INVALID_INPUT（確認問題の欠けより先）', () => {
      const ws = makeWorkspace()
      ws.write(snapshotFile(8, 'ip'), SNAPSHOT_8)
      ws.write('answers/learner.json', BASE)
      expectStopped(grade(ws, { data: 'data/ip' }), ws, 'INVALID_INPUT', 8, 'ip')
    })
  })

  describe('今の確認問題が無いか読めない（REQ-333）', () => {
    /** @covers REQ-333#questions-missing-grade */
    it('今の確認問題が無ければ NOT_FOUND で採点を止める', () => {
      const { ws, r } = graded(BASE, (w) => w.remove(QUESTIONS_DIR))
      expectStopped(r, ws, 'NOT_FOUND')
    })

    for (const [label, file, breakIt] of [
      ['JSON として読めない束', `${QUESTIONS_DIR}/bundle_02.json`, (w: Workspace) => w.write(`${QUESTIONS_DIR}/bundle_02.json`, '{ "questions": [')],
      ['選択肢の外の正解', `${QUESTIONS_DIR}/bundle_01.json`, (w: Workspace) => writeQuestions(w, [question('t5-1', 5, 1, 'オ')])],
    ] as const) {
      /** @covers REQ-333#questions-unreadable-grade */
      it(`今の確認問題に「${label}」があれば INVALID_INPUT で採点を止め、読めないファイルを挙げる`, () => {
        const { ws, r } = graded(BASE, breakIt)
        expectStopped(r, ws, 'INVALID_INPUT')
        expect(toolError(r.json).unreadable).toEqual([file])
      })
    }

    /** @covers REQ-333#unreadable-before-no-snapshot */
    it('今の確認問題が読めずその周の写しも無いときは INVALID_INPUT（写しの欠けより先）', () => {
      const { ws, r } = graded(BASE, (w) => {
        w.write(`${QUESTIONS_DIR}/bundle_02.json`, '{ "questions": [')
        w.remove(snapshotFile(8))
      })
      expectStopped(r, ws, 'INVALID_INPUT')
    })

    /** @covers REQ-333#missing-before-no-snapshot */
    it('今の確認問題が無くその周の写しも無いときは NOT_FOUND で止める', () => {
      const { ws, r } = graded(BASE, (w) => {
        w.remove(QUESTIONS_DIR)
        w.remove(snapshotFile(8))
      })
      expectStopped(r, ws, 'NOT_FOUND')
    })
  })

  describe('その周のパックの写しが読めない（REQ-334）', () => {
    const SNAP = snapshotFile(8)
    for (const [label, body] of [
      ['JSON として読めない', '{ "cycle": 8, '],
      ['questions が無い', JSON.stringify({ cycle: 8, units: SNAPSHOT_8.units })],
      ['units が無い', JSON.stringify({ cycle: 8, questions: SNAPSHOT_8.questions })],
      ['正解が選択肢の外', JSON.stringify({ ...SNAPSHOT_8, questions: [{ ...SNAPSHOT_8.questions[0], answer: 'オ' }] })],
      ['問題の到達基準が無い', JSON.stringify({ ...SNAPSHOT_8, questions: [{ qid: 't5-1', topic_id: 5, field: '分野甲', answer: 'イ' }] })],
      ['単位の ID が整数でない', JSON.stringify({ ...SNAPSHOT_8, units: [{ order: 1, topic_id: '5', term: '単位五', field: '分野甲' }] })],
    ] as const) {
      /** @covers REQ-334#snapshot-unreadable */
      it(`その周の写しが「${label}」なら INVALID_INPUT で採点を止め、その写しを挙げ、周の結果を残さない`, () => {
        const { ws, r } = graded(BASE, (w) => w.write(SNAP, body))
        expectStopped(r, ws, 'INVALID_INPUT')
        expect(toolError(r.json).unreadable).toEqual([SNAP])
      })
    }

    /** @covers REQ-334#unreadable-before-result-exists */
    it('その周の写しが読めず周の結果もあるときは INVALID_INPUT で止め、結果を書き換えない（結果ありより先）', () => {
      const existing = { cycle: 8, rate: 0.5, avg_understood: 2 }
      const { ws, r } = graded(BASE, (w) => {
        w.write(SNAP, '{ "cycle": 8, ')
        w.write(resultFile(8), existing)
      })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(toolError(r.json).unreadable).toEqual([SNAP])
      expect(JSON.parse(ws.read(resultFile(8)))).toEqual(existing)
    })
  })

  describe('その周のパックの写しが無い（REQ-322）', () => {
    /** @covers REQ-322#no-snapshot */
    it('その周の写しが無ければ NOT_FOUND で採点を止め、周の結果を残さない', () => {
      const { ws, r } = graded(BASE, (w) => w.remove(snapshotFile(8)))
      expectStopped(r, ws, 'NOT_FOUND')
    })

    /** @covers REQ-322#other-cycle-snapshot-only */
    it('別の周の写ししか無ければ、それで採点せず NOT_FOUND で止める', () => {
      const { ws, r } = graded(BASE, (w) => {
        w.remove(snapshotFile(8))
        w.write(snapshotFile(7), { ...SNAPSHOT_8, cycle: 7 })
      })
      expectStopped(r, ws, 'NOT_FOUND')
    })

    /** @covers REQ-322#no-snapshot-before-result-exists */
    it('その周の写しは無いが周の結果があるときは NOT_FOUND で止め、結果を書き換えない', () => {
      const { ws, r } = graded(BASE, (w) => {
        w.remove(snapshotFile(8))
        w.write(resultFile(8), { cycle: 8, rate: 0.5, avg_understood: 2 })
      })
      const before = JSON.stringify({ cycle: 8, rate: 0.5, avg_understood: 2 }, null, 2)
      expect(r.status).toBe(1)
      expect(r.code).toBe('NOT_FOUND')
      expect(ws.read(resultFile(8))).toBe(before)
    })
  })

  describe('その周の結果が既にある（REQ-332）', () => {
    const existing = { cycle: 8, rate: 0.5, avg_understood: 2 }

    /** @covers REQ-332#result-exists-before-previous-unreadable */
    it('その周の結果があり差を取る前の周の結果が読めないときは CONFLICT（前の周の読めなさより先）', () => {
      const { ws, r } = graded(BASE, (w) => {
        w.write(resultFile(8), existing)
        w.write(resultFile(5), '{ "cycle": 5, ')
      })
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(JSON.parse(ws.read(resultFile(8)))).toEqual(existing)
    })

    /** @covers REQ-332#result-exists */
    it('その周の結果があれば CONFLICT で採点を断り、結果を書き換えない', () => {
      const { ws, r } = graded(BASE, (w) => w.write(resultFile(8), existing))
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(JSON.parse(ws.read(resultFile(8)))).toEqual(existing)
    })

    /** @covers REQ-332#result-exists-before-answers-missing */
    it('その周の結果があり答えのファイルも無いときは CONFLICT（答えの欠けより先）', () => {
      const { ws, r } = graded(BASE, (w) => {
        w.write(resultFile(8), existing)
        w.remove('answers/learner.json')
      })
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(JSON.parse(ws.read(resultFile(8)))).toEqual(existing)
    })
  })

  describe('差を取る前の周の結果が読めない（REQ-339）', () => {
    for (const [label, body] of [
      ['JSON として読めない', '{ "cycle": 5, '],
      ['rate が無い', JSON.stringify({ cycle: 5, avg_understood: 1.5 })],
      ['avg_understood が数でない', JSON.stringify({ cycle: 5, rate: 0.25, avg_understood: '1.5' })],
      ['cycle が無い', JSON.stringify({ rate: 0.25, avg_understood: 1.5 })],
    ] as const) {
      /** @covers REQ-339#latest-earlier-unreadable */
      it(`より小さい番号のうち最も大きい周の結果が「${label}」なら INVALID_INPUT で止め、それを挙げ、周の結果を残さない`, () => {
        const { ws, r } = graded(BASE, (w) => {
          w.write(resultFile(3), { cycle: 3, rate: 0.9, avg_understood: 3 })
          w.write(resultFile(5), body)
        })
        expectStopped(r, ws, 'INVALID_INPUT')
        expect(toolError(r.json).unreadable).toEqual([resultFile(5)])
      })
    }

    for (const [label, cycle] of [['より前の周', 3], ['より後の周', 9]] as const) {
      /** @covers REQ-339#other-cycles-not-read */
      it(`差を取る周でない${label}の結果が読めなくても止めない`, () => {
        const j = ok(graded(BASE, (w) => {
          w.write(resultFile(5), { cycle: 5, rate: 0.25, avg_understood: 1.5 })
          w.write(resultFile(cycle), '{ "cycle": ')
        }).r)
        expect(j.delta_rate).toBeCloseTo(0.25)
      })
    }

    /** @covers REQ-339#unreadable-before-answers-missing */
    it('前の周の結果が読めず答えのファイルも無いときは INVALID_INPUT（答えの欠けより先）', () => {
      const { ws, r } = graded(BASE, (w) => {
        w.write(resultFile(5), '{ "cycle": 5, ')
        w.remove('answers/learner.json')
      })
      expectStopped(r, ws, 'INVALID_INPUT')
      expect(toolError(r.json).unreadable).toEqual([resultFile(5)])
    })
  })

  describe('引数が契約の形の外（REQ-340）', () => {
    const refusedArgs = (req: { data?: string; cycle?: number | string; answers?: string; explain?: string }, names: string[]) => {
      const ws = makeWorkspace()
      prepareGrade(ws, BASE)
      ws.write('answers/explain_grade.json', { grades: { 単位五: 2 } })
      const before = ws.snapshotTree()
      const r = grade(ws, req)
      expect(r.status).toBe(1)
      expect(r.code, r.stdout).toBe('INVALID_INPUT')
      expect([...(toolError(r.json)?.arguments ?? [])].sort()).toEqual([...names].sort())
      expect(ws.snapshotTree()).toEqual(before)
    }

    for (const cycle of [0, -1, '1.5', 'abc']) {
      /** @covers REQ-340#grade-bad-cycle */
      it(`周の番号が 1 以上の整数でない（${JSON.stringify(cycle)}）なら採点の入口は断り、何も書かない`, () => {
        refusedArgs({ cycle }, ['cycle'])
      })
    }

    /** @covers REQ-340#grade-empty-answers */
    it('答えのファイルが空なら採点の入口は断り、何も書かない', () => {
      refusedArgs({ answers: '' }, ['answers'])
    })

    /** @covers REQ-340#grade-empty-explain */
    it('説明テストの採点のファイルを空で渡すと採点の入口は断り、何も書かない', () => {
      refusedArgs({ explain: '' }, ['explain'])
    })

    for (const data of ['eng', 'data/Eng', 'data/eng/', '../data/eng', 'data/eng2']) {
      /** @covers REQ-340#grade-bad-data */
      it(`学びが学びの置き場の形でない（${data}）なら採点の入口は断り、何も書かない`, () => {
        refusedArgs({ data }, ['data'])
      })
    }

    /** @covers REQ-340#grade-all-bad-arguments-listed */
    it('形の外の引数が複数あれば、すべての名前を挙げる', () => {
      refusedArgs({ cycle: 0, answers: '' }, ['cycle', 'answers'])
    })

    /** @covers REQ-340#bad-args-before-not-roadmap-grade */
    it('資格型の学びで周の番号も形の外なら、引数の誤りとして cycle を挙げる', () => {
      refusedArgs({ data: 'data/ip', cycle: 0 }, ['cycle'])
    })
  })

  describe('答えのファイル（REQ-329）', () => {
    /** @covers REQ-329#answers-missing */
    it('答えのファイルが無ければ NOT_FOUND で採点を止める', () => {
      const { ws, r } = graded(BASE, (w) => w.remove('answers/learner.json'))
      expectStopped(r, ws, 'NOT_FOUND')
      expect(toolError(r.json).unreadable).toEqual(['answers/learner.json'])
    })

    for (const [label, body] of [
      ['JSON として読めない', '学習者役の報告です'],
      ['answers が無い', JSON.stringify({ units: [] })],
      ['units が無い', JSON.stringify({ answers: {} })],
      ['answers が物でない', JSON.stringify({ answers: ['イ'], units: [] })],
      ['選んだ答えが文字列でない', JSON.stringify({ answers: { 't5-1': 1 }, units: [] })],
    ] as const) {
      /** @covers REQ-329#answers-unreadable */
      it(`答えのファイルが「${label}」なら INVALID_INPUT で採点を止める`, () => {
        const { ws, r } = graded(BASE, (w) => w.write('answers/learner.json', body))
        expectStopped(r, ws, 'INVALID_INPUT')
      })
    }

    for (const picked of ['オ', 'A', 'イ ']) {
      /** @covers REQ-329#out-of-choice */
      it(`選んだ答えに選択肢の外の値（${JSON.stringify(picked)}）があれば INVALID_INPUT で採点を止める`, () => {
        const { ws, r } = graded(withUnits(BASE.units, { ...BASE.answers, 't9-1': picked }))
        expectStopped(r, ws, 'INVALID_INPUT')
        expect(toolError(r.json).qids).toEqual(['t9-1'])
      })
    }

    /** @covers REQ-329#answers-unreadable-before-explain-missing */
    it('答えのファイルが読めず説明テストの採点のファイルも無いときは INVALID_INPUT（説明テストの欠けより先）', () => {
      const ws = makeWorkspace()
      prepareGrade(ws, BASE)
      ws.write('answers/learner.json', '学習者役の報告です')
      expectStopped(grade(ws, { explain: 'answers/none.json' }), ws, 'INVALID_INPUT')
    })
  })

  describe('説明テストの採点のファイル（REQ-330）', () => {
    /** @covers REQ-330#explain-missing */
    it('添えた説明テストの採点のファイルが無ければ NOT_FOUND で採点を止める', () => {
      const ws = makeWorkspace()
      prepareGrade(ws, BASE)
      expectStopped(grade(ws, { explain: 'answers/none.json' }), ws, 'NOT_FOUND')
    })

    for (const [label, body] of [
      ['JSON として読めない', '採点のメモ'],
      ['grades が無い', { 単位五: 2 }],
      ['得点が 0〜2 の外', { grades: { 単位五: 3 } }],
      ['得点が整数でない', { grades: { 単位五: '2' } }],
    ] as const) {
      /** @covers REQ-330#explain-unreadable */
      it(`説明テストの採点のファイルが「${label}」なら INVALID_INPUT で採点を止める`, () => {
        const { ws, r } = graded(BASE, undefined, body)
        expectStopped(r, ws, 'INVALID_INPUT')
      })
    }

    /** @covers REQ-330#explain-missing-before-self-report */
    it('説明テストの採点のファイルが無く自己申告に読めない行もあるときは NOT_FOUND（自己申告より先）', () => {
      const ws = makeWorkspace()
      prepareGrade(ws, withUnits([{ topic_id: 999 }]))
      expectStopped(grade(ws, { explain: 'answers/none.json' }), ws, 'NOT_FOUND')
    })

    /** @covers REQ-330#explain-unreadable-before-self-report */
    it('説明テストの採点のファイルが読めず自己申告に読めない行もあるときは INVALID_INPUT で止める', () => {
      const { ws, r } = graded(withUnits([{ topic_id: 999 }]), undefined, '採点のメモ')
      expectStopped(r, ws, 'INVALID_INPUT')
    })
  })
})
