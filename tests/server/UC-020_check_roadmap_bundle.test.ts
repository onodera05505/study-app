import { describe, expect, it, vi } from 'vitest'
import {
  BUNDLE,
  DATA,
  LIMITS,
  REGISTRY,
  TERMS,
  check,
  dump,
  findingText,
  findingsOf,
  makeWorkspace,
  materialsFile,
  assignmentFile,
  questionsFile,
  roadmapFile,
  runGate,
  type Json,
  type Run,
} from './UC-020_fixture'

/** UC-020 書き手から上がったロードマップ型の束を教材の門で確かめる（checkRoadmapBundle）の境界。
 *  仕込みは一時の作業場の学びの写し（UC-020_fixture.ts）の上で、束 bundle_01 の教材か確認問題だけを書き換えて作る。
 *  観測するのは終了の状態と、標準出力の最後の行（機械向けの 1 行）か断りの ToolError だけ。人が読む行の文面は契約に無いので見ない。 */

vi.setConfig({ testTimeout: 30_000 })

/** 同じ入力の実行を使い回す（道具を子プロセスで回すので遅い）。 */
function once(f: () => Run): () => Run {
  let r: Run | undefined
  return () => (r ??= f())
}
const cleanRun = once(() => check(makeWorkspace()))

/** 教材を書き換えて門にかける。 */
function withMaterials(edit: (ms: Json[]) => void, data = DATA): Run {
  const ws = makeWorkspace()
  ws.editMaterials(edit, data)
  return check(ws, data)
}
/** 確認問題を書き換えて門にかける。 */
function withQuestions(edit: (qs: Json[]) => void, data = DATA): Run {
  const ws = makeWorkspace()
  ws.editQuestions(edit, data)
  return check(ws, data)
}
const material = (ms: Json[], topicId: number) => ms.find((m) => m.topic_id === topicId)
const question = (qs: Json[], qid: string) => qs.find((q) => q.qid === qid)

/** 論点 n を挙げているか（論点名か論点の番号）。 */
const namesTopic = (f: Json, n: number) => findingText(f).includes(TERMS[n]) || new RegExp(`(^|\\D)${n}(\\D|$)`).test(findingText(f))

