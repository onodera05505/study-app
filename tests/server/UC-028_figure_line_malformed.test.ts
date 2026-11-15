import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  OTHER_UNIT, REASON, REWRITTEN,
  body, build, cleanWorkspaces, dropEntry, figureFile, figureRef, generations, isRewritten, learningOrder, makeWorkspace,
  plainDetail, plainExplanation, planFile, setEntry, setupPrevious, setupRewritten, snap, svgWith, toolError,
  type Json, type Run, type TopicFixture, type Ws,
} from './UC-028_fixture'

/** UC-028 配る本文に、配信の置き場の図を指す前置きを含むのに図の行の形（BR-054）に合わない行がある（REQ-512）。
 *  図の行の形の値は docs/_shared/components.yaml の MaterialFigureLine・MaterialFigureSrc。
 *  観測するのは、終了コード、標準出力の ToolError（code・reason・lines）、作業場の全部のファイルとディレクトリが呼ぶ前と同じことだけ。 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const OUT = 'readings/ip_21'
const READING = `${OUT}/reading.md`

afterAll(() => cleanWorkspaces())

function prepared(name: string) {
  const ws = makeWorkspace(name)
  const unit = setupRewritten(ws)
  return { ws, unit, T: (i: number) => unit.at(i) }
}

/** 論点の配る本文の説明か詳しい解説の段の間に 1 行を置く。 */
function putLine(ws: Ws, t: TopicFixture, line: string, where: 'explanation' | 'detail' = 'detail', gen = REWRITTEN) {
  const explanation = where === 'explanation' ? `${body.expl1(t)}\n\n${line}\n\n${body.expl2(t)}` : plainExplanation(t)
  const detail = where === 'detail'
    ? `${body.headA(t)}\n${body.detA1(t)}\n\n${line}\n\n${body.detA2(t)}\n${body.headB(t)}\n${body.detB(t)}`
    : plainDetail(t)
  setEntry(ws, gen, t.id, { term: t.term, explanation, detail })
}

const sortLines = (xs: Json[]) => xs.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
/** ToolError の lines を契約の欄だけにして、並びによらず比べられる形にする。 */
const linesOf = (r: Run) =>
  sortLines(((toolError(r.json)?.lines ?? []) as Json[]).map((l) => ({ topic_id: l?.topic_id, line: l?.line })))

/** 呼ぶ前の作業場の写しを取り、呼んで、止まったことと挙げた行と、作業場のどこにもファイルもディレクトリも足し引きされていないことを見る。 */
function expectStopped(ws: Ws, lines: { topic_id: number; line: string }[], label = '') {
  const before = ws.entries('.')
  const pub = snap(ws, `${ws.root}/public`)
  const r = build(ws, { out: OUT })
  expect(r.status, `${label} 止まらずに終わった:\n${r.stdout}\n${r.stderr}`).not.toBe(0)
  expect(r.code, `${label}\n${r.stdout}\n${r.stderr}`).toBe('INVALID_INPUT')
  expect(toolError(r.json)?.reason, r.stdout).toBe(REASON.figureLineMalformed)
  expect(linesOf(r), label).toEqual(sortLines(lines))
  expect(ws.entries('.'), '作業場のファイルかディレクトリが呼ぶ前と違う（単元の読み物か図の画像かディレクトリを残した）').toEqual(before)
  expect(snap(ws, `${ws.root}/public`), '配信の置き場が書き換わった').toEqual(pub)
  return r
}

/** 1 つの形の外の行を、図の無い論点（学ぶ順の 5 番目）の詳しい解説に置いて止まることを、行ごとに新しい作業場で見る。 */
function expectEachStopped(name: string, cases: [string, (ws: Ws, t: TopicFixture) => string][]) {
  for (const [label, lineOf] of cases) {
    const { ws, T } = prepared(name)
    const t = T(5)
    const line = lineOf(ws, t)
    putLine(ws, t, line)
    expectStopped(ws, [{ topic_id: t.id, line }], label)
  }
}

