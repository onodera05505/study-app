import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ROOT, type Shadow, type ToolRun, crashed, removeTemps, runReal, toolShadow } from './UC-037_fixture.local'

/** UC-038 取り込み・分類・書き直し・手順書の結果を照らす道具の境界（入口は CLAUDE.md の「道具を回す操作」の行）。
 *  checkAnswerability ＝ `scripts/check_answerability.py <exam> [--answers-dir] [--questions-dir] [--key]`、
 *  checkAnswerabilityMaterials ＝ `scripts/check_answerability_materials.py [--data] [--results] [--top]`、
 *  checkClassified ＝ `scripts/check_classified.py [--data] [--count]`、checkMaterialCoverage ＝ `scripts/check_material_coverage.py [--data] [--top]`、
 *  specInventory ＝ `scripts/spec_inventory.py <path> [--old] [--dropped] [--quiet]`。
 *  前提は影の根（UC-037_fixture.local.ts）の作業の置き場 `uc038/` に書くか、学びの置き場の写しを書き換えて作る。
 *  観測は終了の状態と、挙げた物（番号・ID・語）が出力に出ること（文言は照らさない）。 */

vi.setConfig({ testTimeout: 300_000 })

afterAll(async () => {
  await removeTemps()
})

type Json = Record<string, any>
const json = (v: unknown) => JSON.stringify(v, null, 2)

function expectEnded(r: ToolRun, status: number, ...shown: string[]) {
  expect(crashed(r), r.out).toBe(false)
  expect(r.status, r.out).toBe(status)
  for (const s of shown) expect(r.out, `「${s}」を示していない`).toContain(s)
}
const expectNotShown = (r: ToolRun, ...hidden: string[]) => {
  for (const s of hidden) expect(r.out, `「${s}」を示した`).not.toContain(s)
}

// ---------------------------------------------------------------------------
// 問題文で解いた結果（checkAnswerability）

const EXAM = '2099t01'
const COUNT = 20

/** 作業の置き場に、回 EXAM の問題文 20 問・正解表（全問ア）・解いた結果（answers の上書きと解けない申告）を置く。 */
function answerability(s: Shadow, override: Record<number, string>, unanswerable: Array<{ number: number; reason: string }>) {
  const numbers = Array.from({ length: COUNT }, (_, i) => i + 1)
  const questions = numbers.map((n) => ({
    number: n,
    page: 1,
    text: `問${n}の本文`,
    choices: { ア: 'a', イ: 'b', ウ: 'c', エ: 'd' },
    has_figure: false,
    figure_description: null,
    confidence: 'high',
    notes: null,
  }))
  s.write(`uc038/questions/${EXAM}.json`, json({ exam: EXAM, source: '仕込み', normalized: true, question_count: COUNT, questions }))
  s.write('uc038/key.json', json({ '2098t01': { '1': 'ア' }, [EXAM]: Object.fromEntries(numbers.map((n) => [String(n), 'ア'])) }))
  const answers = Object.fromEntries(numbers.map((n) => [String(n), override[n] ?? 'ア']))
  s.write(`uc038/answers/${EXAM}/batch_01.json`, json({ exam: EXAM, batch: 'batch_01', range: `1-${COUNT}`, answers, unanswerable }))
}
const checkAnswerability = (s: Shadow, exam = EXAM) =>
  s.run('check_answerability.py', [exam, '--answers-dir', 'uc038/answers', '--questions-dir', 'uc038/questions', '--key', 'uc038/key.json'])

// ---------------------------------------------------------------------------
// 教材で解いた結果（checkAnswerabilityMaterials）

const ipKeys = JSON.parse(readFileSync(join(ROOT, 'data', 'ip', 'answer_keys.json'), 'utf8')) as Record<string, Record<string, string>>
/** 正解表にある ip の問題 4 つ（ID と正解）。 */
const IP_QUESTIONS = Object.entries(ipKeys)
  .flatMap(([exam, ans]) => Object.entries(ans).map(([n, a]) => ({ id: `${exam}-q${n}`, correct: a })))
  .slice(0, 4)