/** 標準出力の最後の行が、契約の response の形の機械向けの 1 行であること。 */
function expectMachineLine(r: Run) {
  expect(r.machine, dump(r)).toBeTypeOf('object')
  expect(r.machine, dump(r)).not.toBeNull()
  for (const k of ['exitCode', 'topics', 'questions', 'stops', 'warnings', 'limits']) expect(r.machine, `${k} が無い: ${dump(r)}`).toHaveProperty(k)
  expect(r.machine.exitCode, dump(r)).toBe(r.status)
  expect(r.machine.limits).toEqual(LIMITS)
  for (const f of [...r.machine.stops, ...r.machine.warnings]) {
    expect(typeof f.kind === 'string' && f.kind.length > 0, JSON.stringify(f)).toBe(true)
    expect(typeof f.where === 'string' && f.where.length > 0, JSON.stringify(f)).toBe(true)
    expect(typeof f.reason === 'string' && f.reason.length > 0, JSON.stringify(f)).toBe(true)
  }
}
/** 止めた: 終了の状態 1 で、kind の止める理由のどれかが match に当たる。 */
function expectStop(r: Run, kind: string, match: (f: Json) => boolean) {
  expect(r.status, dump(r)).toBe(1)
  expectMachineLine(r)
  const hits = findingsOf(r.machine.stops, kind)
  expect(hits.length, `${kind} の止める理由が無い: ${dump(r)}`).toBeGreaterThan(0)
  expect(hits.some(match), JSON.stringify(hits)).toBe(true)
}
/** 止めずに警告した: 終了の状態 0、止める理由 0 件で、kind の警告のどれかが match に当たる。 */
function expectWarningOnly(r: Run, kind: string, match: (f: Json) => boolean) {
  expect(r.status, dump(r)).toBe(0)
  expectMachineLine(r)
  expect(r.machine.stops).toEqual([])
  const hits = findingsOf(r.machine.warnings, kind)
  expect(hits.length, `${kind} の警告が無い: ${dump(r)}`).toBeGreaterThan(0)
  expect(hits.some(match), JSON.stringify(hits)).toBe(true)
}
/** 通した: 終了の状態 0、止める理由も警告も無い。 */
function expectCleanPass(r: Run) {
  expect(r.status, dump(r)).toBe(0)
  expectMachineLine(r)
  expect(r.machine.stops).toEqual([])
  expect(r.machine.warnings).toEqual([])
}
/** 断った: 0 でない終了の状態で、断りの名前が code、理由が空でなく、門の結果（機械向けの 1 行）を出していない。 */
function expectRefusal(r: Run, code: string) {
  expect(r.status, dump(r)).not.toBe(0)
  expect(r.code, dump(r)).toBe(code)
  expect(r.reason.length, dump(r)).toBeGreaterThan(0)
  expect(r.machine?.stops, dump(r)).toBeUndefined()
}
/** 場合の名前を付けて失敗を投げ直す。 */
function labelled(label: string, f: () => void) {
  try {
    f()
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`)
  }
}
/** 詳しい解説の「しくみ」の節の末尾に本文を足す。 */
const addToMechanism = (m: Json, text: string) => {
  // 「しくみ」の節の終わり（次の ### の見出しの前。無ければ詳しい解説の末尾）に足す。使い方の見出しの語は学びごとに違うので頼らない
  const start = m.detail.indexOf('### しくみ\n')
  if (start < 0) throw new Error(`仕込み: 詳しい解説に「### しくみ」が無い: ${m.detail}`)
  const next = m.detail.indexOf('\n### ', start + 1)
  const at = next < 0 ? m.detail.length : next
  m.detail = `${m.detail.slice(0, at)}\n${text}${m.detail.slice(at)}`
  if (!m.detail.includes(text)) throw new Error(`仕込み: 本文を書き足せていない: ${text}`)
}
/** n 字のセル（句点を含まない）。 */
const cell = (n: number) => '段ごとに決める事柄と渡す物を書き残す'.repeat(10).slice(0, n)
const row = (cells: string[]) => `| ${cells.join(' | ')} |`
const table = (cols: number, rows: number, width = 4) =>
  [row(Array.from({ length: cols }, (_, i) => `見出し${i + 1}`)), row(Array(cols).fill('---')), ...Array.from({ length: rows - 1 }, () => row(Array(cols).fill(cell(width))))].join('\n')
const withTable = (t: string) => withMaterials((ms) => addToMechanism(material(ms, 1), `\n${t}\n`))

describe('UC-020 書き手から上がったロードマップ型の束を教材の門で確かめる（checkRoadmapBundle）', () => {
  describe('止める理由が無ければ通し、見た数と警告を返す（REQ-361）', () => {
    /** @covers REQ-361#pass-clean */
    it('止める理由も警告も無い束は、終了の状態 0 で通し、見た論点の数 2 と問題の数 4 を返す', () => {
      const r = cleanRun()
      expectCleanPass(r)
      expect(r.machine).toMatchObject({ exitCode: 0, topics: 2, questions: 4 })
    })

    /** @covers REQ-361#pass-with-warnings */
    it('警告だけが当たる束（列が 5 つの表）は通し、警告ごとに種類と論点と箇所を返す', () => {
      const r = withTable(table(5, 2))
      expectWarningOnly(r, 'tableTooWide', (f) => namesTopic(f, 1))
      expect(r.machine).toMatchObject({ topics: 2, questions: 4 })
    })
  })

  describe('登録簿に無い学び・ロードマップ型でない学び・割り当ての無い束は、何も確かめずに断る（REQ-362）', () => {
    /** @covers REQ-362#bad-arguments */
    it('束の名前が無い・知らない名前の引数・値の無い引数は、INVALID_INPUT で断る（場合ごと）', () => {
      const ws = makeWorkspace()
      const cases: [string, string[]][] = [
        ['束の名前が無い', ['--data', DATA]],
        ['知らない名前の引数', ['--data', DATA, '--bundle', BUNDLE, '--unknownArgument', 'x']],
        ['値の無い引数', ['--data', DATA, '--bundle']],
      ]
      for (const [label, args] of cases) labelled(label, () => expectRefusal(runGate(ws, args), 'INVALID_INPUT'))
    })

    /** @covers REQ-362#unknown-learning */
    it('登録簿に無い学び（置き場はあり、束の教材は壊れている）は、INVALID_INPUT で断り、何も確かめない', () => {
      const ws = makeWorkspace()
      ws.write(materialsFile('data/zzz'), '{"bundle": "bundle_01", "materials": [')
      expectRefusal(check(ws, 'data/zzz'), 'INVALID_INPUT')
    })

    /** @covers REQ-362#not-roadmap */
    it('ロードマップ型でない学び（資格対策の ip。置き場はあり、束の教材は壊れている）は、INVALID_INPUT で断り、何も確かめない', () => {
      const ws = makeWorkspace()
      ws.write(materialsFile('data/ip'), '{"bundle": "bundle_01", "materials": [')
      expectRefusal(check(ws, 'data/ip'), 'INVALID_INPUT')
    })

    /** @covers REQ-362#no-assignment */
    it('割り当ての無い束（bundle_99）は、NOT_FOUND で断る', () => {
      expectRefusal(check(makeWorkspace(), DATA, 'bundle_99'), 'NOT_FOUND')
    })

    /** @covers REQ-362#not-roadmap-before-no-assignment */
    it('ロードマップ型でない学びで割り当ても無い束は、INVALID_INPUT で断る', () => {
      expectRefusal(check(makeWorkspace(), 'data/ip', 'bundle_99'), 'INVALID_INPUT')
    })

    /** @covers REQ-362#refusal-exit-status */
    it('断るとき（引数の誤り・登録簿に無い学び・ロードマップ型でない学び・割り当ての無い束）の終了の状態は 2 で、止める理由があるときの 1 と違う（場合ごと）', () => {
      const ws = makeWorkspace()
      const cases: [string, string[]][] = [
        ['引数の誤り', ['--data', DATA]],
        ['登録簿に無い学び', ['--data', 'data/zzz', '--bundle', BUNDLE]],
        ['ロードマップ型でない学び', ['--data', 'data/ip', '--bundle', BUNDLE]],
        ['割り当ての無い束', ['--data', DATA, '--bundle', 'bundle_99']],
      ]
      for (const [label, args] of cases) {
        const r = runGate(ws, args)
        labelled(label, () => expect(r.status, dump(r)).toBe(2))
      }
    })
  })

  describe('情報の量は止める理由にも警告にもしない（REQ-363）', () => {
    /** @covers REQ-363#short-and-few-not-flagged */
    it('説明と詳しい解説が短く、文も見出しも箇条書きも少ない教材は、止めも警告もしない', () => {
      expectCleanPass(cleanRun())
    })

    /** @covers REQ-363#long-and-many-not-flagged */
    it('説明と詳しい解説が長く、文・見出し・箇条書きの項目が多い教材は、止めも警告もしない', () => {
      const sentence = '相談の言葉の奥にある困りごとを、順に確かめていきます。'
      const r = withMaterials((ms) => {
        const m = material(ms, 1)
        m.explanation = m.explanation.replace('見られます。', `見られます。${sentence.repeat(30)}`)
        const extra = Array.from({ length: 10 }, (_, i) => `### 確かめる点${i + 1}\n${sentence.repeat(5)}\n${Array.from({ length: 12 }, (_, j) => `- 確かめる項目${j + 1}です`).join('\n')}`).join('\n')
        m.detail = `${m.detail}\n${extra}`
      })
      expectCleanPass(r)
    })
  })

  describe('表の列・行・セルの字数が表示の制約から外れると、止めずに警告する（REQ-364）', () => {
    /** @covers REQ-364#table-too-narrow */
    it('列が下限に満たない表（1 列）は、止めずに tableTooNarrow で論点と箇所を挙げる', () => {
      expectWarningOnly(withTable(table(LIMITS.tableColumns.min - 1, 2)), 'tableTooNarrow', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-364#table-too-wide */
    it('列が上限を超える表（5 列）は、止めずに tableTooWide で論点と箇所を挙げる', () => {
      expectWarningOnly(withTable(table(LIMITS.tableColumns.max + 1, 2)), 'tableTooWide', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-364#table-too-short */
    it('行が下限に満たない表（見出しの行だけ）は、止めずに tableTooShort で論点と箇所を挙げる', () => {
      expectWarningOnly(withTable(table(2, LIMITS.tableRows.min - 1)), 'tableTooShort', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-364#table-too-long */
    it('行が上限を超える表（見出しを含め 9 行）は、止めずに tableTooLong で論点と箇所を挙げる', () => {
      expectWarningOnly(withTable(table(2, LIMITS.tableRows.max + 1)), 'tableTooLong', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-364#table-cell-long */
    it('セルの字数が上限を超える表（41 字）は、止めずに tableCellLong で論点と箇所を挙げる', () => {
      expectWarningOnly(withTable(table(2, 2, LIMITS.tableCellLength + 1)), 'tableCellLong', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-364#table-at-limits */
    it('列・行・セルの字数がちょうど下限か上限の表（2 列 2 行、4 列 8 行で 40 字のセル）は、警告しない', () => {
      const r = withTable(`${table(LIMITS.tableColumns.min, LIMITS.tableRows.min)}\n\n本文です。\n\n${table(LIMITS.tableColumns.max, LIMITS.tableRows.max, LIMITS.tableCellLength)}`)
      expectCleanPass(r)
    })
  })

  describe('必須の要素が欠けた教材は止める（REQ-365）', () => {
    /** @covers REQ-365#field-missing */
    it('論点名・説明・詳しい解説の欄が無い教材は、missingElement で論点と欠けた欄を挙げて止める（欄ごと）', () => {
      for (const key of ['term', 'explanation', 'detail']) {
        const r = withMaterials((ms) => delete material(ms, 1)[key])
        labelled(key, () => expectStop(r, 'missingElement', (f) => namesTopic(f, 1) && findingText(f).includes(key)))
      }
    })

    /** @covers REQ-365#field-empty */
    it('説明か詳しい解説の欄が空の教材は、missingElement で論点と欠けた欄を挙げて止める（欄ごと）', () => {
      for (const key of ['explanation', 'detail']) {
        const r = withMaterials((ms) => (material(ms, 1)[key] = ''))
        labelled(key, () => expectStop(r, 'missingElement', (f) => namesTopic(f, 1) && findingText(f).includes(key)))
      }
    })

    /** @covers REQ-365#keyword-line-missing */
    it('説明が登録簿の見分けの語（キーワード）の行を欠く教材は、missingElement で論点と見分けの語を挙げて止める', () => {
      const label = REGISTRY.itc.roadmapSpec.keywordLabel as string
      const r = withMaterials((ms) => {
        const m = material(ms, 1)
        m.explanation = m.explanation.split('\n').filter((l: string) => !l.includes(label)).join('\n')
      })
      expectStop(r, 'missingElement', (f) => namesTopic(f, 1) && findingText(f).includes(label))
    })

    /** @covers REQ-365#mechanism-heading-missing */
    it('詳しい解説が「しくみ」の見出しを欠く教材は、missingElement で論点と「しくみ」を挙げて止める', () => {
      const r = withMaterials((ms) => {
        const m = material(ms, 1)
        m.detail = m.detail.replace('### しくみ\n', '')
      })
      expectStop(r, 'missingElement', (f) => namesTopic(f, 1) && findingText(f).includes('しくみ'))
    })
  })

  describe('束の教材のファイルが無い・読めない・割り当てやロードマップと食い違うと止める（REQ-366）', () => {
    /** @covers REQ-366#materials-file-missing */
    it('束の教材のファイルが無いと、unreadableOutput で束を挙げて止める', () => {
      const ws = makeWorkspace()
      ws.remove(materialsFile())
      expectStop(check(ws), 'unreadableOutput', (f) => findingText(f).includes(BUNDLE))
    })

    /** @covers REQ-366#materials-file-unreadable */
    it('書きかけで途切れた・教材の並びを持たない束の教材のファイルは、unreadableOutput で束を挙げて止める（場合ごと）', () => {
      const cases: [string, string][] = [
        ['途中で途切れた JSON（書き手が書いている途中）', '{"bundle": "bundle_01", "materials": ['],
        ['materials が並びでない', JSON.stringify({ bundle: BUNDLE, materials: {} })],
      ]
      for (const [label, body] of cases) {
        const ws = makeWorkspace()
        ws.write(materialsFile(), body)
        const r = check(ws)
        labelled(label, () => expectStop(r, 'unreadableOutput', (f) => findingText(f).includes(BUNDLE)))
      }
    })

    /** @covers REQ-366#assigned-topic-missing */
    it('割り当ての論点（2）の教材が無い束は、bundleMismatch でその論点を挙げて止める', () => {
      const r = withMaterials((ms) => ms.splice(ms.indexOf(material(ms, 2)), 1))
      expectStop(r, 'bundleMismatch', (f) => namesTopic(f, 2))
    })

    /** @covers REQ-366#unassigned-topic-present */
    it('割り当てに無い論点（4。ロードマップにはある）の教材を持つ束は、bundleMismatch でその論点を挙げて止める', () => {
      const r = withMaterials((ms) => {
        const m = JSON.parse(JSON.stringify(material(ms, 2)))
        Object.assign(m, { topic_id: 4, term: TERMS[4] })
        m.explanation = m.explanation.replace(`**${TERMS[2]}**`, `**${TERMS[4]}**`)
        ms.push(m)
      })
      expectStop(r, 'bundleMismatch', (f) => namesTopic(f, 4))
    })

    /** @covers REQ-366#term-differs-from-roadmap */
    it('論点名がロードマップの論点名と違う教材は、termMismatch で論点を挙げて止める', () => {
      const r = withMaterials((ms) => (material(ms, 1).term = '課題の見極め方'))
      expectStop(r, 'termMismatch', (f) => findingText(f).includes('課題の見極め'))
    })

    /** @covers REQ-366#assignment-unreadable */
    it('JSON として読めないか topics の並びを持たない割り当ては、unreadableOutput でそのファイルを挙げて止める（場合ごと）', () => {
      const cases: [string, string][] = [
        ['途中で途切れた JSON', '{"bundle": "bundle_01", "topics": ['],
        ['topics が並びでない', JSON.stringify({ bundle: BUNDLE, topics: {} })],
      ]
      for (const [label, body] of cases) {
        const ws = makeWorkspace()
        ws.write(assignmentFile(), body)
        const r = check(ws)
        labelled(label, () => expectStop(r, 'unreadableOutput', (f) => findingText(f).includes('material_bundles')))
      }
    })

    /** @covers REQ-366#roadmap-unreadable */
    it('JSON として読めないか units の並びを持たないロードマップは、unreadableOutput でそのファイルを挙げて止める（場合ごと）', () => {
      const cases: [string, string][] = [
        ['途中で途切れた JSON', '{"units": ['],
        ['units が並びでない', JSON.stringify({ target: '仕込み', units: {} })],
      ]
      for (const [label, body] of cases) {
        const ws = makeWorkspace()
        ws.write(roadmapFile(), body)
        const r = check(ws)
        labelled(label, () => expectStop(r, 'unreadableOutput', (f) => findingText(f).includes('roadmap')))
      }
    })
  })

  describe('崩れた表と、決めた階層の外の見出しは止める（REQ-367）', () => {
    /** @covers REQ-367#table-without-separator */
    it('区切りの行が無い表は、brokenTable で論点と箇所を挙げて止める', () => {
      expectStop(withTable(`${row(['段', '決める事柄'])}\n${row(['決める段', '何を作るか'])}`), 'brokenTable', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-367#table-ragged-cells */
    it('行ごとのセルの数がそろわない表は、brokenTable で論点と箇所を挙げて止める', () => {
      expectStop(withTable(`${row(['段', '決める事柄'])}\n${row(['---', '---'])}\n${row(['決める段', '何を作るか', '余りのセル'])}`), 'brokenTable', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-367#heading-outside-level */
    it('詳しい解説に契約の階層（###）の外の見出し（## か ####）があると、headingLevel で論点と見出しを挙げて止める（場合ごと）', () => {
      for (const mark of ['##', '####']) {
        const r = withMaterials((ms) => addToMechanism(material(ms, 1), `${mark} 細かい点\n細かい点を確かめます。`))
        labelled(mark, () => expectStop(r, 'headingLevel', (f) => namesTopic(f, 1) && findingText(f).includes('細かい点')))
      }
    })
  })

  describe('出典の名前が形に当たらないか、集めた資料と集計の名前に無いと止める（REQ-368）', () => {
    /** @covers REQ-368#unknown-source */
    it('集めた資料に無い名前の出典は、unknownSource で論点と出典を挙げて止める', () => {
      const r = withMaterials((ms) => (material(ms, 1).sources = [{ name: '架空の資料の手引き', where: '進め方の章' }]))
      expectStop(r, 'unknownSource', (f) => namesTopic(f, 1) && findingText(f).includes('架空の資料の手引き'))
    })

    /** @covers REQ-368#source-not-in-shape */
    it('出典の形に当たらない名前（「一般常識」）は、unknownSource で論点と出典を挙げて止める', () => {
      const r = withMaterials((ms) => (material(ms, 1).sources = [{ name: '一般常識', where: '進め方の章' }]))
      expectStop(r, 'unknownSource', (f) => namesTopic(f, 1) && findingText(f).includes('一般常識'))
    })

    /** @covers REQ-368#tally-name-accepted */
    it('集計の名前（「選考解説記事の集計」）の出典は止めない', () => {
      const r = withMaterials((ms) => material(ms, 1).sources.push({ name: '選考解説記事の集計', where: '志望の理由' }))
      expect(r.status, dump(r)).toBe(0)
      expectMachineLine(r)
      expect(findingsOf(r.machine.stops, 'unknownSource')).toEqual([])
    })
  })

  describe('用語として示した語がロードマップの論点名に無いと止める（REQ-369）', () => {
    /** @covers REQ-369#unresolved-term */
    it('ロードマップに無い語を [[ ]] で示した教材は、unresolvedTerm で論点と語を挙げて止める', () => {
      const r = withMaterials((ms) => addToMechanism(material(ms, 1), '比べる相手は[[架空の段取り表]]です。'))
      expectStop(r, 'unresolvedTerm', (f) => namesTopic(f, 1) && findingText(f).includes('架空の段取り表'))
    })

    /** @covers REQ-369#roadmap-term-outside-bundle */
    it('束の外にあるロードマップの論点名（提案の組み立て）を [[ ]] で示した教材は止めない', () => {
      const r = withMaterials((ms) => addToMechanism(material(ms, 1), `比べる相手は[[${TERMS[3]}]]です。`))
      expect(r.status, dump(r)).toBe(0)
      expectMachineLine(r)
      expect(r.machine.stops).toEqual([])
    })
  })

  describe('登録簿が禁じた書き方が教材か確認問題の正解の側にあると止める（REQ-370）', () => {
    const MSG = 'data/msg'
    const banned = Object.entries(REGISTRY.msg.roadmapSpec.bannedPatterns as Record<string, string>).find(([re]) => re.includes('体重'))!
    const bannedReason = banned[1]

    /** @covers REQ-370#banned-in-material */
    it('教材の本文に禁じた書き方（体重をかける指示）がある束は、bannedPattern で論点と箇所と禁じた理由を挙げて止める', () => {
      const r = withMaterials((ms) => addToMechanism(material(ms, 1), '体重をかけて押します。'), MSG)
      expectStop(r, 'bannedPattern', (f) => namesTopic(f, 1) && findingText(f).includes(bannedReason))
    })

    /** @covers REQ-370#banned-in-correct-choice */
    it('確認問題の正解の選択肢に禁じた書き方がある束は、bannedPattern で問題と箇所と禁じた理由を挙げて止める', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choices['ア'] = '体重をかけて押しながら、売上が落ちた理由を店長と一緒にたどる'), MSG)
      expectStop(r, 'bannedPattern', (f) => findingText(f).includes('t1-1') && findingText(f).includes(bannedReason))
    })

    /** @covers REQ-370#banned-only-in-wrong-choice */
    it('禁じた書き方が確認問題の誤答の選択肢にだけある束は、bannedPattern で止めない', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choices['イ'] = '体重をかけて押しながら、広告の案をいくつも作って安い順に渡す'), MSG)
      expectMachineLine(r)
      expect(findingsOf(r.machine.stops, 'bannedPattern'), dump(r)).toEqual([])
    })
  })

  describe('確認問題のファイルが読めないか、確認問題の形を満たさないと止める（REQ-371）', () => {
    /** @covers REQ-371#questions-file-unreadable */
    it('途中で途切れた確認問題のファイルは、unreadableOutput でそのファイルを挙げて止める', () => {
      const ws = makeWorkspace()
      ws.write(questionsFile(), '{"bundle": "bundle_01", "questions": [')
      expectStop(check(ws), 'unreadableOutput', (f) => findingText(f).includes(BUNDLE) || findingText(f).includes('roadmap_questions'))
    })

    /** @covers REQ-371#question-field-missing */
    it('必須の欄を欠く確認問題は、questionShape で問題を挙げて止める（欄ごと）', () => {
      for (const key of ['topic_id', 'term', 'stem', 'choices', 'answer', 'reason', 'choice_notes', 'tests_goal']) {
        const r = withQuestions((qs) => delete question(qs, 't1-1')[key])
        labelled(key, () => expectStop(r, 'questionShape', (f) => findingText(f).includes('t1-1')))
      }
    })

    /** @covers REQ-371#question-field-empty */
    it('問題文か解説の理由が空の確認問題は、questionShape で問題を挙げて止める（欄ごと）', () => {
      for (const key of ['stem', 'reason']) {
        const r = withQuestions((qs) => (question(qs, 't1-1')[key] = ''))
        labelled(key, () => expectStop(r, 'questionShape', (f) => findingText(f).includes('t1-1')))
      }
    })

    /** @covers REQ-371#choices-not-four */
    it('選択肢がア〜エの 4 つでない確認問題（エが無い・オがある）は、questionShape で問題を挙げて止める（場合ごと）', () => {
      const cases: [string, (q: Json) => void][] = [
        ['エが無い', (q) => delete q.choices['エ']],
        ['オがある', (q) => (q.choices['オ'] = '段ごとに決める事柄を相手と話し合って書き残す')],
      ]
      for (const [label, edit] of cases) {
        const r = withQuestions((qs) => edit(question(qs, 't1-1')))
        labelled(label, () => expectStop(r, 'questionShape', (f) => findingText(f).includes('t1-1')))
      }
    })

    /** @covers REQ-371#answer-not-a-choice */
    it('正解がア〜エのどれでもない確認問題は、questionShape で問題を挙げて止める', () => {
      expectStop(withQuestions((qs) => (question(qs, 't1-1').answer = 'オ')), 'questionShape', (f) => findingText(f).includes('t1-1'))
    })

    /** @covers REQ-371#correct-note-unmarked */
    it('正解の説明が「正解」で始まらない確認問題は、questionShape で問題を挙げて止める', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choice_notes['ア'] = '理由をたどってから打つ手を選んでいます。'))
      expectStop(r, 'questionShape', (f) => findingText(f).includes('t1-1'))
    })

    /** @covers REQ-371#wrong-note-marked */
    it('誤答の説明が「正解。」の印で始まる確認問題は、questionShape で問題を挙げて止める', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choice_notes['イ'] = '正解。希望をそのまま形にしています。'))
      expectStop(r, 'questionShape', (f) => findingText(f).includes('t1-1'))
    })

    /** @covers REQ-371#wrong-note-starts-with-word */
    it('誤答の説明が印でなく文として「正解」で始まる（「正解の動かし方を…」）確認問題は、questionShape で止めない', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choice_notes['イ'] = '正解の動かし方を取り違えていて、本当の問題かを確かめていません。'))
      expectMachineLine(r)
      expect(findingsOf(r.machine.stops, 'questionShape'), dump(r)).toEqual([])
    })

    /** @covers REQ-371#unknown-goal */
    it('測る到達基準の番号（99）がその学びの到達基準に無い確認問題は、unknownGoal で問題を挙げて止める', () => {
      expectStop(withQuestions((qs) => (question(qs, 't1-1').tests_goal = 99)), 'unknownGoal', (f) => findingText(f).includes('t1-1'))
    })

    /** @covers REQ-371#goal-of-another-unit */
    it('測る到達基準の番号がその学びの別の単位の到達基準（2）なら、unknownGoal で止めない', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').tests_goal = 2))
      expectMachineLine(r)
      expect(findingsOf(r.machine.stops, 'unknownGoal'), dump(r)).toEqual([])
    })
  })

  describe('書き方がロードマップ型の教材の警告に当たると、止めずに警告する（REQ-372）', () => {
    /** @covers REQ-372#avoid-word */
    it('登録簿の避ける語（年収）を含む教材は、止めずに avoidWord で論点と箇所を挙げる', () => {
      const r = withMaterials((ms) => addToMechanism(material(ms, 1), '年収の話はここでは扱いません。'))
      expectWarningOnly(r, 'avoidWord', (f) => namesTopic(f, 1))
    })

    /** @covers REQ-372#usage-section-missing */
    it('詳しい解説に登録簿の使い方の見出し（面接で話すなら）が無い教材は、止めずに usageSectionMissing で論点を挙げる', () => {
      const r = withMaterials((ms) => {
        const m = material(ms, 2)
        m.detail = m.detail.split('\n### 面接で話すなら')[0]
      })
      expectWarningOnly(r, 'usageSectionMissing', (f) => namesTopic(f, 2))
    })
  })

  describe('確認問題の正解の選択肢が教材の本文と長く一致すると、止めずに警告する（REQ-373）', () => {
    /** @covers REQ-373#verbatim-at-threshold */
    it('正解の選択肢が教材の本文と 14 字続けて一致する問題は、止めずに verbatimBody でその問題を挙げる', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choices['ア'] = '困りごとの原因をたどると、別の所に目を向けて理由を探す'))
      expectWarningOnly(r, 'verbatimBody', (f) => findingText(f).includes('t1-1'))
    })

    /** @covers REQ-373#verbatim-below-threshold */
    it('正解の選択肢と教材の本文の一致が 13 字までの問題は、verbatimBody で挙げない', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choices['ア'] = '困りごとの原因をたどると、店の外に目を向けて理由を探す'))
      expectMachineLine(r)
      expect(findingsOf(r.machine.warnings, 'verbatimBody'), dump(r)).toEqual([])
    })

    /** @covers REQ-373#verbatim-in-wrong-choice */
    it('誤答の選択肢だけが教材の本文と長く一致する問題は、verbatimBody で挙げない', () => {
      const r = withQuestions((qs) => (question(qs, 't1-1').choices['イ'] = '困りごとの原因をたどると、別の所に手を打つ方が早い場合があると考える'))
      expectMachineLine(r)
      expect(findingsOf(r.machine.warnings, 'verbatimBody'), dump(r)).toEqual([])
    })
  })

  describe('集めた資料のファイルが読めないあいだは、そのファイルを飛ばす（REQ-659）', () => {
    const BROKEN = `${DATA}/sources/broken.json`
    const brokenRun = once(() => {
      const ws = makeWorkspace()
      ws.write(BROKEN, '{"sources": [{"name": "壊れた資料の手引き"}')
      return check(ws)
    })

    /** @covers REQ-659#unreadable-source-skipped */
    it('JSON として読めない資料のファイルがあっても、止めも警告もせず、人が読む注の行を 1 行足す', () => {
      const r = brokenRun()
      expectCleanPass(r)
      expect(r.humanLines.length, `${dump(r)}\n--- 読めるときの出力 ---\n${dump(cleanRun())}`).toBe(cleanRun().humanLines.length + 1)
    })

    /** @covers REQ-659#other-sources-used */
    it('読めるほうの資料のファイルの名前（仕事の進め方の手引き）の出典は止めない', () => {
      const r = brokenRun()
      expectMachineLine(r)
      expect(findingsOf(r.machine.stops, 'unknownSource'), dump(r)).toEqual([])
    })

    /** @covers REQ-659#skipped-names-unknown */
    it('読めないファイルにしか無い名前の出典は、unknownSource で論点と出典を挙げて止める', () => {
      const ws = makeWorkspace()
      ws.write(BROKEN, '{"sources": [{"name": "壊れた資料の手引き"}')
      ws.editMaterials((ms) => material(ms, 1).sources.push({ name: '壊れた資料の手引き', where: '進め方の章' }))
      expectStop(check(ws), 'unknownSource', (f) => namesTopic(f, 1) && findingText(f).includes('壊れた資料の手引き'))
    })
  })

  describe('束の確認問題のファイルが無いあいだは、確認問題を見ない（REQ-660）', () => {
    /** @covers REQ-660#questions-file-absent */
    it('確認問題のファイルが無く教材に止める理由の無い束は、終了の状態 0 で通し、見た問題の数 0 を返す', () => {
      const ws = makeWorkspace()
      ws.remove(questionsFile())
      const r = check(ws)
      expectCleanPass(r)
      expect(r.machine).toMatchObject({ exitCode: 0, topics: 2, questions: 0 })
    })
  })

  describe('門が結果を返すとき、標準出力の最後の行に機械向けの 1 行を出す（REQ-594）', () => {
    /** @covers REQ-594#machine-line-on-pass */
    it('通すとき、最後の行は終了の状態と同じ exitCode 0・見た論点と問題の数・空の止める理由と警告・門が使った値を持つ 1 行の JSON', () => {
      const r = cleanRun()
      expect(r.status, dump(r)).toBe(0)
      expectMachineLine(r)
      expect(r.machine).toEqual({ exitCode: 0, topics: 2, questions: 4, stops: [], warnings: [], limits: LIMITS })
    })

    /** @covers REQ-594#machine-line-on-stop */
    it('止めるとき、最後の行は終了の状態と同じ exitCode 1 と、止める理由と警告のそれぞれの種類と箇所を並べた 1 行の JSON', () => {
      const r = withMaterials((ms) => {
        addToMechanism(material(ms, 1), '比べる相手は[[架空の段取り表]]です。')
        addToMechanism(material(ms, 2), '年収の話はここでは扱いません。')
      })
      expect(r.status, dump(r)).toBe(1)
      expectMachineLine(r)
      expect(r.machine).toMatchObject({ exitCode: 1, topics: 2, questions: 4 })
      expect(findingsOf(r.machine.stops, 'unresolvedTerm').length, dump(r)).toBeGreaterThan(0)
      expect(findingsOf(r.machine.warnings, 'avoidWord').length, dump(r)).toBeGreaterThan(0)
    })

    /** @covers REQ-594#human-lines-before-machine-line */
    it('機械向けの 1 行の前に人が読む結果の行があり、機械向けの形は最後の 1 行だけ', () => {
      const r = cleanRun()
      expectMachineLine(r)
      expect(r.humanLines.length, dump(r)).toBeGreaterThan(0)
      for (const line of r.humanLines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          parsed = undefined
        }
        expect(parsed !== null && typeof parsed === 'object' && 'exitCode' in (parsed as object), line).toBe(false)
      }
    })
  })
})

