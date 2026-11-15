import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  OTHER_UNIT, REASON, REWRITTEN, UNIT,
  body, build, buildRaw, cleanWorkspaces, dropEntry, expectRefused, figureFile, figureRef, figureSpecFile, figuresOf, filesWithTopic, generations, isRewritten,
  learningOrder, lineSub, makeWorkspace, plainDetail, plainExplanation, planFile, setEntry, setupRewritten, snap, solidPng, sortedNumbers, toolError,
  type Run, type Snap, type TopicFixture, type Ws,
} from './UC-028_fixture'

/** UC-028 単元の読み物を作る入口（buildUnitReading）が断る・止める境界。
 *  観測するのは、終了コード、標準出力の ToolError（code・reason と、その失敗が挙げる欄）、出力先と置き場の写しが前と変わらないことだけ。
 *  契約の errors の並びは判定の順なので、隣り合う 2 つの条件を同時に満たす入力では前の方の失敗になることも見る。 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const OUT = 'readings/ip_21'

afterAll(() => cleanWorkspaces())

/** 書き直した世代の作り物を作り、学ぶ順の位置で論点を引けるようにする。 */
function prepared(name: string) {
  const ws = makeWorkspace(name)
  const unit = setupRewritten(ws)
  return { ws, unit, T: (i: number) => unit.at(i) }
}
/** 最も新しい前の世代。 */
const newestPrevious = (ws: Ws) => generations(ws).filter((g) => !isRewritten(g)).slice(-1)[0]
/** 論点の配る本文を、書き直した世代から前の世代へ移す。 */
function toPrevious(ws: Ws, t: TopicFixture) {
  dropEntry(ws, REWRITTEN, t.id)
  setEntry(ws, newestPrevious(ws), t.id, { term: t.term, explanation: plainExplanation(t), detail: plainDetail(t) })
}
/** 論点の配る本文を、どの世代からも消す。 */
function dropEverywhere(ws: Ws, t: TopicFixture) {
  for (const g of generations(ws)) dropEntry(ws, g, t.id)
}
/** 単元の構成の前提を 1 つ書き換える。 */
function setPrerequisite(ws: Ws, unit: string, key: number, value: number[]) {
  const plan = ws.readJson(planFile(ws, unit))
  plan.prerequisites = { ...(plan.prerequisites ?? {}), [String(key)]: value }
  ws.writeJson(planFile(ws, unit), plan)
}
/** 論点 B の配る本文に、論点 A の 1 番目の図と拡張子だけ違う png を指す図の行を足す（同じ PNG の名前になる 2 つの図）。 */
function addCollision(ws: Ws, A: TopicFixture, B: TopicFixture) {
  setEntry(ws, REWRITTEN, B.id, { term: B.term, explanation: plainExplanation(B), detail: `${plainDetail(B)}\n\n![衝突する図の説明文です。](${figureRef(`${A.id}-1.png`)})` })
  ws.write(figureFile(ws, `${A.id}-1.png`), solidPng(40, 20, [255, 255, 255]))
}
const unreadableOf = (r: Run) => ((toolError(r.json)?.unreadable ?? []) as string[]).slice().sort()

