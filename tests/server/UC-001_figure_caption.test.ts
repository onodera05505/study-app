/** 教材の図を描く道具（`python3 scripts/render_material_figures.py --data data/<学び> --out <出力先>`）が、図の説明文（caption）を
 *  図の画像の中に持たせないこと（REQ-428）と、説明文が無いか空の図があれば描かずに止めてその図を示すこと（REQ-433）。UC-001
 *
 *  仕込みは一時の作業場の data/zz/material_figures/ にテスト自身が書く（入力の形の正本は scripts/prompts/material_figures_spec.md）。
 *  実データは読まない。道具は作業場を cwd にしてコマンドとして呼び、観測するのは終了コード・標準出力と標準エラー・出力先の SVG だけ。 */

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

type Json = Record<string, any>

/** 図の中の文字（ラベル）と 1 字も重ならない語だけで書いた説明文。 */
const CAPTION = '朱色の目印をたどって北の端から順に読みます。濃い枠が肝心な所です。'

/** 4 つの型の図（説明文は呼ぶ側で差す）。 */
const FIGURES: Record<string, Json> = {
  blocks: {
    type: 'blocks',
    nodes: [
      { id: 'cl', label: 'クライアント', row: 0, col: 0 },
      { id: 'ap', label: 'アプリサーバ', row: 0, col: 1, emphasis: true },
      { id: 'db', label: 'DB サーバ', row: 0, col: 2, shape: 'cylinder' },
    ],
    edges: [
      { from: 'cl', to: 'ap', label: '入力', arrow: 'both' },
      { from: 'ap', to: 'db', label: 'SQL', arrow: 'both' },
    ],
  },
  sequence: {
    type: 'sequence',
    actors: [
      { id: 'c', label: 'クライアント' },
      { id: 's', label: 'サーバ' },
    ],
    steps: [
      { from: 'c', to: 's', label: 'ClientHello' },
      { from: 's', to: 'c', label: 'ServerHello', note: '証明書を確認する' },
      { from: 'c', to: 's', label: 'Finished' },
    ],
  },
  matrix: {
    type: 'matrix',
    x: { label: '製品', values: ['既存製品', '新製品'] },
    y: { label: '市場', values: ['既存市場', '新市場'] },
    cells: [
      ['市場浸透', '新製品開発'],
      ['市場開拓', '多角化'],
    ],
    emphasis: [[1, 1]],
  },
  chart: {
    type: 'chart',
    kind: 'line',
    x: { label: '売上高（万円）', values: [0, 200, 400, 600] },
    y: { label: '金額（万円）', min: 0 },
    series: [
      { label: '売上高', values: [0, 200, 400, 600] },
      { label: '総費用', values: [300, 400, 500, 600] },
    ],
    vlines: [{ x: 600, label: '損益分岐点' }],
  },
}

let ws = ''
afterEach(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true })
  ws = ''
})

/** 作業場を作り、論点ごとの図の仕様 JSON を書く。 */
function workspace(files: { topicId: number; term: string; figures: Json[] }[]) {
  if (ws) fs.rmSync(ws, { recursive: true, force: true })
  ws = fs.mkdtempSync(path.join(tmpdir(), 'uc001-caption-'))
  const dir = path.join(ws, DATA, 'material_figures')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files)
    fs.writeFileSync(
      path.join(dir, `${f.topicId}-${f.term}.json`),
      JSON.stringify({ topic_id: f.topicId, term: f.term, figures: f.figures }, null, 2),
    )
}

