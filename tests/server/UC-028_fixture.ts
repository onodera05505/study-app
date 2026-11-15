/** UC-028 単元の読み物を作る入口（buildUnitReading ＝ `python3 scripts/build_unit_reading.py --data <data> --unit <unit> --out <out>`）の
 *  テストが共有する作業場と呼び方。
 *
 *  作業場は一時ディレクトリで、入口はそこを作業ディレクトリにして呼ぶ。置き場の根は契約の冒頭が言う検査用の作り物の形
 *  `tests/fixtures/unit-reading/<名前>/` を作業場の中に作り、その下に資格対策の学び（ip）の置き場の写し（PDF とページの画像を除く）と
 *  配る本文の図の画像の写しを置く。登録簿はリポジトリの src/shared/targets.json のまま。実データは読むだけで書き換えない。
 *
 *  単元の構成は実データの単元 21 の物を写し、まとまりと学ぶ順と受け持ちはそのまま、全体像・まとまりの名前と説明・前提はテストが決めた物に
 *  書き換える。単元の論点の名前・出題頻度・配る本文・図の仕様・図の画像もテストが決めた物に書き換える（期待値を作り物の側から作るため）。
 *  観測するのは、標準出力の JSON・終了コード・出力先の中身・置き場の写しの中身だけ。 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
import { expect } from 'vitest'
import { FREQUENCY_TIER_FLOORS } from '../../src/server/lib/frequency-tier'

export type Json = any
export type Run = { status: number | null; stdout: string; stderr: string; json: Json; code: string | undefined }

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const ENTRY = path.join(ROOT, 'scripts', 'build_unit_reading.py')

/** 読み物にする単元と、単元をまたぐ判定に使うもう 1 つの単元（どちらも単元の構成のファイルの名前と同じ 2 桁）。 */
export const UNIT = '21'
export const OTHER_UNIT = '22'

/** 書き直した世代の最初の置き場。始まりの値は scripts/material_generations.py の REWRITTEN_FROM（値だけを引く）。 */
export const REWRITTEN_FROM = (() => {
  const r = spawnSync('python3', ['-c', 'import material_generations as m; print(m.REWRITTEN_FROM)'], {
    cwd: path.join(ROOT, 'scripts'),
    encoding: 'utf8',
  })
  const n = Number(r.stdout.trim())
  if (!Number.isInteger(n)) throw new Error(`書き直した世代の始まりの値を引けない: ${r.stdout}${r.stderr}`)
  return n
})()
export const REWRITTEN = `materials_v${REWRITTEN_FROM}`

/** 出題頻度から、印の ★ の数を求める（0 なら印なし）。段の境目の値の正本は src/server/lib/frequency-tier.ts の FREQUENCY_TIER_FLOORS（BR-051）。 */
export const starsOf = (count: number) => FREQUENCY_TIER_FLOORS.filter((floor) => count >= floor).length

/** 単元の論点に付ける名前。どの名前もほかの名前の一部にならず、数字を含まない。 */
const STEMS = ['あさひ', 'いずみ', 'うしお', 'えにし', 'おぼろ', 'かすみ', 'きさらぎ', 'くすのき', 'けやき', 'こだま', 'さざなみ', 'しおり',
  'すずらん', 'せせらぎ', 'そよかぜ', 'たそがれ', 'ちどり', 'つばさ', 'てまり', 'ともしび', 'なぎさ', 'にじ', 'ぬばたま', 'ねむのき']

/** 1 論点の、テストが決めた中身。 */
export type TopicFixture = {
  id: number
  /** 学ぶ順（単元の構成のまとまりの順、まとまりの中の順）の 0 始まりの位置。 */
  index: number
  stem: string
  term: string
  count: number
}

/** 論点の本文の組み立て。説明は 2 段、詳しい解説は見出し甲・乙の 2 節。 */
export const body = {
  expl1: (t: { stem: string }) => `${t.stem}の説明の一段目です。`,
  expl2: (t: { stem: string }) => `${t.stem}の説明の二段目です。`,
  headA: (t: { stem: string }) => `### ${t.stem}の見出し甲`,
  headB: (t: { stem: string }) => `### ${t.stem}の見出し乙`,
  detA1: (t: { stem: string }) => `${t.stem}の解説の甲の一段目です。`,
  detA2: (t: { stem: string }) => `${t.stem}の解説の甲の二段目です。`,
  detB: (t: { stem: string }) => `${t.stem}の解説の乙の段です。`,
}
export const plainExplanation = (t: { stem: string }) => `${body.expl1(t)}\n\n${body.expl2(t)}`
export const plainDetail = (t: { stem: string }) => `${body.headA(t)}\n${body.detA1(t)}\n\n${body.detA2(t)}\n${body.headB(t)}\n${body.detB(t)}`