describe('UC-028 入口の引数・学び・出力先・単元で断る（buildUnitReading）', () => {
  let ws: Ws
  beforeAll(() => {
    ws = makeWorkspace('early')
    setupRewritten(ws)
    ws.write('docs/memo.txt', '既にある中身')
    ws.write(`${ws.root}/data/ap/.keep`, '')
  })
  /** ToolError の arguments を、返された並びのまま引く（BR-055 の並びを見るため）。 */
  const argumentsOf = (r: Run) => ((toolError(r.json)?.arguments ?? []) as string[]).slice()

  describe('契約の引数の形の外（REQ-501）', () => {
    const badData = (w: Ws) => ['data/IP', 'ip', `${w.data}/`, path.join(w.dir, w.data), 'tests/fixtures/other/early/data/ip', `${w.root}/data/ip/../ip`, 'tests/fixtures/unit-reading/Early_Root/data/ip', 'data/ip2']
    /** @covers REQ-501#bad-data */
    it('学びが学びの置き場の形でなければ INVALID_INPUT で断り、data だけを挙げ、出力先もその親も作らない', () => {
      for (const data of badData(ws)) {
        const r = build(ws, { data })
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), data).toEqual(['data'])
      }
    })

    /** @covers REQ-501#bad-unit */
    it('単元が 2 桁の番号の形でなければ INVALID_INPUT で断り、unit だけを挙げ、出力先もその親も作らない', () => {
      for (const unit of ['1', '021', 'ab', '', '2a', '２１']) {
        const r = build(ws, { unit })
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), unit).toEqual(['unit'])
      }
    })

    /** @covers REQ-501#empty-out */
    it('出力先が空なら INVALID_INPUT で断り、out だけを挙げる', () => {
      const r = build(ws, { out: '' })
      expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
      expect(argumentsOf(r)).toEqual(['out'])
    })

    /** @covers REQ-501#missing-argument */
    it('必須の引数が無ければ INVALID_INPUT で断り、無い引数だけを挙げる', () => {
      for (const k of ['data', 'unit', 'out'] as const) {
        const r = build(ws, { [k]: null })
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), k).toEqual([k])
      }
    })

    /** @covers REQ-501#missing-argument */
    it('data・unit・out を前の部分だけの名前（--dat・--un・--o）でしか渡さなければ、3 つの欄が無く 3 つの名前が契約に無いとして、欄の 3 つに続けて名前を現れた順に挙げ、何も作らない', () => {
      const { ws: w } = prepared('missing-argument-abbr')
      const r = buildRaw(w, ['--dat', w.data, '--un', UNIT, '--o', 'readings/abbr'])
      expectRefused(r, w, 'INVALID_INPUT', REASON.badArguments, 'readings/abbr')
      expect(argumentsOf(r)).toEqual(['data', 'unit', 'out', 'dat', 'un', 'o'])
    })

    /** @covers REQ-501#missing-value */
    it('値を持たない名前（コマンドの末尾の名前・すぐ後が -- で始まる名前）があれば INVALID_INPUT で断り、その名前を挙げ、何も作らない', () => {
      const cases: [string, string[], string[]][] = [
        ['末尾の --out', ['--data', ws.data, '--unit', UNIT, '--out'], ['out']],
        ['すぐ後が --out の --unit', ['--data', ws.data, '--unit', '--out', OUT], ['unit']],
        ['末尾の --unit で out も無い', ['--data', ws.data, '--unit'], ['unit', 'out']],
      ]
      for (const [label, args, listed] of cases) {
        const r = buildRaw(ws, args)
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), label).toEqual(listed)
      }
    })

    /** @covers REQ-501#duplicated-argument */
    it('同じ名前が 2 回以上あれば、値が形の内でも外でも INVALID_INPUT で断り、その名前を 1 回だけ挙げ、何も作らない', () => {
      const cases: [string, string[], string[]][] = [
        ['前の値が形の外で後ろの値が形の内', ['--data', ws.data, '--unit', '1', '--unit', UNIT, '--out', OUT], ['unit']],
        ['同じ値を 2 回', ['--data', ws.data, '--unit', UNIT, '--unit', UNIT, '--out', OUT], ['unit']],
        ['= の有無の違う書き方で 2 回', ['--data', ws.data, '--unit', UNIT, `--out=${OUT}`, '--out', OUT], ['out']],
        ['3 回', ['--data', ws.data, '--data', ws.data, '--data', ws.data, '--unit', UNIT, '--out', OUT], ['data']],
      ]
      for (const [label, args, listed] of cases) {
        const r = buildRaw(ws, args)
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), label).toEqual(listed)
      }
    })

    /** @covers REQ-501#extra-argument */
    it('契約に無い名前か、どの名前の値でもない語があれば INVALID_INPUT で断り、その名前か語をそのまま挙げ、何も作らない', () => {
      const cases: [string, string[], string[]][] = [
        ['契約に無い名前', ['--cycle', '8'], ['cycle']],
        ['= で値を持つ契約に無い名前', ['--cycle=8'], ['cycle']],
        ['どの名前の値でもない語', ['stray'], ['stray']],
      ]
      for (const [label, extra, listed] of cases) {
        const r = build(ws, {}, extra)
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), label).toEqual(listed)
      }
    })

    /** @covers REQ-501#extra-argument */
    it('契約の引数名の前の部分だけの名前（--dat・--un・--o）は契約に無い名前で、契約の 3 つの引数がそろっていても INVALID_INPUT で断り、その名前を挙げ、何も作らない', () => {
      const extras: [(w: Ws) => string[], string][] = [[(w) => ['--dat', w.data], 'dat'], [() => ['--un', UNIT], 'un'], [() => ['--o', 'readings/abbr'], 'o']]
      for (const [extraOf, name] of extras) {
        const { ws: w } = prepared('extra-argument-abbr')
        const extra = extraOf(w)
        const r = build(w, {}, extra)
        expectRefused(r, w, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), extra.join(' ')).toEqual([name])
        expect(w.exists('readings/abbr'), extra.join(' ')).toBe(false)
      }
    })

    /** @covers REQ-501#all-bad-listed */
    it('形の外の引数が 2 つ以上あれば、契約の欄を request の順に、続けて契約に無い名前と語をコマンドに現れた順に、1 回ずつ挙げる', () => {
      const cases: [string, string[], string[]][] = [
        ['unit と out の値が形の外', ['--data', ws.data, '--unit', '1', '--out', ''], ['unit', 'out']],
        ['out と unit の順に渡しても request の順', ['--out', '', '--data', ws.data, '--unit', '1'], ['unit', 'out']],
        ['形の外の data と値の無い unit と無い out', ['--data', 'data/IP', '--unit'], ['data', 'unit', 'out']],
        ['欄の誤りと契約に無い名前と語が混ざる', ['--zeta', '1', '--data', 'data/IP', 'stray', '--unit', UNIT, '--alpha', '2', '--out', OUT, '--unit', UNIT], ['data', 'unit', 'zeta', 'stray', 'alpha']],
      ]
      for (const [label, args, listed] of cases) {
        const r = buildRaw(ws, args)
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), label).toEqual(listed)
      }
    })

    /** @covers REQ-501#bad-args-before-learning */
    it('引数が形の外で、かつ学びがロードマップ型か登録簿に無いとき、引数の誤りで断る', () => {
      for (const data of [`${ws.root}/data/eng`, `${ws.root}/data/zzz`]) {
        const r = build(ws, { data, unit: '1' })
        expectRefused(r, ws, 'INVALID_INPUT', REASON.badArguments)
        expect(argumentsOf(r), data).toEqual(['unit'])
      }
    })
  })

  describe('登録簿に無い学びか、ロードマップ型の学び（REQ-502）', () => {
    /** @covers REQ-502#unregistered */
    it('登録簿に無い学びは、置き場があっても無くても INVALID_INPUT で断り、出力先を作らない', () => {
      for (const data of [`${ws.root}/data/zzz`, 'data/zzz']) expectRefused(build(ws, { data, unit: '01' }), ws, 'INVALID_INPUT', REASON.unknownLearning)
    })

    /** @covers REQ-502#roadmap */
    it('ロードマップ型の学びは INVALID_INPUT で断り、出力先を作らない', () => {
      for (const data of [`${ws.root}/data/eng`, 'data/itc']) expectRefused(build(ws, { data, unit: '01' }), ws, 'INVALID_INPUT', REASON.roadmapLearning)
    })

    /** @covers REQ-502#roadmap-before-out-inside */
    it('ロードマップ型の学びで、かつ出力先が学びの置き場の中のとき、ロードマップ型の学びとして断る', () => {
      const out = `${ws.root}/data/eng/reading_01`
      expectRefused(build(ws, { data: `${ws.root}/data/eng`, unit: '01', out }), ws, 'INVALID_INPUT', REASON.roadmapLearning, out)
    })
  })

  describe('出力先が学びの置き場の中か、中身がある（REQ-510）', () => {
    /** @covers REQ-510#inside-own-learning */
    it('出力先が指定した学びの置き場の中なら INVALID_INPUT で止め、何も作らない', () => {
      const out = `${ws.data}/reading_21`
      expectRefused(build(ws, { out }), ws, 'INVALID_INPUT', REASON.outInsideData, out)
    })

    /** @covers REQ-510#inside-other-learning */
    it('出力先がほかの学びの置き場（置き場の根の data の下）の中でも INVALID_INPUT で止める', () => {
      for (const out of [`${ws.root}/data/ap/reading_21`, `${ws.root}/data/zzz/reading_21`]) expectRefused(build(ws, { out }), ws, 'INVALID_INPUT', REASON.outInsideData, out)
    })

    /** @covers REQ-510#inside-by-other-spelling */
    it('別の書き方（.. を含む・絶対パス・./ 始まり）で学びの置き場の中を指す出力先も INVALID_INPUT で止める', () => {
      for (const out of [`${ws.root}/public/../data/ip/reading_21`, path.join(ws.dir, ws.data, 'reading_21'), `./${ws.data}/reading_21`]) {
        const r = build(ws, { out })
        expectRefused(r, ws, 'INVALID_INPUT', REASON.outInsideData, path.isAbsolute(out) ? path.relative(ws.dir, out) : out)
      }
    })

    /** @covers REQ-510#inside-before-not-empty */
    it('出力先が学びの置き場そのもの（中身がある）なら、中身があるより先に学びの置き場の中として止める', () => {
      const entries = () => fs.readdirSync(ws.abs(ws.data)).sort()
      const before = entries()
      const r = build(ws, { out: ws.data })
      expect(r.status, r.stdout).not.toBe(0)
      expect(r.code).toBe('INVALID_INPUT')
      expect(toolError(r.json)?.reason).toBe(REASON.outInsideData)
      expect(entries()).toEqual(before)
    })

    /** @covers REQ-510#out-not-empty */
    it('出力先に中身があれば CONFLICT で止め、出力先の中身を変えない', () => {
      const before = snap(ws, 'docs')
      expectRefused(build(ws, { out: 'docs' }), ws, 'CONFLICT', REASON.outNotEmpty, 'docs', before)
    })

    /** @covers REQ-510#not-empty-before-unit-missing */
    it('出力先に中身があり、かつ単元が無いとき、出力先に中身があるとして止める', () => {
      const before = snap(ws, 'docs')
      expectRefused(build(ws, { unit: '99', out: 'docs' }), ws, 'CONFLICT', REASON.outNotEmpty, 'docs', before)
    })
  })

  describe('単元が無い（REQ-503）', () => {
    /** @covers REQ-503#unit-not-in-learning */
    it('学びに無い単元の番号なら NOT_FOUND で止め、その単元を挙げ、出力先を作らない', () => {
      for (const unit of ['99', '00', '24']) {
        const r = build(ws, { unit })
        expectRefused(r, ws, 'NOT_FOUND', REASON.unitMissing)
        expect(toolError(r.json)?.unit).toBe(unit)
      }
    })
  })
})

