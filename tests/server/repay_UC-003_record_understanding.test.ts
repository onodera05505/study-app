/** 理解度の記録と、その記録が一覧のおすすめ順・次に学ぶの候補に反映されること（UC-003）。
 *
 *  記録の結果（残る・上書き・本人だけ・残らない）と並びは、空の偽の D1 では観測できないので、
 *  Node 標準の SQLite（node:sqlite）に `migrations/*.sql` を当てた実体を D1 の口（prepare → bind →
 *  run / all / first / raw、batch、exec）で包んで渡す。観測はすべて HTTP の境界で行う:
 *  記録は PUT /api/topics/:id/progress、読み返しは GET /api/topics/:id・GET /api/topics・GET /api/me。
 *  学びの種類は資格対策（EXAM=ip。論点の並びは出題頻度の降順。BR-031）。
 *
 *  論点は ID の順・名前の順・出題頻度の順が互いに一致しないように置く（並びの観測が
 *  どれか 1 つの順でたまたま緑にならないため）。 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

/** node:sqlite の同期 API のうち、ここで使う形だけ（プロジェクトの型は Workers 向けで node の型を持たない）。 */
type Statement = {
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
  run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint }
  setReturnArrays: (on: boolean) => void
}
type DatabaseSync = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void }

/** node の組み込みは実行時に読む（型の解決を通さない）。 */
const nodeModule = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>
const { DatabaseSync } = await nodeModule<{ DatabaseSync: new (path: string) => DatabaseSync }>('node:sqlite')
const { readdirSync, readFileSync } = await nodeModule<{
  readdirSync: (dir: string) => string[]
  readFileSync: (path: string, encoding: 'utf8') => string
}>('node:fs')
const { fileURLToPath } = await nodeModule<{ fileURLToPath: (url: URL) => string }>('node:url')

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

type Row = Record<string, unknown>

/** D1 に束ねられる値を node:sqlite が受ける形にする（真偽値は 0/1、undefined は NULL）。 */
const toParam = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)

/** 実 SQLite を D1 の口で包む。 */
function d1Of(db: DatabaseSync) {
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound.map(toParam)),
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]))
      return { success: true, results: [], meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...(params as never[])), meta: {} }),
    first: async (column?: string) => {
      const row = (db.prepare(sql).get(...(params as never[])) as Row | undefined) ?? null
      return column && row ? row[column] : row
    },
    raw: async () => {
      const s = db.prepare(sql)
      s.setReturnArrays(true)
      return s.all(...(params as never[]))
    },
  })
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: ReturnType<typeof statement>[]) => {
      const out = []
      for (const s of stmts) out.push(await s.all())
      return out
    },
    exec: async (sql: string) => {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
}

/** 空の DB にマイグレーションを当てる（drizzle の区切りで 1 文ずつ）。 */
function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(MIGRATIONS_DIR + file, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) db.exec(stmt)
    }
  }
  return db
}

const SECRET = 'test-secret'
const ME = { id: 'u-1', name: '学ぶ人', role: 'MEMBER' }
const OTHER = { id: 'u-2', name: '別の人', role: 'MEMBER' }

/** 論点。ID の順（A<B<C<D<E）・名前の順・出題頻度の順（B>D>C>A>E）が互いに一致しない。
 *  Z は過去問が 1 件も紐づかない論点。 */
const TOPICS = [
  { id: 101, term: '原価計算', questions: 3 },
  { id: 102, term: '損益分岐点', questions: 9 },
  { id: 103, term: 'ROE', questions: 5 },
  { id: 104, term: 'キャッシュフロー', questions: 7 },
  { id: 105, term: '減価償却', questions: 1 },
  { id: 106, term: '出題の無い論点', questions: 0 },
] as const
const [A, B, C, D, E, Z] = TOPICS.map((t) => t.id)
const WITH_QUESTIONS = TOPICS.filter((t) => t.questions > 0).map((t) => t.id)
const UNKNOWN_TOPIC = 999999

