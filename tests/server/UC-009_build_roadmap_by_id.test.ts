/** ロードマップを組み立て直す道具（`python3 scripts/build_roadmap.py --data data/itc --out <出力先>`）が、
 *  論点の候補の名前と副題を分けたままロードマップのデータに移し（REQ-429）、ロードマップの設定と候補の前提が単位を指す所を
 *  すべて論点の ID として読み（REQ-430）、どの候補にも当たらない ID があれば書き出さずに止めてその ID を示す（REQ-434）こと。UC-009
 *
 *  仕込みは一時の作業場の data/itc/ にテスト自身が書く（topics_candidates.json と roadmap_config.json だけ。実データは読まない）。
 *  学びの鍵 itc は登録簿にある日で束ねる学びとして借り、分野の名前はその学びの分野を使う。
 *  候補の重み（source_count）を ID の順に下げてあるので、設定が何も効かなければ学ぶ順は ID の順に並び、上位 MAX 件だけが載る。
 *  観測するのは終了コード・標準出力と標準エラー・出力先の roadmap.json の units（topic_id・term・subtitle・summary・order）だけ。 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUILD = path.join(ROOT, 'scripts', 'build_roadmap.py')
const DATA = 'data/itc'
const OUT = 'out'
const FIELDS = ['業界と仕事', 'ITと業務の基礎知識', '選考と自己理解', '論理思考とケース']

type Json = Record<string, any>
type Candidate = Json & { id: number; term: string; prereq: number[] }

/** 候補の数と、ロードマップに載せる上限。 */
const COUNT = 12
const MAX = 6
/** 候補の ID（ID は名前とも学ぶ順とも別の値にしてある）。 */
const ID = (n: number) => 300 + n
/** どの候補にも当たらない ID。 */
const UNKNOWN = 9876

/** 設定が何も効かない候補の一覧（ID の順に重みが下がる）。 */
function candidates(): Candidate[] {
  return Array.from({ length: COUNT }, (_, i) => ({
    id: ID(i + 1),
    term: `候補の単位${String.fromCharCode(0x30a2 + i * 2)}`,
    field: FIELDS[i % FIELDS.length],
    middle: '仕込みの中分類',
    summary: `仕込みの要約${i + 1}`,
    source_count: 40 - i * 2,
    sources: ['仕込みの資料'],
    interview_count: 0,
    prereq: [],
    goals: [1],
    aliases: [],
  }))
}