describe('UC-028 単元の構成を持たない単元（buildUnitReading）', () => {
  /** @covers REQ-503#unit-without-plan */
  it('学びにある単元でも単元の構成を持たなければ NOT_FOUND で止め、その単元を挙げる', () => {
    const { ws } = prepared('unit-without-plan')
    ws.remove(planFile(ws, OTHER_UNIT))
    const r = build(ws, { unit: OTHER_UNIT })
    expectRefused(r, ws, 'NOT_FOUND', REASON.unitMissing)
    expect(toolError(r.json)?.unit).toBe(OTHER_UNIT)
  })

  /** @covers REQ-503#unit-missing-before-unreadable */
  it('単元が無く、かつ読むファイルが読めないとき、単元が無いとして止める', () => {
    const { ws } = prepared('unit-missing-and-unreadable')
    ws.write(`${ws.data}/topics.json`, '{ "topics": [')
    const r = build(ws, { unit: '99' })
    expectRefused(r, ws, 'NOT_FOUND', REASON.unitMissing)
    expect(toolError(r.json)?.unit).toBe('99')
  })
})

describe('UC-028 学びに無い単元が単元の構成のファイルだけを持つ（buildUnitReading）', () => {
  // @covers REQ-503#unit-not-in-learning-with-plan
  it('学びのシラバスに無い単元の番号なら、単元の構成のファイルがあっても門の止める理由より先に NOT_FOUND で止め、その単元を挙げ、出力先を作らない', () => {
    const { ws } = prepared('unit-not-in-learning-with-plan')
    const plan = ws.readJson(planFile(ws, UNIT))
    for (const unit of ['99', '00', '24']) {
      ws.writeJson(planFile(ws, unit), { ...plan, unit_no: Number(unit) })
      const r = build(ws, { unit })
      expectRefused(r, ws, 'NOT_FOUND', REASON.unitMissing)
      expect(toolError(r.json)?.unit, unit).toBe(unit)
      ws.remove(planFile(ws, unit))
    }
  })
})

