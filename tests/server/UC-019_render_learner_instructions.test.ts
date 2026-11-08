import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDER_SCRIPT, ROOT, copyFixture, makeWorkspace, toolError, type Json, type Run, type Workspace } from './uc019_fixture'

/** UC-019 学びの学習者役への指示を雛形から描き出す入口（renderLearnerInstructions ＝
 *  `python3 scripts/render_prompts.py --data <学びの置き場>`）の境界。
 *  request の欄は長い名前の引数、response は標準出力の JSON 1 つと終了コード（成功 0、errors に当たれば 1）。
 *  コマンドは一時の作業場所を起点に呼び、描き出した指示はその中の <学びの置き場>/prompts/roadmap_learner.md を読む。
 *  雛形（scripts/prompts/roadmap_learner.md）・登録簿（src/shared/targets.json）・契約（contract.yaml）は、
 *  入口が読むのと同じリポジトリのファイルから期待値を取る。 */

const CONTRACT = path.join(ROOT, 'docs/goals/GOAL-12-measure-with-learner-role/UC-019-measure-with-learner-pack/contract.yaml')
const TEMPLATE = readFileSync(path.join(ROOT, 'scripts/prompts/roadmap_learner.md'), 'utf8')
const REGISTRY: Record<string, Json> = JSON.parse(readFileSync(path.join(ROOT, 'src/shared/targets.json'), 'utf8'))
const LEARNER_ANSWERS: Json = JSON.parse(
  spawnSync('python3', ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["schemas"]["LearnerAnswers"]))', CONTRACT], { encoding: 'utf8' }).stdout,
)
/** 登録簿のうちロードマップを持たない学び。 */
const NOT_ROADMAP = Object.keys(REGISTRY).filter((k) => !k.startsWith('_') && REGISTRY[k].roadmap === false)
const INSTRUCTIONS = (data: string) => `${data}/prompts/roadmap_learner.md`
const HISTORY = '## 改訂履歴'

