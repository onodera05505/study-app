/** UC-032 配備と投入の前に門を回す。契約の入口のうち、登録簿の門（checkRoadmapRegistry）とソースの門（checkSource）をコマンドとして呼ぶ。
 *
 *  入口の呼び方は契約の先頭のコメントの決まり（request の各欄は同じ名前の引数、learning だけは第 1 引数）から作る:
 *  checkRoadmapRegistry は `python3 scripts/check_roadmap_registry.py <学び>`、checkSource は `python3 scripts/check_source.py [--auth <ファイル>] [--client <置き場>]`。
 *  結果は終了コード（0 は通した、1 は止めた。断ったときは 0 でない）と、標準出力・標準エラーの行で見る。
 *
 *  登録簿の門は登録簿の置き場を引数で受けないので、欠けた登録簿は、入口（scripts/）と登録簿（src/shared/）と学びの置き場（data/<学び>）をプロジェクトと同じ並びで
 *  一時の置き場に写し、写しの登録簿を崩して写しの入口をその置き場を cwd にして呼ぶ。リポジトリの登録簿は読むだけで書き換えない。
 *  ソースの門は、パスワードの記録を作るコードと画面のコードの置き場を一時の置き場に作って引数で渡す。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../src/server/lib/auth'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REGISTRY_REL = path.join('src', 'shared', 'targets.json')

type Out = { status: number | null; out: string }
type Registry = Record<string, any>

const created: string[] = []
function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(tmpdir(), prefix))
  created.push(d)
  return d
}
afterAll(() => {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function run(cwd: string, script: string, args: string[]): Out {
  const r = spawnSync('python3', [script, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

/** 空でない行（前後の空白を除く）。 */
const linesOf = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

const readRegistry = (root: string): Registry => JSON.parse(fs.readFileSync(path.join(root, REGISTRY_REL), 'utf8'))

/** ロードマップ型の学びを、束ね方（1 日の論点数を持つか）で選ぶ。 */
function roadmapLearnings(reg: Registry) {
  const keys = Object.keys(reg).filter((k) => !k.startsWith('_'))
  const roadmap = keys.filter((k) => reg[k].roadmap === true && reg[k].roadmapSpec)
  const day = roadmap.find((k) => reg[k].roadmapSpec.perDay !== undefined && reg[k].questionsPerRound !== undefined)
  const chapter = roadmap.find((k) => reg[k].roadmapSpec.perDay === undefined && Array.isArray(reg[k].roadmapSpec.tiers))
  const qualification = keys.find((k) => reg[k].roadmap === false)
  if (!day || !chapter || !qualification) throw new Error('仕込み: 登録簿に資格対策・日で束ねる・章で束ねる学びがそろっていない')
  return { day, chapter, qualification }
}

/* ---------- 登録簿の門 ---------- */

/** checkRoadmapRegistry をリポジトリの入口と登録簿で呼ぶ。 */
const registryGate = (args: string[]) => run(ROOT, path.join(ROOT, 'scripts', 'check_roadmap_registry.py'), args)

describe('登録簿の門は、そろった学びを通す（UC-032）', () => {
  const reg = readRegistry(ROOT)
  const { day, chapter, qualification } = roadmapLearnings(reg)

  // @covers REQ-546#qualification-nothing-to-check
  it('資格対策の学びを 1 つ渡すと、終了 0 で通す', () => {
    const r = registryGate([qualification])
    expect(r.status, `資格対策の学び ${qualification} を通さない:\n${r.out}`).toBe(0)
  })

  // @covers REQ-546#chapter-roadmap-passes-with-grouping
  it('値のそろった章で束ねる学びを 1 つ渡すと、束ね方を示して終了 0 で通す', () => {
    const r = registryGate([chapter])
    expect(r.status, `章で束ねる学び ${chapter} を通さない:\n${r.out}`).toBe(0)
    expect(/章|chapter/i.test(r.out), `束ね方（章）を示していない:\n${r.out}`).toBe(true)
  })

  // @covers REQ-546#day-roadmap-passes-with-grouping
  it('値のそろった日で束ねる学びを 1 つ渡すと、束ね方を示して終了 0 で通す', () => {
    const r = registryGate([day])
    expect(r.status, `日で束ねる学び ${day} を通さない:\n${r.out}`).toBe(0)
    expect(/日|day/i.test(r.out), `束ね方（日）を示していない:\n${r.out}`).toBe(true)
  })
})