describe('UC-028 読むファイルが契約の形として読めない（REQ-507）', () => {
  const broken: [string, string][] = [['JSON として読めない', '{ "materials": [\n'], ['空のファイル', '']]

  /** @covers REQ-507#materials-unreadable */
  it('配る本文を選ぶ教材の世代のファイル（書き直した世代・前の世代）が読めないか topic_id の無い行を持てば INVALID_INPUT で止め、そのファイルを挙げる', () => {
    const cases: [string, (ws: Ws, A: TopicFixture) => string][] = [
      ...broken.map(([label, text]): [string, (ws: Ws, A: TopicFixture) => string] => [`書き直した世代が${label}`, (ws, A) => {
        const f = filesWithTopic(ws, REWRITTEN, A.id)[0]
        ws.write(f, text)
        return f
      }]),
      ...broken.map(([label, text]): [string, (ws: Ws, A: TopicFixture) => string] => [`前の世代が${label}`, (ws, A) => {
        const f = filesWithTopic(ws, newestPrevious(ws), A.id)[0]
        ws.write(f, text)
        return f
      }]),
      ['書き直した世代に topic_id の無い行', (ws, A) => {
        const f = filesWithTopic(ws, REWRITTEN, A.id)[0]
        const j = ws.readJson(f)
        j.materials = [...j.materials, { term: '番号の無い行', explanation: '説明です。', detail: '### 見出し\n解説です。' }]
        ws.writeJson(f, j)
        return f
      }],
    ]
    for (const [label, breakIt] of cases) {
      const { ws, T } = prepared('materials-unreadable')
      const f = breakIt(ws, T(0))
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', REASON.unreadable)
      expect(unreadableOf(r), label).toEqual([f])
    }
  })

  /** @covers REQ-507#unit-plan-unreadable */
  it('指定した単元の単元の構成のファイルが読めなければ INVALID_INPUT で止め、そのファイルを挙げる', () => {
    for (const [label, text] of broken) {
      const { ws } = prepared('unit-plan-unreadable')
      ws.write(planFile(ws, UNIT), text)
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', REASON.unreadable)
      expect(unreadableOf(r), label).toEqual([planFile(ws, UNIT)])
    }
  })

  /** @covers REQ-507#topics-unreadable */
  it('論点の一覧が読めなければ INVALID_INPUT で止め、そのファイルを挙げる', () => {
    const { ws } = prepared('topics-unreadable')
    ws.write(`${ws.data}/topics.json`, '{ "topics": [')
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.unreadable)
    expect(unreadableOf(r)).toEqual([`${ws.data}/topics.json`])
  })

  /** @covers REQ-507#glossary-source-unreadable */
  it('用語集の元のファイルが読めなければ INVALID_INPUT で止め、そのファイルを挙げる', () => {
    const { ws } = prepared('glossary-unreadable')
    ws.write(`${ws.data}/glossary_overrides.json`, '{ "読み物試験語甲": ')
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.unreadable)
    expect(unreadableOf(r)).toEqual([`${ws.data}/glossary_overrides.json`])
  })

  /** @covers REQ-507#figure-spec-unreadable */
  it('単元の論点の図の仕様が読めなければ INVALID_INPUT で止め、そのファイルを挙げる', () => {
    const { ws, T } = prepared('figure-spec-unreadable')
    ws.write(figureSpecFile(ws, T(0).id), '{ "figures": [')
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.unreadable)
    expect(unreadableOf(r)).toEqual([figureSpecFile(ws, T(0).id)])
  })

  /** @covers REQ-507#several-unreadable-listed */
  it('読めないファイルが 2 つ以上あれば、そのすべてを挙げる', () => {
    const { ws, T } = prepared('several-unreadable')
    const f = filesWithTopic(ws, REWRITTEN, T(0).id)[0]
    ws.write(f, '')
    ws.write(`${ws.data}/topics.json`, '')
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.unreadable)
    expect(unreadableOf(r)).toEqual([f, `${ws.data}/topics.json`].sort())
  })

  /** @covers REQ-507#unreadable-before-gate */
  it('読めないファイルがあり、かつ単元の構成が門の止める理由に当たるとき、読めないファイルとして止める', () => {
    const { ws, T } = prepared('unreadable-and-gate')
    const f = filesWithTopic(ws, REWRITTEN, T(0).id)[0]
    ws.write(f, '')
    setPrerequisite(ws, UNIT, T(5).id, [999])
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.unreadable)
    expect(unreadableOf(r)).toEqual([f])
  })
})