function config(over: Json = {}): Json {
  return {
    max: MAX,
    per_day: 3,
    min_per_goal: 1,
    must_include: [],
    exclude: [],
    prereq_add: {},
    prereq_replace: {},
    cluster: [],
    summary_override: {},
    ...over,
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Built = {
  status: number | null
  out: string
  roadmapExists: boolean
  units: Json[]
}

/** 作業場に候補と設定を書いて組み立てる。 */
function build(cands: Candidate[], cfg: Json): Built {
  const ws = fs.mkdtempSync(path.join(tmpdir(), 'uc009-roadmap-'))
  dirs.push(ws)
  fs.mkdirSync(path.join(ws, DATA), { recursive: true })
  fs.writeFileSync(path.join(ws, DATA, 'topics_candidates.json'), JSON.stringify({ candidates: cands }, null, 2))
  fs.writeFileSync(path.join(ws, DATA, 'roadmap_config.json'), JSON.stringify(cfg, null, 2))
  const r = spawnSync('python3', [BUILD, '--data', DATA, '--out', OUT], {
    cwd: ws,
    encoding: 'utf8',
  })
  const file = path.join(ws, OUT, 'roadmap.json')
  const roadmapExists = fs.existsSync(file)
  const units = roadmapExists ? (JSON.parse(fs.readFileSync(file, 'utf8')).units as Json[]) : []
  return {
    status: r.status,
    out: `${r.stdout}\n${r.stderr}`,
    roadmapExists,
    units,
  }
}

function built(cands: Candidate[], cfg: Json) {
  const b = build(cands, cfg)
  expect(b.status, `組み立てが終了 0 で終わらない:\n${b.out}`).toBe(0)
  expect(b.roadmapExists, 'roadmap.json が書かれていない').toBe(true)
  return b
}

const ids = (b: Built) => b.units.map((u) => u.topic_id)
const unit = (b: Built, id: number) => {
  const u = b.units.find((x) => x.topic_id === id)
  if (!u) throw new Error(`ロードマップに論点 ${id} の単位が無い: ${JSON.stringify(ids(b))}`)
  return u
}
const order = (b: Built, id: number) => unit(b, id).order as number

describe('候補の名前と副題を分けたまま移す（UC-009）', () => {
  const SUBTITLE = '経営の課題を IT で解く役割'
  const PAREN = '（括弧書きの補足）'

  // @covers REQ-429#subtitle-carried-apart
  it('候補で副題を持つ単位は、ロードマップのデータでも名前と副題がそれぞれ元の文字のまま分かれて入る', () => {
    const cands = candidates()
    cands[1].subtitle = SUBTITLE
    const b = built(cands, config())
    const u = unit(b, ID(2))
    expect(u.term, '名前が元の文字のままでない').toBe(cands[1].term)
    expect(u.subtitle, '副題が元の文字のまま入っていない').toBe(SUBTITLE)
  })

  // @covers REQ-429#no-subtitle-absent
  it('候補で副題を持たない単位は、ロードマップのデータで副題の欄を持たず、括弧書きを含む名前も切り出さずに入る', () => {
    const cands = candidates()
    cands[1].subtitle = SUBTITLE
    cands[2].term = `${cands[2].term}${PAREN}`
    const b = built(cands, config())
    for (const i of [2, 3]) {
      const u = unit(b, ID(i + 1))
      expect(u.term, `論点 ${ID(i + 1)} の名前が元の文字のままでない`).toBe(cands[i].term)
      expect(u, `論点 ${ID(i + 1)} の副題を持たない単位に副題の欄がある`).not.toHaveProperty('subtitle')
    }
  })
})

describe('設定と候補の前提を論点の ID で当てる（UC-009）', () => {
  // @covers REQ-430#must-include-by-id
  it('含める単位の一覧に書いた ID の単位は、重みで上限から落ちる単位でもロードマップに載る', () => {
    const low = ID(COUNT)
    expect(ids(built(candidates(), config())), '仕込み: 設定が無くても載っている').not.toContain(low)
    expect(ids(built(candidates(), config({ must_include: [low] })))).toContain(low)
  })

  // @covers REQ-430#exclude-by-id
  it('除く単位の一覧に書いた ID の単位は、重みが一番でもロードマップに載らない', () => {
    const top = ID(1)
    expect(ids(built(candidates(), config())), '仕込み: 設定が無くても載っていない').toContain(top)
    expect(ids(built(candidates(), config({ exclude: [top] })))).not.toContain(top)
  })

  // @covers REQ-430#cluster-by-id
  it('続けて並べる単位の一覧に書いた ID の単位は、学ぶ順で間を空けずに並ぶ', () => {
    const members = [ID(1), ID(4), ID(6)]
    const base = built(candidates(), config())
    const span = (b: Built) => Math.max(...members.map((m) => order(b, m))) - Math.min(...members.map((m) => order(b, m)))
    expect(span(base), '仕込み: 設定が無くても続いて並んでいる').toBeGreaterThan(members.length - 1)
    expect(span(built(candidates(), config({ cluster: [members] })))).toBe(members.length - 1)
  })

  // @covers REQ-430#prereq-add-by-id
  it('前提を足す設定の鍵と値に書いた ID で、値の単位が鍵の単位より前に並ぶ', () => {
    const [dep, pre] = [ID(2), ID(5)]
    const base = built(candidates(), config())
    expect(order(base, pre), '仕込み: 設定が無くても前に並んでいる').toBeGreaterThan(order(base, dep))
    const b = built(candidates(), config({ prereq_add: { [String(dep)]: [pre] } }))
    expect(order(b, pre)).toBeLessThan(order(b, dep))
  })

  // @covers REQ-430#prereq-replace-by-id
  it('前提を置き換える設定の鍵と値に書いた ID で、鍵の単位の前提が値の単位だけになる', () => {
    const [dep, oldPre, newPre] = [ID(4), ID(6), ID(5)]
    const cands = candidates()
    cands[3].prereq = [oldPre]
    const before = built(cands, config())
    expect(order(before, oldPre), '仕込み: 候補の前提が前に並んでいない').toBeLessThan(order(before, dep))
    const b = built(cands, config({ prereq_replace: { [String(dep)]: [newPre] } }))
    expect(order(b, newPre), '置き換えた前提が前に並んでいない').toBeLessThan(order(b, dep))
    expect(order(b, oldPre), '置き換えられた前提がまだ前に並んでいる').toBeGreaterThan(order(b, dep))
  })

  // @covers REQ-430#summary-override-by-id
  it('要約を差し替える設定の鍵に書いた ID の単位は、要約がその値になる', () => {
    const target = ID(3)
    const text = '鍵の ID で差し替えた要約'
    const b = built(candidates(), config({ summary_override: { [String(target)]: text } }))
    expect(unit(b, target).summary).toBe(text)
    for (const u of b.units.filter((x) => x.topic_id !== target)) expect(u.summary).not.toBe(text)
  })

  // @covers REQ-430#candidate-prereq-by-id
  it('候補の前提に書いた ID の単位が、その候補の単位より前に並ぶ', () => {
    const [dep, pre] = [ID(2), ID(5)]
    const cands = candidates()
    cands[1].prereq = [pre]
    const b = built(cands, config())
    expect(order(b, pre)).toBeLessThan(order(b, dep))
  })

  // @covers REQ-430#names-not-matched
  it('候補の名前を別の候補の ID と同じ文字に付け替えても、設定と前提は同じ ID の単位に当たり、組み立ての結果は変わらない', () => {
    const cfg = config({
      must_include: [ID(COUNT)],
      exclude: [ID(1)],
      cluster: [[ID(2), ID(6)]],
      prereq_add: { [String(ID(3))]: [ID(5)] },
      prereq_replace: { [String(ID(4))]: [ID(7)] },
      summary_override: { [String(ID(3))]: '鍵の ID で差し替えた要約' },
    })
    const plain = candidates()
    plain[3].prereq = [ID(8)]
    // 名前を 1 つずらした候補の ID の文字にする: 名前で当てると、設定は別の単位に当たる
    const renamed = plain.map((c, i) => ({
      ...c,
      term: String(plain[(i + 1) % plain.length].id),
    }))
    const shape = (b: Built) => b.units.map((u) => [u.order, u.topic_id, u.summary])
    const a = built(plain, cfg)
    const r = built(renamed, cfg)
    expect(shape(r)).toEqual(shape(a))
    expect(unit(r, ID(3)).summary).toBe('鍵の ID で差し替えた要約')
  })
})

/** 設定の形ごとの、当たらない ID の置き方。 */
const UNKNOWN_KEY: [string, Json][] = [
  ['前提を足す設定', { prereq_add: { [String(UNKNOWN)]: [ID(1)] } }],
  ['前提を置き換える設定', { prereq_replace: { [String(UNKNOWN)]: [ID(1)] } }],
  ['要約を差し替える設定', { summary_override: { [String(UNKNOWN)]: '当たらない鍵の要約' } }],
]
const UNKNOWN_VALUE: [string, Json][] = [
  ['前提を足す設定', { prereq_add: { [String(ID(2))]: [UNKNOWN] } }],
  ['前提を置き換える設定', { prereq_replace: { [String(ID(2))]: [UNKNOWN] } }],
]
const UNKNOWN_LIST: [string, Json][] = [
  ['含める単位の一覧', { must_include: [UNKNOWN] }],
  ['除く単位の一覧', { exclude: [UNKNOWN] }],
  ['続けて並べる単位の一覧', { cluster: [[ID(1), UNKNOWN]] }],
]
const NAME_CASES: [string, (term: string) => Json][] = [
  ['含める単位の一覧', (term: string) => ({ must_include: [term] })],
  [
    '要約を差し替える設定の鍵',
    (term: string) => ({
      summary_override: { [term]: '名前で書いた鍵の要約' },
    }),
  ],
]

describe('当たらない ID があれば書き出さずに止める（UC-009）', () => {
  function expectStopped(b: Built, shown: string, where: string) {
    expect(b.status, `${where}: 止まらずに終了 0 で終わった:\n${b.out}`).not.toBe(0)
    expect(b.roadmapExists, `${where}: roadmap.json が書き出されている`).toBe(false)
    expect(b.out, `${where}: どの ID が当たらないかを示していない`).toContain(shown)
  }

  // @covers REQ-434#unknown-key
  it('単位ごとの設定（前提を足す・置き換える・要約を差し替える）の鍵の ID がどの候補にも当たらないと、書き出さずに止め、その ID を示す', () => {
    for (const [where, over] of UNKNOWN_KEY) {
      expectStopped(build(candidates(), config(over)), String(UNKNOWN), where)
    }
  })

  // @covers REQ-434#unknown-in-value
  it('前提を足す・置き換える設定の値の ID がどの候補にも当たらないと、書き出さずに止め、その ID を示す', () => {
    for (const [where, over] of UNKNOWN_VALUE) {
      expectStopped(build(candidates(), config(over)), String(UNKNOWN), where)
    }
  })

  // @covers REQ-434#unknown-in-list
  it('含める・除く・続けて並べる単位の一覧の ID がどの候補にも当たらないと、書き出さずに止め、その ID を示す', () => {
    for (const [where, over] of UNKNOWN_LIST) {
      expectStopped(build(candidates(), config(over)), String(UNKNOWN), where)
    }
  })

  // @covers REQ-434#name-in-place-of-id
  it('含める単位の一覧と要約を差し替える設定の鍵に、候補の名前を ID の代わりに書くと、名前で当てずに書き出さずに止め、その値を示す', () => {
    for (const [where, over] of NAME_CASES) {
      const cands = candidates()
      const term = cands[COUNT - 1].term
      expectStopped(build(cands, config(over(term))), term, where)
    }
  })
})

describe('候補に名前が同じ単位があれば書き出さずに止める（UC-009）', () => {
  function expectStopped(cands: Candidate[], cfg: Json, name: string, where: string) {
    const b = build(cands, cfg)
    expect(b.status, `${where}: 止まらずに終了 0 で終わった:\n${b.out}`).not.toBe(0)
    expect(b.roadmapExists, `${where}: roadmap.json が書き出されている`).toBe(false)
    expect(b.out, `${where}: どの名前が重なっているかを示していない`).toContain(name)
  }

  const DUP = '重なる名前の単位'

  // @covers REQ-437#duplicate-among-selected
  it('ロードマップに載る候補どうしに名前が同じ単位があると（副題が違っても・3 つでも）、書き出さずに止め、その名前を示す', () => {
    const variants: [string, (c: Candidate[]) => void][] = [
      ['副題なしの 2 つ', (c) => {
        c[0].term = DUP
        c[2].term = DUP
      }],
      ['副題だけが違う 2 つ', (c) => {
        c[0].term = DUP
        c[0].subtitle = '一つ目の副題'
        c[2].term = DUP
        c[2].subtitle = '二つ目の副題'
      }],
      ['3 つ', (c) => {
        c[0].term = DUP
        c[2].term = DUP
        c[4].term = DUP
      }],
    ]
    for (const [where, edit] of variants) {
      const cands = candidates()
      edit(cands)
      expectStopped(cands, config(), DUP, where)
    }
  })

  // @covers REQ-437#duplicate-outside-selection
  it('名前が同じ単位のどちらかが重みの上限や除く一覧でロードマップに載らない候補でも、書き出さずに止め、その名前を示す', () => {
    const cut = candidates()
    cut[0].term = DUP
    cut[COUNT - 1].term = DUP
    expectStopped(cut, config(), DUP, '上限で落ちる候補と重なる')

    const excluded = candidates()
    excluded[0].term = DUP
    excluded[1].term = DUP
    expectStopped(excluded, config({ exclude: [ID(1)] }), DUP, '除く一覧の候補と重なる')

    const bothOut = candidates()
    bothOut[COUNT - 2].term = DUP
    bothOut[COUNT - 1].term = DUP
    expectStopped(bothOut, config(), DUP, '載らない候補どうしで重なる')
  })

  // @covers REQ-437#distinct-names-built
  it('名前がどれも違えば、一方の名前が他方の名前を含んでも、他方の名前と副題をつないだ文字と同じでも、止めずに書き出す', () => {
    const cands = candidates()
    cands[0].term = '基礎'
    cands[0].subtitle = '（入門）'
    cands[1].term = '基礎（入門）'
    cands[2].term = '基礎の応用'
    const b = built(cands, config())
    for (const i of [0, 1, 2]) expect(unit(b, ID(i + 1)).term).toBe(cands[i].term)
    expect(unit(b, ID(1)).subtitle).toBe('（入門）')
  })
})