/** 用語の記法を使う段（論点 B の説明に置く）。キーは段の目印、値は本文の行。 */
export const GLOSSARY_LINES = {
  plain: '甲の段: [[読み物試験語甲]] を使います。',
  dropParen: '乙の段: [[読み物試験語乙（よみものしけんごおつ）]] を使います。',
  sameAsOther: '丙の段: [[読み物試験語丙（別の意味）]] を使います。',
  sameAsOtherShortened: '丁の段: [[読み物試験語丁（甲）]] を使います。',
  notInGlossary: '戊の段: [[読み物に無い試験語]] を使います。',
  inBold: '己の段: **[[読み物試験語甲]]** を太字で使います。',
} as const
/** 用語集の元（glossary_overrides.json）に足す語。 */
export const GLOSSARY_ADDED: Record<string, string> = {
  読み物試験語甲: '読み物の試験に使う語の甲です。',
  '読み物試験語乙（よみものしけんごおつ）': '読み物の試験に使う語の乙です。',
  読み物試験語丙: '読み物の試験に使う語の丙です。',
  '読み物試験語丙（別の意味）': '読み物の試験に使う語の丙の別の意味です。',
  '読み物試験語丁（甲）': '読み物の試験に使う語の丁の甲です。',
  '読み物試験語丁（乙）': '読み物の試験に使う語の丁の乙です。',
}

/** 中央を白、その中を赤の帯で塗った 200×100 の SVG（説明の字を添える）。 */
export const svgWith = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">` +
  `<rect width="200" height="100" fill="#ffffff"/><rect x="0" y="80" width="200" height="20" fill="#cc0000"/>` +
  `<text x="10" y="40" font-size="16">${label}</text></svg>\n`

// ---- PNG を読み書きする最小の道具（8 ビット・インターレース無し）。 ----

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
const pngChunk = (type: string, data: Uint8Array) => {
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  return Buffer.concat([u32(data.length), td, u32(crc32(td))])
}
/** 全面が 1 色の RGB の PNG。 */
export function solidPng(w: number, h: number, rgb: [number, number, number]) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3)
  const ihdr = Buffer.concat([u32(w), u32(h), Uint8Array.of(8, 2, 0, 0, 0)])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array())])
}
export const isPng = (b: Uint8Array) => b.length > 8 && Buffer.from(b.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

/** PNG の画素を読む。 */
export function decodePng(b: Uint8Array): { width: number; height: number; at: (x: number, y: number) => number[] } {
  const buf = Buffer.from(b)
  let p = 8
  let width = 0, height = 0, colorType = 0, depth = 8, interlace = 0
  const idat: Buffer[] = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    }
    if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  expect(depth, 'PNG のビット深度').toBe(8)
  expect(interlace, 'PNG のインターレース').toBe(0)
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= bpp ? px[y * stride + i - bpp] : 0
      const up = y > 0 ? px[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= bpp ? px[(y - 1) * stride + i - bpp] : 0
      const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c)
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      px[y * stride + i] = (x + pred) & 0xff
    }
  }
  return { width, height, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + bpp)] }
}
/** 画素が白に近いか（RGB の各値が 200 以上。灰色 1 色の PNG は値 1 つ）。 */
export const whitish = (v: number[]) => v.slice(0, Math.min(3, v.length)).every((c) => c >= 200)

// ---- 作業場 ----

export interface Ws {
  dir: string
  /** 置き場の根（作業場からの相対）。 */
  root: string
  /** 学びの置き場（作業場からの相対。入口の --data に渡す値）。 */
  data: string
  abs(rel: string): string
  exists(rel: string): boolean
  read(rel: string): string
  bytes(rel: string): Buffer
  readJson(rel: string): Json
  write(rel: string, v: string | Uint8Array): void
  writeJson(rel: string, v: unknown): void
  remove(rel: string): void
  /** ディレクトリの下のファイル（相対・並べ替え済み）。無ければ空。 */
  files(rel: string): string[]
  /** ディレクトリの下のファイルとその中身の写し（比べるため）。無ければ null。 */
  tree(rel: string): Record<string, string> | null
  /** ディレクトリの下の全部の項目（ファイルと、末尾に / を付けたディレクトリ。中身の無いディレクトリも含む。相対・並べ替え済み）。無ければ空。 */
  entries(rel: string): string[]
}

const created: string[] = []

