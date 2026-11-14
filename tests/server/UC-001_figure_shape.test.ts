/** 教材の図を描く道具（`python3 scripts/render_material_figures.py --data data/<学び> --out <出力先>`）が、図の型ごとの形
 *  （型そのもの・項目の数・項目の名前の欠けと行数・項目／括弧／出来事／領域／絵記号の置き方・決められた語から選ぶ値）が
 *  図の仕様書に合わない図を描かずに止め、その図と理由を示すこと（REQ-440）。UC-001
 *
 *  形の正本は scripts/prompts/material_figures_spec.md の「`--check` が見ること（型の中身の門）」の表と、各型の節。
 *  仕込みは一時の作業場の data/zz/material_figures/ にテスト自身が書き、実データは読まない。道具は作業場を cwd にして
 *  コマンドとして呼び、観測するのは終了コード・標準出力と標準エラー・出力先の SVG だけ。どの図も、調べたい 1 つの形のほかは
 *  決まりに従う（説明文あり・項目は名前＋一言の 2 行・線と段の間の矢印に名前）。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 120_000 })

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

function workspace(files: { topicId: number; term: string; figures: Json[] }[]) {
  if (ws) fs.rmSync(ws, { recursive: true, force: true })
  ws = fs.mkdtempSync(path.join(tmpdir(), 'uc001-shape-'))
  const dir = path.join(ws, DATA, 'material_figures')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files)
    fs.writeFileSync(
      path.join(dir, `${f.topicId}-${f.term}.json`),
      JSON.stringify({ topic_id: f.topicId, term: f.term, figures: f.figures }, null, 2),
    )
}

function render() {
  const r = spawnSync('python3', [RENDER, '--data', DATA, '--out', OUT], { cwd: ws, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`.split(ws).join('<ws>') }
}

const svgPath = (topicId: number, figId: number) => path.join(ws, OUT, `${topicId}-${figId}.svg`)

/** 名前＋一言の 2 行の label。 */
const two = (kind: string, i: number) => `${kind}${i}\n役目${i}を担う`
const labels = (kind: string, n: number) => Array.from({ length: n }, (_, i) => two(kind, i))

/** 箱と矢印。2 行の箱 5 個・label 付きの線 4 本（REQ-439 の少なさにも当たらない）。 */
function blocks(): Json {
  const nodes = [0, 1, 2, 3, 4].map((i) => ({ id: `n${i}`, label: two('部品', i), row: Math.floor(i / 3), col: i % 3 }))
  const edges = [0, 1, 2, 3].map((i) => ({ from: `n${i}`, to: `n${i + 1}`, label: `流れ${i}` }))
  return { type: 'blocks', nodes, edges }
}

const ACTOR_NAMES = ['クライアント', 'サーバ', '認証局', '利用者', '監査役']
/** 手順・やり取り。登場人物 n 人・手順 4 つ（隣の登場人物へ順に渡す。1 人なら自分への処理）。 */
function sequence(n = 2): Json {
  const ids = ACTOR_NAMES.slice(0, n).map((_, i) => `a${i}`)
  return {
    type: 'sequence',
    actors: ids.map((id, i) => ({ id, label: ACTOR_NAMES[i] })),
    steps: [0, 1, 2, 3].map((i) => ({ from: ids[i % n], to: ids[(i + 1) % n], label: `やり取り${i}` })),
  }
}

/** 数値のグラフ。系列 n 本・x.values m 個。bar はカテゴリの軸。 */
function chart(n = 2, kind = 'line', m = 4): Json {
  const idx = Array.from({ length: m }, (_, j) => j)
  const values = kind === 'bar' ? idx.map((j) => `区分${j}`) : idx.map((j) => 200 * j)
  return {
    type: 'chart',
    kind,
    x: { label: '売上高（万円）', values },
    y: { label: '金額（万円）', min: 0 },
    series: Array.from({ length: n }, (_, i) => ({ label: `系列${i}`, values: idx.map((j) => 100 * (i + 1) + 50 * j) })),
  }
}

/** 2 軸の分類。y が r 行・x が c 列。 */
function matrix(r: number, c: number): Json {
  return {
    type: 'matrix',
    x: { label: '製品', values: Array.from({ length: c }, (_, j) => `製品${j}`) },
    y: { label: '市場', values: Array.from({ length: r }, (_, i) => `市場${i}`) },
    cells: Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => `区分${i}${j}\n一言${i}${j}`)),
  }
}

/** 段階図。最後の段以外に next_label を付ける。 */
function steps(n = 5): Json {
  return {
    type: 'steps',
    direction: 'down',
    stages: labels('工程', n).map((label, i) => (i < n - 1 ? { label, next_label: `成果物${i}` } : { label })),
  }
}

/** 循環。全段に next_label を付ける。 */
function cycle(n = 4): Json {
  return { type: 'cycle', stages: labels('段', n).map((label, i) => ({ label, next_label: `渡す物${i}` })) }
}

/** 層。2 層以上なら、重ならない 2 つの括弧を置く。 */
function layers(n = 5): Json {
  return {
    type: 'layers',
    shape: 'stack',
    layers: labels('層', n).map((label) => ({ label })),
    ...(n >= 2
      ? {
          brackets: [
            { from: 0, to: 0, label: '端末の中で\n処理する' },
            { from: 1, to: n - 1, label: '経路の機器も\n処理する' },
          ],
        }
      : {}),
  }
}

