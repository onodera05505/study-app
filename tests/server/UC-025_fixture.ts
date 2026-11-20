/** UC-025 の境界のテストが共有する、一時の作業場の仕込みと入口の呼び方。
 *
 *  入口は契約の checkMaterialStyle ＝ `python3 scripts/check_material_style.py --data <学びの置き場> [--dir <書き直した世代>]`。
 *  response は標準出力の JSON 1 つと終了コード（通したら 0、stops が 1 件以上なら 1、断ったら 2）。
 *  コマンドは一時の作業場を cwd にして呼び、`--data data/ip` はその中の data/ip を指す。
 *  学びの種類は登録簿（src/shared/targets.json）が決めるので、リポジトリの登録簿を作業場にも写して、
 *  入口がどちらを読んでも同じ学びの種類になるようにする。実データの data/ は読みも書きもしない。
 *
 *  学びの置き場の仕込み（資格対策の ip）:
 *  - シラバスの単元は 3 つ（単元一・単元二・単元三）。論点は単元一に 6 つ、単元二と単元三に 3 つずつ
 *  - 単元の構成は単元一（まとまり 2 つ）と単元二（まとまり 1 つ）。どちらも単元の構成の門の止める理由にも警告にも当たらない
 *  - 書き直した世代の始まり（GEN(REWRITTEN_FROM)）の束は 01-1・01-2・02-1。そのすぐ前の世代に同じ論点の教材がある
 *  書き直した世代の始まりの値は、用語集が正本と名指す scripts/material_generations.py の REWRITTEN_FROM を道具から引く
 *  （世代の並びの何番目か。1 番目が materials、n 番目が materials_v<n>）。
 *  - 図の仕様は論点ごとに 2 枚（短い説明の直後に 1 枚、詳しい解説の見出しの直後に 1 枚）
 *  本文は、作業場ごとに重ならない漢字の並び（fresh）で作り、数値・問われ方の言い回しを含まない。
 *  決まった言い回し（「とは、」「です。」「混同しやすい用語」など）は 20 字に届かないので、偶然の長い一致は起きない。 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const GATE = path.join(ROOT, 'scripts', 'check_material_style.py')
export const CONTRACT = path.join(ROOT, 'docs/goals/GOAL-10-verify-content-before-delivery/UC-025-check-rewritten-materials-style/contract.yaml')
const REGISTRY_FILE = 'src/shared/targets.json'
export const REGISTRY: Record<string, any> = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8'))

/** 標準出力の JSON。形は契約が決め、ここでは欄を名前で読むだけ。 */
export type Json = any

/** 契約の Limits の const（門が使う値の正本）。 */
export const LIMITS: Record<string, unknown> = (() => {
  const r = spawnSync(
    'python3',
    ['-c', 'import json,sys,yaml; p=yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["schemas"]["Limits"]["properties"]; print(json.dumps({k: v["const"] for k, v in p.items()}, ensure_ascii=False))', CONTRACT],
    { encoding: 'utf8' },
  )
  return JSON.parse(r.stdout)
})()
export const EXAM_PHRASES = LIMITS.examPhrases as string[]
export const SAME_TOPIC = LIMITS.sameTopicMatchLength as number
export const SAME_UNIT = LIMITS.sameUnitMatchLength as number
export const FIGURES_MAX = LIMITS.explanationFiguresMax as number

/** 書き直した世代の始まりの、世代の並びでの番号。 */
export const REWRITTEN_FROM: number = (() => {
  const r = spawnSync('python3', ['-c', 'import json,sys; sys.path.insert(0, sys.argv[1]); import material_generations as g; print(json.dumps(g.REWRITTEN_FROM))', path.join(ROOT, 'scripts')], { encoding: 'utf8' })
  return JSON.parse(r.stdout)
})()
/** 世代の並びの n 番目の世代の名前。 */
export const GEN = (n: number) => (n === 1 ? 'materials' : `materials_v${n}`)

export type Material = { topic_id: number; term: string; explanation: string; detail: string }
export type Figure = { id: number; type: string; caption: string; after: string; [k: string]: unknown }
export type Group = { name: string; description: string; topics: number[] }
export type Owner = { subject: string; owner: number; topics: number[] }
export type Plan = { unit_no: number; unit: string; overview: string; groups: Group[]; owners: Owner[]; prerequisites?: Record<string, number[]> }