describe('登録簿の門は、ロードマップ型の学びの欠けをすべて挙げて止める（UC-032）', () => {
  let proj = ''
  let original: Registry
  let day = ''
  let chapter = ''
  const clean: Record<string, Out> = {}

  /** 写しの登録簿を崩して、写しの入口で門を回す。回したあと写しの登録簿を元に戻す。 */
  function gateWith(learning: string, mutate: (reg: Registry) => void): Out {
    const reg = structuredClone(original)
    mutate(reg)
    const file = path.join(proj, REGISTRY_REL)
    fs.writeFileSync(file, JSON.stringify(reg, null, 2))
    try {
      return run(proj, path.join(proj, 'scripts', 'check_roadmap_registry.py'), [learning])
    } finally {
      fs.writeFileSync(file, JSON.stringify(original, null, 2))
    }
  }

  /** 崩す前は通る学びが、崩すと終了 1 で止まり、学びの key と、崩す前の出力に無い行を挙げる。挙げた行を返す。 */
  function expectStops(learning: string, mutate: (reg: Registry) => void, label: string): string[] {
    expect(clean[learning].status, `仕込み: 崩す前の ${learning} が通らない:\n${clean[learning].out}`).toBe(0)
    const r = gateWith(learning, mutate)
    expect(r.status, `${label}: 終了 1 で止めない:\n${r.out}`).toBe(1)
    expect(r.out.includes(learning), `${label}: 学び ${learning} を挙げていない:\n${r.out}`).toBe(true)
    const before = new Set(linesOf(clean[learning].out))
    const added = linesOf(r.out).filter((l) => !before.has(l))
    expect(added.length, `${label}: 欠けを挙げた行が無い:\n${r.out}`).toBeGreaterThan(0)
    return added
  }

  const spec = (reg: Registry, k: string) => reg[k].roadmapSpec

  beforeAll(() => {
    proj = tempDir('uc032-registry-')
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(proj, 'scripts'), {
      recursive: true,
      filter: (s) => !s.split(path.sep).includes('__pycache__'),
    })
    fs.cpSync(path.join(ROOT, 'src', 'shared'), path.join(proj, 'src', 'shared'), { recursive: true })
    original = readRegistry(proj)
    ;({ day, chapter } = roadmapLearnings(original))
    // 束ね方は登録簿の外（学びの置き場）でも決まりうるので、選んだ 2 つの学びの置き場も写す。
    for (const k of [day, chapter]) fs.cpSync(path.join(ROOT, 'data', k), path.join(proj, 'data', k), { recursive: true })
    for (const k of [day, chapter]) clean[k] = run(proj, path.join(proj, 'scripts', 'check_roadmap_registry.py'), [k])
  })

  // @covers REQ-547#round-word-missing
  it('回の見出し・回の数・回ごとの確認の語のどれかが無いと、学びと欠けを挙げて止める', () => {
    for (const word of ['roundHeading', 'roundCount', 'roundCheck']) {
      expectStops(day, (reg) => delete spec(reg, day)[word], `${word} が無い`)
    }
  })

  // @covers REQ-547#round-word-without-placeholder
  it('回の見出しの語が回の番号の差し込みを、回の数の語が数の差し込みを持たないと、学びと欠けを挙げて止める', () => {
    expect(String(original[day].roadmapSpec.roundHeading), '仕込み: 回の見出しの語が {day} を持たない').toContain('{day}')
    expect(String(original[day].roadmapSpec.roundCount), '仕込み: 回の数の語が {n} を持たない').toContain('{n}')
    expectStops(day, (reg) => (spec(reg, day).roundHeading = spec(reg, day).roundHeading.replace('{day}', '')), '回の見出しの語に {day} が無い')
    expectStops(day, (reg) => (spec(reg, day).roundCount = spec(reg, day).roundCount.replace('{n}', '')), '回の数の語に {n} が無い')
  })

  // @covers REQ-547#extra-round-not-in-exempt-list
  it('補足の回が補足の回の一覧に無いと、学びと欠けを挙げて止める', () => {
    const extra = original[day].roadmapSpec.extraRoundId
    expect(original[day].exemptRounds, '仕込み: 補足の回が一覧にある学びでない').toContain(extra)
    expectStops(day, (reg) => (reg[day].exemptRounds = reg[day].exemptRounds.filter((x: string) => x !== extra)), '補足の回が一覧に無い')
  })

  // @covers REQ-547#extra-field-not-in-fields
  it('補足の分野が分野の一覧に無いと、学びと欠けを挙げて止める', () => {
    const extra = original[day].roadmapSpec.extraField
    expect(original[day].fields, '仕込み: 補足の分野が一覧にある学びでない').toContain(extra)
    expectStops(day, (reg) => (reg[day].fields = reg[day].fields.filter((x: string) => x !== extra)), '補足の分野が一覧に無い')
  })

  // @covers REQ-547#chapter-with-day-only-value
  it('章で束ねる学びが 1 日の論点数か 1 回の問題数を持つと、学びと欠けを挙げて止める', () => {
    expectStops(chapter, (reg) => (spec(reg, chapter).perDay = 3), '章で束ねる学びが 1 日の論点数を持つ')
    expectStops(chapter, (reg) => (reg[chapter].questionsPerRound = 6), '章で束ねる学びが 1 回の問題数を持つ')
  })

  // @covers REQ-547#day-per-day-missing
  it('日で束ねる学びの 1 日の論点数が無いと、学びと欠けを挙げて止める', () => {
    expectStops(day, (reg) => delete spec(reg, day).perDay, '1 日の論点数が無い')
  })

  // @covers REQ-547#day-questions-per-round-missing
  it('日で束ねる学びの 1 回の問題数が無いと、学びと欠けを挙げて止める', () => {
    expectStops(day, (reg) => delete reg[day].questionsPerRound, '1 回の問題数が無い')
  })

  // @covers REQ-547#day-values-disagree
  it('日で束ねる学びの 1 回の問題数が 1 日の論点数と合わないと、学びと欠けを挙げて止める', () => {
    const perDay = Number(original[day].roadmapSpec.perDay)
    expect(perDay, '仕込み: 1 日の論点数が 2 以上でない').toBeGreaterThan(1)
    expect(original[day].questionsPerRound % perDay, '仕込み: 今の 1 回の問題数が 1 日の論点数の倍数でない').toBe(0)
    expectStops(day, (reg) => (reg[day].questionsPerRound = perDay * 2 + 1), '1 回の問題数が 1 日の論点数の倍数でない')
  })

  // @covers REQ-547#tier-level-not-positive
  it('印の段の値が 1 未満だと、学びと欠けを挙げて止める', () => {
    for (const level of [0, -1]) {
      expectStops(chapter, (reg) => (spec(reg, chapter).tiers[spec(reg, chapter).tiers.length - 1].level = level), `印の段が ${level}`)
    }
  })

  // @covers REQ-547#tier-level-not-integer
  it('印の段の値が整数でないと、学びと欠けを挙げて止める', () => {
    expectStops(chapter, (reg) => (spec(reg, chapter).tiers[0].level = 1.5), '印の段が 1.5')
  })

  // @covers REQ-547#tier-level-duplicated
  it('印の段の値が 2 つの段で重なると、学びと欠けを挙げて止める', () => {
    expect(original[chapter].roadmapSpec.tiers.length, '仕込み: 印の段が 2 つ以上ない').toBeGreaterThan(1)
    expectStops(chapter, (reg) => (spec(reg, chapter).tiers[1].level = spec(reg, chapter).tiers[0].level), '印の段が重なる')
  })

  // @covers REQ-547#tier-label-missing
  it('印の段が語を持たないと、学びと欠けを挙げて止める', () => {
    expectStops(chapter, (reg) => delete spec(reg, chapter).tiers[0].label, '印の段の語が無い')
  })

  // @covers REQ-547#all-defects-listed
  it('1 つの学びに欠けが 3 つあると、1 つずつのときに挙げた行をすべて挙げて止める', () => {
    const extra = original[day].roadmapSpec.extraRoundId
    const defects: [string, (reg: Registry) => void][] = [
      ['回ごとの確認の語が無い', (reg) => delete spec(reg, day).roundCheck],
      ['補足の回が一覧に無い', (reg) => (reg[day].exemptRounds = reg[day].exemptRounds.filter((x: string) => x !== extra))],
      ['1 回の問題数が無い', (reg) => delete reg[day].questionsPerRound],
    ]
    const each = defects.map(([label, f]) => [label, expectStops(day, f, label)] as const)
    const all = expectStops(day, (reg) => defects.forEach(([, f]) => f(reg)), '欠けが 3 つ')
    for (const [label, lines] of each) {
      expect(
        lines.some((l) => all.includes(l)),
        `欠けが 3 つのとき「${label}」を挙げていない（1 つのときの行: ${lines.join(' / ')}）:\n${all.join('\n')}`,
      ).toBe(true)
    }
  })
})

