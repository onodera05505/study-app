/** UC-019 の境界のテストが共有する、一時ディレクトリの最小のフィクスチャと入口の呼び方。
 *
 *  入口は契約の 2 つの操作だけ（buildLearnerPack ＝ `python3 scripts/build_learner_pack.py`、
 *  gradeLearnerAnswers ＝ `python3 scripts/grade_learner.py`）。request の欄はそのまま長い名前の引数、
 *  response は標準出力の JSON 1 つと終了コード（成功 0、errors に当たれば 1）。
 *  コマンドは一時ディレクトリを作業ディレクトリにして呼び、`--data data/<key>` はその中の data/<key> を指す
 *  （契約の data は `^data/[a-z]+$`、学びの置き場は data/ の下全体、図は public/figures/materials/<key>/）。
 *  学びの種類は登録簿（リポジトリの src/shared/targets.json）が決めるので、鍵は登録簿にある eng（ロードマップ型）と
 *  ip（資格型）を使う。実データの data/ は読みも書きもしない。 */

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { env as processEnv } from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

export const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const BUILD = path.join(ROOT, 'scripts', 'build_learner_pack.py')
const GRADE = path.join(ROOT, 'scripts', 'grade_learner.py')

/** 標準出力の JSON。形は契約が決め、ここでは欄を名前で読むだけ。 */
export type Json = any

// ---- 学び（eng）の最小のフィクスチャ。学ぶ順は単位の ID の順と違えてある。 ----

export type Unit = { order: number; round: number; chapter: string; topic_id: number; term: string; field: string; middle: string; summary: string }
export const UNITS: Unit[] = [
  { order: 1, round: 1, chapter: '部品の章', topic_id: 5, term: '単位五', field: '分野甲', middle: '単元一', summary: '要約五' },
  { order: 2, round: 1, chapter: '部品の章', topic_id: 2, term: '単位二', field: '分野甲', middle: '単元一', summary: '要約二' },
  { order: 3, round: 2, chapter: '通信の章', topic_id: 9, term: '単位九', field: '分野乙', middle: '単元二', summary: '要約九' },
  { order: 4, round: 2, chapter: '通信の章', topic_id: 4, term: '単位四', field: '分野乙', middle: '単元三', summary: '要約四' },
]
export const roadmapOf = (units: Unit[]) => ({ group_by: 'chapter', units })

export type Question = { qid: string; topic_id: number; term: string; stem: string; choices: Record<string, string>; answer: string; reason: string; choice_notes: Record<string, string>; tests_goal: number }
const KANA = ['ア', 'イ', 'ウ', 'エ']
export const question = (qid: string, topic_id: number, tests_goal: number, answer: string): Question => ({
  qid,
  topic_id,
  term: UNITS.find((u) => u.topic_id === topic_id)?.term ?? `単位${topic_id}`,
  stem: `問いの本文_${qid}`,
  choices: Object.fromEntries(KANA.map((k) => [k, `選択肢_${qid}_${k}`])),
  answer,
  reason: `正解の根拠の印_${qid}`,
  choice_notes: Object.fromEntries(KANA.map((k) => [k, `選択肢の説明の印_${qid}_${k}`])),
  tests_goal,
})
/** 確認問題の束。t77-1 はロードマップに無い単位の問題。単位 4 は問題を持たない。 */
export const QUESTION_BUNDLES: Question[][] = [
  [question('t5-1', 5, 1, 'イ'), question('t5-2', 5, 2, 'エ'), question('t2-1', 2, 1, 'ア')],
  [question('t9-1', 9, 2, 'ウ'), question('t77-1', 77, 1, 'ア')],
]

