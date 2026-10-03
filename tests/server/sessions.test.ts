import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** 入力の検証（出題を組む前に弾く所）だけを叩く。
 *  出題の中身（進行中が既にある 409・範囲に過去問が無い 400）は本物のデータが要るので
 *  scripts/check_api.py が本番相当で見る。
 *
 *  偽の D1 は過去問の行を持つ（finished_session.test.ts の作法）。空の D1 だと
 *  形の正しい要求も「出題できる問題がありません」の 400 になり、形の検証を外しても
 *  緑のままになる（偽の緑）。各クラスの検査は、まず同じ種別の形の正しい要求が 201 で
 *  作れることを確かめてから、形の誤りだけが 400 になることを見る。 */
type Row = Record<string, unknown>
type Table = { match: RegExp; rows: Row[] }

/** SQL の select の並び（別名があれば別名、無ければ最後の識別子）。
 *  drizzle は値を位置で読むことがあるので、行を列名から並べ直すのに使う。 */
function selectNames(sql: string): string[] {
  const head = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(sql)
  if (!head) return []
  const items: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of head[1]) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      items.push(cur)
      cur = ''
    } else cur += ch
  }
  items.push(cur)
  return items.map((item) => {
    const text = item.trim().replace(/^distinct\s+/i, '')
    const alias = /\bas\s+"?(\w+)"?\s*$/i.exec(text)
    if (alias) return alias[1]
    const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    if (quoted.length > 0) return quoted[quoted.length - 1]
    const dotted = /(\w+)\s*$/.exec(text)
    return dotted ? dotted[1] : text
  })
}

/** `"列" = ?` の形の条件を、束ねられた値と組にして取り出す（行が持たない列の条件は素通り）。 */
function conditions(sql: string, params: unknown[]): { column: string; equal: boolean; value: unknown }[] {
  const found: { column: string; equal: boolean; value: unknown }[] = []
  let index = 0
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== '?') continue
    const before = sql.slice(Math.max(0, i - 48), i)
    const match = /"?(\w+)"?\s*(=|<>|!=)\s*$/.exec(before)
    if (match) found.push({ column: match[1], equal: match[2] === '=', value: params[index] })
    index++
  }
  return found
}

/** 列名で持った行を返す偽の D1（prepare → bind → raw/all/first）。 */
function fakeD1(tables: Table[]) {
  const rowsFor = (sql: string, params: unknown[]) => {
    const rows = tables.find((t) => t.match.test(sql))?.rows ?? []
    const where = conditions(sql, params)
    return rows.filter((row) =>
      where.every(({ column, equal, value }) => {
        if (!(column in row)) return true
        const same = String(row[column]) === String(value)
        return equal ? same : !same
      }),
    )
  }
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind: (...bound: unknown[]) => {
        params = bound
        return stmt
      },
      run: async () => ({ success: true, results: [], meta: {} }),
      all: async () => ({ success: true, results: rowsFor(sql, params), meta: {} }),
      first: async () => rowsFor(sql, params)[0] ?? null,
      raw: async () => {
        const names = selectNames(sql)
        return rowsFor(sql, params).map((row) => names.map((name) => (name in row ? row[name] : null)))
      },
    }
    return stmt
  }
  return { prepare, batch: async () => [], exec: async () => ({ count: 0, duration: 0 }) }
}

/** 範囲に合う過去問 1 問ぶんの行（列の別名は session-builder の QuestionRow のまま）。
 *  範囲を絞る列（論点・分野・単元）は持たせない。持たせると範囲の値を外した要求が
 *  「出題できる問題が 1 問も無い」の 400 になり、形の検証を外しても緑のままになる。 */
const question = (n: number): Row => ({
  id: `q-${n}`,
  exam: '2024r06',
  examLabel: '令和6年度',
  number: n,
  text: `問${n} の本文`,
  choices: JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
  answer: 'ア',
  hasFigure: 0,
  figureDescription: null,
  figureImage: null,
  citation: `出典：令和6年度 ITパスポート試験 問${n}`,
  modified: 0,
  contentKey: `ck-${n}`,
})

/** 上限（100 問）まで組めるだけの過去問と、範囲の名前の引き当て。
 *  弱点復習（kind review）は範囲の列で絞る経路を通らず、誤答の記録（session_questions の
 *  result = 2）と理解度の記録（progress の status）から出題を組むので、その 2 本にも行を持たせる。
 *  行が無いと形の正しい `{ kind: 'review' }` が「出題できる問題がありません」の 400 になり、
 *  形の検証（種別→範囲）を外した要求が復習の経路に落ちても 400 のままで緑になる（偽の緑）。
 *  SQL の目印は session-builder.test.ts と同じ: 誤答＝MAX(sq.answered_at) の集約、
 *  出題回数の数え直し＝content_key AS contentKey、理解度＝progress と status。 */
const TABLES: Table[] = [
  { match: /SELECT DISTINCT q\.id/i, rows: Array.from({ length: 100 }, (_, i) => question(i + 1)) },
  { match: /MAX\(sq\.answered_at\)/i, rows: Array.from({ length: 100 }, (_, i) => question(i + 1)) },
  { match: /SELECT id, content_key AS contentKey/i, rows: [] },
  {
    match: /(progress[\s\S]*status)|(status[\s\S]*progress)/i,
    rows: Array.from({ length: 100 }, (_, i) => question(i + 101)),
  },
  { match: /SELECT term FROM topics/i, rows: [{ term: 'オープンソースソフトウェア' }] },
  { match: /SELECT middle FROM syllabus_items/i, rows: [{ middle: '基礎理論' }] },
]