/** 置き場の根の名前。scenario で始まる名前はシナリオのテストが使うので避ける。 */
export function makeWorkspace(name = 'unit-ok'): Ws {
  if (name.startsWith('scenario')) throw new Error('scenario で始まる名前はシナリオのテストが使う')
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'uc028-'))
  created.push(dir)
  const root = `tests/fixtures/unit-reading/${name}`
  const data = `${root}/data/ip`
  const src = path.join(ROOT, 'data', 'ip')
  const skip = new Set([path.join(src, 'pdfs'), path.join(src, 'pages')])
  const copy = (from: string, to: string, filter?: (s: string) => boolean) =>
    fs.cpSync(from, to, { recursive: true, filter, mode: fs.constants.COPYFILE_FICLONE })
  copy(src, path.join(dir, data), (s) => !skip.has(s))
  copy(path.join(ROOT, 'public', 'figures', 'materials', 'ip'), path.join(dir, root, 'public', 'figures', 'materials', 'ip'))
  const abs = (rel: string) => path.resolve(dir, rel)
  const walk = (base: string): string[] => {
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return []
    const out: string[] = []
    const rec = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) rec(p)
        else out.push(path.relative(base, p).split(path.sep).join('/'))
      }
    }
    rec(base)
    return out.sort()
  }
  const walkAll = (base: string): string[] => {
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return []
    const out: string[] = []
    const rec = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        const rel = path.relative(base, p).split(path.sep).join('/')
        if (e.isDirectory()) {
          out.push(`${rel}/`)
          rec(p)
        } else out.push(rel)
      }
    }
    rec(base)
    return out.sort()
  }
  const ws: Ws = {
    dir,
    root,
    data,
    abs,
    exists: (rel) => fs.existsSync(abs(rel)),
    read: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    bytes: (rel) => fs.readFileSync(abs(rel)),
    readJson: (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8')),
    write: (rel, v) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), v)
    },
    writeJson: (rel, v) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), JSON.stringify(v, null, 2))
    },
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    files: (rel) => walk(abs(rel)),
    tree: (rel) => {
      const base = abs(rel)
      if (!fs.existsSync(base)) return null
      if (!fs.statSync(base).isDirectory()) return { '': Buffer.from(fs.readFileSync(base)).toString('base64') }
      return Object.fromEntries(walk(base).map((f) => [f, Buffer.from(fs.readFileSync(path.join(base, f))).toString('base64')]))
    },
    entries: (rel) => walkAll(abs(rel)),
  }
  return ws
}

/** ファイルの並び（相対）に、それらを持つディレクトリ（末尾に /）を足して並べ替える（Ws.entries と比べるため）。 */
export const withParentDirs = (files: string[]): string[] => {
  const out = new Set<string>()
  for (const f of files) {
    out.add(f)
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) out.add(`${parts.slice(0, i).join('/')}/`)
  }
  return [...out].sort()
}

export function cleanWorkspaces() {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

// ---- 入口の呼び方 ----

const parseOut = (stdout: string): Json => {
  try {
    return JSON.parse(stdout.trim())
  } catch {
    for (const line of stdout.split('\n').reverse()) {
      if (!line.trim().startsWith('{')) continue
      try {
        return JSON.parse(line)
      } catch {
        continue
      }
    }
    return undefined
  }
}
/** 断ったときの応答（契約の ToolError）の error 欄。形が違えば undefined。 */
export const toolError = (json: Json): Json | undefined =>
  json && typeof json === 'object' && json.error && typeof json.error === 'object' && !Array.isArray(json.error) ? json.error : undefined
const toRun = (status: number | null, stdout: string, stderr: string): Run => {
  const json = parseOut(stdout)
  const e = toolError(json)
  return { status, stdout, stderr, json, code: e && typeof e.code === 'string' ? e.code : undefined }
}

export type Req = { data?: string; unit?: string; out?: string }
/** request の欄を長い名前の引数にする。欄に null を渡すとその引数を付けない。 */
export const argsOf = (ws: Ws, req: { data?: string | null; unit?: string | null; out?: string | null } = {}, extra: string[] = []) => {
  const v = { data: ws.data, unit: UNIT, out: 'readings/ip_21', ...req }
  const args: string[] = []
  for (const k of ['data', 'unit', 'out'] as const) if (v[k] !== null) args.push(`--${k}`, v[k] as string)
  return [...args, ...extra]
}

/** buildUnitReading を作業場で呼んで、終わるまで待つ。 */
export const build = (ws: Ws, req: { data?: string | null; unit?: string | null; out?: string | null } = {}, extra: string[] = []) => {
  const r = spawnSync('python3', [ENTRY, ...argsOf(ws, req, extra)], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return toRun(r.status, r.stdout ?? '', r.stderr ?? '')
}

/** buildUnitReading を、引数をそのまま並べて作業場で呼ぶ（BR-055 の読み方を引数の並びで確かめるため）。 */
export const buildRaw = (ws: Ws, args: string[]) => {
  const r = spawnSync('python3', [ENTRY, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return toRun(r.status, r.stdout ?? '', r.stderr ?? '')
}

/** buildUnitReading を待たずに起こす（同時に進む呼び出しと、図が外へ出す要求を手元の受け口で受けるため）。
 *  返らない描き手で試験全体が止まらないよう、limitMs を超えたら打ち切り、終了コードを null とする。 */
export function buildAsync(ws: Ws, req: Req = {}, limitMs = 240_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('python3', [ENTRY, ...argsOf(ws, req)], { cwd: ws.dir })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), limitMs)
    child.stdout.setEncoding('utf8').on('data', (x: string) => (stdout += x))
    child.stderr.setEncoding('utf8').on('data', (x: string) => (stderr += x))
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve(toRun(status, stdout, stderr))
    })
  })
}

