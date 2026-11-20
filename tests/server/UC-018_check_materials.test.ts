import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  DATA,
  type GateRun,
  type Learning,
  type Material,
  PUBLIC,
  QUESTION_TEXT,
  TOPICS,
  findings,
  gate,
  goodMaterial,
  kinds,
  makeLearning,
  outOf,
  removeShadows,
} from './UC-018_fixture'

/** UC-018 資格対策の教材の門（checkMaterials ＝ `python3 scripts/check_materials.py`）の境界。
 *  門には影の根の中に作った小さな学び（UC-018_fixture.ts）を渡し、結果は標準出力の最後の機械向けの 1 行（契約の response）で読む。
 *  止める理由と警告は、種類と、論点の ID かファイル名が where か reason に出ることだけを見る（文の言い回しは見ない）。 */

vi.setConfig({ testTimeout: 180_000 })

afterAll(async () => {
  await removeShadows()
})

/** 契約の limits の値。 */
const LIMITS = {
  quoteLength: 30,
  quoteStep: 10,
  requiredExplanationLine: '**キーワード**',
  tableColumns: { min: 2, max: 4 },
  tableRows: { min: 2, max: 8 },
  tableCellLength: 40,
  roleSplitFrom: 3,
  bundleGeneration: 'materials_v2',
}

/** 役割分担前の世代（materials_v2）で警告に当たらない教材（「出題」を含む見出しを持つ）。 */
const goodV2 = (id: number, term = TOPICS.find((t) => t.id === id)!.term): Material => ({
  topic_id: id,
  term,
  explanation: `**${term}**とは、データを扱う装置の一つです。`,
  detail: `### 出題のされ方\n${term}の働きが問われます。\n\n### しくみ\n${term}は決められた手順で働きます。`,
})

/** 役割分担後の世代の手本の教材 1 を edit で変え、ほかの論点は手本のまま置く。 */
function withTopic1(name: string, edit: (m: Material) => void, generation = 'materials_v3'): Learning {
  const l = makeLearning(name, { materials: false })
  const base = generation === 'materials_v2' ? goodV2 : goodMaterial
  const list = TOPICS.map((t) => base(t.id))
  edit(list[0])
  l.materials(generation, '01-1.json', list)
  return l
}

/** 結果の行が読めたことを確かめて返す。 */
function resultOf(r: GateRun) {
  expect(r.result, `機械向けの 1 行（契約の response）が最後の行に無い:\n${outOf(r)}`).not.toBeNull()
  return r.result!
}
/** 通した: 終了 0、exitCode 0、止める理由なし。 */
function expectPassed(r: GateRun) {
  const res = resultOf(r)
  expect(r.code, outOf(r)).toBe(0)
  expect(res.exitCode).toBe(0)
  expect(res.stops, outOf(r)).toEqual([])
  return res
}
/** 止めた: 終了 1、exitCode 1、kind の止める理由が needle を挙げる。 */
function expectStopped(r: GateRun, kind: string, needle: string) {
  const res = resultOf(r)
  expect(r.code, outOf(r)).toBe(1)
  expect(res.exitCode).toBe(1)
  expect(findings(res.stops, kind, needle).length, `${kind} で ${needle} を挙げていない:\n${JSON.stringify(res.stops)}`).toBeGreaterThan(0)
  return res
}
/** 警告した（止めない）: 終了 0、kind の警告が needle を挙げる。 */
function expectWarned(r: GateRun, kind: string, needle = '1') {
  const res = expectPassed(r)
  expect(findings(res.warnings, kind, needle).length, `${kind} の警告で ${needle} を挙げていない:\n${JSON.stringify(res.warnings)}`).toBeGreaterThan(0)
  return res
}
/** 止める理由も警告も無く通した。 */
function expectClean(r: GateRun) {
  const res = expectPassed(r)
  expect(res.warnings, outOf(r)).toEqual([])
  return res
}
/** 断った: 終了 0 でない、ToolError の code、止める理由と警告を返さない。 */
function expectRefused(r: GateRun, code: string) {
  expect(r.code, outOf(r)).not.toBe(0)
  expect(r.refusal?.code, outOf(r)).toBe(code)
  expect(r.result, '断ったのに確かめた結果を返した').toBeNull()
}

