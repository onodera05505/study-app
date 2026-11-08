import { describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** 入力の検証（出題を組む前に弾く所）だけを叩く。演習の種別（UC-004）と模試の種別（UC-008）は
 *  同じ経路を通るので、describe を種別で分けて持つ。
 *  出題の中身（進行中が既にある 409・範囲に過去問が無い 404）は本物のデータが要るので
 *  scripts/check_api.py が本番相当で見る。
 *
 *  偽の D1 は過去問の行を持つ（finished_session.test.ts の作法）。空の D1 だと
 *  形の正しい要求も「出題できる問題がありません」で断られ、形の検証が無くても
 *  テストが作られない（偽の緑）。各クラスの検査は、まず同じ種別の形の正しい要求が 201 で
 *  作れることを確かめてから、形の誤りだけが 400 になることを見る。
 *  作られたかどうかは sessions への INSERT の数で見る。INSERT は run でも batch（1 つの
 *  トランザクション）でも記録する。 */
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

/** 列名で持った行を返す偽の D1（prepare → bind → raw/all/first/run、batch）。
 *  走らせた SQL を `executed` に記録する。テストが作られていないことを
 *  「sessions への INSERT が 1 件も無い」で見るのに使う。 */
function fakeD1(tables: Table[], executed: string[] = []) {
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
      sql,
      bind: (...bound: unknown[]) => {
        params = bound
        return stmt
      },
      run: async () => {
        executed.push(sql)
        return { success: true, results: [], meta: {} }
      },
      all: async () => ({ success: true, results: rowsFor(sql, params), meta: {} }),
      first: async () => rowsFor(sql, params)[0] ?? null,
      raw: async () => {
        const names = selectNames(sql)
        return rowsFor(sql, params).map((row) => names.map((name) => (name in row ? row[name] : null)))
      },
    }
    return stmt
  }
  /** D1 の batch（1 つのトランザクション）。渡された文を順に、run と同じく記録して当てる。
   *  読み出しの文は all と同じ行を返す。 */
  const batch = async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => {
    const out: unknown[] = []
    for (const s of stmts) out.push(/^\s*(select|with)\b/i.test(s.sql) ? await s.all() : await s.run())
    return out
  }
  return { prepare, batch, exec: async () => ({ count: 0, duration: 0 }) }
}

/** 偽の D1 が過去問を持つ回の ID（回を指定した要求もこの値を使う）。 */
const EXAM_ID = '2024r06'

/** 範囲に合う過去問 1 問ぶんの行（列の別名は session-builder の QuestionRow のまま）。
 *  範囲を絞る列（論点・分野・単元）は持たせない。持たせると範囲の値を外した要求が
 *  「出題できる問題が 1 問も無い」で断られ、形の検証を外してもテストが作られない（偽の緑）。 */
