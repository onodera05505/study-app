import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import {
  EXAM_PHRASES,
  FIGURES_MAX,
  LIMITS,
  REGISTRY,
  SAME_TOPIC,
  SAME_UNIT,
  makeWorkspace,
  names,
  namesUnit,
  ofKind,
  UNIT_TOPICS,
  GEN,
  REWRITTEN_FROM,
  previousMaterial,
  v4Material,
  type Json,
  type Run,
  type Workspace,
  unitOf,
} from './UC-025_fixture'

/** UC-025 書き直した世代の様式の門（checkMaterialStyle ＝ `python3 scripts/check_material_style.py --data <学びの置き場> [--dir <世代>]`）の境界。
 *  観測するのは終了コードと標準出力の JSON（exitCode・topics・stops・warnings・limits）だけ。
 *  仕込みは UC-025_fixture.ts の一時の作業場の上で作る。 */

vi.setConfig({ testTimeout: 60_000 })

const made: Workspace[] = []
const ws0 = () => {
  const ws = makeWorkspace()
  made.push(ws)
  return ws
}
afterEach(() => {
  for (const ws of made.splice(0)) fs.rmSync(ws.dir, { recursive: true, force: true })
})

/** 一致させたい並びを、前後に別の字を挟んで差し込める形にする（並びの外へ一致が伸びないため）。 */
const guarded = (ws: Workspace, s: string) => `${ws.fresh(1)}${s}${ws.fresh(1)}`
const out = (r: Run) => `${r.stdout}\n${r.stderr}`

/** 門が結果を返したこと（契約の response の欄がそろい、終了コードが response の exitCode と同じ）。 */
function expectResponse(r: Run): Json {
  expect(r.json, out(r)).toBeTypeOf('object')
  for (const k of ['exitCode', 'topics', 'stops', 'warnings', 'limits']) expect(r.json, out(r)).toHaveProperty(k)
  expect(r.status).toBe(r.json.exitCode)
  for (const f of [...r.json.stops, ...r.json.warnings]) {
    for (const k of ['kind', 'where', 'reason']) expect(typeof f[k] === 'string' && f[k].length > 0, JSON.stringify(f)).toBe(true)
  }
  return r.json
}
const expectPass = (r: Run) => {
  const j = expectResponse(r)
  expect(j.exitCode, out(r)).toBe(0)
  expect(j.stops).toEqual([])
  return j
}
const expectStopped = (r: Run) => {
  const j = expectResponse(r)
  expect(j.exitCode, out(r)).toBe(1)
  expect(j.stops.length).toBeGreaterThan(0)
  return j
}

