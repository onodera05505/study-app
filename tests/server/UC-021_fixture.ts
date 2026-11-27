/** UC-021 の境界のテストが共有する、一時の作業場の学びの仕込みと入口の呼び方。
 *
 *  入口は契約の checkRoadmap ＝ `python3 scripts/check_roadmap.py --data <学びの置き場> [--solutions <独立解答のファイル> ...]`
 *  （CLAUDE.md の「操作 → 入口」の道具を回す操作。引数の名前は契約の request の欄の名前）。
 *  コマンドは一時の作業場を cwd にして呼び、`--data data/eng` はその中の data/eng を指す。学びの種類と見分けの語・使い方の見出し・
 *  避ける語・禁じた書き方・印の段は登録簿（src/shared/targets.json）が決めるので、リポジトリの登録簿を作業場にも写し、
 *  入口がどちらを読んでも同じになるようにする。実データの data/ は読みも書きもしない。
 *
 *  観測するのは終了の状態と、標準出力の最後の行の機械向けの 1 行（契約の response か、断りの `{"error":{"code"}}`）だけ。
 *  人が読む行の形は契約に持たないので、中身を見ない（最後の行より前にあることだけを見る）。
 *
 *  学びの仕込み（learning(key, n)）:
 *  - 単位は n 個。論点の ID は 101 から順、名前・要約・本文は作業場ごとに重ならない漢字の並び（fresh）で作る。
 *    同じ並びが 2 か所に出ないので、正解の選択肢と本文・要約の偶然の一致は起きない。数値と、登録簿の避ける語・禁じた書き方を含まない
 *  - 章で束ねる学び（eng）は 6 単位ずつの章に分け、章の中の印は高い段から並べ、最も低い段（1）を章の末尾に置く。
 *    日で束ねる学び（msg）は章・章の番号・印を持たない
 *  - 2 番目の単位は 1 番目の単位を前提に挙げる（前提は論点名）。ほかの単位は前提を持たない。到達基準は全単位 [1]
 *  - 教材と確認問題は 1 単位に 1 ファイル（bundle_NN.json。NN は学ぶ順の 2 桁）。教材の説明は「**名前**とは、…です。」と
 *    見分けの語の行（登録簿の keywordLabel）、詳しい解説は「### しくみ」と「### <登録簿の usageSection>」の 2 つの見出し。
 *    出典は集めた資料（sources/public.json）の資料の名前 1 つ
 *  - 確認問題は 1 単位に 2 問（qid は t<論点の ID>-1・-2）。正解の選択肢は誤答より 1 字短く、正解の位置は ANSWERS の並び
 *    （ア・イ・ウ・エが同じ数に近く、同じ単位の 2 問で正解の記号が重なる単位を 12 単位に 2 つ持つ）。到達基準は 1 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const GATE = path.join(ROOT, 'scripts', 'check_roadmap.py')
export const CONTRACT = path.join(ROOT, 'docs/goals/GOAL-10-verify-content-before-delivery/UC-021-check-roadmap-learning-at-gate/contract.yaml')
const REGISTRY_FILE = 'src/shared/targets.json'
export const REGISTRY: Record<string, any> = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8'))

/** 標準出力の JSON。形は契約が決め、ここでは欄を名前で読むだけ。 */
export type Json = any

/** 契約の checkRoadmap の response の limits（門が使う閾値と表示の制約の正本）。 */
export const LIMITS: Json = (() => {
  const r = spawnSync(
    'python3',
    [
      '-c',
      'import json,sys,yaml\n' +
        'p=yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["operations"]["checkRoadmap"]["response"]["properties"]["limits"]["properties"]\n' +
        'v=lambda s: s["const"] if "const" in s else {k: x["const"] for k, x in s["properties"].items()}\n' +
        'print(json.dumps({k: v(s) for k, s in p.items()}, ensure_ascii=False))',
      CONTRACT,
    ],
    { encoding: 'utf8' },
  )
  return JSON.parse(r.stdout)
})()

