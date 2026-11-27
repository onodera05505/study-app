import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { DATA, LIMITS, bundleFile, check, dump, explanationsFile, findingText, findingsOf, makeWorkspace, pastQuestion, runGate, type Json, type Run, type Workspace } from './UC-022_fixture'

/** UC-022 資格対策の問題解説を配る前に教材の門で確かめる（checkExplanations）の境界。
 *  仕込みは一時の作業場の学びの写し（UC-022_fixture.ts）の上で、問題解説か入力の束だけを書き換えて作る。
 *  観測するのは終了の状態と、標準出力の JSON（response か断りの ToolError）だけ。人が読む行は見ない。 */

vi.setConfig({ testTimeout: 30_000 })

function once(f: () => Run): () => Run {
  let r: Run | undefined
  return () => (r ??= f())
}
const cleanRun = once(() => check(makeWorkspace()))

/** 問題解説のファイル 1 つを書き換えて門にかける。 */
function withExplanations(bundle: string, edit: (xs: Json[]) => void, ws: Workspace = makeWorkspace()): Run {
  ws.editExplanations(bundle, edit)
  return check(ws)
}
const explanation = (xs: Json[], qid: string) => xs.find((x) => x.question_id === qid)
const choice = (x: Json, label: string) => x.choices.find((c: Json) => c.label === label)
/** 2019h31h-q5（expl_01）を書き換えて門にかける。 */
const withQ5 = (edit: (x: Json) => void) => withExplanations('expl_01', (xs) => edit(explanation(xs, '2019h31h-q5')))