/** 契約の例が示す、失敗ごとの理由の文。 */
export const REASON = {
  badArguments: '引数が契約の形の外',
  unknownLearning: '登録簿に無い学び',
  roadmapLearning: 'ロードマップ型の学び',
  outInsideData: '出力先が学びの置き場の中',
  outNotEmpty: '出力先に中身がある',
  unitMissing: '単元が無いか、単元の構成を持たない',
  unreadable: '読むファイルが契約の形として読めない',
  gateStops: '単元の構成が門の止める理由に当たる',
  bodyMissing: '配る本文の無い論点がある',
  mixedGenerations: '書き直した世代と前の世代が単元の中で混ざる',
  figureMissing: '図の画像か差し込み位置の見出しが無い',
  nameCollision: '同じ PNG の名前になる図が 2 つ以上ある',
  notDrawable: '図を PNG に描けない',
  figureLineMalformed: '図の置き場を指すのに図の行の形に合わない行がある',
} as const

/** ある場所の、ファイルの中身とディレクトリを含む全部の項目の写し（呼ぶ前と後を比べるため）。 */
export type Snap = { tree: Record<string, string> | null; entries: string[] }
export const snap = (ws: Ws, rel: string): Snap => ({ tree: ws.tree(rel), entries: ws.entries(rel) })

/** 断ったときの共通の観測: 終了 0 でない・ToolError の code と理由・出力先がファイルもディレクトリも前と同じ（無かったなら無いまま）。
 *  出力先が readings の下で、呼ぶ前に無かったなら、親の readings も作られていない。 */
export function expectRefused(r: Run, ws: Ws, code: string, reason: string | null, out = 'readings/ip_21', before: Snap | null = null) {
  expect(r.status, `断らずに終わった:\n${r.stdout}\n${r.stderr}`).not.toBe(0)
  expect(r.code, `ToolError の code が違う:\n${r.stdout}\n${r.stderr}`).toBe(code)
  const e = toolError(r.json)!
  if (reason === null) expect(typeof e.reason === 'string' && e.reason.length > 0, '理由が無い').toBe(true)
  else expect(e.reason, r.stdout).toBe(reason)
  expect(ws.tree(out), `出力先 ${out} の中身が変わった`).toEqual(before?.tree ?? null)
  expect(ws.entries(out), `出力先 ${out} のディレクトリが変わった`).toEqual(before?.entries ?? [])
  if (before === null && out.startsWith('readings/')) expect(ws.exists('readings'), '出力先の親 readings が作られた').toBe(false)
}

/** ToolError の figures を契約の欄だけにして、並びによらず比べられる形にする。 */
export const figuresOf = (r: Run, keys: string[] = ['topic_id', 'ref', 'cause']) =>
  ((toolError(r.json)?.figures ?? []) as Json[])
    .map((f) => Object.fromEntries(keys.filter((k) => f?.[k] !== undefined).map((k) => [k, f[k]])))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
export const sortedNumbers = (xs: unknown) => ((Array.isArray(xs) ? xs : []) as number[]).slice().sort((a, b) => a - b)

// ---- 置き場の写しを読む・書き換える ----

export const planFile = (ws: Ws, unit: string) => `${ws.data}/unit_plans/${unit}.json`
export const learningOrder = (plan: Json): number[] => (plan.groups as Json[]).flatMap((g) => g.topics as number[])