const otherChoice = (a: string) => (a === 'ア' ? 'イ' : 'ア')

/** 作業の置き場に、教材で解いた結果の束を 1 つ置く。状態は問題ごとに [正解したか, 足りていると申告したか]。 */
function materialResults(s: Shadow, states: Array<[correct: boolean, sufficient: boolean]>) {
  const answers = states.map(([correct, sufficient], i) => ({
    question_id: IP_QUESTIONS[i].id,
    topic_id: 9000 + i,
    term: `仕込みの論点${i}`,
    answer: correct ? IP_QUESTIONS[i].correct : otherChoice(IP_QUESTIONS[i].correct),
    sufficient,
    basis: '仕込みの根拠',
    missing: sufficient ? null : '仕込みの不足',
  }))
  s.write('uc038/results/bundle_01.json', json({ bundle: 1, answers }))
}
const checkMaterials = (s: Shadow, results = 'uc038/results') => s.run('check_answerability_materials.py', ['--data', 'data/ip', '--results', results])
/** 教材で解いた結果の束を、結果の問題の ID（`<回>-q<問番号>`）だけを決めて置く。 */
function resultsFor(s: Shadow, ids: string[]) {
  const answers = ids.map((id, i) => ({
    question_id: id,
    topic_id: 9100 + i,
    term: `仕込みの論点${i}`,
    answer: 'ア',
    sufficient: true,
    basis: '仕込みの根拠',
    missing: null,
  }))
  s.write('uc038/results/bundle_01.json', json({ bundle: 1, answers }))
}
/** 出力が問題を回と問番号で示したか（結果の ID の形 `<回>-q<n>` か、同じ行に回と「問<n>」）。 */
const questionPattern = (exam: string, n: number) => new RegExp(`${exam}-q${n}(?!\\d)|${exam}[^\\n]*問\\s*${n}(?!\\d)`, 'g')
const showsQuestion = (out: string, exam: string, n: number) => questionPattern(exam, n).test(out)

// ---------------------------------------------------------------------------
// 分類（checkClassified）

const CLASSIFIED = 'data/ap/classified/2016h28a/batch_01.json'
const editClassified = (s: Shadow, edit: (list: Json[]) => Json[]) => {
  const body = JSON.parse(s.read(CLASSIFIED)) as Json
  body.classifications = edit(body.classifications as Json[])
  s.write(CLASSIFIED, json(body))
}
const checkClassified = (s: Shadow) => s.run('check_classified.py', ['--data', 'data/ap'])
const apSyllabus = JSON.parse(readFileSync(join(ROOT, 'data', 'ap', 'syllabus.json'), 'utf8')) as { items: Json[] }
const apFields = JSON.parse(readFileSync(join(ROOT, 'data', 'ap', 'question_fields.json'), 'utf8')) as Record<string, Record<string, string>>

// ---------------------------------------------------------------------------
// 書き直しの落ち（checkMaterialCoverage）

/** 学びの置き場の教材の世代（`materials` が最初、`materials_v<n>` が n 番目）。 */
const genNo = (name: string) => (name === 'materials' ? 1 : Number(/^materials_v(\d+)$/.exec(name)?.[1] ?? NaN))
const ipGenerations = readdirSync(join(ROOT, 'data', 'ip'))
  .filter((n) => Number.isInteger(genNo(n)))
  .sort((a, b) => genNo(a) - genNo(b))
/** 最初の世代と 2 番目の世代（REQ-607 の境界の扱い）。 */
const PREVIOUS = 'materials'
const SECOND = 'materials_v2'
/** 3 番目より後の世代（比べない世代）。 */
const LATER = ipGenerations.filter((n) => genNo(n) >= 3)