const SECRET = 'test-secret'
const env = () => ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(TABLES) } as unknown as Bindings)

async function post(path: string, body: unknown) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env(),
  )
}

/** 形の正しい要求が 201 で作れること（＝偽の D1 が過去問を渡せていること）の確認。
 *  これを欠くと、形の検証を外しても出題できる問題が無い 400 と区別できず空振りの緑になる。 */
async function expectCreated(body: unknown) {
  const res = await post('/api/sessions', body)
  expect(res.status, `形の正しい ${JSON.stringify(body)} が作れない（この検査は空振りになる）`).toBe(201)
  const payload = (await res.json()) as { id?: unknown; questionCount?: unknown }
  expect(typeof payload.id).toBe('string')
  expect(payload.questionCount).toBeGreaterThan(0)
}

/** 形を外れた要求が、テストを作らず理由を示して断られること。
 *  文言そのものは照合しない（理由の文の正本はコード。R-102）。 */
async function expectRejected(body: unknown) {
  const res = await post('/api/sessions', body)
  expect(res.status, `${JSON.stringify(body)} が通ってしまう`).toBe(400)
  const payload = (await res.json()) as { error?: unknown; id?: unknown }
  expect(typeof payload.error).toBe('string')
  expect(String(payload.error).length).toBeGreaterThan(0)
  expect(payload.id, `${JSON.stringify(body)} でテストが作られている`).toBeUndefined()
}

describe('POST /api/sessions の入力の検証', () => {
  // @covers REQ-243#size-out-of-range
  it('問題数が 1 未満・100 超なら、同じ種別の形の正しい要求が作れる状態でも 400', async () => {
    await expectCreated({ kind: 'field', field: 'テクノロジ系', size: 20 })
    for (const size of [0, -1, 101, 1000]) {
      await expectRejected({ kind: 'field', field: 'テクノロジ系', size })
    }
  })

  // @covers REQ-243#size-at-bounds
  it('範囲の両端の問題数（1・100）は問題数の形では弾かれず、テストが作られる', async () => {
    for (const size of [1, 100]) {
      await expectCreated({ kind: 'field', field: 'テクノロジ系', size })
    }
  })

  // @covers REQ-243#kind-or-type-malformed
  it('種別が無い・知らない種別・問題数が整数でないときは、同じ種別が作れる状態でも 400', async () => {
    await expectCreated({ kind: 'field', field: 'テクノロジ系', size: 20 })
    // 範囲を取らない種別（復習）も作れる状態にしておく。これが無いと、種別の決めの値の検証を
    // 外した要求が復習の経路に落ちて 0 件の 400 になり、検証を外しても緑のままになる
    await expectCreated({ kind: 'review', size: 20 })
    // {} ＝ 種別が必須であること、{ kind: 'nope' } ＝ 種別が決めの値だけであること、
    // size: '20' ＝ 問題数が整数であること、を外すと通ってしまう入力
    for (const body of [{}, { kind: 'nope' }, { kind: 'field', field: 'テクノロジ系', size: '20' }]) {
      await expectRejected(body)
    }
  })

  // @covers REQ-243#scope-missing-for-kind
  it('種別に対応する範囲が無いときは、範囲を添えれば作れる状態でも 400（弱点復習に落ちない）', async () => {
    await expectCreated({ kind: 'drill', topicId: 2 })
    await expectCreated({ kind: 'field', field: 'テクノロジ系' })
    await expectCreated({ kind: 'middle', middleNo: 23 })
    // 偽の D1 は範囲の値で絞らないので、形が正しければ当ての無い範囲でも作れる
    // ＝ 下で見える 400 は形の検証だけが出している（出題できる問題が無い 400 ではない）
    await expectCreated({ kind: 'drill', topicId: 9999 })
    await expectCreated({ kind: 'field', field: '当ての無い分野' })
    // 範囲を取らない種別（復習）が作れることも確かめる。範囲の無い要求が復習の経路に
    // 落ちたら 201 になる状態にしてから 400 を見るので、種別→範囲の検証を外せば赤になる
    await expectCreated({ kind: 'review', size: 20 })
    // 種別と範囲の対応（種別ごとに範囲が必須であること）を外すと通ってしまう入力
    for (const body of [{ kind: 'drill' }, { kind: 'field' }, { kind: 'middle' }]) {
      await expectRejected(body)
    }
  })

  // @covers REQ-243#scope-value-malformed
  it('範囲の値そのものが形を外れる（論点番号・単元番号が 1 未満、分野が空）ときは、形の正しい同じ種別が作れる状態でも 400', async () => {
    await expectCreated({ kind: 'drill', topicId: 2 })
    await expectCreated({ kind: 'middle', middleNo: 23 })
    await expectCreated({ kind: 'field', field: 'テクノロジ系' })
    // 形が正しければ当ての無い範囲でも作れる（下の 400 は 0 件の 400 ではない）
    await expectCreated({ kind: 'drill', topicId: 9999 })
    await expectCreated({ kind: 'middle', middleNo: 9999 })
    // 論点番号・単元番号の下限（1 以上）と、分野の空でないこと（最小の長さ 1）を
    // 外すと通ってしまう入力
    for (const body of [
      { kind: 'drill', topicId: 0 },
      { kind: 'drill', topicId: -1 },
      { kind: 'middle', middleNo: 0 },
      { kind: 'field', field: '' },
    ]) {
      await expectRejected(body)
    }
  })
})