/** 教材の世代の置き場（古い順）。 */
export const generations = (ws: Ws): string[] =>
  fs
    .readdirSync(ws.abs(ws.data))
    .filter((n) => /^materials(_v\d+)?$/.test(n))
    .sort((a, b) => (Number(/_v(\d+)$/.exec(a)?.[1] ?? 1) - Number(/_v(\d+)$/.exec(b)?.[1] ?? 1)))
export const isRewritten = (gen: string) => Number(/_v(\d+)$/.exec(gen)?.[1] ?? 1) >= REWRITTEN_FROM
const genFiles = (ws: Ws, gen: string) =>
  fs
    .readdirSync(ws.abs(`${ws.data}/${gen}`))
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => `${ws.data}/${gen}/${n}`)

/** その世代の、その論点の教材の入ったファイル（無ければ空）。 */
export const filesWithTopic = (ws: Ws, gen: string, topicId: number) =>
  genFiles(ws, gen).filter((f) => ((ws.readJson(f).materials ?? []) as Json[]).some((m) => m?.topic_id === topicId))

/** その世代から、その論点の教材を全部消す。 */
export function dropEntry(ws: Ws, gen: string, topicId: number) {
  for (const f of filesWithTopic(ws, gen, topicId)) {
    const j = ws.readJson(f)
    j.materials = (j.materials as Json[]).filter((m) => m?.topic_id !== topicId)
    ws.writeJson(f, j)
  }
}
/** その世代の、その論点の教材を 1 つにして中身を置き換える（無ければその世代の最初のファイルに足す）。 */
export function setEntry(ws: Ws, gen: string, topicId: number, m: { term: string; explanation: string; detail: string }) {
  const entry = { topic_id: topicId, term: m.term, explanation: m.explanation, detail: m.detail }
  const holders = filesWithTopic(ws, gen, topicId)
  const target = holders[0] ?? genFiles(ws, gen)[0]
  dropEntry(ws, gen, topicId)
  const j = ws.readJson(target)
  j.materials = [...(j.materials as Json[]), entry]
  ws.writeJson(target, j)
}
/** その論点の教材の中身を、ある世代で読む（最初の 1 つ）。 */
export const entryOf = (ws: Ws, gen: string, topicId: number): Json | undefined =>
  filesWithTopic(ws, gen, topicId).flatMap((f) => (ws.readJson(f).materials as Json[]).filter((m) => m?.topic_id === topicId))[0]

export const figureSpecFile = (ws: Ws, topicId: number) => `${ws.data}/material_figures/${topicId}.json`
export const figureFile = (ws: Ws, sub: string) => `${ws.root}/public/figures/materials/ip/${sub}`
export const figureRef = (sub: string) => `/figures/materials/ip/${sub}`

/** 図の仕様の 1 図（読み物が使う欄のほか、図の仕様書が必須とする型と中身を持たせる）。 */
export const specFigure = (id: number, after: string, caption: string) => ({
  id,
  type: 'blocks',
  after,
  caption,
  nodes: [
    { id: 'a', label: '左の箱\n一言', row: 0, col: 0 },
    { id: 'b', label: '右の箱\n一言', row: 0, col: 1 },
  ],
  edges: [{ from: 'a', to: 'b', label: 'つなぐ' }],
})
export const writeSpec = (ws: Ws, topicId: number, term: string, figures: Json[]) =>
  ws.writeJson(figureSpecFile(ws, topicId), { topic_id: topicId, term, figures })

/** 論点の一覧の、単元の論点の名前と出題頻度を書き換える。出題頻度は単元の論点の過去問を配り直して件数をそろえる。 */
function setTopics(ws: Ws, fixtures: TopicFixture[]) {
  const file = `${ws.data}/topics.json`
  const j = ws.readJson(file)
  const byId = new Map(fixtures.map((t) => [t.id, t]))
  const pool: Json[] = (j.topics as Json[]).filter((t) => byId.has(t.id)).flatMap((t) => t.questions ?? [])
  let next = 0
  for (const t of j.topics as Json[]) {
    const f = byId.get(t.id)
    if (!f) continue
    t.term = f.term
    const qs: Json[] = []
    for (let i = 0; i < f.count; i++) qs.push(pool[next++ % Math.max(pool.length, 1)])
    t.questions = qs
    t.question_count = f.count
  }
  ws.writeJson(file, j)
}

/** 単元の論点の過去問（論点の一覧が指す回と番号）。 */
export function questionsOfUnit(ws: Ws, ids: number[]): { exam: string; number: number | string }[] {
  const j = ws.readJson(`${ws.data}/topics.json`)
  return (j.topics as Json[]).filter((t) => ids.includes(t.id)).flatMap((t) => t.questions ?? [])
}

