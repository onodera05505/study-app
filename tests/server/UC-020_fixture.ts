/** UC-020 書き手の束の門（checkRoadmapBundle）の境界のテストが共有する、一時の作業場の仕込みと入口の呼び方。
 *
 *  入口は契約の checkRoadmapBundle ＝ `python3 scripts/check_roadmap_bundle.py --data <学びの置き場> --bundle <束の名前>`。
 *  request の欄は同じ名前の長い引数。response は、人が読む結果の行のあとに標準出力の最後の行として出る機械向けの 1 行（JSON）。
 *  断ったときは標準出力に契約の ToolError（error.code・error.reason）を出し、0 でない終了の状態で終える（ADR-0012）。
 *  断りの名前は標準出力の全体を JSON として読み、読めなければ最後の空でない行を読む（CLAUDE.md の「操作 → 入口」）。
 *
 *  作業場は一時のディレクトリで、コマンドはそこを作業ディレクトリにして呼ぶ（契約: パスは相対なら作業ディレクトリが起点）。
 *  学びの種類と見分けの語・使い方の見出し・避ける語・禁じた書き方は登録簿（src/shared/targets.json）が決めるので、
 *  リポジトリの登録簿を作業場にも同じパスで写す。実データの data/ は読みも書きもしない。
 *
 *  学びの置き場の仕込み（tests/fixtures/roadmap-bundle-gate/itc を写す）:
 *  - ロードマップの論点は 4 つ（1 課題の見極め・2 工程の区切り・3 提案の組み立て・4 面接での語り方）。到達基準は 1 と 2
 *  - 束 bundle_01 の割り当ては論点 1・2。教材は 2 つ、確認問題は論点ごとに 2 問（t1-1・t1-2・t2-1・t2-2）
 *  - 集めた資料は「仕事の進め方の手引き」1 つ
 *  - この束は、門の止める理由にも警告にも当たらない（正解の選択肢と教材の本文は 14 字続けて一致しない）
 *  同じ写しを、ロードマップ型の msg（登録簿が禁じた書き方を持つ）・資格対策の ip・登録簿に無い zzz にも置く。 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

export const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const GATE = path.join(ROOT, 'scripts', 'check_roadmap_bundle.py')
const SEED = path.join(ROOT, 'tests', 'fixtures', 'roadmap-bundle-gate', 'itc')
export const CONTRACT = path.join(ROOT, 'docs/goals/GOAL-10-verify-content-before-delivery/UC-020-check-roadmap-bundle-at-gate/contract.yaml')
const REGISTRY_FILE = 'src/shared/targets.json'
export const REGISTRY: Record<string, any> = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8'))

export type Json = any

/** 契約の limits の値（門が使う閾値と表示の制約の正本）。 */
export const LIMITS: Json = (() => {
  const r = spawnSync(
    'python3',
    [
      '-c',
      'import json,sys,yaml; p=yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["operations"]["checkRoadmapBundle"]["response"]["properties"]["limits"]["properties"]\n' +
        'def v(x):\n  return x["const"] if "const" in x else {k: y["const"] for k, y in x["properties"].items()}\n' +
        'print(json.dumps({k: v(x) for k, x in p.items()}, ensure_ascii=False))',
      CONTRACT,
    ],
    { encoding: 'utf8' },
  )
  return JSON.parse(r.stdout)
})()

export const KEY = 'itc'
export const DATA = `data/${KEY}`
export const BUNDLE = 'bundle_01'
export const materialsFile = (data = DATA, bundle = BUNDLE) => `${data}/materials/${bundle}.json`
export const questionsFile = (data = DATA, bundle = BUNDLE) => `${data}/roadmap_questions/${bundle}.json`
export const assignmentFile = (data = DATA, bundle = BUNDLE) => `${data}/material_bundles/${bundle}.json`
export const roadmapFile = (data = DATA) => `${data}/roadmap.json`

/** ロードマップの論点名。 */
export const TERMS: Record<number, string> = { 1: '課題の見極め', 2: '工程の区切り', 3: '提案の組み立て', 4: '面接での語り方' }
/** 集めた資料の名前。 */
export const SOURCE_NAME = '仕事の進め方の手引き'