/** 学びの置き場の仕込み。テストはこれを書き換えてから write で作業場に置く。 */
export type Model = {
  key: string
  /** 書き直した世代の置き場の名前。 */
  dir: string
  /** 書き直した世代の束（束の名前 → 教材）。 */
  v4: Record<string, Material[]>
  /** 前の世代（previousDir）の教材。 */
  previous: Material[]
  /** 前の世代の置き場の名前。 */
  previousDir: string
  /** さらに古い世代の置き場の名前 → 教材。 */
  older: Record<string, Material[]>
  /** 論点 ID → 図の仕様の figures。 */
  figures: Record<number, Figure[]>
  /** 単元の番号 → 単元の構成。 */
  plans: Record<number, Plan>
  /** 論点の一覧（論点 ID・名前・小項目の番号）。 */
  topics: { id: number; term: string; syllabus_item: number }[]
  /** 書き直した世代の束の、その文字列そのままのファイル（書きかけ・形の違うもの）。 */
  rawV4: Record<string, string>
}

export type Run = { status: number | null; stdout: string; stderr: string; json: Json }

export type Workspace = {
  dir: string
  /** 作業場ごとに重ならない漢字の並び。 */
  fresh: (n: number) => string
  write: (rel: string, data: string | object) => void
  read: (rel: string) => string
  exists: (rel: string) => boolean
  remove: (rel: string) => void
  snapshotTree: () => Record<string, string>
  model: Model
  /** model を学びの置き場に書く（書き直した世代・前の世代・図・単元の構成・論点・シラバス）。 */
  materialize: () => void
  /** 門を呼ぶ。dir を undefined にすると --dir を渡さない。 */
  gate: (req?: { data?: string; dir?: string | null }) => Run
  /** 門を、引数の並びをそのまま渡して呼ぶ（引数の誤りを作るため）。 */
  gateArgs: (args: string[]) => Run
}

/** 単元の番号と、その単元の論点。 */
export const UNIT_TOPICS: Record<number, number[]> = { 1: [311, 312, 313, 314, 315, 316], 2: [321, 322, 323], 3: [331, 332, 333] }
export const unitOf = (topicId: number) => Number(Object.entries(UNIT_TOPICS).find(([, ts]) => ts.includes(topicId))![0])
export const DETAIL_HEADING = (m: Material) => m.detail.split('\n')[0]