describe('登録簿の門は、学びを 1 つでなく渡すか登録簿に無い学びを渡すと断る（UC-032）', () => {
  const reg = readRegistry(ROOT)
  const { day, qualification } = roadmapLearnings(reg)
  const unknown = ['zzz', 'zzy'].filter((k) => !(k in reg))

  const expectRefused = (r: Out, label: string) => expect(r.status, `${label}: 断らずに終了 0 で終わった:\n${r.out}`).not.toBe(0)

  // @covers REQ-548#no-learning
  it('学びを渡さないと、終了 0 でなく断る', () => {
    expectRefused(registryGate([]), '学びを渡さない')
  })

  // @covers REQ-548#two-learnings
  it('1 つずつなら通る学びを 2 つ渡すと、判定して通さずに断る', () => {
    expect(registryGate([qualification]).status, '仕込み: 1 つ目の学びが 1 つでは通らない').toBe(0)
    expect(registryGate([day]).status, '仕込み: 2 つ目の学びが 1 つでは通らない').toBe(0)
    expectRefused(registryGate([qualification, day]), '学びを 2 つ渡す')
  })

  // @covers REQ-548#unknown-learning
  it('登録簿に無い学びを渡すと、終了 0 でなく断る', () => {
    expect(unknown.length, '仕込み: 登録簿に無い key を作れない').toBe(2)
    expectRefused(registryGate([unknown[0]]), '登録簿に無い学び')
  })

  // @covers REQ-548#two-unknown-learnings
  it('登録簿に無い学びを 2 つ渡すと、終了 0 でなく断る', () => {
    expect(unknown.length, '仕込み: 登録簿に無い key を作れない').toBe(2)
    expectRefused(registryGate(unknown), '登録簿に無い学びを 2 つ')
  })
})