describe('UC-028 単元の構成が単元の構成の門の止める理由に当たる（REQ-504）', () => {
  const gateOf = (r: Run) => (toolError(r.json)?.gateReasons ?? []) as string[]

  /** @covers REQ-504#own-unit-reason */
  it('指定した単元に止める理由（学びに無い前提・どのまとまりにも無い論点）があれば INVALID_INPUT で止め、単元と止める理由を挙げる', () => {
    const cases: [string, (ws: Ws, T: (i: number) => TopicFixture) => void, string | null][] = [
      ['学びに無い前提', (ws, T) => setPrerequisite(ws, UNIT, T(5).id, [999]), '999'],
      ['どのまとまりにも無い論点', (ws) => {
        const plan = ws.readJson(planFile(ws, UNIT))
        const last = plan.groups[plan.groups.length - 1]
        last.topics = last.topics.slice(0, -1)
        ws.writeJson(planFile(ws, UNIT), plan)
      }, null],
    ]
    for (const [label, breakIt, mention] of cases) {
      const { ws, T } = prepared('unit-plan-gate-stops')
      breakIt(ws, T)
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', REASON.gateStops)
      expect(toolError(r.json)?.unit, label).toBe(UNIT)
      expect(gateOf(r).length, label).toBeGreaterThan(0)
      if (mention) expect(gateOf(r).some((g) => g.includes(mention)), `${label}: ${gateOf(r)}`).toBe(true)
    }
  })

  /** @covers REQ-504#cross-unit-cycle */
  it('前提の循環が指定した単元と別の単元の単元の構成にまたがるとき、指定した単元に関する止める理由として止める', () => {
    const { ws, T } = prepared('gate-cross-unit')
    const other = ws.readJson(planFile(ws, OTHER_UNIT))
    const head = learningOrder(other)[0]
    setPrerequisite(ws, UNIT, T(5).id, [head])
    setPrerequisite(ws, OTHER_UNIT, head, [T(5).id])
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.gateStops)
    expect(toolError(r.json)?.unit).toBe(UNIT)
    expect(gateOf(r).length).toBeGreaterThan(0)
  })

  /** @covers REQ-504#gate-before-body-missing */
  it('単元の構成が門の止める理由に当たり、かつ配る本文の無い論点があるとき、門の止める理由として止める', () => {
    const { ws, T } = prepared('gate-and-body-missing')
    setPrerequisite(ws, UNIT, T(5).id, [999])
    dropEverywhere(ws, T(6))
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.gateStops)
    expect(toolError(r.json)?.unit).toBe(UNIT)
  })
})

