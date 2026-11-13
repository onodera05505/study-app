/** 教材の図を描く道具（`python3 scripts/render_material_figures.py --data data/<学び> --out <出力先>`）が、箱と矢印の図（blocks）で
 *  名前の無い線があるか名前だけの箱が多すぎる図を描かずに止めてその図と理由を示すこと（REQ-438）と、箱と線が少なすぎる図を
 *  描いたうえで作り手に示すこと（REQ-439）。UC-001
 *
 *  値（名前だけの箱は全ノードの半分まで・少なすぎるのはノード 3 個以下かつ線 2 本以下）の正本は
 *  scripts/prompts/material_figures_spec.md の「図だけで分かること」。仕込みは一時の作業場の data/zz/material_figures/ に
 *  テスト自身が書き、実データは読まない。道具は作業場を cwd にしてコマンドとして呼び、観測するのは終了コード・標準出力と
 *  標準エラー・出力先の SVG だけ。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RENDER = path.join(ROOT, 'scripts', 'render_material_figures.py')
const DATA = 'data/zz'
const OUT = 'out'
const CAPTION = '朱色の目印をたどって北の端から順に読みます。濃い枠が肝心な所です。'

type Json = Record<string, any>

let ws = ''
afterEach(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true })
  ws = ''
})

/** 作業場を作り、論点ごとの図の仕様 JSON を書く。 */
function workspace(files: { topicId: number; term: string; figures: Json[] }[]) {
  if (ws) fs.rmSync(ws, { recursive: true, force: true })
  ws = fs.mkdtempSync(path.join(tmpdir(), 'uc001-blocks-'))
  const dir = path.join(ws, DATA, 'material_figures')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files)
    fs.writeFileSync(
      path.join(dir, `${f.topicId}-${f.term}.json`),
      JSON.stringify({ topic_id: f.topicId, term: f.term, figures: f.figures }, null, 2),
    )
}

