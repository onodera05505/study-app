/**
 * 作り手の道具の門と束を作る道具（UC-024・UC-025・UC-026 の inbound）の受け持ちが共有する部品。
 *
 * - 学びの置き場の写しは、実例ごとの影の根（kit/tool.ts の shadowRoot）に、契約の request が名指す
 *   `data/<key>` の下へ毎回作る。実データの data/ は読みも書きもしない（REQ-570）。
 * - 学びの種類は登録簿（src/shared/targets.json）が決めるので、登録簿は影の根にも同じパスで写す。
 * - 道具は `python3 <リポジトリ>/scripts/<道具>.py` を、影の根を作業ディレクトリにして回す（契約: パスは相対なら
 *   コマンドを呼んだ作業ディレクトリが起点）。環境変数は親のものをそのまま引き継ぐ。
 * - 門（UC-024・UC-025）は止める理由があると終了の状態 1 で応答を返す（契約の exitCode）。断りの名前の読み方は
 *   kit/tool.ts の toolErrorCode（CLAUDE.md の「操作 → 入口」）と同じ。
 */

import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Unanswerable, type Answer } from './protocol'
import { REPO_ROOT, runTool, shadowRoot, toolErrorCode, unnamedStop, type Shadow, type ToolRun } from './tool'

/** 登録簿のパス（リポジトリの根からの相対）。 */
export const REGISTRY = 'src/shared/targets.json'

/** シラバスの単元（中項目）。items は小項目の番号。 */
export type SyllabusUnit = { no: number; name: string; items: number[] }
/** 論点。item は小項目の番号。questions は紐づく過去問（回の ID と問番号）。 */
export type TopicSeed = { id: number; term: string; item: number; questions?: { exam: string; number: number }[] }
/** 学びの置き場のシラバスと論点の一覧の仕込み。 */
export type Learning = { units: SyllabusUnit[]; topics: TopicSeed[] }

/** 単元の構成のまとまり。 */
export type PlanGroup = { name: string; description: string; topics: number[] }
/** 単元の構成（UC-024 の契約 UnitPlan）。 */
export type UnitPlan = {
  unit_no: number
  unit: string
  overview: string
  groups: PlanGroup[]
  owners: { subject: string; owner: number; topics: number[] }[]
  prerequisites?: Record<string, number[]>
}

/**
 * 呼ぶたびに前と重ならない漢字の並びを返す関数を作る（本文どうしの偶然の一致・数値・問われ方の言い回しを含まない）。
 * @implements REQ-570
 */
export function kanjiSource(): (n: number) => string {
  let next = 0x4e00
  return (n: number) => {
    let s = ''
    for (let i = 0; i < n; i++) {
      if (next > 0x9fff) throw new Unanswerable('仕込みの漢字が尽きた')
      s += String.fromCodePoint(next++)
    }
    return s
  }
}

/**
 * 連番の論点 ID を sizes の数ずつに分ける（並びがまとまりの学ぶ順）。
 * @implements REQ-570
 */
export function chunk(ids: number[], sizes: number[]): number[][] {
  const out: number[][] = []
  let at = 0
  for (const size of sizes) {
    out.push(ids.slice(at, at + size))
    at += size
  }
  if (at !== ids.length) throw new Unanswerable(`仕込みの論点 ${ids.length} 個をまとまり ${sizes.join('+')} に分けきれない`)
  return out
}

/**
 * from から n 個の連番。
 * @implements REQ-570
 */
export function range(from: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i)
}

/**
 * まとまりの論点の並びから単元の構成を組む（受け持ちは無し）。
 * @implements REQ-570
 */
export function planOf(unit: SyllabusUnit, groups: number[][], prerequisites?: Record<string, number[]>): UnitPlan {
  const plan: UnitPlan = {
    unit_no: unit.no,
    unit: unit.name,
    overview: `${unit.name}の全体像の文です。`,
    groups: groups.map((topics, i) => ({ name: `まとまり${i + 1}`, description: `まとまり${i + 1}の説明です。`, topics })),
    owners: [],
  }
  if (prerequisites) plan.prerequisites = prerequisites
  return plan
}

/**
 * 単元の構成のファイルのパス（単元の番号 2 桁）。
 * @implements REQ-570
 */