describe('UC-028 配る本文の無い論点（REQ-506）', () => {
  /** @covers REQ-506#no-body-in-any-generation */
  it('どの教材の世代にも本文の無い論点があれば NOT_FOUND で止め、その論点を挙げる', () => {
    const { ws, T } = prepared('body-missing')
    dropEverywhere(ws, T(6))
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.bodyMissing)
    expect(sortedNumbers(toolError(r.json)?.topics)).toEqual([T(6).id])
  })

  /** @covers REQ-506#several-topics-listed */
  it('本文の無い論点が 2 つ以上あれば、そのすべてを挙げる', () => {
    const { ws, T } = prepared('body-missing-several')
    dropEverywhere(ws, T(6))
    dropEverywhere(ws, T(7))
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.bodyMissing)
    expect(sortedNumbers(toolError(r.json)?.topics)).toEqual(sortedNumbers([T(6).id, T(7).id]))
  })

  /** @covers REQ-506#body-missing-before-mixed */
  it('本文の無い論点があり、かつ世代が混ざるとき、本文の無い論点として止める', () => {
    const { ws, T } = prepared('body-missing-and-mixed')
    dropEverywhere(ws, T(6))
    toPrevious(ws, T(7))
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.bodyMissing)
    expect(sortedNumbers(toolError(r.json)?.topics)).toEqual([T(6).id])
  })
})

describe('UC-028 書き直した世代と前の世代が単元の中で混ざる（REQ-505）', () => {
  /** @covers REQ-505#mixed */
  it('単元の論点の一部が前の世代から選ばれるとき CONFLICT で止め、書き直した世代から選ばれない論点を挙げる', () => {
    const cases: [string, (order: number[]) => number[]][] = [
      ['1 論点だけ', (o) => [o[o.length - 1]]],
      ['最後のまとまりの全論点', (o) => o.slice(-3)],
    ]
    for (const [label, pickIds] of cases) {
      const { ws, unit } = prepared('mixed-generations')
      const ids = pickIds(unit.order)
      for (const id of ids) toPrevious(ws, unit.byId(id))
      const r = build(ws)
      expectRefused(r, ws, 'CONFLICT', REASON.mixedGenerations)
      expect(sortedNumbers(toolError(r.json)?.topics), label).toEqual(sortedNumbers(ids))
    }
  })

  /** @covers REQ-505#mixed-before-figure-missing */
  it('世代が混ざり、かつ図の画像が無いとき、世代が混ざるとして止める', () => {
    const { ws, unit, T } = prepared('mixed-and-figure-missing')
    const last = unit.order[unit.order.length - 1]
    toPrevious(ws, unit.byId(last))
    ws.remove(figureFile(ws, `${T(0).id}-1.svg`))
    const r = build(ws)
    expectRefused(r, ws, 'CONFLICT', REASON.mixedGenerations)
    expect(sortedNumbers(toolError(r.json)?.topics)).toEqual([last])
  })
})