export type Material = { topic_id: number; term: string; explanation: string; detail: string }
export const DELIVERED: Material[] = [
  { topic_id: 5, term: '単位五', explanation: '**単位五**は配る本文の説明_5 です。', detail: '### しくみ\n![図五の説明](/figures/materials/eng/5-1.svg)\n配る本文の詳しい解説_5\n### 出典\n- 出典の行_5' },
  { topic_id: 2, term: '単位二', explanation: '**単位二**は配る本文の説明_2 です。', detail: '### しくみ\n![図二の説明](/figures/materials/eng/sub/2-1.svg)\n配る本文の詳しい解説_2\n### 出典\n- 出典の行_2' },
  { topic_id: 9, term: '単位九', explanation: '**単位九**は配る本文の説明_9 です。', detail: '### しくみ\n![図九の説明](/figures/materials/eng/9-1.png)\n配る本文の詳しい解説_9\n### 出典\n- 出典の行_9' },
  { topic_id: 4, term: '単位四', explanation: '**単位四**は配る本文の説明_4 です。', detail: '### しくみ\n配る本文の詳しい解説_4\n### 出典\n- 出典の行_4' },
]
/** パックの単位のファイルに出るはずの detail: 図の行だけが ../figures/ の下の、サブパスを保ち拡張子を .png にした画像を指す。 */
export const packDetail = (detail: string) => detail.replace(/\(\/figures\/materials\/eng\/([^)\s]+)\.(svg|png)\)/g, '(../figures/$1.png)')
/** 直したが配る本文へ組み立て直していない教材。パックに出てはいけない。 */
export const EDITED: Material[] = DELIVERED.map((m) => ({ ...m, explanation: `直した後の教材の説明_${m.topic_id}`, detail: `直した後の教材の解説_${m.topic_id}` }))

/** 文字（長音符・中黒を含む）を書いた図。 */
export const svgWithText = (text: string, box: { w: number; h: number; x: number; y: number } = { w: 240, h: 60, x: 10, y: 40 }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}"><rect width="${box.w}" height="${box.h}" fill="#ffffff"/><text x="${box.x}" y="${box.y}" font-size="24" fill="#000000">${text}</text></svg>\n`
export const SVG = svgWithText('データ・コード')
/** 正しい 2×2 の PNG。 */
export const PNG = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,2,8,2,0,0,0,253,212,154,115,0,0,0,16,73,68,65,84,120,156,99,248,207,192,0,68,12,16,10,0,31,238,3,253,139,95,20,212,0,0,0,0,73,69,78,68,174,66,96,130])
/** PNG の IHDR の幅と高さ。 */
export const pngSize = (b: Uint8Array) => {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  return { width: u32(16), height: u32(20) }
}
/** PNG の先頭の 8 バイト（署名）と IHDR を持つか。 */
export const isPng = (b: Uint8Array) =>
  b.length > 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => b[i] === x) && String.fromCharCode(b[12], b[13], b[14], b[15]) === 'IHDR'
export const EXPLAIN_TERMS = { terms: [{ term: '単位五', goal: 1 }, { term: '単位九', goal: 2 }] }

/** 採点の手本の写し（周 8）。単位 4 は問題を持たない。 */
export const SNAPSHOT_8 = {
  cycle: 8,
  units: UNITS.map((u) => ({ order: u.order, topic_id: u.topic_id, term: u.term, field: u.field })),
  questions: [
    { qid: 't5-1', topic_id: 5, tests_goal: 1, field: '分野甲', answer: 'イ' },
    { qid: 't5-2', topic_id: 5, tests_goal: 2, field: '分野甲', answer: 'エ' },
    { qid: 't2-1', topic_id: 2, tests_goal: 1, field: '分野甲', answer: 'ア' },
    { qid: 't9-1', topic_id: 9, tests_goal: 2, field: '分野乙', answer: 'ウ' },
  ],
}

export const ROADMAP_FILE = 'data/eng/roadmap.json'
export const QUESTIONS_DIR = 'data/eng/roadmap_questions'
export const DELIVERED_FILE = 'data/eng/materials_v3/roadmap.json'
export const EDITED_FILE = 'data/eng/materials/bundle_01.json'
export const EXPLAIN_FILE = 'data/eng/explain_terms.json'
export const snapshotFile = (cycle: number, key = 'eng') => `data/${key}/eval/pack_cycle_${cycle}.json`
export const resultFile = (cycle: number, key = 'eng') => `data/${key}/eval/cycle_${cycle}.json`

export type Workspace = {
  dir: string
  abs: (rel: string) => string
  write: (rel: string, data: string | Uint8Array | object) => void
  read: (rel: string) => string
  bytes: (rel: string) => Uint8Array
  exists: (rel: string) => boolean
  remove: (rel: string) => void
  /** dir の下の全ファイルを、dir からの相対パスで返す（無ければ空）。 */
  files: (rel?: string) => string[]
  /** dir の下の全ファイルの中身（変わっていないことを見るため）。 */
  snapshotTree: (rel?: string) => Record<string, string>
}

