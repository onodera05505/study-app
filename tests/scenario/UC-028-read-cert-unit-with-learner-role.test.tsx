/** UC-028「資格対策の単元を利用者と同じ見え方の読み物にして学習者役に通読させる」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止まる場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時の作業場に置き、そこを作業の場所にして契約の入口 buildUnitReading をコマンドとして呼ぶ。
 *  契約の data・out は作業の場所からの相対の道で、学びは登録簿にある資格対策の学びの ip、単元は 21。
 *  学びの置き場（PDF とページの画像を除く）と配信の図の置き場は、ip の今のデータをそのまま写したものを使う。
 *  学習者役への単元の通読の指示は雛形 scripts/prompts/rewrite_unit_learner.md から埋める。
 *  学習者役が読んで報告を返す手順は機械で行えないので、学習者役が単元の読み物だけで読み通せること
 *  （読み物の図の行が出力先の中の画像だけを指すこと）を確かめるところまでを写す。 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '')
const LEARNING = 'ip'
const DATA = `data/${LEARNING}`
const UNIT = '21'
const OUT = `../unit_readings/${LEARNING}_${UNIT}`
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

type UnitPlan = {
  unit: string
  overview: string
  groups: { name: string; description: string; topics: number[] }[]
  prerequisites: Record<string, number[]>
}
type Topic = { id: number; term: string; question_count: number }
type FigureSpec = { figures: { id: number; after: string; caption: string }[] }
type ReadingItem = { no: number; topic_id: number; term: string; generation: string }
type Built = { reading: string; figures: string[]; items: ReadingItem[] }

/** 一時の作業場の親（出力先 ../unit_readings はこの下に入る）。 */
let base = ''
/** 作業の場所（data/・public/ を持つ置き場の根）。 */
let root = ''

