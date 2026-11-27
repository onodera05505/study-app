import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DELIVERED, DELIVERED_FILE, EDITED, EDITED_FILE, EXPLAIN_FILE, EXPLAIN_TERMS, QUESTIONS_DIR, QUESTION_BUNDLES, ROADMAP_FILE, SNAPSHOT_8, SVG, UNITS,
  PNG, addFigureLine, roadmapOf, build, buildRaw, copyFixture, dropBody, imageRefs, isInside, isPng, makeWorkspace, packDetail, pngSize, question, resolveIn, resultFile, snapshotFile, svgWithText,
  toolError, withoutMacTools, writeQuestions,
  type Json, type Run, type Workspace,
} from './uc019_fixture'

/** UC-019 パックを作る入口（buildLearnerPack ＝ `python3 scripts/build_learner_pack.py`）の境界。
 *  観測するのは、標準出力の JSON と終了コード、出力先に書かれたパック、学びの置き場の eval の下の写しだけ。
 *  断るときは、出力先も写しも前と変わらないこと（部分適用なし）まで見る。 */

const PACK = 'packs/c8'
/** 1 つの単位について、パックの中のその単位のファイル（配る本文の説明を含む物）を探す。 */
const unitFileOf = (ws: Workspace, topicId: number) =>
  ws.files(PACK).filter((f) => f.startsWith('units/')).find((f) => ws.read(`${PACK}/${f}`).includes(DELIVERED.find((m) => m.topic_id === topicId)!.explanation))
/** パックの全テキストを 1 つにつなぐ（図の画像を除く）。 */
const packText = (ws: Workspace, pack = PACK) =>
  ws.files(pack).filter((f) => f.endsWith('.md')).map((f) => ws.read(`${pack}/${f}`)).join('\n')

/** 断ったときの共通の観測: 終了 1・ToolError の形とコード・出力先も写しも残らない。 */
function expectRefused(r: Run, ws: Workspace, code: string, before: { out: string; tree: Record<string, string> }) {
  expect(r.status).toBe(1)
  expect(r.code, r.stdout).toBe(code)
  expect(typeof toolError(r.json)?.reason === 'string' && toolError(r.json).reason.length > 0).toBe(true)
  expect(ws.snapshotTree(before.out)).toEqual(before.tree)
  expect(ws.exists(snapshotFile(8))).toBe(false)
}
const untouched = (ws: Workspace, out = PACK) => ({ out, tree: ws.snapshotTree(out) })
/** ToolError の figures を契約の欄（unit・ref）だけにして、並びによらず比べられる形にする。 */
const figuresOf = (r: Run) =>
  ((toolError(r.json)?.figures ?? []) as Json[]).map((f) => ({ unit: f.unit, ref: f.ref })).sort((a, b) => `${a.unit}${a.ref}`.localeCompare(`${b.unit}${b.ref}`))
/** 契約の欄だけを取り出す（契約に無い欄を足した実装も正しいとして比べる）。 */
const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o?.[k]]))
/** パックを作る 1 回は図を描くブラウザの起動を含み、手元のフィクスチャで数秒かかる。1 本のテストは最大 2 回作る。 */
const BUILD_TEST_TIMEOUT = 60_000
const BUILD_HOOK_TIMEOUT = 60_000
/** このファイルのすべてのテストとフックに見積もりを届ける（入れ子の describe・ループの中の it も含む）。 */
vi.setConfig({ testTimeout: BUILD_TEST_TIMEOUT, hookTimeout: BUILD_HOOK_TIMEOUT })