describe('UC-028 図の画像か差し込み位置の見出しが無い（REQ-508）', () => {
  /** @covers REQ-508#image-missing-inserted */
  it('図の仕様の図の画像が配信の置き場に無ければ NOT_FOUND で止め、論点と図と imageMissing を挙げる', () => {
    const { ws, T } = prepared('figure-missing')
    ws.remove(figureFile(ws, `${T(0).id}-2.svg`))
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.figureMissing)
    expect(figuresOf(r)).toEqual([{ topic_id: T(0).id, ref: figureRef(`${T(0).id}-2.svg`), cause: 'imageMissing' }])
  })

  /** @covers REQ-508#image-missing-line */
  it('配る本文の図の行が指す画像が配信の置き場に無ければ NOT_FOUND で止め、論点と図と imageMissing を挙げる', () => {
    const { ws, T } = prepared('figure-line-missing')
    const sub = lineSub(T(4), 'sub', T(0))
    ws.remove(figureFile(ws, sub))
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.figureMissing)
    expect(figuresOf(r)).toEqual([{ topic_id: T(4).id, ref: figureRef(sub), cause: 'imageMissing' }])
  })

  /** @covers REQ-508#image-only-in-other-learning */
  it('同じ名前の画像がほかの学びの置き場にだけあるときも、画像が無いとして止める', () => {
    const { ws, T } = prepared('figure-other-learning')
    const name = `${T(3).id}-1.svg`
    ws.write(`${ws.root}/public/figures/materials/ap/${name}`, ws.read(figureFile(ws, name)))
    ws.remove(figureFile(ws, name))
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.figureMissing)
    expect(figuresOf(r)).toEqual([{ topic_id: T(3).id, ref: figureRef(name), cause: 'imageMissing' }])
  })

  /** @covers REQ-508#heading-missing */
  it('図の行を持たない論点で、図の仕様の差し込み位置の見出しが配る本文に無ければ NOT_FOUND で止め、論点と図と headingMissing を挙げる', () => {
    const { ws, T } = prepared('figure-heading-missing')
    const A = T(0)
    setEntry(ws, REWRITTEN, A.id, { term: A.term, explanation: plainExplanation(A), detail: `${body.headA(A)}\n${body.detA1(A)}\n### 別の名前の見出し\n${body.detB(A)}` })
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.figureMissing)
    expect(figuresOf(r)).toEqual([{ topic_id: A.id, ref: figureRef(`${A.id}-2.svg`), cause: 'headingMissing' }])
  })

  /** @covers REQ-508#figure-missing-before-collision */
  it('図の画像が無く、かつ同じ PNG の名前になる図があるとき、図の画像が無いとして止める', () => {
    const { ws, T } = prepared('figure-missing-and-collision')
    addCollision(ws, T(0), T(1))
    ws.remove(figureFile(ws, `${T(3).id}-1.svg`))
    const r = build(ws)
    expectRefused(r, ws, 'NOT_FOUND', REASON.figureMissing)
    expect(figuresOf(r)).toEqual([{ topic_id: T(3).id, ref: figureRef(`${T(3).id}-1.svg`), cause: 'imageMissing' }])
  })
})

