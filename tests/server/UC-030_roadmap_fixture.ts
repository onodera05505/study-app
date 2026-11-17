/** UC-030 のテストの足場。作り手の手元を一時の作業場に置き、契約の入口（buildRoadmap・applySummaryOverride・buildTargetDataset）を
 *  作業場を cwd にしたコマンドとして呼ぶ。リポジトリの data/ は読むだけで書き換えない。
 *
 *  - 組み立て直しの仕込みは、論点の候補（topics_candidates.json）とロードマップの設定（roadmap_config.json）をテスト自身が書く
 *  - 投入データの組み立ての仕込みは、学びの置き場（data/<学び>）と教材の図を作業場へ写してから、写しの上で変える
 *  - 登録簿（src/shared/targets.json）は値の正本として読むだけ
 *  観測するのは終了コード・標準出力・標準エラーと、作業場に書き出されたファイルだけ。 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Json = Record<string, any>

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const BUILD_ROADMAP = path.join(ROOT, 'scripts', 'build_roadmap.py')
export const APPLY_SUMMARY = path.join(ROOT, 'scripts', 'apply_summary_override.py')
export const BUILD_DATASET = path.join(ROOT, 'scripts', 'build_target_dataset.py')

/** 登録簿のその学びの値。 */
export function registry(key: string): Json {
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'targets.json'), 'utf8'))
  if (!all[key]) throw new Error(`登録簿に学び ${key} が無い（仕込みを作れない）`)
  return all[key]
}

/** 登録簿のその学びの印の段（level の並び）。 */
export function tierLevels(key: string): number[] {
  const tiers = (registry(key).roadmapSpec?.tiers ?? []) as Json[]
  return tiers.map((t) => t.level as number)
}

/** 登録簿のその学びの分野のうち、補足の分野を除いたもの。 */
export function roadmapFields(key: string): string[] {
  const r = registry(key)
  return (r.fields as string[]).filter((f) => f !== r.roadmapSpec?.extraField)
}

const dirs: string[] = []

/** 一時の作業場を作る（後始末は cleanup がまとめて行う）。 */
export function workspace(prefix: string): string {
  const ws = fs.mkdtempSync(path.join(tmpdir(), `${prefix}-`))
  dirs.push(ws)
  return ws
}

export function cleanup() {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

export type Run = { status: number | null; stdout: string; out: string }

/** 作業場を cwd にして python3 の入口を呼ぶ。 */
export function run(ws: string, script: string, args: string[]): Run {
  const r = spawnSync('python3', [script, ...args], { cwd: ws, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

export function readJson(file: string): Json {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file: string, v: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(v, null, 2))
}

/** 置き場の下の全ファイルの相対パスと中身の要約。組み立ての前後で状態が変わっていないことを見るのに使う。 */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fs.existsSync(dir)) return out
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else out[path.relative(dir, f)] = createHash('sha1').update(fs.readFileSync(f)).digest('hex')
    }
  }
  walk(dir)
  return out
}

// ---------------------------------------------------------------- 組み立て直し（buildRoadmap）

export type Candidate = Json & { id: number; term: string; prereq: number[]; goals?: number[] }

/** 候補の論点の ID（ID は名前とも学ぶ順とも別の値）。 */
export const ID = (n: number) => 300 + n
/** 候補の名前（数字を含まない、互いに含み合わない名前）。 */
export const TERM = (n: number) => `仕込みの単位${String.fromCharCode(0x30a2 + (n - 1) * 2)}`

/** 日で束ねる学び（itc）の候補。ID の順に重み（source_count）が下がり、到達基準はどれも 1。 */
export function dayCandidates(count: number): Candidate[] {
  const fields = roadmapFields('itc')
  return Array.from({ length: count }, (_, i) => ({
    id: ID(i + 1),
    term: TERM(i + 1),
    field: fields[i % fields.length],
    middle: '仕込みの中分類',
    summary: `仕込みの要約${i + 1}`,
    source_count: 40 - i * 2,
    sources: ['仕込みの資料'],
    interview_count: 0,
    prereq: [],
    goals: [1],
    aliases: [],
  }))
}

/** 章の名前。 */
export const CHAPTER = (n: number) => `仕込みの章${n}`

/** 章で束ねる学び（eng）の候補。章の名前は 2 つ、印は登録簿の段を順に使う。 */
export function chapterCandidates(count: number): Candidate[] {
  const fields = roadmapFields('eng')
  const levels = tierLevels('eng')
  return Array.from({ length: count }, (_, i) => ({
    id: ID(i + 1),
    term: TERM(i + 1),
    field: fields[i < count / 2 ? 0 : 1],
    chapter: CHAPTER(i < count / 2 ? 1 : 2),
    middle: CHAPTER(i < count / 2 ? 1 : 2),
    summary: `仕込みの要約${i + 1}`,
    tier: levels[i % levels.length],
    source_count: 40 - i * 2,
    sources: [{ name: '仕込みの資料', where: '仕込みの節' }],
    prereq: [],
    goals: [1],
    aliases: [],
  }))
}