function seed(db: DatabaseSync) {
  for (const u of [ME, OTHER]) {
    db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
      u.id,
      `${u.id}@example.com`,
      u.name,
      '-',
      u.role,
    )
  }
  db.prepare(
    'INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (1, ?, ?, 1, ?, 4, ?)',
  ).run('会計と財務', 'ストラテジ系', '企業と法務', '事業の指標')
  let number = 0
  for (const t of TOPICS) {
    db.prepare(
      'INSERT INTO topics (id, term, syllabus_item_id, is_new, explanation, detail, question_count) VALUES (?, ?, 1, 0, ?, NULL, ?)',
    ).run(t.id, t.term, `${t.term} の短い説明です。`, t.questions)
    for (let i = 0; i < t.questions; i++) {
      number++
      const qid = `2024r06-q${number}`
      db.prepare(
        'INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, has_figure, figure_description, citation, modified, figure_image, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, NULL, ?)',
      ).run(
        qid,
        '2024r06',
        '令和6年度',
        number,
        `問${number} の本文`,
        JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }),
        'ア',
        `令和6年度 問${number}`,
        `ck-${number}`,
      )
      db.prepare('INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)').run(t.id, qid)
    }
  }
}

let db: DatabaseSync
let env: Bindings

beforeEach(() => {
  db = migrated()
  seed(db)
  env = { EXAM: 'ip', JWT_SECRET: SECRET, DB: d1Of(db) } as unknown as Bindings
})

afterEach(() => {
  db.close()
})

type Who = typeof ME

