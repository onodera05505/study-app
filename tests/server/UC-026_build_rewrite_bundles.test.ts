import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  DATA, EXPLANATIONS, FIGURE_103, QUESTIONS, TOPICLESS_UNIT, TOPICS, UNITS,
  absAll, buildRewriteBundles, buildUnitInputs, expectToolError, itemOf, keyOf, reasonOf, makeWorkspace, materialOf, newestGeneration, plan21, plan22, planFile, samePath, termOf, unitOf, writtenOf,
  type Json, type Run, type Workspace,
} from './unit_plan_fixture'

/** UC-026 資格対策の単元の入力の束（buildUnitInputs ＝ `python3 scripts/build_rewrite_bundles.py --unit-inputs`）と
 *  書き直しの束（buildRewriteBundles ＝ `python3 scripts/build_rewrite_bundles.py`）を作る入口の境界。
 *  仕込みは一時の作業場の学びの写し（unit_plan_fixture.ts）の上で作る。
 *  観測するのは終了コード・標準出力の JSON・出力先に書かれたファイルだけ。断ったときは終了コード 2 の ToolError 1 つ。 */

vi.setConfig({ testTimeout: 30_000 })

const UI_OUT = 'out/unit_inputs'
const RW_OUT = 'out/rewrite_bundles'
const uiFile = (unitNo: number, out = UI_OUT) => `${out}/${String(unitNo).padStart(2, '0')}.json`
const rwFile = (unitNo: number, k: number, out = RW_OUT) => `${out}/${String(unitNo).padStart(2, '0')}-${k}.json`
const ref = (id: number) => ({ topic_id: id, term: termOf(id) })

/** 単元の論点の、小項目の番号の順・同じ小項目の中は論点の番号の順の並び（期待値）。 */
const unitTopicOrder = (unitNo: number) =>
  TOPICS.filter((t) => unitOf(t.id).middle_no === unitNo)
    .sort((a, b) => a.syllabus_item - b.syllabus_item || a.id - b.id)
    .map((t) => t.id)

function expectOk(r: Run) {
  expect(r.status, r.stdout + r.stderr).toBe(0)
  expect(r.json?.exitCode).toBe(0)
}
/** 断ったこと: 終了コード 2 で、標準出力は契約の code を持つ ToolError 1 つ。label は場合の名前。 */
function expectRefused(r: Run, code: string, label = '') {
  try {
    expectToolError(r, code, expect)
  } catch (e) {
    throw new Error(`${label} ${(e as Error).message}`)
  }
}
/** 論点のある単元（論点の無い単元 24 を除く）。 */
const TOPICAL_UNITS = UNITS.filter((u) => u.middle_no !== TOPICLESS_UNIT)
/** 作業場の out の下にファイルが 1 つも無いこと。 */
const expectNothingWritten = (ws: Workspace, out: string) => expect(ws.files(out)).toEqual([])

/** 書けるファイルの大きさの上限（512 バイトの区画の数）を付けて、書き直しの束を作る入口を呼ぶ。 */
function runLimited(ws: Workspace, blocks: number, args: string[]): Run {
  const tool = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'scripts', 'build_rewrite_bundles.py')
  const r = spawnSync('sh', ['-c', `ulimit -f ${blocks}; exec python3 "$0" "$@"`, tool, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let json: Json = undefined
  try {
    json = JSON.parse(r.stdout.trim())
  } catch {
    json = undefined
  }
  const code = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error.code : undefined
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, code, text: `${r.stdout}${r.stderr}` }
}

/** 単元 21 の構成を書き換える。 */
function edit21(ws: Workspace, edit: (p: Json) => void) {
  const p = plan21()
  edit(p)
  ws.write(planFile(21), p)
}