export function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'uc025-'))
  let next = 0x4e00
  const fresh = (n: number) => {
    let s = ''
    for (let i = 0; i < n; i++) {
      if (next > 0x9fff) throw new Error('仕込みの漢字が尽きた')
      s += String.fromCodePoint(next++)
    }
    return s
  }
  const abs = (rel: string) => path.join(dir, rel)
  const write = (rel: string, data: string | object) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
    fs.writeFileSync(abs(rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const files = (): string[] => {
    const out: string[] = []
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name))
      else out.push(path.relative(dir, p))
    }
    walk(dir)
    return out.sort()
  }

  const terms: Record<number, string> = {}
  const allTopics = Object.values(UNIT_TOPICS).flat()
  for (const t of allTopics) terms[t] = fresh(3)
  const material = (t: number): Material => ({
    topic_id: t,
    term: terms[t],
    explanation: `**${terms[t]}**とは、${fresh(12)}です。\n- **キーワード**: ${fresh(3)}\n\n- ${fresh(14)}です。`,
    detail: `### ${fresh(6)}\n${fresh(24)}です。\n### 混同しやすい用語\n- **${fresh(3)}** — ${fresh(12)}です。`,
  })
  const v4Of = (ts: number[]) => ts.map(material)
  const v4 = { '01-1': v4Of([311, 312, 313]), '01-2': v4Of([314, 315, 316]), '02-1': v4Of([321, 322, 323]) }
  const rewritten = Object.values(v4).flat()
  const previous = rewritten.map((m) => ({ ...m, explanation: `**${m.term}**とは、${fresh(12)}です。`, detail: `### ${fresh(6)}\n${fresh(24)}です。` }))
  const figures: Record<number, Figure[]> = {}
  for (const m of rewritten) {
    figures[m.topic_id] = [
      { id: 1, type: 'blocks', caption: `${fresh(14)}を表します。`, after: 'explanation', nodes: [], edges: [] },
      { id: 2, type: 'blocks', caption: `${fresh(14)}を表します。`, after: DETAIL_HEADING(m), nodes: [], edges: [] },
    ]
  }
  const plans: Record<number, Plan> = {
    1: {
      unit_no: 1,
      unit: '単元一',
      overview: `${fresh(20)}を学びます。`,
      groups: [
        { name: 'まとまり甲', description: `${fresh(10)}です。`, topics: [311, 312, 313] },
        { name: 'まとまり乙', description: `${fresh(10)}です。`, topics: [314, 315, 316] },
      ],
      owners: [],
    },
    2: {
      unit_no: 2,
      unit: '単元二',
      overview: `${fresh(20)}を学びます。`,
      groups: [{ name: 'まとまり丙', description: `${fresh(10)}です。`, topics: [321, 322, 323] }],
      owners: [],
    },
  }
  const topics = allTopics.map((t) => ({ id: t, term: terms[t], syllabus_item: unitOf(t) }))
  const model: Model = { key: 'ip', dir: GEN(REWRITTEN_FROM), v4, previous, previousDir: GEN(REWRITTEN_FROM - 1), older: {}, figures, plans, topics, rawV4: {} }

  const materialize = () => {
    const base = `data/${model.key}`
    fs.rmSync(abs(base), { recursive: true, force: true })
    write(REGISTRY_FILE, fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8'))
    const middles = ['単元一', '単元二', '単元三']
    write(`${base}/syllabus.json`, {
      version: '仕込み',
      source: '仕込み',
      item_count: 3,
      term_count: 0,
      items: middles.map((middle, i) => ({ number: i + 1, name: `小項目${middle}`, field: '分野甲', major_no: 1, major: '大分類甲', middle_no: i + 1, middle, terms: [] })),
    })
    write(`${base}/topics.json`, {
      topic_count: model.topics.length,
      question_count: 0,
      exams: [],
      topics: model.topics.map((t) => ({
        ...t,
        match_key: t.term,
        syllabus_item_name: `小項目${middles[t.syllabus_item - 1] ?? ''}`,
        field: '分野甲',
        major: '大分類甲',
        middle: middles[t.syllabus_item - 1] ?? '',
        is_new: false,
        related_terms: [],
        question_count: 1,
      })),
    })
    for (const [no, plan] of Object.entries(model.plans)) write(`${base}/unit_plans/${String(no).padStart(2, '0')}.json`, plan)
    if (model.previous.length > 0) write(`${base}/${model.previousDir}/expl_01.json`, { bundle: 'expl_01', materials: model.previous })
    for (const [d, materials] of Object.entries(model.older)) write(`${base}/${d}/bundle_01.json`, { bundle: 1, materials })
    for (const [bundle, materials] of Object.entries(model.v4)) write(`${base}/${model.dir}/${bundle}.json`, { bundle, materials })
    for (const [name, raw] of Object.entries(model.rawV4)) write(`${base}/${model.dir}/${name}.json`, raw)
    for (const [t, figs] of Object.entries(model.figures)) {
      const term = model.topics.find((x) => x.id === Number(t))?.term ?? '論点'
      write(`${base}/material_figures/${t}.json`, { topic_id: Number(t), term, figures: figs })
    }
  }

  const gate = (req: { data?: string; dir?: string | null } = {}): Run => {
    const args = ['--data', req.data ?? `data/${model.key}`]
    const d = req.dir === undefined ? model.dir : req.dir
    if (d !== null) args.push('--dir', d)
    return gateArgs(args)
  }
  const gateArgs = (args: string[]): Run => {
    const r = spawnSync('python3', [GATE, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parseJson(r.stdout) }
  }

  return {
    dir,
    fresh,
    write,
    read: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    exists: (rel) => fs.existsSync(abs(rel)),
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    snapshotTree: () => Object.fromEntries(files().map((f) => [f, fs.readFileSync(abs(f), 'utf8')])),
    model,
    materialize,
    gate,
    gateArgs,
  }
}

/** 標準出力の JSON（全体が JSON でなければ、最後の空でない行）。読めなければ undefined。 */
function parseJson(stdout: string): Json {
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  const whole = tryParse(stdout.trim())
  if (whole !== undefined) return whole
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  return lines.length > 0 ? tryParse(lines[lines.length - 1]) : undefined
}

/** 書き直した世代の論点の教材を 1 つ探す。 */
export function v4Material(ws: Workspace, topicId: number): Material {
  for (const ms of Object.values(ws.model.v4)) {
    const m = ms.find((x) => x.topic_id === topicId)
    if (m) return m
  }
  throw new Error(`書き直した世代に論点 ${topicId} が無い`)
}
export function previousMaterial(ws: Workspace, topicId: number): Material {
  const m = ws.model.previous.find((x) => x.topic_id === topicId)
  if (!m) throw new Error(`前の世代に論点 ${topicId} が無い`)
  return m
}

/** 指摘が論点 ID を名指ししているか（where か reason に、前後が数字でない形でその ID がある）。 */
export const names = (f: Json, id: number | string) => new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(`${f.where} ${f.reason}`)
/** 指摘が単元を名指ししているか（単元の番号が 0 詰めかどうかによらない）。 */
export const namesUnit = (f: Json, unitNo: number) => new RegExp(`(^|[^0-9])0*${unitNo}([^0-9]|$)`).test(`${f.where} ${f.reason}`)
/** 指摘のうち、ある種類のもの。 */
export const ofKind = (list: Json[] | undefined, kind: string) => (list ?? []).filter((f) => f.kind === kind)
