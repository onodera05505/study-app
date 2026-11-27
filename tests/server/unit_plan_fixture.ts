/** UC-024（単元の構成の門）と UC-026（書き直しの束を作る）の境界のテストが共有する、一時の作業場の学びの写しと入口の呼び方。
 *
 *  入口は契約の操作だけ:
 *  - checkUnitPlans ＝ `python3 scripts/check_unit_plans.py --data <学びの置き場>`
 *  - buildUnitInputs ＝ `python3 scripts/build_rewrite_bundles.py --unit-inputs --data <学びの置き場> --out <出力先> [--units <番号>…]`
 *  - buildRewriteBundles ＝ `python3 scripts/build_rewrite_bundles.py --data <学びの置き場> --out <出力先> [--units <番号>…]`
 *  request の欄は長い名前の引数（配列の units は番号を空白で区切って並べる）。response は標準出力の JSON 1 つと終了コード。
 *  断ったときは標準出力に契約の ToolError（error.code・error.reason）を 1 つだけ出し、終了コードは 2。
 *  コマンドは作業場を作業ディレクトリにして呼ぶ。学びの種類は登録簿（src/shared/targets.json）が決めるので、
 *  資格対策の ip・ロードマップ型の itc・登録簿に無い zzz の鍵を使い、登録簿は作業場にも同じパスで写す。
 *  実データの data/ は読みも書きもしない。 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

export const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const CHECK = path.join(ROOT, 'scripts', 'check_unit_plans.py')
const BUILD = path.join(ROOT, 'scripts', 'build_rewrite_bundles.py')
const REGISTRY = 'src/shared/targets.json'

export type Json = any

/** 学びの置き場（資格対策）。 */
export const DATA = 'data/ip'

// ---- シラバス: 単元 21・22・23・24。単元 21 は小項目 1・2、22 は 3、23 は 4、24 は 5（24 は論点を持たない）。 ----

export type SyllabusUnit = { middle_no: number; middle: string; field: string; major: string }
export const UNITS: SyllabusUnit[] = [
  { middle_no: 21, middle: '単元二十一', field: '分野甲', major: '大項目甲' },
  { middle_no: 22, middle: '単元二十二', field: '分野乙', major: '大項目乙' },
  { middle_no: 23, middle: '単元二十三', field: '分野乙', major: '大項目乙' },
  { middle_no: 24, middle: '単元二十四', field: '分野乙', major: '大項目乙' },
]
/** 論点を 1 つも持たない単元の番号。 */
export const TOPICLESS_UNIT = 24
export const ITEMS = [
  { number: 1, name: '小項目一', middle_no: 21 },
  { number: 2, name: '小項目二', middle_no: 21 },
  { number: 3, name: '小項目三', middle_no: 22 },
  { number: 4, name: '小項目四', middle_no: 23 },
  { number: 5, name: '小項目五', middle_no: 24 },
]

// ---- 論点: 番号の順・小項目の順・学ぶ順がどれも違うように置く。 ----

export type Topic = { id: number; term: string; syllabus_item: number; related_terms: string[]; questions: { exam: string; number: number }[] }
const topic = (id: number, syllabus_item: number, questions: { exam: string; number: number }[] = []): Topic => ({
  id,
  term: `論点${id}`,
  syllabus_item,
  related_terms: [`周辺語${id}甲`, `周辺語${id}乙`],
  questions,
})
export const TOPICS: Topic[] = [
  topic(112, 1),
  topic(103, 1, [{ exam: '2018h30a', number: 1 }, { exam: '2019h31h', number: 5 }]),
  topic(109, 1),
  topic(107, 2),
  topic(105, 2, [{ exam: '2019h31h', number: 6 }]),
  topic(114, 2),
  ...[220, 221, 222, 223, 224, 225, 226, 227, 228].map((id) => topic(id, 3, id === 220 ? [{ exam: '2019h31h', number: 7 }] : [])),
  topic(330, 4),
  topic(331, 4),
]
export const termOf = (id: number) => TOPICS.find((t) => t.id === id)!.term
export const itemOf = (id: number) => ITEMS.find((i) => i.number === TOPICS.find((t) => t.id === id)!.syllabus_item)!
export const unitOf = (id: number) => UNITS.find((u) => u.middle_no === itemOf(id).middle_no)!
/** 学びに無い論点の番号。 */
export const UNKNOWN_TOPIC = 999