describe('UC-028 図が同じ PNG の名前になるか、PNG に描けない（REQ-509）', () => {
  const notWellFormed: [string, string][] = [
    ['途中で切れた', '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" fill="#ffffff"/><text x="10" y="40">途中'],
    ['XML で決まっていない実体参照を含む', '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="10" y="40">A&nbsp;B</text></svg>'],
  ]
  const notDrawable: [string, string][] = [
    ['xmlns の無い SVG', '<svg width="240" height="60"><rect width="240" height="60" fill="#ffffff"/></svg>'],
    ['XML として整うが図でない', '<?xml version="1.0" encoding="UTF-8"?>\n<note>これは図ではない</note>\n'],
  ]
  /** 論点 D の図を描けない物にして作り、INTERNAL で止まって論点と図を挙げることを確かめる。 */
  function expectNotDrawn(name: string, svg: string, out = OUT, before: Snap | null = null) {
    const { ws, T } = prepared(name)
    const D = T(3)
    ws.write(figureFile(ws, `${D.id}-1.svg`), svg)
    return { ws, D, r: build(ws, { out }), check: (r: Run) => {
      expectRefused(r, ws, 'INTERNAL', REASON.notDrawable, out, before)
      expect(figuresOf(r, ['topic_id', 'ref'])).toEqual([{ topic_id: D.id, ref: figureRef(`${D.id}-1.svg`) }])
    } }
  }

  /** @covers REQ-509#not-well-formed */
  it('図が XML として整わない SVG なら INTERNAL で止め、論点と図を挙げ、読み物も図の画像も出力先も残さない', () => {
    for (const [, svg] of notWellFormed) {
      const { r, check } = expectNotDrawn('figure-not-well-formed', svg)
      check(r)
    }
  })

  /** @covers REQ-509#not-drawable */
  it('図が XML として整っても PNG に描けなければ INTERNAL で止め、論点と図を挙げ、何も残さない', () => {
    for (const [, svg] of notDrawable) {
      const { r, check } = expectNotDrawn('figure-not-drawable', svg)
      check(r)
    }
  })

  /** @covers REQ-509#name-collision */
  it('拡張子だけ違う 2 つの図が同じ PNG の名前になるとき INVALID_INPUT で止め、2 つの論点と図を挙げる', () => {
    const { ws, T } = prepared('figure-name-collision')
    addCollision(ws, T(0), T(1))
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.nameCollision)
    expect(figuresOf(r, ['topic_id', 'ref'])).toEqual(
      [{ topic_id: T(0).id, ref: figureRef(`${T(0).id}-1.svg`) }, { topic_id: T(1).id, ref: figureRef(`${T(0).id}-1.png`) }].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))),
    )
  })

  /** @covers REQ-509#collision-before-not-drawable */
  it('同じ PNG の名前になる図があり、かつ描けない図があるとき、同じ PNG の名前として止める', () => {
    const { ws, T } = prepared('collision-and-not-drawable')
    addCollision(ws, T(0), T(1))
    ws.write(figureFile(ws, `${T(3).id}-1.svg`), notDrawable[0][1])
    const r = build(ws)
    expectRefused(r, ws, 'INVALID_INPUT', REASON.nameCollision)
  })

  /** @covers REQ-509#created-dirs-removed */
  it('描けずに止めたとき、コマンドが作った出力先とその親のディレクトリも、作業場のどこに作ったファイルとディレクトリも残さない', () => {
    const { ws, T } = prepared('created-dirs-removed')
    ws.write(figureFile(ws, `${T(3).id}-1.svg`), notDrawable[0][1])
    const before = ws.entries('.')
    const r = build(ws, { out: 'readings/deep/ip_21' })
    expect(r.code, r.stdout).toBe('INTERNAL')
    expect(ws.exists('readings'), 'コマンドが作った readings が残った').toBe(false)
    expect(ws.entries('.'), '作業場の項目が呼ぶ前と違う').toEqual(before)
  })

  /** @covers REQ-509#existing-parent-kept */
  it('描けずに止めたとき、呼ぶ前からあった出力先の親のディレクトリはファイルもディレクトリも呼ぶ前と同じ中身のまま残す', () => {
    const { ws, T } = prepared('existing-parent-kept')
    ws.write('readings/.keep', '')
    ws.write('readings/kept/note.txt', '前からある中身')
    ws.write(figureFile(ws, `${T(3).id}-1.svg`), notDrawable[0][1])
    const before = snap(ws, 'readings')
    const r = build(ws, { out: OUT })
    expect(r.code, r.stdout).toBe('INTERNAL')
    expect(snap(ws, 'readings')).toEqual(before)
  })

  /** @covers REQ-509#existing-empty-out-kept-empty */
  it('出力先が呼ぶ前からある空のディレクトリなら、描けずに止めたあともファイルもディレクトリも無い空のまま残す', () => {
    const { ws, T } = prepared('existing-empty-out')
    ws.write(`${OUT}/.keep`, '')
    ws.remove(`${OUT}/.keep`)
    ws.write(figureFile(ws, `${T(3).id}-1.svg`), notDrawable[0][1])
    const r = build(ws, { out: OUT })
    expect(r.code, r.stdout).toBe('INTERNAL')
    expect(ws.exists(OUT)).toBe(true)
    expect(ws.entries(OUT), '出力先にファイルかディレクトリが残った').toEqual([])
    expect(ws.entries('readings')).toEqual(['ip_21/'])
  })

  /** @covers REQ-509#sources-untouched */
  it('描けずに止めたとき、配信の置き場の図の画像をどれも書き換えない', () => {
    const { ws, T } = prepared('sources-untouched')
    ws.write(figureFile(ws, `${T(3).id}-1.svg`), notDrawable[0][1])
    const pub = `${ws.root}/public/figures/materials`
    const before = ws.tree(pub)
    const r = build(ws, { out: OUT })
    expect(r.code, r.stdout).toBe('INTERNAL')
    expect(ws.tree(pub)).toEqual(before)
  })
})

