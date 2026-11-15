import { describe, expect, it, vi } from 'vitest'
import { DATA, TOPICLESS_UNIT, UNKNOWN_TOPIC, check, expectToolError, findingText, findingsOf, makeWorkspace, plan21, plan22, planFile, planName, type Json, type Run, type Workspace } from './unit_plan_fixture'

/** UC-024 資格対策の単元の構成を教材の門にかける入口（checkUnitPlans ＝ `python3 scripts/check_unit_plans.py --data <学びの置き場>`）の境界。
 *  仕込みは一時の作業場の学びの写し（unit_plan_fixture.ts）の上で、単元 21 か 22 の単元の構成だけを書き換えて作る。
 *  観測するのは終了コードと標準出力の JSON だけ。指摘の where のまとまりは「まとまり n」（学ぶ順の 1 始まり）。 */

vi.setConfig({ testTimeout: 30_000 })

const LIMITS = { groupTopicsMax: 8, groupTopicsMinWarn: 3, prerequisitesMax: 2 }

/** 単元 21 の構成を書き換えて門にかける。 */
function check21(edit: (p: Json) => void, ws: Workspace = makeWorkspace()): Run {
  const p = plan21()
  edit(p)
  ws.write(planFile(21), p)
  return check(ws)
}
/** 単元 22 の構成を書き換えて門にかける。 */
function check22(edit: (p: Json) => void, ws: Workspace = makeWorkspace()): Run {
  const p = plan22()
  edit(p)
  ws.write(planFile(22), p)
  return check(ws)
}
/** 止めた応答で、kind の止める理由が file を挙げ、needles をどれも挙げていること。 */
function expectStop(r: Run, kind: string, file: string, ...needles: (string | number)[]) {
  expect(r.status).toBe(1)
  expect(r.json?.exitCode).toBe(1)
  const hits = findingsOf(r.json?.stops, kind)
  expect(hits.length, `${kind} の止める理由が無い: ${r.stdout}${r.stderr}`).toBeGreaterThan(0)
  expect(hits.some((f) => String(f.where).includes(file) && needles.every((n) => findingText(f).includes(String(n)))), JSON.stringify(hits)).toBe(true)
  for (const f of r.json.stops) {
    expect(typeof f.where === 'string' && f.where.length > 0).toBe(true)
    expect(typeof f.reason === 'string' && f.reason.length > 0).toBe(true)
  }
}
/** 受け持ちの止める理由が、単元のファイルと受け持ち（説明の名前か owners の箇所）を挙げていること。 */
function expectOwnerStop(r: Run, kind: string) {
  expectStop(r, kind, planName(21))
  const hits = findingsOf(r.json.stops, kind)
  expect(hits.some((f) => findingText(f).includes('共通の説明') || String(f.where).includes('owners')), JSON.stringify(hits)).toBe(true)
}
/** 場合の名前を付けて失敗を投げ直す。 */
function labelled(label: string, f: () => void) {
  try {
    f()
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`)
  }
}
/** 指摘の一覧に kind の物が無いこと。 */
const noneOf = (r: Run, kind: string) => expect(findingsOf(r.json?.stops, kind), r.stdout).toEqual([])
/** 単元を指す側の止める理由が付く単元の構成（中身は単元 22 の論点）を、場合ごとに置いて門にかける。
 *  各場合は [場合の名前, 置くファイルの単元の番号, 止める理由の種類, 単元の番号と名前の書き換え]。 */
const IDENTITY_STOPS: [string, number, string, (p: Json) => void][] = [
  ['単元の番号がファイル名と食い違う', 22, 'unitNoMismatch', (p) => Object.assign(p, { unit_no: 23, unit: '単元二十三' })],
  ['単元の名前がシラバスと食い違う', 22, 'unitNameMismatch', (p) => (p.unit = '単元二十一')],
  ['シラバスに無い単元を指す', 99, 'unknownUnit', (p) => Object.assign(p, { unit_no: 99, unit: '無い単元' })],
]
function checkWithIdentityStop(fileUnit: number, identity: (p: Json) => void, groups: Json[]): Run {
  const ws = makeWorkspace()
  ws.remove(planFile(22))
  const p = plan22()
  identity(p)
  p.groups = groups
  ws.write(planFile(fileUnit), p)
  return check(ws)
}

describe('UC-024 資格対策の単元の構成を教材の門で確かめる（checkUnitPlans）', () => {
  describe('止める理由が無ければ通し、見た数と警告を返す（REQ-442）', () => {
    /** @covers REQ-442#pass-clean */
    it('止める理由も警告も無い単元の構成だけなら、終了コード 0 で通し、見た単元の構成の数・論点の数・門が使った値を返す', () => {
      const r = check(makeWorkspace())
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.json).toMatchObject({ exitCode: 0, units: 2, topics: 15, stops: [], warnings: [], limits: LIMITS })
    })

    /** @covers REQ-442#pass-with-warnings */
    it('警告だけが当たる単元の構成は通し、警告ごとに種類と単元のファイルと箇所を返す', () => {
      const r = check21((p) => {
        p.groups = [
          { name: '土台', description: '土台の説明です。', topics: [112, 103] },
          { name: '応用', description: '応用の説明です。', topics: [109, 105, 114, 107] },
        ]
      })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.json?.exitCode).toBe(0)
      expect(r.json?.stops).toEqual([])
      expect(r.json?.warnings.length).toBe(1)
      const [w] = r.json.warnings
      expect(w.kind).toBe('groupTooSmall')
      expect(String(w.where)).toContain(planName(21))
      expect(String(w.where)).toContain('まとまり 1')
      expect(typeof w.reason === 'string' && w.reason.length > 0).toBe(true)
    })
  })

  describe('登録簿に無い学び・資格対策でない学び・シラバスか論点の一覧が無いか読めない学びは断る（REQ-443）', () => {
    /** @covers REQ-443#unknown-learning */
    it('登録簿に無い学び（置き場はあり、単元の構成は壊れている）は、終了コード 2 の ToolError（INVALID_INPUT）だけを返し、何も確かめない', () => {
      const ws = makeWorkspace()
      ws.write(planFile(21, 'data/zzz'), '{"unit_no": 21,')
      expectToolError(check(ws, 'data/zzz'), 'INVALID_INPUT', expect)
    })

    /** @covers REQ-443#not-qualification */
    it('資格対策でない学び（ロードマップ型の itc。置き場はあり、単元の構成は壊れている）は、終了コード 2 の ToolError（INVALID_INPUT）だけを返し、何も確かめない', () => {
      const ws = makeWorkspace()
      ws.write(planFile(21, 'data/itc'), '{"unit_no": 21,')
      expectToolError(check(ws, 'data/itc'), 'INVALID_INPUT', expect)
    })

    /** @covers REQ-443#learning-file-missing */
    it('シラバスか論点の一覧が無い学びは、終了コード 2 の ToolError（NOT_FOUND）で断る（場合ごと）', () => {
      for (const file of ['syllabus.json', 'topics.json']) {
        const ws = makeWorkspace()
        ws.write(planFile(21), '{"unit_no": 21,')
        ws.remove(`${DATA}/${file}`)
        labelled(file, () => expectToolError(check(ws), 'NOT_FOUND', expect))
      }
    })

    /** @covers REQ-443#learning-file-unreadable */
    it('シラバスか論点の一覧が JSON として読めない学びは、終了コード 2 の ToolError（INVALID_INPUT）で断る（場合ごと）', () => {
      for (const file of ['syllabus.json', 'topics.json']) {
        const ws = makeWorkspace()
        ws.write(`${DATA}/${file}`, '{"items": [')
        labelled(file, () => expectToolError(check(ws), 'INVALID_INPUT', expect))
      }
    })

    /** @covers REQ-443#registry-before-files */
    it('資格対策でない学びでシラバスも無ければ、INVALID_INPUT で断る', () => {
      const ws = makeWorkspace()
      ws.remove('data/itc/syllabus.json')
      expectToolError(check(ws, 'data/itc'), 'INVALID_INPUT', expect)
    })

    /** @covers REQ-443#missing-before-unreadable */
    it('シラバスが無く論点の一覧も読めなければ、NOT_FOUND で断る', () => {
      const ws = makeWorkspace()
      ws.remove(`${DATA}/syllabus.json`)
      ws.write(`${DATA}/topics.json`, '{"topics": [')
      expectToolError(check(ws), 'NOT_FOUND', expect)
    })
  })

  describe('読めない・欠けた・食い違う単元の構成のファイルは止める（REQ-444）', () => {
    /** @covers REQ-444#unreadable-partial */
    it('書いている途中で途切れた JSON のファイルは、そのファイルを挙げて unreadablePlan で止め、他の単元の構成は確かめ続ける', () => {
      const ws = makeWorkspace()
      ws.write(planFile(21), JSON.stringify(plan21(), null, 2).slice(0, 120))
      const p = plan22()
      p.groups[0].name = p.groups[1].name
      ws.write(planFile(22), p)
      const r = check(ws)
      expectStop(r, 'unreadablePlan', planName(21))
      expectStop(r, 'duplicateGroupName', planName(22))
    })

    /** @covers REQ-444#not-plan-shape */
    it('JSON として読めても欄の型が契約と合わないファイルは、そのファイルを挙げて unreadablePlan で止める（場合ごと）', () => {
      for (const [label, make] of <[string, () => unknown][]>[
        ['最上位が配列', () => [plan21()]],
        ['まとまりが配列でない', () => ({ ...plan21(), groups: 'まとまり' })],
        ['まとまりが文字列', () => ({ ...plan21(), groups: ['まとまり'] })],
        ['まとまりの論点に整数でない値', () => ({ ...plan21(), groups: [{ ...plan21().groups[0], topics: ['112', 103, 109] }, plan21().groups[1]] })],
      ]) {
        const ws = makeWorkspace()
        ws.write(planFile(21), make() as Json)
        labelled(label, () => expectStop(check(ws), 'unreadablePlan', planName(21)))
      }
    })

    /** @covers REQ-444#unknown-field-unreadable */
    it('契約に無い欄を持つファイルは、そのファイルを挙げて unreadablePlan で止める（場合ごと）', () => {
      for (const [label, edit] of <[string, (p: Json) => unknown][]>[
        ['最上位に契約に無い欄', (p: Json) => (p.extra = 1)],
        ['まとまりに契約に無い欄', (p: Json) => (p.groups[1].memo = '覚え書き')],
        ['受け持ちに契約に無い欄', (p: Json) => (p.owners[0].memo = '覚え書き')],
      ]) {
        labelled(label, () => expectStop(check21((p) => void edit(p)), 'unreadablePlan', planName(21)))
      }
    })

    /** @covers REQ-444#unreadable-skips-content */
    it('読めないファイルは、欠け・上限超え・下限未満・名前の重なり・前提の食い違いを持っていても、そのファイルについて読めない理由 1 件だけを挙げ、警告も挙げない（場合ごと）', () => {
      /** 読めることにすれば、欠け・上限超え・下限未満・名前の重なり・他の単元の論点・前提が後ろ に当たる中身。 */
      const faulty = (): Json => {
        const p = plan21()
        delete p.overview
        p.groups = [
          { name: '土台', description: '土台の説明です。', topics: [112, 103] },
          { name: '土台', description: '応用の説明です。', topics: [105, 114, 107, 109, 220, 221, 222, 223, 224] },
        ]
        p.prerequisites['103'] = [107]
        return p
      }
      for (const [label, edit] of <[string, (p: Json) => unknown][]>[
        ['欄の型が合わない', (p: Json) => (p.groups[0].topics = ['112', 103])],
        ['契約に無い欄', (p: Json) => (p.extra = 1)],
      ]) {
        const ws = makeWorkspace()
        const p = faulty()
        edit(p)
        ws.write(planFile(21), p)
        const r = check(ws)
        labelled(label, () => {
          expectStop(r, 'unreadablePlan', planName(21))
          expect(r.json.stops, r.stdout).toHaveLength(1)
          expect(r.json.warnings, r.stdout).toEqual([])
        })
      }
    })

    /** @covers REQ-444#missing-overview */
    it('全体像が欠けるファイルは、そのファイルを挙げて missingElement で止める（場合ごと）', () => {
      for (const [label, edit] of <[string, (p: Json) => unknown][]>[
        ['欄が無い', (p: Json) => delete p.overview],
        ['空の文字列', (p: Json) => (p.overview = '')],
      ]) {
        labelled(label, () => expectStop(check21((p) => void edit(p)), 'missingElement', planName(21)))
      }
    })

    /** @covers REQ-444#missing-group-element */
    it('まとまりの要素が欠けるファイルは、そのファイルを挙げて missingElement で止める（場合ごと）', () => {
      for (const [label, edit] of <[string, (p: Json) => unknown][]>[
        ['まとまりの名前が無い', (p: Json) => delete p.groups[1].name],
        ['まとまりの名前が空', (p: Json) => (p.groups[1].name = '')],
        ['まとまりの説明が無い', (p: Json) => delete p.groups[1].description],
        ['まとまりの説明が空', (p: Json) => (p.groups[1].description = '')],
        ['まとまりの論点の並びが無い', (p: Json) => delete p.groups[1].topics],
        ['まとまりの論点の並びが空', (p: Json) => (p.groups[1].topics = [])],
        ['まとまりが 1 つも無い', (p: Json) => (p.groups = [])],
      ]) {
        labelled(label, () => expectStop(check21((p) => void edit(p)), 'missingElement', planName(21)))
      }
    })

    /** @covers REQ-444#missing-unit-identity */
    it('単元の番号か名前が欠けるファイルは、そのファイルを挙げて missingElement で止める（場合ごと）', () => {
      for (const [label, edit] of <[string, (p: Json) => unknown][]>[
        ['単元の番号が無い', (p: Json) => delete p.unit_no],
        ['単元の名前が無い', (p: Json) => delete p.unit],
        ['単元の名前が空', (p: Json) => (p.unit = '')],
      ]) {
        labelled(label, () => expectStop(check21((p) => void edit(p)), 'missingElement', planName(21)))
      }
    })

    /** @covers REQ-444#missing-owners */
    it('受け持ちの欄が無いファイルは、そのファイルを挙げて missingElement で止める', () => {
      expectStop(check21((p) => delete p.owners), 'missingElement', planName(21))
    })

    /** @covers REQ-444#unit-no-mismatch */
    it('単元の番号がファイル名の番号と食い違うファイルは、そのファイルを挙げて unitNoMismatch で止める', () => {
      const ws = makeWorkspace()
      ws.remove(planFile(22))
      ws.write(planFile(22), plan21())
      expectStop(check(ws), 'unitNoMismatch', planName(22))
    })

    /** @covers REQ-444#unknown-unit */
    it('シラバスに無い単元を指すファイルは、そのファイルを挙げて unknownUnit で止める', () => {
      const ws = makeWorkspace()
      ws.write(planFile(99), { ...plan21(), unit_no: 99, unit: '無い単元' })
      expectStop(check(ws), 'unknownUnit', planName(99))
    })

    /** @covers REQ-444#unit-name-mismatch */
    it('単元の名前がシラバスのその番号の単元の名前と食い違うファイルは、そのファイルを挙げて unitNameMismatch で止める', () => {
      expectStop(check21((p) => (p.unit = '単元二十二')), 'unitNameMismatch', planName(21))
    })

    /** @covers REQ-444#duplicate-group-name */
    it('同じ単元にまとまりの名前が重なるファイルは、そのファイルと名前を挙げて duplicateGroupName で止める', () => {
      expectStop(check21((p) => (p.groups[1].name = '土台')), 'duplicateGroupName', planName(21))
    })

    /** @covers REQ-444#mismatch-kept-with-missing-groups */
    it('まとまりの欄が無いうえに単元の番号がファイル名と食い違うファイルは、そのファイルを挙げて missingElement と unitNoMismatch の両方で止める', () => {
      const ws = makeWorkspace()
      const p = plan22()
      delete p.groups
      Object.assign(p, { unit_no: 23, unit: '単元二十三' })
      ws.write(planFile(22), p)
      const r = check(ws)
      expectStop(r, 'missingElement', planName(22))
      expectStop(r, 'unitNoMismatch', planName(22))
    })
  })

  describe('単元の論点がちょうど 1 つのまとまりに入らなければ止める（REQ-445）', () => {
    /** @covers REQ-445#topic-not-grouped */
    it('どのまとまりにも入っていない単元の論点は、その単元と論点を挙げて topicNotGrouped で止める', () => {
      expectStop(check21((p) => (p.groups[1].topics = [105, 107])), 'topicNotGrouped', planName(21), 114)
    })

    /** @covers REQ-445#topic-in-many-groups */
    it('2 つのまとまりに入る論点は、その単元と論点を挙げて topicInManyGroups で止める', () => {
      expectStop(check21((p) => (p.groups[1].topics = [105, 114, 107, 103])), 'topicInManyGroups', planName(21), 103)
    })

    /** @covers REQ-445#topic-repeated-in-group */
    it('同じまとまりに 2 回並ぶ論点は、その単元と論点を挙げて topicRepeatedInGroup で止める', () => {
      expectStop(check21((p) => (p.groups[1].topics = [105, 114, 107, 114])), 'topicRepeatedInGroup', planName(21), 114)
    })

    /** @covers REQ-445#foreign-topic */
    it('他の単元の論点がまとまりにあれば、その単元と論点を挙げて foreignTopic で止める', () => {
      expectStop(check21((p) => p.groups[1].topics.push(330)), 'foreignTopic', planName(21), 330)
    })

    /** @covers REQ-445#unknown-topic */
    it('学びに無い論点がまとまりにあれば、その単元と論点を挙げて unknownTopic で止める', () => {
      expectStop(check21((p) => p.groups[1].topics.push(UNKNOWN_TOPIC)), 'unknownTopic', planName(21), UNKNOWN_TOPIC)
    })
  })

  describe('まとまりの論点の数が上限を超えれば止める（REQ-446）', () => {
    /** @covers REQ-446#over-max */
    it('論点が 9 のまとまりは、その単元とまとまりを挙げて groupTooLarge で止める', () => {
      const r = check22((p) => (p.groups = [{ name: '全部', description: '全部の説明です。', topics: [220, 221, 222, 223, 224, 225, 226, 227, 228] }]))
      expectStop(r, 'groupTooLarge', planName(22), 'まとまり 1')
      expect(findingsOf(r.json.stops, 'groupTooLarge').length).toBe(1)
    })

    /** @covers REQ-446#at-max */
    it('論点がちょうど 8 のまとまりは止めない', () => {
      const r = check22((p) => {
        p.groups = [
          { name: '八つ', description: '八つの説明です。', topics: [220, 221, 222, 223, 224, 225, 226, 227] },
          { name: '一つ', description: '一つの説明です。', topics: [228] },
        ]
      })
      expect(r.json?.stops, r.stdout).toEqual([])
      expect(r.status).toBe(0)
    })

    /** @covers REQ-446#over-max-with-identity-stop */
    it('単元を指す側の止める理由が付くファイルでも、論点が 9 のまとまりをそのファイルとまとまりを挙げて groupTooLarge で止める（場合ごと）', () => {
      for (const [label, fileUnit, kind, identity] of IDENTITY_STOPS) {
        const r = checkWithIdentityStop(fileUnit, identity, [{ name: '全部', description: '全部の説明です。', topics: [220, 221, 222, 223, 224, 225, 226, 227, 228] }])
        labelled(label, () => {
          expectStop(r, kind, planName(fileUnit))
          expectStop(r, 'groupTooLarge', planName(fileUnit), 'まとまり 1')
          expect(findingsOf(r.json.stops, 'groupTooLarge').length).toBe(1)
        })
      }
    })

    /** @covers REQ-446#over-max-with-missing-element */
    it('要素の欠けで止まるファイルでも、論点が 9 のまとまりをそのファイルとまとまりを挙げて groupTooLarge で止める（場合ごと）', () => {
      for (const [label, edit, where] of <[string, (p: Json) => unknown, string][]>[
        ['論点の並びが空のまとまりがある', (p: Json) => (p.groups = [{ name: '前半', description: '前半の説明です。', topics: [] }, { name: '後半', description: '後半の説明です。', topics: [220, 221, 222, 223, 224, 225, 226, 227, 228] }]), 'まとまり 2'],
        ['単元の番号が無い', (p: Json) => { delete p.unit_no; p.groups = [{ name: '全部', description: '全部の説明です。', topics: [220, 221, 222, 223, 224, 225, 226, 227, 228] }] }, 'まとまり 1'],
      ]) {
        const r = check22((p) => void edit(p))
        labelled(label, () => {
          expectStop(r, 'missingElement', planName(22))
          expectStop(r, 'groupTooLarge', planName(22), where)
        })
      }
    })
  })

  describe('前提が実在しない・自分・重なる・多すぎる・後ろ・循環なら止める（REQ-447）', () => {
    /** @covers REQ-447#prerequisite-key-unknown */
    it('前提を持つ側が学びに無い論点なら、その論点を挙げて prerequisiteKeyUnknown で止める', () => {
      expectStop(check21((p) => (p.prerequisites[String(UNKNOWN_TOPIC)] = [103])), 'prerequisiteKeyUnknown', planName(21), UNKNOWN_TOPIC)
    })

    /** @covers REQ-447#prerequisite-key-foreign */
    it('前提を持つ側がその単元の外の論点なら、その論点を挙げて prerequisiteKeyForeign で止める', () => {
      expectStop(check21((p) => (p.prerequisites['330'] = [103])), 'prerequisiteKeyForeign', planName(21), 330)
    })

    /** @covers REQ-447#prerequisite-unknown */
    it('学びに無い論点を前提にすれば、その論点と前提を挙げて prerequisiteUnknown で止める', () => {
      expectStop(check21((p) => (p.prerequisites['107'] = [UNKNOWN_TOPIC])), 'prerequisiteUnknown', planName(21), 107, UNKNOWN_TOPIC)
    })

    /** @covers REQ-447#prerequisite-self */
    it('自分自身を前提にすれば、その論点を挙げて prerequisiteSelf で止める', () => {
      expectStop(check21((p) => (p.prerequisites['107'] = [107])), 'prerequisiteSelf', planName(21), 107)
    })

    /** @covers REQ-447#prerequisite-duplicate */
    it('1 つの論点の前提に同じ論点が 2 回並べば（本数は上限の内、学ぶ順で前）、その論点と前提を挙げて prerequisiteDuplicate で止め、読めないファイルとはしない', () => {
      const r = check21((p) => (p.prerequisites['105'] = [112, 112]))
      expectStop(r, 'prerequisiteDuplicate', planName(21), 105, 112)
      noneOf(r, 'unreadablePlan')
      noneOf(r, 'prerequisiteTooMany')
    })

    /** @covers REQ-447#prerequisite-too-many */
    it('1 つの論点に前提が 3 本（どれも学ぶ順で前）あれば、その論点を挙げて prerequisiteTooMany で止める', () => {
      const r = check21((p) => (p.prerequisites['107'] = [112, 103, 109]))
      expectStop(r, 'prerequisiteTooMany', planName(21), 107)
      noneOf(r, 'prerequisiteAfter')
    })

    /** @covers REQ-447#prerequisite-at-max */
    it('1 つの論点に前提がちょうど 2 本（どれも学ぶ順で前）なら止めない', () => {
      const r = check21((p) => (p.prerequisites['107'] = [112, 103]))
      expect(r.json?.stops, r.stdout).toEqual([])
      expect(r.status).toBe(0)
    })

    /** @covers REQ-447#prerequisite-after */
    it('同じ単元の学ぶ順でその論点より後ろの論点を前提にすれば、その論点と前提を挙げて prerequisiteAfter で止める', () => {
      expectStop(check21((p) => (p.prerequisites['103'] = [107])), 'prerequisiteAfter', planName(21), 103, 107)
    })

    /** @covers REQ-447#other-unit-allowed */
    it('他の単元の論点を前提にするだけなら、学ぶ順にかかわらず止めない', () => {
      const r = check21((p) => (p.prerequisites['112'] = [228]))
      expect(r.json?.stops, r.stdout).toEqual([])
      expect(r.status).toBe(0)
    })

    /** @covers REQ-447#cycle-across-units */
    it('2 つの単元の構成の前提をたどって元の論点に戻れば、その論点と前提を挙げて prerequisiteCycle で止める', () => {
      const r = check21((p) => (p.prerequisites['103'] = [221]))
      expect(r.status).toBe(1)
      const hits = findingsOf(r.json?.stops, 'prerequisiteCycle')
      expect(hits.length, r.stdout).toBeGreaterThan(0)
      expect(hits.some((f) => findingText(f).includes('103') && findingText(f).includes('221')), JSON.stringify(hits)).toBe(true)
    })

    /** @covers REQ-447#cycle-with-missing-element */
    it('循環に加わる単元の構成の 1 つが論点の並びの空のまとまりで止まるときも、その論点と前提を挙げて prerequisiteCycle で止める', () => {
      const ws = makeWorkspace()
      const p22 = plan22()
      p22.groups.push({ name: '空', description: '空のまとまりの説明です。', topics: [] })
      ws.write(planFile(22), p22)
      const r = check21((p) => (p.prerequisites['103'] = [221]), ws)
      expectStop(r, 'missingElement', planName(22))
      const hits = findingsOf(r.json?.stops, 'prerequisiteCycle')
      expect(hits.length, r.stdout).toBeGreaterThan(0)
      expect(hits.some((f) => findingText(f).includes('103') && findingText(f).includes('221')), JSON.stringify(hits)).toBe(true)
    })

    /** @covers REQ-447#self-with-missing-element */
    it('論点の並びが空のまとまりを持つファイルでも、自分自身を前提にする論点を挙げて prerequisiteSelf で止める', () => {
      const r = check21((p) => {
        p.groups.push({ name: '空', description: '空のまとまりの説明です。', topics: [] })
        p.prerequisites['112'] = [112]
      })
      expectStop(r, 'missingElement', planName(21))
      expectStop(r, 'prerequisiteSelf', planName(21), 112)
    })

    /** @covers REQ-447#key-unknown-with-missing-unit-no */
    it('単元の番号が欠けたファイルでも、学びに無い論点が前提を持てば、その論点を挙げて prerequisiteKeyUnknown で止める', () => {
      const r = check21((p) => {
        delete p.unit_no
        p.prerequisites[String(UNKNOWN_TOPIC)] = [103]
      })
      expectStop(r, 'missingElement', planName(21))
      expectStop(r, 'prerequisiteKeyUnknown', planName(21), UNKNOWN_TOPIC)
    })

    /** @covers REQ-447#unknown-with-missing-unit-no */
    it('単元の番号が欠けたファイルでも、学びに無い論点を前提にすれば、その論点と前提を挙げて prerequisiteUnknown で止める', () => {
      const r = check21((p) => {
        delete p.unit_no
        p.prerequisites['107'] = [UNKNOWN_TOPIC]
      })
      expectStop(r, 'missingElement', planName(21))
      expectStop(r, 'prerequisiteUnknown', planName(21), 107, UNKNOWN_TOPIC)
    })

    /** @covers REQ-447#self-with-missing-unit-no */
    it('単元の番号が欠けたファイルでも、自分自身を前提にする論点を挙げて prerequisiteSelf で止める', () => {
      const r = check21((p) => {
        delete p.unit_no
        p.prerequisites['112'] = [112]
      })
      expectStop(r, 'missingElement', planName(21))
      expectStop(r, 'prerequisiteSelf', planName(21), 112)
    })

    /** @covers REQ-447#duplicate-with-missing-unit-no */
    it('単元の番号が欠けたファイルでも、前提に同じ論点が 2 回並べば、その論点と前提を挙げて prerequisiteDuplicate で止め、読めないファイルとはしない', () => {
      const r = check21((p) => {
        delete p.unit_no
        p.prerequisites['105'] = [112, 112]
      })
      expectStop(r, 'missingElement', planName(21))
      expectStop(r, 'prerequisiteDuplicate', planName(21), 105, 112)
      noneOf(r, 'unreadablePlan')
    })

    /** @covers REQ-447#too-many-with-missing-unit-no */
    it('単元の番号が欠けたファイルでも、前提が 3 本あれば、その論点を挙げて prerequisiteTooMany で止める', () => {
      const r = check21((p) => {
        delete p.unit_no
        p.prerequisites['107'] = [112, 103, 109]
      })
      expectStop(r, 'missingElement', planName(21))
      expectStop(r, 'prerequisiteTooMany', planName(21), 107)
    })

    /** @covers REQ-447#cycle-with-missing-unit-no */
    it('循環に加わる単元の構成の 1 つが単元の番号の欠けで止まるときも、その論点と前提を挙げて prerequisiteCycle で止める', () => {
      const r = check21((p) => {
        delete p.unit_no
        p.prerequisites['103'] = [221]
      })
      expectStop(r, 'missingElement', planName(21))
      const hits = findingsOf(r.json?.stops, 'prerequisiteCycle')
      expect(hits.length, r.stdout).toBeGreaterThan(0)
      expect(hits.some((f) => findingText(f).includes('103') && findingText(f).includes('221')), JSON.stringify(hits)).toBe(true)
    })
  })

  describe('受け持ちが学ぶ順で最初でない・触れる論点の外・単元の外なら止める（REQ-448）', () => {
    /** @covers REQ-448#owner-too-few-topics */
    it('触れる論点が 1 つだけの受け持ちは、その単元と受け持ちを挙げて ownerTooFewTopics で止める', () => {
      expectOwnerStop(check21((p) => (p.owners[1].topics = [103])), 'ownerTooFewTopics')
    })

    /** @covers REQ-448#owner-not-first */
    it('受け持ちの論点が、触れる論点のうち学ぶ順で最初でなければ、その単元と受け持ちを挙げて ownerNotFirst で止める', () => {
      expectOwnerStop(check21((p) => (p.owners[1].owner = 109)), 'ownerNotFirst')
    })

    /** @covers REQ-448#owner-not-in-topics */
    it('受け持ちの論点が触れる論点に無ければ、その単元と受け持ちを挙げて ownerNotInTopics で止める', () => {
      expectOwnerStop(check21((p) => (p.owners[1].owner = 107)), 'ownerNotInTopics')
    })

    /** @covers REQ-448#owner-topic-outside */
    it('触れる論点に他の単元の論点があれば、その単元と受け持ちを挙げて ownerTopicOutside で止める', () => {
      expectOwnerStop(check21((p) => p.owners[1].topics.push(220)), 'ownerTopicOutside')
    })

    /** @covers REQ-448#owner-topic-unknown */
    it('触れる論点に学びに無い論点があれば、その単元と受け持ちを挙げて ownerTopicOutside で止める', () => {
      expectOwnerStop(check21((p) => p.owners[1].topics.push(UNKNOWN_TOPIC)), 'ownerTopicOutside')
    })
  })

  describe('まとまりの論点の数が下限に届かなければ警告にする（REQ-449）', () => {
    /** @covers REQ-449#below-min-warns */
    it('論点が 2 のまとまりは groupTooSmall の警告に挙げ、止める理由にはしない', () => {
      const r = check22((p) => {
        p.groups = [
          { name: '二つ', description: '二つの説明です。', topics: [220, 221] },
          { name: '七つ', description: '七つの説明です。', topics: [222, 223, 224, 225, 226, 227, 228] },
        ]
      })
      expect(r.status, r.stdout).toBe(0)
      expect(r.json?.stops).toEqual([])
      const w = findingsOf(r.json?.warnings, 'groupTooSmall')
      expect(w.length).toBe(1)
      expect(String(w[0].where)).toContain(planName(22))
      expect(String(w[0].where)).toContain('まとまり 1')
    })

    /** @covers REQ-449#at-min-no-warning */
    it('論点がちょうど 3 のまとまりは警告に挙げない', () => {
      const r = check22((p) => {
        p.groups = [
          { name: '三つ', description: '三つの説明です。', topics: [220, 221, 222] },
          { name: '六つ', description: '六つの説明です。', topics: [223, 224, 225, 226, 227, 228] },
        ]
      })
      expect(r.status, r.stdout).toBe(0)
      expect(r.json?.warnings).toEqual([])
    })

    /** @covers REQ-449#warning-kept-with-stops */
    it('他の止める理由で止めたときも、下限に届かないまとまりは止める理由でなく警告に挙げる', () => {
      const r = check22((p) => {
        p.groups = [
          { name: '二つ', description: '二つの説明です。', topics: [220, 221] },
          { name: '七つ', description: '', topics: [222, 223, 224, 225, 226, 227, 228] },
        ]
      })
      expect(r.status).toBe(1)
      expect(findingsOf(r.json?.warnings, 'groupTooSmall').length).toBe(1)
      noneOf(r, 'groupTooSmall')
    })

    /** @covers REQ-449#warning-kept-with-identity-stop */
    it('単元を指す側の止める理由が付くファイルでも、論点が 2 のまとまりをそのファイルとまとまりを挙げて警告に挙げ、止める理由にはしない（場合ごと）', () => {
      for (const [label, fileUnit, kind, identity] of IDENTITY_STOPS) {
        const r = checkWithIdentityStop(fileUnit, identity, [
          { name: '二つ', description: '二つの説明です。', topics: [220, 221] },
          { name: '七つ', description: '七つの説明です。', topics: [222, 223, 224, 225, 226, 227, 228] },
        ])
        labelled(label, () => {
          expectStop(r, kind, planName(fileUnit))
          const w = findingsOf(r.json?.warnings, 'groupTooSmall')
          expect(w.length, r.stdout).toBe(1)
          expect(String(w[0].where)).toContain(planName(fileUnit))
          expect(String(w[0].where)).toContain('まとまり 1')
          noneOf(r, 'groupTooSmall')
        })
      }
    })

    /** @covers REQ-449#warning-kept-with-missing-topics */
    it('別のまとまりの論点の並びが空で止めるときも、論点が 2 のまとまりをそのファイルとまとまりを挙げて警告に挙げ、止める理由にはしない', () => {
      const r = check22((p) => {
        p.groups = [
          { name: '空', description: '空のまとまりの説明です。', topics: [] },
          { name: '二つ', description: '二つの説明です。', topics: [220, 221] },
          { name: '七つ', description: '七つの説明です。', topics: [222, 223, 224, 225, 226, 227, 228] },
        ]
      })
      expectStop(r, 'missingElement', planName(22))
      const w = findingsOf(r.json?.warnings, 'groupTooSmall')
      expect(w.some((f) => String(f.where).includes(planName(22)) && String(f.where).includes('まとまり 2')), r.stdout).toBe(true)
      noneOf(r, 'groupTooSmall')
    })
  })

  describe('単元の構成が無い単元は確かめない（REQ-450）', () => {
    /** @covers REQ-450#unplanned-unit-ignored */
    it('単元の構成が無い単元（23）は止める理由にも警告にもならず、見た数にも入らない', () => {
      const r = check(makeWorkspace())
      expect(r.status).toBe(0)
      expect(r.json?.units).toBe(2)
      const all = [...(r.json?.stops ?? []), ...(r.json?.warnings ?? [])].map(findingText).join('\n')
      for (const s of ['23.json', '330', '331', '単元二十三']) expect(all).not.toContain(s)
    })

    /** @covers REQ-450#topicless-unit-ignored */
    it('論点が 1 つも無い単元（24）は、構成が無くても止める理由にも警告にもならず、見た数にも入らない', () => {
      const r = check(makeWorkspace())
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.json).toMatchObject({ units: 2, topics: 15 })
      const all = [...(r.json?.stops ?? []), ...(r.json?.warnings ?? [])].map(findingText).join('\n')
      for (const s of [`${TOPICLESS_UNIT}.json`, '単元二十四']) expect(all).not.toContain(s)
    })

    /** @covers REQ-450#no-plans */
    it('単元の構成が 1 つも無い学びは、見た数 0 で通す', () => {
      const ws = makeWorkspace()
      ws.remove(`${DATA}/unit_plans`)
      const r = check(ws)
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.json).toMatchObject({ exitCode: 0, units: 0, topics: 0, stops: [], warnings: [], limits: LIMITS })
    })
  })

  describe('門は読む物を書き換えない（REQ-486）', () => {
    /** @covers REQ-486#unchanged-on-pass */
    it('通すとき（警告ありを含む）、学びの置き場の単元の構成・シラバス・論点の一覧のどのファイルも書き換えない', () => {
      const ws = makeWorkspace()
      const p = plan22()
      p.groups = [
        { name: '二つ', description: '二つの説明です。', topics: [220, 221] },
        { name: '七つ', description: '七つの説明です。', topics: [222, 223, 224, 225, 226, 227, 228] },
      ]
      ws.write(planFile(22), p)
      const before = ws.snapshotTree(DATA)
      const r = check(ws)
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(ws.snapshotTree(DATA)).toEqual(before)
    })

    /** @covers REQ-486#unchanged-on-stop */
    it('止めるとき（読めない構成と欠けた構成を含む）、学びの置き場のどのファイルも書き換えない', () => {
      const ws = makeWorkspace()
      ws.write(planFile(21), JSON.stringify({ ...plan21(), groups: [] }))
      ws.write(planFile(22), JSON.stringify(plan22()).slice(0, 80))
      const before = ws.snapshotTree(DATA)
      const r = check(ws)
      expect(r.status, r.stdout + r.stderr).toBe(1)
      expect(ws.snapshotTree(DATA)).toEqual(before)
    })

    /** @covers REQ-486#unchanged-on-refuse */
    it('断るとき、学びの置き場のどのファイルも書き換えない（場合ごと）', () => {
      for (const [label, data, prepare] of <[string, string, (ws: Workspace) => void][]>[
        ['登録簿に無い学び', 'data/zzz', () => undefined],
        ['論点の一覧が読めない学び', DATA, (ws) => ws.write(`${DATA}/topics.json`, '{"topics": [')],
      ]) {
        const ws = makeWorkspace()
        prepare(ws)
        const before = ws.snapshotTree(data)
        const r = check(ws, data)
        labelled(label, () => {
          expect(r.status, r.stdout + r.stderr).toBe(2)
          expect(ws.snapshotTree(data)).toEqual(before)
        })
      }
    })
  })
})