describe('UC-028 配る本文に図の置き場を指すのに図の行の形に合わない行がある（REQ-512）', () => {
  /** @covers REQ-512#dotdot-segment */
  it('指す先に .. の段を持つ行は、指す先の画像が置き場の根にあっても INVALID_INPUT で止め、論点と行を挙げ、出力先の中にも外にも PNG も読み物も作らない', () => {
    expectEachStopped('figure-line-dotdot', [
      ['置き場の根の public/figures を指す', (ws) => {
        ws.write(`${ws.root}/public/figures/zz-9.svg`, svgWith('外の図'))
        return '![図](/figures/materials/ip/../../zz-9.svg)'
      }],
      ['学びの置き場の中に戻る', (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('戻る図'))
        return `![図](/figures/materials/ip/uc028/../${t.id}-1.svg)`
      }],
      ['. の段', (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('点の図'))
        return `![図](/figures/materials/ip/./${t.id}-1.svg)`
      }],
    ])
  })

  /** @covers REQ-512#key-not-lowercase */
  it('学びの key の段が小文字の英字だけでない行（大文字・数字を含む）は INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    expectEachStopped('figure-line-key-case', [
      ['大文字の key', (ws, t) => {
        ws.write(`${ws.root}/public/figures/materials/IP/${t.id}-9.svg`, svgWith('大文字の図'))
        return `![図](/figures/materials/IP/${t.id}-9.svg)`
      }],
      ['数字を含む key', () => '![図](/figures/materials/ip2/369-9.svg)'],
    ])
  })

  /** @covers REQ-512#key-missing */
  it('学びの key の段が無い行（前置きのすぐ後に名前・空の段）は INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    expectEachStopped('figure-line-key-missing', [
      ['前置きのすぐ後に名前', (ws, t) => {
        ws.write(`${ws.root}/public/figures/materials/${t.id}-9.svg`, svgWith('key の無い図'))
        return `![図](/figures/materials/${t.id}-9.svg)`
      }],
      ['空の段', (_, t) => `![図](/figures/materials//${t.id}-9.svg)`],
    ])
  })

  /** @covers REQ-512#name-out-of-charset */
  it('サブパスか名前か拡張子が形の外の行（大文字・空白・svg と png でない拡張子・拡張子なし）は INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    expectEachStopped('figure-line-name', [
      ['名前に大文字', (_, t) => `![図](/figures/materials/ip/Fig-${t.id}.svg)`],
      ['サブパスに大文字', (_, t) => `![図](/figures/materials/ip/Sub/${t.id}-1.svg)`],
      ['名前に空白', (_, t) => `![図](/figures/materials/ip/${t.id} 1.svg)`],
      ['拡張子が大文字', (_, t) => `![図](/figures/materials/ip/${t.id}-1.SVG)`],
      ['svg と png でない拡張子', (_, t) => `![図](/figures/materials/ip/${t.id}-1.jpg)`],
      ['拡張子なし', (_, t) => `![図](/figures/materials/ip/${t.id}-1)`],
    ])
  })

  /** @covers REQ-512#control-char-in-src */
  it('指す先の途中に制御文字（U+0085・U+001C・U+001F）を含む行は、その名前の画像が置き場にあっても INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    expectEachStopped('figure-line-control', ['\u0085', '\u001c', '\u001f'].map((ch): [string, (ws: Ws, t: TopicFixture) => string] => [
      `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
      (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1${ch}x.svg`), svgWith('制御の図'))
        return `![図](${figureRef(`${t.id}-1${ch}x.svg`)})`
      },
    ]))
  })

  /** @covers REQ-512#not-whole-line */
  it('画像の記法が行全体でない行（前か後ろに文字・同じ行に 2 つの画像）は、指す先が形の内でも INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    expectEachStopped('figure-line-not-whole', [
      ['前に文字', (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('前の図'))
        return `次の図を見ます。![図](${figureRef(`${t.id}-1.svg`)})`
      }],
      ['後ろに文字', (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('後ろの図'))
        return `![図](${figureRef(`${t.id}-1.svg`)}) を見ます。`
      }],
      ['同じ行に 2 つの画像', (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('一の図'))
        ws.write(figureFile(ws, `${t.id}-2.svg`), svgWith('二の図'))
        return `![図一](${figureRef(`${t.id}-1.svg`)}) ![図二](${figureRef(`${t.id}-2.svg`)})`
      }],
    ])
  })

  /** @covers REQ-512#prefix-outside-image */
  it('前置きを画像の記法の外に含む行（文の中のパス・画像でないリンク）は INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    expectEachStopped('figure-line-prefix-in-text', [
      ['文の中のパス', (_, t) => `図は /figures/materials/ip/${t.id}-1.svg にあります。`],
      ['画像でないリンク', (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('リンクの図'))
        return `[図](${figureRef(`${t.id}-1.svg`)})`
      }],
    ])
  })

  /** @covers REQ-512#empty-caption */
  it('図の説明文が空の画像の行は、指す先が形の内でも INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    expectEachStopped('figure-line-empty-caption', [
      ['説明文が空', (ws, t) => {
        ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('空の図'))
        return `![](${figureRef(`${t.id}-1.svg`)})`
      }],
    ])
  })

  /** @covers REQ-512#all-lines-listed */
  it('形に合わない行が複数の論点の説明と詳しい解説にあれば、全部の行を論点ごとに配る本文に書かれたままで挙げる', () => {
    const { ws, T } = prepared('figure-line-malformed')
    ws.write(`${ws.root}/public/figures/zz-9.svg`, svgWith('外の図'))
    const lines = [
      { t: T(0), line: '![図](/figures/materials/ip/../../zz-9.svg)', where: 'explanation' as const },
      { t: T(1), line: `![図](/figures/materials/IP/${T(0).id}-9.svg)`, where: 'detail' as const },
      { t: T(2), line: `  ![図](/figures/materials/${T(0).id}-9.svg)`, where: 'detail' as const },
    ]
    for (const { t, line, where } of lines) putLine(ws, t, line, where)
    expectStopped(ws, lines.map(({ t, line }) => ({ topic_id: t.id, line })))
  })

  /** @covers REQ-512#previous-generation-body */
  it('全論点を前の世代から選ぶ単元でも、選んだ前の世代の本文に形に合わない行があれば INVALID_INPUT で止め、論点と行を挙げ、何も作らない', () => {
    const ws = makeWorkspace('figure-line-previous')
    const unit = setupPrevious(ws)
    const t = unit.at(5)
    const line = `![図](/figures/materials/IP/${t.id}-9.svg)`
    putLine(ws, t, line, 'detail', unit.genOf(t.id))
    expectStopped(ws, [{ topic_id: t.id, line }])
  })

  /** @covers REQ-512#nothing-created */
  it('止めたとき、呼ぶ前からある空の出力先は空のまま、呼ぶ前に無かった出力先とその親は作らない', () => {
    const cases: [string, (ws: Ws) => void][] = [
      ['呼ぶ前からある空の出力先', (ws) => {
        ws.write(`${OUT}/.keep`, '')
        ws.remove(`${OUT}/.keep`)
      }],
      ['呼ぶ前に無い出力先と親', () => {}],
    ]
    for (const [label, arrange] of cases) {
      const { ws, T } = prepared('figure-line-nothing-created')
      arrange(ws)
      const outBefore = snap(ws, 'readings')
      const t = T(5)
      const line = `![図](/figures/materials/ip/../../zz-9.svg)`
      ws.write(`${ws.root}/public/figures/zz-9.svg`, svgWith('外の図'))
      putLine(ws, t, line)
      expectStopped(ws, [{ topic_id: t.id, line }])
      expect(snap(ws, 'readings'), label).toEqual(outBefore)
    }
  })
})