/** 分解図。 */
function parts(n = 4): Json {
  return { type: 'parts', whole: { label: '装置' }, parts: labels('部位', n).map((label) => ({ label })) }
}

/** 時間軸。出来事 n 個・目盛り m 個。最初の出来事は軸の全体の期間、他は軸の上の点。 */
function timeline(n = 4, m = 6): Json {
  const last = m - 1
  const events = labels('時期', n).map((label, i) => (i === 0 ? { from: 0, to: last, label } : { at: (last * i) / n, label }))
  return {
    type: 'timeline',
    axis: { label: '発売からの時間（例）', ticks: Array.from({ length: m }, (_, i) => `${i} 年`) },
    events,
  }
}

const SET_IDS = ['a', 'b', 'c', 'd']
/** 空でない組み合わせ全部（overlap の領域）。 */
function combos(ids: string[]): string[][] {
  const out: string[][] = []
  for (let mask = 1; mask < 1 << ids.length; mask++) out.push(ids.filter((_, i) => mask & (1 << i)))
  return out
}
/** 包含。範囲 k 個。overlap は空でない組み合わせ全部、nested は外から順の先頭の並び全部を領域にする。 */
function venn(k = 2, layout: 'overlap' | 'nested' = 'overlap', universe = false): Json {
  const ids = SET_IDS.slice(0, k)
  const ins = layout === 'overlap' ? combos(ids) : ids.map((_, i) => ids.slice(0, i + 1))
  if (universe) ins.push([])
  return {
    type: 'venn',
    layout,
    ...(universe ? { universe: '社内システムの全権限' } : {}),
    sets: ids.map((id) => ({ id, label: `範囲${id}` })),
    regions: ins.map((inSets, i) => ({ in: inSets, label: two('領域', i) })),
  }
}

/** 図を書き換えて返す。 */
function edit(fig: Json, mutate: (f: Json) => void) {
  mutate(fig)
  return fig
}

const GOOD_TOPIC = 931
const BAD_TOPIC = 947
const BAD_FIG = 58

/** 決まりに従う図の論点と、調べたい図だけを id 58 として持つ論点を並べて描く。 */
function drawWith(target: Json) {
  workspace([
    { topicId: GOOD_TOPIC, term: '決まりに従う図', figures: [{ id: 1, after: 'explanation', caption: CAPTION, ...blocks() }] },
    {
      topicId: BAD_TOPIC,
      term: '調べる図',
      figures: [
        { id: 1, after: 'explanation', caption: CAPTION, ...matrix(2, 2) },
        { id: BAD_FIG, after: 'explanation', caption: CAPTION, ...target },
      ],
    },
  ])
  return render()
}

/** 終了 0 でなく、その図を描かず、その論点と図の番号を示し、理由の語（どれも）を示す。 */
function expectStopped(target: Json, reasons: RegExp[], label: string) {
  expectStoppedRun(drawWith(target), reasons, label)
}

/** 描いた結果が、論点 BAD_TOPIC の図 BAD_FIG を描かずに止め、その図と理由を示したこと。 */
function expectStoppedRun(r: { status: number | null; out: string }, reasons: RegExp[], label: string) {
  expect(r.status, `${label} 止まらずに終了 0 で終わった:\n${r.out}`).not.toBe(0)
  expect(fs.existsSync(svgPath(BAD_TOPIC, BAD_FIG)), `${label} 止めるべき図が描かれている`).toBe(false)
  expect(r.out, `${label} どの論点の図かを示していない`).toContain(String(BAD_TOPIC))
  expect(r.out, `${label} どの図かを示していない`).toContain(String(BAD_FIG))
  for (const reason of reasons) expect(r.out, `${label} 理由を示していない（${reason}）`).toMatch(reason)
}

/** 決まりに従う形の図を 1 つの論点に並べて描き、どれも描かれて終了 0 で終わる。 */
function expectDrawn(targets: [string, Json][]) {
  workspace([
    {
      topicId: BAD_TOPIC,
      term: '調べる図',
      figures: targets.map(([, fig], i) => ({ id: i + 1, after: 'explanation', caption: CAPTION, ...fig })),
    },
  ])
  const r = render()
  expect(r.status, `止まった:\n${r.out}`).toBe(0)
  targets.forEach(([label], i) => expect(fs.existsSync(svgPath(BAD_TOPIC, i + 1)), `${label} が描かれていない:\n${r.out}`).toBe(true))
}

/** 項目の理由は型ごとの項目の語（仕様書の語）か配列名（JSON のキー）で示す。 */
const ITEM: Record<string, RegExp> = {
  steps: /段|stages/,
  cycle: /段|stages/,
  layers: /層|layers/,
  parts: /部位|parts/,
  timeline: /出来事|events/,
  venn: /領域|regions/,
}
/** 型ごとの項目の配列の名前と、決まりに従う図。 */
const ITEM_TYPES: [string, string, () => Json][] = [
  ['steps', 'stages', () => steps(5)],
  ['cycle', 'stages', () => cycle(5)],
  ['layers', 'layers', () => layers(5)],
  ['parts', 'parts', () => parts(5)],
  ['timeline', 'events', () => timeline(5)],
  ['venn', 'regions', () => venn(2, 'overlap', true)],
]