// ---- 過去問: 2018h30a の 1 と 2019h31h の 5 は本文と選択肢が同じ（同一内容）。 ----

const choices = (mark: string) => ({ ア: `選択肢${mark}ア`, イ: `選択肢${mark}イ`, ウ: `選択肢${mark}ウ`, エ: `選択肢${mark}エ` })
export const QUESTIONS: Record<string, { number: number; text: string; choices: Record<string, string>; answer: string }[]> = {
  '2018h30a': [{ number: 1, text: '問いの本文A', choices: choices('A'), answer: 'ア' }],
  '2019h31h': [
    { number: 5, text: '問いの本文A', choices: choices('A'), answer: 'ア' },
    { number: 6, text: '問いの本文B', choices: choices('B'), answer: 'エ' },
    { number: 7, text: '問いの本文C', choices: choices('C'), answer: 'ウ' },
  ],
}
/** 同一内容の判定の鍵: 本文に選択肢をア・イ・ウ・エの順に連結し、空白文字をすべて除いた UTF-8 の sha1 の 16 進の先頭 16 桁（契約の questions[].content_key）。 */
export const contentKeyOf = (text: string, ch: Record<string, string>) =>
  createHash('sha1').update([text, ch['ア'], ch['イ'], ch['ウ'], ch['エ']].join('').replace(/\s/g, ''), 'utf8').digest('hex').slice(0, 16)
export const questionOf = (exam: string, number: number) => QUESTIONS[exam].find((q) => q.number === number)!
export const keyOf = (exam: string, number: number) => contentKeyOf(questionOf(exam, number).text, questionOf(exam, number).choices)
export const EXAM_LABELS = { '2018h30a': '平成30年度 秋期', '2019h31h': '平成31年度 春期' }
/** 問題解説。同一内容の組 A は古い回の問題の ID で書いてあり、組への結び付けは content_key で行う。 */
export const EXPLANATIONS = [
  { question_id: '2018h30a-q1', content_key: keyOf('2018h30a', 1), correct: 'ア', correct_reason: '正解の根拠の印A', choices: ['ア', 'イ', 'ウ', 'エ'].map((label) => ({ label, term: null, note: `選択肢の説明の印A${label}` })) },
  { question_id: '2019h31h-q6', content_key: keyOf('2019h31h', 6), correct: 'エ', correct_reason: '正解の根拠の印B', choices: ['ア', 'イ', 'ウ', 'エ'].map((label) => ({ label, term: null, note: `選択肢の説明の印B${label}` })) },
]

// ---- 教材の世代: materials（全論点）・materials_v2（105・109・103）・materials_v3（103・220）。 ----

export const GENERATIONS: Record<string, { dir: string; file: string; bundle: string | number; ids: number[] }> = {
  materials: { dir: 'materials', file: 'batch_01.json', bundle: 1, ids: TOPICS.map((t) => t.id) },
  materials_v2: { dir: 'materials_v2', file: 'bundle_01.json', bundle: 1, ids: [105, 109, 103] },
  materials_v3: { dir: 'materials_v3', file: 'expl_01.json', bundle: 'expl_01', ids: [103, 220] },
}
export const materialOf = (gen: string, id: number) => ({
  topic_id: id,
  term: termOf(id),
  explanation: `${gen}の説明_${id}`,
  detail: `### しくみ\n${gen}の解説_${id}`,
})
/** 論点ごとに最も新しい世代の名前（期待値。教材の世代を古い順に重ねた結果）。 */
export const newestGeneration = (id: number) => (GENERATIONS.materials_v3.ids.includes(id) ? 'materials_v3' : GENERATIONS.materials_v2.ids.includes(id) ? 'materials_v2' : 'materials')

// ---- 図の仕様: 論点 103 だけが持つ。 ----

export const FIGURE_103 = { topic_id: 103, term: termOf(103), figures: [{ id: 1, type: 'matrix', after: 'explanation', caption: '図の説明の印103', rows: [['甲', '乙']] }] }

// ---- 単元の構成: 21 と 22 は門の止める理由にも警告にも当たらない。23 は構成を持たない。 ----