/** 契約の checkRoadmap の止める理由と警告の種類。 */
export const KINDS: { stops: string[]; warnings: string[] } = (() => {
  const r = spawnSync(
    'python3',
    [
      '-c',
      'import json,sys,yaml\n' +
        'p=yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["operations"]["checkRoadmap"]["response"]["properties"]\n' +
        'k=lambda n: p[n]["items"]["allOf"][1]["properties"]["kind"]["enum"]\n' +
        'print(json.dumps({"stops": k("stops"), "warnings": k("warnings")}, ensure_ascii=False))',
      CONTRACT,
    ],
    { encoding: 'utf8' },
  )
  return JSON.parse(r.stdout)
})()

export type Unit = {
  order: number
  topic_id: number
  term: string
  summary?: string
  prereq?: string[]
  round?: number
  chapter?: string
  tier?: number
  goals?: number[]
}
export type Source = { name: string; where?: string }
export type Material = { topic_id: number; term: string; explanation?: string; detail?: string; sources?: Source[]; [k: string]: unknown }
export type Question = {
  qid: string
  topic_id: number
  term: string
  stem: string
  choices: Record<string, string>
  answer: string
  reason: string
  choice_notes: Record<string, string>
  tests_goal: number
  [k: string]: unknown
}

/** 学びの置き場の仕込み。テストはこれを書き換えてから runGate で作業場に置く。 */
export type Learning = {
  key: string
  roadmap: { group_by?: string; units: Unit[] }
  /** 教材のファイル名（materials/ の下）→ 教材。 */
  materials: Record<string, Material[]>
  /** 確認問題のファイル名（roadmap_questions/ の下）→ 確認問題。 */
  questions: Record<string, Question[]>
  /** 集めた資料のファイル名（sources/ の下）→ 中身。 */
  sources: Record<string, unknown>
  /** そのまま書く文字列（学びの置き場からの相対パス → 中身）。読めないファイルの仕込みに使う。 */
  raw: Record<string, string>
  /** 置かないファイル（学びの置き場からの相対パス）。 */
  omit: string[]
  /** 作業場ごとの漢字の並び。 */
  fresh: (n: number) => string
  /** 集めた資料の資料の名前。 */
  sourceName: string
}

export const CHOICES = ['ア', 'イ', 'ウ', 'エ'] as const

/** 単位ごとの 2 問の正解の記号（12 単位で一巡。ア・イ・ウ・エが 6 回ずつ、2 問が重なる単位が 2 つ）。 */
export const ANSWERS: [string, string][] = [
  ['ア', 'イ'], ['ウ', 'エ'], ['ア', 'ア'], ['イ', 'ウ'], ['エ', 'ア'], ['イ', 'イ'],
  ['ウ', 'エ'], ['ア', 'ウ'], ['エ', 'イ'], ['ウ', 'エ'], ['ア', 'エ'], ['イ', 'ウ'],
]

/** 重ならない漢字の並びを返す関数（呼ぶたびに続きの字を返す）。 */
export function kanjiSource(): (n: number) => string {
  let next = 0x4e00
  return (n: number) => {
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCodePoint(next++)
    return s
  }
}

export const bundleName = (i: number) => `bundle_${String(i + 1).padStart(2, '0')}.json`

/** 章の大きさ s の中の印の並び（高い段から、最も低い段 1 を末尾に）。 */
function tiersOf(s: number): number[] {
  const low = Math.max(1, Math.floor(s / 3))
  const high = Math.ceil((s - low) / 2)
  return [...Array(high).fill(3), ...Array(s - low - high).fill(2), ...Array(low).fill(1)]
}

/** 教材の説明（見分けの語の行を持つ）。 */
export function explanationOf(l: Learning, term: string): string {
  const label = REGISTRY[l.key].roadmapSpec.keywordLabel
  return `**${term}**とは、${l.fresh(12)}です。\n\n- **${label}**: ${l.fresh(3)}・${l.fresh(3)}\n\n${l.fresh(20)}です。`
}

/** 詳しい解説（「しくみ」と使い方の見出し）。extra は「しくみ」の節の末尾に足す行。 */
export function detailOf(l: Learning, extra = ''): string {
  const usage = REGISTRY[l.key].roadmapSpec.usageSection
  return `### しくみ\n${l.fresh(30)}です。${extra ? `\n${extra}` : ''}\n### ${usage}\n${l.fresh(30)}です。`
}