describe('UC-019 学習者役のパックを作る（buildLearnerPack）', { timeout: BUILD_TEST_TIMEOUT }, () => {
  describe('ロードマップ型で配る本文と図がそろい、その周の写しが無い', () => {
    let ws: Workspace
    let r: Run
    beforeAll(() => {
      ws = makeWorkspace()
      r = build(ws)
    }, BUILD_HOOK_TIMEOUT)

    /** @covers REQ-304#order-id-and-round */
    it('一覧はロードマップの学ぶ順に単位を並べ、各行に単位の ID を添え、その単位の回の見出しの下に置く', () => {
      expect(r.status).toBe(0)
      const md = ws.read(`${PACK}/roadmap.md`)
      const chapters = [...new Set(UNITS.map((u) => u.chapter))]
      let last = -1
      for (const u of UNITS) {
        const at = md.indexOf(u.term)
        expect(at, u.term).toBeGreaterThan(last)
        last = at
        const lineEnd = md.indexOf('\n', at) === -1 ? md.length : md.indexOf('\n', at)
        const line = md.slice(md.lastIndexOf('\n', at) + 1, lineEnd)
        expect(line, u.term).toMatch(new RegExp(`(^|[^0-9])${u.topic_id}([^0-9]|$)`))
        const head = md.slice(0, lineEnd)
        const nearest = chapters.map((c) => [c, head.lastIndexOf(c)] as const).sort((a, b) => b[1] - a[1])[0]
        expect(nearest[0], u.term).toBe(u.chapter)
      }
    })

    /** @covers REQ-304#unit-file-per-unit */
    it('ロードマップの単位ごとに 1 つのファイルがあり、ファイル名の番号の順が学ぶ順になる', () => {
      expect(r.status).toBe(0)
      const units = (r.json.files.units as string[]).slice()
      expect(units).toHaveLength(UNITS.length)
      for (const f of units) expect(f).toMatch(/^units\/[0-9]{2,}_.+\.md$/)
      const byNumber = units.sort((a, b) => Number(/^units\/(\d+)/.exec(a)![1]) - Number(/^units\/(\d+)/.exec(b)![1]))
      expect(byNumber).toEqual(UNITS.map((u) => unitFileOf(ws, u.topic_id)))
    })

    /** @covers REQ-304#quiz-questions */
    it('確認問題のファイルにロードマップの単位の問題が、問いと 4 つの選択肢とともに出る', () => {
      const md = ws.read(`${PACK}/quiz.md`)
      for (const q of QUESTION_BUNDLES.flat().filter((q) => UNITS.some((u) => u.topic_id === q.topic_id))) {
        expect(md).toContain(q.qid)
        expect(md).toContain(q.stem)
        for (const text of Object.values(q.choices)) expect(md).toContain(text)
      }
    })

    /** @covers REQ-304#answer-format */
    it('確認問題のファイルに、answers が空で units の各行が単位の ID を持つ答えと自己申告の書き方の JSON がある', () => {
      const md = ws.read(`${PACK}/quiz.md`)
      const blocks = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1])
      const formats = blocks.flatMap((b) => {
        try {
          const j = JSON.parse(b)
          return j && typeof j === 'object' && 'answers' in j && 'units' in j ? [j] : []
        } catch {
          return []
        }
      })
      expect(formats.length).toBeGreaterThan(0)
      const f = formats[0]
      expect(f.answers).toEqual({})
      expect(Array.isArray(f.units) && f.units.length > 0).toBe(true)
      for (const row of f.units) expect(Number.isInteger(row.topic_id)).toBe(true)
    })

    /** @covers REQ-304#explain-with-terms */
    it('説明テストの語の一覧を持つ学びでは、説明テストのファイルに一覧の語がすべて出る', () => {
      expect(r.json.files.explain).toBe('explain.md')
      const md = ws.read(`${PACK}/explain.md`)
      for (const t of EXPLAIN_TERMS.terms) expect(md).toContain(t.term)
    })

    /** @covers REQ-304#response-lists-files */
    it('応答の files はパックの中に実在するファイルと一致する', () => {
      const listed = [r.json.files.roadmap, ...r.json.files.units, r.json.files.quiz, r.json.files.explain, ...r.json.files.figures].sort()
      expect(listed).toEqual(ws.files(PACK))
      expect(r.json.files.roadmap).toBe('roadmap.md')
      expect(r.json.files.quiz).toBe('quiz.md')
    })

    /** @covers REQ-305#unit-header */
    it('各単位のファイルは単位の名前・分野・単元を添える', () => {
      for (const u of UNITS) {
        const md = ws.read(`${PACK}/${unitFileOf(ws, u.topic_id)}`)
        expect(md).toContain(u.term)
        expect(md).toContain(u.field)
        expect(md).toContain(u.middle)
      }
    })

    /** @covers REQ-305#full-body */
    it('各単位のファイルは配る本文の説明と詳しい解説（出典と図の行を含む）を、図の参照先を戻せば全文含む', () => {
      for (const m of DELIVERED) {
        const md = ws.read(`${PACK}/${unitFileOf(ws, m.topic_id)}`)
        expect(md).toContain(m.explanation)
        expect(md).toContain(packDetail(m.detail))
      }
    })

    /** @covers REQ-305#full-body */
    it('行頭と行末に空白を持つ図の行も図の行として、参照先だけを変えて空白ごと全文含む', () => {
      const w = makeWorkspace()
      const detail = `${DELIVERED.find((m) => m.topic_id === 4)!.detail}\n\u3000 ![足した図](/figures/materials/eng/5-1.svg)\t`
      w.write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED.map((m) => (m.topic_id === 4 ? { ...m, detail } : m)) })
      const res = build(w)
      expect(res.status, res.stdout + res.stderr).toBe(0)
      const file = w.files(PACK).filter((f) => f.startsWith('units/')).find((f) => w.read(`${PACK}/${f}`).includes(DELIVERED.find((m) => m.topic_id === 4)!.explanation))!
      expect(w.read(`${PACK}/${file}`)).toContain(packDetail(detail))
    })

    /** @covers REQ-305#delivered-not-edited */
    it('教材を直しても配る本文へ組み立て直していなければ、パックには配る本文が出て直した教材は出ない', () => {
      const text = packText(ws)
      for (const m of EDITED) {
        expect(text).not.toContain(m.explanation)
        expect(text).not.toContain(m.detail)
      }
    })

    /** 単位のファイルの図の参照先を、パックの中の実体に解いて返す。 */
    const figureOf = (topicId: number) => {
      const unit = `${PACK}/${unitFileOf(ws, topicId)}`
      const refs = imageRefs(ws.read(unit))
      expect(refs).toHaveLength(1)
      return resolveIn(ws.abs(unit), refs[0])
    }

    /** @covers REQ-306#svg-drawn-as-png */
    it('置き場の直下の svg の図は、パックの figures の下に拡張子を .png にした PNG として入り、本文の図はそれを指す', () => {
      expect(r.json.files.figures).toContain('figures/5-1.png')
      expect(figureOf(5)).toBe(ws.abs(`${PACK}/figures/5-1.png`))
      expect(isPng(ws.bytes(`${PACK}/figures/5-1.png`))).toBe(true)
    })

    /** @covers REQ-306#subpath-kept */
    it('置き場のサブパスの下の図は、figures の下に同じサブパスで PNG として入る', () => {
      expect(r.json.files.figures).toContain('figures/sub/2-1.png')
      expect(figureOf(2)).toBe(ws.abs(`${PACK}/figures/sub/2-1.png`))
      expect(isPng(ws.bytes(`${PACK}/figures/sub/2-1.png`))).toBe(true)
    })

    /** @covers REQ-306#png-source */
    it('元が png の図も、同じ名前の PNG としてパックに入る', () => {
      expect(r.json.files.figures).toContain('figures/9-1.png')
      expect(figureOf(9)).toBe(ws.abs(`${PACK}/figures/9-1.png`))
      expect(isPng(ws.bytes(`${PACK}/figures/9-1.png`))).toBe(true)
    })

    /** @covers REQ-306#unit-without-figure */
    it('図を含まない単位のファイルは画像を指さない', () => {
      expect(imageRefs(ws.read(`${PACK}/${unitFileOf(ws, 4)}`))).toEqual([])
    })

    /** @covers REQ-306#no-outside-reference */
    it('パックのどの本文も、配信の置き場・パックの外・PNG でない画像を指さない', () => {
      expect(r.json.files.figures.slice().sort()).toEqual(['figures/5-1.png', 'figures/9-1.png', 'figures/sub/2-1.png'])
      for (const f of ws.files(PACK).filter((f) => f.endsWith('.md'))) {
        const md = ws.read(`${PACK}/${f}`)
        expect(md, f).not.toContain('/figures/materials/')
        for (const ref of imageRefs(md)) {
          expect(ref, f).toMatch(/\.png$/)
          expect(isInside(ws.abs(PACK), resolveIn(ws.abs(`${PACK}/${f}`), ref)), `${f}: ${ref}`).toBe(true)
        }
      }
    })

    /** @covers REQ-307#reason-not-in-pack */
    it('確認問題のファイルに正解の根拠の欄が出ない', () => {
      expect(ws.read(`${PACK}/quiz.md`)).not.toContain('正解の根拠の印_')
    })

    /** @covers REQ-307#choice-notes-not-in-pack */
    it('確認問題のファイルに選択肢ごとの説明の欄が出ない', () => {
      expect(ws.read(`${PACK}/quiz.md`)).not.toContain('選択肢の説明の印_')
    })

    /** @covers REQ-308#off-roadmap-excluded */
    it('ロードマップに無い単位の確認問題は、パックにも写しにも入らない', () => {
      expect(packText(ws)).not.toContain('t77-1')
      expect(JSON.stringify(JSON.parse(ws.read(snapshotFile(8))))).not.toContain('t77-1')
    })

    /** @covers REQ-308#roadmap-questions-kept */
    it('ロードマップにある単位の確認問題はすべて写しに入る', () => {
      expect((r.json.snapshot.questions as Json[]).map((q) => q.qid).sort()).toEqual(['t2-1', 't5-1', 't5-2', 't9-1'])
    })

    /** @covers REQ-309#snapshot-file-and-response */
    it('写しは学びの置き場の eval の下の pack_cycle_<周>.json に残り、中身は応答の snapshot と同じ', () => {
      expect(r.json.snapshotPath).toBe(snapshotFile(8))
      expect(JSON.parse(ws.read(snapshotFile(8)))).toEqual(r.json.snapshot)
      expect(r.json.snapshot.cycle).toBe(8)
    })

    /** @covers REQ-309#roadmap-order-recorded */
    it('写しの units はその時点のロードマップの並び（順・単位の ID・名前・分野）', () => {
      expect((r.json.snapshot.units as Json[]).map((u) => pick(u, ['order', 'topic_id', 'term', 'field']))).toEqual(
        UNITS.map((u) => ({ order: u.order, topic_id: u.topic_id, term: u.term, field: u.field })),
      )
    })

    /** @covers REQ-309#questions-in-pack-order */
    it('写しの questions の並びは、確認問題のファイルに出した順', () => {
      const md = ws.read(`${PACK}/quiz.md`)
      const qids = (r.json.snapshot.questions as Json[]).map((q) => q.qid as string)
      const positions = qids.map((qid) => md.indexOf(`問いの本文_${qid}`))
      expect(positions.every((p) => p >= 0)).toBe(true)
      expect(positions).toEqual(positions.slice().sort((a, b) => a - b))
    })

    /** @covers REQ-309#question-attributes */
    it('写しの各問題は正解・属する単位・測る到達基準・属する単位の分野を持つ', () => {
      const byQid = Object.fromEntries((r.json.snapshot.questions as Json[]).map((q) => [q.qid, q]))
      for (const q of SNAPSHOT_8.questions) expect(pick(byQid[q.qid], ['qid', 'topic_id', 'tests_goal', 'field', 'answer'])).toEqual(q)
    })

    /** @covers REQ-309#snapshot-outside-pack */
    it('写しはパックの外にだけあり、パックには応答の files に挙げたファイルしか無い', () => {
      expect(isInside(ws.abs(PACK), ws.abs(r.json.snapshotPath))).toBe(false)
      const listed = [r.json.files.roadmap, ...r.json.files.units, r.json.files.quiz, r.json.files.explain, ...r.json.files.figures]
      for (const f of ws.files(PACK)) expect(listed).toContain(f)
    })
  })

  /** @covers REQ-304#no-explain-without-terms */
  it('説明テストの語の一覧を持たない学びでは、説明テストのファイルを出さない', () => {
    const ws = makeWorkspace()
    ws.remove(EXPLAIN_FILE)
    const r = build(ws)
    expect(r.status).toBe(0)
    expect(r.json.files.explain).toBeUndefined()
    expect(ws.exists(`${PACK}/explain.md`)).toBe(false)
  })

  describe('図の描き方（REQ-306）', () => {
    const TALL = { w: 640, h: 760, x: 20, y: 745 }
    const WIDE = { w: 1200, h: 200, x: 1080, y: 110 }
    /** 文字だけを違えた図の組。1 回のパックで描くため、すべて単位 4 の本文の図として draw/ の下に置く。 */
    const PAIRS = [
      ['dot', '中黒', 'データ・コード', 'データ コード', undefined],
      ['bar', '長音符', 'データ・コード', 'データ・コド', undefined],
      ['tall-dot', '縦長の図の下端の中黒', 'デ・タ', 'デ タ', TALL],
      ['tall-bar', '縦長の図の下端の長音符', 'コード', 'コド', TALL],
      ['wide-dot', '横長の図の右端の中黒', 'デ・タ', 'デ タ', WIDE],
      ['wide-bar', '横長の図の右端の長音符', 'コード', 'コド', WIDE],
      ['tall-edge', '縦長', '端A', '端B', TALL],
      ['wide-edge', '横長', '端A', '端B', WIDE],
    ] as const
    let ws: Workspace
    beforeAll(() => {
      ws = makeWorkspace()
      const lines: string[] = []
      for (const [key, , textA, textB, box] of PAIRS) {
        ws.write(`public/figures/materials/eng/draw/${key}-a.svg`, svgWithText(textA, box))
        ws.write(`public/figures/materials/eng/draw/${key}-b.svg`, svgWithText(textB, box))
        lines.push(`![${key}-a](/figures/materials/eng/draw/${key}-a.svg)`, `![${key}-b](/figures/materials/eng/draw/${key}-b.svg)`)
      }
      ws.write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED.map((m) => (m.topic_id === 4 ? { ...m, detail: `${m.detail}\n${lines.join('\n')}` } : m)) })
      const r = build(ws)
      expect(r.status, r.stdout + r.stderr).toBe(0)
    }, BUILD_HOOK_TIMEOUT)
    const png = (key: string, side: 'a' | 'b') => ws.bytes(`${PACK}/figures/draw/${key}-${side}.png`)

    for (const [key, label] of PAIRS.slice(0, 6)) {
      /** @covers REQ-306#symbols-drawn */
      it(`図の文字の${label}だけが違う 2 つの図から描いた PNG は中身が違う`, () => {
        expect(Array.from(png(key, 'b'))).not.toEqual(Array.from(png(key, 'a')))
      })
    }

    for (const [key, label, box] of [['tall-edge', '縦長', TALL], ['wide-edge', '横長', WIDE]] as const) {
      /** @covers REQ-306#tall-and-wide-drawn-whole */
      it(`${label}（${box.w}×${box.h}）の図の PNG は元の図と同じ幅と高さで描かれる`, () => {
        for (const side of ['a', 'b'] as const) {
          expect(isPng(png(key, side))).toBe(true)
          expect(pngSize(png(key, side))).toEqual({ width: box.w, height: box.h })
        }
      })

      /** @covers REQ-306#tall-and-wide-drawn-whole */
      it(`${label}の図の端に置いた文字だけが違えば、PNG の中身も違う（端まで切らずに描く）`, () => {
        expect(Array.from(png(key, 'b'))).not.toEqual(Array.from(png(key, 'a')))
      })
    }
  })

  /** @covers REQ-306#same-on-ci */
  it('PATH から macOS の道具（qlmanage・sips）を外しても、図を元の寸法の PNG に描いてパックの中から指す', () => {
    const ws = makeWorkspace()
    const r = build(ws, {}, withoutMacTools(ws))
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.json.files.figures.slice().sort()).toEqual(['figures/5-1.png', 'figures/9-1.png', 'figures/sub/2-1.png'])
    for (const f of ['figures/5-1.png', 'figures/sub/2-1.png', 'figures/9-1.png']) expect(isPng(ws.bytes(`${PACK}/${f}`)), f).toBe(true)
    expect(pngSize(ws.bytes(`${PACK}/figures/5-1.png`))).toEqual({ width: 240, height: 60 })
    expect(pngSize(ws.bytes(`${PACK}/figures/9-1.png`))).toEqual({ width: 2, height: 2 })
    for (const f of ws.files(PACK).filter((f) => f.startsWith('units/'))) {
      for (const ref of imageRefs(ws.read(`${PACK}/${f}`))) expect(ws.exists(resolveIn(ws.abs(`${PACK}/${f}`), ref)), ref).toBe(true)
    }
  })

  /** @covers REQ-305#latest-generation-per-unit */
  it('配る本文は単位ごとに後の世代の教材を選び、後の世代に無い単位は前の世代の物を出す', () => {
    const ws = makeWorkspace()
    ws.write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED.filter((m) => m.topic_id !== 4) })
    const r = build(ws)
    expect(r.status, r.stdout).toBe(0)
    const text = (id: number) => ws.files(PACK).filter((f) => f.startsWith('units/')).map((f) => ws.read(`${PACK}/${f}`)).find((md) => md.includes(UNITS.find((u) => u.topic_id === id)!.term))
    expect(text(4)).toContain(EDITED.find((m) => m.topic_id === 4)!.explanation)
    expect(text(5)).toContain(DELIVERED.find((m) => m.topic_id === 5)!.explanation)
    expect(text(5)).not.toContain(EDITED.find((m) => m.topic_id === 5)!.explanation)
  })

  /** @covers REQ-307#answer-not-in-pack */
  it('正解だけが違う 2 つの学びから作ったパックは、ファイルの中身がすべて同じ', () => {
    const a = makeWorkspace()
    const b = makeWorkspace()
    const rotate: Record<string, string> = { ア: 'イ', イ: 'ウ', ウ: 'エ', エ: 'ア' }
    writeQuestions(b, QUESTION_BUNDLES.flat().map((q) => ({ ...q, answer: rotate[q.answer] })))
    writeQuestions(a, QUESTION_BUNDLES.flat())
    expect(build(a).status).toBe(0)
    expect(build(b).status).toBe(0)
    expect(b.files(PACK)).toEqual(a.files(PACK))
    for (const f of a.files(PACK)) expect(Array.from(b.bytes(`${PACK}/${f}`)), f).toEqual(Array.from(a.bytes(`${PACK}/${f}`)))
  })

  /** @covers REQ-309#earlier-cycles-untouched */
  it('より小さい番号の周の写しと結果があってもパックを作り、それらを書き換えない', () => {
    const ws = makeWorkspace()
    ws.write(snapshotFile(5), { ...SNAPSHOT_8, cycle: 5 })
    ws.write(resultFile(5), { cycle: 5, rate: 0.25, avg_understood: 1.5 })
    const before = ws.snapshotTree('data/eng/eval')
    const r = build(ws)
    expect(r.status).toBe(0)
    const after = ws.snapshotTree('data/eng/eval')
    for (const [f, body] of Object.entries(before)) expect(after[f], f).toBe(body)
  })

  /** @covers REQ-309#unreadable-earlier-result-not-read */
  it('差を取る前の周の結果が読めなくてもパックを作り、その結果を書き換えない', () => {
    const ws = makeWorkspace()
    ws.write(resultFile(5), '{ "cycle": 5, ')
    const r = build(ws)
    expect(r.status, r.stdout).toBe(0)
    expect(ws.read(resultFile(5))).toBe('{ "cycle": 5, ')
  })

  describe('登録簿に無い学びか、ロードマップを持たない学び（REQ-318）', () => {
    /** @covers REQ-318#exam-learning-build */
    it('資格型の学びは、ロードマップ型と同じファイルを置いても INVALID_INPUT で断る', () => {
      const ws = makeWorkspace()
      for (const f of [ROADMAP_FILE, DELIVERED_FILE, EXPLAIN_FILE]) ws.write(f.replace('data/eng/', 'data/ip/'), ws.read(f))
      ws.write('data/ip/roadmap_questions/bundle_01.json', ws.read(`${QUESTIONS_DIR}/bundle_01.json`))
      const before = untouched(ws, 'packs/ip')
      const r = build(ws, { data: 'data/ip', out: 'packs/ip' })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(ws.snapshotTree(before.out)).toEqual(before.tree)
      expect(ws.exists(snapshotFile(8, 'ip'))).toBe(false)
    })

    /** @covers REQ-318#unregistered-build */
    it('登録簿に無い学びは INVALID_INPUT で断り、何も残さない', () => {
      const ws = makeWorkspace()
      for (const f of [ROADMAP_FILE, DELIVERED_FILE]) ws.write(f.replace('data/eng/', 'data/zzz/'), ws.read(f))
      const r = build(ws, { data: 'data/zzz', out: 'packs/zzz' })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(ws.exists('packs/zzz')).toBe(false)
      expect(ws.exists(snapshotFile(8, 'zzz'))).toBe(false)
    })

    /** @covers REQ-318#roadmap-file-missing-build */
    it('ロードマップ型でもロードマップのファイルが無ければ INVALID_INPUT で断り、何も残さない', () => {
      const ws = makeWorkspace()
      ws.remove(ROADMAP_FILE)
      expectRefused(build(ws), ws, 'INVALID_INPUT', untouched(ws))
    })

    /** @covers REQ-318#not-roadmap-before-out-inside */
    it('資格型の学びで出力先が学びの置き場の中でも INVALID_INPUT で断り、出力先を作らない', () => {
      const ws = makeWorkspace()
      const r = build(ws, { data: 'data/ip', cycle: 1, out: 'data/ip/pack_c1' })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(ws.exists('data/ip/pack_c1')).toBe(false)
      expect(ws.exists(snapshotFile(1, 'ip'))).toBe(false)
    })
  })

  describe('パックの出力先（REQ-331）', () => {
    /** @covers REQ-331#inside-own-learning */
    it('出力先がその学びの置き場の中なら INVALID_INPUT で止め、パックも写しも作らない', () => {
      const ws = makeWorkspace()
      const r = build(ws, { out: 'data/eng/pack_c8' })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(ws.exists('data/eng/pack_c8')).toBe(false)
      expect(ws.exists(snapshotFile(8))).toBe(false)
    })

    for (const out of ['data/itc/pack', 'data/zzz/pack']) {
    /** @covers REQ-331#inside-other-learning */
    it(`出力先が別の学び（または学びでない data の下）の ${out} なら INVALID_INPUT で止める`, () => {
      const ws = makeWorkspace()
      const r = build(ws, { out })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(ws.exists(out)).toBe(false)
      expect(ws.exists(snapshotFile(8))).toBe(false)
    })
    }

    for (const [label, outOf] of [
      ['.. を含む相対パス', (_ws: Workspace) => 'packs/../data/eng/pack_c8'],
      ['絶対パス', (ws: Workspace) => ws.abs('data/eng/pack_c8')],
    ] as const) {
    /** @covers REQ-331#inside-by-other-spelling */
    it(`出力先を ${label} で学びの置き場の中に向けても INVALID_INPUT で止める`, () => {
      const ws = makeWorkspace()
      const r = build(ws, { out: outOf(ws) })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(ws.exists('data/eng/pack_c8')).toBe(false)
      expect(ws.exists(snapshotFile(8))).toBe(false)
    })
    }

    /** @covers REQ-331#out-not-empty */
    it('出力先に既に中身があれば CONFLICT で止め、中身を変えず写しも作らない', () => {
      const ws = makeWorkspace()
      ws.write(`${PACK}/memo.txt`, '作り手のメモ')
      expectRefused(build(ws), ws, 'CONFLICT', { out: PACK, tree: { 'memo.txt': '作り手のメモ' } })
    })

    /** @covers REQ-331#existing-empty-dir-accepted */
    it('出力先が空のディレクトリならパックを作る', () => {
      const ws = makeWorkspace()
      ws.write(`${PACK}/x`, '')
      ws.remove(`${PACK}/x`)
      const r = build(ws)
      expect(r.status).toBe(0)
      expect(ws.exists(`${PACK}/roadmap.md`)).toBe(true)
    })

    /** @covers REQ-331#inside-before-not-empty */
    it('出力先が学びの置き場の中で中身もあるときは INVALID_INPUT（中身のある出力先より先）', () => {
      const ws = makeWorkspace()
      const before = ws.snapshotTree('data/eng')
      const r = build(ws, { out: 'data/eng' })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INVALID_INPUT')
      expect(ws.snapshotTree('data/eng')).toEqual(before)
    })

    /** @covers REQ-331#not-empty-before-cycle-exists */
    it('出力先に中身があり、その周の写しもあるときは CONFLICT で止め、どちらも書き換えない', () => {
      const ws = makeWorkspace()
      ws.write(`${PACK}/memo.txt`, '作り手のメモ')
      ws.write(snapshotFile(8), SNAPSHOT_8)
      const snap = ws.read(snapshotFile(8))
      const r = build(ws)
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(ws.snapshotTree(PACK)).toEqual({ 'memo.txt': '作り手のメモ' })
      expect(ws.read(snapshotFile(8))).toBe(snap)
    })
  })

  describe('その周の写しか周の結果が既にある（REQ-321）', () => {
    /** @covers REQ-321#snapshot-exists */
    it('その周の写しがあれば CONFLICT で止め、パックを作らず写しを書き換えない', () => {
      const ws = makeWorkspace()
      ws.write(snapshotFile(8), SNAPSHOT_8)
      const snap = ws.read(snapshotFile(8))
      const r = build(ws)
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(ws.exists(PACK)).toBe(false)
      expect(ws.read(snapshotFile(8))).toBe(snap)
    })

    /** @covers REQ-321#result-exists-without-snapshot */
    it('その周の写しは無いが周の結果があれば CONFLICT で止め、写しを作らず結果を書き換えない', () => {
      const ws = makeWorkspace()
      ws.write(resultFile(8), { cycle: 8, rate: 0.5, avg_understood: 2 })
      const result = ws.read(resultFile(8))
      const r = build(ws)
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(ws.exists(PACK)).toBe(false)
      expect(ws.exists(snapshotFile(8))).toBe(false)
      expect(ws.read(resultFile(8))).toBe(result)
    })

    /** @covers REQ-321#unreadable-snapshot-exists */
    it('その周の写しが壊れていて読めなくても、あれば CONFLICT で止め、写しを書き換えない', () => {
      const ws = makeWorkspace()
      ws.write(snapshotFile(8), '{ "cycle": 8, ')
      const r = build(ws)
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(ws.exists(PACK)).toBe(false)
      expect(ws.read(snapshotFile(8))).toBe('{ "cycle": 8, ')
    })

    /** @covers REQ-321#both-exist */
    it('その周の写しも周の結果もあれば CONFLICT で止め、どちらも書き換えない', () => {
      const ws = makeWorkspace()
      ws.write(snapshotFile(8), SNAPSHOT_8)
      ws.write(resultFile(8), { cycle: 8, rate: 0.5, avg_understood: 2 })
      const before = ws.snapshotTree('data/eng/eval')
      const r = build(ws)
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(ws.exists(PACK)).toBe(false)
      expect(ws.snapshotTree('data/eng/eval')).toEqual(before)
    })

    /** @covers REQ-321#cycle-exists-before-questions-missing */
    it('その周の写しがあり今の確認問題も無いときは CONFLICT（確認問題の欠けより先）', () => {
      const ws = makeWorkspace()
      ws.write(snapshotFile(8), SNAPSHOT_8)
      ws.remove(QUESTIONS_DIR)
      const r = build(ws)
      expect(r.status).toBe(1)
      expect(r.code).toBe('CONFLICT')
      expect(ws.exists(PACK)).toBe(false)
    })
  })

  describe('今の確認問題が無いか読めない（REQ-333）', () => {
    /** @covers REQ-333#questions-missing-build */
    it('今の確認問題が無ければ NOT_FOUND で止め、パックも写しも作らない', () => {
      const ws = makeWorkspace()
      ws.remove(QUESTIONS_DIR)
      expectRefused(build(ws), ws, 'NOT_FOUND', untouched(ws))
    })

    const B1 = `${QUESTIONS_DIR}/bundle_01.json`
    const B2 = `${QUESTIONS_DIR}/bundle_02.json`
    for (const [label, file, breakIt] of [
      ['JSON として読めない束', B2, (ws: Workspace) => ws.write(B2, '{ "questions": [')],
      ['選択肢に エ が無い問題', B1, (ws: Workspace) => writeQuestions(ws, [{ ...question('t5-1', 5, 1, 'イ'), choices: { ア: 'a', イ: 'b', ウ: 'c' } }])],
      ['選択肢の外の正解', B1, (ws: Workspace) => writeQuestions(ws, [question('t5-1', 5, 1, 'オ')])],
      ['測る到達基準の無い問題', B1, (ws: Workspace) => writeQuestions(ws, [{ ...question('t5-1', 5, 1, 'イ'), tests_goal: undefined } as unknown as ReturnType<typeof question>])],
      ['単位の ID が文字列の問題', B1, (ws: Workspace) => writeQuestions(ws, [{ ...question('t5-1', 5, 1, 'イ'), topic_id: '5' } as unknown as ReturnType<typeof question>])],
    ] as const) {
    /** @covers REQ-333#questions-unreadable-build */
    it(`今の確認問題に「${label}」があれば INVALID_INPUT で止め、読めないファイルを挙げ、パックも写しも作らない`, () => {
      const ws = makeWorkspace()
      breakIt(ws)
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(toolError(r.json).unreadable).toEqual([file])
    })
    }

    /** @covers REQ-333#unreadable-before-explain-terms-unreadable */
    it('今の確認問題も説明テストの語の一覧も読めないときは、確認問題の束だけを挙げて止める', () => {
      const ws = makeWorkspace()
      ws.write(B2, '{ "questions": [')
      ws.write(EXPLAIN_FILE, '{ "terms": ')
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(toolError(r.json).unreadable).toEqual([B2])
    })
  })

  describe('説明テストの語の一覧が読めない（REQ-335）', () => {
    for (const [label, body] of [
      ['JSON として読めない', '{ "terms": '],
      ['terms が無い', JSON.stringify({ words: ['単位五'] })],
      ['terms が配列でない', JSON.stringify({ terms: '単位五' })],
      ['語が空の項目がある', JSON.stringify({ terms: [{ term: '' }] })],
      ['語の欄の無い項目がある', JSON.stringify({ terms: [{ goal: 1 }] })],
    ] as const) {
      /** @covers REQ-335#explain-terms-unreadable */
      it(`説明テストの語の一覧が「${label}」なら INVALID_INPUT で止め、その一覧を挙げ、パックも写しも作らない`, () => {
        const ws = makeWorkspace()
        ws.write(EXPLAIN_FILE, body)
        const r = build(ws)
        expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
        expect(toolError(r.json).unreadable).toEqual([EXPLAIN_FILE])
      })
    }

    /** @covers REQ-335#unreadable-before-roadmap-row-broken */
    it('語の一覧が読めずロードマップに欠けた行もあるときは、語の一覧だけを挙げて止める', () => {
      const ws = makeWorkspace()
      ws.write(EXPLAIN_FILE, '{ "terms": ')
      ws.write(ROADMAP_FILE, roadmapOf(UNITS.map((u, i) => (i === 1 ? { ...u, term: undefined } as unknown as typeof u : u))))
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(toolError(r.json).unreadable).toEqual([EXPLAIN_FILE])
    })
  })

  describe('配る本文の無い単位がある（REQ-319）', () => {
    /** @covers REQ-319#unit-body-missing */
    it('ロードマップの 1 単位に配る本文が無ければ NOT_FOUND で止め、その単位を挙げ、パックも写しも作らない', () => {
      const ws = makeWorkspace()
      dropBody(ws, 9)
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect(toolError(r.json).units).toEqual([9])
    })

    /** @covers REQ-319#body-in-earlier-generation-ok */
    it('後の世代に無くても前の世代に配る本文がある単位では止めない', () => {
      const ws = makeWorkspace()
      ws.write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED.filter((m) => m.topic_id !== 9) })
      expect(build(ws).status).toBe(0)
    })

    /** @covers REQ-319#delivered-body-absent */
    it('配る本文が 1 つも無ければ NOT_FOUND で止め、パックも写しも作らない', () => {
      const ws = makeWorkspace()
      ws.remove(DELIVERED_FILE)
      ws.remove('data/eng/materials')
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect([...toolError(r.json).units].sort((a: number, b: number) => a - b)).toEqual([2, 4, 5, 9])
    })

    /** @covers REQ-319#body-missing-before-figure-missing */
    it('配る本文の無い単位と画像の無い図が両方あるときは、配る本文の無い単位を挙げて止める', () => {
      const ws = makeWorkspace()
      dropBody(ws, 9)
      ws.remove('public/figures/materials/eng/5-1.svg')
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect(toolError(r.json).units).toEqual([9])
      expect(toolError(r.json).figures).toBeUndefined()
    })
  })

  describe('配る本文が指す図の画像が無い（REQ-320）', () => {
    for (const [unit, src] of [[5, '/figures/materials/eng/5-1.svg'], [2, '/figures/materials/eng/sub/2-1.svg'], [9, '/figures/materials/eng/9-1.png']] as const) {
    /** @covers REQ-320#figure-missing */
    it(`${src} の画像が無ければ NOT_FOUND で止め、単位とその図を挙げ、パックも写しも作らない`, () => {
      const ws = makeWorkspace()
      ws.remove(`public${src}`)
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect(figuresOf(r)).toEqual([{ unit, ref: src }])
    })
    }

    /** @covers REQ-320#figure-missing */
    it('行頭と行末に空白を持つ図の行が指す画像が無くても NOT_FOUND で止め、単位と空白を除いた参照先を挙げる', () => {
      const ws = makeWorkspace()
      ws.write(DELIVERED_FILE, { bundle: 'roadmap', materials: DELIVERED.map((m) => (m.topic_id === 4 ? { ...m, detail: `${m.detail}\n\u3000![足した図](/figures/materials/eng/4-1.svg)\t` } : m)) })
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect(figuresOf(r)).toEqual([{ unit: 4, ref: '/figures/materials/eng/4-1.svg' }])
    })

    /** @covers REQ-320#figure-only-in-other-learning */
    it('同じ名前の画像が別の学びの置き場にしか無ければ NOT_FOUND で止める', () => {
      const ws = makeWorkspace()
      ws.remove('public/figures/materials/eng/5-1.svg')
      ws.write('public/figures/materials/itc/5-1.svg', SVG)
      ws.write('public/figures/5-1.svg', SVG)
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect(figuresOf(r)).toEqual([{ unit: 5, ref: '/figures/materials/eng/5-1.svg' }])
    })

    /** @covers REQ-320#figure-missing-before-name-collision */
    it('画像の無い図と同じ PNG の名前になる図が両方あるときは NOT_FOUND（名前の重なりより先）', () => {
      const ws = makeWorkspace()
      ws.remove('public/figures/materials/eng/9-1.png')
      ws.write('public/figures/materials/eng/5-1.png', PNG)
      addFigureLine(ws, 4, '/figures/materials/eng/5-1.png')
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect(figuresOf(r)).toEqual([{ unit: 9, ref: '/figures/materials/eng/9-1.png' }])
    })
  })

  describe('図の置き場を指すのに図の行の形に合わない行がある（REQ-513）', () => {
    /** 最も後の世代の配る本文で、単位の detail（既定）か explanation の末尾に 1 行を足す。 */
    const addLines = (ws: Workspace, adds: { unit: number; line: string; field?: 'detail' | 'explanation' }[]) => {
      ws.write(DELIVERED_FILE, {
        bundle: 'roadmap',
        materials: DELIVERED.map((m) => {
          const mine = adds.filter((a) => a.unit === m.topic_id)
          const detail = mine.filter((a) => (a.field ?? 'detail') === 'detail').reduce((d, a) => `${d}\n${a.line}`, m.detail)
          const explanation = mine.filter((a) => a.field === 'explanation').reduce((d, a) => `${d}\n${a.line}`, m.explanation)
          return { ...m, explanation, detail }
        }),
      })
    }
    /** ToolError の lines を契約の欄（unit・line）だけにして、並びによらず比べられる形にする。 */
    const linesOf = (r: Run) =>
      ((toolError(r.json)?.lines ?? []) as Json[]).map((x) => ({ unit: x.unit, line: x.line })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const sortLines = (xs: { unit: number; line: string }[]) => [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

    for (const [label, line] of [
      ['段に .. を含む', '![図](/figures/materials/eng/../../zz-9.svg)'],
      ['学びの段が大文字', '![図](/figures/materials/ENG/5-1.svg)'],
      ['学びの段に数字', '![図](/figures/materials/eng2/5-1.svg)'],
      ['学びの段が無い', '![図](/figures/materials/5-1.svg)'],
      ['拡張子が svg・png でない', '![図](/figures/materials/eng/5-1.jpg)'],
      ['拡張子が大文字', '![図](/figures/materials/eng/5-1.SVG)'],
      ['図の説明文が空', '![](/figures/materials/eng/5-1.svg)'],
      ['図の説明文が ]( を含む', '![a](b](/figures/materials/eng/5-1.svg)'],
      ['画像でなくリンクの記法', '[図](/figures/materials/eng/5-1.svg)'],
      ['題を添えた画像', '![図](/figures/materials/eng/5-1.svg "題")'],
      ['行の前に文がある', '図は ![図](/figures/materials/eng/5-1.svg)'],
      ['行の後に文がある', '![図](/figures/materials/eng/5-1.svg)。'],
      ['1 行に画像が 2 つ', '![図](/figures/materials/eng/5-1.svg)![図](/figures/materials/eng/9-1.png)'],
      ['外の URL の中に前置きを含む', '![図](https://example.com/figures/materials/eng/5-1.svg)'],
      ['文の中で前置きに触れる', '図は /figures/materials/eng/5-1.svg にある'],
      ['行の中のコードで前置きに触れる', '`/figures/materials/eng/5-1.svg`'],
      ['行頭に空白を持つ形に合わない行', '  ![図](/figures/materials/eng/../5-1.svg)'],
    ] as const) {
      /** @covers REQ-513#line-malformed */
      it(`配る本文に前置きを含み形に合わない行（${label}）があれば INVALID_INPUT で止め、単位と書かれたままの行を挙げ、パックも写しも作らない`, () => {
        const ws = makeWorkspace()
        addLines(ws, [{ unit: 4, line }])
        const r = build(ws)
        expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
        expect(linesOf(r)).toEqual([{ unit: 4, line }])
      })
    }

    /** @covers REQ-513#line-malformed */
    it('配る本文の説明の行に前置きを含み形に合わない行があっても止め、その単位と行を挙げる', () => {
      const ws = makeWorkspace()
      const line = '図は /figures/materials/eng/5-1.svg を見る'
      addLines(ws, [{ unit: 4, line, field: 'explanation' }])
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(linesOf(r)).toEqual([{ unit: 4, line }])
    })

    /** @covers REQ-513#several-lines-listed */
    it('形に合わない行が複数の単位と 1 つの単位の中に複数あれば、すべての単位と行を挙げる', () => {
      const ws = makeWorkspace()
      const adds = [
        { unit: 4, line: '![図](/figures/materials/ENG/5-1.svg)' },
        { unit: 4, line: '[図](/figures/materials/eng/9-1.png)' },
        { unit: 5, line: '![図](/figures/materials/eng/5-1.jpg)' },
      ]
      addLines(ws, adds)
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(linesOf(r)).toEqual(sortLines(adds))
    })

    for (const [label, line] of [
      ['行頭に全角の空白・行末にタブ', '　![図](/figures/materials/eng/5-1.svg)\t'],
      ['行頭にタブと半角の空白・行末に半角の空白', ' \t![図](/figures/materials/eng/sub/2-1.svg) '],
      ['図の説明文が ( の続かない ] を含む', '![図[1]の説明](/figures/materials/eng/9-1.png)'],
    ] as const) {
      /** @covers REQ-513#well-formed-variants-ok */
      it(`図の行の形に合う行（${label}）は図の行として読み、止めずにパックを作る`, () => {
        const ws = makeWorkspace()
        addLines(ws, [{ unit: 4, line }])
        const r = build(ws)
        expect(r.status, r.stdout + r.stderr).toBe(0)
        expect(toolError(r.json)).toBeUndefined()
      })
    }

    /** @covers REQ-513#only-delivered-body-checked */
    it('形に合わない行が配る本文に選ばれない前の世代の教材にだけあれば、止めずにパックを作る', () => {
      const ws = makeWorkspace()
      ws.write(EDITED_FILE, { bundle: 1, materials: EDITED.map((m) => (m.topic_id === 5 ? { ...m, detail: `${m.detail}\n![図](/figures/materials/ENG/5-1.svg)` } : m)) })
      const r = build(ws)
      expect(r.status, r.stdout + r.stderr).toBe(0)
    })

    /** @covers REQ-513#body-missing-before-line-malformed */
    it('配る本文の無い単位と形に合わない行が両方あれば、配る本文の無い単位を挙げて NOT_FOUND で止める', () => {
      const ws = makeWorkspace()
      addLines(ws, [{ unit: 4, line: '![図](/figures/materials/ENG/5-1.svg)' }])
      dropBody(ws, 9)
      const r = build(ws)
      expectRefused(r, ws, 'NOT_FOUND', untouched(ws))
      expect(toolError(r.json).units).toEqual([9])
      expect(toolError(r.json).lines).toBeUndefined()
    })

    /** @covers REQ-513#line-malformed-before-figure-missing */
    it('形に合わない行と画像の無い図が両方あれば、形に合わない行だけを挙げて INVALID_INPUT で止める', () => {
      const ws = makeWorkspace()
      addLines(ws, [{ unit: 4, line: '![図](/figures/materials/ENG/5-1.svg)' }])
      ws.remove('public/figures/materials/eng/sub/2-1.svg')
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(linesOf(r)).toEqual([{ unit: 4, line: '![図](/figures/materials/ENG/5-1.svg)' }])
      expect(toolError(r.json).figures).toBeUndefined()
    })

    describe('契約の例が指す作り物の置き場から呼ぶ', () => {
      /** 作り物を写して呼ぶ。断ったときは作り物の置き場の写しも出力先も残さない。 */
      const fromFixture = (name: string) => {
        const ws = makeWorkspace()
        const data = `${copyFixture(ws, name)}/data/itc`
        const before = untouched(ws, 'packs/fx')
        const r = build(ws, { data, cycle: 1, out: 'packs/fx' })
        expect(r.status, r.stdout + r.stderr).toBe(1)
        expect(ws.snapshotTree(before.out)).toEqual(before.tree)
        expect(ws.exists(`${data}/eval/pack_cycle_1.json`)).toBe(false)
        return r
      }

      /** @covers REQ-513#several-lines-listed */
      it('figure-line-malformed: 単位 12 と 16 の形に合わない行を挙げて INVALID_INPUT で止める', () => {
        const r = fromFixture('figure-line-malformed')
        expect(r.code).toBe('INVALID_INPUT')
        expect(linesOf(r)).toEqual(sortLines([
          { unit: 12, line: '![図](/figures/materials/itc/../../zz-9.svg)' },
          { unit: 16, line: '![図](/figures/materials/ITC/16-1.svg)' },
        ]))
      })

      /** @covers REQ-513#body-missing-before-line-malformed */
      it('body-missing-and-figure-line-malformed: 配る本文の無い単位 12 を挙げて NOT_FOUND で止める', () => {
        const r = fromFixture('body-missing-and-figure-line-malformed')
        expect(r.code).toBe('NOT_FOUND')
        expect(toolError(r.json).units).toEqual([12])
        expect(toolError(r.json).lines).toBeUndefined()
      })

      /** @covers REQ-513#line-malformed-before-figure-missing */
      it('figure-line-malformed-and-figure-missing: 単位 16 の形に合わない行だけを挙げて INVALID_INPUT で止める', () => {
        const r = fromFixture('figure-line-malformed-and-figure-missing')
        expect(r.code).toBe('INVALID_INPUT')
        expect(linesOf(r)).toEqual([{ unit: 16, line: '![図](/figures/materials/ITC/16-1.svg)' }])
        expect(toolError(r.json).figures).toBeUndefined()
      })
    })
  })

  describe('同じ PNG の名前になる図が 2 つ以上ある（REQ-337）', () => {
    for (const [label, existing, other, otherFile] of [
      ['直下', '/figures/materials/eng/5-1.svg', '/figures/materials/eng/5-1.png', 'public/figures/materials/eng/5-1.png'],
      ['サブパス', '/figures/materials/eng/sub/2-1.svg', '/figures/materials/eng/sub/2-1.png', 'public/figures/materials/eng/sub/2-1.png'],
    ] as const) {
      /** @covers REQ-337#extension-only-differs */
      it(`${label}で拡張子だけが違う図を別の単位が指せば INVALID_INPUT で止め、両方の単位と図を挙げ、どの画像も上書きしない`, () => {
        const ws = makeWorkspace()
        ws.write(otherFile, PNG)
        addFigureLine(ws, 4, other)
        const images = ws.snapshotTree('public')
        const r = build(ws)
        expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
        const owner = existing.includes('sub/') ? 2 : 5
        expect(figuresOf(r)).toEqual([{ unit: 4, ref: other }, { unit: owner, ref: existing }].sort((a, b) => `${a.unit}${a.ref}`.localeCompare(`${b.unit}${b.ref}`)))
        expect(ws.snapshotTree('public')).toEqual(images)
      })
    }

    for (const [label, ref, file] of [
      ['同じ図を 2 つの単位が指す', '/figures/materials/eng/5-1.svg', undefined],
      ['拡張子が同じでもサブパスが違う', '/figures/materials/eng/sub/5-1.png', 'public/figures/materials/eng/sub/5-1.png'],
    ] as const) {
      /** @covers REQ-337#not-a-collision */
      it(`${label}ときは名前の重なりとせずパックを作る`, () => {
        const ws = makeWorkspace()
        if (file) ws.write(file, PNG)
        addFigureLine(ws, 4, ref)
        const r = build(ws)
        expect(r.status, r.stdout).toBe(0)
      })
    }

    /** @covers REQ-337#collision-before-not-drawable */
    it('名前の重なる図と PNG に描けない図が両方あるときは INVALID_INPUT（描けないより先）', () => {
      const ws = makeWorkspace()
      ws.write('public/figures/materials/eng/5-1.png', PNG)
      addFigureLine(ws, 4, '/figures/materials/eng/5-1.png')
      ws.write('public/figures/materials/eng/sub/2-1.svg', 'これは図ではない')
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(figuresOf(r).map((f) => f.unit).sort()).toEqual([4, 5])
    })
  })

  describe('配る本文の図を PNG に描けない（REQ-336）', () => {
    for (const [label, body] of [
      ['図でない文', 'これは図ではない'],
      ['空のファイル', ''],
    ] as const) {
      /** @covers REQ-336#not-drawable */
      it(`図が「${label}」で PNG に描けなければ INTERNAL で止め、単位と図を挙げ、パックも写しも残さない`, () => {
        const ws = makeWorkspace()
        ws.write('public/figures/materials/eng/sub/2-1.svg', body)
        const r = build(ws)
        expectRefused(r, ws, 'INTERNAL', untouched(ws))
        expect(figuresOf(r)).toEqual([{ unit: 2, ref: '/figures/materials/eng/sub/2-1.svg' }])
      })
    }

    /** @covers REQ-336#created-dirs-removed */
    it('描けずに止めたときは、コマンドが作った出力先とその親のディレクトリも残さない', () => {
      const ws = makeWorkspace()
      ws.write('public/figures/materials/eng/sub/2-1.svg', 'これは図ではない')
      const r = build(ws, { out: 'made/by/cmd/c8' })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INTERNAL')
      expect(ws.exists('made')).toBe(false)
      expect(ws.exists(snapshotFile(8))).toBe(false)
    })

    /** @covers REQ-336#existing-parent-kept */
    it('描けずに止めても、前からあった出力先の親のディレクトリと中身は残す', () => {
      const ws = makeWorkspace()
      ws.write('packs/memo.txt', '作り手のメモ')
      ws.write('public/figures/materials/eng/sub/2-1.svg', 'これは図ではない')
      const r = build(ws, { out: 'packs/c8' })
      expect(r.status).toBe(1)
      expect(r.code).toBe('INTERNAL')
      expect(ws.snapshotTree('packs')).toEqual({ 'memo.txt': '作り手のメモ' })
    })
  })

  describe('ロードマップの行が欠けているか型が違う（REQ-338）', () => {
    /** 2 番目（index 1）の行だけを書き換えたロードマップを置いて作る。 */
    const withRow = (row: (u: Json) => Json) => {
      const ws = makeWorkspace()
      ws.write(ROADMAP_FILE, roadmapOf(UNITS.map((u, i) => (i === 1 ? row({ ...u }) : u))))
      return { ws, r: build(ws) }
    }
    const rowsOf = (r: Run) => ((toolError(r.json)?.roadmapRows ?? []) as Json[]).map((x) => ({ index: x.index, fields: [...x.fields].sort() })).sort((a, b) => a.index - b.index)

    for (const field of ['order', 'topic_id', 'term', 'field', 'middle', 'summary']) {
      /** @covers REQ-338#required-field-missing */
      it(`ロードマップの行に欠けてはならない欄 ${field} が無ければ、その行と欄を挙げて INVALID_INPUT で止める`, () => {
        const { ws, r } = withRow((u) => ({ ...u, [field]: undefined }))
        expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
        expect(rowsOf(r)).toEqual([{ index: 1, fields: [field] }])
      })
    }

    for (const [field, value] of [['order', '2'], ['topic_id', '2'], ['term', 2], ['field', null], ['middle', ['単元一']], ['summary', 5]] as const) {
      /** @covers REQ-338#wrong-type */
      it(`ロードマップの行の欄 ${field} の型が違えば（${JSON.stringify(value)}）、その行と欄を挙げて止める`, () => {
        const { ws, r } = withRow((u) => ({ ...u, [field]: value }))
        expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
        expect(rowsOf(r)).toEqual([{ index: 1, fields: [field] }])
      })
    }

    /** @covers REQ-338#several-rows-listed */
    it('欠けた行が複数あれば、すべての行と欄を挙げる', () => {
      const ws = makeWorkspace()
      ws.write(ROADMAP_FILE, roadmapOf(UNITS.map((u, i) => (i === 0 ? { ...u, term: undefined, middle: 3 } : i === 3 ? { ...u, topic_id: undefined } : u) as typeof u)))
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(rowsOf(r)).toEqual([{ index: 0, fields: ['middle', 'term'] }, { index: 3, fields: ['topic_id'] }])
    })

    for (const field of ['day', 'round', 'chapter']) {
      /** @covers REQ-338#optional-field-missing-ok */
      it(`契約が任意とする欄 ${field} が無い行では止めずにパックを作る`, () => {
        const { r } = withRow((u) => ({ ...u, [field]: undefined }))
        expect(r.status, r.stdout).toBe(0)
      })
    }

    /** @covers REQ-338#row-broken-before-body-missing */
    it('ロードマップに欠けた行があり配る本文の無い単位もあるときは INVALID_INPUT（配る本文の欠けより先）', () => {
      const ws = makeWorkspace()
      ws.write(ROADMAP_FILE, roadmapOf(UNITS.map((u, i) => (i === 1 ? ({ ...u, term: undefined } as unknown as typeof u) : u))))
      dropBody(ws, 9)
      const r = build(ws)
      expectRefused(r, ws, 'INVALID_INPUT', untouched(ws))
      expect(rowsOf(r)).toEqual([{ index: 1, fields: ['term'] }])
    })
  })

  describe('引数が契約の形の外（REQ-340）', () => {
    /** 断ったうえで、挙げた引数（BR-055 の並び）と、作業場所のファイルが 1 つも変わらないこと。 */
    const expectArgsRefused = (ws: Workspace, before: Record<string, string>, r: Run, names: string[]) => {
      expect(r.status, r.stdout + r.stderr).toBe(1)
      expect(r.code, r.stdout).toBe('INVALID_INPUT')
      expect(toolError(r.json)?.arguments).toEqual(names)
      expect(ws.snapshotTree()).toEqual(before)
    }
    /** request の欄を名前と値の組で渡して呼ぶ。 */
    const refusedArgs = (req: { data?: string; cycle?: number | string; out?: string }, names: string[]) => {
      const ws = makeWorkspace()
      const before = ws.snapshotTree()
      expectArgsRefused(ws, before, build(ws, req), names)
    }
    /** コマンドの引数をそのまま渡して呼ぶ。 */
    const refusedRaw = (args: string[], names: string[]) => {
      const ws = makeWorkspace()
      const before = ws.snapshotTree()
      expectArgsRefused(ws, before, buildRaw(ws, args), names)
    }
    const DATA = ['--data', 'data/eng']
    const CYCLE = ['--cycle', '8']
    const OUT = ['--out', 'packs/c8']

    for (const cycle of [0, -1, '1.5', 'abc', '+8']) {
      /** @covers REQ-340#build-bad-cycle */
      it(`周の番号が 1 以上の 10 進の整数でない（${JSON.stringify(cycle)}）ならパックを作る入口は断り、cycle を挙げ、何も書かない`, () => {
        refusedArgs({ cycle }, ['cycle'])
      })
    }

    /** @covers REQ-340#build-empty-out */
    it('出力先が空ならパックを作る入口は断り、out を挙げ、何も書かない', () => {
      refusedArgs({ out: '' }, ['out'])
    })

    for (const data of ['eng', 'data/Eng', 'data/eng/', '../data/eng', 'data/eng2']) {
      /** @covers REQ-340#build-bad-data */
      it(`学びが学びの置き場の形でない（${data}）ならパックを作る入口は断り、data を挙げ、何も書かない`, () => {
        refusedArgs({ data }, ['data'])
      })
    }

    for (const [label, args, names] of [
      ['data を付けない', [...CYCLE, ...OUT], ['data']],
      ['cycle を付けない', [...DATA, ...OUT], ['cycle']],
      ['out を付けない', [...DATA, ...CYCLE], ['out']],
      ['引数を 1 つも付けない', [], ['data', 'cycle', 'out']],
      ['out が名前だけで値が無い（最後の語）', [...DATA, ...CYCLE, '--out'], ['out']],
      ['cycle が名前だけで値が無い（すぐ後が -- で始まる語）', [...DATA, '--cycle', ...OUT], ['cycle']],
      ['out を前の部分だけの名前 o でしか渡さない', [...DATA, ...CYCLE, '--o', '../learner_packs/eng_c8'], ['out', 'o']],
      ['data を前の部分だけの名前 dat でしか渡さない', ['--dat', 'data/eng', ...CYCLE, ...OUT], ['data', 'dat']],
      ['cycle を前の部分だけの名前 cyc でしか =付きで渡さない', [...DATA, '--cyc=8', ...OUT], ['cycle', 'cyc']],
    ] as const) {
      /** @covers REQ-340#build-missing-argument */
      it(`パックを作る入口で引数が無い（${label}）なら断り、その欄を挙げ、何も書かない`, () => {
        refusedRaw([...args], [...names])
      })
    }

    for (const [label, args, names] of [
      ['周の番号を 2 回（前が形の外、後ろが形の内）', [...DATA, '--cycle', '0', '--cycle', '8', ...OUT], ['cycle']],
      ['出力先を 2 回（どちらも形の内）', [...DATA, ...CYCLE, '--out', 'packs/a', '--out', 'packs/b'], ['out']],
      ['学びを同じ値で 2 回', [...DATA, ...DATA, ...CYCLE, ...OUT], ['data']],
      ['出力先を = 付きと無しで 2 回', [...DATA, ...CYCLE, '--out=packs/a', ...OUT], ['out']],
    ] as const) {
      /** @covers REQ-340#build-duplicated-argument */
      it(`パックを作る入口に同じ名前の引数を 2 回渡す（${label}）と断り、その名前を 1 回挙げ、何も書かない`, () => {
        refusedRaw([...args], [...names])
      })
    }

    /** @covers REQ-340#build-all-bad-arguments-listed */
    it('形の外の引数が複数あれば、cycle・out を request の順に 1 回ずつ挙げる', () => {
      refusedArgs({ cycle: 0, out: '' }, ['cycle', 'out'])
    })

    /** @covers REQ-340#build-all-bad-arguments-listed */
    it('コマンドの並びによらず、request の欄を request の順に、続けて契約に無い名前と語を現れた順に挙げる', () => {
      refusedRaw(['--zz', '1', '--out', '', 'stray', '--cycle', '0', '--cycle', '1', '--aa', '2', ...DATA], ['cycle', 'out', 'zz', 'stray', 'aa'])
    })

    /** @covers REQ-340#bad-args-before-not-roadmap-build */
    it('資格型の学びで周の番号も形の外なら、引数の誤りとして cycle を挙げる', () => {
      refusedArgs({ data: 'data/ip', cycle: 0, out: 'packs/ip' }, ['cycle'])
    })

    for (const [extra, names] of [
      [['--unit', '01'], ['unit']],
      [['--unit=01'], ['unit']],
      [['--dat', 'data/eng'], ['dat']],
      [['--cyc', '8'], ['cyc']],
      [['--o', 'packs/other'], ['o']],
      [['stray'], ['stray']],
      [['-x'], ['-x']],
      [['--unit', '01', 'stray', '--o', 'packs/other'], ['unit', 'stray', 'o']],
    ] as const) {
      /** @covers REQ-340#build-extra-argument */
      it(`契約の引数がそろったうえで契約に無い引数（${extra.join(' ')}）があれば、パックを作る入口は断り、${names.join('・')} を挙げ、何も書かない`, () => {
        const ws = makeWorkspace()
        const before = ws.snapshotTree()
        expectArgsRefused(ws, before, build(ws, {}, {}, [...extra]), [...names])
      })
    }

    for (const args of [['--out', '-x'], ['--out=-x']]) {
      /** @covers REQ-340#hyphen-value-in-shape */
      it(`- で始まる値（${args.join(' ')}）は出力先の値として読み、断らずに -x にパックを作る`, () => {
        const ws = makeWorkspace()
        const r = buildRaw(ws, [...DATA, ...CYCLE, ...args])
        expect(r.status, r.stdout + r.stderr).toBe(0)
        expect(ws.exists('-x/roadmap.md')).toBe(true)
        expect(ws.exists(snapshotFile(8))).toBe(true)
      })
    }
  })
})