export const plan21 = (): Json => ({
  unit_no: 21,
  unit: '単元二十一',
  overview: '単元二十一の全体像の文です。',
  groups: [
    { name: '土台', description: '土台のまとまりの説明です。', topics: [112, 103, 109] },
    { name: '応用', description: '応用のまとまりの説明です。', topics: [105, 114, 107] },
  ],
  owners: [
    { subject: '土台の説明', owner: 112, topics: [112, 109] },
    { subject: '共通の説明', owner: 103, topics: [103, 109, 105] },
  ],
  prerequisites: { '109': [103], '105': [112, 109] },
})
export const plan22 = (): Json => ({
  unit_no: 22,
  unit: '単元二十二',
  overview: '単元二十二の全体像の文です。',
  groups: [
    { name: '前半', description: '前半のまとまりの説明です。', topics: [220, 221, 222, 223] },
    { name: '後半', description: '後半のまとまりの説明です。', topics: [224, 225, 226, 227, 228] },
  ],
  owners: [],
  prerequisites: { '221': [103] },
})
/** 単元の構成のファイルのパス（単元の番号 2 桁）。 */
export const planFile = (unitNo: number, data = DATA) => `${data}/unit_plans/${String(unitNo).padStart(2, '0')}.json`
export const planName = (unitNo: number) => `unit_plans/${String(unitNo).padStart(2, '0')}.json`

export type Workspace = {
  dir: string
  abs: (rel: string) => string
  write: (rel: string, data: string | object) => void
  read: (rel: string) => string
  readJson: (rel: string) => Json
  exists: (rel: string) => boolean
  remove: (rel: string) => void
  files: (rel?: string) => string[]
  snapshotTree: (rel?: string) => Record<string, string>
}

/** data/<key> に学びの写し一式を置く。 */
export function writeLearning(ws: Workspace, data = DATA) {
  ws.write(`${data}/syllabus.json`, {
    version: 'test',
    items: ITEMS.map((i) => {
      const u = UNITS.find((x) => x.middle_no === i.middle_no)!
      return { number: i.number, name: i.name, field: u.field, major_no: 1, major: u.major, middle_no: u.middle_no, middle: u.middle, terms: [] }
    }),
  })
  ws.write(`${data}/topics.json`, {
    topic_count: TOPICS.length,
    question_count: Object.values(QUESTIONS).reduce((n, qs) => n + qs.length, 0),
    exams: Object.keys(QUESTIONS),
    topics: TOPICS.map((t) => {
      const i = itemOf(t.id)
      const u = unitOf(t.id)
      return {
        id: t.id,
        term: t.term,
        match_key: `key${t.id}`,
        syllabus_item: t.syllabus_item,
        syllabus_item_name: i.name,
        field: u.field,
        major: u.major,
        middle: u.middle,
        is_new: false,
        related_terms: t.related_terms,
        question_count: t.questions.length,
        questions: t.questions.map((q) => ({ ...q, confidence: 'high' })),
      }
    }),
  })
  ws.write(`${data}/topic_ids.json`, Object.fromEntries(TOPICS.map((t) => [`key${t.id}`, t.id])))
  for (const [exam, qs] of Object.entries(QUESTIONS)) {
    ws.write(`${data}/questions/${exam}.json`, {
      exam,
      source: 'テスト用の出典',
      normalized: true,
      question_count: qs.length,
      questions: qs.map((q) => ({ number: q.number, page: 1, text: q.text, choices: q.choices, has_figure: false, figure_description: null, confidence: 'high', notes: null })),
    })
  }
  ws.write(`${data}/answer_keys.json`, Object.fromEntries(Object.entries(QUESTIONS).map(([exam, qs]) => [exam, Object.fromEntries(qs.map((q) => [String(q.number), q.answer]))])))
  ws.write(`${data}/exam_labels.json`, EXAM_LABELS)
  ws.write(`${data}/question_explanations/expl_01.json`, { bundle: 'expl_01', explanations: EXPLANATIONS })
  for (const [gen, g] of Object.entries(GENERATIONS)) ws.write(`${data}/${g.dir}/${g.file}`, { [gen === 'materials' ? 'batch' : 'bundle']: g.bundle, materials: g.ids.map((id) => materialOf(gen, id)) })
  ws.write(`${data}/material_figures/103.json`, FIGURE_103)
  ws.write(planFile(21, data), plan21())
  ws.write(planFile(22, data), plan22())
}

/** この土台が作った作業場。土台を読み込んだテストのファイルが終わるとき（落ちた・途中で投げたときも）に消す。
 *  rmSync は作業場の中のリンクを辿らない（リンクの先のリポジトリの物は消さない）。道具が時間切れで止められた直後は、
 *  孫のプロセスがまだ書いていて消しきれないことがあるので、少し待って消し直す。 */