/** 1 単位の教材。 */
export function materialOf(l: Learning, u: Unit): Material {
  return {
    topic_id: u.topic_id,
    term: u.term,
    explanation: explanationOf(l, u.term),
    detail: detailOf(l),
    sources: [{ name: l.sourceName, where: `${l.fresh(5)}の項目` }],
  }
}

/** 1 問（正解は answer。正解の選択肢は誤答より 1 字短い）。 */
export function questionOf(l: Learning, u: Unit, qid: string, answer: string): Question {
  const choices: Record<string, string> = {}
  const notes: Record<string, string> = {}
  for (const c of CHOICES) {
    choices[c] = l.fresh(c === answer ? 9 : 10)
    notes[c] = c === answer ? `正解。${l.fresh(10)}です。` : `${l.fresh(10)}です。`
  }
  return { qid, topic_id: u.topic_id, term: u.term, stem: `${l.fresh(12)}はどれか。`, choices, answer, reason: `${l.fresh(14)}です。`, choice_notes: notes, tests_goal: 1 }
}

/** 止める理由にも警告にも当たらない学び（key は登録簿のロードマップ型の学び。n は単位の数）。 */
export function learning(key: string, n = 12): Learning {
  const fresh = kanjiSource()
  const spec = REGISTRY[key]?.roadmapSpec
  const byChapter = Boolean(spec?.tiers)
  const l: Learning = {
    key,
    roadmap: byChapter ? { group_by: 'chapter', units: [] } : { units: [] },
    materials: {},
    questions: {},
    sources: {},
    raw: {},
    omit: [],
    fresh,
    sourceName: `${fresh(6)}の手引き`,
  }
  l.sources['public.json'] = { collector: 'public', sources: [{ name: l.sourceName, fetched: true }] }
  const chapterSize = 6
  for (let i = 0; i < n; i++) {
    const u: Unit = { order: i + 1, topic_id: 101 + i, term: fresh(4), summary: fresh(12), prereq: [], goals: [1] }
    if (byChapter) {
      const c = Math.floor(i / chapterSize)
      const size = Math.min(chapterSize, n - c * chapterSize)
      u.round = c + 1
      u.chapter = `章${fresh(5)}`
      u.tier = tiersOf(size)[i - c * chapterSize]
    }
    l.roadmap.units.push(u)
  }
  if (byChapter) {
    // 同じ章の単位は同じ章の名前
    for (const u of l.roadmap.units) u.chapter = l.roadmap.units.find((x) => x.round === u.round)!.chapter
  }
  if (n >= 2) l.roadmap.units[1].prereq = [l.roadmap.units[0].term]
  l.roadmap.units.forEach((u, i) => {
    l.materials[bundleName(i)] = [materialOf(l, u)]
    const [a1, a2] = ANSWERS[i % ANSWERS.length]
    l.questions[bundleName(i)] = [questionOf(l, u, `t${u.topic_id}-1`, a1), questionOf(l, u, `t${u.topic_id}-2`, a2)]
  })
  return l
}

/** 学ぶ順の i 番目（0 始まり）の単位。 */
export const unitAt = (l: Learning, i: number) => l.roadmap.units[i]
/** その単位の教材（1 単位 1 ファイルの仕込み）。 */
export const materialAt = (l: Learning, i: number) => l.materials[bundleName(i)][0]
/** その単位の確認問題。 */
export const questionsAt = (l: Learning, i: number) => l.questions[bundleName(i)]
/** 全単位の確認問題（ロードマップの単位の分）。 */
export const allQuestions = (l: Learning) => l.roadmap.units.flatMap((_, i) => l.questions[bundleName(i)] ?? [])

/** Markdown の表（rows の 1 行目がヘッダ。区切りの行はヘッダの後ろに 1 つ置く）。 */
export function table(rows: string[][], separator = true): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const out = [line(rows[0])]
  if (separator) out.push(line(rows[0].map(() => '---')))
  for (const r of rows.slice(1)) out.push(line(r))
  return out.join('\n')
}
/** cols 列 × rows 行（ヘッダを含む）の表の中身。セルは cell 字。 */
export function grid(l: Learning, cols: number, rows: number, cell = 4): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => l.fresh(cell)))
}