/** 過去問の問題文（回のファイルから、指す番号の物）。 */
export function questionStems(ws: Ws, refs: { exam: string; number: number | string }[]): string[] {
  const out: string[] = []
  for (const r of refs) {
    const f = `${ws.data}/questions/${r.exam}.json`
    if (!ws.exists(f)) continue
    const q = ((ws.readJson(f).questions ?? []) as Json[]).find((x) => String(x.number) === String(r.number))
    if (q && typeof q.text === 'string') out.push(q.text)
  }
  return out
}
/** 問題解説の正解の根拠と誤答の注（指す過去問の物）。 */
export function questionExplanations(ws: Ws, refs: { exam: string; number: number | string }[]): string[] {
  const ids = new Set(refs.map((r) => `${r.exam}-q${r.number}`))
  const dir = `${ws.data}/question_explanations`
  const out: string[] = []
  for (const f of ws.files(dir)) {
    if (!f.endsWith('.json')) continue
    for (const e of (ws.readJson(`${dir}/${f}`).explanations ?? []) as Json[]) {
      if (!ids.has(e.question_id)) continue
      if (typeof e.correct_reason === 'string') out.push(e.correct_reason)
      for (const c of (e.choices ?? []) as Json[]) if (typeof c.note === 'string') out.push(c.note)
    }
  }
  return out
}

/** 単元の読み物の作り物の全体。 */
export type Unit = {
  plan: Json
  order: number[]
  topics: TopicFixture[]
  /** 学ぶ順の位置ごとの論点。 */
  at: (index: number) => TopicFixture
  byId: (id: number) => TopicFixture
}

/** 単元の構成を、まとまりと学ぶ順と受け持ちはそのままに、全体像・まとまりの名前と説明・前提をテストの物にして書く。 */
function rewritePlan(ws: Ws, prerequisites: (order: number[]) => Record<string, number[]>): Json {
  const plan = ws.readJson(planFile(ws, UNIT))
  const order = learningOrder(plan)
  plan.overview = 'この単元の全体像の文です。土台の論点から順に、論点どうしのつながりをたどって進みます。'
  plan.groups = (plan.groups as Json[]).map((g, i) => ({
    ...g,
    name: `まとまりの名前その${'一二三四五六七八九'[i]}`,
    description: `まとまりその${'一二三四五六七八九'[i]}の説明の文です。`,
  }))
  plan.prerequisites = prerequisites(order)
  ws.writeJson(planFile(ws, UNIT), plan)
  return plan
}

/** 論点の名前と出題頻度を決める。学ぶ順で 3 番目の論点の名前は末尾に括弧書きを持つ。 */
function topicFixtures(order: number[]): TopicFixture[] {
  const counts = new Map<number, number>([[0, 3], [1, 0], [2, 1], [3, 2]])
  const high = [12, 13, 14, 15, 16].find((n) => !order.includes(n))!
  counts.set(4, high)
  return order.map((id, index) => {
    const stem = STEMS[index]
    const term = index === 2 ? `${stem}の論点（${stem}のよみ）` : `${stem}の論点`
    return { id, index, stem, term, count: counts.get(index) ?? 1 }
  })
}

const unitOf = (plan: Json, topics: TopicFixture[]): Unit => ({
  plan,
  order: learningOrder(plan),
  topics,
  at: (i) => topics[i],
  byId: (id) => topics.find((t) => t.id === id)!,
})

/** 単元の論点の、ほかの世代の教材と図の仕様を片付ける（単元の論点の配る本文を、テストが書く世代の物だけにする）。 */
function clearUnitTopics(ws: Ws, ids: number[]) {
  for (const gen of generations(ws)) for (const id of ids) dropEntry(ws, gen, id)
  for (const id of ids) ws.remove(figureSpecFile(ws, id))
}

/** 書き直した世代の作り物（単元の全論点を書き直した世代から選ぶ）。
 *  学ぶ順の位置ごとの役:
 *   0 A: 図の仕様の図 2 つ（1 は短い説明の末尾、2 は見出し乙の節）
 *   1 B: 用語の記法を使う段を説明に持つ。出題頻度 0
 *   2 C: 名前の末尾に括弧書き
 *   3 D: 前提に C と A（単元の構成に書く順）。図の仕様の図 1 つ（見出し甲の節）
 *   4 E: 前提に C。配る本文が図の行を 2 つ持つ（短い説明の中の png と、見出し甲の節の中のサブパスの svg）
 *   ほか: 図の無い論点
 *  論点 A は前の世代にも別の本文（目印）を持つ。 */