const createdWorkspaces: string[] = []
afterAll(() => {
  for (const dir of createdWorkspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** 資格対策の学び ip と、同じ形の写しを持つロードマップ型の itc・登録簿に無い zzz を置いた作業場を作る。 */
export function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'unitplan-'))
  createdWorkspaces.push(dir)
  const abs = (rel: string) => (path.isAbsolute(rel) ? rel : path.join(dir, rel))
  const write = (rel: string, data: string | object) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
    fs.writeFileSync(abs(rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const files = (rel = '.'): string[] => {
    const base = abs(rel)
    if (!fs.existsSync(base)) return []
    const out: string[] = []
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name))
      else out.push(path.relative(base, p))
    }
    walk(base)
    return out.sort()
  }
  const ws: Workspace = {
    dir,
    abs,
    write,
    read: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    readJson: (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8')),
    exists: (rel) => fs.existsSync(abs(rel)),
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    files,
    snapshotTree: (rel = '.') => Object.fromEntries(files(rel).map((f) => [f, fs.readFileSync(path.join(abs(rel), f), 'utf8')])),
  }
  write(REGISTRY, fs.readFileSync(path.join(ROOT, REGISTRY), 'utf8'))
  writeLearning(ws, DATA)
  writeLearning(ws, 'data/itc')
  writeLearning(ws, 'data/zzz')
  return ws
}

export type Run = { status: number | null; stdout: string; stderr: string; json: Json; code: string | undefined; text: string }

function run(script: string, ws: Workspace, args: string[]): Run {
  const r = spawnSync('python3', [script, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let json: Json = undefined
  try {
    json = JSON.parse(r.stdout.trim())
  } catch {
    json = undefined
  }
  const code = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error.code : undefined
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, code: typeof code === 'string' ? code : undefined, text: `${r.stdout}\n${r.stderr}` }
}

export const check = (ws: Workspace, data = DATA) => run(CHECK, ws, ['--data', data])

export type BuildRequest = { data?: string; out: string; units?: number[] }
const buildArgs = (req: BuildRequest) => ['--data', req.data ?? DATA, '--out', req.out, ...(req.units ? ['--units', ...req.units.map(String)] : [])]
export const buildUnitInputs = (ws: Workspace, req: BuildRequest) => run(BUILD, ws, ['--unit-inputs', ...buildArgs(req)])
export const buildRewriteBundles = (ws: Workspace, req: BuildRequest) => run(BUILD, ws, buildArgs(req))

/** 応答の written を作業場の絶対パスにして並べる。 */
export const writtenOf = (ws: Workspace, r: Run): string[] => (Array.isArray(r.json?.written) ? r.json.written.map((p: string) => ws.abs(p)).map((p: string) => path.normalize(p)).sort() : [])
export const absAll = (ws: Workspace, rels: string[]) => rels.map((p) => path.normalize(ws.abs(p))).sort()
/** 作業場の中のパスとして同じ所を指すか。 */
export const samePath = (ws: Workspace, a: string, b: string) => path.normalize(ws.abs(a)) === path.normalize(ws.abs(b))

/** 指摘の一覧から種類が kind の物。 */
export const findingsOf = (list: Json, kind: string): Json[] => (Array.isArray(list) ? list.filter((f: Json) => f && f.kind === kind) : [])
/** 指摘を文字列にした物（挙げた物が中に出ているかを見るため）。 */
export const findingText = (f: Json) => `${f?.where ?? ''} ${f?.reason ?? ''}`

/** 断った応答（ToolError）の reason。形が違えば空。 */
export const reasonOf = (r: Run): string => (r.json && typeof r.json.error === 'object' && typeof r.json.error?.reason === 'string' ? r.json.error.reason : '')
/** 断ったこと: 終了コード 2 で、標準出力は error だけを持つ ToolError 1 つで、code が契約の値、reason が空でない。 */
export function expectToolError(r: Run, code: string, expectFn: (v: unknown, m?: string) => any) {
  const at = `${r.stdout}${r.stderr}`
  expectFn(r.status, at).toBe(2)
  expectFn(r.json !== undefined && r.json !== null && typeof r.json === 'object' ? Object.keys(r.json) : r.json, at).toEqual(['error'])
  expectFn(r.code, at).toBe(code)
  expectFn(reasonOf(r).length, at).toBeGreaterThan(0)
}