/* ---------- ソースの門 ---------- */

/** checkSource をリポジトリの入口で呼ぶ。 */
const sourceGate = (args: string[]) => run(ROOT, path.join(ROOT, 'scripts', 'check_source.py'), args)

/** パスワードの記録を作るコード（BR-039 が名指しする 1 か所）。門の入力として写すだけで、中身はテストが決めない。 */
const AUTH_SRC = path.join(ROOT, 'src', 'server', 'lib', 'auth.ts')

/** 取得する一覧を取得前を表す値で始め、一覧でない値を空で始める画面。止める箇所が無い。 */
const CLEAN_SCREEN = `import { useEffect, useState } from 'react'

type Topic = { id: number; name: string }

export function TopicList() {
  const [topics, setTopics] = useState<Topic[] | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    fetch('/api/topics')
      .then((r) => r.json())
      .then((rows: Topic[]) => setTopics(rows))
  }, [])
  if (topics === null) return <p>読み込み中</p>
  return (
    <div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul>{topics.map((t) => <li key={t.id}>{t.name}</li>)}</ul>
    </div>
  )
}
`

/** 書き込んだ行の番号（1 始まり）を、目印の文字列で引く。 */
function lineOf(text: string, needle: string): number {
  const i = text.split('\n').findIndex((l) => l.includes(needle))
  if (i < 0) throw new Error(`仕込み: ${needle} が書き込んだ画面に無い`)
  return i + 1
}

