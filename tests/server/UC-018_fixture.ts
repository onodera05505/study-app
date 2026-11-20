/** UC-018（資格対策の教材の門）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: checkMaterials ＝ `python3 scripts/check_materials.py`。
 *  request の各欄は同じ名前の引数（dir は値を並べる。all は名前だけ）。結果は標準出力の最後の行の JSON（契約の response）、
 *  断ったときは標準出力の ToolError（`error.code`）。
 *
 *  囲いは UC-039 の土台（UC-039_fixture.ts の shadow39・runTool）をそのまま使う（外への接続と作業ツリー・本体への書き込みを断つ）。
 *  門には、影の根の中の作業の置き場 `w/` に作った小さな学び（登録簿の資格対策の学び ip の key を借りた `w/data/ip`）と、
 *  図の配信の置き場 `w/public` を渡す。原本の data/ は読まない・書き換えない。
 *
 *  手本の教材（goodMaterial）は、役割分担後の世代（materials_v3）で止める理由にも警告にも当たらない形:
 *  説明は太字の論点名で始まり、キーワードの行を持つ。詳しい解説は「### 」の見出しと敬体の箇条書きを持ち、記法は契約の許す物だけ。 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { redact, removeShadows, runTool, shadow39, type Run, type Shadow39 } from './UC-039_fixture'

export { removeShadows }

export type Json = Record<string, any>
export type Material = { topic_id: number; term?: string; explanation?: string; detail?: string; [k: string]: unknown }
export type Finding = { kind: string; where: string; reason: string }
export type GateResult = { exitCode: number; topics: number; missingTopics: number[]; stops: Finding[]; warnings: Finding[]; limits: Json }

/** 学びの置き場（登録簿の資格対策の学び ip の key を借りる）。 */
export const DATA = 'w/data/ip'
export const PUBLIC = 'w/public'

/** 学びの論点。 */
export const TOPICS = [
  { id: 1, term: '記憶装置' },
  { id: 2, term: '演算装置' },
  { id: 3, term: '制御装置' },
]

/** 過去問の本文（引用の一致を見る相手。60 字以上）。 */
export const QUESTION_TEXT = 'コンピュータの五大装置のうち、プログラムの命令を解読して各装置に指示を出す装置として、最も適切なものはどれか。'

/** 止める理由にも警告にも当たらない教材。 */
export function goodMaterial(id: number, term = TOPICS.find((t) => t.id === id)?.term ?? `論点${id}`): Material {
  return {
    topic_id: id,
    term,
    explanation: `**${term}**とは、データを扱う装置の一つです。\n**キーワード**：装置・働き`,
    detail: `### しくみ\n${term}は、決められた手順で働きます。\n\n- 入力を受け取ります\n- 結果を渡します`,
  }
}

export type Learning = {
  s: Shadow39
  /** 学びの置き場の中のファイルを書く（JSON はオブジェクトで渡す）。 */
  put: (rel: string, value: unknown) => void
  remove: (rel: string) => void
  /** 教材の世代の置き場の 1 つのファイルに教材を置く。 */
  materials: (generation: string, file: string, list: Material[]) => void
}

/** 小さな資格対策の学びを作る（論点 3 つ・過去問 1 回分・役割分担後の世代 materials_v3 に手本の教材）。 */
export function makeLearning(name: string, opts: { materials?: boolean } = {}): Learning {
  const s = shadow39(`uc018-${name}`)
  const write = (rel: string, value: unknown) => {
    const at = s.path(rel)
    mkdirSync(dirname(at), { recursive: true })
    rmSync(at, { force: true })
    writeFileSync(at, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }
  const put = (rel: string, value: unknown) => write(`${DATA}/${rel}`, value)
  put('topics.json', { topics: TOPICS.map((t) => ({ ...t, question_count: 1 })) })
  put('questions/2024r06.json', { exam: '2024r06', questions: [{ number: 1, text: QUESTION_TEXT, choices: { ア: 'a', イ: 'b', ウ: 'c', エ: 'd' } }] })
  mkdirSync(s.path(`${PUBLIC}/figures/materials/ip`), { recursive: true })
  const materials = (generation: string, file: string, list: Material[]) => put(`${generation}/${file}`, { materials: list })
  if (opts.materials !== false) materials('materials_v3', '01-1.json', TOPICS.map((t) => goodMaterial(t.id)))
  return { s, put, remove: (rel) => rmSync(s.path(`${DATA}/${rel}`), { recursive: true, force: true }), materials }
}

export type GateRun = Run & { result: GateResult | null; lines: string[]; refusal: Json | undefined }

const lastJson = (text: string): Json | null => {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  try {
    return lines.length ? (JSON.parse(lines[lines.length - 1]) as Json) : null
  } catch {
    return null
  }
}

/** 門を回す（作業の場所は影の根）。args を与えなければ `--data w/data/ip --public w/public`。 */
export async function gate(l: Learning, args?: string[]): Promise<GateRun> {
  const r = await runTool(l.s, 'check_materials.py', args ?? ['--data', DATA, '--public', PUBLIC])
  // runTool の out は標準出力と標準エラーを合わせた物なので、機械向けの行は最後の JSON の行として読む
  const lines = r.out.split('\n').filter((x) => x.trim() !== '')
  const jsonLines = lines.filter((x) => x.trim().startsWith('{'))
  const last = jsonLines.length ? lastJson(jsonLines[jsonLines.length - 1]) : null
  const result = last && typeof last.exitCode === 'number' ? (last as GateResult) : null
  const refusal = last && last.error && typeof last.error === 'object' ? (last.error as Json) : undefined
  return { ...r, result, lines, refusal }
}

export const outOf = (r: Run) => `終了 ${r.code}\n${redact(r.out)}`
export const kinds = (fs: Finding[] | undefined) => (fs ?? []).map((f) => f.kind)
/** 種類 kind の指摘のうち、where か reason に needle を含む物。 */
export const findings = (fs: Finding[] | undefined, kind: string, needle?: string) =>
  (fs ?? []).filter((f) => f.kind === kind && (needle === undefined || `${f.where} ${f.reason}`.includes(needle)))
export const exists = (l: Learning, rel: string) => existsSync(l.s.path(rel))