/** 世代の置き場の、その論点の教材の入ったファイル（data からの相対）。 */
function materialFile(gen: string, topicId: number): string | null {
  for (const f of readdirSync(join(ROOT, 'data', 'ip', gen)).filter((n) => n.endsWith('.json'))) {
    const body = JSON.parse(readFileSync(join(ROOT, 'data', 'ip', gen, f), 'utf8')) as Json
    if ((body.materials as Json[] | undefined)?.some((m) => m.topic_id === topicId)) return `ip/${gen}/${f}`
  }
  return null
}
/** 最初の世代と 2 番目の世代の両方に教材がある論点。 */
const SHARED_TOPIC = (() => {
  const first = SECOND
  if (!ipGenerations.includes(first)) return null
  const body = JSON.parse(readFileSync(join(ROOT, 'data', 'ip', first, readdirSync(join(ROOT, 'data', 'ip', first)).filter((n) => n.endsWith('.json'))[0]), 'utf8')) as Json
  for (const m of body.materials as Json[]) if (materialFile(PREVIOUS, m.topic_id)) return m.topic_id as number
  return null
})()
/** その論点の名前（前の世代の教材の term）。 */
const termOf = (topicId: number): string => {
  const rel = materialFile(PREVIOUS, topicId)!
  return ((JSON.parse(readFileSync(join(ROOT, 'data', rel), 'utf8')) as Json).materials as Json[]).find((m) => m.topic_id === topicId)!.term as string
}
const editMaterial = (s: Shadow, rel: string, topicId: number, edit: (m: Json) => void) => {
  const body = JSON.parse(s.read(`data/${rel}`)) as Json
  edit((body.materials as Json[]).find((m) => m.topic_id === topicId)!)
  s.write(`data/${rel}`, json(body))
}
const checkCoverage = (s: Shadow) => s.run('check_material_coverage.py', ['--data', 'data/ip'])

// ---------------------------------------------------------------------------
// 手順書の書き換え（specInventory）

const OLD_SPEC = ['# 仕込みの仕様書', '', '## 決まり', '', '- 図は **12 枚まで** にする', '- 見出しは「しくみ」で始めて、例を 1 つ添える', '- 説明は 200 字を目安に書く', '', '## 改訂履歴', ''].join('\n')
const specWith = (lines: string[]) => ['# 仕込みの仕様書', '', '## 決まり', '', ...lines, '', '## 改訂履歴', ''].join('\n')
function inventory(s: Shadow, next: string, dropped?: string, old = 'uc038/spec_old.md') {
  s.write('uc038/spec_old.md', OLD_SPEC)
  s.write('uc038/spec.md', next)
  if (dropped !== undefined) s.write('uc038/dropped.md', dropped)
  return s.run('spec_inventory.py', ['uc038/spec.md', '--old', old, ...(dropped !== undefined ? ['--dropped', 'uc038/dropped.md'] : [])])
}

