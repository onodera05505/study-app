import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  GLOSSARY_LINES, OTHER_UNIT, REWRITTEN, UNIT,
  body, build, cleanWorkspaces, countOf, hasNumberToken, headOf, imagesOf, insertedCaption, isInside, isPng,
  learningOrder, lineCaption, lineSub, makeWorkspace, planFile, questionExplanations, questionStems, questionsOfUnit, resolveIn, sectionsOf,
  setupPrevious, setupRewritten, starsOf, withParentDirs, withoutImageTargets, buildRaw,
  figureFile, figureRef, plainExplanation, setEntry, specFigure, svgWith, writeSpec,
  type Json, type Run, type TopicFixture, type Unit, type Ws,
} from './UC-028_fixture'

/** UC-028 単元の読み物を作る入口（buildUnitReading）が作る物の境界。
 *  観測するのは、標準出力の JSON と終了コード、出力先の reading.md と figures の下の PNG だけ。
 *  作り物は 2 つ: 単元の全論点を書き直した世代から選ぶ単元と、全論点を前の世代から選ぶ単元（UC-028_fixture.ts）。 */

/** 1 回作るのに図を描くブラウザの起動を含む。 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const OUT = 'readings/ip_21'
const READING = `${OUT}/reading.md`
const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o?.[k]]))

afterAll(() => cleanWorkspaces())

/** 作った読み物の、論点の区切りを引く。区切りが見つからなければ落とす。 */
function sectionOf(md: string, unit: Unit, t: TopicFixture) {
  const s = sectionsOf(md, unit).get(t.id)
  expect(s, `論点「${t.term}」の見出しが読み物に無い`).toBeDefined()
  return s!
}