/** 作業の場所でコマンドを呼び、終了コードと標準出力の JSON を返す。 */
function run(script: string, args: string[]): { status: number | null; json: unknown; stdout: string; stderr: string } {
  const p = spawnSync('python3', [join(REPO, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 300_000 })
  let json: unknown = null
  try {
    json = JSON.parse(p.stdout)
  } catch {
    json = null
  }
  return { status: p.status, json, stdout: p.stdout ?? '', stderr: `${p.stderr ?? ''}${p.error ? String(p.error) : ''}` }
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as T
}

/** BR-051 の出題回数の印（出題頻度が 0 の論点は印を持たない）。 */
function frequencyMark(count: number): string {
  if (count >= 3) return '★★★'
  if (count === 2) return '★★'
  if (count === 1) return '★'
  return ''
}

/** 文字列の中に部分文字列が現れる回数。 */
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'uc028-scenario-'))
  root = join(base, 'repo')
  const src = join(REPO, DATA)
  const skip = new Set([join(src, 'pdfs'), join(src, 'pages')])
  cpSync(src, join(root, DATA), { recursive: true, filter: (s) => !skip.has(s) })
  cpSync(join(REPO, 'public/figures/materials', LEARNING), join(root, 'public/figures/materials', LEARNING), { recursive: true })
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  cpSync(join(REPO, 'src/shared/targets.json'), join(root, 'src/shared/targets.json'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('UC-028 資格対策の単元を利用者と同じ見え方の読み物にして学習者役に通読させる', () => {
  // @scenario UC-028
  it('資格対策の単元の読み物と図の画像を作り、項目の番号ごとの論点と世代を受け取り、通読の指示を埋めて学習者役に渡せる形にする', () => {
    const plan = readJson<UnitPlan>(`${DATA}/unit_plans/${UNIT}.json`)
    const topics = new Map(readJson<{ topics: Topic[] }>(`${DATA}/topics.json`).topics.map((t) => [t.id, t]))
    const order = plan.groups.flatMap((g) => g.topics)
    const outAbs = join(root, OUT)
    expect(existsSync(outAbs), '事前条件: 出力先が既にある').toBe(false)

    // step 1: 作り手が、学びと単元と出力先を指定して単元の読み物を作る
    const built = run('build_unit_reading.py', ['--data', DATA, '--unit', UNIT, '--out', OUT])
    expect(built.status, `単元の読み物を作れなかった: ${built.stdout} ${built.stderr}`).toBe(0)
    const result = built.json as Built
    expect(result, '単元の読み物を作った結果が標準出力の JSON に無い').not.toBeNull()

    // step 2: システムが、単元の構成が単元の構成の門の止める理由に当たらないことを確かめる（通れば断らずに作る）
    expect((result as unknown as { error?: unknown }).error, '門を通る単元の構成なのに断った').toBeUndefined()
    expect(result.reading).toBe('reading.md')
    const readingPath = join(outAbs, result.reading)
    expect(existsSync(readingPath), '単元の読み物が出力先に無い').toBe(true)
    const reading = readFileSync(readingPath, 'utf8')

    // step 3: システムが、単元の構成の順に、全体像・まとまり・論点の名前と出題回数の印・前提の論点を並べる
    expect(occurrences(reading, plan.overview), '単元の全体像が 1 回だけ置かれていない').toBe(1)
    let cursor = reading.indexOf(plan.overview)
    for (const g of plan.groups) {
      const at = reading.indexOf(g.name, cursor)
      expect(at, `まとまり「${g.name}」が単元の構成の順に無い`).toBeGreaterThan(cursor)
      expect(reading, `まとまり「${g.name}」の説明が無い`).toContain(g.description)
      cursor = at
    }
    for (const id of order) {
      const t = topics.get(id)!
      expect(reading, `論点の名前「${t.term}」が無い`).toContain(t.term)
      const mark = frequencyMark(t.question_count)
      if (mark) expect(reading, `出題頻度 ${t.question_count} の論点「${t.term}」の出題回数の印 ${mark} が無い`).toContain(mark)
      for (const pre of plan.prerequisites[String(id)] ?? []) {
        expect(reading, `「${t.term}」の前提の論点「${topics.get(pre)!.term}」が無い`).toContain(topics.get(pre)!.term)
      }
    }

    // step 4: システムが、論点ごとに配る本文を、用語と図を利用者が画面で見るのと同じ見え方にして並べ、図の画像を添える
    expect(reading, '押すと説明が出る語の印が無い').toContain('※')
    expect(reading, '用語の記法が書かれた文字のまま残っている').not.toMatch(/\[\[[^\]]+\]\]/)
    const expectedFigures: string[] = []
    const captions: string[] = []
    for (const id of order) {
      const specPath = `${DATA}/material_figures/${id}.json`
      if (!existsSync(join(root, specPath))) continue
      for (const f of readJson<FigureSpec>(specPath).figures) {
        expectedFigures.push(`figures/${id}-${f.id}.png`)
        captions.push(f.caption)
      }
    }
    expect([...result.figures].sort(), '図の仕様の図が PNG に描かれていない').toEqual([...expectedFigures].sort())
    for (const f of result.figures) {
      const file = join(outAbs, f)
      expect(existsSync(file), `図の画像 ${f} が出力先に無い`).toBe(true)
      expect([...readFileSync(file).subarray(0, 8)], `${f} が PNG でない`).toEqual(PNG_SIGNATURE)
      expect(reading, `単元の読み物が図の画像 ${f} を指していない`).toContain(f)
    }
    for (const c of captions) expect(occurrences(reading, c), `図の説明文「${c.slice(0, 20)}…」が 1 回だけ置かれていない`).toBe(1)

    // step 5: システムが、単元の読み物の項目の番号と論点の対応を作り手に示す
    expect(result.items.map((i) => i.no), '項目の番号が 1 から続いていない').toEqual(order.map((_, i) => i + 1))
    expect(result.items.map((i) => i.topic_id), '項目の番号の順が単元の構成の順でない').toEqual(order)
    expect(result.items.map((i) => i.term), '項目の論点の名前が論点の一覧の名前でない').toEqual(order.map((id) => topics.get(id)!.term))
    for (const i of result.items) expect(i.generation, `項目 ${i.no} の教材の世代が示されていない`).toMatch(/^materials(_v[0-9]+)?$/)
    expect(new Set(result.items.map((i) => i.generation)).size, '単元の中で選ばれた教材の世代が混ざる').toBe(1)

    // step 6: 作り手が、学習者役への単元の通読の指示に単元の値を埋め、単元の読み物と一緒に学習者役に渡す
    const template = readFileSync(join(REPO, 'scripts/prompts/rewrite_unit_learner.md'), 'utf8')
    const block = /## 学習者役への指示[^\n]*\n+```text\n([\s\S]*?)\n```/.exec(template)
    expect(block, '単元の通読の指示の雛形に指示の囲みが無い').not.toBeNull()
    const roleRow = new RegExp(`^\\| \`${LEARNING}\` \\| ([^|]+) \\|`, 'm').exec(template)
    expect(roleRow, `雛形に ${LEARNING} の役の文が無い`).not.toBeNull()
    const role = `${roleRow![1].trim()}${plan.unit}の用語は、聞いたことがある程度で、意味を説明できる語はほとんど無い。`
    const instruction = block![1].replace('{{役の 1 文}}', role).replace('{{読み物のパス}}', readingPath)
    expect(instruction, '単元の通読の指示に埋まっていない差し込みがある').not.toMatch(/\{\{[^}]*\}\}/)
    expect(instruction, '単元の通読の指示が単元の読み物の場所を持たない').toContain(readingPath)

    // step 7: 学習者役が、単元の読み物だけを頭から順に読み、学習者役の報告を返す
    // （読む・報告する手順は機械で行えない。単元の読み物だけで読み通せる＝図の行が出力先の中の画像だけを指すことを確かめる）
    const figureLines = [...reading.matchAll(/figures\/[^\s)"'<>]+\.png/g)].map((m) => m[0])
    expect(new Set(figureLines), '単元の読み物の図の行が、添えた図の画像と一致しない').toEqual(new Set(result.figures))
    expect(reading, '単元の読み物が出力先の外の図の置き場を指している').not.toContain('/figures/materials/')

    // 成功時: 出力先に単元の読み物と図の画像があり、項目の番号ごとの論点と選ばれた教材の世代を作り手が見ている
    expect(existsSync(readingPath)).toBe(true)
    expect(result.items.length).toBe(order.length)
  }, 360_000)
})
