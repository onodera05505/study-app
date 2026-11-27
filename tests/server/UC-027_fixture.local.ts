/** UC-027 のテストの仕込み。資格対策の学びの置き場の写しを一時の作業場に置き、その上で教材の世代・単元の構成・図の仕様を
 *  書き換えて、契約の 5 つの入口（buildSeed・attachMaterialFigures・checkFigureSpecs・checkRender・verifySeedRemote）を作業場を
 *  cwd にしたコマンドとして呼ぶ。実データは読むだけで書き換えない。論点・単元は番号を決め打ちせず、写しの中身から条件で選ぶ。
 *
 *  観測の道具: 投入の SQL を migrations を当てた SQLite に流し、配る本文は HTTP の境界（getTopicDetail ＝ GET /api/topics/{id}）で、
 *  単元の構成は表（unit_plans・unit_groups・unit_group_topics・topic_prerequisites）を SELECT で見る。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import { DatabaseSync } from 'node:sqlite'
import { learningD1, sqliteOf } from '../portal/repay_UC-014_sqlite_d1'

export type Json = Record<string, any>
export type Run = { status: number | null; out: string }

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPTS = path.join(ROOT, 'scripts')
const SECRET = 'test-secret'
const USER = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }

/** 書き直した世代の最初の置き場。始まりの値の正本は scripts/material_generations.py の REWRITTEN_FROM（値だけを引く）。 */
export const REWRITTEN = (() => {
  const r = spawnSync('python3', ['-c', 'import material_generations as m; print(m.REWRITTEN_FROM)'], {
    cwd: path.join(ROOT, 'scripts'),
    encoding: 'utf8',
  })
  const n = Number(r.stdout.trim())
  if (!Number.isInteger(n)) throw new Error(`書き直した世代の始まりの値を引けない: ${r.stdout}${r.stderr}`)
  return `materials_v${n}`
})()
/** 前の世代の置き場。古い順。 */
export const PREVIOUS = ['materials', 'materials_v2', 'materials_v3'] as const

/** 世代ごとの目印。本文の先頭に置き、配る本文がどの世代から来たかを見分ける。 */
export const mark = (gen: string, topicId: number) => `目印-${gen}-${topicId}`

/** 書き直した世代の本文が持つ、論点ごとに一意の見出し。 */
export const rewrittenHeading = (topicId: number, which: '甲' | '乙') => `### 書き直した${topicId}の見出し${which}`

export interface Ws {
  dir: string
  learning: string
  /** 学びの置き場（cwd からの相対）。 */
  data: string
  abs(rel: string): string
  readJson(rel: string): any
  writeJson(rel: string, v: unknown): void
  writeText(rel: string, v: string): void
  readText(rel: string): string
  remove(rel: string): void
}

const created: string[] = []

/** 学びの置き場（PDF とページの画像を除く）と、その学びの図の画像を写した作業場を作る。
 *  写しの中の書き直した世代と単元の構成は消し、テストが自分で書いた物だけにする。dataName は置き場の名前（登録簿に無い学びを作るとき）。 */
export function makeWorkspace(learning = 'ip', dataName = learning): Ws {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'uc027-'))
  created.push(dir)
  const src = path.join(ROOT, 'data', learning)
  const skip = new Set([path.join(src, 'pdfs'), path.join(src, 'pages')])
  fs.cpSync(src, path.join(dir, 'data', dataName), { recursive: true, filter: (s) => !skip.has(s) })
  for (const sub of [learning, path.join('materials', learning)]) {
    const f = path.join(ROOT, 'public', 'figures', sub)
    if (fs.existsSync(f)) fs.cpSync(f, path.join(dir, 'public', 'figures', sub.replace(learning, dataName)), { recursive: true })
  }
  const data = `data/${dataName}`
  const from = Number(REWRITTEN.replace('materials_v', ''))
  for (const name of fs.readdirSync(path.join(dir, data))) {
    const v = /^materials_v(\d+)$/.exec(name)
    if (name === 'unit_plans' || (v && Number(v[1]) >= from)) fs.rmSync(path.join(dir, data, name), { recursive: true, force: true })
  }
  const abs = (rel: string) => path.join(dir, rel)
  return {
    dir,
    learning: dataName,
    data,
    abs,
    readJson: (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8')),
    readText: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    writeJson: (rel, v) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), JSON.stringify(v, null, 2))
    },
    writeText: (rel, v) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), v)
    },
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
  }
}