/** 読み物の構造（REQ-494）を、作り物の単元の構成から確かめる。 */
function expectStructure(md: string, unit: Unit) {
  const groups = unit.plan.groups as Json[]
  const lines = md.split('\n')
  const headingLines = (s: string) => lines.map((l, i) => [l, i] as const).filter(([l]) => /^\s*#/.test(l) && l.includes(s)).map(([, i]) => i)
  let lastGroup = -1
  const groupStarts: number[] = []
  for (const g of groups) {
    const at = headingLines(g.name)
    expect(at, `まとまり「${g.name}」の見出しが 1 回でない`).toHaveLength(1)
    expect(at[0], `まとまり「${g.name}」が単元の構成の順にない`).toBeGreaterThan(lastGroup)
    expect(countOf(md, g.description), `まとまり「${g.name}」の説明が 1 回でない`).toBe(1)
    lastGroup = at[0]
    groupStarts.push(at[0])
  }
  const sections = sectionsOf(md, unit)
  let lastTopic = -1
  groups.forEach((g, gi) => {
    for (const id of g.topics as number[]) {
      const t = unit.byId(id)
      const s = sections.get(id)
      expect(s, `論点「${t.term}」の見出しが読み物に無い`).toBeDefined()
      const line = md.slice(0, s!.start).split('\n').length - 1
      expect(line, `論点「${t.term}」が学ぶ順にない`).toBeGreaterThan(lastTopic)
      expect(line, `論点「${t.term}」がまとまりの見出しの前にある`).toBeGreaterThan(groupStarts[gi])
      if (gi + 1 < groupStarts.length) expect(line, `論点「${t.term}」が次のまとまりの見出しの後にある`).toBeLessThan(groupStarts[gi + 1])
      lastTopic = line
    }
  })
}

describe('UC-028 単元の読み物を作る: 単元の全論点を書き直した世代から選ぶ（buildUnitReading）', () => {
  let ws: Ws
  let unit: ReturnType<typeof setupRewritten>
  let r: Run
  let md = ''
  beforeAll(() => {
    ws = makeWorkspace('unit-ok')
    unit = setupRewritten(ws)
    r = build(ws, { out: OUT })
    md = ws.exists(READING) ? ws.read(READING) : ''
  })
  const ok = () => expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  const T = (i: number) => unit.at(i)

  /** @covers REQ-494#notice-and-overview-at-top */
  it('冒頭（最初のまとまりの見出しより前）に、※ と図に触れる読み方の注意と単元の全体像を置き、全体像は読み物に 1 回だけ出る', () => {
    ok()
    const firstGroup = (unit.plan.groups as Json[])[0].name as string
    const lines = md.split('\n')
    const firstLine = lines.findIndex((l) => /^\s*#/.test(l) && l.includes(firstGroup))
    expect(firstLine, '最初のまとまりの見出しが無い').toBeGreaterThan(0)
    const top = lines.slice(0, firstLine).join('\n')
    expect(top).toContain(unit.plan.overview)
    expect(top).toContain('※')
    expect(top).toContain('図')
    expect(countOf(md, unit.plan.overview)).toBe(1)
  })

  /** @covers REQ-494#groups-once-in-plan-order */
  it('まとまりごとに名前の見出しと説明を 1 回だけ単元の構成の順に置き、その下にそのまとまりの論点を学ぶ順に置く', () => {
    ok()
    expectStructure(md, unit)
  })

  /** @covers REQ-494#items-numbered-from-one */
  it('論点の見出しに、単元の中で 1 から続く項目の番号を学ぶ順に振る', () => {
    ok()
    const sections = sectionsOf(md, unit)
    unit.order.forEach((id, i) => {
      const s = sections.get(id)!
      expect(hasNumberToken(s.headLine.replace(unit.byId(id).term, ''), i + 1), `${s.headLine} に項目の番号 ${i + 1} が無い`).toBe(true)
    })
    expect((r.json.items as Json[]).map((x) => x.no)).toEqual(unit.order.map((_, i) => i + 1))
  })

  /** @covers REQ-495#term-once-at-head */
  it('各論点の頭に論点の一覧の名前を 1 回だけ置く', () => {
    ok()
    for (const t of unit.topics) expect(countOf(headOf(sectionOf(md, unit, t).text, t), t.term), t.term).toBe(1)
  })

  /** @covers REQ-495#names-as-is */
  it('末尾に括弧書きを持つ論点の名前は、論点の頭でも前提の論点として挙げるときも括弧書きを落とさずそのまま置く', () => {
    ok()
    const C = T(2)
    expect(sectionOf(md, unit, C).headLine).toContain(C.term)
    for (const t of [T(3), T(4)]) expect(headOf(sectionOf(md, unit, t).text, t), t.term).toContain(C.term)
  })

  const tierCases: [string, number][] = [['出題頻度 0', 1], ['出題頻度 1', 2], ['出題頻度 2', 3], ['出題頻度 3', 0], ['出題頻度 3 を超える', 4]]
  /** 論点の頭の出題回数の印と出題頻度を確かめる。 */
  function expectTier(index: number) {
    ok()
    const t = T(index)
    const head = headOf(sectionOf(md, unit, t).text, t)
    expect(countOf(head, '★'), `${t.term}（出題頻度 ${t.count}）の印`).toBe(starsOf(t.count))
    if (t.count > 0) expect(hasNumberToken(head.replace(t.term, ''), t.count), `${t.term} の頭に出題頻度 ${t.count} が無い`).toBe(true)
  }
  /** @covers REQ-495#frequency-zero-no-mark */
  it(`${tierCases[0][0]} の論点の頭には出題回数の印を置かない`, () => expectTier(tierCases[0][1]))
  /** @covers REQ-495#frequency-one */
  it(`${tierCases[1][0]} の論点の頭に、出題頻度と最も低い段の印（★）を置く`, () => expectTier(tierCases[1][1]))
  /** @covers REQ-495#frequency-two */
  it(`${tierCases[2][0]} の論点の頭に、出題頻度と中の段の印（★★）を置く`, () => expectTier(tierCases[2][1]))
  for (const [label, index] of tierCases.slice(3)) {
    /** @covers REQ-495#frequency-three-or-more */
    it(`${label} の論点の頭に、出題頻度と最も高い段の印（★★★）を置く`, () => expectTier(index))
  }

  /** @covers REQ-495#prerequisites-in-plan-order */
  it('前提を持つ論点の頭に、前提の論点の名前を単元の構成に書かれた順に置く（学ぶ順と逆に書いた前提でも書かれた順）', () => {
    ok()
    const D = T(3)
    const head = headOf(sectionOf(md, unit, D).text, D)
    const [first, second] = (unit.plan.prerequisites[String(D.id)] as number[]).map((id) => unit.byId(id).term)
    expect(head.indexOf(first), first).toBeGreaterThan(head.indexOf(D.term))
    expect(head.indexOf(second), second).toBeGreaterThan(head.indexOf(first))
    const E = T(4)
    expect(headOf(sectionOf(md, unit, E).text, E)).toContain(unit.byId(unit.plan.prerequisites[String(E.id)][0]).term)
  })

  /** @covers REQ-495#no-prerequisites */
  it('前提を持たない論点の頭には、ほかの論点の名前を置かない', () => {
    ok()
    for (const t of [T(0), T(1), T(2)]) {
      const head = headOf(sectionOf(md, unit, t).text, t)
      for (const o of unit.topics.filter((o) => o !== t && !o.term.includes(t.term))) expect(head, `${t.term} の頭に ${o.term}`).not.toContain(o.term)
    }
  })

  /** @covers REQ-496#explanation-then-detail-full */
  it('各論点の本文に、配る本文の説明と詳しい解説の段を全部、説明・詳しい解説の順に置く', () => {
    ok()
    for (const t of unit.topics) {
      const s = sectionOf(md, unit, t).text
      const parts = [body.expl1(t), body.expl2(t), body.headA(t).replace(/^#+\s*/, ''), body.detA1(t), body.detA2(t), body.headB(t).replace(/^#+\s*/, ''), body.detB(t)]
      let last = -1
      for (const p of parts) {
        const at = s.indexOf(p)
        expect(at, `${t.term}: 「${p}」が無いか順が違う`).toBeGreaterThan(last)
        last = at
      }
    }
  })

  /** @covers REQ-496#selected-generation-body */
  it('配る本文は投入が選ぶ書き直した世代の物で、前の世代の同じ論点の本文は出ない', () => {
    ok()
    expect(md).not.toContain(unit.decoy)
    for (const t of unit.topics) expect(sectionOf(md, unit, t).text).toContain(body.expl1(t))
  })

  /** 読み物の中の、その参照先の画像の位置。 */
  const imageAt = (sub: string) => {
    const png = `figures/${sub.replace(/\.(svg|png)$/, '.png')}`
    const hits = imagesOf(md).filter((i) => i.ref.replace(/^\.\//, '') === png)
    expect(hits, `${png} を指す図が 1 つでない`).toHaveLength(1)
    return hits[0].at
  }

  /** @covers REQ-496#insert-after-explanation */
  it('図の行を持たない論点の、差し込み位置が短い説明の図は、説明の後・詳しい解説の最初の見出しの前に置く', () => {
    ok()
    const A = T(0)
    const s = sectionOf(md, unit, A)
    const at = imageAt(`${A.id}-1.svg`)
    expect(at).toBeGreaterThan(md.indexOf(body.expl2(A), s.start))
    expect(at).toBeLessThan(md.indexOf(body.headA(A).replace(/^#+\s*/, ''), s.start))
  })

  /** @covers REQ-496#insert-at-heading-section-end */
  it('図の行を持たない論点の、差し込み位置が見出しの図は、その見出しの節の末尾（節の最後の段の後・次の見出しの前、後に見出しが無ければ論点の区切りの末尾）に置く', () => {
    ok()
    const A = T(0)
    const sa = sectionOf(md, unit, A)
    const atA = imageAt(`${A.id}-2.svg`)
    expect(atA, '後に見出しの無い節の図が、節の段より前にある').toBeGreaterThan(md.indexOf(body.detB(A), sa.start))
    expect(atA).toBeLessThan(sa.end)
    const D = T(3)
    const sd = sectionOf(md, unit, D)
    const atD = imageAt(`${D.id}-1.svg`)
    expect(atD, '後に見出しのある節の図が、節の最後の段より前にある').toBeGreaterThan(md.indexOf(body.detA2(D), sd.start))
    expect(atD).toBeLessThan(md.indexOf(body.headB(D).replace(/^#+\s*/, ''), sd.start))
  })

  /** @covers REQ-496#line-position */
  it('配る本文が図の行を持つ論点では、図をその行の位置（前後の段の間）に置く', () => {
    ok()
    const E = T(4)
    const s = sectionOf(md, unit, E)
    const png = imageAt(lineSub(E, 'png', T(0)))
    expect(png).toBeGreaterThan(md.indexOf(body.expl1(E), s.start))
    expect(png).toBeLessThan(md.indexOf(body.expl2(E), s.start))
    const sub = imageAt(lineSub(E, 'sub', T(0)))
    expect(sub).toBeGreaterThan(md.indexOf(body.detA1(E), s.start))
    expect(sub).toBeLessThan(md.indexOf(body.detA2(E), s.start))
  })

  /** 用語の記法の段を、読み物の中で引く。 */
  const glossaryLine = (key: keyof typeof GLOSSARY_LINES) => {
    const mark = GLOSSARY_LINES[key].slice(0, GLOSSARY_LINES[key].indexOf(':') + 1)
    const line = md.split('\n').find((l) => l.includes(mark))
    expect(line, `「${mark}」の段が読み物に無い`).toBeDefined()
    expect(line).not.toContain('[[')
    expect(line).not.toContain(']]')
    return line!
  }
  /** @covers REQ-497#glossary-term-marked */
  it('用語集にある語は、表示名の直後に押すと説明が出る語の印 ※ を添えて置き、記法の括弧は残さない', () => {
    ok()
    expect(glossaryLine('plain')).toContain('読み物試験語甲※')
  })
  /** @covers REQ-497#paren-dropped */
  it('末尾の括弧書きを落としても他の語と重ならない用語集の語は、括弧書きを落とした表示名に ※ を添える', () => {
    ok()
    const line = glossaryLine('dropParen')
    expect(line).toContain('読み物試験語乙※')
    expect(line).not.toContain('（よみものしけんごおつ）')
  })
  /** @covers REQ-497#paren-kept-same-as-other-term */
  it('括弧書きを落とすと用語集の他の語と同じになる語は、正式な表記のまま ※ を添える', () => {
    ok()
    expect(glossaryLine('sameAsOther')).toContain('読み物試験語丙（別の意味）※')
  })
  /** @covers REQ-497#paren-kept-same-as-other-shortened */
  it('括弧書きを落とすと他の語から括弧書きを落とした表記と同じになる語は、正式な表記のまま ※ を添える', () => {
    ok()
    expect(glossaryLine('sameAsOtherShortened')).toContain('読み物試験語丁（甲）※')
  })
  /** @covers REQ-497#not-in-glossary-plain */
  it('用語集に無い語は、印を添えず書かれた文字のまま置く', () => {
    ok()
    const line = glossaryLine('notInGlossary')
    expect(line).toContain('読み物に無い試験語')
    expect(line).not.toContain('読み物に無い試験語※')
  })
  /** @covers REQ-497#term-in-bold */
  it('太字の中の用語の記法も、用語集にある語なら ※ を添えて置く', () => {
    ok()
    expect(glossaryLine('inBold')).toContain('読み物試験語甲※')
  })

  /** @covers REQ-498#svg-drawn-as-png */
  it('置き場の直下の svg の図は、出力先の figures の下に拡張子を .png にした PNG として入り、読み物の図はそれを指す', () => {
    ok()
    const A = T(0)
    for (const sub of [`${A.id}-1`, `${A.id}-2`, `${T(3).id}-1`]) {
      expect(r.json.figures).toContain(`figures/${sub}.png`)
      expect(isPng(ws.bytes(`${OUT}/figures/${sub}.png`)), sub).toBe(true)
      imageAt(`${sub}.svg`)
    }
  })

  /** @covers REQ-498#subpath-kept */
  it('置き場のサブパスの下の図は、figures の下に同じサブパスで PNG として入る', () => {
    ok()
    const sub = lineSub(T(4), 'sub', T(0)).replace(/\.svg$/, '.png')
    expect(r.json.figures).toContain(`figures/${sub}`)
    expect(isPng(ws.bytes(`${OUT}/figures/${sub}`))).toBe(true)
  })

  /** @covers REQ-498#png-source */
  it('元が png の図も、同じ名前の PNG として入る', () => {
    ok()
    const sub = lineSub(T(4), 'png', T(0))
    expect(r.json.figures).toContain(`figures/${sub}`)
    expect(isPng(ws.bytes(`${OUT}/figures/${sub}`))).toBe(true)
  })

  /** @covers REQ-498#caption-once */
  it('図の説明文は、図の画像の代替文に持たせず、図のすぐそばの文字として読み物に 1 回だけ出る', () => {
    ok()
    const A = T(0), D = T(3), E = T(4)
    const figures: [string, string][] = [
      [`${A.id}-1.svg`, insertedCaption(A, 1)],
      [`${A.id}-2.svg`, insertedCaption(A, 2)],
      [`${D.id}-1.svg`, insertedCaption(D, 1)],
      [lineSub(E, 'png', A), lineCaption(E, 'png')],
      [lineSub(E, 'sub', A), lineCaption(E, 'sub')],
    ]
    const lines = md.split('\n')
    for (const [sub, caption] of figures) {
      expect(countOf(md, caption), caption).toBe(1)
      const png = `figures/${sub.replace(/\.(svg|png)$/, '.png')}`
      const img = imagesOf(md).find((i) => i.ref.replace(/^\.\//, '') === png)!
      expect(img, png).toBeDefined()
      expect(img.alt).not.toContain(caption)
      const lineNo = md.slice(0, img.at).split('\n').length - 1
      const near = (dir: 1 | -1) => {
        for (let i = lineNo + dir; i >= 0 && i < lines.length; i += dir) if (lines[i].trim()) return lines[i]
        return ''
      }
      const sameLineRest = lines[lineNo].replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      expect([sameLineRest, near(1), near(-1)].some((l) => l.includes(caption)), `${caption} が図のそばに無い`).toBe(true)
    }
  })

  /** @covers REQ-498#no-outside-reference */
  it('読み物の図はどれも出力先の中の PNG を指し、配信の置き場を指さない', () => {
    ok()
    expect(md).not.toContain('/figures/materials/')
    for (const { ref } of imagesOf(md)) {
      expect(ref).toMatch(/\.png$/)
      expect(isInside(ws.abs(OUT), resolveIn(ws.abs(READING), ref)), ref).toBe(true)
    }
  })

  /** @covers REQ-498#response-matches-files */
  it('応答の reading と figures は出力先に実在するファイルと一致し、figures は読み物が指す図と一致する', () => {
    ok()
    expect(r.json.reading).toBe('reading.md')
    expect(ws.entries(OUT), '出力先のファイルとディレクトリが応答と違う').toEqual(withParentDirs(['reading.md', ...(r.json.figures as string[])]))
    expect([...new Set(imagesOf(md).map((i) => i.ref.replace(/^\.\//, '')))].sort()).toEqual((r.json.figures as string[]).slice().sort())
  })

  /** @covers REQ-498#topic-without-figure */
  it('図の仕様も図の行も持たない論点の区切りには図を置かない', () => {
    ok()
    for (const t of [T(1), T(2), ...unit.topics.slice(5)]) expect(imagesOf(sectionOf(md, unit, t).text), t.term).toEqual([])
  })

  /** @covers REQ-499#no-question-content */
  it('読み物に、単元の論点の過去問の問題文と問題解説（正解の根拠・誤答の注）を含めない', () => {
    ok()
    const refs = questionsOfUnit(ws, unit.order)
    const texts = [...questionStems(ws, refs), ...questionExplanations(ws, refs)].map((s) => s.slice(0, 25)).filter((s) => s.length >= 12)
    expect(texts.length).toBeGreaterThan(0)
    for (const s of texts) expect(md, s).not.toContain(s)
  })

  /** @covers REQ-499#no-topic-id */
  it('読み物の文に、単元の論点の ID を含めない（図の画像の参照先を除く）', () => {
    ok()
    const text = withoutImageTargets(md)
    for (const id of unit.order) expect(hasNumberToken(text, id), `論点の ID ${id}`).toBe(false)
  })

  /** @covers REQ-499#no-generation-name */
  it('読み物に教材の世代の名前を含めない', () => {
    ok()
    expect(md).not.toMatch(/materials/)
  })

  /** @covers REQ-499#items-to-maker */
  it('応答の items で、項目の番号ごとの論点の ID・論点の名前・選んだ教材の世代を作り手に示す', () => {
    ok()
    expect((r.json.items as Json[]).map((x) => pick(x, ['no', 'topic_id', 'term', 'generation']))).toEqual(
      unit.order.map((id, i) => ({ no: i + 1, topic_id: id, term: unit.byId(id).term, generation: REWRITTEN })),
    )
  })

  /** @covers REQ-509#same-name-other-subpath-ok */
  it('同じ名前でサブパスの違う図は同じ PNG の名前にならず、どちらも描かれて読み物が出来る', () => {
    ok()
    const A = T(0)
    expect(r.json.figures).toContain(`figures/${A.id}-1.png`)
    expect(r.json.figures).toContain(`figures/uc028/${A.id}-1.png`)
  })
})

describe('UC-028 単元の読み物を作る: 単元の全論点を前の世代から選ぶ（buildUnitReading）', () => {
  let ws: Ws
  let unit: ReturnType<typeof setupPrevious>
  let r: Run
  let md = ''
  beforeAll(() => {
    ws = makeWorkspace('unit-previous')
    unit = setupPrevious(ws)
    r = build(ws, { out: OUT })
    md = ws.exists(READING) ? ws.read(READING) : ''
  })
  const ok = () => expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  const T = (i: number) => unit.at(i)
  const imageAt = (sub: string) => {
    const png = `figures/${sub.replace(/\.(svg|png)$/, '.png')}`
    const hits = imagesOf(md).filter((i) => i.ref.replace(/^\.\//, '') === png)
    expect(hits, `${png} を指す図が 1 つでない`).toHaveLength(1)
    return hits[0].at
  }

  /** @covers REQ-494#previous-generation-unit */
  it('前の世代から選ぶ単元でも、冒頭に全体像を置き、まとまりの見出しと論点を単元の構成の順に、1 から続く項目の番号で置く', () => {
    ok()
    expect(countOf(md, unit.plan.overview)).toBe(1)
    expectStructure(md, unit)
    expect((r.json.items as Json[]).map((x) => x.no)).toEqual(unit.order.map((_, i) => i + 1))
  })

  /** @covers REQ-496#selected-generation-body */
  it('論点ごとに投入が選ぶ最も新しい世代の本文を置き、その前の世代の同じ論点の本文は出ない', () => {
    ok()
    expect(md).not.toContain(unit.decoy)
    for (const t of unit.topics) expect(sectionOf(md, unit, t).text, t.term).toContain(body.detB(t))
  })

  /** @covers REQ-496#line-position */
  it('前の世代の本文の図は、図の仕様の差し込み位置ではなく本文の図の行の位置に置く', () => {
    ok()
    const A = T(0)
    const sa = sectionOf(md, unit, A)
    const atA = imageAt(`${A.id}-1.svg`)
    expect(atA).toBeGreaterThan(md.indexOf(body.expl1(A), sa.start))
    expect(atA).toBeLessThan(md.indexOf(body.expl2(A), sa.start))
    const D = T(3)
    const sd = sectionOf(md, unit, D)
    const atD = imageAt(`${D.id}-1.svg`)
    expect(atD).toBeGreaterThan(md.indexOf(body.detA1(D), sd.start))
    expect(atD).toBeLessThan(md.indexOf(body.detA2(D), sd.start))
  })

  /** @covers REQ-499#items-to-maker */
  it('応答の items の世代は、論点ごとに投入が選んだ前の世代の名前になる', () => {
    ok()
    expect((r.json.items as Json[]).map((x) => pick(x, ['no', 'topic_id', 'term', 'generation']))).toEqual(
      unit.order.map((id, i) => ({ no: i + 1, topic_id: id, term: unit.byId(id).term, generation: unit.genOf(id) })),
    )
  })

  /** @covers REQ-505#previous-generations-together */
  it('前の世代どうし（異なる前の世代）から選ぶ論点が混ざる単元は、世代が混ざったとして止めずに読み物を作る', () => {
    ok()
    expect(new Set(unit.order.map((id) => unit.genOf(id))).size).toBeGreaterThan(1)
    expect(ws.exists(READING)).toBe(true)
  })

  /** @covers REQ-506#oldest-generation-only-ok */
  it('最も古い世代にだけ本文のある論点も、その本文を配る本文として置く', () => {
    ok()
    const C = T(2)
    expect(unit.genOf(C.id)).toBe('materials')
    expect(sectionOf(md, unit, C).text).toContain(body.expl1(C))
  })

  /** @covers REQ-508#heading-irrelevant-with-lines */
  it('図の行を持つ論点では、図の仕様の差し込み位置の見出しが本文に無くても止めずに読み物を作る', () => {
    ok()
    expect(r.json.figures).toContain(`figures/${T(3).id}-1.png`)
  })

  function sectionOf(md: string, u: Unit, t: TopicFixture) {
    const s = sectionsOf(md, u).get(t.id)
    expect(s, `論点「${t.term}」の見出しが読み物に無い`).toBeDefined()
    return s!
  }
})

describe('UC-028 単元の構成の門: 指定した単元に関する止める理由が無ければ作る（buildUnitReading）', () => {
  let ws: Ws
  let r: Run
  beforeAll(() => {
    ws = makeWorkspace('gate-other-unit')
    const unit = setupRewritten(ws)
    /* 別の単元にだけ止める理由（学びに無い前提）を置き、読み物にする単元には警告（まとまりの論点が下限に届かない）だけを置く。 */
    const other = ws.readJson(planFile(ws, OTHER_UNIT))
    other.prerequisites = { ...(other.prerequisites ?? {}), [String(learningOrder(other)[0])]: [999999] }
    ws.writeJson(planFile(ws, OTHER_UNIT), other)
    const plan = ws.readJson(planFile(ws, UNIT))
    const [g1, g2, ...rest] = plan.groups as Json[]
    const moved = g1.topics[g1.topics.length - 1]
    plan.groups = [{ ...g1, topics: g1.topics.slice(0, -1) }, { ...g2, topics: [moved, ...g2.topics] }, ...rest]
    expect(learningOrder(plan)).toEqual(unit.order)
    ws.writeJson(planFile(ws, UNIT), plan)
    r = build(ws, { out: OUT })
  })

  /** @covers REQ-504#other-unit-reason-ignored */
  it('止める理由が別の単元にだけあるとき、指定した単元の読み物を作る', () => {
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(ws.exists(READING)).toBe(true)
  })

  /** @covers REQ-504#warning-only-ok */
  it('指定した単元に警告（まとまりの論点が下限に届かない）だけがあるとき、止めずに読み物を作る', () => {
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.json.reading).toBe('reading.md')
  })
})

describe('UC-028 出力先が既にある空のディレクトリ（buildUnitReading）', () => {
  /** @covers REQ-510#existing-empty-dir-accepted */
  it('出力先が既にある空のディレクトリなら、そこに読み物を作る', () => {
    const ws = makeWorkspace('out-empty')
    setupRewritten(ws)
    ws.write(`${OUT}/.keep`, '')
    ws.remove(`${OUT}/.keep`)
    expect(ws.files(OUT)).toEqual([])
    const r = build(ws, { out: OUT })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(ws.exists(READING)).toBe(true)
  })
})

describe('UC-028 単元の読み物を作る: 行頭と行末に空白を持つ図の行（buildUnitReading）', () => {
  /** 図の行の形（BR-054）が行頭と行末に置ける空白: 半角の空白・タブ・全角の空白。 */
  const LEADING = ' \t\u3000 '
  const TRAILING = '\u3000\t '
  const CAPTION = '前後に空白を持つ図の行の説明文です。'
  let ws: Ws
  let unit: ReturnType<typeof setupRewritten>
  let r: Run
  let md = ''
  beforeAll(() => {
    ws = makeWorkspace('line-surrounding-space')
    unit = setupRewritten(ws)
    const t = unit.at(5)
    ws.write(figureFile(ws, `${t.id}-1.svg`), svgWith('空白の図'))
    const detail = `${body.headA(t)}\n${body.detA1(t)}\n\n${LEADING}![${CAPTION}](${figureRef(`${t.id}-1.svg`)})${TRAILING}\n\n${body.detA2(t)}\n${body.headB(t)}\n${body.detB(t)}`
    setEntry(ws, REWRITTEN, t.id, { term: t.term, explanation: plainExplanation(t), detail })
    r = build(ws, { out: OUT })
    md = ws.exists(READING) ? ws.read(READING) : ''
  })

  /** @covers REQ-496#line-with-surrounding-space */
  it('行頭と行末に半角の空白・タブ・全角の空白を持つ図の行も図の行として読み、図をその行の位置（前後の段の間）に PNG で置く', () => {
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    const t = unit.at(5)
    const s = sectionOf(md, unit, t)
    const png = `figures/${t.id}-1.png`
    expect(r.json.figures).toContain(png)
    expect(isPng(ws.bytes(`${OUT}/${png}`))).toBe(true)
    const hits = imagesOf(md).filter((i) => i.ref.replace(/^\.\//, '') === png)
    expect(hits, `${png} を指す図が 1 つでない`).toHaveLength(1)
    expect(hits[0].at).toBeGreaterThan(md.indexOf(body.detA1(t), s.start))
    expect(hits[0].at).toBeLessThan(md.indexOf(body.detA2(t), s.start))
    expect(md).not.toContain('/figures/materials/')
  })
})

describe('UC-028 単元の読み物を作る: 同じ差し込み位置に図が 3 枚ずつある書き直した世代の論点（buildUnitReading）', () => {
  /** 差し込み位置ごとの図の仕様の順。どれも図の id の昇順（小さい順）とも降順とも違う。 */
  const ORDER = { explanation: [5, 6, 4], headA: [2, 3, 1], headB: [8, 9, 7] }
  /** 見出し乙の節の二段目（節の段を 2 つにして、最初の段の後に置く置き方と見分ける）。 */
  const detB2 = (t: TopicFixture) => `${t.stem}の解説の乙の二段目です。`
  let ws: Ws
  let unit: ReturnType<typeof setupRewritten>
  let r: Run
  let md = ''
  const F = () => unit.at(5)
  beforeAll(() => {
    ws = makeWorkspace('same-position-order')
    unit = setupRewritten(ws)
    const t = F()
    const detail = `${body.headA(t)}\n${body.detA1(t)}\n\n${body.detA2(t)}\n${body.headB(t)}\n${body.detB(t)}\n\n${detB2(t)}`
    setEntry(ws, REWRITTEN, t.id, { term: t.term, explanation: plainExplanation(t), detail })
    const after = { explanation: 'explanation', headA: body.headA(t), headB: body.headB(t) }
    const keys = ['headA', 'explanation', 'headB'] as const
    // 図の仕様では差し込み位置の違う図を互い違いに並べる（同じ差し込み位置の中の順だけが図の仕様の順になる）。
    const figures = [0, 1, 2].flatMap((i) => keys.map((k) => specFigure(ORDER[k][i], after[k], insertedCaption(t, ORDER[k][i]))))
    writeSpec(ws, t.id, t.term, figures)
    for (const k of keys) for (const id of ORDER[k]) ws.write(figureFile(ws, `${t.id}-${id}.svg`), svgWith(`図${id}`))
    r = build(ws, { out: OUT })
    md = ws.exists(READING) ? ws.read(READING) : ''
  })
  const ok = () => expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  const positionsOf = (ids: number[]) =>
    ids.map((id) => {
      const png = `figures/${F().id}-${id}.png`
      const hits = imagesOf(md).filter((i) => i.ref.replace(/^\.\//, '') === png)
      expect(hits, `${png} を指す図が 1 つでない`).toHaveLength(1)
      return hits[0].at
    })
  const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] < x)

  /** @covers REQ-496#insert-at-heading-section-end */
  it('差し込み位置が見出しの図は、後に見出しのある節では節の最後の段の後・次の見出しの前に、後に見出しの無い節では節の最後の段の後に置く', () => {
    ok()
    const t = F()
    const s = sectionOf(md, unit, t)
    const lastA = md.indexOf(body.detA2(t), s.start)
    const nextHead = md.indexOf(body.headB(t).replace(/^#+\s*/, ''), s.start)
    for (const at of positionsOf(ORDER.headA)) {
      expect(at, '見出し甲の図が、節の最後の段より前にある').toBeGreaterThan(lastA)
      expect(at, '見出し甲の図が、次の見出しより後にある').toBeLessThan(nextHead)
    }
    const lastB = md.indexOf(detB2(t), s.start)
    for (const at of positionsOf(ORDER.headB)) {
      expect(at, '見出し乙の図が、節の最後の段より前にある').toBeGreaterThan(lastB)
      expect(at).toBeLessThan(s.end)
    }
  })

  /** @covers REQ-496#same-heading-spec-order */
  it('同じ見出しを差し込み位置にする図は、図の仕様に並ぶ順に上から置く（後に見出しのある節と無い節の両方）', () => {
    ok()
    expect(ascending(positionsOf(ORDER.headA)), `見出し甲の図が図の仕様の順 ${ORDER.headA.join('→')} に並ばない`).toBe(true)
    expect(ascending(positionsOf(ORDER.headB)), `見出し乙の図が図の仕様の順 ${ORDER.headB.join('→')} に並ばない`).toBe(true)
  })

  /** @covers REQ-496#same-explanation-spec-order */
  it('短い説明を差し込み位置にする図は、図の仕様に並ぶ順に上から置く', () => {
    ok()
    expect(ascending(positionsOf(ORDER.explanation)), `短い説明の図が図の仕様の順 ${ORDER.explanation.join('→')} に並ばない`).toBe(true)
  })
})

describe('UC-028 出力先の値が - で始まる（buildUnitReading）', () => {
  /** @covers REQ-501#hyphen-value-in-shape */
  it('- で始まる出力先の値は、= の有無どちらで渡しても値として読み、断らずにその出力先に読み物を作る', () => {
    const ws = makeWorkspace('hyphen-value')
    setupRewritten(ws)
    const cases: [string, string[]][] = [
      ['-x', ['--data', ws.data, '--unit', UNIT, '--out', '-x']],
      ['-y', ['--data', ws.data, `--unit=${UNIT}`, '--out=-y']],
    ]
    for (const [out, args] of cases) {
      const r = buildRaw(ws, args)
      expect(r.status, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0)
      expect(r.json.reading).toBe('reading.md')
      expect(ws.exists(`${out}/reading.md`), out).toBe(true)
    }
  })
})