describe('型ごとの形が図の仕様書に合わない図は描かずに止め、その図と理由を示す（UC-001）', () => {
  // @covers REQ-440#type-unknown
  it('type が 10 の型のどれでもない図は、止めてその図と type の理由を示す', () => {
    const cases: [string, Json][] = [
      ['仕様書に無い型の名前', { ...blocks(), type: 'flowchart' }],
      ['大文字の混ざった型の名前', { ...blocks(), type: 'Blocks' }],
      ['空の文字列', { ...blocks(), type: '' }],
      ['null', { ...blocks(), type: null }],
      ['type の欄が無い', edit(blocks(), (f) => delete f.type)],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/type|型/], label)
  })

  // @covers REQ-440#figure-id-duplicate
  it('同じファイルの figures[].id が重複する図は、止めてその図と id の重複の理由を示す', () => {
    const cases: [string, Json, Json][] = [
      ['同じ型どうし', blocks(), blocks()],
      ['違う型どうし', blocks(), steps()],
    ]
    for (const [label, first, second] of cases) {
      workspace([
        { topicId: GOOD_TOPIC, term: '決まりに従う図', figures: [{ id: 1, after: 'explanation', caption: CAPTION, ...blocks() }] },
        {
          topicId: BAD_TOPIC,
          term: '調べる図',
          figures: [
            { id: 1, after: 'explanation', caption: CAPTION, ...matrix(2, 2) },
            { id: BAD_FIG, after: 'explanation', caption: CAPTION, ...first },
            { id: BAD_FIG, after: 'explanation', caption: CAPTION, ...second },
          ],
        },
      ])
      expectStoppedRun(render(), [/figures|id/, /重複|一意/], label)
    }
  })

  // @covers REQ-440#actor-count-outside
  it('sequence の登場人物が 2〜4 の外の図は、止めてその図と登場人物の理由を示す', () => {
    for (const n of [1, 5]) expectStopped(sequence(n), [/登場人物|actors/], `登場人物 ${n} 人`)
  })

  // @covers REQ-440#actor-count-inside
  it('登場人物が 2 人と 4 人の sequence の図は、止めずに描く', () => {
    expectDrawn([
      ['登場人物 2 人', sequence(2)],
      ['登場人物 4 人', sequence(4)],
    ])
  })

  // @covers REQ-440#actor-id-duplicate
  it('sequence の actors に同じ id が 2 つ以上ある図は、止めてその図と、その id を示す', () => {
    const fig = edit(sequence(2), (f) => { f.actors.push({ id: 'a1', label: '認証局' }) })
    expectStopped(fig, [/actors|登場人物/, /重複|一意/, /a1/], '登場人物の id a1 が 2 つ')
  })

  // @covers REQ-440#series-absent
  it('chart の系列が 0 本の図は、止めてその図と系列の理由を示す', () => {
    expectStopped(chart(0), [/系列|series/], '系列 0 本')
  })

  // @covers REQ-440#x-values-too-few
  it('chart の x.values が 2 つ未満の図は、止めてその図と x.values の理由を示す', () => {
    for (const kind of ['line', 'bar'])
      for (const m of [0, 1]) expectStopped(chart(2, kind, m), [/values|横軸/], `${kind} の x.values ${m} 個`)
  })

  // @covers REQ-440#x-values-at-least-two
  it('chart の x.values がちょうど 2 つの図は、止めずに描く', () => {
    expectDrawn([
      ['line の x.values 2 個', chart(2, 'line', 2)],
      ['bar の x.values 2 個', chart(2, 'bar', 2)],
    ])
  })

  // @covers REQ-440#series-over-limit
  it('chart の系列が 4 本以上の図は、止めてその図と系列の理由を示す', () => {
    for (const n of [4, 5]) expectStopped(chart(n), [/系列|series/], `系列 ${n} 本`)
  })

  // @covers REQ-440#series-at-limit
  it('chart の系列が 3 本までの図は、止めずに描く', () => {
    expectDrawn([
      ['系列 1 本', chart(1)],
      ['系列 3 本', chart(3)],
    ])
  })

  // @covers REQ-440#item-count-below
  it('項目の数が型ごとの下限より 1 つ少ない図は、止めてその図と項目の理由を示す', () => {
    const cases: [string, Json, RegExp][] = [
      ['段階図の段 2', steps(2), ITEM.steps],
      ['循環の段 2', cycle(2), ITEM.cycle],
      ['層 1', layers(1), ITEM.layers],
      ['部位 2', parts(2), ITEM.parts],
      ['出来事 2', timeline(2), ITEM.timeline],
      ['目盛り 1', edit(timeline(3, 2), (f) => { f.axis.ticks = ['0 年']; f.events = labels('時期', 3).map((label) => ({ at: 0, label })) }), /ticks|目盛り/],
      ['範囲 1', venn(1), /範囲|sets/],
    ]
    for (const [label, fig, reason] of cases) expectStopped(fig, [reason], label)
  })

  // @covers REQ-440#item-count-above
  it('項目の数が型ごとの上限より 1 つ多い図は、止めてその図と項目の理由を示す', () => {
    const cases: [string, Json, RegExp][] = [
      ['段階図の段 7', steps(7), ITEM.steps],
      ['循環の段 7', cycle(7), ITEM.cycle],
      ['層 8', layers(8), ITEM.layers],
      ['部位 9', parts(9), ITEM.parts],
      ['出来事 9', timeline(9), ITEM.timeline],
      ['目盛り 13', timeline(4, 13), /ticks|目盛り/],
      ['範囲 4', venn(4), /範囲|sets/],
    ]
    for (const [label, fig, reason] of cases) expectStopped(fig, [reason], label)
  })

  // @covers REQ-440#item-count-at-bounds
  it('項目の数が型ごとの下限と上限ちょうどの図は、止めずに描く', () => {
    expectDrawn([
      ['段階図の段 3', steps(3)],
      ['段階図の段 6', steps(6)],
      ['循環の段 3', cycle(3)],
      ['循環の段 6', cycle(6)],
      ['層 2', layers(2)],
      ['層 7', layers(7)],
      ['部位 3', parts(3)],
      ['部位 8', parts(8)],
      ['出来事 3', timeline(3)],
      ['出来事 8', timeline(8)],
      ['目盛り 2', timeline(3, 2)],
      ['目盛り 12', timeline(3, 12)],
      ['範囲 2', venn(2)],
      ['範囲 3', venn(3)],
    ])
  })

  // @covers REQ-440#matrix-size-outside
  it('2 軸の分類の行か列が 2〜3 の外の図は、止めてその図と大きさの理由を示す', () => {
    const cases: [string, Json][] = [
      ['1 行 2 列', matrix(1, 2)],
      ['2 行 1 列', matrix(2, 1)],
      ['4 行 2 列', matrix(4, 2)],
      ['2 行 4 列', matrix(2, 4)],
      ['4 行 4 列', matrix(4, 4)],
      ['3 行 4 列', matrix(3, 4)],
      ['4 行 3 列', matrix(4, 3)],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/matrix|cells|行|列|×/], label)
  })

  // @covers REQ-440#matrix-size-inside
  it('2 軸の分類が 2×2・2×3・3×2・3×3 の図は、止めずに描く', () => {
    expectDrawn([
      ['2×2', matrix(2, 2)],
      ['2 行 3 列', matrix(2, 3)],
      ['3 行 2 列', matrix(3, 2)],
      ['3×3', matrix(3, 3)],
    ])
  })

  // @covers REQ-440#item-label-absent
  it('項目の label が無い・null・空・空白だけの段・層・部位・出来事・領域がある図は、止めてその図と label の理由を示す', () => {
    const variants: [string, (item: Json) => void][] = [
      ['label の欄が無い', (item) => delete item.label],
      ['null', (item) => { item.label = null }],
      ['空の文字列', (item) => { item.label = '' }],
      ['空白だけ', (item) => { item.label = ' 　\t\n ' }],
    ]
    for (const [type, key, make] of ITEM_TYPES)
      for (const [vlabel, mutate] of variants)
        expectStopped(edit(make(), (f) => mutate(f[key][1])), [/label|名前/, ITEM[type]], `${type} ${vlabel}`)
  })

  // @covers REQ-440#item-label-four-lines
  it('項目の label が 4 行以上の図は、止めてその図と行の理由を示す', () => {
    for (const [type, key, make] of ITEM_TYPES)
      for (const text of ['名前\n一言の\n続きの\n4 行目', '名前\n一言の\n続きの\n4 行目\n5 行目'])
        expectStopped(edit(make(), (f) => { f[key][1].label = text }), [/行|line/, ITEM[type]], `${type} ${text.split('\n').length} 行`)
  })

  // @covers REQ-440#item-label-three-lines
  it('項目の label がちょうど 3 行の図は、止めずに描く', () => {
    expectDrawn(ITEM_TYPES.map(([type, key, make]) => [type, edit(make(), (f) => { f[key][1].label = '名前\n一言の\n続き' })]))
  })

  /** 名前の欄の欠け方（欄が無い・null・空・空白だけ）。 */
  const ABSENT: [string, (o: Json, key: string) => void][] = [
    ['欄が無い', (o, key) => delete o[key]],
    ['null', (o, key) => { o[key] = null }],
    ['空の文字列', (o, key) => { o[key] = '' }],
    ['空白だけ', (o, key) => { o[key] = ' 　\t ' }],
  ]

  // @covers REQ-440#axis-label-absent
  it('timeline の axis.label が無い・null・空・空白だけの図は、止めてその図と軸の理由を示す', () => {
    for (const [label, mutate] of ABSENT)
      expectStopped(edit(timeline(), (f) => mutate(f.axis, 'label')), [/axis|軸/, /label|名前/], `axis.label ${label}`)
  })

  // @covers REQ-440#y-label-absent
  it('chart の y.label が無い・null・空・空白だけか y の欄が無い図は、止めてその図と y の理由を示す', () => {
    for (const [label, mutate] of ABSENT)
      expectStopped(edit(chart(), (f) => mutate(f.y, 'label')), [/\by\b|縦軸/, /label|名前/], `y.label ${label}`)
    expectStopped(edit(chart(), (f) => delete f.y), [/\by\b|縦軸/], 'y の欄が無い')
  })

  // @covers REQ-440#steps-last-next-label
  it('段階図の最後の段に中身のある next_label がある図は、止めてその図と最後の段の理由を示す', () => {
    for (const n of [3, 4, 6])
      expectStopped(
        edit(steps(n), (f) => { f.stages[n - 1].next_label = '確かめた製品' }),
        [/next_label|最後/],
        `段 ${n} の最後`,
      )
    expectStopped(edit(steps(5), (f) => { f.stages[4].next_label = ' 　確かめた製品\t' }), [/next_label|最後/], '空白に囲まれた中身')
  })

  // @covers REQ-440#steps-last-next-label-empty
  it('段階図の最後の段の next_label が空・空白だけ・null の図は、無いのと同じに扱って止めずに描く', () => {
    expectDrawn(
      ([['空の文字列', ''], ['半角の空白だけ', '   '], ['全角の空白とタブだけ', '　\t　'], ['null', null]] as [string, unknown][]).map(
        ([label, value]) => [label, edit(steps(5), (f) => { f.stages[4].next_label = value })] as [string, Json],
      ),
    )
  })

  // @covers REQ-440#word-unknown
  it('段階図の direction・層の shape・包含の layout が決められた語でない図は、止めてその図とその鍵の理由を示す', () => {
    const cases: [string, Json, RegExp][] = [
      ['direction が仕様書に無い語', { ...steps(), direction: 'left' }, /direction|向き/],
      ['direction が大文字の混ざった語', { ...steps(), direction: 'Down' }, /direction|向き/],
      ['direction が空の文字列', { ...steps(), direction: '' }, /direction|向き/],
      ['direction の欄が無い', edit(steps(), (f) => delete f.direction), /direction|向き/],
      ['shape が仕様書に無い語', { ...layers(), shape: 'circle' }, /shape|形/],
      ['shape が大文字の混ざった語', { ...layers(), shape: 'Stack' }, /shape|形/],
      ['shape が空の文字列', { ...layers(), shape: '' }, /shape|形/],
      ['layout が仕様書に無い語', { ...venn(), layout: 'nest' }, /layout/],
      ['layout が大文字の混ざった語', { ...venn(), layout: 'Overlap' }, /layout/],
      ['layout が空の文字列', { ...venn(), layout: '' }, /layout/],
      ['layout の欄が無い', edit(venn(), (f) => delete f.layout), /layout/],
      ['箱の shape が仕様書に無い語', edit(blocks(), (f) => { f.nodes[1].shape = 'hexagon' }), /shape|形/],
      ['箱の shape が大文字の混ざった語', edit(blocks(), (f) => { f.nodes[1].shape = 'Cylinder' }), /shape|形/],
      ['箱の shape が空の文字列', edit(blocks(), (f) => { f.nodes[1].shape = '' }), /shape|形/],
      ['線の style が仕様書に無い語', edit(blocks(), (f) => { f.edges[1].style = 'dotted' }), /style/],
      ['線の style が大文字の混ざった語', edit(blocks(), (f) => { f.edges[1].style = 'Dashed' }), /style/],
      ['線の style が空の文字列', edit(blocks(), (f) => { f.edges[1].style = '' }), /style/],
      ['線の arrow が仕様書に無い語', edit(blocks(), (f) => { f.edges[1].arrow = 'back' }), /arrow|矢印/],
      ['線の arrow が大文字の混ざった語', edit(blocks(), (f) => { f.edges[1].arrow = 'Both' }), /arrow|矢印/],
      ['線の arrow が空の文字列', edit(blocks(), (f) => { f.edges[1].arrow = '' }), /arrow|矢印/],
      ['kind が仕様書に無い語', { ...chart(), kind: 'pie' }, /kind/],
      ['kind が大文字の混ざった語', { ...chart(), kind: 'Line' }, /kind/],
      ['kind が空の文字列', { ...chart(), kind: '' }, /kind/],
      ['kind の欄が無い', edit(chart(), (f) => delete f.kind), /kind/],
    ]
    for (const [label, fig, reason] of cases) expectStopped(fig, [reason], label)
  })

  // @covers REQ-440#word-allowed
  it('direction・shape・layout が決められた語のどれか（shape は省略も）の図は、止めずに描く', () => {
    expectDrawn([
      ['direction up', { ...steps(), direction: 'up' }],
      ['direction down', { ...steps(), direction: 'down' }],
      ['shape stack', { ...layers(), shape: 'stack' }],
      ['shape pyramid', { ...layers(), shape: 'pyramid' }],
      ['shape の省略', edit(layers(), (f) => delete f.shape)],
      ['layout overlap', venn(2, 'overlap')],
      ['layout nested', venn(3, 'nested')],
      ...(['box', 'round', 'cylinder', 'cloud'].map((w) => [`箱の shape ${w}`, edit(blocks(), (f) => { f.nodes[1].shape = w })]) as [string, Json][]),
      ['箱の shape の省略', blocks()],
      ...(['solid', 'dashed'].map((w) => [`線の style ${w}`, edit(blocks(), (f) => { f.edges[1].style = w })]) as [string, Json][]),
      ...(['to', 'both', 'none'].map((w) => [`線の arrow ${w}`, edit(blocks(), (f) => { f.edges[1].arrow = w })]) as [string, Json][]),
      ['線の style と arrow の省略', blocks()],
      ...(['line', 'bar', 'step'].map((w) => [`kind ${w}`, chart(2, w)]) as [string, Json][]),
    ])
  })

  // @covers REQ-440#node-id-duplicate
  it('blocks の nodes[] に同じ id が 2 つ以上ある図は、止めてその図と、その id を示す', () => {
    const cases: [string, Json][] = [
      ['線を持たない箱が他の箱の id を使う', edit(blocks(), (f) => { f.nodes.push({ id: 'n2', label: two('部品', 9), row: 1, col: 2 }) })],
      ['線の端の箱の id を 2 つの箱が持つ', edit(blocks(), (f) => { f.nodes.push({ id: 'n0', label: two('部品', 9), row: 2, col: 0 }) })],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/nodes|箱/, /重複|一意/, /n[02]/], label)
  })

  // @covers REQ-440#edge-endpoint-unknown
  it('線の from か to が nodes に無い id を指す図は、止めてその図と、その id を示す', () => {
    const cases: [string, Json][] = [
      ['from が無い id', edit(blocks(), (f) => { f.edges[1].from = 'zq9' })],
      ['to が無い id', edit(blocks(), (f) => { f.edges[1].to = 'zq9' })],
      ['両端が無い id の自分への矢印', edit(blocks(), (f) => { f.edges.push({ from: 'zq9', to: 'zq9', label: '流れ9' }) })],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/edges|線/, /zq9/], label)
  })

  // @covers REQ-440#bracket-range-invalid
  it('層の括弧の範囲が from > to か層の位置の外の図は、止めてその図と括弧の理由を示す', () => {
    const cases: [string, Json[]][] = [
      ['from > to', [{ from: 2, to: 1, label: '括弧\nの注記' }]],
      ['to が層の数と同じ', [{ from: 0, to: 5, label: '括弧\nの注記' }]],
      ['from が負', [{ from: -1, to: 0, label: '括弧\nの注記' }]],
      ['from も to も層の外', [{ from: 5, to: 5, label: '括弧\nの注記' }]],
    ]
    for (const [label, brackets] of cases) expectStopped({ ...layers(5), brackets }, [/brackets|括弧/], label)
  })

  // @covers REQ-440#bracket-overlap
  it('層の括弧どうしの範囲が重なる図は、止めてその図と括弧の理由を示す', () => {
    const b = (from: number, to: number) => ({ from, to, label: '括弧\nの注記' })
    const cases: [string, Json[]][] = [
      ['端の 1 層を共有する', [b(0, 2), b(2, 4)]],
      ['一方が他方を含む', [b(0, 3), b(1, 2)]],
      ['同じ範囲', [b(1, 1), b(1, 1)]],
    ]
    for (const [label, brackets] of cases) expectStopped({ ...layers(5), brackets }, [/brackets|括弧/], label)
  })

  // @covers REQ-440#bracket-label-absent
  it('層の括弧に label が無い図は、止めてその図と括弧の理由を示す', () => {
    const cases: [string, Json][] = [
      ['label の欄が無い', { from: 1, to: 4 }],
      ['label が null', { from: 1, to: 4, label: null }],
    ]
    for (const [label, bracket] of cases)
      expectStopped({ ...layers(5), brackets: [{ from: 0, to: 0, label: '端末の中で\n処理する' }, bracket] }, [/brackets|括弧/, /label|名前/], label)
  })

  // @covers REQ-440#bracket-valid
  it('層の括弧が層の位置の内で from ≤ to、重ならず label を持つ図（括弧無しも）は、止めずに描く', () => {
    const b = (from: number, to: number) => ({ from, to, label: '括弧\nの注記' })
    expectDrawn([
      ['隣り合う 2 つ', { ...layers(5), brackets: [b(0, 1), b(2, 4)] }],
      ['1 層だけの括弧を 3 つ', { ...layers(5), brackets: [b(0, 0), b(1, 1), b(4, 4)] }],
      ['全部の層を 1 つで', { ...layers(5), brackets: [b(0, 4)] }],
      ['括弧無し', edit(layers(5), (f) => delete f.brackets)],
    ])
  })

  // @covers REQ-440#whole-label-absent
  it('分解図の whole か whole の label が無い図は、止めてその図と分解する物の理由を示す', () => {
    const cases: [string, Json][] = [
      ['whole の欄が無い', edit(parts(), (f) => delete f.whole)],
      ['whole が空のオブジェクト', { ...parts(), whole: {} }],
      ['whole に icon だけ', { ...parts(), whole: { icon: 'gear' } }],
      ['whole の label が null', { ...parts(), whole: { label: null } }],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/whole|物/], label)
  })

  // @covers REQ-440#event-not-point-nor-period
  it('時間軸の出来事が点（at）でも期間（from と to）でもないか両方を持つ図は、止めてその図と出来事の理由を示す', () => {
    const variants: [string, Json][] = [
      ['位置を持たない', {}],
      ['at と from／to の両方', { at: 1, from: 0, to: 2 }],
      ['at と from', { at: 1, from: 0 }],
      ['from だけ', { from: 1 }],
      ['to だけ', { to: 2 }],
    ]
    for (const [label, pos] of variants)
      expectStopped(edit(timeline(4), (f) => { f.events[2] = { label: two('時期', 2), ...pos } }), [ITEM.timeline], label)
  })

  // @covers REQ-440#event-position-out-of-range
  it('時間軸の出来事の位置が 0〜目盛りの個数 −1 の外か、期間が from ≥ to の図は、止めてその図と出来事の理由を示す', () => {
    const variants: [string, Json][] = [
      ['点が負', { at: -0.5 }],
      ['点が最後の目盛りを超える（小数）', { at: 5.5 }],
      ['点が目盛りの個数と同じ', { at: 6 }],
      ['期間の from が負', { from: -1, to: 1 }],
      ['期間の to が最後の目盛りを超える', { from: 4, to: 5.5 }],
      ['期間が from = to', { from: 2, to: 2 }],
      ['期間が from > to', { from: 3, to: 2 }],
    ]
    for (const [label, pos] of variants)
      expectStopped(edit(timeline(4, 6), (f) => { f.events[2] = { label: two('時期', 2), ...pos } }), [ITEM.timeline], label)
  })

  // @covers REQ-440#event-position-in-range
  it('時間軸の出来事が点か期間の一方だけを持ち、位置が目盛りの範囲の内（両端と小数）の図は、止めずに描く', () => {
    const at = (pos: Json, i: number) => ({ label: two('時期', i), ...pos })
    expectDrawn([
      [
        '両端の点・小数の点・全体の期間・小数の期間',
        {
          type: 'timeline',
          axis: { label: '発売からの時間（例）', ticks: ['0 年', '1 年', '2 年', '3 年', '4 年', '5 年'] },
          events: [at({ from: 0, to: 5 }, 0), at({ at: 0 }, 1), at({ at: 5 }, 2), at({ at: 2.5 }, 3), at({ from: 1.5, to: 2 }, 4)],
        },
      ],
    ])
  })

  // @covers REQ-440#sets-id-duplicate
  it('venn の sets に同じ id が 2 つ以上ある図は、止めてその図と、その id を示す', () => {
    const fig = edit(venn(2), (f) => {
      f.sets = [{ id: 'a', label: '範囲a' }, { id: 'kq', label: '範囲kq' }, { id: 'kq', label: '範囲kq2' }]
      f.regions = [['a'], ['kq'], ['a', 'kq']].map((inSets, i) => ({ in: inSets, label: two('領域', i) }))
    })
    expectStopped(fig, [/sets|範囲/, /重複|一意/, /kq/], '範囲の id kq が 2 つ')
  })

  // @covers REQ-440#venn-in-duplicate-id
  it('1 つの regions[i].in に同じ id が 2 回ある図は、止めてその図と in の理由を示す', () => {
    const cases: [string, Json][] = [
      ['単独の領域に同じ id', edit(venn(2), (f) => { f.regions[0].in = ['a', 'a'] })],
      ['重なりの領域に同じ id', edit(venn(2), (f) => { f.regions[2].in = ['a', 'b', 'b'] })],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/\bin\b/, /同じ id|重複|1 回ずつ/], label)
  })

  // @covers REQ-440#venn-in-unknown-set
  it('包含の領域の in が sets に無い id を含む図は、止めてその図と、その id を示す', () => {
    const cases: [string, Json][] = [
      ['重なりの領域に無い id', edit(venn(2), (f) => { f.regions[2].in = ['a', 'kq'] })],
      ['単独の領域が無い id', edit(venn(2), (f) => { f.regions.push({ in: ['kq'], label: two('領域', 9) }) })],
      ['入れ子の領域に無い id', edit(venn(2, 'nested'), (f) => { f.regions[1].in = ['a', 'kq'] })],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [ITEM.venn, /kq/], label)
  })

  // @covers REQ-440#venn-regions-mismatch
  it('包含の領域が layout に合わない（欠け・重複・置けない並び・universe 無しの in: []）図は、止めてその図と領域の理由を示す', () => {
    const region = (inSets: string[], i: number) => ({ in: inSets, label: two('領域', i) })
    const cases: [string, Json][] = [
      ['重なり 2 範囲で重なりの領域の欠け', edit(venn(2), (f) => { f.regions.splice(2, 1) })],
      ['重なり 3 範囲で 1 領域の欠け', edit(venn(3), (f) => { f.regions.splice(5, 1) })],
      ['重なりで同じ領域の重複', edit(venn(2), (f) => { f.regions.push(region(['a'], 7)) })],
      ['universe 無しの in: []', edit(venn(2), (f) => { f.regions.push(region([], 7)) })],
      ['universe ありで in: [] が 2 つ', edit(venn(2, 'overlap', true), (f) => { f.regions.push(region([], 7)) })],
      ['入れ子で先頭の並びでない領域', edit(venn(2, 'nested'), (f) => { f.regions[1].in = ['b'] })],
      ['入れ子で外の領域の欠け', edit(venn(3, 'nested'), (f) => { f.regions.splice(0, 1) })],
      ['入れ子で同じ領域の重複', edit(venn(2, 'nested'), (f) => { f.regions.push(region(['a', 'b'], 7)) })],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/領域|regions|layout/], label)
  })

  // @covers REQ-440#venn-regions-match
  it('包含の領域が layout の並びをちょうど 1 つずつ持つ図（universe ありの in: [] 1 つも）は、止めずに描く', () => {
    expectDrawn([
      ['重なり 2 範囲', venn(2, 'overlap')],
      ['重なり 3 範囲', venn(3, 'overlap')],
      ['重なり 2 範囲・universe と in: []', venn(2, 'overlap', true)],
      ['入れ子 2 範囲', venn(2, 'nested')],
      ['入れ子 3 範囲', venn(3, 'nested')],
      ['入れ子 2 範囲・universe と in: []', venn(2, 'nested', true)],
      ['重なり 3 範囲・in を逆の順に', edit(venn(3, 'overlap'), (f) => f.regions.forEach((r: Json) => r.in.reverse()))],
      ['入れ子 3 範囲・in を逆の順に', edit(venn(3, 'nested'), (f) => f.regions.forEach((r: Json) => r.in.reverse()))],
    ])
  })

  /** 絵記号を置ける所（箱・登場人物・段階図と循環の段・層・分解する物・部位）に icon を書いた図。 */
  const ICON_PLACES: [string, (icon: unknown) => Json][] = [
    ['箱と矢印の箱', (icon) => edit(blocks(), (f) => { f.nodes[1].icon = icon })],
    ['手順の登場人物', (icon) => edit(sequence(), (f) => { f.actors[0].icon = icon })],
    ['段階図の段', (icon) => edit(steps(), (f) => { f.stages[1].icon = icon })],
    ['循環の段', (icon) => edit(cycle(), (f) => { f.stages[1].icon = icon })],
    ['層', (icon) => edit(layers(), (f) => { f.layers[1].icon = icon })],
    ['分解する物', (icon) => edit(parts(), (f) => { f.whole.icon = icon })],
    ['部位', (icon) => edit(parts(), (f) => { f.parts[1].icon = icon })],
  ]

  // @covers REQ-440#icon-unknown
  it('絵記号を置ける所に、絵の語彙に無い名前の icon がある図は、止めてその図と icon の理由を示す', () => {
    for (const [place, make] of ICON_PLACES) expectStopped(make('robot'), [/icon|絵/, /robot/], `${place} 語彙に無い名前`)
    expectStopped(ICON_PLACES[2][1]('Person'), [/icon|絵/, /Person/], '段階図の段 大文字の混ざった名前')
    expectStopped(ICON_PLACES[2][1](''), [/icon|絵/], '段階図の段 空の文字列')
  })

  // @covers REQ-440#icon-misplaced
  it('絵記号を置けない所（時間軸の出来事と軸・包含の範囲と領域・箱と矢印の線・手順の矢印・chart の系列・matrix の軸・層の括弧・図の一番上の階層）に icon がある図は、止めてその図と icon の理由を示す', () => {
    const cases: [string, Json][] = [
      ['時間軸の出来事', edit(timeline(), (f) => { f.events[1].icon = 'clock' })],
      ['包含の範囲', edit(venn(), (f) => { f.sets[0].icon = 'people' })],
      ['包含の領域', edit(venn(), (f) => { f.regions[0].icon = 'people' })],
      ['箱と矢印の線', edit(blocks(), (f) => { f.edges[0].icon = 'mail' })],
      ['手順の矢印', edit(sequence(), (f) => { f.steps[0].icon = 'mail' })],
      ['chart の系列', edit(chart(), (f) => { f.series[0].icon = 'chart' })],
      ['matrix の x の軸', edit(matrix(2, 2), (f) => { f.x.icon = 'box' })],
      ['matrix の y の軸', edit(matrix(2, 2), (f) => { f.y.icon = 'people' })],
      ['層の括弧', edit(layers(), (f) => { f.brackets[0].icon = 'lock' })],
      ['時間軸の軸', edit(timeline(), (f) => { f.axis.icon = 'clock' })],
      ['図の一番上の階層', { ...blocks(), icon: 'gear' }],
    ]
    for (const [label, fig] of cases) expectStopped(fig, [/icon|絵/], label)
  })

  // @covers REQ-440#icon-allowed
  it('絵の語彙の 23 の名前のどれも、置ける 7 か所のどこに書いても（名前×置き場の全部の組）止めずに描く', () => {
    const VOCAB = [
      'person', 'people', 'server', 'database', 'document', 'device', 'phone', 'cloud', 'network', 'money', 'building', 'lock',
      'key', 'clock', 'gear', 'box', 'arrow-cycle', 'warning', 'check', 'mail', 'chart', 'search', 'hand',
    ]
    expectDrawn(VOCAB.flatMap((name) => ICON_PLACES.map(([place, make]) => [`${place} の ${name}`, make(name)] as [string, Json])))
  })
})