export function cleanWorkspaces() {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

function spawn(ws: Ws, cmd: string, args: string[], env?: NodeJS.ProcessEnv): Run {
  const r = spawnSync(cmd, args, { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: env ?? process.env })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`.split(ws.dir).join('<ws>') }
}

/** buildSeed: `python3 scripts/build_seed.py --data <置き場> [引数…]` */
export const buildSeed = (ws: Ws, data = ws.data, extra: string[] = []) =>
  spawn(ws, 'python3', [path.join(SCRIPTS, 'build_seed.py'), '--data', data, ...extra])
/** attachMaterialFigures: `python3 scripts/attach_material_figures.py --data <置き場> [引数…]` */
export const attachFigures = (ws: Ws, extra: string[] = [], data = ws.data) =>
  spawn(ws, 'python3', [path.join(SCRIPTS, 'attach_material_figures.py'), '--data', data, ...extra])
/** checkFigureSpecs: `python3 scripts/render_material_figures.py --data <置き場> --check [--only <論点…>]` */
export const checkFigureSpecs = (ws: Ws, only: number[], data = ws.data) =>
  spawn(ws, 'python3', [
    path.join(SCRIPTS, 'render_material_figures.py'),
    '--data',
    data,
    '--check',
    ...(only.length ? ['--only', ...only.map(String)] : []),
  ])
/** 描画の検査を回す根を作業場に作る。道具は自分の置き場の 1 つ上を根として、版の印の項目でその根のビルド（dist/）を見るので、
 *  リポジトリの根でなく作業場を根にする（テストの合否がリポジトリの根の dist/ の有無と中身に左右されない。作業場には dist/ を置かないので、
 *  版の印の項目はいつも「dist/ が無い」の警告になる）。
 *  - 写す: 道具の置き場（scripts）と、道具が描く画面のソース（src・portal）と型の設定（tsconfig*.json）。ソースをリンクにすると、
 *    実行の環境がリンクを解いた元の場所のソースを型の設定の外と見て、画面の部品を組めない
 *  - 置かない: ビルド（dist）・作業の跡（.wrangler・coverage・backups）・git
 *  - リンク: ほかの最上位の物。学びの置き場と図の置き場は作業場の物のまま */
const TOOL_ROOT_COPIED = new Set(['scripts', 'src', 'portal', 'tsconfig.json', 'tsconfig.node.json'])
const TOOL_ROOT_OMITTED = new Set(['.git', 'dist', 'data', 'public', '.wrangler', 'coverage', 'backups'])
function ensureToolRoot(ws: Ws): void {
  if (fs.existsSync(ws.abs('scripts/check_render.sh'))) return
  const copied: string[] = []
  for (const name of fs.readdirSync(ROOT)) {
    if (TOOL_ROOT_OMITTED.has(name) || name.startsWith('.worker-build') || fs.existsSync(ws.abs(name))) continue
    if (TOOL_ROOT_COPIED.has(name)) copied.push(path.join(ROOT, name))
    else fs.symlinkSync(path.join(ROOT, name), ws.abs(name))
  }
  const r = spawnSync('cp', process.platform === 'darwin' ? ['-cR', ...copied, `${ws.dir}/`] : ['-R', ...copied, `${ws.dir}/`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`仕込み: 道具の根を写せない: ${r.stderr}`)
}

/** checkRender: `bash scripts/check_render.sh <学び>`（作業場を根にした道具の写しを回す。ensureToolRoot） */
export const checkRender = (ws: Ws, learning = ws.learning) => {
  ensureToolRoot(ws)
  return spawn(ws, 'bash', [ws.abs('scripts/check_render.sh'), learning])
}

/** wrangler の `d1 execute … --json --command <SQL>` を、環境変数 UC027_DB の SQLite ファイルに流して wrangler の --json の形で返す偽物。
 *  流したあとの DB を手元に作るために、wrangler（Cloudflare の CLI。こちらが持たない境界）だけを差し替える。 */
const FAKE_NPX = `#!/usr/bin/env python3
import json, os, sqlite3, sys
args = sys.argv[1:]
if 'd1' not in args or '--command' not in args:
    sys.stderr.write('偽の npx は wrangler d1 execute --command だけを受ける: ' + ' '.join(args) + '\\n')
    sys.exit(1)
sql = args[args.index('--command') + 1]
db = sqlite3.connect(os.environ['UC027_DB'])
db.row_factory = sqlite3.Row
out, buf = [], ''
for line in sql.replace(';', ';\\n').split('\\n'):
    buf += line + '\\n'
    if sqlite3.complete_statement(buf):
        rows = [dict(r) for r in db.execute(buf).fetchall()]
        out.append({'results': rows, 'success': True, 'meta': {}})
        buf = ''
if buf.strip():
    rows = [dict(r) for r in db.execute(buf).fetchall()]
    out.append({'results': rows, 'success': True, 'meta': {}})
print(json.dumps(out, ensure_ascii=False))
`

/** verifySeedRemote: `python3 scripts/verify_seed_remote.py --data <置き場> --exam <学び> --local [--sql <投入>]`。
 *  手元の DB は dbFile の SQLite で、wrangler だけを偽物に差し替える。 */
export function verifySeed(ws: Ws, exam: string, dbFile: string, extra: string[] = [], data = ws.data): Run {
  const bin = ws.abs('fakebin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'npx'), FAKE_NPX, { mode: 0o755 })
  return spawn(ws, 'python3', [path.join(SCRIPTS, 'verify_seed_remote.py'), '--data', data, '--exam', exam, '--local', ...extra], {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    UC027_DB: dbFile,
  })
}

/** migrations を当てた SQLite ファイルに投入を流す（流したあとの DB）。 */
export function seededDbFile(ws: Ws, name: string, ...seeds: string[]): string {
  const file = ws.abs(`${name}.sqlite`)
  fs.rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  applyMigrations(db)
  for (const s of seeds) db.exec(s)
  db.close()
  return file
}
export const withDbFile = <T>(file: string, f: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file)
  try {
    return f(db)
  } finally {
    db.close()
  }
}

function applyMigrations(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys = ON')
  const dir = path.join(ROOT, 'migrations')
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort())
    for (const st of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/))
      if (st.trim()) db.exec(st)
}

/** 出力の中の、契約の response か ToolError の形の JSON（最後の 1 つ）。 */
export function resultOf(r: Run): Json | null {
  for (const line of r.out.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      continue
    }
  }
  return null
}

/** 断ったとき: 終了コードが 0 でなく、標準出力に ToolError の形でその code を 1 つ出す。 */
export function expectRefused(r: Run, code: string, label: string) {
  expect(r.status, `${label}: 断らずに終了 0 で終わった:\n${r.out}`).not.toBe(0)
  expect(resultOf(r)?.error?.code, `${label}: ToolError の code が ${code} でない:\n${r.out}`).toBe(code)
  expect(String(resultOf(r)?.error?.reason ?? '').length, `${label}: 理由が無い`).toBeGreaterThan(0)
}

/* ---------- 写しの中身を読む ---------- */

export interface Catalog {
  /** 単元の番号 → 単元の名前。 */
  unitName: Map<number, string>
  /** 単元の番号 → その単元の論点 ID（ID の順）。 */
  unitTopics: Map<number, number[]>
  term: Map<number, string>
}

export function catalog(ws: Ws): Catalog {
  const syllabus = ws.readJson(`${ws.data}/syllabus.json`).items as Json[]
  const middleOf = new Map<number, number>()
  const unitName = new Map<number, string>()
  for (const i of syllabus) {
    middleOf.set(i.number, i.middle_no)
    unitName.set(i.middle_no, i.middle)
  }
  const unitTopics = new Map<number, number[]>()
  const term = new Map<number, string>()
  for (const t of ws.readJson(`${ws.data}/topics.json`).topics as Json[]) {
    const u = middleOf.get(t.syllabus_item)
    if (u === undefined) continue
    term.set(t.id, t.term)
    unitTopics.set(u, [...(unitTopics.get(u) ?? []), t.id].sort((a, b) => a - b))
  }
  return { unitName, unitTopics, term }
}

const genFiles = (ws: Ws, gen: string) => {
  const dir = ws.abs(`${ws.data}/${gen}`)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => `${ws.data}/${gen}/${n}`)
}

/** その世代にある、その論点の教材（同じ論点が複数あれば全部）。 */
export function entriesOf(ws: Ws, gen: string, topicId: number): Json[] {
  return genFiles(ws, gen).flatMap((f) => (ws.readJson(f).materials as Json[]).filter((m) => m.topic_id === topicId))
}

/** その世代の、その論点の教材を全部書き換える。remove が真を返した教材は消す。 */
export function editEntries(ws: Ws, gen: string, topicId: number, edit: (m: Json) => void | 'remove') {
  for (const f of genFiles(ws, gen)) {
    const body = ws.readJson(f)
    if (!(body.materials as Json[]).some((m) => m.topic_id === topicId)) continue
    body.materials = (body.materials as Json[]).filter((m) => (m.topic_id === topicId ? edit(m) !== 'remove' : true))
    ws.writeJson(f, body)
  }
}

/** 本文の先頭に目印を置く。 */
export const prependMark = (ws: Ws, gen: string, topicId: number) =>
  editEntries(ws, gen, topicId, (m) => {
    m.explanation = `${mark(gen, topicId)}\n\n${m.explanation}`
  })

export const figureFile = (ws: Ws, topicId: number) => `${ws.data}/material_figures/${topicId}.json`
export const figureSpec = (ws: Ws, topicId: number): Json | null =>
  fs.existsSync(ws.abs(figureFile(ws, topicId))) ? ws.readJson(figureFile(ws, topicId)) : null

/** 教材の detail にある見出し（`### …` の行）。 */
export const headingsOf = (detail: string | null | undefined) =>
  String(detail ?? '')
    .split('\n')
    .filter((l) => l.startsWith('### '))

/** 本文の図の行の置き場。図の画像のパスごとに、explanation か detail の直前の見出し（見出しより前は「detail の先頭」）を並べる。 */
export function placement(body: { explanation?: string | null; detail?: string | null }): [string, string][] {
  const out: [string, string][] = []
  const scan = (text: string | null | undefined, first: string) => {
    let section = first
    for (const line of String(text ?? '').split('\n')) {
      if (first !== 'explanation' && line.startsWith('### ')) section = line.trim()
      for (const m of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) out.push([section, m[1]])
    }
  }
  scan(body.explanation, 'explanation')
  scan(body.detail, 'detail の先頭')
  return out
}

/** 図の画像のパスが、その論点のその図を指すか。 */
export const isFigure = (p: string, topicId: number, figId: number) => p.endsWith(`/${topicId}-${figId}.svg`)

/* ---------- 単元の構成 ---------- */

export const planFile = (ws: Ws, unitNo: number) => `${ws.data}/unit_plans/${String(unitNo).padStart(2, '0')}.json`

/** その単元の全論点を、ID の逆順を学ぶ順として 2 つのまとまりに分けた単元の構成。
 *  前提は学ぶ順で 3 番目の論点に 1 番目、4 番目の論点に 2 番目と 1 番目（この並びが示す順）。 */
export function planFor(cat: Catalog, unitNo: number): Json {
  const order = [...(cat.unitTopics.get(unitNo) ?? [])].sort((a, b) => b - a)
  const half = Math.ceil(order.length / 2)
  return {
    unit_no: unitNo,
    unit: cat.unitName.get(unitNo),
    overview: `単元${unitNo}の全体像です。土台から応用へ進みます。`,
    groups: [
      { name: `単元${unitNo}の土台`, description: `単元${unitNo}の土台になる論点です。`, topics: order.slice(0, half) },
      { name: `単元${unitNo}の応用`, description: `単元${unitNo}の土台の上に立つ論点です。`, topics: order.slice(half) },
    ],
    owners: [],
    prerequisites: { [String(order[2])]: [order[0]], [String(order[3])]: [order[1], order[0]] },
  }
}

/** 学ぶ順（まとまりの順、まとまりの中の順）に並べた論点。 */
export const learningOrder = (plan: Json): number[] => (plan.groups as Json[]).flatMap((g) => g.topics)

/** 書き直した世代の 1 論点の教材。図の行を持たず、見出し甲・乙を持つ。 */
export const rewrittenMaterial = (topicId: number, term: string): Json => ({
  topic_id: topicId,
  term,
  explanation: `${mark(REWRITTEN, topicId)}\n\n**${term}**を書き直した要点です。\n\n- 書き直した要点の箇条です`,
  detail: `${rewrittenHeading(topicId, '甲')}\n書き直した詳しい説明の一段目です。\n${rewrittenHeading(topicId, '乙')}\n書き直した詳しい説明の二段目です。`,
})

/* ---------- 投入を流して観測する ---------- */

export const SEED = (ws: Ws) => `${ws.data}/seed.sql`

/** 投入の SQL を migrations を当てた SQLite に流した D1。 */
export async function loadSeed(sqlText: string): Promise<D1Database> {
  const d1 = await learningD1()
  const db = sqliteOf(d1)
  db.exec('PRAGMA foreign_keys = ON')
  db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
    USER.id,
    `${USER.id}@example.com`,
    USER.name,
    '-',
    USER.role,
  )
  db.exec(sqlText)
  return d1
}

/** 投入をもう 1 本、同じ DB に流す（D1 と同じく外部キーを効かせたまま）。 */
export function applySeed(d1: D1Database, sqlText: string) {
  sqliteOf(d1).exec(sqlText)
}

/** getTopicDetail の応答の topic。 */
export async function topicDetail(d1: D1Database, exam: string, id: number): Promise<Json> {
  const token = await issueToken(SECRET, USER)
  const res = await app.request(
    `/api/topics/${id}`,
    { headers: { Authorization: `Bearer ${token}` } },
    { EXAM: exam, JWT_SECRET: SECRET, DB: d1 } as unknown as Bindings,
  )
  const text = await res.text()
  expect(res.status, `/api/topics/${id} が 200 でない: ${text}`).toBe(200)
  return JSON.parse(text).topic as Json
}

/** 表の行を SELECT で読む。 */
export const rows = (d1: D1Database, sql: string): Json[] => sqliteOf(d1).prepare(sql).all() as Json[]