function render(extra: string[] = []) {
  const r = spawnSync('python3', [RENDER, '--data', DATA, '--out', OUT, ...extra], { cwd: ws, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`.split(ws).join('<ws>') }
}

const svgPath = (topicId: number, figId: number) => path.join(ws, OUT, `${topicId}-${figId}.svg`)

/** 名前＋一言の 2 行の箱と、名前だけの 1 行の箱。 */
const twoLine = (i: number) => ({ id: `n${i}`, label: `部品${i}\n役目${i}を担う`, row: Math.floor(i / 3), col: i % 3 })
const oneLine = (i: number) => ({ id: `n${i}`, label: `部品${i}`, row: Math.floor(i / 3), col: i % 3 })

/** 線は箱を並べた順に隣どうしを結び、末尾の次は先頭へ戻る。どの線にも label を付ける。 */
function blocks(nodes: Json[], edgeCount: number): Json {
  const ids = nodes.map((n) => n.id)
  const edges: Json[] = []
  for (let i = 0; i < edgeCount; i++) {
    const from = ids[i % ids.length]
    const to = ids[(i + 1) % ids.length]
    edges.push({ from, to, label: `流れ${i}` })
  }
  return { type: 'blocks', nodes, edges }
}

/** 仕様書の決まりに従い、少なすぎもしない箱と矢印の図（2 行の箱 5 個・label 付きの線 4 本）。 */
const big = () => blocks([0, 1, 2, 3, 4].map(twoLine), 4)

const MATRIX: Json = {
  type: 'matrix',
  x: { label: '製品', values: ['既存製品', '新製品'] },
  y: { label: '市場', values: ['既存市場', '新市場'] },
  cells: [
    ['市場浸透\n既存市場で売る', '新製品開発\n既存客に新製品'],
    ['市場開拓\n新市場へ売る', '多角化\n新製品を新市場へ'],
  ],
}

const GOOD_TOPIC = 931
const BAD_TOPIC = 947
const BAD_FIG = 58

/** 決まりに従う図の論点と、調べたい図だけを id 58 として持つ論点を並べて描く。extra は道具に足す引数（--only・--check）。 */
function drawWith(target: Json, extra: string[] = []) {
  workspace([
    { topicId: GOOD_TOPIC, term: '決まりに従う図', figures: [{ id: 1, after: 'explanation', caption: CAPTION, ...big() }] },
    {
      topicId: BAD_TOPIC,
      term: '調べる図',
      figures: [
        { id: 1, after: 'explanation', caption: CAPTION, ...MATRIX },
        { id: BAD_FIG, after: 'explanation', caption: CAPTION, ...target },
      ],
    },
  ])
  return render(extra)
}

function expectStoppedAndShown(r: { status: number | null; out: string }, reason: RegExp, label: string) {
  expect(r.status, `${label} 止まらずに終了 0 で終わった:\n${r.out}`).not.toBe(0)
  expect(fs.existsSync(svgPath(BAD_TOPIC, BAD_FIG)), `${label} 止めるべき図が描かれている`).toBe(false)
  expect(r.out, `${label} どの論点の図かを示していない`).toContain(String(BAD_TOPIC))
  expect(r.out, `${label} どの図かを示していない`).toContain(String(BAD_FIG))
  expect(r.out, `${label} 理由を示していない`).toMatch(reason)
}

/** 線の理由は「線（edge）」、箱の理由は「箱（node）」の語で示す（図の仕様書の語と JSON のキー）。 */
const EDGE_REASON = /線|edge/i
const BOX_REASON = /箱|ノード|node/i

/** 決まりに従う図の線だけを書き換えた図。 */
function withEdge(mutate: (edges: Json[]) => void) {
  const fig = big()
  mutate(fig.edges)
  return fig
}

describe('名前の無い線か名前だけの箱が多すぎる箱と矢印の図は描かずに止める（UC-001）', () => {
  // @covers REQ-438#edge-label-absent
  it('label を持たない線（ふつうの矢印・向きの無い線・自己ループ・null）が 1 本でもあると、止めてその図と線の理由を示す', () => {
    const cases: [string, Json][] = [
      ['ふつうの矢印', withEdge((e) => delete e[1].label)],
      ['向きの無い線', withEdge((e) => { e[1].arrow = 'none'; delete e[1].label })],
      ['破線', withEdge((e) => { e[1].style = 'dashed'; delete e[1].label })],
      ['自己ループ', withEdge((e) => e.push({ from: 'n2', to: 'n2' }))],
      ['label が null', withEdge((e) => { e[1].label = null })],
    ]
    for (const [label, fig] of cases) expectStoppedAndShown(drawWith(fig), EDGE_REASON, label)
  })

  // @covers REQ-438#edge-label-blank
  it('label が空の文字列か空白だけの線があると、止めてその図と線の理由を示す', () => {
    for (const blank of ['', ' ', '　', ' \t\n '])
      expectStoppedAndShown(drawWith(withEdge((e) => { e[1].label = blank })), EDGE_REASON, JSON.stringify(blank))
  })

  // @covers REQ-438#one-line-boxes-over-half
  it('1 行だけ（名前だけ）の箱が全ノードの半分を超えると、止めてその図と箱の理由を示す', () => {
    const cases: [string, Json][] = [
      ['5 個中 3 個', blocks([oneLine(0), oneLine(1), oneLine(2), twoLine(3), twoLine(4)], 4)],
      ['4 個中 3 個', blocks([oneLine(0), oneLine(1), oneLine(2), twoLine(3)], 3)],
      ['3 個中 2 個', blocks([oneLine(0), oneLine(1), twoLine(2)], 3)],
      ['4 個中 4 個', blocks([0, 1, 2, 3].map(oneLine), 3)],
    ]
    for (const [label, fig] of cases) expectStoppedAndShown(drawWith(fig), BOX_REASON, label)
  })

  // @covers REQ-438#one-line-boxes-at-most-half
  it('1 行だけの箱が全ノードのちょうど半分以下で線がどれも label を持つ図は、止めずに描く', () => {
    const cases: [string, Json][] = [
      ['4 個中 2 個', blocks([oneLine(0), oneLine(1), twoLine(2), twoLine(3)], 3)],
      ['6 個中 3 個', blocks([oneLine(0), oneLine(1), oneLine(2), twoLine(3), twoLine(4), twoLine(5)], 5)],
      ['5 個中 2 個', blocks([oneLine(0), oneLine(1), twoLine(2), twoLine(3), twoLine(4)], 4)],
    ]
    for (const [label, fig] of cases) {
      const r = drawWith(fig)
      expect(r.status, `${label} 止まった:\n${r.out}`).toBe(0)
      expect(fs.existsSync(svgPath(BAD_TOPIC, BAD_FIG)), `${label} 図が描かれていない`).toBe(true)
    }
  })
})

/** 調べたい図だけを持つ作業場で描き、その図に触れる出力の行を、少なすぎない図を同じ番号で描いたときの行と比べる。 */
const SMALL_TOPIC = 947
const SMALL_FIG = 58
function drawAlone(fig: Json) {
  workspace([{ topicId: SMALL_TOPIC, term: '箱と線の数を見る図', figures: [{ id: SMALL_FIG, after: 'explanation', caption: CAPTION, ...fig }] }])
  const r = render()
  return { ...r, drawn: fs.existsSync(svgPath(SMALL_TOPIC, SMALL_FIG)) }
}
const lines = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean)
/** 行の形。描いた量（大きさ・数）は図ごとに違って当然なので、数字の並びを伏せて比べる。 */
const shape = (line: string) => line.replace(/\d+/g, '#').replace(/\s+/g, ' ')
/** 基準（少なすぎない図）の出力に同じ形の行が無く、調べたい図の出力にだけ現れる行。 */
function extraLines(fig: Json) {
  const ref = drawAlone(big())
  expect(ref.status, `基準の図が描けない:\n${ref.out}`).toBe(0)
  const target = drawAlone(fig)
  const refShapes = new Set(lines(ref.out).map(shape))
  return { target, extra: lines(target.out).filter((l) => !refShapes.has(shape(l))) }
}

describe('箱と線が少なすぎる箱と矢印の図は描いたうえで作り手に示す（UC-001）', () => {
  // @covers REQ-439#small-drawn-and-shown
  it('ノードが 3 個以下で線が 2 本以下の図は、終了 0 で描かれ、その図を示す行が出る', () => {
    const cases: [string, Json][] = [
      ['3 個・2 本', blocks([0, 1, 2].map(twoLine), 2)],
      ['2 個・1 本', blocks([0, 1].map(twoLine), 1)],
      ['1 個・0 本', blocks([twoLine(0)], 0)],
    ]
    for (const [label, fig] of cases) {
      const { target, extra } = extraLines(fig)
      expect(target.status, `${label} 止まった:\n${target.out}`).toBe(0)
      expect(target.drawn, `${label} 図が描かれていない`).toBe(true)
      expect(extra, `${label} 少なすぎない図と同じ出力で、その図を示していない:\n${target.out}`).not.toEqual([])
      expect(extra.join('\n'), `${label} 示した行がどの図かを持たない`).toContain(String(SMALL_FIG))
      expect(target.out, `${label} どの論点の図かを示していない`).toContain(String(SMALL_TOPIC))
    }
  })

  // @covers REQ-439#nodes-over-limit
  it('線が 2 本以下でもノードが 4 個の図は、描かれ、少なすぎる図として示されない', () => {
    const { target, extra } = extraLines(blocks([0, 1, 2, 3].map(twoLine), 2))
    expect(target.status, target.out).toBe(0)
    expect(target.drawn).toBe(true)
    expect(extra, `ノード 4 個の図を示している:\n${target.out}`).toEqual([])
  })

  // @covers REQ-439#edges-over-limit
  it('ノードが 3 個以下でも線が 3 本の図は、描かれ、少なすぎる図として示されない', () => {
    const { target, extra } = extraLines(blocks([0, 1, 2].map(twoLine), 3))
    expect(target.status, target.out).toBe(0)
    expect(target.drawn).toBe(true)
    expect(extra, `線 3 本の図を示している:\n${target.out}`).toEqual([])
  })
})

/** 門に当たる図（名前の無い線・名前だけの箱が多すぎる）。絞り込みの内と外のどちらに置くかを変えて使う。 */
const gateHits = (): [string, Json][] => [
  ['label の無い線', withEdge((e) => delete e[1].label)],
  ['空白だけの label', withEdge((e) => { e[1].label = '　' })],
  ['名前だけの箱が 5 個中 3 個', blocks([oneLine(0), oneLine(1), oneLine(2), twoLine(3), twoLine(4)], 4)],
]

describe('論点を絞って描くときは絞った論点の図だけを門にかけ、絞り無しの検証は全部の図を門にかける（UC-001）', () => {
  // @covers REQ-438#only-outside-hit-ignored
  it('--only で絞った外の論点に門に当たる図があっても、絞った論点の図は描かれて終了 0 で終わる', () => {
    for (const [label, fig] of gateHits()) {
      const r = drawWith(fig, ['--only', String(GOOD_TOPIC)])
      expect(r.status, `${label} 絞った外の図で止まった:\n${r.out}`).toBe(0)
      expect(fs.existsSync(svgPath(GOOD_TOPIC, 1)), `${label} 絞った論点の図が描かれていない`).toBe(true)
      expect(fs.existsSync(svgPath(BAD_TOPIC, BAD_FIG)), `${label} 門に当たる図が描かれている`).toBe(false)
    }
  })

  // @covers REQ-438#only-inside-hit-stops
  it('--only で絞った論点に門に当たる図があれば、その図を描かずに止めてその図と理由を示す', () => {
    const reasons = [EDGE_REASON, EDGE_REASON, BOX_REASON]
    gateHits().forEach(([label, fig], i) => {
      expectStoppedAndShown(drawWith(fig, ['--only', String(BAD_TOPIC)]), reasons[i], `${label}（その論点だけに絞る）`)
      expectStoppedAndShown(
        drawWith(fig, ['--only', String(GOOD_TOPIC), String(BAD_TOPIC)]),
        reasons[i],
        `${label}（決まりに従う論点と並べて絞る）`,
      )
    })
  })

  // @covers REQ-438#check-unscoped-judges-all
  it('--check を絞り無しで回すと、どの論点にある門に当たる図も示して終了 0 で終わらない', () => {
    const reasons = [EDGE_REASON, EDGE_REASON, BOX_REASON]
    gateHits().forEach(([label, fig], i) => {
      const r = drawWith(fig, ['--check'])
      expect(r.status, `${label} 終了 0 で終わった:\n${r.out}`).not.toBe(0)
      expect(r.out, `${label} どの論点の図かを示していない`).toContain(String(BAD_TOPIC))
      expect(r.out, `${label} どの図かを示していない`).toContain(String(BAD_FIG))
      expect(r.out, `${label} 理由を示していない`).toMatch(reasons[i])
    })
  })
})