describe('UC-025 書き直した世代の様式の門', () => {
  describe('REQ-451 止める理由が無ければ通す', () => {
    /** @covers REQ-451#clean-pass */
    it('止める理由も警告も無い世代は、見た論点の数と契約の値を返して通す', () => {
      const ws = ws0()
      const m = v4Material(ws, 311)
      previousMaterial(ws, 311).detail += `\n${ws.fresh(3)}は80です。`
      m.detail += `\n${ws.fresh(3)}は80です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(j.warnings).toEqual([])
      expect(j.topics).toBe(9)
      expect(j.limits).toEqual(LIMITS)
    })

    /** @covers REQ-451#warnings-only-pass */
    it('警告の 4 種類だけが当たる世代は通し、警告ごとに種類と論点と箇所を返す', () => {
      const ws = ws0()
      v4Material(ws, 311).explanation += `\n- ${ws.fresh(4)}${EXAM_PHRASES[0]}${ws.fresh(4)}です。`
      const s20 = ws.fresh(SAME_TOPIC + 5)
      v4Material(ws, 312).explanation += `\n- ${guarded(ws, s20)}です。`
      v4Material(ws, 312).detail += `\n${guarded(ws, s20)}です。`
      const s30 = ws.fresh(SAME_UNIT + 5)
      v4Material(ws, 314).detail += `\n${guarded(ws, s30)}です。`
      v4Material(ws, 315).detail += `\n${guarded(ws, s30)}です。`
      previousMaterial(ws, 321).detail += `\n${ws.fresh(3)}は80です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      const expected: [string, number[]][] = [
        ['examPhrase', [311]],
        ['sameTopicRepeat', [312]],
        ['sameUnitRepeat', [314, 315]],
        ['lostNumber', [321]],
      ]
      for (const [kind, ids] of expected) {
        const hits = ofKind(j.warnings, kind).filter((f) => ids.every((id) => names(f, id)))
        expect(hits.length, `${kind} ${JSON.stringify(j.warnings)}`).toBeGreaterThan(0)
      }
      expect(j.topics).toBe(9)
    })

    /** @covers REQ-451#default-dir */
    it('書き直した世代の名前を省くと、書き直した世代の始まりの世代を確かめる', () => {
      const ws = ws0()
      v4Material(ws, 313).explanation += `\n- ${ws.fresh(4)}${EXAM_PHRASES[1]}${ws.fresh(4)}です。`
      ws.materialize()
      const j = expectPass(ws.gate({ dir: null }))
      expect(j.topics).toBe(9)
      expect(ofKind(j.warnings, 'examPhrase').some((f) => names(f, 313))).toBe(true)
    })
  })

  describe('REQ-452 書き直した世代の置き場の教材だけを確かめる', () => {
    /** @covers REQ-452#no-rewritten-dir */
    it('書き直した世代の置き場が無い学びは、名前を省いても書き直した世代の名前を渡しても、前の世代と図に問題があっても 0 論点で通す', () => {
      const ws = ws0()
      ws.model.v4 = {}
      previousMaterial(ws, 311).explanation += `${EXAM_PHRASES[0]}${ws.fresh(3)}は80です。`
      ws.model.figures[311][1].after = 'explanation'
      ws.materialize()
      expect(ws.exists(`data/ip/${GEN(REWRITTEN_FROM)}`)).toBe(false)
      for (const dir of [null, GEN(REWRITTEN_FROM), GEN(REWRITTEN_FROM + 5)]) {
        const j = expectPass(ws.gate({ dir }))
        expect(j.topics, String(dir)).toBe(0)
        expect(j.warnings, String(dir)).toEqual([])
      }
    })

    /** @covers REQ-452#previous-only-topic */
    it('前の世代にだけ教材がある論点は、単元の構成・図・読めない図の仕様・言い回し・数値のどれでも止めも警告もしない', () => {
      const ws = ws0()
      ws.model.previous.push({
        topic_id: 331,
        term: ws.model.topics.find((t) => t.id === 331)!.term,
        explanation: `**論点**とは、${ws.fresh(6)}です。${EXAM_PHRASES[2]}${ws.fresh(3)}`,
        detail: `### ${ws.fresh(4)}\n${ws.fresh(6)}は95です。`,
      })
      ws.model.figures[331] = [
        { id: 1, type: 'blocks', caption: `${ws.fresh(10)}を表します。`, after: 'explanation', nodes: [], edges: [] },
        { id: 2, type: 'blocks', caption: `${ws.fresh(10)}を表します。`, after: 'explanation', nodes: [], edges: [] },
      ]
      ws.materialize()
      ws.write('data/ip/material_figures/332.json', '{"topic_id": 332, "figures": [')
      const j = expectPass(ws.gate())
      expect([...j.stops, ...j.warnings].filter((f: Json) => names(f, 331) || names(f, 332))).toEqual([])
      expect(j.topics).toBe(9)
    })

    /** @covers REQ-452#dir-selects-generation */
    it('--dir に始まりより後の書き直した世代の名前を渡すとその世代だけを確かめ、始まりの世代の置き場の言い回しは警告しない', () => {
      const ws = ws0()
      ws.model.dir = GEN(REWRITTEN_FROM + 1)
      ws.materialize()
      const noisy = ws.model.v4['01-1'].map((m) => ({ ...m, explanation: `${m.explanation}\n- ${ws.fresh(3)}${EXAM_PHRASES[3]}${ws.fresh(3)}です。` }))
      ws.write(`data/ip/${GEN(REWRITTEN_FROM)}/01-1.json`, { bundle: '01-1', materials: noisy })
      const j = expectPass(ws.gate({ dir: GEN(REWRITTEN_FROM + 1) }))
      expect(ofKind(j.warnings, 'examPhrase')).toEqual([])
      expect(j.topics).toBe(9)
    })
  })

  describe('REQ-453 断る入力', () => {
    /** 断ったこと（標準出力の ToolError 1 つ、終了コード 2、止める理由も警告も返さない）。 */
    const expectRefused = (r: Run, code: 'INVALID_INPUT' | 'NOT_FOUND') => {
      expect(r.status, out(r)).toBe(2)
      expect(r.json, out(r)).toBeTypeOf('object')
      expect(r.json.error?.code, out(r)).toBe(code)
      expect(typeof r.json.error?.reason === 'string' && r.json.error.reason.length > 0, out(r)).toBe(true)
      expect(r.json.stops).toBeUndefined()
      expect(r.json.warnings).toBeUndefined()
    }
    /** 止める理由と警告に当たる物を置き場に仕込む（断るなら何も確かめないことを見るため）。 */
    const noisy = (ws: Workspace) => {
      ws.model.figures[311][1].after = 'explanation'
      v4Material(ws, 312).explanation += `\n- ${ws.fresh(3)}${EXAM_PHRASES[0]}${ws.fresh(3)}です。`
    }

    /** @covers REQ-453#unknown-learning */
    it('登録簿に無い学びは、置き場に止める理由があっても何も確かめずに INVALID_INPUT で断る', () => {
      const ws = ws0()
      ws.model.key = 'zzz'
      noisy(ws)
      ws.materialize()
      expect(REGISTRY.zzz).toBeUndefined()
      expectRefused(ws.gate(), 'INVALID_INPUT')
    })

    /** @covers REQ-453#not-qualification */
    it('登録簿の資格対策でない学びは、どれも何も確かめずに INVALID_INPUT で断る', () => {
      const keys = Object.keys(REGISTRY).filter((k) => !k.startsWith('_') && REGISTRY[k].kind !== 'exam')
      expect(keys.length).toBeGreaterThan(0)
      for (const key of keys) {
        const ws = ws0()
        ws.model.key = key
        noisy(ws)
        ws.materialize()
        expectRefused(ws.gate(), 'INVALID_INPUT')
      }
    })

    /** @covers REQ-453#earlier-generation */
    it('書き直した世代の始まりより前の世代の名前を --dir に渡すと、その置き場があっても何も確かめずに INVALID_INPUT で断る', () => {
      expect(REWRITTEN_FROM).toBeGreaterThan(1)
      for (let n = 1; n < REWRITTEN_FROM; n++) {
        const ws = ws0()
        noisy(ws)
        ws.materialize()
        ws.write(`data/ip/${GEN(n)}/01-1.json`, { bundle: '01-1', materials: ws.model.v4['01-1'] })
        expectRefused(ws.gate({ dir: GEN(n) }), 'INVALID_INPUT')
      }
    })

    /** @covers REQ-453#not-generation-name */
    it('世代の名前の形でない値を --dir に渡すと、その置き場があっても何も確かめずに INVALID_INPUT で断る', () => {
      const rewritten = GEN(REWRITTEN_FROM)
      for (const dir of [`data/ip/${rewritten}`, `${rewritten}/`, 'rewrite', 'materials_v', `Materials_v${REWRITTEN_FROM}`, `${rewritten}_draft`]) {
        const ws = ws0()
        noisy(ws)
        ws.materialize()
        ws.write(`data/ip/${dir.replace(/^data\/ip\//, '').replace(/\/$/, '')}/01-1.json`, { bundle: '01-1', materials: ws.model.v4['01-1'] })
        expectRefused(ws.gate({ dir }), 'INVALID_INPUT')
      }
    })

    /** 書き直した世代の名前の前後に改行・空白・タブが付いた形と、番号が全角の形。契約の形は文字列の全体に当たり、どれも当たらない。 */
    const FULLWIDTH = (n: number) => String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)))
    /** @covers REQ-453#not-generation-name */
    it.each([
      ['末尾に改行を付けた名前', `${GEN(REWRITTEN_FROM)}\n`],
      ['末尾に CR と改行を付けた名前', `${GEN(REWRITTEN_FROM)}\r\n`],
      ['先頭に改行を付けた名前', `\n${GEN(REWRITTEN_FROM)}`],
      ['先頭に空白を付けた名前', ` ${GEN(REWRITTEN_FROM)}`],
      ['末尾に空白を付けた名前', `${GEN(REWRITTEN_FROM)} `],
      ['末尾にタブを付けた名前', `${GEN(REWRITTEN_FROM)}\t`],
      ['番号を全角にした名前', `materials_v${FULLWIDTH(REWRITTEN_FROM)}`],
    ])('%s を --dir に渡すと、止める理由のある作業場でも何も確かめずに INVALID_INPUT で断る', (_label, dir) => {
      const ws = ws0()
      noisy(ws)
      ws.materialize()
      ws.write(`data/ip/${dir}/01-1.json`, { bundle: '01-1', materials: ws.model.v4['01-1'] })
      expectRefused(ws.gate({ dir }), 'INVALID_INPUT')
    })

    /** @covers REQ-453#catalog-missing */
    it('シラバスか論点の一覧が無い学びは、何も確かめずに NOT_FOUND で断る', () => {
      for (const file of ['syllabus.json', 'topics.json']) {
        const ws = ws0()
        noisy(ws)
        ws.materialize()
        ws.remove(`data/ip/${file}`)
        expectRefused(ws.gate(), 'NOT_FOUND')
      }
    })

    /** @covers REQ-453#catalog-unreadable */
    it('シラバスか論点の一覧が読めない学びは、何も確かめずに INVALID_INPUT で断る', () => {
      const broken: [string, string][] = [
        ['syllabus.json', '{"items": ['],
        ['syllabus.json', '{"items": {}}'],
        ['topics.json', '{"topics": [{"id": 311'],
        ['topics.json', '{"topics": "論点"}'],
      ]
      for (const [file, body] of broken) {
        const ws = ws0()
        noisy(ws)
        ws.materialize()
        ws.write(`data/ip/${file}`, body)
        expectRefused(ws.gate(), 'INVALID_INPUT')
      }
    })

    /** @covers REQ-453#not-qualification-before-not-rewritten */
    it('資格対策でない学びに書き直した世代でない世代の名前を渡すと、INVALID_INPUT で断る', () => {
      const ws = ws0()
      ws.model.key = 'itc'
      ws.materialize()
      expectRefused(ws.gate({ dir: GEN(REWRITTEN_FROM - 1) }), 'INVALID_INPUT')
    })

    /** @covers REQ-453#not-rewritten-before-catalog-missing */
    it('書き直した世代でない世代の名前を渡し、シラバスも無い学びは、NOT_FOUND でなく INVALID_INPUT で断る', () => {
      const ws = ws0()
      ws.materialize()
      ws.remove('data/ip/syllabus.json')
      expectRefused(ws.gate({ dir: GEN(REWRITTEN_FROM - 1) }), 'INVALID_INPUT')
    })

    /** @covers REQ-453#catalog-missing-before-unreadable */
    it('シラバスが無く論点の一覧が読めない学びは、INVALID_INPUT でなく NOT_FOUND で断る', () => {
      const ws = ws0()
      ws.materialize()
      ws.remove('data/ip/syllabus.json')
      ws.write('data/ip/topics.json', '{"topics": [')
      expectRefused(ws.gate(), 'NOT_FOUND')
    })
  })

  describe('REQ-454 読めない束のファイルで止める', () => {
    /** @covers REQ-454#not-json */
    it('書きかけで JSON として読めない束のファイルは、そのファイルを挙げて止める', () => {
      const ws = ws0()
      ws.model.rawV4['01-3'] = '{"bundle": "01-3", "materials": [{"topic_id": 316, "te'
      ws.materialize()
      const j = expectStopped(ws.gate())
      expect(ofKind(j.stops, 'unreadableOutput').some((f) => /01-3\.json/.test(`${f.where} ${f.reason}`)), JSON.stringify(j.stops)).toBe(true)
    })

    /** @covers REQ-454#missing-field */
    it('教材の必須の欄が欠ける束のファイルは、そのファイルを挙げて止める', () => {
      for (const drop of ['topic_id', 'term', 'explanation', 'detail', 'materials', 'bundle']) {
        const ws = ws0()
        const m: Json = { ...v4Material(ws, 311) }
        const file: Json = { bundle: '01-3', materials: [m] }
        if (drop === 'materials' || drop === 'bundle') delete file[drop]
        else delete m[drop]
        ws.model.rawV4['01-3'] = JSON.stringify(file)
        ws.materialize()
        const j = expectStopped(ws.gate())
        expect(ofKind(j.stops, 'unreadableOutput').some((f) => /01-3\.json/.test(`${f.where} ${f.reason}`)), `${drop} ${JSON.stringify(j.stops)}`).toBe(true)
      }
    })

    /** @covers REQ-454#wrong-type */
    it('欄の型が契約と違う束のファイルは、そのファイルを挙げて止める', () => {
      const variants: [string, (m: Json) => Json][] = [
        ['materials が配列でない', (m) => ({ bundle: '01-3', materials: m })],
        ['topic_id が文字列', (m) => ({ bundle: '01-3', materials: [{ ...m, topic_id: String(m.topic_id) }] })],
        ['topic_id が 0', (m) => ({ bundle: '01-3', materials: [{ ...m, topic_id: 0 }] })],
        ['bundle が数', (m) => ({ bundle: 13, materials: [m] })],
        ['explanation が空', (m) => ({ bundle: '01-3', materials: [{ ...m, explanation: '' }] })],
        ['detail が空', (m) => ({ bundle: '01-3', materials: [{ ...m, detail: '' }] })],
        ['中身が配列', (m) => [m]],
      ]
      for (const [label, make] of variants) {
        const ws = ws0()
        ws.model.rawV4['01-3'] = JSON.stringify(make({ ...v4Material(ws, 311) }))
        ws.materialize()
        const j = expectStopped(ws.gate())
        expect(ofKind(j.stops, 'unreadableOutput').some((f) => /01-3\.json/.test(`${f.where} ${f.reason}`)), `${label} ${JSON.stringify(j.stops)}`).toBe(true)
      }
    })

    /** @covers REQ-454#bundle-name-shape */
    it('書き直した世代の置き場の、束の名前の形でない名前の JSON のファイルは、そのファイルを挙げて止める', () => {
      for (const name of ['bundle_01', '1-1', '01-0', '001-1', '01_1', '01-1a']) {
        const ws = ws0()
        ws.model.rawV4[name] = JSON.stringify({ bundle: '01-1', materials: [] })
        ws.materialize()
        const j = expectStopped(ws.gate())
        const re = new RegExp(`(^|[^0-9A-Za-z_-])${name.replace(/[-]/g, '\\-')}\\.json`)
        expect(ofKind(j.stops, 'unreadableOutput').some((f) => re.test(`${f.where} ${f.reason}`)), `${name} ${JSON.stringify(j.stops)}`).toBe(true)
      }
    })

    /** @covers REQ-454#non-json-file-ignored */
    it('書き直した世代の置き場の、JSON でないファイルは止める理由にしない', () => {
      const ws = ws0()
      ws.materialize()
      ws.write(`data/ip/${ws.model.dir}/メモ.md`, '書き手のメモ\n')
      ws.write(`data/ip/${ws.model.dir}/01-1.json.tmp`, '{"bundle": "01-1"')
      const j = expectPass(ws.gate())
      expect(j.topics).toBe(9)
    })

    /** @covers REQ-454#all-listed */
    it('止める理由は件数で打ち切らず、読めない束のファイルをすべて挙げる', () => {
      const ws = ws0()
      ws.model.rawV4['01-3'] = '{"bundle": "01-3"'
      ws.model.rawV4['02-2'] = '[]'
      ws.materialize()
      const j = expectStopped(ws.gate())
      for (const file of ['01-3\\.json', '02-2\\.json']) {
        expect(ofKind(j.stops, 'unreadableOutput').some((f) => new RegExp(file).test(`${f.where} ${f.reason}`)), `${file} ${JSON.stringify(j.stops)}`).toBe(true)
      }
    })
  })

  describe('REQ-490 使えない単元の構成の単元で止める', () => {
    /** @covers REQ-490#unit-without-plan */
    it('書き直した世代に論点がある単元に単元の構成が無ければ、その単元を挙げて止め、論点ごとには重ねて挙げない', () => {
      const ws = ws0()
      ws.model.v4['03-1'] = [331, 332, 333].map((id) => ({
        topic_id: id,
        term: ws.model.topics.find((t) => t.id === id)!.term,
        explanation: `**論点**とは、${ws.fresh(10)}です。`,
        detail: `### ${ws.fresh(5)}\n${ws.fresh(16)}です。`,
      }))
      ws.materialize()
      const j = expectStopped(ws.gate())
      expect(ofKind(j.stops, 'unitPlanStops').some((f) => namesUnit(f, 3)), JSON.stringify(j.stops)).toBe(true)
      expect(ofKind(j.stops, 'topicNotInPlan').filter((f) => [331, 332, 333].some((id) => names(f, id))), JSON.stringify(j.stops)).toEqual([])
    })

    /** @covers REQ-490#plan-has-stops */
    it('論点の単元の構成が単元の構成の門の止める理由に当たれば、その単元を挙げて止め、論点ごとには重ねて挙げない', () => {
      const broken: [string, (ws: Workspace) => void][] = [
        ['まとまりに実在しない論点', (ws) => ws.model.plans[1].groups[0].topics.push(998)],
        ['まとまりが上限を超える', (ws) => {
          const extra = [341, 342, 343, 344, 345, 346, 347, 348, 349]
          for (const id of extra) ws.model.topics.push({ id, term: ws.fresh(3), syllabus_item: 1 })
          ws.model.plans[1].groups[1].topics = [314, 315, 316, ...extra]
        }],
        ['全体像が欠ける', (ws) => delete (ws.model.plans[1] as Json).overview],
      ]
      for (const [label, breakPlan] of broken) {
        const ws = ws0()
        breakPlan(ws)
        ws.materialize()
        const j = expectStopped(ws.gate())
        expect(ofKind(j.stops, 'unitPlanStops').some((f) => namesUnit(f, 1)), `${label} ${JSON.stringify(j.stops)}`).toBe(true)
        expect(ofKind(j.stops, 'topicNotInPlan').filter((f) => UNIT_TOPICS[1].some((id) => names(f, id))), label).toEqual([])
      }
    })

    /** @covers REQ-490#plan-file-unreadable */
    it('論点の単元の構成のファイルが書きかけで読めなければ、その単元を挙げて止め、論点ごとには重ねて挙げない', () => {
      const ws = ws0()
      ws.materialize()
      ws.write('data/ip/unit_plans/01.json', '{"unit_no": 1, "unit": "単元一", "groups": [')
      const j = expectStopped(ws.gate())
      expect(ofKind(j.stops, 'unitPlanStops').some((f) => namesUnit(f, 1)), JSON.stringify(j.stops)).toBe(true)
      expect(ofKind(j.stops, 'topicNotInPlan').filter((f) => UNIT_TOPICS[1].some((id) => names(f, id)))).toEqual([])
    })

    /** @covers REQ-490#plan-outside-scope */
    it('書き直した世代に論点が無い単元の単元の構成は、無くても読めなくても止める理由に当たっても見ない', () => {
      const ws = ws0()
      delete ws.model.v4['02-1']
      ws.model.plans[2].groups[0].topics.push(995)
      ws.materialize()
      ws.write('data/ip/unit_plans/03.json', '{"unit_no": 3, "groups": [')
      const j = expectPass(ws.gate())
      expect(j.topics).toBe(6)
      expect(j.warnings).toEqual([])
    })

    /** 単元の構成の前提で、2 つの単元の論点を互いに先に読む側として指し、学びの全部の構成をたどると循環させる。 */
    const crossCycle = (ws: Workspace, a: number, b: number) => {
      ws.model.plans[unitOf(a)].prerequisites = { [String(a)]: [b] }
      ws.model.plans[unitOf(b)].prerequisites = { [String(b)]: [a] }
    }
    /** 書き直した世代から、ある単元の束をすべて除く。 */
    const dropUnitBundles = (ws: Workspace, unitNo: number) => {
      for (const name of Object.keys(ws.model.v4)) if (Number(name.split('-')[0]) === unitNo) delete ws.model.v4[name]
    }

    /** @covers REQ-490#cross-unit-cycle */
    it('前提の循環が 2 つの単元の構成にまたがると、書き直した世代に論点がある側の単元を、どちらの側でも挙げて止め、論点ごとには重ねて挙げない', () => {
      for (const [kept, dropped] of [[2, 1], [1, 2]]) {
        const ws = ws0()
        crossCycle(ws, 311, 321)
        dropUnitBundles(ws, dropped)
        ws.materialize()
        const j = expectStopped(ws.gate())
        expect(ofKind(j.stops, 'unitPlanStops').some((f) => namesUnit(f, kept)), `単元 ${kept} ${JSON.stringify(j.stops)}`).toBe(true)
        expect(ofKind(j.stops, 'topicNotInPlan').filter((f) => UNIT_TOPICS[kept].some((id) => names(f, id))), `単元 ${kept}`).toEqual([])
      }
    })

    /** @covers REQ-490#cycle-outside-units */
    it('前提の循環に入らない単元にだけ書き直した世代の論点があれば、別の単元の構成どうしの循環があっても止めない', () => {
      const ws = ws0()
      ws.model.plans[3] = {
        unit_no: 3,
        unit: '単元三',
        overview: `${ws.fresh(20)}を学びます。`,
        groups: [{ name: 'まとまり丁', description: `${ws.fresh(10)}です。`, topics: [331, 332, 333] }],
        owners: [],
      }
      crossCycle(ws, 311, 331)
      dropUnitBundles(ws, 1)
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(j.topics).toBe(3)
    })
  })

  describe('REQ-491 どの単元の構成のまとまりにも無い論点で止める', () => {
    /** @covers REQ-491#unknown-topic */
    it('論点の一覧に無い論点が書き直した世代にあれば、その論点を挙げて止める', () => {
      const ws = ws0()
      ws.model.v4['01-1'].push({ topic_id: 999, term: ws.fresh(3), explanation: `**論点**とは、${ws.fresh(10)}です。`, detail: `### ${ws.fresh(5)}\n${ws.fresh(16)}です。` })
      ws.materialize()
      const j = expectStopped(ws.gate())
      expect(ofKind(j.stops, 'topicNotInPlan').some((f) => names(f, 999)), JSON.stringify(j.stops)).toBe(true)
    })

    /** @covers REQ-491#all-listed */
    it('止める理由は件数で打ち切らず、どのまとまりにも無い論点をすべて挙げる', () => {
      const ws = ws0()
      ws.model.v4['01-1'].push({ topic_id: 997, term: ws.fresh(3), explanation: `**論点**とは、${ws.fresh(10)}です。`, detail: `### ${ws.fresh(5)}\n${ws.fresh(16)}です。` })
      ws.model.v4['01-2'].push({ topic_id: 996, term: ws.fresh(3), explanation: `**論点**とは、${ws.fresh(10)}です。`, detail: `### ${ws.fresh(5)}\n${ws.fresh(16)}です。` })
      ws.model.v4['02-1'].push({ topic_id: 995, term: ws.fresh(3), explanation: `**論点**とは、${ws.fresh(10)}です。`, detail: `### ${ws.fresh(5)}\n${ws.fresh(16)}です。` })
      ws.materialize()
      const j = expectStopped(ws.gate())
      for (const id of [997, 996, 995]) expect(ofKind(j.stops, 'topicNotInPlan').some((f) => names(f, id)), `${id} ${JSON.stringify(j.stops)}`).toBe(true)
    })
  })

  describe('REQ-455 読めない図の仕様と、短い説明の直後の 2 枚目の図で止める', () => {
    /** @covers REQ-455#figure-spec-unreadable */
    it('書き直した世代に教材がある論点の図の仕様のファイルが読めなければ、そのファイルを挙げて止める', () => {
      const broken = [
        '{"topic_id": 312, "figures": [',
        '{"topic_id": 312, "figures": {}}',
        '{"topic_id": 312, "figures": [{"id": 1, "type": "blocks", "caption": "図を表します。"}]}',
        '{"topic_id": 312, "figures": [{"id": 1, "type": "blocks", "after": "explanation"}]}',
        '{"topic_id": 312, "figures": [{"id": 0, "type": "blocks", "caption": "図を表します。", "after": "explanation"}]}',
        '{"topic_id": "312", "figures": []}',
        '[]',
      ]
      for (const body of broken) {
        const ws = ws0()
        ws.materialize()
        ws.write('data/ip/material_figures/312.json', body)
        const j = expectStopped(ws.gate())
        expect(ofKind(j.stops, 'unreadableFigureSpec').some((f) => /(^|[^0-9])312\.json/.test(`${f.where} ${f.reason}`)), `${body} ${JSON.stringify(j.stops)}`).toBe(true)
      }
    })

    /** @covers REQ-455#over-max */
    it('短い説明の直後に置く図が上限を超える論点は、その論点を挙げて止める', () => {
      for (const n of [FIGURES_MAX + 1, FIGURES_MAX + 2]) {
        const ws = ws0()
        const figs = ws.model.figures[312]
        while (figs.length < n) figs.push({ id: figs.length + 1, type: 'blocks', caption: `${ws.fresh(10)}を表します。`, after: 'explanation', nodes: [], edges: [] })
        figs.forEach((f, i) => (f.after = i < n ? 'explanation' : f.after))
        ws.materialize()
        const j = expectStopped(ws.gate())
        const hits = ofKind(j.stops, 'explanationFigures')
        expect(hits.some((f) => names(f, 312)), `${n} ${JSON.stringify(j.stops)}`).toBe(true)
        expect(hits.filter((f) => !names(f, 312))).toEqual([])
      }
    })

    /** @covers REQ-455#within-max */
    it('短い説明の直後に置く図が 0 枚か上限ちょうどなら、見出しの後ろの図がいくつあっても止めない', () => {
      for (const n of [0, FIGURES_MAX]) {
        const ws = ws0()
        const m = v4Material(ws, 312)
        const heading = m.detail.split('\n')[0]
        ws.model.figures[312] = Array.from({ length: 4 }, (_, i) => ({
          id: i + 1,
          type: 'blocks',
          caption: `${ws.fresh(10)}を表します。`,
          after: i < n ? 'explanation' : heading,
          nodes: [],
          edges: [],
        }))
        ws.materialize()
        const j = expectPass(ws.gate())
        expect(ofKind(j.stops, 'explanationFigures')).toEqual([])
      }
    })
  })

  describe('REQ-457 問われ方・覚え方の言い回しは混同しやすい用語の見出しの外で警告する', () => {
    /** @covers REQ-457#in-explanation */
    it('短い説明にある言い回しは、どれも論点と箇所を挙げて警告し、通す', () => {
      for (const phrase of EXAM_PHRASES) {
        const ws = ws0()
        v4Material(ws, 315).explanation += `\n- ${ws.fresh(4)}${phrase}${ws.fresh(4)}です。`
        ws.materialize()
        const j = expectPass(ws.gate())
        const hits = ofKind(j.warnings, 'examPhrase').filter((f) => names(f, 315))
        expect(hits.length, `${phrase} ${JSON.stringify(j.warnings)}`).toBeGreaterThan(0)
        expect(hits.some((f) => /explanation|短い説明/.test(`${f.where} ${f.reason}`)), phrase).toBe(true)
      }
    })

    /** @covers REQ-457#in-detail-outside */
    it('詳しい解説の、混同しやすい用語より前の見出しの下にある言い回しは、どれも論点と箇所を挙げて警告する', () => {
      for (const phrase of EXAM_PHRASES) {
        const ws = ws0()
        const m = v4Material(ws, 315)
        const [head, ...rest] = m.detail.split('\n')
        m.detail = [head, `${ws.fresh(4)}${phrase}${ws.fresh(4)}です。`, ...rest].join('\n')
        ws.materialize()
        const j = expectPass(ws.gate())
        const hits = ofKind(j.warnings, 'examPhrase').filter((f) => names(f, 315))
        expect(hits.length, `${phrase} ${JSON.stringify(j.warnings)}`).toBeGreaterThan(0)
        expect(hits.some((f) => /detail|詳しい解説|###/.test(`${f.where} ${f.reason}`)), phrase).toBe(true)
      }
    })

    /** @covers REQ-457#inside-confusion-heading */
    it('混同しやすい用語の見出しの下にある言い回しは、どれも警告しない', () => {
      for (const phrase of EXAM_PHRASES) {
        const ws = ws0()
        v4Material(ws, 315).detail += `\n- **${ws.fresh(3)}** — ${ws.fresh(4)}${phrase}${ws.fresh(4)}です。`
        ws.materialize()
        const j = expectPass(ws.gate())
        expect(ofKind(j.warnings, 'examPhrase'), phrase).toEqual([])
      }
    })

    /** @covers REQ-457#after-confusion-section */
    it('混同しやすい用語の後ろに続く別の見出しの下にある言い回しは警告する', () => {
      const ws = ws0()
      v4Material(ws, 315).detail += `\n### ${ws.fresh(5)}\n${ws.fresh(4)}${EXAM_PHRASES[0]}${ws.fresh(4)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'examPhrase').some((f) => names(f, 315)), JSON.stringify(j.warnings)).toBe(true)
    })

    /** @covers REQ-457#phrase-in-heading */
    it('混同しやすい用語でない見出しの行の文そのものにある言い回しは、見出しの下の本文に無くても、どれも論点と詳しい解説の箇所を挙げて警告する', () => {
      for (const phrase of EXAM_PHRASES) {
        const ws = ws0()
        const m = v4Material(ws, 315)
        const [head, body, ...rest] = m.detail.split('\n')
        m.detail = [head, body, `### ${ws.fresh(3)}${phrase}${ws.fresh(3)}`, `${ws.fresh(10)}です。`, ...rest].join('\n')
        ws.materialize()
        const j = expectPass(ws.gate())
        const hits = ofKind(j.warnings, 'examPhrase').filter((f) => names(f, 315))
        expect(hits.length, `${phrase} ${JSON.stringify(j.warnings)}`).toBeGreaterThan(0)
        expect(hits.some((f) => /detail|詳しい解説|###/.test(`${f.where} ${f.reason}`)), phrase).toBe(true)
      }
    })

    /** @covers REQ-457#near-miss */
    it('言い回しの一部だけの語（試験・出題・覚える）は警告しない', () => {
      const ws = ws0()
      v4Material(ws, 315).explanation += `\n- ${ws.fresh(3)}の試験の範囲と出題の傾向を覚えている${ws.fresh(3)}です。`
      v4Material(ws, 316).detail += `\n${ws.fresh(3)}は問いの形と覚え書きの${ws.fresh(3)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'examPhrase')).toEqual([])
    })
  })

  describe('REQ-458 同じ論点の中の長い一致を警告する', () => {
    /** @covers REQ-458#caption-body-at-threshold */
    it('図の説明文と短い説明・詳しい解説が上限の字数ちょうど一致すると、論点を挙げて警告し、通す', () => {
      for (const where of ['explanation', 'detail'] as const) {
        const ws = ws0()
        const s = ws.fresh(SAME_TOPIC)
        ws.model.figures[313][1].caption = `${guarded(ws, s)}を表します。`
        v4Material(ws, 313)[where] += `\n${guarded(ws, s)}です。`
        ws.materialize()
        const j = expectPass(ws.gate())
        const hits = ofKind(j.warnings, 'sameTopicRepeat').filter((f) => names(f, 313))
        expect(hits.length, `${where} ${JSON.stringify(j.warnings)}`).toBeGreaterThan(0)
      }
    })

    /** @covers REQ-458#explanation-detail-at-threshold */
    it('短い説明と詳しい解説が上限の字数ちょうど一致すると、論点と 2 か所を挙げて警告する', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_TOPIC)
      v4Material(ws, 313).explanation += `\n- ${guarded(ws, s)}です。`
      v4Material(ws, 313).detail += `\n${guarded(ws, s)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      const hits = ofKind(j.warnings, 'sameTopicRepeat').filter((f) => names(f, 313))
      expect(hits.length, JSON.stringify(j.warnings)).toBeGreaterThan(0)
      expect(hits.some((f) => /explanation|短い説明/.test(`${f.where} ${f.reason}`) && /detail|詳しい解説|###/.test(`${f.where} ${f.reason}`)), JSON.stringify(hits)).toBe(true)
    })

    /** @covers REQ-458#below-threshold */
    it('一致が上限より 1 字短ければ、どの 2 か所でも警告しない', () => {
      const ws = ws0()
      const a = ws.fresh(SAME_TOPIC - 1)
      const b = ws.fresh(SAME_TOPIC - 1)
      v4Material(ws, 313).explanation += `\n- ${guarded(ws, a)}です。`
      v4Material(ws, 313).detail += `\n${guarded(ws, a)}です。`
      ws.model.figures[314][0].caption = `${guarded(ws, b)}を表します。`
      v4Material(ws, 314).detail += `\n${guarded(ws, b)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameTopicRepeat')).toEqual([])
    })

    /** @covers REQ-458#markup-excluded-reaches */
    it('記法と空白で途切れていても、除いて上限の字数に届けば警告する', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_TOPIC)
      v4Material(ws, 313).explanation += `\n- ${ws.fresh(1)}**${s.slice(0, 5)}**${s.slice(5, 12)} ${s.slice(12)}${ws.fresh(1)}です。`
      v4Material(ws, 313).detail += `\n${ws.fresh(1)}${s.slice(0, 9)} [[${s.slice(9, 15)}]]　${s.slice(15)}${ws.fresh(1)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameTopicRepeat').some((f) => names(f, 313)), JSON.stringify(j.warnings)).toBe(true)
    })

    /** @covers REQ-458#markup-not-counted */
    it('記法と空白を含めると上限を超えても、除いて上限に届かなければ警告しない', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_TOPIC - 1)
      const marked = `**${s.slice(0, 8)}** [[${s.slice(8)}]]`
      v4Material(ws, 313).explanation += `\n- ${guarded(ws, marked)}です。`
      v4Material(ws, 313).detail += `\n${guarded(ws, marked)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameTopicRepeat')).toEqual([])
    })

    /** @covers REQ-458#across-topics */
    it('別の論点の図の説明文や本文との一致は、同じ論点の繰り返しとして警告しない', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_TOPIC + 2)
      ws.model.figures[311][0].caption = `${guarded(ws, s)}を表します。`
      v4Material(ws, 312).explanation += `\n- ${guarded(ws, s)}です。`
      const t = ws.fresh(SAME_TOPIC + 2)
      v4Material(ws, 311).explanation += `\n- ${guarded(ws, t)}です。`
      v4Material(ws, 312).detail += `\n${guarded(ws, t)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameTopicRepeat')).toEqual([])
    })
  })

  describe('REQ-459 同じ単元の 2 論点の長い一致を警告する', () => {
    /** @covers REQ-459#at-threshold */
    it('同じまとまりの 2 論点の本文が上限の字数ちょうど一致すると、2 論点だけを挙げて警告し、通す', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_UNIT)
      v4Material(ws, 311).detail += `\n${guarded(ws, s)}です。`
      v4Material(ws, 312).detail += `\n${guarded(ws, s)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      const hits = ofKind(j.warnings, 'sameUnitRepeat').filter((f) => names(f, 311) && names(f, 312))
      expect(hits.length, JSON.stringify(j.warnings)).toBeGreaterThan(0)
      expect(hits.some((f) => [313, 314, 315, 316].some((id) => names(f, id)))).toBe(false)
    })

    /** @covers REQ-459#below-threshold */
    it('同じ単元の 2 論点の一致が上限より 1 字短ければ警告しない', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_UNIT - 1)
      v4Material(ws, 311).detail += `\n${guarded(ws, s)}です。`
      v4Material(ws, 312).detail += `\n${guarded(ws, s)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameUnitRepeat')).toEqual([])
    })

    /** @covers REQ-459#markup-excluded */
    it('記法と空白で途切れていても、除いて上限の字数に届けば警告する', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_UNIT)
      v4Material(ws, 311).detail += `\n${ws.fresh(1)}**${s.slice(0, 10)}** ${s.slice(10)}${ws.fresh(1)}です。`
      v4Material(ws, 312).detail += `\n${ws.fresh(1)}${s.slice(0, 18)}　**${s.slice(18, 24)}** ${s.slice(24)}${ws.fresh(1)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameUnitRepeat').some((f) => names(f, 311) && names(f, 312)), JSON.stringify(j.warnings)).toBe(true)
    })

    /** @covers REQ-459#term-not-counted */
    it('[[ ]] で囲んだ同じ用語を挟んでいても、その中の字は数えず、外の一致が上限に届かなければ警告しない', () => {
      const ws = ws0()
      const before = ws.fresh(15)
      const term = ws.fresh(SAME_UNIT + 5)
      const after = ws.fresh(SAME_UNIT - 1 - 15)
      const inner = `${before}[[${term}]]${after}`
      v4Material(ws, 311).detail += `\n${guarded(ws, inner)}です。`
      v4Material(ws, 312).detail += `\n${guarded(ws, inner)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameUnitRepeat'), JSON.stringify(j.warnings)).toEqual([])
    })

    /** @covers REQ-459#term-joins-across */
    it('[[ ]] で囲んだ用語が論点ごとに違っても、前後の一致をつなげて上限の字数に届けば警告する', () => {
      const ws = ws0()
      const before = ws.fresh(15)
      const after = ws.fresh(SAME_UNIT - 15)
      v4Material(ws, 311).detail += `\n${guarded(ws, `${before}[[${ws.fresh(3)}]]${after}`)}です。`
      v4Material(ws, 312).detail += `\n${guarded(ws, `${before}[[${ws.fresh(4)}]]${after}`)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameUnitRepeat').some((f) => names(f, 311) && names(f, 312)), JSON.stringify(j.warnings)).toBe(true)
    })

    /** @covers REQ-459#across-groups */
    it('同じ単元の別のまとまり（別の束）の 2 論点の一致も警告する', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_UNIT + 3)
      v4Material(ws, 311).explanation += `\n- ${guarded(ws, s)}です。`
      v4Material(ws, 316).detail += `\n${guarded(ws, s)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameUnitRepeat').some((f) => names(f, 311) && names(f, 316)), JSON.stringify(j.warnings)).toBe(true)
    })

    /** @covers REQ-459#different-units */
    it('別の単元の 2 論点の一致は警告しない', () => {
      const ws = ws0()
      const s = ws.fresh(SAME_UNIT + 10)
      v4Material(ws, 311).detail += `\n${guarded(ws, s)}です。`
      v4Material(ws, 321).detail += `\n${guarded(ws, s)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'sameUnitRepeat')).toEqual([])
    })

    /** @covers REQ-459#owner-named */
    it('一致した 2 論点の説明の受け持ちを単元の構成が決めていれば、受け持ちの論点も挙げる', () => {
      const ws = ws0()
      ws.model.plans[1].owners = [{ subject: `${ws.fresh(6)}の説明`, owner: 311, topics: [311, 312, 313] }]
      const s = ws.fresh(SAME_UNIT + 3)
      v4Material(ws, 312).detail += `\n${guarded(ws, s)}です。`
      v4Material(ws, 313).detail += `\n${guarded(ws, s)}です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      const hits = ofKind(j.warnings, 'sameUnitRepeat').filter((f) => names(f, 312) && names(f, 313))
      expect(hits.length, JSON.stringify(j.warnings)).toBeGreaterThan(0)
      expect(hits.some((f) => names(f, 311)), JSON.stringify(hits)).toBe(true)
    })
  })

  describe('REQ-460 前の世代から消えた数値を警告する', () => {
    const addPrev = (ws: Workspace, id: number, text: string) => (previousMaterial(ws, id).detail += `\n${ws.fresh(3)}は${text}です。`)
    const addNew = (ws: Workspace, id: number, text: string) => (v4Material(ws, id).detail += `\n${ws.fresh(3)}は${text}です。`)
    const lost = (j: Json, id: number) => ofKind(j.warnings, 'lostNumber').filter((f) => names(f, id))

    /** @covers REQ-460#lost-number */
    it('前の世代にある 2 桁の数値が書き直した世代に無ければ、論点と数値を挙げて警告し、通す', () => {
      const ws = ws0()
      addPrev(ws, 321, '80')
      ws.materialize()
      const j = expectPass(ws.gate())
      const hits = lost(j, 321)
      expect(hits.length, JSON.stringify(j.warnings)).toBeGreaterThan(0)
      expect(hits.some((f) => /(^|[^0-9])80([^0-9]|$)/.test(`${f.where} ${f.reason}`))).toBe(true)
    })

    /** @covers REQ-460#kept-number */
    it('前の世代の数値が書き直した世代の短い説明か詳しい解説にあれば警告しない', () => {
      const ws = ws0()
      addPrev(ws, 321, '80')
      addPrev(ws, 322, '2.5')
      addNew(ws, 321, '80')
      v4Material(ws, 322).explanation += `\n- ${ws.fresh(3)}は2.5です。`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'lostNumber')).toEqual([])
    })

    /** @covers REQ-460#single-digit-not-compared */
    it('小数点を含まない 1 桁の数値は、書き直した世代に無くても警告しない', () => {
      const ws = ws0()
      addPrev(ws, 321, '7')
      addPrev(ws, 322, '７')
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'lostNumber')).toEqual([])
    })

    /** @covers REQ-460#decimal-compared */
    it('小数点を含む数値は、桁が少なくても書き直した世代に無ければ警告する', () => {
      const ws = ws0()
      addPrev(ws, 321, '0.5')
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(lost(j, 321).some((f) => `${f.where} ${f.reason}`.includes('0.5')), JSON.stringify(j.warnings)).toBe(true)
    })

    /** @covers REQ-460#fullwidth-normalized */
    it('全角の数値は半角に寄せて比べ、書き直した世代に半角であれば警告しない', () => {
      const ws = ws0()
      addPrev(ws, 321, '８０')
      addPrev(ws, 322, '０．５')
      addNew(ws, 321, '80')
      addNew(ws, 322, '0.5')
      addPrev(ws, 323, '45')
      addNew(ws, 323, '４５')
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'lostNumber')).toEqual([])
    })

    /** @covers REQ-460#fullwidth-lost */
    it('全角の数値が書き直した世代にどの書き方でも無ければ警告する', () => {
      const ws = ws0()
      addPrev(ws, 321, '８０')
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(lost(j, 321).length, JSON.stringify(j.warnings)).toBeGreaterThan(0)
    })

    /** @covers REQ-460#figure-line-not-counted */
    it('前の世代の図の行の中の数値は、書き直した世代に無くても警告しない', () => {
      const ws = ws0()
      previousMaterial(ws, 321).detail += `\n![売上が 45 から 60 に増える図](/figures/materials/ip/321-12.svg)`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'lostNumber')).toEqual([])
    })

    /** @covers REQ-460#figure-line-caption-brackets-not-counted */
    it('図の説明文に角かっこを含む前の世代の図の行の中の数値も、書き直した世代に無くても警告しない', () => {
      const ws = ws0()
      previousMaterial(ws, 321).detail += `\n![根を A[1] に置き、売上が 45 から 60 に増える順に並べた図](/figures/materials/ip/321-12.svg)`
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'lostNumber'), JSON.stringify(j.warnings)).toEqual([])
    })

    /** @covers REQ-460#newest-previous-generation */
    it('前の世代は書き直した世代を除いて最も新しい世代で、それより古い世代にだけある数値は警告しない', () => {
      const ws = ws0()
      ws.model.older[GEN(REWRITTEN_FROM - 2)] = [{ ...previousMaterial(ws, 321), detail: `### ${ws.fresh(4)}\n${ws.fresh(3)}は55です。` }]
      ws.model.older[GEN(REWRITTEN_FROM - 3)] = [{ ...previousMaterial(ws, 322), detail: `### ${ws.fresh(4)}\n${ws.fresh(3)}は66です。` }]
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(ofKind(j.warnings, 'lostNumber')).toEqual([])
    })

    /** @covers REQ-460#previous-per-topic */
    it('最も新しい前の世代に無い論点は、その論点がある中で最も新しい世代の数値と比べて警告する', () => {
      const ws = ws0()
      const m = previousMaterial(ws, 323)
      ws.model.previous = ws.model.previous.filter((x) => x.topic_id !== 323)
      ws.model.older[GEN(REWRITTEN_FROM - 2)] = [{ ...m, detail: `### ${ws.fresh(4)}\n${ws.fresh(3)}は77です。` }]
      ws.model.older[GEN(REWRITTEN_FROM - 3)] = [{ ...m, detail: `### ${ws.fresh(4)}\n${ws.fresh(3)}は88です。` }]
      ws.materialize()
      const j = expectPass(ws.gate())
      const hits = lost(j, 323)
      expect(hits.some((f) => /(^|[^0-9])77([^0-9]|$)/.test(`${f.where} ${f.reason}`)), JSON.stringify(j.warnings)).toBe(true)
      expect(hits.some((f) => /(^|[^0-9])88([^0-9]|$)/.test(`${f.where} ${f.reason}`)), JSON.stringify(j.warnings)).toBe(false)
    })

    /** @covers REQ-460#rewritten-not-previous */
    it('始まりより後の書き直した世代を確かめるとき、始まりの書き直した世代は前の世代に数えない', () => {
      const ws = ws0()
      ws.model.dir = GEN(REWRITTEN_FROM + 1)
      ws.materialize()
      const start = ws.model.v4['02-1'].map((m) => (m.topic_id === 321 ? { ...m, detail: `${m.detail}\n${ws.fresh(3)}は44です。` } : m))
      ws.write(`data/ip/${GEN(REWRITTEN_FROM)}/02-1.json`, { bundle: '02-1', materials: start })
      const j = expectPass(ws.gate({ dir: GEN(REWRITTEN_FROM + 1) }))
      expect(lost(j, 321), JSON.stringify(j.warnings)).toEqual([])
    })

    /** @covers REQ-460#number-as-token */
    it('数値は取り出した数として比べ、書き直した世代に桁の多い別の数の一部としてあるだけなら警告する', () => {
      const ws = ws0()
      addPrev(ws, 321, '80')
      addNew(ws, 321, '180')
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(lost(j, 321).length, JSON.stringify(j.warnings)).toBeGreaterThan(0)
    })
  })

  describe('REQ-485 門は読む物を書き換えない', () => {
    /** @covers REQ-485#unchanged-on-pass */
    it('警告を出して通すとき、作業場のどのファイルも書き換えず、足しも消しもしない', () => {
      const ws = ws0()
      v4Material(ws, 311).explanation += `\n- ${ws.fresh(3)}${EXAM_PHRASES[0]}${ws.fresh(3)}です。`
      previousMaterial(ws, 321).detail += `\n${ws.fresh(3)}は80です。`
      ws.materialize()
      const before = ws.snapshotTree()
      const j = expectPass(ws.gate())
      expect(j.warnings.length).toBeGreaterThan(0)
      expect(ws.snapshotTree()).toEqual(before)
    })

    /** @covers REQ-485#unchanged-on-stop */
    it('読めない束・使えない単元の構成・読めない図の仕様・図の上限超えで止めるとき、作業場のどのファイルも書き換えない', () => {
      const ws = ws0()
      ws.model.rawV4['01-3'] = '{"bundle": "01-3", "materials": [{"topic_id": 316, "te'
      ws.model.plans[2].groups[0].topics.push(994)
      ws.model.figures[312][1].after = 'explanation'
      ws.materialize()
      ws.write('data/ip/material_figures/313.json', '{"topic_id": 313, "figures": [')
      const before = ws.snapshotTree()
      const j = expectStopped(ws.gate())
      expect(j.stops.length).toBeGreaterThan(1)
      expect(ws.snapshotTree()).toEqual(before)
    })

    /** @covers REQ-485#unchanged-on-refuse */
    it('断るとき、作業場のどのファイルも書き換えない', () => {
      const cases: [string, (ws: Workspace) => void, { dir?: string | null }][] = [
        ['資格対策でない学び', (ws) => (ws.model.key = 'itc'), {}],
        ['書き直した世代でない名前', () => {}, { dir: GEN(REWRITTEN_FROM - 1) }],
        ['論点の一覧が読めない', () => {}, {}],
      ]
      for (const [label, setup, req] of cases) {
        const ws = ws0()
        setup(ws)
        ws.model.figures[311][1].after = 'explanation'
        ws.materialize()
        if (label === '論点の一覧が読めない') ws.write('data/ip/topics.json', '{"topics": [')
        const before = ws.snapshotTree()
        const r = ws.gate(req)
        expect(r.status, label).toBe(2)
        expect(ws.snapshotTree(), label).toEqual(before)
      }
    })
  })

  describe('REQ-473 情報の量を見ない', () => {
    /** @covers REQ-473#large-volume */
    it('字数・文数・見出し・箇条・表の行がどれだけ多い教材でも、止めも警告もしない', () => {
      const ws = ws0()
      const m = v4Material(ws, 311)
      m.explanation = [
        `**${m.term}**とは、${ws.fresh(150)}です。`,
        `- **キーワード**: ${ws.fresh(3)}・${ws.fresh(3)}・${ws.fresh(3)}・${ws.fresh(3)}・${ws.fresh(3)}`,
        '',
        ...Array.from({ length: 12 }, () => `- ${ws.fresh(18)}です。`),
      ].join('\n')
      const blocks: string[] = []
      for (let h = 0; h < 12; h++) {
        blocks.push(`### ${ws.fresh(6)}`)
        blocks.push(Array.from({ length: 8 }, () => `${ws.fresh(15)}です。`).join(''))
        for (let b = 0; b < 8; b++) blocks.push(`- ${ws.fresh(10)}です。`)
      }
      blocks.push(`| ${ws.fresh(3)} | ${ws.fresh(3)} | ${ws.fresh(3)} | ${ws.fresh(3)} |`, '| --- | --- | --- | --- |')
      for (let r = 0; r < 15; r++) blocks.push(`| ${ws.fresh(4)} | ${ws.fresh(4)} | ${ws.fresh(4)} | ${ws.fresh(4)} |`)
      blocks.push('### 混同しやすい用語')
      for (let b = 0; b < 10; b++) blocks.push(`- **${ws.fresh(3)}** — ${ws.fresh(10)}です。`)
      m.detail = blocks.join('\n')
      ws.model.figures[311][1].after = m.detail.split('\n')[0]
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(j.warnings).toEqual([])
    })

    /** @covers REQ-473#small-volume */
    it('1 文だけの短い説明と見出しの無い 1 字の詳しい解説でも、止めも警告もしない', () => {
      const ws = ws0()
      const m = v4Material(ws, 311)
      m.explanation = `**${m.term}**です。`
      m.detail = ws.fresh(1)
      ws.model.figures[311] = [{ id: 1, type: 'blocks', caption: `${ws.fresh(10)}を表します。`, after: 'explanation', nodes: [], edges: [] }]
      ws.materialize()
      const j = expectPass(ws.gate())
      expect(j.warnings).toEqual([])
    })
  })
})