describe('UC-026 資格対策の教材の書き直しに配る束を作る（buildUnitInputs・buildRewriteBundles）', () => {
  describe('単元ごとに 1 つ、単元の全論点と今の教材を持つ単元の入力の束を書き出す（REQ-461）', () => {
    /** @covers REQ-461#one-per-unit */
    it('単元を指定しなければ、論点のあるシラバスの単元ごとに 1 つの束を書き出し、書き出したパスを返す', () => {
      const ws = makeWorkspace()
      const r = buildUnitInputs(ws, { out: UI_OUT })
      expectOk(r)
      const expected = TOPICAL_UNITS.map((u) => uiFile(u.middle_no))
      expect(writtenOf(ws, r)).toEqual(absAll(ws, expected))
      expect(ws.files(UI_OUT)).toEqual(expected.map((p) => p.slice(UI_OUT.length + 1)).sort())
      for (const u of TOPICAL_UNITS) {
        const b = ws.readJson(uiFile(u.middle_no))
        expect(b).toMatchObject({ unit_no: u.middle_no, unit: u.middle, field: u.field, major: u.major })
      }
    })

    /** @covers REQ-461#topic-order */
    it('束の論点は単元の全論点で、小項目の番号の順、同じ小項目の中は論点の番号の順に並ぶ', () => {
      const ws = makeWorkspace()
      expectOk(buildUnitInputs(ws, { out: UI_OUT }))
      for (const u of TOPICAL_UNITS) expect(ws.readJson(uiFile(u.middle_no)).topics.map((t: Json) => t.topic_id)).toEqual(unitTopicOrder(u.middle_no))
    })

    /** @covers REQ-461#topic-attributes */
    it('束の各論点は、名前・小項目の番号と名前・出題回数・周辺の用語を持つ', () => {
      const ws = makeWorkspace()
      expectOk(buildUnitInputs(ws, { out: UI_OUT, units: [21] }))
      for (const t of ws.readJson(uiFile(21)).topics) {
        const src = TOPICS.find((x) => x.id === t.topic_id)!
        expect(t).toMatchObject({
          term: src.term,
          syllabus_item: src.syllabus_item,
          syllabus_item_name: itemOf(src.id).name,
          question_count: src.questions.length,
          related_terms: src.related_terms,
        })
      }
    })

    /** @covers REQ-461#newest-generation */
    it('束の各論点の教材は、教材の世代を古い順に重ねて論点ごとに最も新しい世代の物', () => {
      const ws = makeWorkspace()
      expectOk(buildUnitInputs(ws, { out: UI_OUT, units: [21, 22] }))
      for (const n of [21, 22])
        for (const t of ws.readJson(uiFile(n)).topics) {
          const m = materialOf(newestGeneration(t.topic_id), t.topic_id)
          expect({ explanation: t.explanation, detail: t.detail }, `論点 ${t.topic_id}`).toEqual({ explanation: m.explanation, detail: m.detail })
        }
    })

    /** @covers REQ-461#topicless-unit-skipped */
    it('論点が 1 つも無い単元の束は、単元を指定しなくても書き出さない', () => {
      const ws = makeWorkspace()
      const r = buildUnitInputs(ws, { out: UI_OUT })
      expectOk(r)
      expect(ws.exists(uiFile(TOPICLESS_UNIT))).toBe(false)
      expect(writtenOf(ws, r)).not.toContain(absAll(ws, [uiFile(TOPICLESS_UNIT)])[0])
    })

    /** @covers REQ-461#ignores-unit-plans */
    it('単元の構成が無い単元や、止める理由に当たる単元の構成があっても、単元の入力の束は作る', () => {
      const ws = makeWorkspace()
      ws.write(planFile(21), '{"unit_no": 21,')
      const r = buildUnitInputs(ws, { out: UI_OUT, units: [21, 23] })
      expectOk(r)
      expect(writtenOf(ws, r)).toEqual(absAll(ws, [uiFile(21), uiFile(23)]))
    })
  })

  describe('まとまりごとに 1 つ、書き直しに要る物を持つ書き直しの束を書き出す（REQ-462）', () => {
    const built = () => {
      const ws = makeWorkspace()
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21, 22] })
      expectOk(r)
      return { ws, r, b1: ws.readJson(rwFile(21, 1)), b2: ws.readJson(rwFile(21, 2)) }
    }
    const topicIn = (b: Json, id: number) => b.topics.find((t: Json) => t.topic_id === id)

    /** @covers REQ-462#one-per-group */
    it('単元の構成のまとまりごとに 1 つの束を、単元の番号 2 桁とまとまりの順の名前で書き出し、書き出したパスを返す', () => {
      const { ws, r } = built()
      const expected = [rwFile(21, 1), rwFile(21, 2), rwFile(22, 1), rwFile(22, 2)]
      expect(writtenOf(ws, r)).toEqual(absAll(ws, expected))
      expect(ws.files(RW_OUT)).toEqual(expected.map((p) => p.slice(RW_OUT.length + 1)).sort())
    })

    /** @covers REQ-462#bundle-header */
    it('束は束の名前・単元の番号と名前・全体像・そのまとまりの順と名前と説明・単元の全部のまとまりを持つ', () => {
      const { b2 } = built()
      const p = plan21()
      expect(b2).toMatchObject({
        bundle: '21-2',
        unit_no: 21,
        unit: p.unit,
        overview: p.overview,
        group: { index: 2, name: p.groups[1].name, description: p.groups[1].description },
      })
      expect(b2.groups_in_unit.map((g: Json) => ({ index: g.index, name: g.name, topics: g.topics.map((t: Json) => ({ topic_id: t.topic_id, term: t.term })) }))).toEqual(
        p.groups.map((g: Json, i: number) => ({ index: i + 1, name: g.name, topics: g.topics.map(ref) })),
      )
    })

    /** @covers REQ-462#learn-order */
    it('束の論点は、そのまとまりの論点だけを単元の構成の学ぶ順に並べる', () => {
      const { b1, b2 } = built()
      const p = plan21()
      expect(b1.topics.map((t: Json) => t.topic_id)).toEqual(p.groups[0].topics)
      expect(b2.topics.map((t: Json) => t.topic_id)).toEqual(p.groups[1].topics)
    })

    /** @covers REQ-462#topic-attributes */
    it('束の各論点は、名前・分野・大項目・単元・小項目の名前・出題回数・周辺の用語を持つ', () => {
      const { b1, b2 } = built()
      for (const t of [...b1.topics, ...b2.topics]) {
        const src = TOPICS.find((x) => x.id === t.topic_id)!
        const u = unitOf(src.id)
        expect(t).toMatchObject({ term: src.term, field: u.field, major: u.major, middle: u.middle, syllabus_item_name: itemOf(src.id).name, question_count: src.questions.length, related_terms: src.related_terms })
      }
    })

    /** @covers REQ-462#newest-generation */
    it('束の各論点の今の教材は、最も新しい世代の名前と教材を持つ', () => {
      const { b1, b2 } = built()
      for (const t of [...b1.topics, ...b2.topics]) {
        const gen = newestGeneration(t.topic_id)
        const m = materialOf(gen, t.topic_id)
        expect(t.current, `論点 ${t.topic_id}`).toEqual({ generation: gen, explanation: m.explanation, detail: m.detail })
      }
    })

    /** @covers REQ-462#questions-folded */
    it('紐づく過去問は同一内容を 1 件に畳み、代表は新しい回の問題で、同一内容の判定の鍵・本文・選択肢・正解を持つ', () => {
      const { b1, b2 } = built()
      const q103 = topicIn(b1, 103).questions
      expect(q103.length).toBe(1)
      const a = QUESTIONS['2019h31h'].find((q) => q.number === 5)!
      expect(q103[0]).toMatchObject({ question_id: '2019h31h-q5', stem: a.text, choices: a.choices, answer: a.answer })
      expect(q103[0].content_key).toBe(keyOf('2019h31h', 5))
      expect(q103[0].content_key).toBe(keyOf('2018h30a', 1))
      const b = QUESTIONS['2019h31h'].find((q) => q.number === 6)!
      expect(topicIn(b2, 105).questions.map((q: Json) => ({ question_id: q.question_id, stem: q.stem, answer: q.answer }))).toEqual([{ question_id: '2019h31h-q6', stem: b.text, answer: b.answer }])
      expect(topicIn(b1, 112).questions).toEqual([])
    })

    /** @covers REQ-462#question-explanations */
    it('各論点は、紐づく過去問の組に同一内容の判定で結んだ問題解説を持つ（解説が組の古い回の問題の ID で書いてあっても）', () => {
      const { b1, b2 } = built()
      const shape = (e: Json) => ({ content_key: e.content_key, correct_reason: e.correct_reason })
      expect(topicIn(b1, 103).question_explanations.map(shape)).toEqual([shape(EXPLANATIONS[0])])
      expect(topicIn(b1, 103).question_explanations[0].content_key).toBe(topicIn(b1, 103).questions[0].content_key)
      expect(topicIn(b2, 105).question_explanations.map(shape)).toEqual([shape(EXPLANATIONS[1])])
      expect(topicIn(b1, 112).question_explanations).toEqual([])
    })

    /** @covers REQ-462#figures */
    it('図の仕様を持つ論点は図の仕様のパスと figures の写しを持ち、持たない論点は null と空の配列を持つ', () => {
      const { ws, b1, b2 } = built()
      const t103 = topicIn(b1, 103)
      expect(typeof t103.figure_file).toBe('string')
      expect(samePath(ws, t103.figure_file, `${DATA}/material_figures/103.json`)).toBe(true)
      expect(t103.figures).toEqual(FIGURE_103.figures)
      const t105 = topicIn(b2, 105)
      expect(t105.figure_file).toBeNull()
      expect(t105.figures).toEqual([])
    })

    /** @covers REQ-462#prerequisites */
    it('各論点は、単元の構成の前提の論点を、他の単元の論点も含めて番号と名前で持ち、前提の無い論点は空の配列を持つ', () => {
      const { ws, b1, b2 } = built()
      expect(topicIn(b1, 109).prerequisites).toEqual([ref(103)])
      expect(topicIn(b2, 105).prerequisites).toEqual([ref(112), ref(109)])
      expect(topicIn(b1, 112).prerequisites).toEqual([])
      expect(topicIn(ws.readJson(rwFile(22, 1)), 221).prerequisites).toEqual([ref(103)])
    })

    /** @covers REQ-462#owners-touching-group */
    it('束は、そのまとまりの論点が触れる受け持ちだけを、受け持ちの論点が前のまとまりにあっても持つ', () => {
      const { ws, b1, b2 } = built()
      const p = plan21()
      const shape = (o: Json) => ({ subject: o.subject, owner: { topic_id: o.owner?.topic_id, term: o.owner?.term }, topics: o.topics })
      expect(b1.owners.map(shape)).toEqual(p.owners.map((o: Json) => ({ subject: o.subject, owner: ref(o.owner), topics: o.topics })))
      expect(b2.owners.map(shape)).toEqual([{ subject: '共通の説明', owner: ref(103), topics: [103, 109, 105] }])
      expect(ws.readJson(rwFile(22, 1)).owners).toEqual([])
    })
  })

  describe('単元の構成が無いか止める理由に当たれば何も書き出さずに止める（REQ-463）', () => {
    /** @covers REQ-463#plan-missing */
    it('求めた単元の単元の構成が無ければ、NOT_FOUND で止め、束を 1 つも書き出さず、その単元を示す', () => {
      const ws = makeWorkspace()
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21, 23] })
      expectRefused(r, 'NOT_FOUND')
      expectNothingWritten(ws, RW_OUT)
      expect(reasonOf(r)).toContain('23')
    })

    /** @covers REQ-463#plan-stops */
    it('求めた単元の単元の構成が止める理由に当たれば、CONFLICT で止め、束を 1 つも書き出さず、その単元と理由を示す', () => {
      const ws = makeWorkspace()
      const p = plan22()
      p.groups[1].name = p.groups[0].name
      ws.write(planFile(22), p)
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21, 22] })
      expectRefused(r, 'CONFLICT')
      expectNothingWritten(ws, RW_OUT)
      expect(reasonOf(r)).toContain('22')
      expect(reasonOf(r)).toMatch(/duplicateGroupName|前半|重な/)
    })

    /** @covers REQ-463#plan-unreadable */
    it('求めた単元の単元の構成が書きかけで読めなければ、CONFLICT で止め、束を 1 つも書き出さない', () => {
      const ws = makeWorkspace()
      ws.write(planFile(21), JSON.stringify(plan21()).slice(0, 80))
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectRefused(r, 'CONFLICT')
      expectNothingWritten(ws, RW_OUT)
      expect(reasonOf(r)).toContain('21')
    })

    /** @covers REQ-463#judged-with-all-plans */
    it('求めた単元の構成が他の単元の構成と合わせて前提の循環になれば、CONFLICT で止め、束を 1 つも書き出さない', () => {
      const ws = makeWorkspace()
      edit21(ws, (p) => (p.prerequisites['103'] = [221]))
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectRefused(r, 'CONFLICT')
      expectNothingWritten(ws, RW_OUT)
    })

    /** @covers REQ-463#other-unit-stop-ignored */
    it('止める理由が求めていない単元の構成にだけあれば、求めた単元の束を書き出す', () => {
      const ws = makeWorkspace()
      const p = plan22()
      p.groups[1].name = p.groups[0].name
      ws.write(planFile(22), p)
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectOk(r)
      expect(writtenOf(ws, r)).toEqual(absAll(ws, [rwFile(21, 1), rwFile(21, 2)]))
    })

    /** @covers REQ-463#units-omitted-plan-missing */
    it('単元を指定せず、論点のある単元（23）に構成が無ければ、NOT_FOUND で止め、束を 1 つも書き出さない', () => {
      const ws = makeWorkspace()
      const r = buildRewriteBundles(ws, { out: RW_OUT })
      expectRefused(r, 'NOT_FOUND')
      expectNothingWritten(ws, RW_OUT)
      expect(reasonOf(r)).toContain('23')
    })

    /** @covers REQ-463#units-omitted-topical-units */
    it('単元を指定せず、論点のある単元すべてに構成があれば、論点の無い単元（24）に構成が無くても全部のまとまりの束を書き出す', () => {
      const ws = makeWorkspace()
      ws.write(planFile(23), { unit_no: 23, unit: '単元二十三', overview: '単元二十三の全体像の文です。', groups: [{ name: '全部', description: '全部の説明です。', topics: [330, 331] }], owners: [] })
      const r = buildRewriteBundles(ws, { out: RW_OUT })
      expectOk(r)
      expect(writtenOf(ws, r)).toEqual(absAll(ws, [rwFile(21, 1), rwFile(21, 2), rwFile(22, 1), rwFile(22, 2), rwFile(23, 1)]))
    })

    /** @covers REQ-463#plan-missing-before-plan-stops */
    it('構成の無い単元と止める理由に当たる単元を同時に求めると、NOT_FOUND で止める', () => {
      const ws = makeWorkspace()
      edit21(ws, (p) => (p.groups[1].name = '土台'))
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21, 23] })
      expectRefused(r, 'NOT_FOUND')
      expectNothingWritten(ws, RW_OUT)
    })
  })

  describe('出力先に既に束があれば何も書き出さず書き換えずに止める（REQ-464）', () => {
    const OLD = '{"既にある束": true}'

    /** @covers REQ-464#same-bundle-exists */
    it('作る束と同じ名前の束が出力先にあれば、CONFLICT で止め、既にある束を書き換えず、他の束も書き出さず、出力先を示す（場合ごと）', () => {
      for (const [label, op, out, existing, units] of [
        ['単元の入力の束', buildUnitInputs, UI_OUT, uiFile(21), [21, 22]],
        ['書き直しの束', buildRewriteBundles, RW_OUT, rwFile(21, 1), [21, 22]],
      ] as const) {
        const ws = makeWorkspace()
        ws.write(existing, OLD)
        const r = op(ws, { out, units: [...units] })
        expectRefused(r, 'CONFLICT', label)
        expect(ws.files(out)).toEqual([existing.slice(out.length + 1)])
        expect(ws.read(existing)).toBe(OLD)
        expect(reasonOf(r)).toContain(out)
      }
    })

    /** @covers REQ-464#other-bundle-exists */
    it('作らない単元の束でも出力先に束があれば、CONFLICT で止め、何も書き出さない（場合ごと）', () => {
      for (const [label, op, out, existing, units] of [
        ['単元の入力の束', buildUnitInputs, UI_OUT, uiFile(23), [21]],
        ['書き直しの束', buildRewriteBundles, RW_OUT, rwFile(22, 1), [21]],
      ] as const) {
        const ws = makeWorkspace()
        ws.write(existing, OLD)
        const r = op(ws, { out, units: [...units] })
        expectRefused(r, 'CONFLICT', label)
        expect(ws.files(out)).toEqual([existing.slice(out.length + 1)])
        expect(ws.read(existing)).toBe(OLD)
      }
    })

    /** @covers REQ-464#non-bundle-name-ignored */
    it('出力先にあるのがその種類の束の名前の形でないファイルだけなら、止めずに書き出し、そのファイルは書き換えない（場合ごと）', () => {
      for (const [label, op, out, others, expected] of [
        ['単元の入力の束', buildUnitInputs, UI_OUT, ['memo.txt', '21-1.json'], [uiFile(21)]],
        ['書き直しの束', buildRewriteBundles, RW_OUT, ['memo.txt', '21.json'], [rwFile(21, 1), rwFile(21, 2)]],
      ] as const) {
        const ws = makeWorkspace()
        for (const f of others) ws.write(`${out}/${f}`, OLD)
        const r = op(ws, { out, units: [21] })
        try {
          expectOk(r)
          expect(writtenOf(ws, r)).toEqual(absAll(ws, [...expected]))
          for (const f of others) expect(ws.read(`${out}/${f}`)).toBe(OLD)
        } catch (e) {
          throw new Error(`${label} ${(e as Error).message}`)
        }
      }
    })

    /** @covers REQ-464#unknown-unit-before-exists */
    it('シラバスに無い単元を求め、出力先にも束があれば、INVALID_INPUT で断る（場合ごと）', () => {
      for (const [label, op, out, existing] of [
        ['単元の入力の束', buildUnitInputs, UI_OUT, uiFile(21)],
        ['書き直しの束', buildRewriteBundles, RW_OUT, rwFile(21, 1)],
      ] as const) {
        const ws = makeWorkspace()
        ws.write(existing, OLD)
        const r = op(ws, { out, units: [99] })
        expectRefused(r, 'INVALID_INPUT', label)
        expect(ws.read(existing)).toBe(OLD)
      }
    })

    /** @covers REQ-464#exists-before-plan-missing */
    it('出力先に束があり、求めた単元の単元の構成も無ければ、CONFLICT で止める', () => {
      const ws = makeWorkspace()
      ws.write(rwFile(21, 1), OLD)
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [23] })
      expectRefused(r, 'CONFLICT')
      expect(ws.files(RW_OUT)).toEqual(['21-1.json'])
    })
  })

  describe('単元を指定すれば、その単元の束だけを書き出す（REQ-465）', () => {
    /** @covers REQ-465#only-specified-unit-inputs */
    it('単元の入力の束は、指定した単元の束だけを書き出す', () => {
      const ws = makeWorkspace()
      const r = buildUnitInputs(ws, { out: UI_OUT, units: [22] })
      expectOk(r)
      expect(writtenOf(ws, r)).toEqual(absAll(ws, [uiFile(22)]))
      expect(ws.files(UI_OUT)).toEqual(['22.json'])
    })

    /** @covers REQ-465#only-specified-rewrite */
    it('書き直しの束は、指定した単元のまとまりの束だけを書き出す', () => {
      const ws = makeWorkspace()
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [22] })
      expectOk(r)
      expect(writtenOf(ws, r)).toEqual(absAll(ws, [rwFile(22, 1), rwFile(22, 2)]))
      expect(ws.files(RW_OUT)).toEqual(['22-1.json', '22-2.json'])
    })

    /** @covers REQ-465#unknown-unit */
    it('シラバスに無い単元を指定に含めれば、INVALID_INPUT で断り、何も書き出さない（場合ごと）', () => {
      for (const [label, op, out] of [
        ['単元の入力の束', buildUnitInputs, UI_OUT],
        ['書き直しの束', buildRewriteBundles, RW_OUT],
      ] as const) {
        const ws = makeWorkspace()
        const r = op(ws, { out, units: [21, 99] })
        expectRefused(r, 'INVALID_INPUT', label)
        expectNothingWritten(ws, out)
      }
    })
  })

  describe('登録簿に無い学び・資格対策でない学び・シラバスか論点の一覧が無いか読めない学びは何も書き出さずに断る（REQ-466）', () => {
    const BOTH = [
      ['単元の入力の束', buildUnitInputs, UI_OUT],
      ['書き直しの束', buildRewriteBundles, RW_OUT],
    ] as const

    /** @covers REQ-466#learning-file-missing */
    it('シラバスか論点の一覧が無い学びは、NOT_FOUND で断り、何も書き出さない（場合ごと）', () => {
      for (const [label, op, out] of BOTH)
        for (const file of ['syllabus.json', 'topics.json']) {
          const ws = makeWorkspace()
          ws.remove(`${DATA}/${file}`)
          expectRefused(op(ws, { out, units: [21] }), 'NOT_FOUND', `${label} ${file}`)
          expectNothingWritten(ws, out)
        }
    })

    /** @covers REQ-466#learning-file-unreadable */
    it('シラバスか論点の一覧が JSON として読めない学びは、INVALID_INPUT で断り、何も書き出さない（場合ごと）', () => {
      for (const [label, op, out] of BOTH)
        for (const file of ['syllabus.json', 'topics.json']) {
          const ws = makeWorkspace()
          ws.write(`${DATA}/${file}`, '{"items": [')
          expectRefused(op(ws, { out, units: [21] }), 'INVALID_INPUT', `${label} ${file}`)
          expectNothingWritten(ws, out)
        }
    })

    /** @covers REQ-466#registry-before-files */
    it('資格対策でない学びでシラバスも無ければ、INVALID_INPUT で断る（場合ごと）', () => {
      for (const [label, op] of BOTH) {
        const ws = makeWorkspace()
        ws.remove('data/itc/syllabus.json')
        expectRefused(op(ws, { data: 'data/itc', out: 'data/itc/bundles', units: [21] }), 'INVALID_INPUT', label)
      }
    })

    /** @covers REQ-466#missing-before-unreadable */
    it('シラバスが無く論点の一覧も読めなければ、NOT_FOUND で断る（場合ごと）', () => {
      for (const [label, op, out] of BOTH) {
        const ws = makeWorkspace()
        ws.remove(`${DATA}/syllabus.json`)
        ws.write(`${DATA}/topics.json`, '{"topics": [')
        expectRefused(op(ws, { out, units: [21] }), 'NOT_FOUND', label)
      }
    })

    /** @covers REQ-466#unknown-learning */
    it('登録簿に無い学び（置き場はある）は INVALID_INPUT で断り、作業場に何も書き出さない（場合ごと）', () => {
      for (const [label, op] of [
        ['単元の入力の束', buildUnitInputs],
        ['書き直しの束', buildRewriteBundles],
      ] as const) {
        const ws = makeWorkspace()
        const before = ws.snapshotTree()
        const r = op(ws, { data: 'data/zzz', out: 'data/zzz/bundles', units: [21] })
        expectRefused(r, 'INVALID_INPUT', label)
        expect(ws.snapshotTree()).toEqual(before)
      }
    })

    /** @covers REQ-466#not-qualification */
    it('資格対策でない学び（ロードマップ型の itc。置き場はある）は INVALID_INPUT で断り、作業場に何も書き出さない（場合ごと）', () => {
      for (const [label, op] of [
        ['単元の入力の束', buildUnitInputs],
        ['書き直しの束', buildRewriteBundles],
      ] as const) {
        const ws = makeWorkspace()
        const before = ws.snapshotTree()
        const r = op(ws, { data: 'data/itc', out: 'data/itc/bundles', units: [21] })
        expectRefused(r, 'INVALID_INPUT', label)
        expect(ws.snapshotTree()).toEqual(before)
      }
    })
  })

  describe('束に入る代表の過去問の正解が正解表に無ければ何も書き出さずに断り、畳まれて束に入らない過去問の正解が無いだけでは断らない（REQ-492）', () => {
    /** @covers REQ-492#answer-missing */
    it('書き直しの束に入る過去問の正解が正解表に無ければ、NOT_FOUND で断り、束を 1 つも書き出さない', () => {
      const ws = makeWorkspace()
      ws.write(`${DATA}/answer_keys.json`, { '2018h30a': { '1': 'ア' }, '2019h31h': { '5': 'ア', '7': 'ウ' } })
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectRefused(r, 'NOT_FOUND')
      expectNothingWritten(ws, RW_OUT)
    })

    /** @covers REQ-492#answer-table-missing */
    it('学びの置き場に正解表のファイルそのものが無ければ、束に入る過去問の正解も無いので、NOT_FOUND で断り、束を 1 つも書き出さない', () => {
      const ws = makeWorkspace()
      ws.remove(`${DATA}/answer_keys.json`)
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectRefused(r, 'NOT_FOUND')
      expectNothingWritten(ws, RW_OUT)
    })

    /** @covers REQ-492#plan-stops-before-answer-missing */
    it('求めた単元の構成が止める理由に当たり、過去問の正解も正解表に無ければ、CONFLICT で止める', () => {
      const ws = makeWorkspace()
      ws.write(`${DATA}/answer_keys.json`, { '2018h30a': { '1': 'ア' }, '2019h31h': { '5': 'ア', '7': 'ウ' } })
      edit21(ws, (p) => (p.groups[1].name = '土台'))
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectRefused(r, 'CONFLICT')
      expectNothingWritten(ws, RW_OUT)
    })

    /** @covers REQ-492#folded-answer-missing-not-refused */
    it('同一内容の組のうち、畳まれて束に入らない古い回の過去問の正解だけが正解表に無ければ、断らずに束を書き出す（場合ごと）', () => {
      for (const [label, keys] of [
        ['古い回の問番号だけが無い', { '2018h30a': {}, '2019h31h': { '5': 'ア', '6': 'エ', '7': 'ウ' } }],
        ['古い回が丸ごと無い', { '2019h31h': { '5': 'ア', '6': 'エ', '7': 'ウ' } }],
      ] as const) {
        const ws = makeWorkspace()
        ws.write(`${DATA}/answer_keys.json`, keys)
        const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
        try {
          expectOk(r)
          expect(writtenOf(ws, r)).toEqual(absAll(ws, [rwFile(21, 1), rwFile(21, 2)]))
          const q103 = ws.readJson(rwFile(21, 1)).topics.find((t: Json) => t.topic_id === 103).questions
          expect(q103.map((q: Json) => q.question_id), '束に入る代表').toEqual(['2019h31h-q5'])
        } catch (e) {
          throw new Error(`${label} ${(e as Error).message}`)
        }
      }
    })
  })

  describe('出力先に束を書き出せなければ、書き出した束を残さずに断り、出力先を示す（REQ-584）', () => {
    /** 書き込めないようにした置き場を、後片付けで消せるように戻す。 */
    const restoreMode = (ws: Workspace, rel: string) => fs.chmodSync(ws.abs(rel), 0o755)

    /** @covers REQ-584#out-path-is-file */
    it('出力先の位置に通常のファイルがあって出力先を作れなければ、STORAGE_UNAVAILABLE で断り、そのファイルを書き換えず、出力先を示す', () => {
      const ws = makeWorkspace()
      ws.write(RW_OUT, 'ふつうのファイル')
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectRefused(r, 'STORAGE_UNAVAILABLE')
      expect(ws.read(RW_OUT)).toBe('ふつうのファイル')
      expect(reasonOf(r)).toContain(RW_OUT)
    })

    /** @covers REQ-584#out-not-writable */
    it('出力先のディレクトリに書き込めなければ、STORAGE_UNAVAILABLE で断り、束を 1 つも残さず、出力先を示す', () => {
      const ws = makeWorkspace()
      fs.mkdirSync(ws.abs(RW_OUT), { recursive: true })
      fs.chmodSync(ws.abs(RW_OUT), 0o555)
      try {
        const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
        expectRefused(r, 'STORAGE_UNAVAILABLE')
        expectNothingWritten(ws, RW_OUT)
        expect(reasonOf(r)).toContain(RW_OUT)
      } finally {
        restoreMode(ws, RW_OUT)
      }
    })

    /** @covers REQ-584#partial-write-removed */
    it('1 つ目の束は書き出せて後の束を書き出せなければ、STORAGE_UNAVAILABLE で断り、先に書き出した束を残さず、出力先を示す', () => {
      // 単元 21 の束は 21-1・21-2 の 2 つ。後のまとまりの説明を長くして 21-2 だけを大きくし、
      // 書けるファイルの大きさの上限（ulimit -f）を 2 つの間に置いて、21-2 だけを書き出せなくする
      const longer = (ws: Workspace) => edit21(ws, (p) => (p.groups[1].description = `${'応用のまとまりの長い説明です。'.repeat(8000)}`))
      const base = makeWorkspace()
      longer(base)
      expectOk(buildRewriteBundles(base, { out: RW_OUT, units: [21] }))
      const [small, large] = [1, 2].map((k) => fs.statSync(base.abs(rwFile(21, k))).size)
      expect(large, '仕込み: 後の束が十分に大きくない').toBeGreaterThan(small + 4 * 512)
      const blocks = Math.ceil(small / 512) + 1

      const ws = makeWorkspace()
      longer(ws)
      const r = runLimited(ws, blocks, ['--data', DATA, '--out', RW_OUT, '--units', '21'])
      expectRefused(r, 'STORAGE_UNAVAILABLE')
      expectNothingWritten(ws, RW_OUT)
      expect(reasonOf(r)).toContain(RW_OUT)
    })

    /** @covers REQ-584#answer-missing-before-write-failed */
    it('束に入る過去問の正解が正解表に無く、出力先にも書き出せなければ、NOT_FOUND で断る', () => {
      const ws = makeWorkspace()
      ws.write(`${DATA}/answer_keys.json`, { '2018h30a': { '1': 'ア' }, '2019h31h': { '5': 'ア', '7': 'ウ' } })
      ws.write(RW_OUT, 'ふつうのファイル')
      const r = buildRewriteBundles(ws, { out: RW_OUT, units: [21] })
      expectRefused(r, 'NOT_FOUND')
      expect(ws.read(RW_OUT)).toBe('ふつうのファイル')
    })
  })
})