export type Workspace = {
  dir: string
  abs: (rel: string) => string
  write: (rel: string, data: string | object) => void
  readJson: (rel: string) => Json
  remove: (rel: string) => void
  /** 束の教材（materials/bundle_01.json）の中身を書き換える。 */
  editMaterials: (edit: (materials: Json[]) => void, data?: string) => void
  /** 束の確認問題（roadmap_questions/bundle_01.json）の中身を書き換える。 */
  editQuestions: (edit: (questions: Json[]) => void, data?: string) => void
  snapshot: () => Record<string, string>
}

function copyTree(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name)
    const dst = path.join(to, name)
    if (fs.statSync(src).isDirectory()) copyTree(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

/** この土台が作った作業場。土台を読み込んだテストのファイルが終わるとき（落ちた・途中で投げたときも）に消す。
 *  rmSync は作業場の中のリンクを辿らない（リンクの先のリポジトリの物は消さない）。道具が時間切れで止められた直後は、
 *  孫のプロセスがまだ書いていて消しきれないことがあるので、少し待って消し直す。 */
const createdWorkspaces: string[] = []
afterAll(() => {
  for (const dir of createdWorkspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** 学びの写し（itc・msg・ip・zzz）を置いた作業場を作る。 */
export function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'roadmap-bundle-gate-'))
  createdWorkspaces.push(dir)
  const abs = (rel: string) => path.join(dir, rel)
  const write = (rel: string, data: string | object) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
    fs.writeFileSync(abs(rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const readJson = (rel: string) => JSON.parse(fs.readFileSync(abs(rel), 'utf8'))
  const files = (base: string): string[] => {
    const out: string[] = []
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n))
      else out.push(path.relative(base, p))
    }
    walk(base)
    return out.sort()
  }
  write(REGISTRY_FILE, fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8'))
  for (const key of ['itc', 'msg', 'ip', 'zzz']) copyTree(SEED, abs(`data/${key}`))
  // msg の使い方の見出しは登録簿の値に合わせる（警告に当たらないように）
  const msgUsage = REGISTRY.msg.roadmapSpec.usageSection as string
  const msgMaterials = readJson(materialsFile('data/msg'))
  for (const m of msgMaterials.materials) m.detail = m.detail.replace('### 面接で話すなら', `### ${msgUsage}`)
  write(materialsFile('data/msg'), msgMaterials)
  const ws: Workspace = {
    dir,
    abs,
    write,
    readJson,
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    editMaterials: (edit, data = DATA) => {
      const doc = readJson(materialsFile(data))
      edit(doc.materials)
      write(materialsFile(data), doc)
    },
    editQuestions: (edit, data = DATA) => {
      const doc = readJson(questionsFile(data))
      edit(doc.questions)
      write(questionsFile(data), doc)
    },
    snapshot: () => Object.fromEntries(files(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')])),
  }
  return ws
}

export type Run = {
  status: number | null
  stdout: string
  stderr: string
  /** 標準出力の最後の空でない行を JSON として読んだ物（読めなければ undefined）。 */
  machine: Json
  /** 最後の行より前の行。 */
  humanLines: string[]
  /** 断りの名前（標準出力の全体か最後の空でない行の error.code）。 */
  code: string | undefined
  reason: string
}

const parse = (text: string): Json => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 引数を並べて門を回す。 */
export function runGate(ws: Workspace, args: string[]): Run {
  const r = spawnSync('python3', [GATE, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = r.stdout.split('\n').filter((l) => l.trim() !== '')
  const last = lines.length > 0 ? parse(lines[lines.length - 1]) : undefined
  const whole = parse(r.stdout.trim())
  const err = (whole && typeof whole === 'object' && whole.error) || (last && typeof last === 'object' && last.error)
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    machine: last,
    humanLines: lines.slice(0, -1),
    code: err && typeof err.code === 'string' ? err.code : undefined,
    reason: err && typeof err.reason === 'string' ? err.reason : '',
  }
}

/** 契約の request の形で門を回す（request の欄は同じ名前の長い引数）。 */
export const check = (ws: Workspace, data = DATA, bundle = BUNDLE) => runGate(ws, ['--data', data, '--bundle', bundle])

/** 指摘の一覧から種類が kind の物。 */
export const findingsOf = (list: Json, kind: string): Json[] => (Array.isArray(list) ? list.filter((f: Json) => f && f.kind === kind) : [])
/** 指摘を文字列にした物（挙げた物が中に出ているかを見るため）。 */
export const findingText = (f: Json) => `${f?.where ?? ''} ${f?.reason ?? ''}`
export const dump = (r: Run) => `status=${r.status}\n${r.stdout}\n${r.stderr}`.slice(0, 4000)