/** 雛形の節の見出し（# で始まる行）。 */
const headingsOf = (md: string) => md.split('\n').filter((l) => /^#{1,6} /.test(l))
/** 雛形の改訂履歴の節の中身の行（見出しの次から、同じか上の段の次の見出しの前まで、空でない行）。 */
const historyBody = (md: string) => {
  const lines = md.split('\n')
  const at = lines.indexOf(HISTORY)
  const rest = lines.slice(at + 1)
  const end = rest.findIndex((l) => /^#{1,2} /.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter((l) => l.length > 0)
}
/** 雛形の差し込みの名前。 */
const placeholdersOf = (md: string) => [...new Set([...md.matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)].map((m) => m[1]))]
/** 雛形の日で束ねる学びだけの塊（{{#byDay}} と {{/byDay}} に挟んだ文。行の中に置けて入れ子にしない）。 */
const BY_DAY = /\{\{#byDay\}\}([\s\S]*?)\{\{\/byDay\}\}/g
/** 雛形のうち日で束ねる学びだけの塊を持つ行。 */
const byDayLines = (md: string) => md.split('\n').filter((l) => /\{\{#byDay\}\}[\s\S]*?\{\{\/byDay\}\}/.test(l))
/** 差し込みを値で埋める。 */
const fill = (s: string, values: Record<string, string>) =>
  s.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (m, name: string) => (name in values ? values[name] : m))
/** 章で束ねる学びで期待する行（塊を印ごと除き、残りの差し込みを埋める）。 */
const chapterLine = (line: string, values: Record<string, string>) => fill(line.replace(BY_DAY, ''), values)
/** 日で束ねる学びで期待する行（塊の印だけを除き、塊の中も含めて差し込みを埋める）。 */
const dayLine = (line: string, values: Record<string, string>) => fill(line.replace(BY_DAY, (_m, inner: string) => inner), values)
/** 雛形の差し込みも塊の印も含む、{{ }} の書き方すべて。 */
const ANY_MUSTACHE = /\{\{[^{}]*\}\}/
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 塊の文が、塊の後に続く文（次の差し込みの前まで）の直前に出ているかを見る正規表現（塊の中の差し込みは任意の文字に当てる）。 */
function blockThenAfter(line: string): RegExp[] {
  const out: RegExp[] = []
  for (const m of line.matchAll(new RegExp(BY_DAY.source, 'g'))) {
    const after = line.slice((m.index ?? 0) + m[0].length).split(/\{\{/)[0]
    const inner = m[1].split(/\{\{\s*[A-Za-z_]\w*\s*\}\}/).map(escapeRe).join('.+?')
    if (after.length > 0) out.push(new RegExp(inner + escapeRe(after)))
  }
  return out
}

/** 指示の中の、answers と units を持つ JSON の書き方（囲みのコードと行の中のコードのうち、JSON として読める物）。 */
function answerFormats(md: string): Json[] {
  const fenced = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const outside = md.replace(/```[a-z]*\n[\s\S]*?```/g, '')
  const inline = [...outside.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  return [...fenced, ...inline].flatMap((s) => {
    try {
      const j = JSON.parse(s)
      return j && typeof j === 'object' && !Array.isArray(j) && 'answers' in j && 'units' in j ? [j] : []
    } catch {
      return []
    }
  })
}
/** answers と units を名に持つが JSON として読めない書き方の候補（読めない書き方を見落とさないため）。 */
function unparsedFormatCandidates(md: string): string[] {
  const fenced = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const outside = md.replace(/```[a-z]*\n[\s\S]*?```/g, '')
  const inline = [...outside.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  return [...fenced, ...inline].filter((s) => /"answers"/.test(s) && /"units"/.test(s)).filter((s) => {
    try {
      JSON.parse(s)
      return false
    } catch {
      return true
    }
  })
}

/** 契約の型（JSON Schema の type・enum・minimum・properties・additionalProperties・items・required）に値が合うかを見て、
 *  合わない所を挙げる。properties を持ち additionalProperties を持たない型では、契約に無い欄の名前も挙げる。 */
function mismatches(v: Json, s: Json, at: string): string[] {
  const out: string[] = []
  const types: string[] = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]
  const is = (t: string) =>
    t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' : t === 'array' ? Array.isArray(v)
      : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'null' ? v === null : typeof v === t
  if (types.length > 0 && !types.some(is)) return [`${at}: 型が ${types.join('|')} でない（${JSON.stringify(v)}）`]
  if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${JSON.stringify(v)} が ${JSON.stringify(s.enum)} の外`)
  if (typeof s.minimum === 'number' && typeof v === 'number' && v < s.minimum) out.push(`${at}: ${v} が ${s.minimum} より小さい`)
  if (Array.isArray(v) && s.items) v.forEach((x, i) => out.push(...mismatches(x, s.items, `${at}[${i}]`)))
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of s.required ?? []) if (!(k in v)) out.push(`${at}: 欄 ${k} が無い`)
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) out.push(...mismatches(x, s.properties[k], `${at}.${k}`))
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...mismatches(x, s.additionalProperties, `${at}.${k}`))
      else if (s.properties) out.push(`${at}: 契約に無い欄 ${k}`)
    }
  }
  return out
}

function render(ws: Workspace, args: string[]): Run {
  const r = spawnSync('python3', [RENDER_SCRIPT, ...args], { cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  let json: Json = undefined
  try {
    json = JSON.parse(r.stdout.trim())
  } catch {
    json = undefined
  }
  const e = toolError(json)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, code: e && typeof e.code === 'string' ? e.code : undefined }
}

/** 日で束ねるロードマップ型の学び（itc）の置き場を作る。days を持たないロードマップも作れる。 */
function itcWorkspace(opts: { prefix?: string; days?: number | null; key?: string } = {}) {
  const ws = makeWorkspace()
  const data = `${opts.prefix ? `${opts.prefix}/` : ''}data/${opts.key ?? 'itc'}`
  const units = [
    { order: 1, day: 1, topic_id: 3, term: '作り物の単位3', field: '作り物の分野', middle: '作り物の単元', summary: '作り物の要約3' },
    { order: 2, day: 1, topic_id: 12, term: '作り物の単位12', field: '作り物の分野', middle: '作り物の単元', summary: '作り物の要約12' },
    { order: 3, day: 2, topic_id: 16, term: '作り物の単位16', field: '作り物の分野', middle: '作り物の単元', summary: '作り物の要約16' },
  ]
  ws.write(`${data}/roadmap.json`, { target: '作り物の学び', per_day: 2, ...(opts.days === null ? {} : { days: opts.days ?? 9 }), units })
  return { ws, data }
}
/** 章で束ねるロードマップ型の学び（eng）の置き場を作る。ロードマップは group_by が chapter で、days を持たない。 */
function engWorkspace() {
  const ws = makeWorkspace()
  const data = 'data/eng'
  const units = [
    { order: 1, round: 1, chapter: '作り物の章1', topic_id: 1, term: '作り物の単位1', field: '作り物の分野', middle: '作り物の章1', summary: '作り物の要約1' },
    { order: 2, round: 1, chapter: '作り物の章1', topic_id: 2, term: '作り物の単位2', field: '作り物の分野', middle: '作り物の章1', summary: '作り物の要約2' },
    { order: 3, round: 2, chapter: '作り物の章2', topic_id: 5, term: '作り物の単位5', field: '作り物の分野', middle: '作り物の章2', summary: '作り物の要約5' },
  ]
  ws.write(`${data}/roadmap.json`, { target: '作り物の学び', group_by: 'chapter', units })
  return { ws, data }
}
/** 章で束ねる学びの描き出しに成功し、指示の中身を返す。 */
function renderedChapter() {
  const { ws, data } = engWorkspace()
  const r = render(ws, ['--data', data])
  expect(r.status, r.stdout + r.stderr).toBe(0)
  return { ws, data, r, md: ws.read(INSTRUCTIONS(data)) }
}
/** 登録簿の学びの語（差し込みの値）。 */
const wordsOf = (key: string): Record<string, string> => ({ learnerRole: REGISTRY[key].roadmapSpec.learnerRole, goalVerb: REGISTRY[key].roadmapSpec.goalVerb })

/** 描き出しに成功し、指示の中身を返す。 */
function rendered(opts: Parameters<typeof itcWorkspace>[0] = {}) {
  const { ws, data } = itcWorkspace(opts)
  const r = render(ws, ['--data', data])
  expect(r.status, r.stdout + r.stderr).toBe(0)
  return { ws, data, r, md: ws.read(INSTRUCTIONS(data)) }
}
/** 断ったときの共通の観測: 終了 1・INVALID_INPUT・理由・作業場所のファイルが 1 つも変わらない。 */
function expectRefused(r: Run, ws: Workspace, before: Record<string, string>) {
  expect(r.status, r.stdout + r.stderr).toBe(1)
  expect(r.code, r.stdout).toBe('INVALID_INPUT')
  expect(typeof toolError(r.json)?.reason === 'string' && toolError(r.json).reason.length > 0).toBe(true)
  expect(ws.snapshotTree()).toEqual(before)
}

describe('UC-019 学習者役への指示を雛形から描き出す（renderLearnerInstructions）', () => {
  describe('雛形の改訂履歴の節を含めない（REQ-359）', () => {
    /** @covers REQ-359#no-history-section */
    it('描き出した指示には、雛形の改訂履歴の見出しも、その節の行も出ない', () => {
      expect(headingsOf(TEMPLATE), '雛形が改訂履歴の節を持つこと（この試験の前提）').toContain(HISTORY)
      const { md } = rendered()
      expect(headingsOf(md)).not.toContain(HISTORY)
      expect(md).not.toMatch(/^#{1,6}\s*改訂履歴\s*$/m)
      for (const line of historyBody(TEMPLATE)) expect(md, line).not.toContain(line)
    })

    /** @covers REQ-359#other-sections-kept */
    it('改訂履歴のほかの雛形の節の見出しは、雛形の順のまま残る', () => {
      const { md } = rendered()
      const expected = headingsOf(TEMPLATE).filter((h) => h !== HISTORY)
      expect(expected.length).toBeGreaterThan(0)
      expect(headingsOf(md)).toEqual(expected)
    })

    /** @covers REQ-359#chapter-no-day-block */
    it('章で束ねる学び（eng）の指示には、雛形の日で束ねる学びだけの塊の文（日数の文）が出ず、塊の後に続く同じ行の文は残る', () => {
      const lines = byDayLines(TEMPLATE)
      expect(lines.length, '雛形が日で束ねる学びだけの塊を持つこと（この試験の前提）').toBeGreaterThan(0)
      const { md } = renderedChapter()
      expect(md).not.toMatch(/\{\{[#/]byDay\}\}/)
      for (const line of lines) {
        const tail = line.replace(/^[\s\S]*\{\{\/byDay\}\}/, '')
        expect(tail.trim().length, `塊の後に同じ行の文が続くこと（この試験の前提）: ${line}`).toBeGreaterThan(0)
        expect(md, line).toContain(chapterLine(line, wordsOf('eng')))
        for (const re of blockThenAfter(line)) expect(md, String(re)).not.toMatch(re)
      }
    })

    /** @covers REQ-359#day-block-kept */
    it('日で束ねる学び（itc）の指示には、雛形の日で束ねる学びだけの塊の文が日数を差し込んで出る', () => {
      const lines = byDayLines(TEMPLATE)
      expect(lines.length, '雛形が日で束ねる学びだけの塊を持つこと（この試験の前提）').toBeGreaterThan(0)
      expect(lines.some((l) => [...l.matchAll(BY_DAY)].some((m) => /\{\{\s*days\s*\}\}/.test(m[1]))), '塊が差し込み days を持つこと（この試験の前提）').toBe(true)
      const { md } = rendered({ days: 9 })
      expect(md).not.toMatch(/\{\{[#/]byDay\}\}/)
      for (const line of lines) expect(md, line).toContain(dayLine(line, { ...wordsOf('itc'), days: '9' }))
    })
  })

  describe('指示の答えと自己申告の書き方は契約の形と同じ（REQ-360）', () => {
    /** @covers REQ-360#format-present */
    it('指示に answers と units を持つ JSON の書き方があり、読めない書き方の候補は無い', () => {
      const { md } = rendered()
      expect(unparsedFormatCandidates(md)).toEqual([])
      expect(answerFormats(md).length).toBeGreaterThan(0)
    })

    /** @covers REQ-360#unit-row-id-required */
    it('書き方の units は 1 行以上あり、どの行も 1 以上の整数の topic_id を持つ', () => {
      const formats = answerFormats(rendered().md)
      expect(formats.length).toBeGreaterThan(0)
      for (const f of formats) {
        expect(Array.isArray(f.units) && f.units.length > 0, JSON.stringify(f)).toBe(true)
        for (const row of f.units) expect(Number.isInteger(row.topic_id) && row.topic_id >= 1, JSON.stringify(row)).toBe(true)
      }
      expect(LEARNER_ANSWERS.properties.units.items.required).toContain('topic_id')
    })

    /** @covers REQ-360#fields-and-types-match */
    it('書き方の欄の名前はすべて契約の LearnerAnswers にあり、値の型が契約の型に合う', () => {
      const formats = answerFormats(rendered().md)
      expect(formats.length).toBeGreaterThan(0)
      for (const f of formats) expect(mismatches(f, LEARNER_ANSWERS, 'answerFormat')).toEqual([])
    })
  })

  describe('登録簿に無い学びか、ロードマップを持たない学び（REQ-410）', () => {
    /** @covers REQ-410#unknown-learning */
    it('登録簿に無い学びを指定すれば、ロードマップがあっても INVALID_INPUT で断り、指示を書かない', () => {
      const { ws, data } = itcWorkspace({ key: 'zzz' })
      const before = ws.snapshotTree()
      expectRefused(render(ws, ['--data', data]), ws, before)
      expect(ws.exists(INSTRUCTIONS(data))).toBe(false)
    })

    for (const key of NOT_ROADMAP) {
      /** @covers REQ-410#not-roadmap */
      it(`ロードマップを持たない学び ${key} を指定すれば、置き場にロードマップがあっても INVALID_INPUT で断り、指示を書かない`, () => {
        const { ws, data } = itcWorkspace({ key })
        const before = ws.snapshotTree()
        expectRefused(render(ws, ['--data', data]), ws, before)
        expect(ws.exists(INSTRUCTIONS(data))).toBe(false)
      })
    }

    /** @covers REQ-410#before-placeholder-unfilled */
    it('登録簿に無い学びの、日で束ねる形（group_by が無い）のロードマップに days も無いときは、差し込みの名前を挙げずに断る（登録簿に無い学びが先）', () => {
      const { ws, data } = itcWorkspace({ key: 'zzz', days: null })
      const before = ws.snapshotTree()
      const r = render(ws, ['--data', data])
      expectRefused(r, ws, before)
      expect(toolError(r.json).placeholders).toBeUndefined()
    })
  })

  describe('入口の引数が契約の形の外（REQ-411）', () => {
    /** 断ったうえで、挙げた引数の名前と、作業場所のファイルが 1 つも変わらないこと。 */
    const refusedArgs = (args: string[], names: string[]) => {
      const { ws } = itcWorkspace()
      const before = ws.snapshotTree()
      const r = render(ws, args)
      expectRefused(r, ws, before)
      expect([...(toolError(r.json)?.arguments ?? [])].sort()).toEqual([...names].sort())
    }

    /** @covers REQ-411#data-missing */
    it('学びを渡さなければ断り、data を挙げ、何も書かない', () => {
      refusedArgs([], ['data'])
    })

    for (const data of ['itc', 'data/Itc', 'data/itc/', '../data/itc', 'data/itc2', 'other/data/itc', 'tests/fixtures/learner-pack/Bad/data/itc', 'tests/fixtures/learner-pack/x/y/data/itc', '']) {
      /** @covers REQ-411#data-not-in-shape */
      it(`学びが学びの置き場の形でない（${JSON.stringify(data)}）なら断り、data を挙げ、何も書かない`, () => {
        refusedArgs(['--data', data], ['data'])
      })
    }

    for (const [label, args, names] of [
      ['周の番号', ['--data', 'data/itc', '--cycle', '1'], ['cycle']],
      ['出力先', ['--data', 'data/itc', '--out', 'packs/x'], ['out']],
      ['契約に無い 2 つの引数', ['--data', 'data/itc', '--cycle', '1', '--out', 'packs/x'], ['cycle', 'out']],
    ] as const) {
      /** @covers REQ-411#unknown-argument */
      it(`契約に無い引数（${label}）を渡せば断り、その名前を挙げ、何も書かない`, () => {
        refusedArgs([...args], [...names])
      })
    }

    /** @covers REQ-411#before-not-roadmap */
    it('ロードマップを持たない学びに契約に無い引数も渡せば、引数の誤りとしてその名前を挙げる（引数の誤りが先）', () => {
      refusedArgs(['--data', `data/${NOT_ROADMAP[0]}`, '--cycle', '1'], ['cycle'])
    })

    /** @covers REQ-411#fixture-prefix-in-shape */
    it('作り物の置き場の前置きを持つ学びは形の内として描き出し、応答の path はその置き場の指示を指す', () => {
      const { ws, data, r } = rendered({ prefix: 'tests/fixtures/learner-pack/render-ok' })
      expect(r.json).toEqual({ path: INSTRUCTIONS(data) })
      expect(ws.exists(INSTRUCTIONS(data))).toBe(true)
      expect(ws.exists('data/itc/prompts/roadmap_learner.md')).toBe(false)
    })
  })

  describe('雛形の差し込みに埋まらない物が残る（REQ-412）', () => {
    /** @covers REQ-412#days-missing */
    it('日で束ねる学びのロードマップに days が無ければ、差し込み days を挙げて INVALID_INPUT で断り、指示を書かない', () => {
      const { ws, data } = itcWorkspace({ days: null })
      expect(JSON.parse(ws.read(`${data}/roadmap.json`)).group_by, '日で束ねる形であること（この試験の前提）').toBeUndefined()
      const before = ws.snapshotTree()
      const r = render(ws, ['--data', data])
      expectRefused(r, ws, before)
      expect(toolError(r.json).placeholders).toEqual(['days'])
      expect(ws.exists(INSTRUCTIONS(data))).toBe(false)
    })

    /** @covers REQ-412#days-missing */
    it('作り物の置き場 instructions-no-days から描き出すと、差し込み days を挙げて断る', () => {
      const ws = makeWorkspace()
      const data = `${copyFixture(ws, 'instructions-no-days')}/data/itc`
      const before = ws.snapshotTree()
      const r = render(ws, ['--data', data])
      expectRefused(r, ws, before)
      expect(toolError(r.json).placeholders).toEqual(['days'])
    })

    /** @covers REQ-412#existing-instructions-kept */
    it('断ったときは、前からあった指示のファイルを書き換えない', () => {
      const { ws, data } = itcWorkspace({ days: null })
      ws.write(INSTRUCTIONS(data), '前からある指示\n')
      const before = ws.snapshotTree()
      const r = render(ws, ['--data', data])
      expectRefused(r, ws, before)
      expect(ws.read(INSTRUCTIONS(data))).toBe('前からある指示\n')
    })

    /** @covers REQ-412#chapter-days-unused */
    it('章で束ねる学びのロードマップに days が無くても断らず、指示を書き、差し込み days を挙げない', () => {
      const { ws, data } = engWorkspace()
      expect(JSON.parse(ws.read(`${data}/roadmap.json`)).days, 'days が無いこと（この試験の前提）').toBeUndefined()
      const r = render(ws, ['--data', data])
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.code).toBeUndefined()
      expect(toolError(r.json)).toBeUndefined()
      expect(r.json).toEqual({ path: INSTRUCTIONS(data) })
      expect(ws.exists(INSTRUCTIONS(data))).toBe(true)
    })

    /** @covers REQ-412#all-filled */
    it('日で束ねる学びで差し込みがすべて埋まれば、差し込みも塊の印も残らず、登録簿の学びの語とロードマップの days が入る', () => {
      const { md, r, data } = rendered({ days: 9 })
      expect(r.json).toEqual({ path: INSTRUCTIONS(data) })
      const names = placeholdersOf(TEMPLATE)
      expect(names.length).toBeGreaterThan(0)
      expect(md).not.toMatch(ANY_MUSTACHE)
      const spec = REGISTRY.itc.roadmapSpec
      if (names.includes('learnerRole')) expect(md).toContain(spec.learnerRole)
      if (names.includes('goalVerb')) expect(md).toContain(spec.goalVerb)
      if (names.includes('days')) expect(md).toMatch(/(^|[^0-9])9 ?日/)
    })

    /** @covers REQ-412#all-filled */
    it('章で束ねる学びで差し込みがすべて埋まれば、差し込みも塊の印も残らず、登録簿の学びの語が入る', () => {
      const { md } = renderedChapter()
      const names = placeholdersOf(TEMPLATE)
      expect(names.length).toBeGreaterThan(0)
      expect(md).not.toMatch(ANY_MUSTACHE)
      const spec = REGISTRY.eng.roadmapSpec
      if (names.includes('learnerRole')) expect(md).toContain(spec.learnerRole)
      if (names.includes('goalVerb')) expect(md).toContain(spec.goalVerb)
    })
  })
})