export function planPath(key: string, unitNo: number): string {
  return `data/${key}/unit_plans/${String(unitNo).padStart(2, '0')}.json`
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

/**
 * 影の根の data/<key> にシラバス・論点の一覧・論点 ID の表を置く。
 * @implements REQ-570
 */
export async function writeLearning(shadow: Shadow, key: string, learning: Learning): Promise<void> {
  const unitOfItem = (item: number) => {
    const unit = learning.units.find((u) => u.items.includes(item))
    if (!unit) throw new Unanswerable(`仕込みの小項目 ${item} がどの単元にも無い`)
    return unit
  }
  const field = '分野甲'
  const major = '大項目甲'
  await shadow.write(
    `data/${key}/syllabus.json`,
    json({
      version: '仕込み',
      items: learning.units.flatMap((u) =>
        u.items.map((number) => ({ number, name: `小項目${number}`, field, major_no: 1, major, middle_no: u.no, middle: u.name, terms: [] })),
      ),
    }),
  )
  const exams = [...new Set(learning.topics.flatMap((t) => (t.questions ?? []).map((q) => q.exam)))]
  await shadow.write(
    `data/${key}/topics.json`,
    json({
      topic_count: learning.topics.length,
      question_count: learning.topics.reduce((n, t) => n + (t.questions ?? []).length, 0),
      exams,
      topics: learning.topics.map((t) => ({
        id: t.id,
        term: t.term,
        match_key: `key${t.id}`,
        syllabus_item: t.item,
        syllabus_item_name: `小項目${t.item}`,
        field,
        major,
        middle: unitOfItem(t.item).name,
        is_new: false,
        related_terms: [],
        question_count: (t.questions ?? []).length,
        questions: (t.questions ?? []).map((q) => ({ ...q, confidence: 'high' })),
      })),
    }),
  )
  await shadow.write(`data/${key}/topic_ids.json`, json(Object.fromEntries(learning.topics.map((t) => [`key${t.id}`, t.id]))))
}

/**
 * 単元の構成を置く。
 * @implements REQ-570
 */
export async function writePlan(shadow: Shadow, key: string, plan: UnitPlan): Promise<void> {
  await shadow.write(planPath(key, plan.unit_no), json(plan))
}

/**
 * JSON の値をファイルに置く。
 * @implements REQ-570
 */
export async function writeJson(shadow: Shadow, rel: string, value: unknown): Promise<void> {
  await shadow.write(rel, json(value))
}

/**
 * 影の根のファイルを除く。
 * @implements REQ-570
 */
export async function removeFile(shadow: Shadow, rel: string): Promise<void> {
  await rm(shadow.path(rel), { recursive: true, force: true })
}

/**
 * 同一内容の判定の鍵（UC-026 の契約 questions[].content_key の作り方）。
 * @implements REQ-570
 */
export function contentKeyOf(text: string, choices: Record<string, string>): string {
  return createHash('sha1')
    .update([text, choices['ア'], choices['イ'], choices['ウ'], choices['エ']].join('').replace(/\s/g, ''), 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/**
 * 登録簿を写した影の根を作り、body に渡して、終わったら片付ける。
 * @implements REQ-569, REQ-570
 */
export async function inShadow<T>(body: (shadow: Shadow) => Promise<T>): Promise<T> {
  const shadow = await shadowRoot({ copy: [REGISTRY] })
  try {
    return await body(shadow)
  } finally {
    await shadow.cleanup()
  }
}

/**
 * `scripts/<script>` を影の根を作業ディレクトリにして回す（親の環境変数を引き継ぐ）。
 * @implements REQ-567, REQ-570
 */
export function runScript(shadow: Shadow, script: string, args: string[]): Promise<ToolRun> {
  return runTool(['python3', join(REPO_ROOT, 'scripts', script), ...args], { cwd: shadow.root, env: process.env, timeoutMs: 60_000 })
}

function parseObject(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout.trim()) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 道具を回した結果を答えに読む。断りの名前があれば断り。終了の状態が okCodes のどれかで標準出力の全体が JSON の
 * オブジェクトなら、それをそのまま応答にする。名前を出さずに 0 でない終了の状態で止まったときは unnamedStop の答え
 * （終了の状態を持つ応答）。終了の状態 0 で JSON のオブジェクトを出さなければ Unanswerable を投げる。
 * 門（UC-024・UC-025）は止める理由ありの 1 も応答（契約の exitCode）なので okCodes に 0 と 1 を渡す。
 * @implements REQ-567, REQ-568, BR-064
 */
export function answerOf(run: ToolRun, okCodes: number[]): Answer {
  const code = toolErrorCode(run.stdout)
  if (code !== null) return { error: code }
  if (okCodes.includes(run.code)) {
    const response = parseObject(run.stdout)
    if (response !== null) return { response }
    if (run.code !== 0) return unnamedStop(run)
    throw new Unanswerable(`道具の標準出力が JSON のオブジェクトでない（終了の状態 ${run.code}）: ${run.stdout.trim().slice(0, 200)}`)
  }
  return unnamedStop(run)
}

/**
 * 実例の request から文字列の欄を読む（無ければ undefined）。
 * @implements REQ-567
 */
export function field(request: Record<string, unknown> | null, name: string): string | undefined {
  const value = request?.[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * request の data（`data/<key>`）から学びの key を読む。
 * @implements REQ-567
 */
export function keyOf(request: Record<string, unknown> | null): string {
  const data = field(request, 'data')
  const m = data?.match(/^data\/([a-z]+)$/)
  if (!m) throw new Unanswerable(`request の data が契約の形でない: ${JSON.stringify(request)}`)
  return m[1]
}