/** ロードマップの設定。over に書いた値で上書きする。 */
export function roadmapConfig(over: Json = {}): Json {
  return {
    max: 6,
    per_day: 3,
    min_per_goal: 1,
    must_include: [],
    exclude: [],
    prereq_add: {},
    prereq_replace: {},
    cluster: [],
    summary_override: {},
    ...over,
  }
}

/** 章で束ねる設定（全候補を載せる上限）。 */
export function chapterConfig(count: number, over: Json = {}): Json {
  const { per_day: _p, ...rest } = roadmapConfig({ group_by: 'chapter', max: count, ...over })
  return rest
}

export type Built = Run & {
  ws: string
  dir: string
  roadmap: Json | null
  before: Record<string, string>
  after: Record<string, string>
}

/** 作業場の data/<学び> に候補と設定（null なら設定のファイルを置かない）と追加のファイルを書き、組み立て直す。 */
export function buildRoadmap(
  key: string,
  cands: Candidate[] | null,
  cfg: Json | null,
  opts: { args?: string[]; files?: Record<string, unknown>; fixture?: string } = {},
): Built {
  const ws = workspace('uc030-roadmap')
  let data = `data/${key}`
  if (opts.fixture) {
    // 契約の例が指す fixture を、同じ相対パスのまま作業場へ写して呼ぶ
    data = opts.fixture
    fs.cpSync(path.join(ROOT, opts.fixture), path.join(ws, opts.fixture), { recursive: true })
  }
  const dir = path.join(ws, data)
  fs.mkdirSync(dir, { recursive: true })
  if (cands) writeJson(path.join(dir, 'topics_candidates.json'), { candidates: cands })
  if (cfg) writeJson(path.join(dir, 'roadmap_config.json'), cfg)
  for (const [rel, v] of Object.entries(opts.files ?? {})) writeJson(path.join(dir, rel), v)
  const before = snapshot(dir)
  const r = run(ws, BUILD_ROADMAP, ['--data', data, ...(opts.args ?? [])])
  const file = path.join(dir, 'roadmap.json')
  const roadmap = fs.existsSync(file) ? readJson(file) : null
  return { ...r, ws, dir, roadmap, before, after: snapshot(dir) }
}

export const unitsOf = (b: Built): Json[] => (b.roadmap?.units ?? []) as Json[]
export const unitIds = (b: Built): number[] => unitsOf(b).map((u) => u.topic_id as number)

/** ロードマップのデータのうち、単位の並び（units）の外にある部分の文字列。 */
export function outsideUnits(b: Built): string {
  const { units: _u, ...rest } = b.roadmap ?? {}
  return JSON.stringify(rest)
}

// ---------------------------------------------------------------- 投入データの組み立て（buildTargetDataset）

export type DatasetWs = {
  ws: string
  key: string
  data: string
  dir: string
  path: (rel: string) => string
  read: (rel: string) => Json
  write: (rel: string, v: unknown) => void
}

/** 学びの置き場と教材の図を写した作業場。 */
export function datasetWorkspace(key: string): DatasetWs {
  const ws = workspace(`uc030-dataset-${key}`)
  fs.cpSync(path.join(ROOT, 'data', key), path.join(ws, 'data', key), { recursive: true })
  const figures = path.join(ROOT, 'public', 'figures', 'materials', key)
  if (fs.existsSync(figures)) fs.cpSync(figures, path.join(ws, 'public', 'figures', 'materials', key), { recursive: true })
  const dir = path.join(ws, 'data', key)
  return {
    ws,
    key,
    data: `data/${key}`,
    dir,
    path: (rel) => path.join(dir, rel),
    read: (rel) => readJson(path.join(dir, rel)),
    write: (rel, v) => writeJson(path.join(dir, rel), v),
  }
}

/** 置き場の下の、その名前のディレクトリの JSON ファイル（名前の順）。 */
export function jsonFiles(d: DatasetWs, sub: string): string[] {
  const p = d.path(sub)
  if (!fs.existsSync(p)) return []
  return fs
    .readdirSync(p)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => `${sub}/${n}`)
}

/** 置き場の下のディレクトリにある束のファイルの、その欄の行を論点の ID の条件で書き換える。 */
export function editBundles(d: DatasetWs, sub: string, list: string, edit: (rows: Json[]) => Json[]) {
  for (const rel of jsonFiles(d, sub)) {
    const body = d.read(rel)
    body[list] = edit(body[list] as Json[])
    d.write(rel, body)
  }
}

/** 束のファイルにあるその欄の全行。 */
export function bundleRows(d: DatasetWs, sub: string, list: string): Json[] {
  return jsonFiles(d, sub).flatMap((rel) => d.read(rel)[list] as Json[])
}

export type DatasetRun = Run & { before: Record<string, string>; after: Record<string, string> }

/** 作業場で投入データを組み立てる。 */
export function buildDataset(d: DatasetWs): DatasetRun {
  const before = snapshot(d.dir)
  const r = run(d.ws, BUILD_DATASET, ['--data', d.data])
  return { ...r, before, after: snapshot(d.dir) }
}