async function headersFor(who: Who) {
  const token = await issueToken(SECRET, who)
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

/** recordUnderstanding。本文は形を外した値も送れるように unknown。 */
async function record(topicId: number | string, body: unknown, who: Who = ME) {
  return app.request(
    `/api/topics/${topicId}/progress`,
    { method: 'PUT', headers: await headersFor(who), body: JSON.stringify(body) },
    env,
  )
}

async function getJson<T>(path: string, who: Who = ME): Promise<T> {
  const res = await app.request(path, { headers: await headersFor(who) }, env)
  expect(res.status, `GET ${path} が ${res.status}: ${await res.clone().text()}`).toBe(200)
  return (await res.json()) as T
}

type Detail = { topic: { id: number; status: number | null }; nextTopic: { id: number; term: string } | null }
type Listed = { id: number; status: number | null; questionCount: number }
type Me = { topics: { total: number; understood: number; partly: number }; nextTopics: { id: number; questionCount: number }[] }

/** 論点の画面が示す理解度（getTopicDetail の topic.status）。 */
const detailStatus = async (topicId: number, who: Who = ME) =>
  (await getJson<Detail>(`/api/topics/${topicId}`, who)).topic.status
/** 論点の一覧の行が示す理解度（listTopics の status）。 */
async function listedStatus(topicId: number, who: Who = ME) {
  const { topics } = await getJson<{ topics: Listed[] }>('/api/topics', who)
  const row = topics.find((t) => t.id === topicId)
  expect(row, `論点 ${topicId} が一覧に無い`).toBeDefined()
  return row!.status
}
/** ホームの集計（getHomeSummary の topics）。 */
const counts = async (who: Who = ME) => (await getJson<Me>('/api/me', who)).topics

/** 記録の表に残っている (利用者, 論点) の行の数。保存先の正本（schema）の progress 表で見る。 */
const storedRows = (userId: string, topicId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND topic_id = ?').get(userId, topicId) as { n: number }).n

describe('理解度の記録が残ること（UC-003）', () => {
  // @covers REQ-034#record-chosen-stage
  it('3 段階のいずれかを選ぶと、その論点の理解度がその段階になり、論点の画面と一覧の行の両方で読める', async () => {
    for (const [topicId, status] of [
      [A, 1],
      [C, 2],
      [E, 3],
    ] as const) {
      const res = await record(topicId, { status })
      expect(res.status, `status=${status} の記録が ${res.status}: ${await res.clone().text()}`).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, status })
      expect(await detailStatus(topicId), `論点の画面の理解度が status=${status} でない`).toBe(status)
      expect(await listedStatus(topicId), `一覧の行の理解度が status=${status} でない`).toBe(status)
    }
    // 記録していない論点は記録なしのまま
    expect(await detailStatus(B)).toBeNull()
  })

  // @covers REQ-034#overwrite-keeps-last
  it('同じ論点に続けて記録が届くと、最後に届いた段階だけが残る（以前の段階は集計にも残らない）', async () => {
    for (const status of [3, 2, 1]) expect((await record(B, { status })).status).toBe(200)
    expect(await detailStatus(B)).toBe(1)
    expect(await listedStatus(B)).toBe(1)
    // 以前の「理解」「やや理解」が集計に残っていない
    expect(await counts()).toMatchObject({ understood: 0, partly: 0 })
    expect(storedRows(ME.id, B), '同じ論点の記録が 2 件以上残っている').toBe(1)

    // もう一度「理解」にすると、集計もそれだけになる
    expect((await record(B, { status: 3 })).status).toBe(200)
    expect(await detailStatus(B)).toBe(3)
    expect(await counts()).toMatchObject({ understood: 1, partly: 0 })
    expect(storedRows(ME.id, B)).toBe(1)
  })

  // @covers REQ-035#owner-only
  it('記録は求めた本人の理解度としてだけ残り、別の利用者の同じ論点の理解度は変わらない', async () => {
    expect((await record(B, { status: 3 }, ME)).status).toBe(200)
    expect(await detailStatus(B, OTHER), '本人でない利用者の論点の画面に本人の記録が見える').toBeNull()
    expect(await listedStatus(B, OTHER)).toBeNull()
    expect(await counts(OTHER)).toMatchObject({ understood: 0, partly: 0 })
    expect(storedRows(OTHER.id, B)).toBe(0)

    // 別の利用者が同じ論点に記録しても、本人の記録は変わらない
    expect((await record(B, { status: 1 }, OTHER)).status).toBe(200)
    expect(await detailStatus(B, ME)).toBe(3)
    expect(await detailStatus(B, OTHER)).toBe(1)
    expect(await counts(ME)).toMatchObject({ understood: 1, partly: 0 })
  })

  // @covers REQ-036#no-change-on-reject
  it('3 段階の外の値で断られたあとも、その論点の理解度は要求の前の段階のまま', async () => {
    expect((await record(B, { status: 2 })).status).toBe(200)
    for (const body of [{ status: 0 }, { status: 4 }, { status: 'りかい' }, {}]) {
      const res = await record(B, body)
      expect(res.status, `本文 ${JSON.stringify(body)} が 400 にならない`).toBe(400)
      expect(await detailStatus(B), `本文 ${JSON.stringify(body)} のあとに理解度が変わった`).toBe(2)
    }
    expect(await counts()).toMatchObject({ understood: 0, partly: 1 })

    // 記録の無い論点は、断られたあとも記録なしのまま
    expect((await record(A, { status: 4 })).status).toBe(400)
    expect(await detailStatus(A)).toBeNull()
    expect(storedRows(ME.id, A)).toBe(0)
  })

  // @covers REQ-037#unknown-topic-not-found
  it('存在しない論点への記録は、見つからないこととして断られる', async () => {
    const res = await record(UNKNOWN_TOPIC, { status: 3 })
    expect(res.status).toBe(404)
    const data = (await res.json()) as { error?: unknown; ok?: unknown }
    expect(typeof data.error).toBe('string')
    expect(data.ok).toBeUndefined()
  })

  // @covers REQ-037#nothing-recorded-for-unknown-topic
  it('存在しない論点への記録を断ったあと、理解度はどこにも残らない', async () => {
    const before = await counts()
    for (const status of [1, 2, 3]) expect((await record(UNKNOWN_TOPIC, { status })).status).toBe(404)
    expect(storedRows(ME.id, UNKNOWN_TOPIC), '存在しない論点に理解度の行が残っている').toBe(0)
    expect(await counts()).toEqual(before)
    // 在る論点の理解度にも影響しない
    for (const id of WITH_QUESTIONS) expect(await detailStatus(id)).toBeNull()
  })
})