export function setupRewritten(ws: Ws): Unit & { decoy: string } {
  const plan = rewritePlan(ws, (o) => ({ [String(o[3])]: [o[2], o[0]], [String(o[4])]: [o[2]] }))
  const topics = topicFixtures(learningOrder(plan))
  setTopics(ws, topics)
  clearUnitTopics(ws, topics.map((t) => t.id))
  const [A, B, , D, E] = topics
  for (const t of topics) {
    let explanation = plainExplanation(t)
    let detail = plainDetail(t)
    if (t === B) explanation = [body.expl1(t), ...Object.values(GLOSSARY_LINES), body.expl2(t)].join('\n\n')
    if (t === E) {
      explanation = `${body.expl1(t)}\n\n${lineFigure(E, 'png', A)}\n\n${body.expl2(t)}`
      detail = `${body.headA(t)}\n${body.detA1(t)}\n\n${lineFigure(E, 'sub', A)}\n\n${body.detA2(t)}\n${body.headB(t)}\n${body.detB(t)}`
    }
    setEntry(ws, REWRITTEN, t.id, { term: t.term, explanation, detail })
  }
  writeSpec(ws, A.id, A.term, [specFigure(1, 'explanation', insertedCaption(A, 1)), specFigure(2, body.headB(A), insertedCaption(A, 2))])
  writeSpec(ws, D.id, D.term, [specFigure(1, body.headA(D), insertedCaption(D, 1))])
  ws.write(figureFile(ws, `${A.id}-1.svg`), svgWith('甲の図'))
  ws.write(figureFile(ws, `${A.id}-2.svg`), svgWith('乙の図'))
  ws.write(figureFile(ws, `${D.id}-1.svg`), svgWith('丁の図'))
  ws.write(figureFile(ws, lineSub(E, 'sub', A)), svgWith('サブの図'))
  ws.write(figureFile(ws, lineSub(E, 'png', A)), solidPng(40, 20, [255, 255, 255]))
  addGlossary(ws, GLOSSARY_ADDED)
  const prev = generations(ws).filter((g) => !isRewritten(g))
  const decoy = `${A.stem}の前の世代だけにある本文の目印です。`
  setEntry(ws, prev[prev.length - 1], A.id, { term: A.term, explanation: decoy, detail: `### 前の世代の見出し\n${decoy}` })
  return { ...unitOf(plan, topics), decoy }
}

/** 差し込まれる図の説明文。 */
export const insertedCaption = (t: TopicFixture, id: number) => `${t.stem}の${id}番目の図の説明文です。`
/** 論点 E の図の行の参照先（置き場からのサブパス）。サブパスの図は論点 A の 1 番目の図と同じ名前を別のサブパスに持つ。 */
export const lineSub = (E: TopicFixture, kind: 'png' | 'sub', A: TopicFixture) => (kind === 'png' ? `${E.id}-9.png` : `uc028/${A.id}-1.svg`)
export const lineCaption = (E: TopicFixture, kind: 'png' | 'sub') => `${E.stem}の${kind === 'png' ? '短い説明' : '見出し甲'}にある図の説明文です。`
const lineFigure = (E: TopicFixture, kind: 'png' | 'sub', A: TopicFixture) => `![${lineCaption(E, kind)}](${figureRef(lineSub(E, kind, A))})`

/** 用語集の元に語を足す。 */
export function addGlossary(ws: Ws, terms: Record<string, string>) {
  const file = `${ws.data}/glossary_overrides.json`
  const j = ws.exists(file) ? ws.readJson(file) : {}
  ws.writeJson(file, { ...j, ...terms })
}

/** 前の世代の作り物（単元の全論点を書き直した世代より前の世代から選ぶ）。
 *  学ぶ順の位置ごとの役:
 *   0 A: 最も新しい前の世代に本文（説明の 2 段の間に図の行）。図の仕様は同じ図を見出し乙の節に置く。その前の世代に別の本文
 *   1 B: 前の世代のうち 2 番目に新しい世代だけに本文
 *   2 C: 最も古い世代だけに本文
 *   3 D: 最も新しい前の世代に本文（見出し甲の節の 2 段の間に図の行）。図の仕様の差し込み位置の見出しは本文に無い
 *   ほか: 最も新しい前の世代に図の無い本文 */