/** この土台が作った作業場。土台を読み込んだテストのファイルが終わるとき（落ちた・途中で投げたときも）に消す。
 *  rmSync は作業場の中のリンクを辿らない（リンクの先のリポジトリの物は消さない）。道具が時間切れで止められた直後は、
 *  孫のプロセスがまだ書いていて消しきれないことがあるので、少し待って消し直す。 */
const createdWorkspaces: string[] = []
afterAll(() => {
  for (const dir of createdWorkspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** ロードマップ型の学び eng がそろい、どの周の写しも結果も無い作業場所を作る。 */
export function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'uc019-'))
  createdWorkspaces.push(dir)
  const abs = (rel: string) => (path.isAbsolute(rel) ? rel : path.join(dir, rel))
  const write = (rel: string, data: string | Uint8Array | object) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
    const body = typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data, null, 2)
    fs.writeFileSync(abs(rel), body)
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
    bytes: (rel) => fs.readFileSync(abs(rel)),
    exists: (rel) => fs.existsSync(abs(rel)),
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    files,
    snapshotTree: (rel = '.') => Object.fromEntries(files(rel).map((f) => [f, fs.readFileSync(path.join(abs(rel), f), 'utf8')])),
  }
  write(ROADMAP_FILE, roadmapOf(UNITS))
  QUESTION_BUNDLES.forEach((qs, i) => write(`${QUESTIONS_DIR}/bundle_${String(i + 1).padStart(2, '0')}.json`, { bundle: i + 1, questions: qs }))
  write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED })
  write(EDITED_FILE, { bundle: 1, materials: EDITED })
  write(EXPLAIN_FILE, EXPLAIN_TERMS)
  write('public/figures/materials/eng/5-1.svg', SVG)
  write('public/figures/materials/eng/sub/2-1.svg', svgWithText('サブ・パスの図ー'))
  write('public/figures/materials/eng/9-1.png', PNG)
  return ws
}

/** 単位の配る本文を、教材のどの世代（materials・materials_v3）からも消す。 */
export function dropBody(ws: Workspace, ...topicIds: number[]) {
  ws.write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED.filter((m) => !topicIds.includes(m.topic_id)) })
  ws.write(EDITED_FILE, { bundle: 1, materials: EDITED.filter((m) => !topicIds.includes(m.topic_id)) })
}

/** 単位の配る本文の detail に、図の行を 1 つ足す（最も後の世代の materials_v3 だけを書き換える）。 */
export function addFigureLine(ws: Workspace, topicId: number, ref: string) {
  ws.write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED.map((m) => (m.topic_id === topicId ? { ...m, detail: `${m.detail}\n![足した図](${ref})` } : m)) })
}

/** 今の確認問題を、束を 1 つにまとめて置き直す。 */
export function writeQuestions(ws: Workspace, questions: Question[]) {
  ws.remove(QUESTIONS_DIR)
  ws.write(`${QUESTIONS_DIR}/bundle_01.json`, { bundle: 1, questions })
}

export type Run = { status: number | null; stdout: string; stderr: string; json: Json; code: string | undefined }

type RunOptions = { env?: Record<string, string | undefined>; python?: string }

function run(script: string, ws: Workspace, args: string[], opts: RunOptions = {}): Run {
  const r = spawnSync(opts.python ?? 'python3', [script, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: opts.env ?? processEnv })
  let json: Json = undefined
  try {
    json = JSON.parse(r.stdout.trim())
  } catch {
    json = undefined
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, code: errorCode(json) }
}

/** macOS の道具（qlmanage・sips）を持つディレクトリを PATH から外した環境と、その環境で使う python の実体。 */
export function withoutMacTools(ws: Workspace): Required<RunOptions> {
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 1 << 20 }).stdout.trim()
  const shim = path.join(ws.dir, '.bin')
  fs.mkdirSync(shim, { recursive: true })
  fs.symlinkSync(python, path.join(shim, 'python3'))
  const dirs = (processEnv.PATH ?? '').split(':').filter((d) => d && !['qlmanage', 'sips'].some((t) => fs.existsSync(path.join(d, t))))
  return { python, env: { ...processEnv, PATH: [shim, ...dirs].join(':') } }
}