describe('UC-028 配る本文として選ばれない本文と単元の外の論点の形に合わない行（REQ-512）', () => {
  let ws: Ws
  let r: Run
  let md = ''
  const unselectedLine = '![図](/figures/materials/IP/9001-9.svg)'
  const outsideLine = '![図](/figures/materials/IP/9002-9.svg)'
  beforeAll(() => {
    ws = makeWorkspace('figure-line-not-delivered')
    const unit = setupRewritten(ws)
    const t = unit.at(5)
    const prev = generations(ws).filter((g) => !isRewritten(g))
    putLine(ws, t, unselectedLine, 'detail', prev[prev.length - 1])
    const other = learningOrder(ws.readJson(planFile(ws, OTHER_UNIT)))[0]
    expect(unit.order).not.toContain(other)
    dropEntry(ws, REWRITTEN, other)
    setEntry(ws, REWRITTEN, other, { term: '単元の外の論点', explanation: `単元の外の説明です。\n\n${outsideLine}`, detail: '### 単元の外の見出し\n単元の外の解説です。' })
    r = build(ws, { out: OUT })
    md = ws.exists(READING) ? ws.read(READING) : ''
  })

  /** @covers REQ-512#unselected-body-ignored */
  it('投入が選ばない前の世代の本文にだけ形に合わない行がある論点では止めず、読み物を作り、その行を置かない', () => {
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(md).not.toContain(unselectedLine)
  })

  /** @covers REQ-512#outside-unit-ignored */
  it('単元の外の論点の配る本文にだけ形に合わない行があっても止めず、読み物を作り、その行を置かない', () => {
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(md).not.toContain(outsideLine)
  })
})

describe('UC-028 形に合わない行と隣の失敗の順（REQ-512）', () => {
  /** @covers REQ-512#mixed-before-malformed-line */
  it('世代が混ざり、かつ形に合わない行があるとき、世代が混ざるとして CONFLICT で止める', () => {
    const { ws, unit, T } = prepared('mixed-and-figure-line-malformed')
    const groups = unit.plan.groups as Json[]
    const lastGroup = groups[groups.length - 1].topics as number[]
    const prev = generations(ws).filter((g) => !isRewritten(g))
    for (const id of lastGroup) {
      const t = unit.byId(id)
      dropEntry(ws, REWRITTEN, id)
      setEntry(ws, prev[prev.length - 1], id, { term: t.term, explanation: plainExplanation(t), detail: plainDetail(t) })
    }
    putLine(ws, T(0), `![図](/figures/materials/IP/${T(0).id}-9.svg)`)
    const before = ws.entries('.')
    const r = build(ws, { out: OUT })
    expect(r.status, r.stdout).not.toBe(0)
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe('CONFLICT')
    expect(toolError(r.json)?.reason).toBe(REASON.mixedGenerations)
    expect(((toolError(r.json)?.topics ?? []) as number[]).slice().sort((a, b) => a - b)).toEqual(lastGroup.slice().sort((a, b) => a - b))
    expect(ws.entries('.')).toEqual(before)
  })

  /** @covers REQ-512#malformed-line-before-figure-missing */
  it('形に合わない行があり、かつ図の画像が無いとき、形に合わない行として INVALID_INPUT で止め、その行だけを挙げる', () => {
    const { ws, T } = prepared('figure-line-malformed-and-figure-missing')
    const line = `![図](/figures/materials/IP/${T(0).id}-9.svg)`
    putLine(ws, T(5), line)
    ws.remove(figureFile(ws, `${T(0).id}-2.svg`))
    expectStopped(ws, [{ topic_id: T(5).id, line }])
  })
})