export function setupPrevious(ws: Ws): Unit & { genOf: (id: number) => string; decoy: string } {
  const plan = rewritePlan(ws, (o) => ({ [String(o[3])]: [o[2], o[0]], [String(o[4])]: [o[2]] }))
  const topics = topicFixtures(learningOrder(plan))
  setTopics(ws, topics)
  clearUnitTopics(ws, topics.map((t) => t.id))
  const prev = generations(ws).filter((g) => !isRewritten(g))
  const newest = prev[prev.length - 1]
  const second = prev[prev.length - 2]
  const oldest = prev[0]
  const [A, B, C, D] = topics
  const genOf = new Map<number, string>()
  const decoy = `${A.stem}の古い世代の本文の目印です。`
  for (const t of topics) {
    let explanation = plainExplanation(t)
    let detail = plainDetail(t)
    let gen = newest
    if (t === A) {
      explanation = `${body.expl1(t)}\n\n![${insertedCaption(A, 1)}](${figureRef(`${A.id}-1.svg`)})\n\n${body.expl2(t)}`
      setEntry(ws, second, t.id, { term: t.term, explanation: decoy, detail: `### 古い見出し\n${decoy}` })
    }
    if (t === B) gen = second
    if (t === C) gen = oldest
    if (t === D)
      detail = `${body.headA(t)}\n${body.detA1(t)}\n\n![${insertedCaption(D, 1)}](${figureRef(`${D.id}-1.svg`)})\n\n${body.detA2(t)}\n${body.headB(t)}\n${body.detB(t)}`
    setEntry(ws, gen, t.id, { term: t.term, explanation, detail })
    genOf.set(t.id, gen)
  }
  writeSpec(ws, A.id, A.term, [specFigure(1, body.headB(A), insertedCaption(A, 1))])
  writeSpec(ws, D.id, D.term, [specFigure(1, '### 本文に無い見出し', insertedCaption(D, 1))])
  ws.write(figureFile(ws, `${A.id}-1.svg`), svgWith('前の甲の図'))
  ws.write(figureFile(ws, `${D.id}-1.svg`), svgWith('前の丁の図'))
  return { ...unitOf(plan, topics), genOf: (id) => genOf.get(id)!, decoy }
}

// ---- 読み物を読む ----

/** 本文の画像の参照先（`![..](参照先)`）と、その代替文。 */
export const imagesOf = (md: string) => [...md.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)].map((m) => ({ alt: m[1], ref: m[2], at: m.index! }))
/** 画像の参照先を除いた本文（論点の ID や世代の名前が本文に出ていないかを見るため）。 */
export const withoutImageTargets = (md: string) => md.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '![$1]()')
/** 数字の並びとして独立に現れるか。 */
export const hasNumberToken = (text: string, n: number) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(text)
export const countOf = (text: string, s: string) => text.split(s).length - 1

export const resolveIn = (fromFile: string, ref: string) => path.resolve(path.dirname(fromFile), ref)
export const isInside = (root: string, p: string) => {
  const r = path.relative(root, p)
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r)
}

/** 読み物の中の論点の区切り。論点の名前を持つ見出しの行から、次の論点かまとまりの見出しの行の前まで。 */
export function sectionsOf(md: string, unit: Unit): Map<number, { start: number; end: number; headLine: string; text: string }> {
  const lines = md.split('\n')
  const offsets: number[] = []
  let acc = 0
  for (const l of lines) {
    offsets.push(acc)
    acc += l.length + 1
  }
  const headingAt = (pred: (l: string) => boolean, from = 0) => {
    for (let i = from; i < lines.length; i++) if (/^\s*#/.test(lines[i]) && pred(lines[i])) return i
    return -1
  }
  const groupNames = (unit.plan.groups as Json[]).map((g) => g.name as string)
  const starts = unit.topics.map((t) => ({ t, line: headingAt((l) => l.includes(t.term)) }))
  const boundaries = [
    ...starts.map((s) => s.line),
    ...groupNames.map((n) => headingAt((l) => l.includes(n))),
  ].filter((n) => n >= 0)
  const out = new Map<number, { start: number; end: number; headLine: string; text: string }>()
  for (const { t, line } of starts) {
    if (line < 0) continue
    const next = boundaries.filter((b) => b > line).sort((a, b) => a - b)[0] ?? lines.length
    const start = offsets[line]
    const end = next < lines.length ? offsets[next] : md.length
    out.set(t.id, { start, end, headLine: lines[line], text: md.slice(start, end) })
  }
  return out
}

/** 論点の区切りの頭（見出しの行から、本文の最初の段の前まで）。 */
export const headOf = (section: string, t: TopicFixture) => {
  const at = section.indexOf(`${t.stem}の説明の一段目`)
  const alt = section.indexOf(`${t.stem}の古い世代`)
  const cut = [at, alt].filter((n) => n >= 0).sort((a, b) => a - b)[0]
  return cut === undefined ? section : section.slice(0, cut)
}