describe('おすすめ順の一覧（UC-003）', () => {
  /** B=理解・D=やや理解・A=未理解、C と E は記録なし（未理解として扱う。BR-029）。 */
  async function recordMixed() {
    expect((await record(B, { status: 3 })).status).toBe(200)
    expect((await record(D, { status: 2 })).status).toBe(200)
    expect((await record(A, { status: 1 })).status).toBe(200)
  }
  const recommended = async () =>
    (await getJson<{ topics: Listed[] }>('/api/topics?sort=recommended')).topics.filter((t) =>
      (WITH_QUESTIONS as readonly number[]).includes(t.id),
    )

  // @covers REQ-042#understood-not-removed
  it('理解にした論点も、おすすめ順の一覧から除かれない', async () => {
    await recordMixed()
    const ids = (await recommended()).map((t) => t.id)
    expect(ids, '理解にした論点が一覧から消えている').toContain(B)
    expect(new Set(ids)).toEqual(new Set(WITH_QUESTIONS))
  })

  // @covers REQ-042#low-understanding-first
  it('理解度の低い論点が先に並ぶ（記録の無い論点は未理解として並ぶ）', async () => {
    await recordMixed()
    const stages = (await recommended()).map((t) => t.status ?? 1)
    for (let i = 1; i < stages.length; i++)
      expect(stages[i], `並び ${stages.join(',')} の ${i} 番目で理解度が下がっている`).toBeGreaterThanOrEqual(stages[i - 1])
    expect(stages).toEqual([1, 1, 1, 2, 3])
  })

  // @covers REQ-042#same-stage-follows-learning-type
  it('同じ理解度の中は、資格対策の並び（出題頻度の降順）に従う', async () => {
    await recordMixed()
    const unlearned = (await recommended()).filter((t) => (t.status ?? 1) === 1)
    // C(5 問) → A(3 問) → E(1 問)。ID の順（A, C, E）でも名前の順でもない
    expect(unlearned.map((t) => t.id)).toEqual([C, A, E])
  })
})

describe('次に学ぶの候補（UC-003）', () => {
  // @covers REQ-043#only-topics-with-questions
  it('過去問が紐づかない論点は候補に入らない', async () => {
    const { nextTopics } = await getJson<Me>('/api/me')
    expect(nextTopics.length, '候補が 1 件も無い（この検査は空振りになる）').toBeGreaterThan(0)
    expect(nextTopics.map((t) => t.id), '過去問の無い論点が候補に入っている').not.toContain(Z)
    for (const t of nextTopics) {
      expect(WITH_QUESTIONS, `候補 ${t.id} は過去問の紐づく論点でない`).toContain(t.id)
      expect(t.questionCount).toBeGreaterThanOrEqual(1)
    }
  })

  // @covers REQ-043#order-follows-learning-type
  it('候補は、理解にした論点を除いた上で、資格対策の並び（出題頻度の降順）で返る', async () => {
    expect((await record(B, { status: 3 })).status).toBe(200)
    expect((await record(D, { status: 2 })).status).toBe(200)
    const { nextTopics } = await getJson<Me>('/api/me')
    // D(7 問・やや理解) → C(5 問) → A(3 問) → E(1 問)。B は理解にしたので入らない
    expect(nextTopics.map((t) => t.id)).toEqual([D, C, A, E])
  })

  // @covers REQ-045#excludes-current-topic
  it('論点の画面に添える候補の先頭は、いま開いている論点自身を除いたものになる', async () => {
    // 記録なし: 候補の先頭は出題頻度が最も高い B
    const onB = await getJson<Detail>(`/api/topics/${B}`)
    expect(onB.nextTopic, '候補があるのに添えられていない').not.toBeNull()
    expect(onB.nextTopic!.id, 'いま開いている論点自身が次に学ぶになっている').not.toBe(B)
    expect(onB.nextTopic!.id).toBe(D)
    // B 以外の論点を開いているときは、先頭の B がそのまま添えられる
    const onD = await getJson<Detail>(`/api/topics/${D}`)
    expect(onD.nextTopic?.id).toBe(B)
  })
})