function render() {
  const r = spawnSync('python3', [RENDER, '--data', DATA, '--out', OUT], {
    cwd: ws,
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

const svgPath = (topicId: number, figId: number) => path.join(ws, OUT, `${topicId}-${figId}.svg`)

/** 説明文の 4 字の切れ端（句読点を含む）。どれか 1 つでも現れれば、説明文の一部を持っている。 */
const fragments = (() => {
  const s = CAPTION.replace(/\s/g, '')
  return Array.from({ length: s.length - 3 }, (_, i) => s.slice(i, i + 4))
})()
const leaked = (text: string) => {
  const t = text.replace(/\s/g, '')
  return fragments.filter((f) => t.includes(f))
}

/** 図として見える文字: title と desc を除いた要素の中身の文字（タグと属性を落とした残り）。 */
function visibleText(svg: string) {
  return svg
    .replace(/<title[\s\S]*?<\/title>/g, '')
    .replace(/<desc[\s\S]*?<\/desc>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
}

/** 読み上げに届く文字: title・desc の中身と、すべての属性の値（aria-label など）。 */
function accessibleText(svg: string) {
  const parts: string[] = []
  for (const m of svg.matchAll(/<(title|desc)\b[^>]*>([\s\S]*?)<\/\1>/g)) parts.push(m[2])
  for (const m of svg.matchAll(/<[^>]*>/g)) for (const a of m[0].matchAll(/=\s*"([^"]*)"|=\s*'([^']*)'/g)) parts.push(a[1] ?? a[2])
  return parts.join(' ')
}

const TOPIC = 931
const TYPES = Object.keys(FIGURES)

function drawEachType() {
  workspace([
    {
      topicId: TOPIC,
      term: '図の説明文の試し',
      figures: TYPES.map((t, i) => ({
        id: i + 1,
        after: 'explanation',
        caption: CAPTION,
        ...FIGURES[t],
      })),
    },
  ])
  const r = render()
  expect(r.status, `説明文を持つ図が描けない:\n${r.out}`).toBe(0)
  return r
}

describe('図の説明文を図の画像に持たせない（UC-001）', () => {
  // @covers REQ-428#caption-not-visible
  it('4 つの型の図の SVG はどれも、説明文のどの切れ端も見える文字として持たない', () => {
    drawEachType()
    for (const [type, figId] of TYPES.map((t, i) => [t, i + 1] as const)) {
      const file = svgPath(TOPIC, figId)
      expect(fs.existsSync(file), `${path.basename(file)} が描かれていない`).toBe(true)
      const svg = fs.readFileSync(file, 'utf8')
      expect(leaked(visibleText(svg)), `${type}: 説明文が図の中の見える文字に入っている`).toEqual([])
    }
  })

  // @covers REQ-428#caption-not-accessible
  it('4 つの型の図の SVG はどれも、説明文のどの切れ端も title・desc・属性の値として持たない', () => {
    drawEachType()
    for (const [type, figId] of TYPES.map((t, i) => [t, i + 1] as const)) {
      const file = svgPath(TOPIC, figId)
      expect(fs.existsSync(file), `${path.basename(file)} が描かれていない`).toBe(true)
      const svg = fs.readFileSync(file, 'utf8')
      expect(leaked(accessibleText(svg)), `${type}: 説明文が読み上げに届く文字（title・desc・属性）に入っている`).toEqual([])
    }
  })
})

/** 説明文の欠けた図だけを id 58 として持つ論点と、説明文を持つ図の論点を並べて描く。 */
const BAD_TOPIC = 947
const BAD_FIG = 58
function drawWithBadCaption(bad: Json) {
  workspace([
    {
      topicId: TOPIC,
      term: '説明文を持つ図',
      figures: [{ id: 1, after: 'explanation', caption: CAPTION, ...FIGURES.blocks }],
    },
    {
      topicId: BAD_TOPIC,
      term: '説明文の欠けた図',
      figures: [
        { id: 1, after: 'explanation', caption: CAPTION, ...FIGURES.matrix },
        { id: BAD_FIG, after: 'explanation', ...FIGURES.blocks, ...bad },
      ],
    },
  ])
  return render()
}

function expectStoppedAndShown(r: { status: number | null; out: string }, label = '') {
  expect(r.status, `${label} 止まらずに終了 0 で終わった:\n${r.out}`).not.toBe(0)
  expect(fs.existsSync(svgPath(BAD_TOPIC, BAD_FIG)), `${label} 説明文の欠けた図が描かれている`).toBe(false)
  expect(r.out, `${label} どの論点の図かを示していない`).toContain(String(BAD_TOPIC))
  expect(r.out, `${label} どの図かを示していない`).toContain(String(BAD_FIG))
}

describe('説明文の無い図は描かずに止める（UC-001）', () => {
  // @covers REQ-433#caption-absent
  it('説明文の欄が無い図があると、終了 0 でなく、その図を描かず、その論点と図を示す', () => {
    expectStoppedAndShown(drawWithBadCaption({}))
  })

  // @covers REQ-433#caption-empty
  it('説明文が空の文字列の図があると、終了 0 でなく、その図を描かず、その論点と図を示す', () => {
    expectStoppedAndShown(drawWithBadCaption({ caption: '' }))
  })

  // @covers REQ-433#caption-blank
  it('説明文が空白だけの文字列の図があると、終了 0 でなく、その図を描かず、その論点と図を示す', () => {
    for (const caption of [' ', '   ', '\u3000', ' \t\n ']) expectStoppedAndShown(drawWithBadCaption({ caption }), JSON.stringify(caption))
  })

  // @covers REQ-433#caption-not-string
  it('説明文が文字列でない値の図があると、終了 0 でなく、その図を描かず、その論点と図を示す', () => {
    for (const caption of [null, 0, 42, true, [CAPTION], { text: CAPTION }])
      expectStoppedAndShown(drawWithBadCaption({ caption }), JSON.stringify(caption))
  })
})
