/** UC-027 書き直した世代の教材と単元の構成を配る本文に組み立てる。契約の入口のうち、配る本文の教材の一覧（listDeliveredMaterials）と
 *  流す前の投入の検査（checkSeed）、投入の組み立て（buildSeed）が作る用語集、図の差し込み（attachMaterialFigures）が前の世代から
 *  選んだ論点に足す図の行を、資格対策の学び（ip）の写しを置いた一時の作業場を cwd にしたコマンドとして呼ぶ。
 *
 *  入口の呼び方は契約の先頭のコメントの決まり（request の欄は同じ名前の引数、大文字の前に - を入れた小文字）から作る:
 *  listDeliveredMaterials は `python3 scripts/material_generations.py --data <置き場> [--registered] [--refusal-only]`、
 *  checkSeed は `python3 scripts/check_seed.py --data <置き場> [--sql <投入>]`。応答と ToolError は標準出力の JSON
 *  （全体が 1 つ、または最後の行）で読み、終了コードはプロセスの終了コードで見る。
 *
 *  観測: 用語集は、組み立てた投入を migrations を当てた SQLite に流して表を SELECT で見る。前の世代から選んだ論点の図の行は、
 *  投入を流した D1 の配る本文を getTopicDetail（HTTP）で見る。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  PREVIOUS,
  REWRITTEN,
  ROOT,
  SEED,
  attachFigures,
  buildSeed,
  catalog,
  cleanWorkspaces,
  editEntries,
  entriesOf,
  figureFile,
  figureSpec,
  loadSeed,
  makeWorkspace,
  mark,
  planFile,
  rewrittenMaterial,
  seededDbFile,
  topicDetail,
  withDbFile,
  type Catalog,
  type Json,
  type Run,
  type Ws,
} from './UC-027_fixture'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 })

const LEARNING = 'ip'
const [V1, V2, V3] = PREVIOUS

/* ---------- 入口と出力の読み方 ---------- */

type Out = { status: number | null; stdout: string; out: string }