describe('ソースの門（UC-032）', () => {
  let auth = ''
  let iterations = 0
  let iterationsRe: RegExp

  /** 画面のコードの置き場を作る。files は置き場からの相対パスと中身。 */
  function clientDir(files: Record<string, string>): string {
    const d = tempDir('uc032-client-')
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true })
      fs.writeFileSync(path.join(d, rel), body)
    }
    return d
  }

  /** パスワードの記録を作るコードの写しを書く。 */
  function authFile(name: string, body: string): string {
    const d = tempDir('uc032-auth-')
    const f = path.join(d, name)
    fs.writeFileSync(f, body)
    return f
  }

  beforeAll(async () => {
    const stored = await hashPassword('correct horse 8')
    iterations = Number(stored.split(':')[0])
    if (!Number.isInteger(iterations) || iterations <= 0) throw new Error(`仕込み: 記録の計算量の欄を読めない: ${stored.split(':')[0]}`)
    // 数字の間に _ を許す（100_000 の書き方）。前後が数字・_ でないこと。
    const digits = String(iterations).split('').join('_?')
    iterationsRe = new RegExp(`(?<![\\d_])${digits}(?![\\d_])`, 'g')
    auth = authFile('auth.ts', fs.readFileSync(AUTH_SRC, 'utf8'))
  })

  describe('ソースの門は、計算量が上限の内で空の一覧で始める箇所が無ければ通す（UC-032）', () => {
    // @covers REQ-549#within-limit-clean-client
    it('今のパスワードの記録を作るコードの写しと、空の一覧で始める箇所の無い画面を渡すと、終了 0 で通す', () => {
      const r = sourceGate(['--auth', auth, '--client', clientDir({ 'TopicList.tsx': CLEAN_SCREEN })])
      expect(r.status, `通さない:\n${r.out}`).toBe(0)
    })

    // @covers REQ-549#clean-client-same-written-forms
    it('止める箇所と同じ書き方で、空でない一覧か取得前を表す値で始める画面を渡すと、終了 0 で通す', () => {
      const body = `import React, { useEffect, useState } from 'react'

type Topic = { id: number; name: string }

export function Filters() {
  const [selected, setSelected] = useState<string[]>(() => ['ストラテジ'])
  const [fields, setFields] = useState(['マネジメント'] as string[])
  const [topics, setTopics] = useState<
    Topic[] | null
  >(null)
  const [exams, setExams] = useState<Array<Topic> | null>(null)
  const [rows, setRows] = React.useState<Topic[] | null>(null)
  useEffect(() => {
    fetch('/api/topics').then((r) => r.json()).then(setTopics)
    fetch('/api/exams').then((r) => r.json()).then(setExams)
    fetch('/api/rows').then((r) => r.json()).then(setRows)
  }, [])
  if (topics === null || exams === null || rows === null) return <p>読み込み中</p>
  return (
    <div>
      <button onClick={() => setSelected([])}>{selected.join('・')}</button>
      <button onClick={() => setFields([])}>{fields.join('・')}</button>
      <p>{topics.length} / {exams.length} / {rows.length}</p>
    </div>
  )
}
`
      const r = sourceGate(['--auth', auth, '--client', clientDir({ 'Filters.tsx': body, 'TopicList.tsx': CLEAN_SCREEN })])
      expect(r.status, `通さない:\n${r.out}`).toBe(0)
    })
  })

  describe('ソースの門は、パスワードの記録の計算量を確かめられないか上限を超えると挙げて止める（UC-032）', () => {
    // @covers REQ-550#auth-code-missing
    it('パスワードの記録を作るコードとして渡したファイルが無いと、それを挙げて終了 1 で止める', () => {
      const missing = path.join(tempDir('uc032-auth-'), 'no_such_auth.ts')
      const r = sourceGate(['--auth', missing, '--client', clientDir({ 'TopicList.tsx': CLEAN_SCREEN })])
      expect(r.status, `終了 1 で止めない:\n${r.out}`).toBe(1)
      expect(r.out.includes('no_such_auth.ts'), `無いファイルを挙げていない:\n${r.out}`).toBe(true)
    })

    // @covers REQ-550#iterations-not-found
    it('パスワードの記録を作るコードに計算量の値が無いと、それを挙げて終了 1 で止める', () => {
      const f = authFile('auth_without_iterations.ts', 'export function hashPassword(password: string): string {\n  return password\n}\n')
      const r = sourceGate(['--auth', f, '--client', clientDir({ 'TopicList.tsx': CLEAN_SCREEN })])
      expect(r.status, `終了 1 で止めない:\n${r.out}`).toBe(1)
      expect(r.out.includes('auth_without_iterations.ts'), `計算量の値が無いコードを挙げていない:\n${r.out}`).toBe(true)
    })

    // @covers REQ-550#iterations-over-limit
    it('パスワードの記録を作る計算量が上限を超えると、超えた値を挙げて終了 1 で止める', () => {
      const body = fs.readFileSync(auth, 'utf8')
      const found = body.match(iterationsRe) ?? []
      expect(found.length, `仕込み: コードの写しに計算量 ${iterations} の値が無い`).toBeGreaterThan(0)
      const over = 1_000_000_000
      const f = authFile('auth.ts', body.replace(iterationsRe, String(over)))
      const r = sourceGate(['--auth', f, '--client', clientDir({ 'TopicList.tsx': CLEAN_SCREEN })])
      expect(r.status, `終了 1 で止めない:\n${r.out}`).toBe(1)
      expect(r.out.replace(/[_,]/g, '').includes(String(over)), `超えた値を挙げていない:\n${r.out}`).toBe(true)
    })
  })

  describe('ソースの門は、状態を空の一覧で始める箇所をすべて挙げて止める（UC-032）', () => {
    /** 終了 1 で止め、各箇所（ファイルの名前と行の番号）を同じ行にそろえて挙げる。 */
    function expectSitesListed(files: Record<string, string>, sites: [string, string][], label: string) {
      const r = sourceGate(['--auth', auth, '--client', clientDir(files)])
      expect(r.status, `${label}: 終了 1 で止めない:\n${r.out}`).toBe(1)
      const lines = linesOf(r.out)
      for (const [rel, needle] of sites) {
        const name = path.basename(rel)
        const n = lineOf(files[rel], needle)
        const hit = lines.some((l) => l.includes(name) && new RegExp(`(?<!\\d)${n}(?!\\d)`).test(l.replace(name, '')))
        expect(hit, `${label}: ${rel} の ${n} 行目を挙げていない:\n${r.out}`).toBe(true)
      }
    }

    const screen = (body: string) => `import { useEffect, useState } from 'react'

type Topic = { id: number; name: string }
type Exam = { id: string; label: string }

${body}
`

    // @covers REQ-551#one-site
    it('取得する一覧を空の一覧で始める箇所が 1 つあると、その箇所を挙げて終了 1 で止める', () => {
      const body = screen(`export function TopicList() {
  const [topics, setTopics] = useState<Topic[]>([])
  useEffect(() => {
    fetch('/api/topics').then((r) => r.json()).then(setTopics)
  }, [])
  return <ul>{topics.map((t) => <li key={t.id}>{t.name}</li>)}</ul>
}`)
      expectSitesListed({ 'TopicList.tsx': body }, [['TopicList.tsx', 'useState<Topic[]>([])']], '1 箇所')
    })

    // @covers REQ-551#all-sites-listed
    it('2 つのファイルに合わせて 3 箇所あると、3 箇所をすべて挙げて終了 1 で止める', () => {
      const a = screen(`export function Dashboard() {
  const [topics, setTopics] = useState<Topic[]>([])
  const [exams, setExams] = useState<Exam[]>([])
  useEffect(() => {
    fetch('/api/topics').then((r) => r.json()).then(setTopics)
    fetch('/api/exams').then((r) => r.json()).then(setExams)
  }, [])
  return <p>{topics.length} / {exams.length}</p>
}`)
      const b = screen(`export function History() {
  const [rows, setRows] = useState([])
  useEffect(() => {
    fetch('/api/history').then((r) => r.json()).then(setRows)
  }, [])
  return <p>{rows.length}</p>
}`)
      expectSitesListed(
        { 'Dashboard.tsx': a, 'pages/History.tsx': b, 'TopicList.tsx': CLEAN_SCREEN },
        [
          ['Dashboard.tsx', 'useState<Topic[]>([])'],
          ['Dashboard.tsx', 'useState<Exam[]>([])'],
          ['pages/History.tsx', 'useState([])'],
        ],
        '3 箇所',
      )
    })

    // @covers REQ-551#annotated-line-still-fails
    it('箇所の行に印や注記のコメントを書き添えても、どの箇所も挙げて終了 1 で止める', () => {
      const body = screen(`export function Annotated() {
  const [topics, setTopics] = useState<Topic[]>([]) // 空で開始可
  const [exams, setExams] = useState<Exam[]>([]) // eslint-disable-line
  const [rows, setRows] = useState<Topic[]>([]) /* check_source: ignore */ // noqa
  useEffect(() => {
    fetch('/api/topics').then((r) => r.json()).then(setTopics)
    fetch('/api/exams').then((r) => r.json()).then(setExams)
    fetch('/api/rows').then((r) => r.json()).then(setRows)
  }, [])
  return <p>{topics.length} / {exams.length} / {rows.length}</p>
}`)
      expectSitesListed(
        { 'Annotated.tsx': body },
        [
          ['Annotated.tsx', '// 空で開始可'],
          ['Annotated.tsx', '// eslint-disable-line'],
          ['Annotated.tsx', '// noqa'],
        ],
        '書き添えた行',
      )
    })

    // @covers REQ-551#hook-module-site
    it('画面の部品でない .ts のファイルにある箇所も、挙げて終了 1 で止める', () => {
      const hook = `import { useEffect, useState } from 'react'

export type Topic = { id: number; name: string }

export function useTopics(): Topic[] {
  const [topics, setTopics] = useState<Topic[]>([])
  useEffect(() => {
    fetch('/api/topics').then((r) => r.json()).then(setTopics)
  }, [])
  return topics
}
`
      expectSitesListed({ 'hooks/useTopics.ts': hook, 'TopicList.tsx': CLEAN_SCREEN }, [['hooks/useTopics.ts', 'useState<Topic[]>([])']], '.ts の箇所')
    })

    // @covers REQ-551#local-list-site
    it('取得の結果を入れない手元の一覧を空の一覧で始める箇所が 1 つだけあると、その箇所を挙げて終了 1 で止める', () => {
      const body = screen(`export function TagPicker() {
  const [selected, setSelected] = useState<string[]>([])
  const toggle = (tag: string) =>
    setSelected((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))
  return (
    <div>
      {['ストラテジ', 'マネジメント', 'テクノロジ'].map((tag) => (
        <button key={tag} onClick={() => toggle(tag)}>{selected.includes(tag) ? '✓ ' : ''}{tag}</button>
      ))}
    </div>
  )
}`)
      expect(body.includes('fetch('), '仕込み: 手元の一覧の画面が取得している').toBe(false)
      expectSitesListed({ 'TagPicker.tsx': body }, [['TagPicker.tsx', 'useState<string[]>([])']], '手元の一覧の箇所')
    })

    /** 手元の一覧の画面と同じ形で、状態を作る行だけを差し替えた画面。header は import の行。 */
    const pickerWith = (stateLines: string, header = "import { useState } from 'react'") => `${header}

export function TagPicker() {
${stateLines}
  const toggle = (tag: string) =>
    setSelected((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))
  return (
    <div>
      {['ストラテジ', 'マネジメント', 'テクノロジ'].map((tag) => (
        <button key={tag} onClick={() => toggle(tag)}>{selected.includes(tag) ? '✓ ' : ''}{tag}</button>
      ))}
    </div>
  )
}
`

    // @covers REQ-551#lazy-initializer-site
    it('初期値を空の一覧を返す関数で渡す箇所が 1 つだけあると、その箇所を挙げて終了 1 で止める', () => {
      const body = pickerWith('  const [selected, setSelected] = useState<string[]>(() => [])')
      expectSitesListed({ 'TagPicker.tsx': body }, [['TagPicker.tsx', 'useState<string[]>(() => [])']], '関数で渡す箇所')
    })

    // @covers REQ-551#type-asserted-site
    it('型を空の一覧の後ろに添えて渡す箇所が 1 つだけあると、その箇所を挙げて終了 1 で止める', () => {
      const body = pickerWith('  const [selected, setSelected] = useState([] as string[])')
      expectSitesListed({ 'TagPicker.tsx': body }, [['TagPicker.tsx', 'useState([] as string[])']], '型を添えた箇所')
    })

    // @covers REQ-551#multiline-type-argument-site
    it('型引数を複数の行に分けた箇所が 1 つだけあると、useState を書いた行を挙げて終了 1 で止める', () => {
      const body = pickerWith('  const [selected, setSelected] = useState<\n    string[]\n  >([])')
      expectSitesListed({ 'TagPicker.tsx': body }, [['TagPicker.tsx', 'useState<']], '型引数が複数の行の箇所')
    })

    // @covers REQ-551#nested-type-argument-site
    it('型引数に別の型引数を入れ子にした箇所が 1 つだけあると、その箇所を挙げて終了 1 で止める', () => {
      const body = pickerWith('  const [selected, setSelected] = useState<Array<string>>([])')
      expectSitesListed({ 'TagPicker.tsx': body }, [['TagPicker.tsx', 'useState<Array<string>>([])']], '入れ子の型引数の箇所')
    })

    // @covers REQ-551#namespaced-call-site
    it('状態を作る関数を名前空間から呼ぶ箇所が 1 つだけあると、その箇所を挙げて終了 1 で止める', () => {
      const body = pickerWith('  const [selected, setSelected] = React.useState<string[]>([])', "import React from 'react'")
      expectSitesListed({ 'TagPicker.tsx': body }, [['TagPicker.tsx', 'React.useState<string[]>([])']], '名前空間から呼ぶ箇所')
    })
  })
})