export type Run = { code: number; stdout: string; stderr: string; lines: string[]; json: Json | null; dir: string }

/** 作業場に学びを置く（置き場は data/<key>）。 */
export function writeLearning(dir: string, l: Learning, base = `data/${l.key}`): void {
  const put = (rel: string, content: string) => {
    if (l.omit.includes(rel)) return
    const file = path.join(dir, base, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const json = (v: unknown) => JSON.stringify(v, null, 1)
  put('roadmap.json', json(l.roadmap))
  for (const [name, ms] of Object.entries(l.materials)) put(`materials/${name}`, json({ bundle: name.replace(/\.json$/, ''), materials: ms }))
  for (const [name, qs] of Object.entries(l.questions)) put(`roadmap_questions/${name}`, json({ bundle: name.replace(/\.json$/, ''), questions: qs }))
  for (const [name, v] of Object.entries(l.sources)) put(`sources/${name}`, json(v))
  for (const [rel, content] of Object.entries(l.raw)) put(rel, content)
}

const made: string[] = []
/** 作った作業場を消す（テストの最後に呼ぶ）。 */
export function cleanupWorkspaces(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

/** 一時の作業場（登録簿の写しを持つ）。 */
export function workspace(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'uc021-'))
  made.push(dir)
  fs.mkdirSync(path.join(dir, 'src/shared'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, REGISTRY_FILE), path.join(dir, REGISTRY_FILE))
  return dir
}

/** 最後の空でない行の JSON（読めなければ null）。 */
export function lastLine(stdout: string): Json | null {
  const lines = stdout.split('\n').filter((x) => x.trim() !== '')
  if (lines.length === 0) return null
  try {
    return JSON.parse(lines[lines.length - 1])
  } catch {
    return null
  }
}

/** 作業場で門を回す。args は --data の後ろに足す引数。files は作業場に置く追加のファイル（作業場の根からの相対 → 中身。文字列でなければ JSON）。 */
export function runIn(dir: string, data: string | null, args: string[] = [], files: Record<string, unknown> = {}): Run {
  for (const [rel, v] of Object.entries(files)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 1))
  }
  const r = spawnSync('python3', [GATE, ...(data === null ? [] : ['--data', data]), ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
  const stdout = r.stdout ?? ''
  return { code: r.status ?? -1, stdout, stderr: r.stderr ?? '', lines: stdout.split('\n').filter((x) => x.trim() !== ''), json: lastLine(stdout), dir }
}

/** 学びを作業場に置いて門にかける。solutions は独立解答のファイル（data/<key>/eval/<名前> に置き、その順に渡す。文字列ならそのまま書く。null なら置かない）。 */
export function runGate(l: Learning, solutions: Record<string, unknown | null> = {}): Run {
  const dir = workspace()
  writeLearning(dir, l)
  const files: Record<string, unknown> = {}
  const paths: string[] = []
  for (const [name, v] of Object.entries(solutions)) {
    const rel = `data/${l.key}/eval/${name}`
    paths.push(rel)
    if (v !== null) files[rel] = v
  }
  return runIn(dir, `data/${l.key}`, paths.length > 0 ? ['--solutions', ...paths] : [], files)
}

/** 同じ仕込みで 1 回だけ回す（テストの間で結果を使い回す）。 */
export function once<T>(make: () => T): () => T {
  let made: { value: T } | null = null
  return () => (made ??= { value: make() }).value
}

/** 全問を正解どおりに答えた独立解答。 */
export function perfectAnswers(l: Learning): Record<string, string> {
  return Object.fromEntries(allQuestions(l).map((q) => [q.qid, q.answer]))
}
/** 正解と違う記号。 */
export const wrongOf = (answer: string) => CHOICES[(CHOICES.indexOf(answer as (typeof CHOICES)[number]) + 1) % 4]

/** 指摘の文字（where と reason）。 */
export const findingText = (f: Json) => `${f?.where ?? ''} ${f?.reason ?? ''}`
/** list の中で kind が一致し、needles のどれかを where か reason に含む指摘。 */
export function findingsAbout(list: Json[] | undefined, kind: string | null, ...needles: (string | number)[]): Json[] {
  return (list ?? []).filter((f) => (kind === null || f?.kind === kind) && (needles.length === 0 || needles.some((n) => findingText(f).includes(String(n)))))
}
/** 単位を指す語（論点名と論点の ID）。 */
export const unitNeedles = (u: { topic_id: number; term: string }) => [u.term, String(u.topic_id)]

/** 断りの名前（標準出力の全体の JSON か最後の行の JSON の error.code）。 */
export function errorCode(r: Run): string | null {
  const read = (text: string) => {
    try {
      const code = JSON.parse(text)?.error?.code
      return typeof code === 'string' ? code : null
    } catch {
      return null
    }
  }
  return read(r.stdout.trim()) ?? (r.lines.length > 0 ? read(r.lines[r.lines.length - 1]) : null)
}

// ---- テストが共有する仕込み（同じ仕込みで確かめられるクラスは 1 回の実行の結果を使い回す） ----

/** 止める理由の無い eng（12 単位）。2 番目の単位の詳しい解説が 1 番目の単位の論点名を用語として示す。 */
export function cleanEng(): Learning {
  const l = learning('eng', 12)
  materialAt(l, 1).detail = detailOf(l, `[[${unitAt(l, 0).term}]]は${l.fresh(6)}です。`)
  return l
}

/** 止める理由の無い msg（日で束ねる・印を持たない。6 単位）。 */
export const cleanMsg = (): Learning => learning('msg', 6)

/** 学ぶ順の i 番目の単位に当てた止める理由（STOP_DEFECTS の並び）。 */
export const STOP_DEFECTS = [
  'noKeywordLine', 'noMechanismHeading', 'emptyExplanation', 'noDetailField', 'termMismatch', 'noMaterial', 'duplicateMaterial',
  'tableWithoutSeparator', 'tableUneven', 'headingShallower', 'headingDeeper', 'unknownSourceName', 'generalKnowledgeSource',
  'unresolvedTerm', 'prereqAfter', 'noSummary', 'emptySummary', 'noRound', 'noChapter', 'noTier', 'tierOutside',
  'choicesNotFour', 'answerOutside', 'correctNoteNotSeikai', 'unknownGoal', 'threeQuestions', 'oneQuestion', 'duplicateQid',
] as const
export type StopDefect = (typeof STOP_DEFECTS)[number]
/** 止める理由を当てた単位の学ぶ順の番号（0 始まり）。 */
export const stopAt = (d: StopDefect) => STOP_DEFECTS.indexOf(d)
/** 読めない教材のファイルと確認問題のファイルの名前。 */
export const BROKEN_MATERIAL_FILE = 'bundle_mbroken.json'
export const BROKEN_QUESTION_FILE = 'bundle_qbroken.json'
export const DUPLICATE_MATERIAL_FILE = 'bundle_dup.json'

/** 1 単位に 1 つずつ止める理由を当てた eng（28 単位）と、読めない教材と確認問題のファイル。 */
export function stoppedEng(): Learning {
  const l = learning('eng', STOP_DEFECTS.length)
  const u = (d: StopDefect) => unitAt(l, stopAt(d))
  const m = (d: StopDefect) => materialAt(l, stopAt(d))
  const qs = (d: StopDefect) => questionsAt(l, stopAt(d))
  const label = REGISTRY.eng.roadmapSpec.keywordLabel
  m('noKeywordLine').explanation = m('noKeywordLine').explanation!.replace(new RegExp(`\\n\\n- \\*\\*${label}\\*\\*: [^\\n]*`), '')
  m('noMechanismHeading').detail = m('noMechanismHeading').detail!.replace('### しくみ\n', `### ${l.fresh(4)}\n`)
  m('emptyExplanation').explanation = ''
  delete m('noDetailField').detail
  m('termMismatch').term = l.fresh(4)
  delete l.materials[bundleName(stopAt('noMaterial'))]
  l.materials[DUPLICATE_MATERIAL_FILE] = [materialOf(l, u('duplicateMaterial'))]
  m('tableWithoutSeparator').detail = detailOf(l, table(grid(l, 2, 3), false))
  m('tableUneven').detail = detailOf(l, `${table(grid(l, 3, 3))}\n| ${l.fresh(4)} | ${l.fresh(4)} |`)
  m('headingShallower').detail += `\n## ${l.fresh(4)}\n${l.fresh(10)}です。`
  m('headingDeeper').detail += `\n#### ${l.fresh(4)}\n${l.fresh(10)}です。`
  m('unknownSourceName').sources = [{ name: `${l.fresh(6)}の記録`, where: `${l.fresh(5)}の項目` }]
  m('generalKnowledgeSource').sources = [{ name: '一般常識', where: `${l.fresh(5)}の項目` }]
  m('unresolvedTerm').detail = detailOf(l, `[[${l.fresh(4)}]]は${l.fresh(6)}です。`)
  u('prereqAfter').prereq = [u('tierOutside').term]
  delete u('noSummary').summary
  u('emptySummary').summary = ''
  delete u('noRound').round
  delete u('noChapter').chapter
  delete u('noTier').tier
  u('tierOutside').tier = 7
  delete qs('choicesNotFour')[0].choices['エ']
  delete qs('choicesNotFour')[0].choice_notes['エ']
  if (qs('choicesNotFour')[0].answer === 'エ') qs('choicesNotFour')[0].answer = 'ア'
  qs('answerOutside')[0].answer = 'オ'
  {
    const q = qs('correctNoteNotSeikai')[0]
    const wrong = wrongOf(q.answer)
    q.choice_notes[q.answer] = `${l.fresh(10)}です。`
    q.choice_notes[wrong] = `正解。${l.fresh(10)}です。`
  }
  qs('unknownGoal')[0].tests_goal = 99
  {
    const t = u('threeQuestions')
    qs('threeQuestions').push(questionOf(l, t, `t${t.topic_id}-3`, 'ウ'))
  }
  qs('oneQuestion').pop()
  qs('duplicateQid')[1].qid = qs('duplicateQid')[0].qid
  l.raw[`materials/${BROKEN_MATERIAL_FILE}`] = '{"bundle": "bundle_mbroken", "materials": ['
  l.raw[`roadmap_questions/${BROKEN_QUESTION_FILE}`] = '{"bundle": "bundle_qbroken", "questions": ['
  return l
}

/** 学ぶ順の i 番目の単位に当てた、登録簿が禁じた書き方（msg の bannedPatterns の重さの断定）。 */
export const BANNED_AT = ['material', 'summary', 'correctChoice', 'correctNote', 'wrongChoice'] as const
export type BannedPlace = (typeof BANNED_AT)[number]
export const bannedAt = (p: BannedPlace) => BANNED_AT.indexOf(p)
/** 禁じた書き方の正規表現（重さの断定）と、登録簿が書いた禁じた理由。 */
export const BANNED = (() => {
  const patterns: Record<string, string> = REGISTRY.msg.roadmapSpec.bannedPatterns
  const key = Object.keys(patterns).find((k) => k.includes('kg'))!
  return { text: '5kg', reason: patterns[key] }
})()

/** 禁じた書き方を、教材・要約・正解の選択肢・正解の説明・誤答の選択肢に 1 つずつ当てた msg（6 単位）。 */
export function bannedMsg(): Learning {
  const l = learning('msg', 6)
  const i = bannedAt
  materialAt(l, i('material')).explanation = explanationOf(l, unitAt(l, i('material')).term).replace(/です。$/, `${BANNED.text}です。`)
  unitAt(l, i('summary')).summary = `${l.fresh(6)}${BANNED.text}${l.fresh(4)}`
  {
    const q = questionsAt(l, i('correctChoice'))[0]
    q.choices[q.answer] = `${l.fresh(4)}${BANNED.text}${l.fresh(2)}`
  }
  {
    const q = questionsAt(l, i('correctNote'))[0]
    q.choice_notes[q.answer] = `正解。${l.fresh(4)}${BANNED.text}${l.fresh(4)}です。`
  }
  {
    const q = questionsAt(l, i('wrongChoice'))[0]
    q.choices[wrongOf(q.answer)] = `${l.fresh(4)}${BANNED.text}${l.fresh(3)}`
  }
  return l
}

/** 学ぶ順の i 番目の単位に当てた、止めずに警告する書き方（WARN_AT の並び）。 */
export const WARN_AT = [
  'avoidWordInMaterial', 'avoidWordInSummary', 'usageSectionMissing', 'unclosedEmphasis', 'tableTooWide', 'tableTooNarrow',
  'tableTooShort', 'tableTooLong', 'tableCellLong', 'prereqUnknown',
] as const
export type WarnPlace = (typeof WARN_AT)[number]
export const warnAt = (p: WarnPlace) => WARN_AT.indexOf(p)

/** 止めずに警告する書き方を 1 単位に 1 つずつ当てた eng（12 単位）。2 番目の章（学ぶ順 7〜12）は最も低い段が末尾にそろわない。 */
export function warnedEng(): Learning {
  const l = learning('eng', 12)
  const w = (p: WarnPlace) => materialAt(l, warnAt(p))
  const avoid = REGISTRY.eng.roadmapSpec.ngWords[0] as string
  w('avoidWordInMaterial').explanation = w('avoidWordInMaterial').explanation!.replace(/です。$/, `${avoid}の${l.fresh(4)}です。`)
  unitAt(l, warnAt('avoidWordInSummary')).summary = `${l.fresh(5)}${REGISTRY.eng.roadmapSpec.ngWords[1]}${l.fresh(5)}`
  w('usageSectionMissing').detail = `### しくみ\n${l.fresh(30)}です。\n${l.fresh(30)}です。`
  w('unclosedEmphasis').explanation = w('unclosedEmphasis').explanation!.replace(/です。$/, `です。**${l.fresh(6)}です。`)
  const cols = LIMITS.tableColumns
  const rows = LIMITS.tableRows
  w('tableTooWide').detail = detailOf(l, table(grid(l, cols.max + 1, 3)))
  w('tableTooNarrow').detail = detailOf(l, table(grid(l, cols.min - 1, 3)))
  w('tableTooShort').detail = detailOf(l, table(grid(l, 2, rows.min - 1)))
  w('tableTooLong').detail = detailOf(l, table(grid(l, 2, rows.max + 1)))
  {
    const g = grid(l, 2, 3)
    g[2][1] = l.fresh(LIMITS.tableCellLength + 1)
    w('tableCellLong').detail = detailOf(l, table(g))
  }
  unitAt(l, warnAt('prereqUnknown')).prereq = [l.fresh(4)]
  // 2 番目の章: 印の並び 3,3,2,2,1,1 を 1,3,2,2,1,3 にする
  unitAt(l, 6).tier = 1
  unitAt(l, 11).tier = 3
  return l
}

/** 情報の量の両端と、表示の制約のちょうど境目の表と、集計の名前の出典を持つ eng（12 単位）。 */
export const ACCEPT_AT = ['long', 'short', 'manyItems', 'tableAtMax', 'tableAtMin', 'tallySource', 'tallySourceWithKey'] as const
export type AcceptPlace = (typeof ACCEPT_AT)[number]
export const acceptAt = (p: AcceptPlace) => ACCEPT_AT.indexOf(p)
export function acceptedEng(): Learning {
  const l = learning('eng', 12)
  const a = (p: AcceptPlace) => materialAt(l, acceptAt(p))
  const usage = REGISTRY.eng.roadmapSpec.usageSection
  const label = REGISTRY.eng.roadmapSpec.keywordLabel
  {
    const m = a('long')
    const t = unitAt(l, acceptAt('long'))
    m.explanation = `${explanationOf(l, t.term)}\n\n${Array.from({ length: 60 }, () => `${l.fresh(40)}です。`).join('')}`
    m.detail = `### しくみ\n${Array.from({ length: 40 }, () => `${l.fresh(40)}です。`).join('')}\n${Array.from({ length: 8 }, () => `### ${l.fresh(5)}\n${l.fresh(60)}です。`).join('\n')}\n### ${usage}\n${Array.from({ length: 20 }, () => `${l.fresh(40)}です。`).join('')}`
    t.summary = l.fresh(200)
  }
  {
    const m = a('short')
    const t = unitAt(l, acceptAt('short'))
    m.explanation = `**${t.term}**とは、${l.fresh(2)}です。\n\n- **${label}**: ${l.fresh(2)}`
    m.detail = `### しくみ\n${l.fresh(2)}です。\n### ${usage}\n${l.fresh(2)}です。`
    t.summary = l.fresh(2)
  }
  a('manyItems').detail = detailOf(
    l,
    `${Array.from({ length: 30 }, () => `- ${l.fresh(8)}です。`).join('\n')}\n${Array.from({ length: 20 }, () => `- **${l.fresh(3)}** — ${l.fresh(8)}です。`).join('\n')}`,
  )
  {
    const g = grid(l, LIMITS.tableColumns.max, LIMITS.tableRows.max)
    g[3][2] = l.fresh(LIMITS.tableCellLength)
    a('tableAtMax').detail = detailOf(l, table(g))
  }
  a('tableAtMin').detail = detailOf(l, table(grid(l, LIMITS.tableColumns.min, LIMITS.tableRows.min)))
  a('tallySource').sources = [{ name: `${l.fresh(4)}の集計`, where: `${l.fresh(5)}の項目` }]
  a('tallySourceWithKey').sources = [{ name: `${l.fresh(4)}の集計（public）`, where: `${l.fresh(5)}の項目` }]
  return l
}

/** ロードマップの外の補足の論点（論点の ID 900）。 */
export const SUPPLEMENT = { topic_id: 900, file: 'bundle_supp.json' }
/** 補足の論点の教材と確認問題 2 問を足す（論点名はロードマップに無い）。 */
export function addSupplement(l: Learning): Unit {
  const s: Unit = { order: 0, topic_id: SUPPLEMENT.topic_id, term: l.fresh(4) }
  l.materials[SUPPLEMENT.file] = [materialOf(l, s)]
  l.questions[SUPPLEMENT.file] = [questionOf(l, s, `t${s.topic_id}-1`, 'イ'), questionOf(l, s, `t${s.topic_id}-2`, 'ウ')]
  return s
}

/** 確認問題の手がかりを持つ eng（n 単位）。どの単位も 1 問目の正解がア・2 問目はア以外（2 問の正解が重ならない）、
 *  正解の選択肢がいつも最も長い。verbatim なら 1 番目の単位の 1 問目の正解が教材の説明と、2 番目の単位の 1 問目の正解が要約と
 *  verbatimLength + 2 字続けて一致する。 */
export function cluedEng(n: number, verbatim: boolean): Learning {
  const l = learning('eng', n)
  l.roadmap.units.forEach((u, i) => {
    const second = ['イ', 'ウ', 'エ'][i % 3]
    const qs = [questionOf(l, u, `t${u.topic_id}-1`, 'ア'), questionOf(l, u, `t${u.topic_id}-2`, second)]
    for (const q of qs) q.choices[q.answer] = l.fresh(12)
    l.questions[bundleName(i)] = qs
  })
  if (verbatim) {
    const body = l.fresh(LIMITS.verbatimLength + 2)
    const m = materialAt(l, 0)
    m.explanation = m.explanation!.replace(/です。$/, `です。${body}です。`)
    const q0 = questionsAt(l, 0)[0]
    q0.choices[q0.answer] = body
    const summary = l.fresh(LIMITS.verbatimLength + 2)
    unitAt(l, 1).summary = summary
    const q1 = questionsAt(l, 1)[0]
    q1.choices[q1.answer] = summary
  }
  return l
}

/** k 問の答えを正解と違う記号に、blank 問の答えを書かない独立解答（ロードマップの単位の問題の先頭から）。 */
export function answersWith(l: Learning, wrong: number, blank = 0): { solver: string; answers: Record<string, string> } {
  const answers = perfectAnswers(l)
  const qids = allQuestions(l).map((q) => q.qid)
  qids.slice(0, wrong).forEach((qid) => (answers[qid] = wrongOf(answers[qid])))
  qids.slice(wrong, wrong + blank).forEach((qid) => delete answers[qid])
  return { solver: 'X', answers }
}