function tool(ws: Ws, script: string, args: string[]): Out {
  const r = spawnSync('python3', [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ws.dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout}\n${r.stderr}`.split(ws.dir).join('<ws>') }
}

/** listDeliveredMaterials: `python3 scripts/material_generations.py --data <置き場> [引数…]` */
const listMaterials = (ws: Ws, extra: string[] = [], data = ws.data) => tool(ws, 'material_generations.py', ['--data', data, ...extra])
/** checkSeed: `python3 scripts/check_seed.py --data <置き場> [引数…]` */
const checkSeed = (ws: Ws, extra: string[] = [], data = ws.data) => tool(ws, 'check_seed.py', ['--data', data, ...extra])

/** 標準出力の JSON。全体が 1 つの JSON ならそれを、でなければ { で始まる最後の行を読む。 */
function jsonOf(stdout: string): Json | null {
  try {
    return JSON.parse(stdout.trim())
  } catch {
    /* 最後の行を読む */
  }
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t)
    } catch {
      continue
    }
  }
  return null
}

/** 断ったとき: 終了コードが 0 でなく、標準出力に ToolError の形でその code を出し、理由が空でない。 */
function expectToolError(r: Out, code: string, label: string) {
  expect(r.status, `${label}: 断らずに終了 0 で終わった:\n${r.out}`).not.toBe(0)
  const e = jsonOf(r.stdout)
  expect(e?.error?.code, `${label}: 標準出力の ToolError の code が ${code} でない:\n${r.out}`).toBe(code)
  expect(String(e?.error?.reason ?? '').length, `${label}: 理由が無い`).toBeGreaterThan(0)
}

const ok = (r: Run | Out, label: string) => expect(r.status, `${label} が終了 0 で終わらない:\n${r.out}`).toBe(0)

/** 学びの置き場の下のファイルの一覧（相対パス・大きさ・更新時刻）。何も書き出していないことを見る。 */
function treeOf(ws: Ws, rel: string): string[] {
  const out: string[] = []
  const walk = (abs: string) => {
    if (!fs.existsSync(abs)) return
    for (const n of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, n.name)
      if (n.isDirectory()) walk(p)
      else {
        const st = fs.statSync(p)
        out.push(`${path.relative(ws.dir, p)}:${st.size}:${st.mtimeMs}`)
      }
    }
  }
  walk(ws.abs(rel))
  return out.sort()
}

/** 教材の世代のファイルの名前（名前の順）。 */
const genFileNames = (ws: Ws, gen: string) => {
  const dir = ws.abs(`${ws.data}/${gen}`)
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []
}

afterAll(() => cleanWorkspaces())

/* ---------- REQ-530 ---------- */

describe('配る本文の教材を、選んだ世代とファイルの名前を添えて出す（UC-027）', () => {
  let gw: Ws
  let zz: Ws
  let cat: Catalog
  /** 書き直した世代と前の世代の両方にある論点（書き直した世代の 01-1 にだけ）。 */
  let A = 0
  /** 書き直した世代の 01-1 と 01-2 の両方にある論点。 */
  let B = 0
  /** 書き直した世代にだけある論点（01-2）。 */
  let C = 0
  /** 最も新しい前の世代が v3 の論点。 */
  let D = 0
  /** v3 から消して、最も新しい前の世代が v2 になった論点。 */
  let E = 0
  let listed: Out
  let res: Json | null
  /** 世代を古い順に重ねた、論点ごとの選んだ世代とファイルと教材。 */
  const expected = new Map<number, { gen: string; file: string; entry: Json }>()
  const EARLY = '目印-前のファイル'
  const LATE = '目印-後のファイル'

  const fileOf = (gen: string, id: number) =>
    genFileNames(gw, gen).filter((n) => (gw.readJson(`${gw.data}/${gen}/${n}`).materials as Json[]).some((m) => m.topic_id === id))
  const materialOf = (id: number): Json | undefined => ((res?.materials as Json[] | undefined) ?? []).find((m) => m.topic_id === id)

  beforeAll(() => {
    gw = makeWorkspace(LEARNING)
    zz = makeWorkspace(LEARNING, 'zzz')
    cat = catalog(gw)
    const all = [...cat.term.keys()].sort((a, b) => a - b)
    const used = new Set<number>()
    const pick = (cond: (id: number) => boolean, label: string) => {
      const id = all.find((x) => !used.has(x) && cond(x))
      if (!id) throw new Error(`${label} を選べない（仕込みを作れない）`)
      used.add(id)
      return id
    }
    const onlyOneV3 = (id: number) => entriesOf(gw, V3, id).length === 1 && fileOf(V3, id).length === 1
    A = pick(onlyOneV3, '論点 A')
    B = pick(onlyOneV3, '論点 B')
    C = pick(onlyOneV3, '論点 C')
    D = pick(onlyOneV3, '論点 D')
    E = pick((id) => onlyOneV3(id) && entriesOf(gw, V2, id).length === 1 && fileOf(V2, id).length === 1, '論点 E')

    for (const g of PREVIOUS) editEntries(gw, g, C, () => 'remove')
    editEntries(gw, V3, E, () => 'remove')
    const material = (id: number, extra = '') => {
      const m = rewrittenMaterial(id, cat.term.get(id)!)
      if (extra) m.explanation = `${extra}-${id}\n\n${m.explanation}`
      return m
    }
    gw.writeJson(`${gw.data}/${REWRITTEN}/01-1.json`, { bundle: '01-1', materials: [material(A), material(B, EARLY)] })
    gw.writeJson(`${gw.data}/${REWRITTEN}/01-2.json`, { bundle: '01-2', materials: [material(B, LATE), material(C)] })

    for (const gen of [...PREVIOUS, REWRITTEN])
      for (const file of genFileNames(gw, gen))
        for (const entry of gw.readJson(`${gw.data}/${gen}/${file}`).materials as Json[]) expected.set(entry.topic_id, { gen, file, entry })

    listed = listMaterials(gw)
    res = jsonOf(listed.stdout)
  })

  const expectChosen = (id: number, label: string) => {
    ok(listed, '配る本文の教材の一覧')
    const want = expected.get(id)!
    const got = materialOf(id)
    expect(got, `${label}: 論点 ${id} の教材が無い`).toBeTruthy()
    expect({ gen: got!._generation, file: got!._file }, `${label}: 論点 ${id} の選んだ世代とファイル`).toEqual({ gen: want.gen, file: want.file })
    expect(
      { term: got!.term, explanation: got!.explanation, detail: got!.detail },
      `${label}: 論点 ${id} の教材が選んだ世代の教材の欄でない`,
    ).toEqual({ term: want.entry.term, explanation: want.entry.explanation, detail: want.entry.detail })
  }

  // @covers REQ-530#rewritten-over-previous
  it('書き直した世代と前の世代の両方に教材がある論点は、書き直した世代の教材を、その世代の名前とファイルの名前を添えて出す', () => {
    expect(expected.get(A), '仕込み').toMatchObject({ gen: REWRITTEN, file: '01-1.json' })
    expectChosen(A, '書き直した世代と前の世代にある論点')
    expect(materialOf(A)!.explanation).toContain(mark(REWRITTEN, A))
  })

  // @covers REQ-530#rewritten-only
  it('書き直した世代にだけ教材がある論点は、書き直した世代の教材を、その世代の名前とファイルの名前を添えて出す', () => {
    expect(entriesOf(gw, V1, C).length + entriesOf(gw, V2, C).length + entriesOf(gw, V3, C).length, '仕込み: 前の世代に教材が残っている').toBe(0)
    expectChosen(C, '書き直した世代にだけある論点')
    expect(materialOf(C)!._file).toBe('01-2.json')
  })

  // @covers REQ-530#later-file-in-generation
  it('同じ世代の 2 つのファイルに教材がある論点は、後のファイルの教材を、そのファイルの名前を添えて出す', () => {
    expectChosen(B, '同じ世代の 2 つのファイルにある論点')
    expect(materialOf(B)!._file).toBe('01-2.json')
    expect(materialOf(B)!.explanation).toContain(`${LATE}-${B}`)
  })

  // @covers REQ-530#latest-previous-generation
  it('書き直した世代に教材が無い論点は、最も新しい前の世代（v3 の論点は v3、v3 に無く v2 にある論点は v2）の教材を、その世代とファイルの名前を添えて出す', () => {
    expect(expected.get(D)?.gen, '仕込み').toBe(V3)
    expect(expected.get(E)?.gen, '仕込み').toBe(V2)
    expectChosen(D, '最も新しい前の世代が v3 の論点')
    expectChosen(E, '最も新しい前の世代が v2 の論点')
  })

  // @covers REQ-530#topic-order-once
  it('教材は、どれかの世代に教材がある論点ごとに 1 つ、論点の番号の順に並ぶ', () => {
    ok(listed, '配る本文の教材の一覧')
    const ids = ((res?.materials as Json[] | undefined) ?? []).map((m) => m.topic_id)
    expect(ids, '論点の並び').toEqual([...expected.keys()].sort((a, b) => a - b))
  })

  // @covers REQ-530#counts-by-generation
  it('世代ごとの論点の数は、論点ごとに選んだ世代で 1 論点を 1 回だけ数えた数で、選んだ論点が無い世代は持たない', () => {
    ok(listed, '配る本文の教材の一覧')
    const want: Record<string, number> = {}
    for (const { gen } of expected.values()) want[gen] = (want[gen] ?? 0) + 1
    expect(want[REWRITTEN], '仕込み: 書き直した世代から選ぶ論点の数').toBe(3)
    expect(res?.topicsByGeneration, '世代ごとの論点の数').toEqual(want)
  })

  // @covers REQ-530#stopping-plan-still-listed
  it('単元の構成の門の止める理由に当たる単元の構成があっても、断らずに同じ教材を出す', () => {
    const unitNo = [...cat.unitTopics.keys()][0]
    gw.writeText(planFile(gw, unitNo), '{"unit_no": ')
    try {
      const r = listMaterials(gw)
      ok(r, '止める理由のある単元の構成がある学びの教材の一覧')
      const got = ((jsonOf(r.stdout)?.materials as Json[] | undefined) ?? []).map((m) => [m.topic_id, m._generation, m._file])
      expect(got).toEqual([...expected.entries()].sort((a, b) => a[0] - b[0]).map(([id, w]) => [id, w.gen, w.file]))
    } finally {
      gw.remove(`${gw.data}/unit_plans`)
    }
  })

  // @covers REQ-530#unregistered-listed
  it('registered を渡さなければ、登録簿に無い学びの置き場でも、論点ごとに選んだ教材を世代とファイルの名前を添えて出す', () => {
    const r = listMaterials(zz)
    ok(r, '登録簿に無い学びの教材の一覧')
    const body = jsonOf(r.stdout)
    const mats = (body?.materials as Json[] | undefined) ?? []
    expect(mats.length, '教材が無い').toBeGreaterThan(0)
    for (const m of mats.slice(0, 5)) {
      expect(m._generation).toMatch(/^materials(_v[0-9]+)?$/)
      expect(m._file).toMatch(/\.json$/)
    }
    expect(Object.keys(body?.topicsByGeneration ?? {}).length, '世代ごとの論点の数が無い').toBeGreaterThan(0)
  })

  // @covers REQ-487#delivered-materials-unregistered
  it('registered を渡すと、登録簿に無い学びは INVALID_INPUT で断り、教材を出さない', () => {
    const r = listMaterials(zz, ['--registered'])
    expectToolError(r, 'INVALID_INPUT', '登録簿に無い学び')
    expect(jsonOf(r.stdout)?.materials, '断ったのに教材を出した').toBeUndefined()
  })

  // @covers REQ-530#refusal-only-passes
  it('registered と refusalOnly を渡すと、登録簿にある学びは終了 0 で通し、教材も世代ごとの論点の数も出さない', () => {
    const r = listMaterials(gw, ['--registered', '--refusal-only'])
    ok(r, '断るかどうかだけを見る一覧')
    const body = jsonOf(r.stdout)
    expect(body?.materials, '教材を出した').toBeUndefined()
    expect(body?.topicsByGeneration, '世代ごとの論点の数を出した').toBeUndefined()
  })
})

/* ---------- REQ-529 ---------- */

describe('投入の組み立ては、用語集を問題解説の注記と教材から作った語だけに入れ替える（UC-027）', () => {
  let gl: Ws
  let cat: Catalog
  let glossary = new Map<string, Json>()
  let built: Run
  let dbFile = ''
  const STALE = '前の投入だけにあった検証の語'
  const TERM_A = '検証の語甲'
  const TERM_B = '検証の語乙'
  const TERM_C = '検証の語丙'
  const TERM_D = '検証の語丁'
  const TERM_E = '検証の語戊'
  const UNFILLED = '補えない検証の語'
  const OVERRIDE_BRIEF = '上書きした検証の説明です'
  let T0 = { id: 0, term: '' }
  let T1 = { id: 0, term: '' }
  let T2 = { id: 0, term: '' }
  let PARTIAL = ''

  const examOf = (qid: string) => qid.split('-q')[0]
  const yearOf = (exam: string) => Number(exam.slice(0, 4))
  /** 文末の句点を落とす（BR は句点を残すかを決めていない）。 */
  const sentence = (s: unknown) => String(s ?? '').replace(/。$/, '')
  const row = (term: string) => glossary.get(term)

  beforeAll(async () => {
    gl = makeWorkspace(LEARNING)
    cat = catalog(gl)
    const explDir = `${gl.data}/question_explanations`
    const files = fs.readdirSync(gl.abs(explDir)).filter((n) => n.endsWith('.json')).sort().map((n) => `${explDir}/${n}`)
    const bodies = new Map(files.map((f) => [f, gl.readJson(f)]))
    const overridesRel = `${gl.data}/glossary_overrides.json`
    const overrides = fs.existsSync(gl.abs(overridesRel)) ? gl.readJson(overridesRel) : {}
    const taken = new Set<string>(Object.keys(overrides))
    for (const b of bodies.values()) for (const e of b.explanations as Json[]) for (const ch of e.choices as Json[]) if (ch.term) taken.add(ch.term)

    const topics = [...cat.term.entries()].filter(([, t]) => !taken.has(t)).sort((a, b) => a[0] - b[0])
    if (topics.length < 3) throw new Error('選択肢の用語にも上書きにも無い名前の論点が 3 つ無い（仕込みを作れない）')
    ;[T0, T1, T2] = topics.slice(0, 3).map(([id, term]) => ({ id, term }))
    PARTIAL = `${T0.term}の検証の派生語`

    const all = [...bodies.entries()].flatMap(([f, b]) => (b.explanations as Json[]).map((e) => ({ f, e })))
    const years = all.map(({ e }) => yearOf(examOf(e.question_id)))
    const newest = all.filter(({ e }) => yearOf(examOf(e.question_id)) === Math.max(...years))
    const oldest = all.filter(({ e }) => yearOf(examOf(e.question_id)) === Math.min(...years))
    if (newest.length < 2 || oldest.length < 1 || Math.max(...years) === Math.min(...years))
      throw new Error('新しい回と古い回の問題解説を選べない（仕込みを作れない）')
    const [xNew, xOther] = newest
    const [xOld] = oldest
    const wrong = (e: Json) => (e.choices as Json[]).filter((ch) => ch.label !== e.correct)
    const right = (e: Json) => (e.choices as Json[]).find((ch) => ch.label === e.correct)!
    const set = (ch: Json, term: string, note: string) => {
      ch.term = term
      ch.note = note
    }
    set(right(xNew.e), TERM_B, `正解。${TERM_B}は正解の選択肢の検証の説明です。正解との対比の二文目です。`)
    const [n1, n2, n3] = wrong(xNew.e)
    set(n1, TERM_C, `${TERM_C}は新しい回の検証の説明です。二文目です。`)
    set(n2, TERM_A, `${TERM_A}は一文目の検証の説明です。二文目の検証の説明です。`)
    set(n3, TERM_D, `**強調した検証の語**と[[${TERM_A}]]を含む${TERM_D}の説明です。二文目です。`)
    const [o1, o2, o3] = wrong(xOld.e)
    set(o1, TERM_C, `${TERM_C}は古い回の検証の説明です。二文目です。`)
    set(o2, TERM_E, `${TERM_E}は問題解説の側の検証の説明です。二文目です。`)
    set(o3, T0.term, `${T0.term}を名前に持つ論点に結ぶ検証の説明です。二文目です。`)
    const [p1] = wrong(xOther.e)
    set(p1, PARTIAL, `${PARTIAL}は論点の名前を含む検証の説明です。二文目です。`)
    xOther.e.correct_reason = `${xOther.e.correct_reason}\n\n[[${T2.term}]]と[[${UNFILLED}]]を本文で用語として示します。`
    for (const [f, b] of bodies) gl.writeJson(f, b)

    overrides[TERM_E] = { brief: OVERRIDE_BRIEF, topic_id: T1.id }
    gl.writeJson(overridesRel, overrides)

    for (const g of PREVIOUS)
      editEntries(gl, g, T2.id, (m) => {
        m.explanation = `**${T2.term}**は補う検証の説明の一文目です。補う説明の二文目です。\n\n${m.explanation}`
      })

    built = buildSeed(gl)
    if (built.status !== 0) return
    const seed = gl.readText(SEED(gl))
    dbFile = seededDbFile(gl, 'glossary', seed)
    glossary = new Map(
      withDbFile(dbFile, (db) => db.prepare('SELECT term, brief, topic_id FROM glossary').all() as Json[]).map((r) => [r.term as string, r]),
    )
  })

  const built0 = () => ok(built, '投入の組み立て')

  // @covers REQ-529#choice-note-first-sentence
  it('問題解説の選択肢の用語は、その注記の 1 文目を説明にし、2 文目以降を持たない', () => {
    built0()
    expect(sentence(row(TERM_A)?.brief), `${TERM_A} の説明`).toBe(`${TERM_A}は一文目の検証の説明です`)
  })

  // @covers REQ-529#correct-mark-removed
  it('正解の選択肢の用語は、注記から正解の印を除いた 1 文目を説明にする', () => {
    built0()
    expect(sentence(row(TERM_B)?.brief), `${TERM_B} の説明`).toBe(`${TERM_B}は正解の選択肢の検証の説明です`)
  })

  // @covers REQ-529#newest-exam-note
  it('同じ語が古い回と新しい回の問題の選択肢にあれば、新しい回の問題の注記から説明を作る', () => {
    built0()
    expect(sentence(row(TERM_C)?.brief), `${TERM_C} の説明`).toBe(`${TERM_C}は新しい回の検証の説明です`)
  })

  // @covers REQ-529#markup-removed
  it('説明には、注記の 1 文目にあった用語の記法と強調の記法を残さない', () => {
    built0()
    expect(sentence(row(TERM_D)?.brief), `${TERM_D} の説明`).toBe(`強調した検証の語と${TERM_A}を含む${TERM_D}の説明です`)
  })

  // @covers REQ-529#override-brief-and-topic
  it('学びの置き場に用語の上書きがある語は、上書きの説明と論点の結び付けを使う', () => {
    built0()
    expect(row(TERM_E), `${TERM_E} の行`).toEqual({ term: TERM_E, brief: OVERRIDE_BRIEF, topic_id: T1.id })
  })

  // @covers REQ-529#body-term-filled-from-topic
  it('問題解説の本文で用語として示した説明の無い語は、名前が一致する論点の短い説明の 1 文目（記法を除く）で補い、その論点に結ぶ', () => {
    built0()
    const r = row(T2.term)
    expect(r, `${T2.term} が用語集に無い`).toBeTruthy()
    expect(sentence(r!.brief), `${T2.term} の説明`).toBe(`${T2.term}は補う検証の説明の一文目です`)
    expect(r!.topic_id, `${T2.term} の結ぶ論点`).toBe(T2.id)
  })

  // @covers REQ-529#body-term-unfilled-absent
  it('問題解説の本文で用語として示した説明の無い語で、名前が一致する論点も無い語は、用語集に入れない', () => {
    built0()
    expect(row(UNFILLED), `${UNFILLED} が用語集にある`).toBeUndefined()
  })

  // @covers REQ-529#exact-name-linked
  it('論点の名前と完全に一致する選択肢の用語は、その論点に結ぶ', () => {
    built0()
    expect(row(T0.term)?.topic_id, `${T0.term} の結ぶ論点`).toBe(T0.id)
  })

  // @covers REQ-529#partial-name-not-linked
  it('論点の名前を含むが一致しない選択肢の用語は、どの論点にも結ばない', () => {
    built0()
    expect(row(PARTIAL), `${PARTIAL} が用語集に無い`).toBeTruthy()
    expect(row(PARTIAL)!.topic_id, `${PARTIAL} の結ぶ論点`).toBeNull()
  })

  // @covers REQ-529#previous-rows-replaced
  it('前の投入で用語集の表にあり、今回の作り方で作らない語の行は、投入を流すと無くなり、作った語の行は残る', () => {
    built0()
    const seed = gl.readText(SEED(gl))
    const after = withDbFile(dbFile, (db) => {
      db.prepare('INSERT INTO glossary (term, brief, topic_id) VALUES (?, ?, ?)').run(STALE, '前の投入の説明です。', T0.id)
      db.exec(seed)
      return db.prepare('SELECT term FROM glossary').all() as Json[]
    })
    const terms = new Set(after.map((r) => r.term as string))
    expect(terms.has(STALE), `${STALE} の行が残った`).toBe(false)
    expect([...terms].sort(), '作った語の行').toEqual([...glossary.keys()].sort())
  })
})

/* ---------- REQ-531 ---------- */

describe('流す前の投入の検査は、問題があれば示して失敗で終える（UC-027）', () => {
  let sw: Ws
  let built: Run
  let seed = ''

  /** 文の始まり（INSERT INTO <表> … VALUES (<先頭の値>）から、次の文の始まりの直前まで。 */
  function statementRange(sql: string, table: string, firstValue: string): [number, number] {
    const head = new RegExp(`^INSERT INTO ${table} \\([^)]*\\) VALUES \\(${firstValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, `, 'm')
    const m = head.exec(sql)
    if (!m) throw new Error(`仕込み: ${table} の ${firstValue} の文が投入に無い`)
    const next = /\n(?=INSERT INTO |DELETE FROM |UPDATE |-- )/g
    next.lastIndex = m.index + 1
    const n = next.exec(sql)
    return [m.index, n ? n.index + 1 : sql.length]
  }
  const statement = (sql: string, table: string, firstValue: string) => {
    const [a, b] = statementRange(sql, table, firstValue)
    return sql.slice(a, b)
  }
  const replaceStatement = (sql: string, table: string, firstValue: string, f: (s: string) => string) => {
    const [a, b] = statementRange(sql, table, firstValue)
    return sql.slice(0, a) + f(sql.slice(a, b)) + sql.slice(b)
  }
  const dropStatement = (sql: string, table: string, firstValue: string) => replaceStatement(sql, table, firstValue, () => '')

  type Q = { id: string; exam: string; label: string; answer: string; key: string; figure: string | null }
  /** 投入の過去問の行（id・回・年度ラベル・正解・内容の鍵・図の画像）。 */
  function questionsOf(sql: string): Q[] {
    const out: Q[] = []
    const re = /^INSERT INTO past_questions \(id, exam, exam_label, [^)]*\) VALUES \('([^']+)', '([^']+)', '([^']+)', /gm
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      const s = statement(sql, 'past_questions', `'${m[1]}'`)
      const key = /'([0-9a-f]+)'\) ON CONFLICT\(id\)/.exec(s)
      if (!key) throw new Error(`仕込み: 問 ${m[1]} の内容の鍵を読めない`)
      const fig = /'(\/figures\/[^']+\.(?:png|svg|jpg))'/.exec(s)
      const ans = /', '([^']+)', (?:0|1|true|false), /.exec(s.slice(s.indexOf("'{")))
      out.push({ id: m[1], exam: m[2], label: m[3], answer: ans ? ans[1] : '', key: key[1], figure: fig ? fig[1] : null })
    }
    return out
  }

  /** 書き換えた投入を別のファイルに書いて、それを検査する。 */
  function checkTampered(name: string, sql: string): Out {
    const rel = `${sw.data}/seed_${name}.sql`
    sw.writeText(rel, sql)
    return checkSeed(sw, ['--sql', rel])
  }
  /** 置き場から 1 つのファイルを外して検査し、戻す。 */
  function checkWithout(rel: string): Out {
    const abs = sw.abs(rel)
    const saved = fs.readFileSync(abs)
    fs.rmSync(abs)
    try {
      return checkSeed(sw)
    } finally {
      fs.writeFileSync(abs, saved)
    }
  }
  const expectProblem = (r: Out, hints: string[], label: string) => {
    expect(r.status, `${label}: 問題があるのに終了 1 で終わらない:\n${r.out}`).toBe(1)
    expect(
      hints.some((h) => r.out.includes(h)),
      `${label}: 問題を示していない（${hints.join('・')} のどれも出力に無い）:\n${r.out.slice(0, 4000)}`,
    ).toBe(true)
  }

  beforeAll(() => {
    sw = makeWorkspace(LEARNING)
    built = buildSeed(sw)
    if (built.status === 0) seed = sw.readText(SEED(sw))
  })
  const seedOf = () => {
    ok(built, '投入の組み立て')
    return seed
  }

  // @covers REQ-531#clean-seed-passes
  it('組み立てたままの投入は、問題を示さずに終了 0 で終える', () => {
    seedOf()
    const r = checkSeed(sw)
    expect(r.status, `問題の無い投入で失敗した:\n${r.out}`).toBe(0)
  })

  // @covers REQ-531#citation-exam-name
  it('過去問の出典の試験名が登録簿の学びの名前と違う投入は、問題として示して終了 1 で終える', () => {
    seedOf()
    const out = `${sw.data}/seed_exam_name.sql`
    ok(buildSeed(sw, sw.data, ['--exam-name', '架空の検証試験', '--out', out]), '試験名を別に渡した投入の組み立て')
    const r = checkSeed(sw, ['--sql', out])
    expectProblem(r, ['架空の検証試験'], '出典の試験名')
  })

  // @covers REQ-531#citation-year-label
  it('過去問の出典の年度ラベルがその回の年度ラベルと違う投入は、問題として示して終了 1 で終える', () => {
    const q = questionsOf(seedOf())[0]
    const wrong = '令和99年度 架空期'
    const sql = replaceStatement(seed, 'past_questions', `'${q.id}'`, (s) => {
      const t = s.replace(`'出典：${q.label}`, `'出典：${wrong}`)
      if (t === s) throw new Error(`仕込み: 問 ${q.id} の出典に年度ラベル ${q.label} が無い`)
      return t
    })
    expectProblem(checkTampered('year_label', sql), [q.id, wrong], '出典の年度ラベル')
  })

  // @covers REQ-531#question-count-per-exam
  it('ある回の過去問が 1 問欠けた投入（紐付け・問題解説・出題頻度は欠けた問に合わせる）は、問題として示して終了 1 で終える', () => {
    const qs = questionsOf(seedOf())
    const q = qs.find((x) => qs.filter((y) => y.key === x.key).length === 1)!
    let sql = dropStatement(seed, 'past_questions', `'${q.id}'`)
    sql = dropStatement(sql, 'question_explanations', `'${q.key}'`)
    const links = [...sql.matchAll(new RegExp(`^INSERT INTO topic_questions \\([^)]*\\) VALUES \\((\\d+), '${q.id}', [^\\n]*\\n`, 'gm'))]
    for (const l of links) sql = sql.replace(l[0], '')
    for (const l of links)
      sql = replaceStatement(sql, 'topics', l[1], (s) => s.replace(/, (\d+)\) ON CONFLICT\(id\)/, (_m, n) => `, ${Number(n) - 1}) ON CONFLICT(id)`))
    expectProblem(checkTampered('question_count', sql), [q.exam], '回ごとの問題数')
  })

  /** 過去問の文の、問題文と選択肢の 2 つの文字列リテラル（'' を含めた SQL の書き方のまま）。 */
  function textAndChoices(stmt: string): string {
    const head = /VALUES \('(?:[^']|'')*', '(?:[^']|'')*', '(?:[^']|'')*', \d+, /.exec(stmt)
    if (!head) throw new Error('仕込み: 過去問の文の形を読めない')
    const lit = /'(?:[^']|'')*', '(?:[^']|'')*'/y
    lit.lastIndex = head.index + head[0].length
    const m = lit.exec(stmt)
    if (!m) throw new Error('仕込み: 問題文と選択肢を読めない')
    return m[0]
  }

  // @covers REQ-531#same-content-answer-split
  it('同一内容の組（本文と選択肢が同じ過去問）の正解が割れた投入は、問題として示して終了 1 で終える', () => {
    const qs = questionsOf(seedOf())
    const a = qs[0]
    const b = qs.find((x) => x.exam !== a.exam && x.answer && a.answer && x.answer !== a.answer && qs.filter((y) => y.key === x.key).length === 1)
    if (!b) throw new Error('仕込み: 正解の違う別の回の問が無い')
    const aBody = textAndChoices(statement(seed, 'past_questions', `'${a.id}'`))
    let sql = replaceStatement(seed, 'past_questions', `'${b.id}'`, (s) => {
      const t = s.replace(textAndChoices(s), () => aBody).replace(`'${b.key}') ON CONFLICT`, `'${a.key}') ON CONFLICT`)
      if (!t.includes(aBody) || !t.includes(`'${a.key}') ON CONFLICT`)) throw new Error('仕込み: 問の本文と選択肢と内容の鍵を書き換えられない')
      return t
    })
    sql = dropStatement(sql, 'question_explanations', `'${b.key}'`)
    expectProblem(checkTampered('answer_split', sql), [a.key, a.id, b.id], '同一内容の組の正解')
  })

  // @covers REQ-531#question-figure-missing
  it('過去問が指す図の画像が置き場に無ければ、問題として示して終了 1 で終える', () => {
    const q = questionsOf(seedOf()).find((x) => x.figure && fs.existsSync(sw.abs(`public${x.figure}`)))
    if (!q) throw new Error('仕込み: 図の画像を指す過去問が無い')
    expectProblem(checkWithout(`public${q.figure}`), [path.basename(q.figure!)], '過去問の図の画像')
  })

  // @covers REQ-531#material-figure-missing
  it('教材が指す図の画像が配信の置き場に無ければ、問題として示して終了 1 で終える', () => {
    const m = new RegExp(`\\]\\((/figures/materials/${sw.learning}/[^)\\s]+\\.svg)`).exec(seedOf())
    if (!m || !fs.existsSync(sw.abs(`public${m[1]}`))) throw new Error('仕込み: 図の画像を指す教材が無い')
    expectProblem(checkWithout(`public${m[1]}`), [path.basename(m[1])], '教材の図の画像')
  })

  // @covers REQ-531#frequency-mismatch
  it('論点の出題頻度が紐づく過去問の件数と違う投入は、問題として示して終了 1 で終える', () => {
    const t = /^INSERT INTO topics \([^)]*\) VALUES \((\d+), '([^']+)', /m.exec(seedOf())!
    const sql = replaceStatement(seed, 'topics', t[1], (s) => s.replace(/, (\d+)\) ON CONFLICT\(id\)/, (_m, n) => `, ${Number(n) + 1}) ON CONFLICT(id)`))
    expect(sql, '仕込み: 出題頻度を書き換えられない').not.toBe(seed)
    expectProblem(checkTampered('frequency', sql), [t[2], `論点 ${t[1]}`, `topic ${t[1]}`, `topic_id ${t[1]}`, `${t[1]}:`], '出題頻度')
  })

  // @covers REQ-531#explanation-target-missing
  it('問題解説の行き先（内容の鍵）の過去問が無い投入は、問題として示して終了 1 で終える', () => {
    const q = questionsOf(seedOf()).find((x) => seed.includes(`INSERT INTO question_explanations (content_key, correct_reason, choices_json, updated_at) VALUES ('${x.key}', `))
    if (!q) throw new Error('仕込み: 問題解説のある過去問が無い')
    const ghost = 'f0f0f0f0f0f0f0f0'
    const sql = replaceStatement(seed, 'question_explanations', `'${q.key}'`, (s) => s.replace(`VALUES ('${q.key}', `, `VALUES ('${ghost}', `))
    expectProblem(checkTampered('explanation_target', sql), [ghost, q.key, q.id], '問題解説の行き先')
  })

  // @covers REQ-531#glossary-target-missing
  it('用語集の行き先（結ぶ論点）が無い投入は、問題として示して終了 1 で終える', () => {
    const g = /^INSERT INTO glossary \(term, brief, topic_id\) VALUES \('([^']+)', '(?:[^']|'')*', (\d+)\)/m.exec(seedOf())
    if (!g) throw new Error('仕込み: 論点に結ぶ用語集の行が無い')
    const sql = replaceStatement(seed, 'glossary', `'${g[1]}'`, (s) => s.replace(/, (\d+)\) ON CONFLICT/, ', 999999) ON CONFLICT'))
    expect(sql, '仕込み: 用語集の結ぶ論点を書き換えられない').not.toBe(seed)
    expectProblem(checkTampered('glossary_target', sql), [g[1], '999999'], '用語集の行き先')
  })

  // @covers REQ-531#user-data-write
  it('利用者のデータの表（進捗）に書き込む文を含む投入は、問題として示して終了 1 で終える', () => {
    const t = /^INSERT INTO topics \([^)]*\) VALUES \((\d+), /m.exec(seedOf())!
    const sql = `${seed}\nINSERT INTO progress (user_id, topic_id, status) VALUES ('u-1', ${t[1]}, 1);\n`
    expectProblem(checkTampered('user_data', sql), ['progress'], '利用者のデータの表への書き込み')
  })
})

/* ---------- REQ-487（流す前の投入の検査） ---------- */

describe('登録簿に無い学びの流す前の投入の検査は、何も書き出さずに断る（UC-027）', () => {
  let zz: Ws
  beforeAll(() => {
    zz = makeWorkspace(LEARNING, 'zzz')
    if (!fs.existsSync(zz.abs(`${zz.data}/seed.sql`))) zz.writeText(`${zz.data}/seed.sql`, fs.readFileSync(path.join(ROOT, 'data', LEARNING, 'seed.sql'), 'utf8'))
  })

  // @covers REQ-487#check-seed-unregistered
  it('検査する投入があっても、登録簿に無い学びの流す前の投入の検査は INVALID_INPUT で断り、学びの置き場に何も書き出さない', () => {
    const before = treeOf(zz, 'data')
    expectToolError(checkSeed(zz), 'INVALID_INPUT', '登録簿に無い学びの投入の検査')
    expect(treeOf(zz, 'data'), '学びの置き場が書き換わった').toEqual(before)
  })

  // @covers REQ-487#check-seed-unregistered-seed-missing
  it('検査する投入も無い登録簿に無い学びの流す前の投入の検査は、契約の errors の順で先の NOT_FOUND で断り、何も書き出さない', () => {
    const before = treeOf(zz, 'data')
    expectToolError(checkSeed(zz, ['--sql', `${zz.data}/no_such_seed.sql`]), 'NOT_FOUND', '投入も無い登録簿に無い学び')
    expect(treeOf(zz, 'data'), '学びの置き場が書き換わった').toEqual(before)
  })
})

/* ---------- REQ-542 ---------- */

describe('前の世代から選んだ論点の、本文に行の無い図の行を足す（UC-027）', () => {
  let fw: Ws
  let cat: Catalog
  type Loaded = { d1: D1Database | null; error: string }
  let first: { attach: Run; run: Run; loaded: Loaded }
  let second: { attach: Run; run: Run; loaded: Loaded }
  /** 差し込み位置が短い説明の図 1 枚。 */
  let P1 = 0
  /** 差し込み位置が見出し甲の図 1 枚。 */
  let P2 = 0
  /** 差し込み位置が見出し乙の図 3 枚（図の仕様の順が id の昇順でも降順でもない）。 */
  let P3 = 0
  /** 差し込み位置が教材に無い見出しの図 1 枚。 */
  let P4 = 0
  const HEAD_A = '### 前の世代の検証の見出し甲'
  const HEAD_B = '### 前の世代の検証の見出し乙'
  const HEAD_ABSENT = '### 教材に無い検証の見出し'
  const P3_SPEC = [2, 3, 1]

  type Layout = [string, string][]
  /** 空でない行ごとに [置き場, 種類]。置き場は explanation・detail の先頭・見出しの行。種類は 図<id> か 本文。 */
  const layoutOf = (body: { explanation?: string | null; detail?: string | null }, id: number): Layout => {
    const out: Layout = []
    const fig = new RegExp(`^\\s*!\\[.*\\]\\(/figures/materials/${fw.learning}/${id}-(\\d+)\\.svg\\)\\s*$`)
    const scan = (text: string | null | undefined, firstSection: string) => {
      let section = firstSection
      for (const line of String(text ?? '').split('\n')) {
        if (!line.trim()) continue
        if (firstSection !== 'explanation' && line.startsWith('### ')) {
          section = line.trim()
          continue
        }
        const m = fig.exec(line)
        out.push([section, m ? `図${m[1]}` : '本文'])
      }
    }
    scan(body.explanation, 'explanation')
    scan(body.detail, 'detail の先頭')
    return out
  }
  const kindsIn = (layout: Layout, section: string) => layout.filter(([sec]) => sec === section).map(([, k]) => k)
  const figsOf = (layout: Layout) => layout.map(([, k]) => k).filter((k) => k !== '本文')
  const layoutIn = async (s: Loaded, id: number) => {
    if (!s.d1) throw new Error(s.error)
    return layoutOf(await topicDetail(s.d1, LEARNING, id), id)
  }

  async function load(run: Run): Promise<Loaded> {
    if (run.status !== 0) return { d1: null, error: `組み立てが終了 0 で終わらない:\n${run.out}` }
    try {
      return { d1: await loadSeed(fw.readText(SEED(fw))), error: '' }
    } catch (e) {
      return { d1: null, error: `投入の SQL を流せない: ${String(e)}` }
    }
  }

  beforeAll(async () => {
    fw = makeWorkspace(LEARNING)
    cat = catalog(fw)
    const svgDir = fw.abs(`public/figures/materials/${fw.learning}`)
    const anySvg = fs.readdirSync(svgDir).find((n) => n.endsWith('.svg'))
    const template = fs
      .readdirSync(fw.abs(`${fw.data}/material_figures`))
      .filter((n) => n.endsWith('.json'))
      .map((n) => fw.readJson(`${fw.data}/material_figures/${n}`))
      .find((s) => (s.figures as Json[]).length > 0)
    if (!anySvg || !template) throw new Error('図の画像か図の仕様の手本が無い（仕込みを作れない）')
    const figTemplate = template.figures[0] as Json

    const ids = [...cat.term.keys()].filter((id) => entriesOf(fw, V3, id).length === 1).sort((a, b) => a - b)
    if (ids.length < 4) throw new Error('v3 に教材が 1 つある論点が 4 つ無い（仕込みを作れない）')
    ;[P1, P2, P3, P4] = ids.slice(0, 4)

    const writeTopic = (id: number, figs: { id: number; after: string }[]) => {
      for (const g of PREVIOUS)
        editEntries(fw, g, id, (m) => {
          m.explanation = `${mark(g, id)}\n\n短い説明の一段目です。\n\n短い説明の二段目です。\n\n- 短い説明の箇条です`
          m.detail = [HEAD_A, '甲の一段目です。', '', '甲の二段目です。', HEAD_B, '乙の一段目です。', '', '乙の二段目です。'].join('\n')
        })
      const spec = {
        topic_id: id,
        term: cat.term.get(id),
        figures: figs.map((f) => ({ ...JSON.parse(JSON.stringify(figTemplate)), id: f.id, after: f.after, caption: `図${f.id}の検証の説明です。` })),
      }
      fw.writeJson(figureFile(fw, id), spec)
      for (const f of figs) fs.copyFileSync(path.join(svgDir, anySvg), path.join(svgDir, `${id}-${f.id}.svg`))
    }
    writeTopic(P1, [{ id: 1, after: 'explanation' }])
    writeTopic(P2, [{ id: 1, after: HEAD_A }])
    writeTopic(P3, P3_SPEC.map((id) => ({ id, after: HEAD_B })))
    writeTopic(P4, [{ id: 1, after: HEAD_ABSENT }])

    const attach1 = attachFigures(fw)
    const run1 = buildSeed(fw)
    first = { attach: attach1, run: run1, loaded: await load(run1) }
    const attach2 = attachFigures(fw)
    const run2 = buildSeed(fw)
    second = { attach: attach2, run: run2, loaded: await load(run2) }
  })

  const okFirst = () => {
    ok(first.attach, '図の差し込み')
    ok(first.run, '投入の組み立て')
  }

  // @covers REQ-542#missing-explanation-figure-appended
  it('前の世代から選んだ論点で、差し込み位置が短い説明の図が本文に無ければ、その図の行を短い説明の末尾に 1 行足す', async () => {
    okFirst()
    const layout = await layoutIn(first.loaded, P1)
    const kinds = kindsIn(layout, 'explanation')
    expect(figsOf(layout), `論点 ${P1} の図の行`).toEqual(['図1'])
    expect(kinds.slice(-1), `短い説明の末尾が図の行でない: ${kinds.join(' → ')}`).toEqual(['図1'])
    expect(kinds.filter((k) => k === '本文').length, '仕込み: 短い説明に本文の行が無い').toBeGreaterThan(1)
  })

  // @covers REQ-542#missing-heading-figure-after-heading-line
  it('前の世代から選んだ論点で、差し込み位置が見出しの図が本文に無ければ、その図の行を見出しの行の直後（節の本文より上）に 1 行足す', async () => {
    okFirst()
    const layout = await layoutIn(first.loaded, P2)
    expect(figsOf(layout), `論点 ${P2} の図の行`).toEqual(['図1'])
    expect(kindsIn(layout, HEAD_A), `見出し甲の節の行の並び`).toEqual(['図1', '本文', '本文'])
  })

  // @covers REQ-542#missing-same-heading-later-on-top
  it('前の世代から選んだ論点で、同じ見出しを差し込み位置にする図が 3 枚本文に無ければ、見出しの行の直後に、後に足した図が上に来る並び（図の仕様の逆の順）で足す', async () => {
    okFirst()
    const layout = await layoutIn(first.loaded, P3)
    const want = [...P3_SPEC].reverse().map((id) => `図${id}`)
    expect(want, '仕込み: 図の仕様の逆の順が id の昇順か降順と同じ').not.toEqual(['図1', '図2', '図3'])
    expect(want).not.toEqual(['図3', '図2', '図1'])
    expect(kindsIn(layout, HEAD_B), `見出し乙の節の行の並び`).toEqual([...want, '本文', '本文'])
  })

  // @covers REQ-542#missing-heading-absent-to-explanation
  it('前の世代から選んだ論点で、差し込み位置の見出しが教材に無い図が本文に無ければ、その図の行を短い説明の末尾に 1 行足す', async () => {
    okFirst()
    const layout = await layoutIn(first.loaded, P4)
    const kinds = kindsIn(layout, 'explanation')
    expect(figsOf(layout), `論点 ${P4} の図の行`).toEqual(['図1'])
    expect(kinds.slice(-1), `短い説明の末尾が図の行でない: ${kinds.join(' → ')}`).toEqual(['図1'])
  })

  // @covers REQ-542#rerun-adds-nothing
  it('図の差し込みをもう一度かけても、足した図の行は増えも動きもしない', async () => {
    okFirst()
    ok(second.attach, '2 回目の図の差し込み')
    ok(second.run, '2 回目の投入の組み立て')
    for (const id of [P1, P2, P3, P4])
      expect(await layoutIn(second.loaded, id), `論点 ${id} の行の並び`).toEqual(await layoutIn(first.loaded, id))
  })
})