const table = (rows: string[][], separator = true) => {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const out = [line(rows[0])]
  if (separator) out.push(line(rows[0].map(() => '---')))
  for (const r of rows.slice(1)) out.push(line(r))
  return out.join('\n')
}
const cells = (cols: number, label: string) => Array.from({ length: cols }, (_, i) => `${label}${i + 1}`)
const rowsOf = (n: number, cols: number) => Array.from({ length: n }, (_, i) => cells(cols, `値${i}`))
const withTable = (t: string) => (m: Material) => (m.detail = `${m.detail}\n\n${t}`)
const sentences = (n: number, unit: string) => Array.from({ length: n }, (_, i) => `${unit}の${i + 1}番目の文です。`).join('')

describe('UC-018 資格対策の教材を配る前に教材の門で確かめる', () => {
  describe('止める理由が無ければ警告の有無によらず通し、見た数と教材の無い論点と警告を返す（REQ-291）', () => {
    // @covers REQ-291#pass-clean
    it('止める理由にも警告にも当たらない教材は、終了の状態 0 で通し、見た論点の数と空の止める理由と警告と門が使った値を返す', async () => {
      const res = expectClean(await gate(makeLearning('pass-clean')))
      expect(res.topics).toBe(TOPICS.length)
      expect(res.limits).toEqual(LIMITS)
    })

    // @covers REQ-291#pass-with-warnings
    it('警告だけが当たる教材（IPA 原文の句読点を含む）も通し、警告ごとに種類と論点と箇所を返す', async () => {
      expectWarned(await gate(withTopic1('pass-warn', (m) => (m.detail = `${m.detail}\n記憶装置は，データを保ちます．`))), 'sourcePunctuation')
    })
  })

  describe('情報の量（字数・文数・見出しの数・箇条書きや比較の項目の数）を止める理由にも警告にもしない（REQ-292）', () => {
    // @covers REQ-292#long-not-flagged
    it('説明が 2000 字で 60 文、詳しい解説が 5000 字で 150 文の教材を、止める理由にも警告にも挙げない', async () => {
      const l = withTopic1('long', (m) => {
        const pad = (text: string, len: number) => text + 'あ'.repeat(Math.max(0, len - text.length))
        m.explanation = `**記憶装置**とは${pad(sentences(59, '説明'), 1990)}です。\n**キーワード**：装置`
        m.detail = `### しくみ\n${pad(sentences(149, '解説'), 4990)}です。`
      })
      expectClean(await gate(l))
    })

    // @covers REQ-292#short-not-flagged
    it('説明が 1 文、詳しい解説が見出し 1 つと 1 文の教材を挙げない', async () => {
      const l = withTopic1('short', (m) => {
        m.explanation = '**記憶装置**とは、データを保つ装置です。\n**キーワード**：保存'
        m.detail = '### しくみ\nデータを保ちます。'
      })
      expectClean(await gate(l))
    })

    // @covers REQ-292#many-headings-and-items-not-flagged
    it('役割分担後の世代で、詳しい解説が見出し 10 個・続く箇条書き 30 項目・「- **語** —」の形の比較の項目 20 件を持つ教材を挙げない', async () => {
      const l = withTopic1('many', (m) => {
        const headings = Array.from({ length: 10 }, (_, i) => `### 見出し${i + 1}\n${['- 一つ目の働きです', '- 二つ目の働きです', '- 三つ目の働きです'].join('\n')}`)
        const compare = Array.from({ length: 20 }, (_, i) => `- **語${i + 1}** — ${i + 1}番目の語の説明です`)
        m.detail = `${headings.join('\n\n')}\n\n### 比べる\n${compare.join('\n')}`
      })
      expectClean(await gate(l))
    })

    // @covers REQ-292#few-headings-before-role-split-not-flagged
    it('役割分担前の世代で、詳しい解説の見出しが 1 つ（「出題」を含む）の教材を挙げない', async () => {
      const l = withTopic1('few-v2', (m) => (m.detail = '### 出題のされ方\n記憶装置の働きが問われます。'), 'materials_v2')
      expectClean(await gate(l))
    })
  })

  describe('説明か詳しい解説が無いか空白だけか空なら、その論点と欠けた要素を挙げて止める（REQ-293）', () => {
    // @covers REQ-293#explanation-empty
    it('説明が空の教材を missingElement で止める', async () => {
      expectStopped(await gate(withTopic1('expl-empty', (m) => (m.explanation = ''))), 'missingElement', '1')
    })

    // @covers REQ-293#detail-missing
    it('詳しい解説の欄が無い教材を missingElement で止める', async () => {
      expectStopped(await gate(withTopic1('detail-missing', (m) => delete m.detail)), 'missingElement', '1')
    })

    // @covers REQ-293#whitespace-only
    it('詳しい解説が空白と改行だけの教材を missingElement で止める', async () => {
      expectStopped(await gate(withTopic1('whitespace', (m) => (m.detail = '  \n\n \t '))), 'missingElement', '1')
    })
  })

  describe('読めない教材のファイル・論点名の食い違い・学びに無い論点・束の割り当てとの違いを挙げて止める（REQ-294）', () => {
    // @covers REQ-294#file-unreadable
    it('途中で途切れた教材のファイル（書き手が書いている途中）を、そのファイルを挙げて unreadableOutput で止める', async () => {
      const l = makeLearning('unreadable')
      l.put('materials_v3/01-2.json', '{ "materials": [ { "topic_id": 1, ')
      expectStopped(await gate(l), 'unreadableOutput', '01-2.json')
    })

    // @covers REQ-294#topic-id-missing
    it('論点の ID を持たない教材があるファイルを unreadableOutput で止める', async () => {
      const l = makeLearning('no-id')
      const { topic_id: _id, ...rest } = goodMaterial(1)
      l.put('materials_v3/01-2.json', { materials: [rest] })
      expectStopped(await gate(l), 'unreadableOutput', '01-2.json')
    })

    // @covers REQ-294#term-mismatch
    it('論点名が学びの論点と食い違う教材を termMismatch で止める', async () => {
      expectStopped(await gate(withTopic1('term', (m) => (m.term = '別の名前の装置'))), 'termMismatch', '1')
    })

    // @covers REQ-294#orphan-material
    it('学びに無い論点の教材を orphanMaterial で止める', async () => {
      const l = makeLearning('orphan')
      l.materials('materials_v3', '01-2.json', [goodMaterial(99, '学びに無い論点')])
      expectStopped(await gate(l), 'orphanMaterial', '99')
    })

    // @covers REQ-294#bundle-mismatch
    it('束を突き合わせる世代の束の論点が、同じ名前の束の割り当てと違う束を bundleMismatch で止める', async () => {
      const l = makeLearning('bundle', { materials: false })
      l.materials('materials_v2', 'bundle_01.json', [goodV2(1), goodV2(2)])
      l.materials('materials_v2', 'bundle_02.json', [goodV2(3)])
      l.put('material_bundles/bundle_01.json', { topics: [{ topic_id: 1 }, { topic_id: 3 }] })
      expectStopped(await gate(l), 'bundleMismatch', 'bundle_01')
    })

    // @covers REQ-294#bundle-without-assignment
    it('同じ名前の束の割り当てが無い束は突き合わせず、止めない', async () => {
      const l = makeLearning('bundle-none', { materials: false })
      l.materials('materials_v2', 'bundle_01.json', TOPICS.map((t) => goodV2(t.id)))
      expectPassed(await gate(l))
    })
  })

  describe('崩れた表か、行か列の数が表示の制約から外れる表を挙げて止める（REQ-295）', () => {
    // @covers REQ-295#no-separator
    it('2 行目が区切りの行でない表を brokenTable で止める', async () => {
      expectStopped(await gate(withTopic1('no-sep', withTable(table(rowsOf(3, 2), false)))), 'brokenTable', '1')
    })

    // @covers REQ-295#single-row
    it('先頭が「|」の 1 行だけの表を brokenTable で止める', async () => {
      expectStopped(await gate(withTopic1('single-row', withTable('| 項目 | 値 |'))), 'brokenTable', '1')
    })

    // @covers REQ-295#uneven-cells
    it('行ごとのセルの数がヘッダとそろわない表を brokenTable で止める', async () => {
      expectStopped(await gate(withTopic1('uneven', withTable('| a | b |\n| --- | --- |\n| c | d | e |'))), 'brokenTable', '1')
    })

    // @covers REQ-295#too-many-columns
    it('列が上限 + 1 の表を tableTooWide で止める', async () => {
      expectStopped(await gate(withTopic1('wide', withTable(table(rowsOf(3, LIMITS.tableColumns.max + 1))))), 'tableTooWide', '1')
    })

    // @covers REQ-295#too-few-rows
    it('ヘッダと区切りの行だけの表（行が下限 − 1）を tableTooShort で止める', async () => {
      expectStopped(await gate(withTopic1('short-table', withTable(table(rowsOf(LIMITS.tableRows.min - 1, 2))))), 'tableTooShort', '1')
    })

    // @covers REQ-295#too-many-rows
    it('行（区切りの行を数えない）が上限 + 1 の表を tableTooLong で止める', async () => {
      expectStopped(await gate(withTopic1('long-table', withTable(table(rowsOf(LIMITS.tableRows.max + 1, 2))))), 'tableTooLong', '1')
    })

    // @covers REQ-295#within-limits
    it('行と列が下限ちょうどの表と上限ちょうどの表は止めない', async () => {
      const l = withTopic1('within', (m) => {
        withTable(table(rowsOf(LIMITS.tableRows.min, LIMITS.tableColumns.min)))(m)
        withTable(table(rowsOf(LIMITS.tableRows.max, LIMITS.tableColumns.max)))(m)
      })
      expectPassed(await gate(l))
    })

    // @covers REQ-295#without-headings
    it('詳しい解説が見出しを持たない教材の崩れた表は止めない', async () => {
      const l = withTopic1('no-heading', (m) => (m.detail = `記憶装置はデータを保ちます。\n\n${table(rowsOf(3, 2), false)}`))
      const res = expectPassed(await gate(l))
      expect(kinds(res.stops)).not.toContain('brokenTable')
    })
  })

  describe('図の行が指す画像が配信の置き場に無ければ、その論点と図を挙げて止める（REQ-296）', () => {
    const FIGURE = '/figures/materials/ip/1-1.svg'
    // @covers REQ-296#figure-missing
    it('置き場に無い画像を指す図の行を、その論点と図を挙げて figureMissing で止める', async () => {
      expectStopped(await gate(withTopic1('fig-missing', (m) => (m.detail = `${m.detail}\n\n![記憶装置の図](${FIGURE})`))), 'figureMissing', '1-1.svg')
    })

    // @covers REQ-296#figure-present
    it('置き場にある画像を指す図の行は止めない', async () => {
      const l = withTopic1('fig-present', (m) => (m.detail = `${m.detail}\n\n![記憶装置の図](${FIGURE})`))
      writeFileSync(l.s.path(`${PUBLIC}${FIGURE}`), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
      expectPassed(await gate(l))
    })
  })

  describe('用語として示した語が用語集に無くても止める理由にも警告にもしない（REQ-298）', () => {
    // @covers REQ-298#unknown-term-not-flagged
    it('論点にも用語集にも無い語を用語として示した教材を、止める理由にも警告にも挙げない', async () => {
      expectClean(await gate(withTopic1('unknown-term', (m) => (m.detail = `${m.detail}\n\n[[どこにも無い仕込みの語]]と並べて使います。`))))
    })
  })

  describe('過去問の本文の、間隔おきの位置から取った閾値の字数の部分がそのまま現れれば止める（REQ-300）', () => {
    // @covers REQ-300#quote-at-threshold
    it('過去問の本文の先頭から 30 字がそのまま現れる教材を pastQuestionQuote で止める', async () => {
      const quote = QUESTION_TEXT.slice(0, LIMITS.quoteLength)
      expectStopped(await gate(withTopic1('quote-30', (m) => (m.detail = `${m.detail}\n${quote}`))), 'pastQuestionQuote', '1')
    })

    // @covers REQ-300#quote-below-threshold
    it('過去問の本文の先頭から 29 字までの一致は止めない', async () => {
      const quote = QUESTION_TEXT.slice(0, LIMITS.quoteLength - 1)
      const res = expectPassed(await gate(withTopic1('quote-29', (m) => (m.detail = `${m.detail}\n${quote}`))))
      expect(kinds(res.stops)).not.toContain('pastQuestionQuote')
    })

    // @covers REQ-300#quote-off-step
    it('間隔おきの位置から外れた位置で始まる 30 字だけの一致（39 字に満たない）は止めない', async () => {
      const quote = QUESTION_TEXT.slice(5, 5 + LIMITS.quoteLength)
      const res = expectPassed(await gate(withTopic1('quote-off', (m) => (m.detail = `${m.detail}\n${quote}`))))
      expect(kinds(res.stops)).not.toContain('pastQuestionQuote')
    })
  })

  describe('誤った引数・登録簿に無いか資格対策でない学び・学びの外の世代・無い置き場は、何も確かめずに断る（REQ-315）', () => {
    /** 壊れた教材を持つ、学び key の置き場を作る。 */
    const brokenLearning = (l: Learning, key: string) => {
      const dir = l.s.path(`w/data/${key}/materials_v3`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/01-1.json`, '{ "materials": [')
    }

    // @covers REQ-315#bad-arguments
    it('知らない名前の引数・値の無い引数は INVALID_INPUT で断る（場合ごと）', async () => {
      const l = makeLearning('bad-args')
      expectRefused(await gate(l, ['--data', DATA, '--unknown-argument', 'x']), 'INVALID_INPUT')
      expectRefused(await gate(l, ['--data']), 'INVALID_INPUT')
    })

    // @covers REQ-315#unknown-learning
    it('登録簿に無い学び（zzz）は、置き場と壊れた教材があっても INVALID_INPUT で断る', async () => {
      const l = makeLearning('unknown')
      brokenLearning(l, 'zzz')
      expectRefused(await gate(l, ['--data', 'w/data/zzz']), 'INVALID_INPUT')
    })

    // @covers REQ-315#not-qualification
    it('ロードマップ型の学び（itc）は、置き場と壊れた教材があっても INVALID_INPUT で断る', async () => {
      const l = makeLearning('not-qual')
      brokenLearning(l, 'itc')
      expectRefused(await gate(l, ['--data', 'w/data/itc']), 'INVALID_INPUT')
    })

    // @covers REQ-315#dir-outside-learning
    it('別の学びの教材の世代の置き場を指定すると INVALID_INPUT で断る', async () => {
      const l = makeLearning('outside')
      brokenLearning(l, 'ap')
      expectRefused(await gate(l, ['--data', DATA, '--dir', 'w/data/ap/materials_v3']), 'INVALID_INPUT')
    })

    // @covers REQ-315#learning-dir-missing
    it('置き場の無い資格対策の学びは NOT_FOUND で断る', async () => {
      expectRefused(await gate(makeLearning('no-learning'), ['--data', 'w/data/fe']), 'NOT_FOUND')
    })

    // @covers REQ-315#dir-missing
    it('学びの置き場の下に無い教材の世代の置き場を指定すると NOT_FOUND で断る', async () => {
      expectRefused(await gate(makeLearning('no-dir'), ['--data', DATA, '--dir', `${DATA}/materials_v9`]), 'NOT_FOUND')
    })

    // @covers REQ-315#outside-before-missing
    it('学びの外にあり存在もしない教材の世代の置き場を指定すると INVALID_INPUT（契約の errors の順）', async () => {
      expectRefused(await gate(makeLearning('outside-missing'), ['--data', DATA, '--dir', 'w/data/ap/materials_v9']), 'INVALID_INPUT')
    })

    // @covers REQ-315#not-qualification-before-dir-missing
    it('資格対策でなく、指定した教材の世代の置き場も無いときは INVALID_INPUT（契約の errors の順）', async () => {
      const l = makeLearning('notqual-missing')
      brokenLearning(l, 'itc')
      expectRefused(await gate(l, ['--data', 'w/data/itc', '--dir', 'w/data/itc/materials_v9']), 'INVALID_INPUT')
    })
  })

  describe('役割分担後の世代の詳しい解説の表のセルの字数が上限を超えれば、止めずに警告する（REQ-316）', () => {
    const cellTable = (len: number) => table([['項目', '説明'], ['語', 'あ'.repeat(len)]])

    // @covers REQ-316#cell-too-long
    it('セルの字数が上限 + 1 の表を持つ教材を tableCellLong で警告する（止めない）', async () => {
      expectWarned(await gate(withTopic1('cell-41', withTable(cellTable(LIMITS.tableCellLength + 1)))), 'tableCellLong')
    })

    // @covers REQ-316#cell-at-limit
    it('セルの字数が上限ちょうどの表は警告しない', async () => {
      const res = expectPassed(await gate(withTopic1('cell-40', withTable(cellTable(LIMITS.tableCellLength)))))
      expect(kinds(res.warnings)).not.toContain('tableCellLong')
    })

    // @covers REQ-316#before-role-split
    it('役割分担前の世代の教材のセルの字数は警告しない', async () => {
      const res = expectPassed(await gate(withTopic1('cell-v2', withTable(cellTable(LIMITS.tableCellLength + 1)), 'materials_v2')))
      expect(kinds(res.warnings)).not.toContain('tableCellLong')
    })
  })

  describe('資格対策の教材の警告の種類に当たる書き方を、止めずに種類と論点と箇所の警告として挙げる（REQ-324）', () => {
    const cases: Array<[string, string, (m: Material) => void, string?]> = [
      ['source-punctuation', 'sourcePunctuation', (m) => (m.detail = `${m.detail}\n記憶装置は，データを保ちます．`)],
      ['markup-in-plain', 'markupInPlainText', (m) => (m.detail = '記憶装置は**主記憶**を持ちます。')],
      ['notation-outside', 'notationOutside', (m) => (m.detail = `## 大きな見出し\n${m.detail}`)],
      ['unclosed-emphasis', 'unclosedEmphasis', (m) => (m.detail = `${m.detail}\n**閉じない強調です。`)],
      ['explanation-heading', 'explanationHeading', (m) => (m.explanation = `### 説明の見出し\n${m.explanation}`)],
      ['choice-symbol', 'choiceSymbol', (m) => (m.detail = `${m.detail}\n正解はウです。`)],
      [
        'calc-without-formula',
        'calcWithoutFormula',
        (m) => {
          m.explanation = '**記憶装置**とは、容量を計算で求める装置です。\n**キーワード**：容量'
          m.detail = '### しくみ\n容量 = 1 枚の容量 × 枚数 で求めます。'
        },
      ],
      ['indented-line', 'indentedLine', (m) => (m.detail = `${m.detail}\n  - 字下げした項目です`)],
      ['pattern-heading-missing', 'patternHeadingMissing', (m) => (m.detail = '### しくみ\n記憶装置は決められた手順で働きます。'), 'materials_v2'],
      ['pattern-heading-left', 'patternHeadingLeft', (m) => (m.detail = `### 出題のされ方\n働きが問われます。\n\n${m.detail}`)],
      ['keyword-line-missing', 'keywordLineMissing', (m) => (m.explanation = '**記憶装置**とは、データを扱う装置の一つです。')],
      ['solving-hint', 'solvingHint', (m) => (m.detail = `${m.detail}\n選択肢の中から装置の名前で選びます。`)],
      ['first-sentence-not-term', 'firstSentenceNotTerm', (m) => (m.explanation = '装置の一つが記憶装置です。\n**キーワード**：装置')],
      ['plain-list-ending', 'plainListEnding', (m) => (m.detail = `${m.detail}\n- 入力を受け取る。`)],
      ['term-markup-mixed', 'termMarkupMixed', (m) => (m.detail = `${m.detail}\n**主記憶**はデータを保ちます。[[主記憶]]は速く読めます。`)],
    ]
    const run = (name: string) => {
      const [, kind, edit, generation] = cases.find((c) => c[0] === name)!
      return gate(withTopic1(name, edit, generation)).then((r) => expectWarned(r, kind))
    }

    // @covers REQ-324#source-punctuation
    it('本文に「，」か「．」がある教材を sourcePunctuation で警告する（止めない）', () => run('source-punctuation'))
    // @covers REQ-324#markup-in-plain
    it('詳しい解説が見出しを持たない教材の記法（代表は「**」）を markupInPlainText で警告する', () => run('markup-in-plain'))
    // @covers REQ-324#notation-outside
    it('使えない記法（代表は「##」の見出し）を持つ教材を notationOutside で警告する', () => run('notation-outside'))
    // @covers REQ-324#unclosed-emphasis
    it('図の行を除いた本文の「**」の数が奇数の教材を unclosedEmphasis で警告する', () => run('unclosed-emphasis'))
    // @covers REQ-324#explanation-heading
    it('説明に見出しがある教材を explanationHeading で警告する', () => run('explanation-heading'))
    // @covers REQ-324#choice-symbol
    it('「正解」の直後に記号を書いた教材（代表は「正解はウ」）を choiceSymbol で警告する', () => run('choice-symbol'))
    // @covers REQ-324#calc-without-formula
    it('説明が計算に触れて式を持たず、詳しい解説が式を持つ教材を calcWithoutFormula で警告する', () => run('calc-without-formula'))
    // @covers REQ-324#indented-line
    it('詳しい解説に字下げした箇条書きの項目を持つ教材を indentedLine で警告する', () => run('indented-line'))
    // @covers REQ-324#pattern-heading-missing
    it('役割分担前の世代で「出題」を含む見出しが無い教材を patternHeadingMissing で警告する', () => run('pattern-heading-missing'))
    // @covers REQ-324#pattern-heading-left
    it('役割分担後の世代で「出題」を含む見出しが残る教材を patternHeadingLeft で警告する', () => run('pattern-heading-left'))
    // @covers REQ-324#keyword-line-missing
    it('役割分担後の世代で説明にキーワードの行が無い教材を keywordLineMissing で警告する', () => run('keyword-line-missing'))
    // @covers REQ-324#solving-hint
    it('役割分担後の世代で選択肢の消し方の語（代表は「選択肢」）を含む教材を solvingHint で警告する', () => run('solving-hint'))
    // @covers REQ-324#first-sentence-not-term
    it('役割分担後の世代で説明の 1 文目が太字で始まらない教材を firstSentenceNotTerm で警告する', () => run('first-sentence-not-term'))
    // @covers REQ-324#plain-list-ending
    it('役割分担後の世代で常体の「。」で終わる箇条書きの項目を持つ教材を plainListEnding で警告する', () => run('plain-list-ending'))
    // @covers REQ-324#term-markup-mixed
    it('役割分担後の世代で素の太字で書いた語を本文の別の所で [[ ]] にも書いた教材を termMarkupMixed で警告する', () => run('term-markup-mixed'))
  })

  describe('同じ論点の教材が 2 つ以上の世代にあるあいだ、最も後ろの世代の教材だけを確かめる（REQ-409）', () => {
    // @covers REQ-409#latest-generation-checked
    it('後ろの世代の教材の止める理由（論点名の食い違い）を挙げる', async () => {
      const l = makeLearning('latest', { materials: false })
      l.materials('materials_v2', 'bundle_01.json', TOPICS.map((t) => goodV2(t.id)))
      l.materials('materials_v3', '01-1.json', [{ ...goodMaterial(1), term: '後ろの世代の名前' }, goodMaterial(2), goodMaterial(3)])
      expectStopped(await gate(l), 'termMismatch', '1')
    })

    // @covers REQ-409#older-generation-ignored
    it('前の世代にだけある止める理由と警告を挙げない', async () => {
      const l = makeLearning('older', { materials: false })
      l.materials('materials_v2', 'bundle_01.json', [{ ...goodV2(1), term: '前の世代の名前', detail: '### しくみ\n記憶装置は，働きます．' }, goodV2(2), goodV2(3)])
      l.materials('materials_v3', '01-1.json', TOPICS.map((t) => goodMaterial(t.id)))
      expectClean(await gate(l))
    })

    // @covers REQ-409#given-order
    it('世代を指定したときは、指定した並びの最も後ろの世代の教材を確かめる', async () => {
      const l = makeLearning('given', { materials: false })
      l.materials('materials_v2', 'bundle_01.json', [{ ...goodV2(1), term: '指定で後ろの名前' }, goodV2(2), goodV2(3)])
      l.materials('materials_v3', '01-1.json', TOPICS.map((t) => goodMaterial(t.id)))
      const r = await gate(l, ['--data', DATA, '--public', PUBLIC, '--dir', `${DATA}/materials_v3`, `${DATA}/materials_v2`])
      expectStopped(r, 'termMismatch', '1')
    })
  })

  describe('結果を返すとき、人が読む行を変えずに、最後の行に機械向けの 1 行を出す（REQ-655）', () => {
    // @covers REQ-655#line-when-passed
    it('通したときの最後の行が、終了の状態と同じ exitCode 0・見た数・空の止める理由と警告・契約の閾値を持つ', async () => {
      const r = await gate(makeLearning('line-pass'))
      const res = resultOf(r)
      expect(res.exitCode).toBe(r.code)
      expect(res.exitCode).toBe(0)
      expect(res.topics).toBe(TOPICS.length)
      expect(res.stops).toEqual([])
      expect(res.warnings).toEqual([])
      expect(res.limits).toEqual(LIMITS)
    })

    // @covers REQ-655#line-when-stopped
    it('止めたときの最後の行が exitCode 1 と、契約の種類・箇所・理由を持つ止める理由を並べる', async () => {
      const l = makeLearning('line-stop')
      l.materials('materials_v3', '01-2.json', [goodMaterial(99, '学びに無い論点')])
      const r = await gate(l)
      const res = resultOf(r)
      expect(res.exitCode).toBe(r.code)
      expect(res.exitCode).toBe(1)
      expect(res.stops.length).toBeGreaterThan(0)
      for (const f of res.stops) {
        expect(typeof f.kind === 'string' && f.kind.length > 0).toBe(true)
        expect(typeof f.where === 'string' && f.where.length > 0).toBe(true)
        expect(typeof f.reason === 'string' && f.reason.length > 0).toBe(true)
      }
    })

    // @covers REQ-655#all-findings
    it('止める理由と警告が 21 件以上のとき、最後の行がすべてを並べる', async () => {
      const l = makeLearning('line-all')
      l.materials('materials_v3', '01-2.json', Array.from({ length: 22 }, (_, i) => goodMaterial(101 + i, `学びに無い論点${i + 1}`)))
      const res = resultOf(await gate(l))
      expect(findings(res.stops, 'orphanMaterial').length).toBe(22)
    })

    // @covers REQ-655#human-lines-kept
    it('人が読む結果の行は最後の行より前に残り、機械向けの行は最後の 1 行だけ', async () => {
      const l = makeLearning('line-human')
      l.materials('materials_v3', '01-2.json', [goodMaterial(99, '学びに無い論点')])
      const r = await gate(l)
      resultOf(r)
      const machine = r.lines.filter((x) => {
        try {
          return typeof JSON.parse(x).exitCode === 'number'
        } catch {
          return false
        }
      })
      expect(machine.length, '機械向けの行が 1 行でない').toBe(1)
      const at = r.lines.indexOf(machine[0])
      expect(r.lines.slice(0, at).length, '人が読む行が機械向けの行の前に無い').toBeGreaterThan(0)
    })
  })

  describe('教材の無い論点は止める理由にも警告にもせず、教材の無い論点として返す（REQ-656）', () => {
    // @covers REQ-656#missing-returned
    it('教材の無い論点を教材の無い論点としてすべて返し、止めない', async () => {
      const l = makeLearning('missing', { materials: false })
      l.materials('materials_v3', '01-1.json', [goodMaterial(1)])
      const res = expectClean(await gate(l))
      expect([...res.missingTopics].sort((a, b) => a - b)).toEqual([2, 3])
    })

    // @covers REQ-656#none-missing
    it('どの論点にも教材があれば教材の無い論点は空', async () => {
      const res = expectPassed(await gate(makeLearning('none-missing')))
      expect(res.missingTopics).toEqual([])
    })
  })

  describe('同じ世代の中で同じ論点の教材が重なれば、止めずに警告し、最も後の教材を確かめる（REQ-657）', () => {
    // @covers REQ-657#duplicate-warned
    it('同じ世代の 2 つのファイルにある論点を duplicate で警告する（止めない）', async () => {
      const l = makeLearning('dup-files')
      l.materials('materials_v3', '01-2.json', [goodMaterial(1)])
      expectWarned(await gate(l), 'duplicate')
    })

    // @covers REQ-657#duplicate-in-one-file
    it('同じファイルの中に 2 つある論点も duplicate で警告する', async () => {
      const l = makeLearning('dup-one', { materials: false })
      l.materials('materials_v3', '01-1.json', [goodMaterial(1), goodMaterial(2), goodMaterial(3), goodMaterial(1)])
      expectWarned(await gate(l), 'duplicate')
    })

    // @covers REQ-657#later-file-checked
    it('後のファイルの教材の止める理由（論点名の食い違い）を挙げ、前のファイルの教材の止める理由は挙げない', async () => {
      const l = makeLearning('dup-later', { materials: false })
      l.materials('materials_v3', '01-1.json', [{ ...goodMaterial(1), term: '前のファイルの名前' }, goodMaterial(2), goodMaterial(3)])
      l.materials('materials_v3', '01-2.json', [{ ...goodMaterial(1), term: '後のファイルの名前' }])
      const res = expectStopped(await gate(l), 'termMismatch', '後のファイルの名前')
      expect(findings(res.stops, 'termMismatch', '前のファイルの名前')).toEqual([])
    })
  })
})