const question = (n: number): Row => ({
  id: `q-${n}`,
  exam: EXAM_ID,
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

/** 回の指定の形を外れた値（空の ID・文字列でない値）を、そのまま回の列に当てても 1 問は引ける行。
 *  これが無いと、形を外れた回の指定が「その回に出題できる問題が 1 問も無い」で断られ、
 *  回の指定の形の検証（最小の長さ 1・文字列）を外してもテストが作られない（偽の緑）。 */
const MALFORMED_EXAM_ROWS: Row[] = [
  { ...question(101), exam: '' },
  { ...question(102), exam: '12345' },
]

/** 上限（100 問）まで組めるだけの過去問と、範囲の名前の引き当て。
 *  弱点復習（kind review）は範囲の列で絞る経路を通らず、誤答の記録（session_questions の
 *  result = 2）と理解度の記録（progress の status）から出題を組むので、その 2 本にも行を持たせる。
 *  行が無いと形の正しい `{ kind: 'review' }` が「出題できる問題がありません」で断られ、
 *  形の検証（種別→範囲）を外した要求が復習の経路に落ちてもテストが作られない（偽の緑）。
 *  SQL の目印は session-builder.test.ts と同じ: 誤答＝MAX(sq.answered_at) の集約、
 *  出題回数の数え直し＝content_key AS contentKey、理解度＝progress と status。 */
const TABLES: Table[] = [
  {
    match: /SELECT DISTINCT q\.id/i,
    rows: [...Array.from({ length: 100 }, (_, i) => question(i + 1)), ...MALFORMED_EXAM_ROWS],
  },
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
const env = (executed: string[] = []) =>
  ({ EXAM: 'ip', JWT_SECRET: SECRET, DB: fakeD1(TABLES, executed) } as unknown as Bindings)

async function post(path: string, body: unknown, executed: string[] = []) {
  const token = await issueToken(SECRET, { id: 'u-1', name: '検査', role: 'MEMBER' })
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env(executed),
  )
}

/** sessions への INSERT（テストの行が作られたこと）だけを取り出す。 */
const sessionInserts = (executed: string[]) => executed.filter((sql) => /insert into "sessions"/i.test(sql))

/** 形の正しい要求が 201 で作れること（＝偽の D1 が過去問を渡せていること）の確認。
 *  これを欠くと、形の検証を外しても出題できる問題が無い断りと区別できず空振りの緑になる。 */
async function expectCreated(body: unknown) {
  const executed: string[] = []
  const res = await post('/api/sessions', body, executed)
  expect(res.status, `形の正しい ${JSON.stringify(body)} が作れない（この検査は空振りになる）`).toBe(201)
  const payload = (await res.json()) as { id?: unknown; questionCount?: unknown }
  expect(typeof payload.id).toBe('string')
  expect(payload.questionCount).toBeGreaterThan(0)
  expect(sessionInserts(executed), `${JSON.stringify(body)} でテストの行が作られていない`).toHaveLength(1)
}

/** 形を外れた要求が、テストを作らず理由を示して断られること。
 *  文言そのものは照合しない（理由の文の正本はコード。R-102）。 */
async function expectRejected(body: unknown) {
  const executed: string[] = []
  const res = await post('/api/sessions', body, executed)
  expect(res.status, `${JSON.stringify(body)} が通ってしまう`).toBe(400)
  const payload = (await res.json()) as { error?: unknown; id?: unknown }
  expect(typeof payload.error).toBe('string')
  expect(String(payload.error).length).toBeGreaterThan(0)
  expect(payload.id, `${JSON.stringify(body)} でテストが作られている`).toBeUndefined()
  expect(sessionInserts(executed), `${JSON.stringify(body)} でテストの行が作られている`).toEqual([])
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
    // 外した要求が復習の経路に落ちて 0 件で断られ、検証を外してもテストが作られない
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
    // ＝ 下で見える 400 は形の検証だけが出している（出題できる問題が無い断りではない）
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
    // 形が正しければ当ての無い範囲でも作れる（下の 400 は 0 件の断りではない）
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

describe('POST /api/sessions の入力の検証（模試。UC-008）', () => {
  // @covers REQ-247#size-out-of-range
  it('ランダム構成の問数が 1 未満・100 超なら、形の正しい模試が作れる状態でもテストを作らず 400', async () => {
    await expectCreated({ kind: 'mock', size: 20 })
    for (const size of [0, -1, 101, 1000]) {
      await expectRejected({ kind: 'mock', size })
    }
  })

  // @covers REQ-247#size-at-bounds
  it('ランダム構成の問数が範囲の両端（1・100）なら、問数の形では弾かれずテストが作られる', async () => {
    for (const size of [1, 100]) {
      await expectCreated({ kind: 'mock', size })
    }
  })

  // @covers REQ-247#kind-or-type-malformed
  it('種別が決めの値でない・問数が整数でないときは、形の正しい模試が作れる状態でもテストを作らず 400', async () => {
    await expectCreated({ kind: 'mock', size: 20 })
    // 同じ経路が持つ演習の種別（drill・field・middle）は形を満たす側で、REQ-243 の領域。
    // ここは模試の契約の決めの値を外した種別と、問数の型を外した値だけを渡す
    for (const body of [
      { kind: 'mocks', size: 20 },
      { kind: 'mock', size: '20' },
      { kind: 'mock', size: 20.5 },
      { kind: 'mock', size: null },
    ]) {
      await expectRejected(body)
    }
  })

  // @covers REQ-247#exam-malformed
  it('回の指定が空の ID・文字列でない値のときは、その値で 1 問は引ける状態でもテストを作らず 400', async () => {
    await expectCreated({ kind: 'mock', exam: EXAM_ID })
    // 偽の D1 は '' と '12345' の回にも 1 問ずつ持つ。形を満たす '12345' が作れることが、
    // 下の 400 を出しているのが形の検証だけであること（「その回に出題できる問題が 1 問も無い」の
    // 断りではないこと）の裏づけになる
    await expectCreated({ kind: 'mock', exam: '12345' })
    for (const body of [{ kind: 'mock', exam: '' }, { kind: 'mock', exam: 12345 }]) {
      await expectRejected(body)
    }
  })
})