/** 断ったときの応答（契約の ToolError）の error 欄。形が違えば undefined。 */
export const toolError = (json: Json): Json | undefined =>
  json && typeof json === 'object' && json.error && typeof json.error === 'object' && !Array.isArray(json.error) ? json.error : undefined

function errorCode(json: Json): string | undefined {
  const e = toolError(json)
  return e && typeof e.code === 'string' ? e.code : undefined
}

/** パックを作る入口を呼ぶ。extra は request の欄のあとに付ける引数。 */
export const build = (ws: Workspace, req: { data?: string; cycle?: number | string; out?: string } = {}, opts: RunOptions = {}, extra: string[] = []) =>
  run(BUILD, ws, ['--data', req.data ?? 'data/eng', '--cycle', String(req.cycle ?? 8), '--out', req.out ?? 'packs/c8', ...extra], opts)

/** パックを作る入口を、コマンドの引数をそのまま渡して呼ぶ（引数の欠け・重なり・並びを組むため）。 */
export const buildRaw = (ws: Workspace, args: string[]) => run(BUILD, ws, args)

/** 採点の入口を、コマンドの引数をそのまま渡して呼ぶ。 */
export const gradeRaw = (ws: Workspace, args: string[]) => run(GRADE, ws, args)

/** 採点の入口を呼ぶ。extra は request の欄のあとに付ける引数。 */
export const grade = (ws: Workspace, req: { data?: string; cycle?: number | string; answers?: string; explain?: string } = {}, extra: string[] = []) =>
  run(GRADE, ws, [
    '--data', req.data ?? 'data/eng',
    '--cycle', String(req.cycle ?? 8),
    '--answers', req.answers ?? 'answers/learner.json',
    ...(req.explain !== undefined ? ['--explain', req.explain] : []),
    ...extra,
  ])

/** 採点の前提をそろえる: 周の写しと答えのファイルを置く。 */
export function prepareGrade(ws: Workspace, answers: Json, snapshot: Json = SNAPSHOT_8, file = 'answers/learner.json') {
  ws.write(snapshotFile(snapshot.cycle), snapshot)
  ws.write(file, answers)
}

/** 本文の画像の参照先（`![..](参照先)`）。 */
export const imageRefs = (md: string) => [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1])

export const resolveIn = (fromFile: string, ref: string) => path.resolve(path.dirname(fromFile), ref)
export const isInside = (root: string, p: string) => {
  const r = path.relative(root, p)
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r)
}

// ---- 検査用の作り物（tests/fixtures/learner-pack/<名前>/）と、同時に進む呼び出し。 ----

/** 入口の実体（契約の操作名 → コマンド）。同時に進む呼び出しを組むテストが使う。 */
export const BUILD_SCRIPT = BUILD
export const GRADE_SCRIPT = GRADE
/** 学習者役への指示を描き出す入口（renderLearnerInstructions ＝ `python3 scripts/render_prompts.py --data <学びの置き場>`）。 */
export const RENDER_SCRIPT = path.join(ROOT, 'scripts', 'render_prompts.py')

/** 契約の例が指す作り物の置き場の根（リポジトリからの相対）。 */
export const fixtureRoot = (name: string) => `tests/fixtures/learner-pack/${name}`

/** リポジトリの作り物を、同じ前置き（tests/fixtures/learner-pack/<名前>/）のまま作業場所へ写す。
 *  入口は作業場所を起点に呼ぶので、リポジトリの作り物は読みも書きもしない。 */
export function copyFixture(ws: Workspace, name: string) {
  fs.cpSync(path.join(ROOT, fixtureRoot(name)), ws.abs(fixtureRoot(name)), { recursive: true })
  return fixtureRoot(name)
}

/** 標準出力の JSON と終了コードを、呼び出しを待たずに受け取る（同時に 2 つ以上を走らせるため）。 */
export function runAsync(script: string, ws: Workspace, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('python3', [script, ...args], { cwd: ws.dir, env: processEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    child.on('close', (status) => {
      let json: Json = undefined
      try {
        json = JSON.parse(stdout.trim())
      } catch {
        json = undefined
      }
      resolve({ status, stdout, stderr, json, code: errorCode(json) })
    })
  })
}
