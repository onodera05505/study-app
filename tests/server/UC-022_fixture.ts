/** UC-022 問題解説の門（checkExplanations）の境界のテストが共有する、一時の作業場の仕込みと入口の呼び方。
 *
 *  入口は契約の checkExplanations ＝ `python3 scripts/check_explanations.py --data <学びの置き場> [--bundles <入力の束の置き場>]`。
 *  request の欄は同じ名前の長い引数。response は標準出力の JSON（全体が JSON でなければ最後の空でない行の JSON）と終了の状態。
 *  断ったときは標準出力に契約の ToolError（error.code・error.reason）を出し、0 でない終了の状態で終える（ADR-0012）。
 *
 *  作業場は一時のディレクトリで、コマンドはそこを作業ディレクトリにして呼ぶ。学びの種類は登録簿（src/shared/targets.json）が
 *  決めるので、リポジトリの登録簿を作業場にも同じパスで写す。実データの data/ は読みも書きもしない。
 *
 *  学びの置き場の仕込み（tests/fixtures/explanations-gate/ip を写す）:
 *  - 過去問は 2018h30a の 1・2・3・4 と 2019h31h の 5・6。2018h30a-q1 と 2019h31h-q5 は本文と選択肢が同じ（同一内容）。2018h30a-q4 はどの入力の束にも無い
 *  - 入力の束は expl_01（2019h31h-q5・2018h30a-q2）と expl_02（2018h30a-q3・2019h31h-q6）。同一内容の組は新しい回の 2019h31h-q5 で書く
 *  - 問題解説は束と同じ名前のファイルに 2 本ずつ（計 4 本）。選択肢の用語は 9 語。用語の上書きは「受託開発」1 語
 *  - 論点は 3 つ（1 契約の種類・2 処理の分け方・3 保守の進め方）。教材は 1 と 2 だけで、世代は materials（前）と materials_v2（後）
 *  - この問題解説は、門の止める理由にも警告にも当たらない
 *  同じ写しを、ロードマップ型の itc・登録簿に無い zzz にも置く。 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

export const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const GATE = path.join(ROOT, 'scripts', 'check_explanations.py')
const SEED = path.join(ROOT, 'tests', 'fixtures', 'explanations-gate', 'ip')
export const CONTRACT = path.join(ROOT, 'docs/goals/GOAL-10-verify-content-before-delivery/UC-022-check-explanations-at-gate/contract.yaml')
const REGISTRY_FILE = 'src/shared/targets.json'

export type Json = any

/** 契約の limits の値（門が使う閾値と表示の制約の正本）。checkExplanations の response の limits の properties の行の const を読む
 *  （契約の YAML の全体は一般の YAML の読み手で読めない書き方を含むので、その行だけを読む）。 */
export const LIMITS: Json = (() => {
  const text = fs.readFileSync(CONTRACT, 'utf8')
  const op = text.slice(text.indexOf('\n  checkExplanations:'))
  const block = op.slice(op.indexOf('\n        limits:'), op.indexOf('\n    errors:'))
  const out: Record<string, number> = {}
  for (const m of block.matchAll(/^\s+([A-Za-z]+):\s*\{[^}\n]*\bconst:\s*(\d+)/gm)) out[m[1]] = Number(m[2])
  if (Object.keys(out).length === 0) throw new Error('契約の limits を読めない')
  return out
})()

export const DATA = 'data/ip'
export const explanationsFile = (bundle: string, data = DATA) => `${data}/question_explanations/${bundle}.json`
export const bundleFile = (bundle: string, data = DATA) => `${data}/explanation_bundles/${bundle}.json`

/** 過去問の本文と選択肢（仕込みのファイルから読む）。 */
export function pastQuestion(exam: string, number: number): { text: string; choices: Record<string, string> } {
  const doc = JSON.parse(fs.readFileSync(path.join(SEED, 'questions', `${exam}.json`), 'utf8'))
  return doc.questions.find((q: Json) => q.number === number)
}

export type Workspace = {
  dir: string
  abs: (rel: string) => string
  write: (rel: string, data: string | object) => void
  readJson: (rel: string) => Json
  remove: (rel: string) => void
  /** 問題解説のファイル 1 つの explanations を書き換える。 */
  editExplanations: (bundle: string, edit: (xs: Json[]) => void, data?: string) => void
  /** 入力の束 1 つ（topics[].questions[] を持つ文書）を書き換える。 */
  editBundle: (bundle: string, edit: (doc: Json) => void, data?: string) => void
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

/** 学びの写し（ip・itc・zzz）を置いた作業場を作る。 */
export function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'explanations-gate-'))
  createdWorkspaces.push(dir)
  const abs = (rel: string) => path.join(dir, rel)
  const write = (rel: string, data: string | object) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
    fs.writeFileSync(abs(rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const readJson = (rel: string) => JSON.parse(fs.readFileSync(abs(rel), 'utf8'))
  write(REGISTRY_FILE, fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8'))
  for (const key of ['ip', 'itc', 'zzz']) copyTree(SEED, abs(`data/${key}`))
  return {
    dir,
    abs,
    write,
    readJson,
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    editExplanations: (bundle, edit, data = DATA) => {
      const doc = readJson(explanationsFile(bundle, data))
      edit(doc.explanations)
      write(explanationsFile(bundle, data), doc)
    },
    editBundle: (bundle, edit, data = DATA) => {
      const doc = readJson(bundleFile(bundle, data))
      edit(doc)
      write(bundleFile(bundle, data), doc)
    },
  }
}

export type Run = {
  status: number | null
  stdout: string
  stderr: string
  json: Json
  code: string | undefined
  reason: string
  /** 標準出力の最後の空でない行を JSON として読んだ物（読めなければ undefined）。 */
  last: Json
  /** 最後の行より前の空でない行。 */
  humanLines: string[]
}

const parse = (text: string): Json => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 引数を並べて門を回す。標準出力の全体を JSON として読み、読めなければ最後の空でない行を読む。 */
export function runGate(ws: Workspace, args: string[]): Run {
  const r = spawnSync('python3', [GATE, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = r.stdout.split('\n').filter((l) => l.trim() !== '')
  const whole = parse(r.stdout.trim())
  const json = whole !== undefined && whole !== null && typeof whole === 'object' ? whole : lines.length > 0 ? parse(lines[lines.length - 1]) : undefined
  const err = json && typeof json === 'object' ? json.error : undefined
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json,
    code: err && typeof err.code === 'string' ? err.code : undefined,
    reason: err && typeof err.reason === 'string' ? err.reason : '',
    last: lines.length > 0 ? parse(lines[lines.length - 1]) : undefined,
    humanLines: lines.slice(0, -1),
  }
}

/** 契約の request の形で門を回す。 */
export const check = (ws: Workspace, data = DATA, bundles?: string) => runGate(ws, ['--data', data, ...(bundles === undefined ? [] : ['--bundles', bundles])])

export const findingsOf = (list: Json, kind: string): Json[] => (Array.isArray(list) ? list.filter((f: Json) => f && f.kind === kind) : [])
export const findingText = (f: Json) => `${f?.where ?? ''} ${f?.reason ?? ''}`
export const dump = (r: Run) => `status=${r.status}\n${r.stdout}\n${r.stderr}`.slice(0, 4000)