function expectResponse(r: Run) {
  expect(r.json, dump(r)).toBeTypeOf('object')
  expect(r.json, dump(r)).not.toBeNull()
  for (const k of ['exitCode', 'questions', 'stops', 'warnings', 'limits']) expect(r.json, `${k} が無い: ${dump(r)}`).toHaveProperty(k)
  expect(r.json.exitCode, dump(r)).toBe(r.status)
  expect(r.json.limits).toEqual(LIMITS)
  for (const f of [...r.json.stops, ...r.json.warnings]) {
    expect(typeof f.kind === 'string' && f.kind.length > 0, JSON.stringify(f)).toBe(true)
    expect(typeof f.where === 'string' && f.where.length > 0, JSON.stringify(f)).toBe(true)
    expect(typeof f.reason === 'string' && f.reason.length > 0, JSON.stringify(f)).toBe(true)
  }
}
function expectStop(r: Run, kind: string, ...needles: string[]) {
  expect(r.status, dump(r)).toBe(1)
  expectResponse(r)
  const hits = findingsOf(r.json.stops, kind)
  expect(hits.length, `${kind} の止める理由が無い: ${dump(r)}`).toBeGreaterThan(0)
  expect(hits.some((f) => needles.every((n) => findingText(f).includes(n))), JSON.stringify(hits)).toBe(true)
}
function expectWarningOnly(r: Run, kind: string, ...needles: string[]) {
  expect(r.status, dump(r)).toBe(0)
  expectResponse(r)
  expect(r.json.stops).toEqual([])
  const hits = findingsOf(r.json.warnings, kind)
  expect(hits.length, `${kind} の警告が無い: ${dump(r)}`).toBeGreaterThan(0)
  expect(hits.some((f) => needles.every((n) => findingText(f).includes(n))), JSON.stringify(hits)).toBe(true)
}
function expectCleanPass(r: Run) {
  expect(r.status, dump(r)).toBe(0)
  expectResponse(r)
  expect(r.json.stops).toEqual([])
  expect(r.json.warnings).toEqual([])
}
/** 止める理由に kind が無い（通るかどうかは問わない）。 */
function expectNoStop(r: Run, kind: string) {
  expectResponse(r)
  expect(findingsOf(r.json.stops, kind), dump(r)).toEqual([])
}
function expectRefusal(r: Run, code: string) {
  expect(r.status, dump(r)).not.toBe(0)
  expect(r.code, dump(r)).toBe(code)
  expect(r.reason.length, dump(r)).toBeGreaterThan(0)
  expect(r.json?.stops, dump(r)).toBeUndefined()
}
function labelled(label: string, f: () => void) {
  try {
    f()
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`)
  }
}
/** 句点を含まない n 字の文字列を作り、末尾を「です。」で終える（全体で n 字）。 */
/** 同一内容の判定の鍵（BR-052。本文に選択肢をア〜エの順に続け、空白を除いた sha1 の先頭 16 桁）。 */
const contentKeyOf = (text: string, ch: Record<string, string>) =>
  createHash('sha1').update([text, ch['ア'], ch['イ'], ch['ウ'], ch['エ']].join('').replace(/\s/g, ''), 'utf8').digest('hex').slice(0, 16)
/** 入力の束に無い過去問 2018h30a-q4 の、形の整った問題解説。 */
const explanationOfQ4 = () => {
  const q = pastQuestion('2018h30a', 4)
  return {
    question_id: '2018h30a-q4',
    content_key: contentKeyOf(q.text, q.choices),
    correct: 'ア',
    correct_reason: '日々の点検を受け持つ点が決め手です。',
    choices: [
      { label: 'ア', term: null, note: '正解。' },
      { label: 'イ', term: '要件定義', note: '作る物に求めることを決める仕事です。' },
      { label: 'ウ', term: '基本設計', note: '仕組みの骨組みを決める仕事です。' },
      { label: 'エ', term: '受入試験', note: '出来上がった物を受け取る前に確かめる仕事です。' },
    ],
  }
}
/** 論点の一覧（topics.json）を書き換える。 */
const editTopics = (ws: Workspace, edit: (ts: Json[]) => void) => {
  const doc = ws.readJson(`${DATA}/topics.json`)
  edit(doc.topics)
  ws.write(`${DATA}/topics.json`, doc)
}
/** 教材の世代のファイル（学びの置き場からの相対）を書き換える。 */
const editMaterials = (ws: Workspace, rel: string, edit: (ms: Json[]) => void) => {
  const doc = ws.readJson(`${DATA}/${rel}`)
  edit(doc.materials)
  ws.write(`${DATA}/${rel}`, doc)
}
const politeOf = (n: number) => '作業を進めること自体を引き受ける約束で出来上がりではなく進め方に責任を持つ'.repeat(10).slice(0, n - 3) + 'です。'

describe('UC-022 資格対策の問題解説を配る前に教材の門で確かめる（checkExplanations）', () => {
  describe('止める理由が無ければ通し、見た数と警告を返す（REQ-393）', () => {
    /** @covers REQ-393#pass-clean */
    it('止める理由も警告も無い問題解説は、終了の状態 0 で通し、見た問題の数 4 と門が使った値を返す', () => {
      const r = cleanRun()
      expectCleanPass(r)
      expect(r.json).toEqual({ exitCode: 0, questions: 4, stops: [], warnings: [], limits: LIMITS })
    })

    /** @covers REQ-393#pass-with-warnings */
    it('警告だけが当たる問題解説（用語の説明が上限を超える）は通し、警告ごとに種類と問題と箇所を返す', () => {
      const r = withQ5((x) => (choice(x, 'イ').note = politeOf(LIMITS.choiceNoteLength + 1)))
      expectWarningOnly(r, 'choiceNoteLong', '2019h31h-q5')
      expect(r.json.questions).toBe(4)
    })
  })

  describe('登録簿に無い学び・資格対策でない学び・入力の束の置き場が無い・正解表が無いか読めないときは、何も確かめずに断る（REQ-394）', () => {
    /** @covers REQ-394#bad-arguments */
    it('知らない名前の引数・値の無い引数は、INVALID_INPUT で断る（場合ごと）', () => {
      const ws = makeWorkspace()
      const cases: [string, string[]][] = [
        ['知らない名前の引数', ['--data', DATA, '--unknownArgument', 'x']],
        ['data に値が無い', ['--data']],
        ['bundles に値が無い', ['--data', DATA, '--bundles']],
      ]
      for (const [label, args] of cases) labelled(label, () => expectRefusal(runGate(ws, args), 'INVALID_INPUT'))
    })

    /** @covers REQ-394#unknown-learning */
    it('登録簿に無い学び（置き場はあり、問題解説は壊れている）は、INVALID_INPUT で断り、何も確かめない', () => {
      const ws = makeWorkspace()
      ws.write(explanationsFile('expl_01', 'data/zzz'), '{"bundle": "expl_01", "explanations": [')
      expectRefusal(check(ws, 'data/zzz'), 'INVALID_INPUT')
    })

    /** @covers REQ-394#not-qualification */
    it('資格対策でない学び（ロードマップ型の itc。置き場はあり、問題解説は壊れている）は、INVALID_INPUT で断り、何も確かめない', () => {
      const ws = makeWorkspace()
      ws.write(explanationsFile('expl_01', 'data/itc'), '{"bundle": "expl_01", "explanations": [')
      expectRefusal(check(ws, 'data/itc'), 'INVALID_INPUT')
    })

    /** @covers REQ-394#bundles-missing */
    it('入力の束の置き場が無い（指定した置き場が無い・省略時の explanation_bundles が無い）と、NOT_FOUND で断る（場合ごと）', () => {
      labelled('指定した置き場が無い', () => expectRefusal(check(makeWorkspace(), DATA, `${DATA}/explanation_bundles_x`), 'NOT_FOUND'))
      const ws = makeWorkspace()
      ws.remove(`${DATA}/explanation_bundles`)
      labelled('省略時の置き場が無い', () => expectRefusal(check(ws), 'NOT_FOUND'))
    })

    /** @covers REQ-394#not-qualification-before-bundles-missing */
    it('資格対策でない学びで入力の束の置き場も無いときは、INVALID_INPUT で断る', () => {
      expectRefusal(check(makeWorkspace(), 'data/itc', `${DATA}/explanation_bundles_x`), 'INVALID_INPUT')
    })

    /** @covers REQ-394#answer-keys-missing */
    it('正解表の無い学びは、壊れた問題解説があっても何も確かめずに NOT_FOUND で断る', () => {
      const ws = makeWorkspace()
      ws.remove(`${DATA}/answer_keys.json`)
      ws.write(explanationsFile('expl_02'), '{"bundle": "expl_02", "explanations": [')
      expectRefusal(check(ws), 'NOT_FOUND')
    })

    /** @covers REQ-394#answer-keys-unreadable */
    it('JSON として読めない正解表の学びは、何も確かめずに INVALID_INPUT で断る', () => {
      const ws = makeWorkspace()
      ws.write(`${DATA}/answer_keys.json`, '{"2018h30a": {"1": "ア", ')
      expectRefusal(check(ws), 'INVALID_INPUT')
    })

    /** @covers REQ-394#answer-key-value-not-string */
    it('正解が文字列でない値（2019h31h の 5 が ["ア"]）を持つ正解表の学びは、壊れた問題解説があっても何も確かめずに INVALID_INPUT で断る', () => {
      const ws = makeWorkspace()
      const keys = ws.readJson(`${DATA}/answer_keys.json`)
      keys['2019h31h']['5'] = ['ア']
      ws.write(`${DATA}/answer_keys.json`, keys)
      ws.write(explanationsFile('expl_02'), '{"bundle": "expl_02", "explanations": [')
      expectRefusal(check(ws), 'INVALID_INPUT')
    })
  })

  describe('読めないファイル（過去問を含む）・問題解説の無い問題・2 つ以上ある問題は止める（REQ-395）', () => {
    /** @covers REQ-395#explanations-file-unreadable */
    it('途中で途切れた問題解説のファイル（書き手が書いている途中）は、unreadableOutput でそのファイルを挙げて止める', () => {
      const ws = makeWorkspace()
      ws.write(explanationsFile('expl_02'), '{"bundle": "expl_02", "explanations": [')
      expectStop(check(ws), 'unreadableOutput', 'expl_02')
    })

    /** @covers REQ-395#explanation-missing */
    it('入力の束にある問題（2018h30a-q2）の問題解説が無いと、missingExplanation でその問題を挙げて止める', () => {
      const r = withExplanations('expl_01', (xs) => xs.splice(xs.indexOf(explanation(xs, '2018h30a-q2')), 1))
      expectStop(r, 'missingExplanation', '2018h30a-q2')
    })

    /** @covers REQ-395#duplicate-across-files */
    it('同じ問題（2018h30a-q3）の問題解説が 2 つのファイルにあると、duplicate でその問題を挙げて止める', () => {
      const ws = makeWorkspace()
      const copy = explanation(ws.readJson(explanationsFile('expl_02')).explanations, '2018h30a-q3')
      expectStop(withExplanations('expl_01', (xs) => xs.push(copy), ws), 'duplicate', '2018h30a-q3')
    })

    /** @covers REQ-395#bundle-file-unreadable */
    it('途中で途切れた入力の束のファイル（expl_02）は、unreadableOutput でそのファイルを挙げて止める', () => {
      const ws = makeWorkspace()
      ws.write(bundleFile('expl_02'), '{"bundle": "expl_02", "topics": [')
      expectStop(check(ws), 'unreadableOutput', 'expl_02')
    })

    /** @covers REQ-395#past-questions-unreadable */
    it('1 問（6）の問番号が文字列の過去問のファイル（2019h31h）が 1 つあり、ほかの回（2018h30a）が読める学びは、そのファイルを挙げて unreadableOutput で止める', () => {
      const ws = makeWorkspace()
      const file = `${DATA}/questions/2019h31h.json`
      const doc = ws.readJson(file)
      doc.questions.find((q: Json) => q.number === 6).number = '6'
      ws.write(file, doc)
      expectStop(check(ws), 'unreadableOutput', '2019h31h')
    })

    /** @covers REQ-395#explanations-file-missing */
    it('入力の束（expl_02）と同じ名前の問題解説のファイルが無いと、その束の問題をそれぞれ missingExplanation で挙げて止める', () => {
      const ws = makeWorkspace()
      ws.remove(explanationsFile('expl_02'))
      const r = check(ws)
      expectStop(r, 'missingExplanation', '2018h30a-q3')
      expectStop(r, 'missingExplanation', '2019h31h-q6')
    })

    /** @covers REQ-395#explanation-outside-bundle */
    it('同じ名前の入力の束（expl_01）に無い問題（2018h30a-q4）の問題解説を持つファイルは、bundleMismatch でその問題を挙げて止める', () => {
      expectStop(withExplanations('expl_01', (xs) => xs.push(explanationOfQ4())), 'bundleMismatch', '2018h30a-q4')
    })

    /** @covers REQ-395#bundle-without-explanations-file-name */
    it('同じ名前の入力の束が無い問題解説のファイル（expl_03）は、束と突き合わせず bundleMismatch にしない', () => {
      const ws = makeWorkspace()
      ws.write(explanationsFile('expl_03'), { bundle: 'expl_03', explanations: [explanationOfQ4()] })
      expectNoStop(check(ws), 'bundleMismatch')
    })
  })

  describe('正解の根拠と選択肢ごとの説明の量は止める理由にも警告にもしない（REQ-396）', () => {
    /** @covers REQ-396#short-not-flagged */
    it('正解の根拠が 1 文で、正解の説明が「正解。」だけの問題解説は、止めも警告もしない', () => {
      expectCleanPass(cleanRun())
    })

    /** @covers REQ-396#long-not-flagged */
    it('正解の根拠が 30 文あり、用語の説明に使わない選択肢の説明が 300 字ある問題解説は、止めも警告もしない', () => {
      const r = withQ5((x) => {
        x.correct_reason = `${x.correct_reason}${'仕上がりの責任を誰が持つかを順に確かめます。'.repeat(29)}`
        choice(x, 'ア').note = `正解。${politeOf(297)}`
      })
      expectCleanPass(r)
    })
  })

  describe('用語の説明に使う選択肢の説明が表示の制約の上限を超えると、止めずに警告する（REQ-397）', () => {
    /** @covers REQ-397#choice-note-over-limit */
    it('用語の説明に使う選択肢の説明が 91 字だと、止めずに choiceNoteLong で問題と選択肢を挙げる', () => {
      const r = withQ5((x) => (choice(x, 'イ').note = politeOf(LIMITS.choiceNoteLength + 1)))
      expectWarningOnly(r, 'choiceNoteLong', '2019h31h-q5', 'イ')
    })

    /** @covers REQ-397#choice-note-at-limit */
    it('用語の説明に使う選択肢の説明がちょうど 90 字なら、警告しない', () => {
      expectCleanPass(withQ5((x) => (choice(x, 'イ').note = politeOf(LIMITS.choiceNoteLength))))
    })

    /** @covers REQ-397#correct-choice-note-over-limit */
    it('用語を持つ正解の選択肢の説明が「正解。」を含めて 91 字だと、止めずに choiceNoteLong で問題と選択肢を挙げる', () => {
      const r = withQ5((x) => {
        const a = choice(x, 'ア')
        a.term = '請負契約'
        a.note = `正解。${politeOf(LIMITS.choiceNoteLength + 1 - '正解。'.length)}`
      })
      expectWarningOnly(r, 'choiceNoteLong', '2019h31h-q5', 'ア')
    })
  })

  describe('必須の要素が欠けた問題解説は止める（REQ-398）', () => {
    /** @covers REQ-398#field-missing */
    it('同一内容の鍵・正解・正解の根拠・選択肢・選択肢の説明の欄が無い問題解説は、missingElement で問題を挙げて止める（欄ごと）', () => {
      const cases: [string, (x: Json) => void][] = [
        ...['content_key', 'correct', 'correct_reason', 'choices'].map((k): [string, (x: Json) => void] => [k, (x) => delete x[k]]),
        ['choices[].note', (x) => delete choice(x, 'ウ').note],
      ]
      for (const [label, edit] of cases) labelled(label, () => expectStop(withQ5(edit), 'missingElement', '2019h31h-q5'))
    })

    /** @covers REQ-398#field-empty */
    it('正解の根拠か選択肢の説明が空の問題解説は、missingElement で問題を挙げて止める（欄ごと）', () => {
      const cases: [string, (x: Json) => void][] = [
        ['correct_reason', (x) => (x.correct_reason = '')],
        ['choices[].note', (x) => (choice(x, 'ウ').note = '')],
      ]
      for (const [label, edit] of cases) labelled(label, () => expectStop(withQ5(edit), 'missingElement', '2019h31h-q5'))
    })

    /** @covers REQ-398#choices-not-four */
    it('選択肢ごとの説明が 3 つか 5 つの問題解説は、missingElement で問題を挙げて止める（場合ごと）', () => {
      const cases: [string, (x: Json) => void][] = [
        ['3 つ', (x) => x.choices.pop()],
        ['5 つ', (x) => x.choices.push({ label: 'オ', term: null, note: '別の場面の説明です。' })],
      ]
      for (const [label, edit] of cases) labelled(label, () => expectStop(withQ5(edit), 'missingElement', '2019h31h-q5'))
    })

    /** @covers REQ-398#choice-label-duplicated */
    it('選択肢の記号が重なる（ア・ア・ウ・エ）問題解説は、missingElement で問題を挙げて止める', () => {
      expectStop(withQ5((x) => (choice(x, 'イ').label = 'ア')), 'missingElement', '2019h31h-q5')
    })
  })

  describe('正解・指す過去問・同一内容の鍵・正誤の印が食い違うと止める（REQ-399）', () => {
    /** @covers REQ-399#answer-key-mismatch */
    it('正解（イ）が正解表（ア）と違う問題解説は、answerKeyMismatch で問題を挙げて止める', () => {
      const r = withQ5((x) => {
        x.correct = 'イ'
        const [a, i] = [choice(x, 'ア'), choice(x, 'イ')]
        ;[a.note, i.note] = ['請け負う形の約束です。', '正解。']
      })
      expectStop(r, 'answerKeyMismatch', '2019h31h-q5')
    })

    /** @covers REQ-399#question-missing */
    it('指す過去問が無い（2018h30a-q9）問題解説は、questionMissing で問題を挙げて止める', () => {
      const ws = makeWorkspace()
      const q3 = explanation(ws.readJson(explanationsFile('expl_02')).explanations, '2018h30a-q3')
      ws.editBundle('expl_02', (doc) => doc.topics[0].questions.push({ ...doc.topics[0].questions[0], question_id: '2018h30a-q9' }))
      expectStop(withExplanations('expl_02', (xs) => xs.push({ ...q3, question_id: '2018h30a-q9' }), ws), 'questionMissing', '2018h30a-q9')
    })

    /** @covers REQ-399#no-past-questions-readable */
    it('過去問のファイルがどれも読めない（途切れている）学びの問題解説は、questionMissing で問題を挙げて止める', () => {
      const ws = makeWorkspace()
      for (const exam of ['2018h30a', '2019h31h']) ws.write(`${DATA}/questions/${exam}.json`, `{"exam": "${exam}", "questions": [`)
      expectStop(check(ws), 'questionMissing', '2019h31h-q5')
    })

    /** @covers REQ-399#content-key-unknown */
    it('同一内容の鍵が過去問のどれにも無い問題解説は、contentKeyMismatch で問題を挙げて止める', () => {
      expectStop(withQ5((x) => (x.content_key = '0000000000000000')), 'contentKeyMismatch', '2019h31h-q5')
    })

    /** @covers REQ-399#content-key-of-another-question */
    it('同一内容の鍵が別の過去問（2018h30a-q2）の鍵で、指す過去問から作った鍵と違う問題解説は、contentKeyMismatch で問題を挙げて止める', () => {
      const r = withExplanations('expl_01', (xs) => (explanation(xs, '2019h31h-q5').content_key = explanation(xs, '2018h30a-q2').content_key))
      expectStop(r, 'contentKeyMismatch', '2019h31h-q5')
    })

    /** @covers REQ-399#correct-mark-mismatch */
    it('正解の説明が「正解」で始まらないか、誤答の説明が「正解」で始まる問題解説は、correctMarkMismatch で問題を挙げて止める（場合ごと）', () => {
      const cases: [string, (x: Json) => void][] = [
        ['正解の説明が「正解」で始まらない', (x) => (choice(x, 'ア').note = '請け負う形の約束です。')],
        ['誤答の説明が「正解」で始まる', (x) => (choice(x, 'イ').note = '正解に見えますが、作業を進めること自体を引き受ける約束です。')],
      ]
      for (const [label, edit] of cases) labelled(label, () => expectStop(withQ5(edit), 'correctMarkMismatch', '2019h31h-q5'))
    })
  })

  describe('過去問の原文と引用の閾値以上の字数で続けて一致すると止める（REQ-400）', () => {
    const text = pastQuestion('2018h30a', 2).text

    /** @covers REQ-400#quote-at-threshold */
    it('正解の根拠が過去問の本文と 30 字続けて一致する問題解説は、pastQuestionQuote で問題と一致した箇所を挙げて止める', () => {
      const quoted = text.slice(0, LIMITS.quoteLength)
      const r = withExplanations('expl_01', (xs) => (explanation(xs, '2018h30a-q2').correct_reason = `問いは「${quoted}」と聞いています。`))
      expectStop(r, 'pastQuestionQuote', '2018h30a-q2')
    })

    /** @covers REQ-400#quote-below-threshold */
    it('過去問の本文との一致が 29 字までなら、pastQuestionQuote で止めない', () => {
      const quoted = text.slice(0, LIMITS.quoteLength - 1)
      const r = withExplanations('expl_01', (xs) => (explanation(xs, '2018h30a-q2').correct_reason = `問いは「${quoted}」と聞いています。`))
      expectNoStop(r, 'pastQuestionQuote')
    })

    /** @covers REQ-400#no-match-across-text-and-choices */
    it('過去問の本文の末尾 15 字と選択肢アの先頭 15 字をつないだ 30 字だけが一致する問題解説は、pastQuestionQuote で止めない', () => {
      // どの入力の束にも無い過去問 2018h30a-q4 の選択肢アを 15 字以上にして、本文の末尾とつないだ 30 字を正解の根拠に書く
      const ws = makeWorkspace()
      const file = `${DATA}/questions/2018h30a.json`
      const doc = ws.readJson(file)
      const q4 = doc.questions.find((q: Json) => q.number === 4)
      q4.choices['ア'] = '運用の手順を決めて毎日の点検を続ける担当の役目'
      ws.write(file, doc)
      const half = LIMITS.quoteLength / 2
      const joined = `${q4.text.slice(-half)}${q4.choices['ア'].slice(0, half)}`
      const r = withExplanations('expl_01', (xs) => (explanation(xs, '2018h30a-q2').correct_reason = `問いは「${joined}」と聞いています。`), ws)
      expectNoStop(r, 'pastQuestionQuote')
    })

    /** @covers REQ-400#match-across-explanation-fields */
    it('正解の根拠の末尾 15 字と選択肢アの説明の先頭 15 字をつなぐと過去問（2018h30a-q2）の本文の 30 字と一致する問題解説（2018h30a-q3）は、pastQuestionQuote で止める', () => {
      // 2018h30a-q3 の正解はウなので、選択肢アの説明は「正解」で始めなくてよい
      const half = LIMITS.quoteLength / 2
      const r = withExplanations('expl_02', (xs) => {
        const x = explanation(xs, '2018h30a-q3')
        x.correct_reason = `問いの書き出しは${text.slice(0, half)}`
        choice(x, 'ア').note = `${text.slice(half, half * 2)}と続く問いの言い方です。`
      })
      expectStop(r, 'pastQuestionQuote', '2018h30a-q3')
    })
  })

  describe('用語として示した語が選択肢の用語と用語の上書きのどれでも解決できないと止める（REQ-401）', () => {
    /** @covers REQ-401#unresolved-term */
    it('どこにも無い語を [[ ]] で示した問題解説は、unresolvedTerm で問題と語を挙げて止める', () => {
      expectStop(withQ5((x) => (x.correct_reason = `${x.correct_reason}比べる相手は[[架空の約束事]]です。`)), 'unresolvedTerm', '2019h31h-q5', '架空の約束事')
    })

    /** @covers REQ-401#resolved-by-choice-term */
    it('別の問題解説の選択肢の用語（表計算ソフト）を [[ ]] で示した問題解説は、unresolvedTerm で止めない', () => {
      expectNoStop(withQ5((x) => (x.correct_reason = `${x.correct_reason}比べる相手は[[表計算ソフト]]です。`)), 'unresolvedTerm')
    })

    /** @covers REQ-401#resolved-by-override */
    it('用語の上書きにある語（受託開発）を [[ ]] で示した問題解説は、unresolvedTerm で止めない', () => {
      expectNoStop(withQ5((x) => (x.correct_reason = `${x.correct_reason}比べる相手は[[受託開発]]です。`)), 'unresolvedTerm')
    })

    /** @covers REQ-401#resolved-by-topic */
    it('教材のある論点の名前（契約の種類）を [[ ]] で示した問題解説は、unresolvedTerm で止めない', () => {
      expectNoStop(withQ5((x) => (x.correct_reason = `${x.correct_reason}比べる相手は[[契約の種類]]です。`)), 'unresolvedTerm')
    })

    /** @covers REQ-401#resolved-by-alias */
    it('教材のある論点の別名（論点の一覧の aliases・論点の別名の表）を [[ ]] で示した問題解説は、unresolvedTerm で止めない（場合ごと）', () => {
      const cases: [string, (ws: Workspace) => void, string][] = [
        ['論点の一覧の aliases', (ws) => editTopics(ws, (ts) => (ts.find((t: Json) => t.id === 1).aliases = ['契約の型'])), '契約の型'],
        ['論点の別名の表', (ws) => ws.write(`${DATA}/topic_aliases.json`, { _comment: '仕込み', 契約の形: '契約の種類' }), '契約の形'],
      ]
      for (const [label, put, word] of cases) {
        const ws = makeWorkspace()
        put(ws)
        const r = withExplanations('expl_01', (xs) => (explanation(xs, '2019h31h-q5').correct_reason += `比べる相手は[[${word}]]です。`), ws)
        labelled(label, () => expectNoStop(r, 'unresolvedTerm'))
      }
    })

    /** @covers REQ-401#topic-without-material */
    it('教材の無い論点の名前（保守の進め方）だけで解決する語を [[ ]] で示した問題解説は、unresolvedTerm で問題と語を挙げて止める', () => {
      expectStop(withQ5((x) => (x.correct_reason = `${x.correct_reason}比べる相手は[[保守の進め方]]です。`)), 'unresolvedTerm', '2019h31h-q5', '保守の進め方')
    })

    /** @covers REQ-401#unresolved-term-in-material */
    it('配る教材（論点ごとに最も後の世代）の本文でどこにも無い語を [[ ]] で示すと、unresolvedTerm でその論点と語を挙げて止める', () => {
      const ws = makeWorkspace()
      editMaterials(ws, 'materials_v2/bundle_01.json', (ms) => (ms.find((m: Json) => m.topic_id === 1).detail += '\n比べる相手は[[架空の約束事]]です。'))
      const r = check(ws)
      expectStop(r, 'unresolvedTerm', '架空の約束事')
      expect(findingsOf(r.json.stops, 'unresolvedTerm').some((f) => findingText(f).includes('契約の種類') || /(^|\D)1(\D|$)/.test(findingText(f))), JSON.stringify(r.json.stops)).toBe(true)
    })

    /** @covers REQ-401#older-material-not-counted */
    it('前の世代にだけある教材の [[ ]] の語は、unresolvedTerm で止めない', () => {
      const ws = makeWorkspace()
      editMaterials(ws, 'materials/batch_01.json', (ms) => (ms.find((m: Json) => m.topic_id === 1).detail += '\n比べる相手は[[架空の約束事]]です。'))
      expectNoStop(check(ws), 'unresolvedTerm')
    })
  })

  describe('書き方が問題解説の警告に当たると、止めずに警告する（REQ-402）', () => {
    /** @covers REQ-402#plain-note */
    it('常体で終わる選択肢の説明（「〜である。」）がある問題解説は、止めずに plainNote で問題と箇所を挙げる', () => {
      expectWarningOnly(withQ5((x) => (choice(x, 'イ').note = '作業を進めること自体を引き受ける約束である。')), 'plainNote', '2019h31h-q5')
    })

    /** @covers REQ-402#plain-correct-note */
    it('正解の選択肢の説明が敬体で終わらない（「正解。〜である。」）問題解説は、plainNote にしない', () => {
      const r = withQ5((x) => (choice(x, 'ア').note = '正解。請け負う形の約束である。'))
      expectResponse(r)
      expect(findingsOf(r.json.warnings, 'plainNote'), JSON.stringify(r.json.warnings)).toEqual([])
    })

    /** @covers REQ-402#note-value-only */
    it('「〜にはなりません」で終わる誤答の選択肢の説明がある問題解説は、止めずに noteValueOnly で問題と記号を挙げる', () => {
      expectWarningOnly(withQ5((x) => (choice(x, 'イ').note = 'この値にはなりません')), 'noteValueOnly', '2019h31h-q5', 'イ')
    })

    /** @covers REQ-402#term-notes-differ */
    it('誤答の選択肢の同じ用語（表計算ソフト）の説明の 1 文目が 2 つの問題解説で違うと、止めずに termNotesDiffer でその用語を 1 件挙げる', () => {
      const ws = makeWorkspace()
      ws.editExplanations('expl_02', (xs) => Object.assign(choice(explanation(xs, '2018h30a-q3'), 'ア'), { term: '表計算ソフト', note: '表の形で数を並べて集計する道具です。' }))
      const r = check(ws)
      expectWarningOnly(r, 'termNotesDiffer', '表計算ソフト')
      expect(findingsOf(r.json.warnings, 'termNotesDiffer').filter((f) => findingText(f).includes('表計算ソフト')).length).toBe(1)
    })

    /** @covers REQ-402#label-order */
    it('選択肢の説明がア〜エの順に並ばない（イ・ア・ウ・エ）問題解説は、止めずに labelOrder で問題を挙げる', () => {
      expectWarningOnly(withQ5((x) => ([x.choices[0], x.choices[1]] = [x.choices[1], x.choices[0]])), 'labelOrder', '2019h31h-q5')
    })

    /** @covers REQ-402#representative-not-newest */
    it('同一内容の組を古い回の問題（2018h30a-q1）で書いた問題解説は、止めずに representativeNotNewest で問題を挙げる', () => {
      const ws = makeWorkspace()
      ws.editBundle('expl_01', (doc) => (doc.topics[0].questions.find((q: Json) => q.question_id === '2019h31h-q5').question_id = '2018h30a-q1'))
      const r = withExplanations('expl_01', (xs) => (explanation(xs, '2019h31h-q5').question_id = '2018h30a-q1'), ws)
      expectWarningOnly(r, 'representativeNotNewest', '2018h30a-q1')
    })
  })
  describe('門が結果を返すとき、標準出力の最後の行に機械向けの 1 行を出す（REQ-658）', () => {
    /** 最後の行が契約の response の形で、exitCode が終了の状態と同じこと。 */
    const expectLastLine = (r: Run) => {
      expect(r.last, dump(r)).toBeTypeOf('object')
      for (const k of ['exitCode', 'questions', 'stops', 'warnings', 'limits']) expect(r.last, `${k} が無い: ${dump(r)}`).toHaveProperty(k)
      expect(r.last.exitCode, dump(r)).toBe(r.status)
      expect(r.last.limits).toEqual(LIMITS)
      for (const f of [...r.last.stops, ...r.last.warnings]) {
        for (const k of ['kind', 'where', 'reason']) expect(typeof f[k] === 'string' && f[k].length > 0, JSON.stringify(f)).toBe(true)
      }
    }

    // @covers REQ-658#line-when-passed
    it('通したときの最後の行は、終了の状態と同じ exitCode 0・見た問題の数 4・空の止める理由と警告・契約の閾値を持つ', () => {
      const r = cleanRun()
      expect(r.status, dump(r)).toBe(0)
      expectLastLine(r)
      expect(r.last).toEqual({ exitCode: 0, questions: 4, stops: [], warnings: [], limits: LIMITS })
    })

    // @covers REQ-658#line-when-stopped
    it('止めたときの最後の行は exitCode 1 と、種類・箇所・理由を持つ止める理由（問題解説の無い問題）を並べる', () => {
      const r = withExplanations('expl_01', (xs) => xs.splice(xs.indexOf(explanation(xs, '2018h30a-q2')), 1))
      expect(r.status, dump(r)).toBe(1)
      expectLastLine(r)
      expect(r.last.exitCode).toBe(1)
      expect(findingsOf(r.last.stops, 'missingExplanation').some((f) => findingText(f).includes('2018h30a-q2')), JSON.stringify(r.last.stops)).toBe(true)
    })

    // @covers REQ-658#all-findings
    it('止める理由が 21 件以上（解決できない語 25 個）のとき、最後の行はすべてを並べる', () => {
      const words = Array.from({ length: 25 }, (_, i) => `架空の約束事${'一二三四五六七八九十'[i % 10]}${'甲乙丙'[Math.floor(i / 10)]}`)
      const r = withQ5((x) => (x.correct_reason = `${x.correct_reason}${words.map((w) => `[[${w}]]`).join('と')}を比べます。`))
      expect(r.status, dump(r)).toBe(1)
      expectLastLine(r)
      const hits = findingsOf(r.last.stops, 'unresolvedTerm')
      for (const w of words) expect(hits.some((f) => findingText(f).includes(w)), `${w} が最後の行に無い（${hits.length} 件）`).toBe(true)
    })

    // @covers REQ-658#human-lines-kept
    it('人が読む結果の行は最後の行より前に残り、機械向けの形は最後の 1 行だけ', () => {
      const r = cleanRun()
      expectLastLine(r)
      expect(r.humanLines.length, dump(r)).toBeGreaterThan(0)
      for (const line of r.humanLines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          parsed = undefined
        }
        expect(parsed !== null && typeof parsed === 'object' && 'exitCode' in (parsed as object), line).toBe(false)
      }
    })
  })
})