describe('UC-038 取り込み・分類・書き直しの結果と手順書の書き換えを、機械で確かめる', () => {
  describe('問題文だけで解いた結果を正解表と照らし、正解率・不正解・解けない申告を示す（REQ-603）', () => {
    // @covers REQ-603#all-correct
    it('どの問題も正解なら、正解率 100% を示して成功で終える', () => {
      const s = toolShadow()
      answerability(s, {}, [])
      expectEnded(checkAnswerability(s), 0, '100%')
    })

    // @covers REQ-603#wrong-shown
    it('不正解の問題があれば、正解率とその問題の番号を示して成功で終える', () => {
      const s = toolShadow()
      answerability(s, { 17: 'イ' }, [])
      expectEnded(checkAnswerability(s), 0, '95', '17')
    })

    // @covers REQ-603#unanswerable-shown
    it('問題文だけでは解けないと申告された問題があれば、その問題の番号を示して成功で終える', () => {
      const s = toolShadow()
      answerability(s, {}, [{ number: 13, reason: '仕込みの解けない理由' }])
      expectEnded(checkAnswerability(s), 0, '13')
    })
  })

  describe('正解表に指定した回が無ければ、その旨を示して失敗で終える（REQ-604）', () => {
    // @covers REQ-604#exam-not-in-key
    it('正解表にほかの回があっても指定した回が無いと、その回を示して失敗で終える', () => {
      const s = toolShadow()
      answerability(s, {}, [])
      const key = JSON.parse(s.read('uc038/key.json')) as Json
      delete key[EXAM]
      s.write('uc038/key.json', json(key))
      const r = checkAnswerability(s)
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).not.toBe(0)
      expect(r.out).toContain(EXAM)
    })
  })

  describe('教材だけで解いた結果を照らし、不正解と不足の申告を示し、両方に当たる問題があれば失敗で終える（REQ-605）', () => {
    // @covers REQ-605#all-correct-sufficient
    it('どの問題も正解で、不足の申告も無ければ、成功で終える', () => {
      const s = toolShadow()
      materialResults(s, [[true, true], [true, true]])
      expectEnded(checkMaterials(s), 0)
    })

    // @covers REQ-605#wrong-shown
    it('不正解の問題（不足の申告なし）があれば、その問題を示して成功で終える', () => {
      const s = toolShadow()
      materialResults(s, [[true, true], [false, true]])
      expectEnded(checkMaterials(s), 0, IP_QUESTIONS[1].id)
    })

    // @covers REQ-605#insufficient-shown
    it('正解したが教材だけでは決まらないと申告された問題があれば、その問題を示して成功で終える', () => {
      const s = toolShadow()
      materialResults(s, [[true, true], [true, false]])
      expectEnded(checkMaterials(s), 0, IP_QUESTIONS[1].id)
    })

    // @covers REQ-605#wrong-and-insufficient-fails
    it('不正解で、しかも不足を申告された問題があれば、その問題を示して失敗で終える', () => {
      const s = toolShadow()
      materialResults(s, [[true, true], [false, false]])
      expectEnded(checkMaterials(s), 1, IP_QUESTIONS[1].id)
    })

    // @covers REQ-605#no-results
    it('照らす結果の置き場が無ければ、無いことを示して成功で終える', () => {
      const s = toolShadow()
      const r = checkMaterials(s, 'uc038/no_such_results')
      expectEnded(r, 0)
      expect(r.out.trim().length, '無いことを示していない').toBeGreaterThan(0)
    })
  })

  describe('教材で解いた結果の問題がどれも正解表で引けず、照らせる結果が 1 つも無ければ、引けなかった問題を回と問番号で示して失敗で終える（REQ-671）', () => {
    // @covers REQ-671#no-scorable-results
    it('正解表にほかの回があっても、結果の問題の回が正解表に無ければ、名前の無い例外で止まらず、その問題を回と問番号で示して失敗で終える', () => {
      const s = toolShadow()
      const exam = '2099t09'
      expect(ipKeys[exam], `仕込み: 正解表に ${exam} がある`).toBeUndefined()
      resultsFor(s, [`${exam}-q1`, `${exam}-q2`])
      const r = checkMaterials(s)
      expectEnded(r, 1, exam)
      for (const n of [1, 2]) expect(showsQuestion(r.out, exam, n), `${exam} の問${n} を示していない`).toBe(true)
    })

    // @covers REQ-671#number-not-in-key
    it('結果の問題の回は正解表にあるが問番号が無いだけなら、その問題を回と問番号で示し、その回を正解表に無い回とは示さずに失敗で終える', () => {
      const s = toolShadow()
      const exam = Object.keys(ipKeys)[0]
      const n = 999
      expect(ipKeys[exam][String(n)], `仕込み: 正解表の ${exam} に問${n} がある`).toBeUndefined()
      resultsFor(s, [`${exam}-q${n}`])
      const r = checkMaterials(s)
      expectEnded(r, 1)
      expect(showsQuestion(r.out, exam, n), `${exam} の問${n} を示していない`).toBe(true)
      // 回は問題を示す中にだけ出る（回だけを挙げる行は、その回を正解表に無い回と示すこと）
      expect(r.out.replace(questionPattern(exam, n), ''), `${exam} を問題とは別に挙げた（正解表に無い回と示した）`).not.toContain(exam)
    })
  })

  describe('回を指定して問題文で解いた結果を照らすとき、その回の解いた結果が無ければ、無いことを示して失敗で終える（REQ-672）', () => {
    /** 解いた結果が無いことを示した（その回の ID か「解いた結果」を出力に挙げた）。 */
    const showsNoAnswers = (r: ToolRun) =>
      expect(r.out.includes(EXAM) || r.out.includes('解いた結果'), `解いた結果が無いことを示していない:\n${r.out}`).toBe(true)
    /** 正答 0 の正解率（「0/<n>」か「0%」）を示した。 */
    const zeroRate = (out: string) => /(^|[^\d])0\s*\/\s*\d+|(^|[^\d.])0(\.0+)?\s*%/.test(out)

    // @covers REQ-672#no-answers-for-exam
    it('正解表と問題文にその回があっても、その回の解いた結果の置き場が無ければ、正答 0 の正解率で成功にせず、失敗で終える', () => {
      const s = toolShadow()
      answerability(s, {}, [])
      s.remove(`uc038/answers/${EXAM}`)
      const r = checkAnswerability(s)
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).not.toBe(0)
      showsNoAnswers(r)
    })

    // @covers REQ-672#answers-dir-empty
    it('その回の解いた結果の置き場はあるが、解いた結果のファイルが 1 つも無ければ、正答 0 の正解率を示さず、失敗で終える', () => {
      const s = toolShadow()
      answerability(s, {}, [])
      s.remove(`uc038/answers/${EXAM}/batch_01.json`)
      expect(existsSync(s.path(`uc038/answers/${EXAM}`)), '仕込み: 解いた結果の置き場が無い').toBe(true)
      const r = checkAnswerability(s)
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).not.toBe(0)
      expect(zeroRate(r.out), `正答 0 の正解率を示した:\n${r.out}`).toBe(false)
      showsNoAnswers(r)
    })
  })

  describe('分類を確かめ、誤りを挙げて失敗で終え、参考は挙げるだけにする（REQ-606）', () => {
    const otherFieldItem = (field: string) => apSyllabus.items.find((i) => i.field !== field)!.number as number
    const unknownItem = Math.max(...apSyllabus.items.map((i) => i.number as number)) + 100

    // @covers REQ-606#clean-passes
    it('今の学び（ap）の分類には誤りが無く、成功で終える', () => {
      expectEnded(runReal('check_classified.py', ['--data', 'data/ap']), 0)
    })

    // @covers REQ-606#missing-number
    it('回の中に分類の無い問番号があると、誤りとして挙げて失敗で終える', () => {
      const s = toolShadow({ copyData: ['ap/classified'] })
      editClassified(s, (list) => list.filter((c) => c.number !== 5))
      expectEnded(checkClassified(s), 1, '2016h28a')
    })

    // @covers REQ-606#duplicate-number
    it('回の中に同じ問番号の分類が 2 つあると、誤りとして挙げて失敗で終える', () => {
      const s = toolShadow({ copyData: ['ap/classified'] })
      editClassified(s, (list) => [...list, { ...list.find((c) => c.number === 5)! }])
      expectEnded(checkClassified(s), 1, '2016h28a')
    })

    // @covers REQ-606#extra-number
    it('回の問題数を超える問番号の分類があると、誤りとして挙げて失敗で終える', () => {
      const s = toolShadow({ copyData: ['ap/classified'] })
      editClassified(s, (list) => [...list, { ...list[0], number: 999 }])
      expectEnded(checkClassified(s), 1, '999')
    })

    // @covers REQ-606#field-mismatch
    it('公式の分野と選んだ項目の分野が食い違うと、誤りとして挙げて失敗で終える', () => {
      const s = toolShadow({ copyData: ['ap/classified'] })
      const official = apFields['2016h28a']['1']
      expect(official, '仕込み: 2016h28a 問1 の公式の分野が無い').toBeTruthy()
      const item = otherFieldItem(official)
      editClassified(s, (list) => list.map((c) => (c.number === 1 ? { ...c, syllabus_item: item } : c)))
      expectEnded(checkClassified(s), 1, '2016h28a')
    })

    // @covers REQ-606#unknown-item
    it('シラバスに無い項目の番号を選ぶと、誤りとして挙げて失敗で終える', () => {
      const s = toolShadow({ copyData: ['ap/classified'] })
      editClassified(s, (list) => list.map((c) => (c.number === 1 ? { ...c, syllabus_item: unknownItem } : c)))
      expectEnded(checkClassified(s), 1, String(unknownItem))
    })

    // @covers REQ-606#reference-only-passes
    it('選んだ項目の用語例に無いのに新しい論点でないとした論点は、参考として挙げ、それだけでは成功で終える', () => {
      const s = toolShadow({ copyData: ['ap/classified'] })
      const term = '仕込みの用語例に無い論点'
      editClassified(s, (list) => list.map((c) => (c.number === 1 ? { ...c, topic_term: term, topic_is_new: false } : c)))
      expectEnded(checkClassified(s), 0, term)
    })
  })

  describe('最初の世代にあって 2 番目の世代に無い語と短くなった論点を挙げる（REQ-607）', () => {
    const WORDS = ['ゼタキャッシュ', 'QZ9X', '8761']

    // @covers REQ-607#dropped-words-listed
    it('最初の世代にあって 2 番目の世代に無い英数字・数値・カタカナの語を、その論点とともに挙げて成功で終える', () => {
      expect(SHARED_TOPIC, '仕込み: 最初の世代と 2 番目の世代の両方に教材がある論点が無い').not.toBeNull()
      const prev = materialFile(PREVIOUS, SHARED_TOPIC!)!
      const next = materialFile(SECOND, SHARED_TOPIC!)!
      const s = toolShadow({ copyData: [prev, next] })
      editMaterial(s, prev, SHARED_TOPIC!, (m) => (m.detail = `${m.detail}\n${WORDS.join(' と ')} の話。`))
      editMaterial(s, next, SHARED_TOPIC!, (m) => (m.detail = `${m.detail}\n${WORDS.join(' と ')} の話。`.replace(/ゼタキャッシュ|QZ9X|8761/g, '仕込みの語')))
      expectEnded(checkCoverage(s), 0, ...WORDS)
    })

    // @covers REQ-607#shorter-detail-listed
    it('詳しい解説が最初の世代より短くなった論点を挙げて成功で終える', () => {
      expect(SHARED_TOPIC, '仕込み: 最初の世代と 2 番目の世代の両方に教材がある論点が無い').not.toBeNull()
      const prev = materialFile(PREVIOUS, SHARED_TOPIC!)!
      const next = materialFile(SECOND, SHARED_TOPIC!)!
      const s = toolShadow({ copyData: [prev, next] })
      editMaterial(s, prev, SHARED_TOPIC!, (m) => (m.detail = `${m.detail}\n${'長い説明の文です。'.repeat(400)}`))
      editMaterial(s, next, SHARED_TOPIC!, (m) => (m.detail = '短い。'))
      expectEnded(checkCoverage(s), 0, termOf(SHARED_TOPIC!))
    })

    // @covers REQ-607#no-second-generation
    it('2 番目の世代が無ければ、無いことを示して成功で終え、最初の世代と 3 番目より後の世代の間の落ちは挙げない', () => {
      // 2 番目の世代を消し、最初の世代と 3 番目の世代の間にだけ語の落ちを置く（比べる相手が無いので挙がらない）
      expect(LATER.length, '仕込み: 3 番目の世代が無い').toBeGreaterThan(0)
      const third = LATER[0]
      const topic = (() => {
        for (const f of readdirSync(join(ROOT, 'data', 'ip', PREVIOUS)).filter((n) => n.endsWith('.json')))
          for (const m of (JSON.parse(readFileSync(join(ROOT, 'data', 'ip', PREVIOUS, f), 'utf8')) as Json).materials as Json[])
            if (materialFile(third, m.topic_id)) return m.topic_id as number
        throw new Error('仕込み: 最初の世代と 3 番目の世代の両方に教材がある論点が無い')
      })()
      const a = materialFile(PREVIOUS, topic)!
      const b = materialFile(third, topic)!
      const s = toolShadow({ copyData: [`ip/${SECOND}`, a, b] })
      s.remove(`data/ip/${SECOND}`)
      editMaterial(s, a, topic, (m) => (m.detail = `${m.detail}\n${WORDS.join(' と ')} の話。`))
      editMaterial(s, b, topic, (m) => (m.detail = `${m.detail}\n仕込みの語 の話。`))
      const r = checkCoverage(s)
      expectEnded(r, 0)
      expect(r.out.trim().length, '無いことを示していない').toBeGreaterThan(0)
      expectNotShown(r, ...WORDS)
    })
  })

  describe('書き換えた手順書を前の版と照らし、説明できない欠けを挙げて失敗で終える（REQ-608）', () => {
    // @covers REQ-608#unchanged-passes
    it('前の版と同じ手順書は、欠けが無く成功で終える', () => {
      expectEnded(inventory(toolShadow(), OLD_SPEC), 0)
    })

    // @covers REQ-608#keys-kept-passes
    it('言い回しを変えても項目の鍵（数値・かぎ括弧の引用）が全部残る項目は、欠けにしない', () => {
      const next = specWith(['- 図は **12 枚まで** にする', '- 例を 1 つ添え、見出しの頭は「しくみ」にする', '- 1 つの論点の説明は 200 字を目安にする'])
      expectEnded(inventory(toolShadow(), next), 0)
    })

    // @covers REQ-608#dropped-with-reason-passes
    it('消した項目が消した理由の一覧に載っていれば、欠けにしない', () => {
      const next = specWith(['- 見出しは「しくみ」で始めて、例を 1 つ添える', '- 説明は 200 字を目安に書く'])
      expectEnded(inventory(toolShadow(), next, '- - 図は **12 枚まで** にする — 図の数は図の仕様書へ移した\n'), 0)
    })

    // @covers REQ-608#unexplained-gap-fails
    it('消した項目が理由の一覧に無ければ、その項目を挙げて失敗で終える', () => {
      const next = specWith(['- 見出しは「しくみ」で始めて、例を 1 つ添える', '- 説明は 200 字を目安に書く'])
      expectEnded(inventory(toolShadow(), next, ''), 1, '図は **12 枚まで** にする')
    })
  })

  describe('前の版が取れなければ、その旨を示して欠けとは別の終了の状態で終える（REQ-609）', () => {
    // @covers REQ-609#old-unavailable
    it('前の版として渡したファイルが無いと、その旨を示して、欠けがあったとき（1）と別の 0 でない終了の状態で終える', () => {
      const s = toolShadow()
      const r = inventory(s, OLD_SPEC, undefined, 'uc038/no_such_old.md')
      expect(crashed(r), r.out).toBe(false)
      expect(r.status, r.out).not.toBe(0)
      expect(r.status, r.out).not.toBe(1)
      expect(r.out).toContain('no_such_old.md')
    })
  })
})
