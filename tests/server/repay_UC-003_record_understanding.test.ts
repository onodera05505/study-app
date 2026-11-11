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

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'

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

  /** 理解にした論点（status=3）か。記録なし・未理解・やや理解はまだ理解していない論点（BR-029・BR-030）。 */
  const isUnderstood = (t: Listed) => t.status === 3

  // @covers REQ-042#not-understood-first
  it('まだ理解していない論点（未理解・やや理解・記録なし）がすべて先に、理解にした論点がすべて最後に並ぶ', async () => {
    // 理解にしたのは出題頻度の最も高い B。頻度の順のままなら先頭に来る論点を選ぶ
    await recordMixed()
    const listed = await recommended()
    const firstUnderstood = listed.findIndex(isUnderstood)
    expect(firstUnderstood, '理解にした論点が一覧に無い（この検査は空振りになる）').toBeGreaterThanOrEqual(0)
    expect(
      listed.slice(firstUnderstood).every(isUnderstood),
      `理解にした論点のあとに、まだ理解していない論点がある: ${listed.map((t) => `${t.id}(${t.status})`).join(',')}`,
    ).toBe(true)
    expect(firstUnderstood, '理解にした論点がまだ理解していない論点より前にある').toBe(listed.length - 1)
    expect(listed[firstUnderstood].id).toBe(B)
  })

  // @covers REQ-042#not-understood-one-order
  it('まだ理解していない論点は、未理解とやや理解を分けず、資格対策の並び（出題頻度の降順）の 1 つの並びになる', async () => {
    // 記録が 1 つも無い: 全件がまだ理解していない論点で、出題頻度の降順 B(9)→D(7)→C(5)→A(3)→E(1)
    expect((await recommended()).map((t) => t.id)).toEqual([B, D, C, A, E])

    // 未理解の B(9)・やや理解の D(7)・記録なしの C(5) と A(3)・やや理解の E(1) が、出題頻度の降順の 1 つの並びになる
    // （未理解とやや理解を分けると B,C,A,D,E になる）
    expect((await record(B, { status: 1 })).status).toBe(200)
    expect((await record(D, { status: 2 })).status).toBe(200)
    expect((await record(E, { status: 2 })).status).toBe(200)
    expect((await recommended()).map((t) => t.id)).toEqual([B, D, C, A, E])
  })

  // @covers REQ-042#understood-follow-learning-type
  it('理解にした論点どうしも、最後の塊の中で資格対策の並び（出題頻度の降順）に従う', async () => {
    // 理解にするのを A(3)・C(5)・D(7) の順で記録する。ID の順（A,C,D）・名前の順（C,D,A）・記録した順（A,C,D）の
    // どれとも違う出題頻度の降順 D→C→A になる
    for (const id of [A, C, D]) expect((await record(id, { status: 3 })).status).toBe(200)
    expect((await recommended()).map((t) => t.id)).toEqual([B, E, D, C, A])

    // 全件を理解にしても、除かれずに出題頻度の降順のまま
    for (const id of [B, E]) expect((await record(id, { status: 3 })).status).toBe(200)
    expect((await recommended()).map((t) => t.id)).toEqual([B, D, C, A, E])
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

describe('整数として読めない論点の ID（UC-003）', () => {
  // @covers REQ-268#non-integer-id-rejected
  it('論点の ID が整数として読めない求めは受け付けず、先頭の数字だけなら在る論点になる表記でも理解度を残さない', async () => {
    for (const id of ['abc', `${B}abc`, `${B}.5`]) {
      const res = await record(id, { status: 3 })
      expect(res.status, `ID「${id}」の求めが 400 にならない`).toBe(400)
      const data = (await res.json()) as { error?: unknown; ok?: unknown }
      expect(typeof data.error, `ID「${id}」の断りに理由が無い`).toBe('string')
      expect(data.ok).toBeUndefined()
    }
    expect(await detailStatus(B), '整数として読めない ID の求めで、先頭の数字の論点に理解度が残った').toBeNull()
    expect(storedRows(ME.id, B)).toBe(0)
    expect(await counts()).toMatchObject({ understood: 0, partly: 0 })
  })

  // @covers REQ-268#before-not-found
  it('整数として読めず、その ID の論点も無いことになる求めは、見つからないではなく受け付けないとして断る', async () => {
    for (const id of ['abc', `${UNKNOWN_TOPIC}x`]) {
      const res = await record(id, { status: 3 })
      expect(res.status, `ID「${id}」が受け付けの拒み（400）より先に見つからない（404）になっている`).toBe(400)
    }
  })
})

/* ---------- ホームの集計（getHomeSummary） ---------- */

type Visits = { today: string; streak: number; longest: number; total: number }
type Recent = {
  id: string
  kind: string
  scopeLabel: string
  questionCount: number
  correctCount: number | null
  finishedAt: number | null
}
type Summary = { visits: Visits; recentSessions: Recent[] }

/** ホームの集計を求める（それ自体が本人として学びを使うことになる）。 */
const summary = async (who: Who = ME) => getJson<Summary>('/api/me', who)

/** 本人として学びを使い、そのあとに読み返したホームの集計。 */
async function useThenSummary(who: Who = ME) {
  await summary(who)
  return summary(who)
}

/** 'YYYY-MM-DD' の暦日から n 日前の暦日。 */
function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** 学びを開いた日の記録を前の日に置く（保存先の正本は schema の daily_visits 表）。 */
function visitedOn(userId: string, ...days: string[]) {
  for (const day of days) db.prepare('INSERT INTO daily_visits (user_id, day) VALUES (?, ?)').run(userId, day)
}

/** 応答の今日（日本時間の暦日）。 */
const today = async () => (await summary()).visits.today

describe('学びを開いた日の記録（UC-003）', () => {
  // @covers REQ-270#first-use-of-day
  it('記録がまだ無い状態で本人として学びを使うと、その日が 1 件記録される', async () => {
    const { visits } = await useThenSummary()
    expect(visits.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(visits.total, '使った日が記録されていない').toBe(1)
    expect(visits.streak).toBe(1)
  })

  // @covers REQ-270#same-day-again
  it('同じ日に重ねて使っても、その日の記録は 1 件のまま', async () => {
    await summary()
    await getJson('/api/topics')
    await getJson(`/api/topics/${B}`)
    await summary()
    const { visits } = await summary()
    expect(visits.total, '同じ日の記録が 2 件以上になっている').toBe(1)
    expect(visits.streak).toBe(1)
    expect(visits.longest).toBe(1)
  })

  // @covers REQ-270#next-day
  it('前の日の記録があり今日の記録が無い状態で使うと、前の日を残したまま今日が 1 件増える', async () => {
    const day = await today()
    db.prepare('DELETE FROM daily_visits WHERE user_id = ?').run(ME.id)
    visitedOn(ME.id, daysBefore(day, 1))
    const { visits } = await useThenSummary()
    expect(visits.total, '前の日の記録が消えたか、今日が増えていない').toBe(2)
    expect(visits.streak).toBe(2)
  })
})

describe('連続記録と開いた日数（UC-003）', () => {
  // @covers REQ-271#today-only
  it('開いた日が今日だけなら、連続記録・最も長い連続記録・開いた日数の合計はいずれも 1', async () => {
    const { visits } = await useThenSummary()
    expect({ streak: visits.streak, longest: visits.longest, total: visits.total }).toEqual({ streak: 1, longest: 1, total: 1 })
  })

  // @covers REQ-271#consecutive-days
  it('今日に続く途切れの無い記録なら、連続記録と合計がその日数になる', async () => {
    const day = await today()
    visitedOn(ME.id, daysBefore(day, 1), daysBefore(day, 2), daysBefore(day, 3))
    const { visits } = await useThenSummary()
    expect({ streak: visits.streak, longest: visits.longest, total: visits.total }).toEqual({ streak: 4, longest: 4, total: 4 })
  })

  // @covers REQ-271#broken-streak
  it('間に開いていない日があれば、連続記録は今日に続く分だけで、最も長い連続記録は過去の分が残り、合計はすべての日数', async () => {
    const day = await today()
    // 今日・1 日前（今日に続く 2 日）／4〜7 日前（過去の 4 日連続）。2・3 日前は開いていない
    visitedOn(ME.id, daysBefore(day, 1), ...[4, 5, 6, 7].map((n) => daysBefore(day, n)))
    const { visits } = await useThenSummary()
    expect({ streak: visits.streak, longest: visits.longest, total: visits.total }).toEqual({ streak: 2, longest: 4, total: 6 })
    // 他の利用者の記録は数えない
    visitedOn(OTHER.id, daysBefore(day, 2), daysBefore(day, 3))
    expect((await summary()).visits).toMatchObject({ streak: 2, longest: 4, total: 6 })
  })
})

describe('ホームの集計の最近の結果（UC-003）', () => {
  const STARTED = 1_760_000_000

  /** 締めたテストの行（保存先の正本は schema の sessions 表）。n が大きいほど新しく締めた。 */
  function finishedSession(n: number, over: Row = {}) {
    const row: Row = {
      id: `done-${String(n).padStart(3, '0')}`,
      user_id: ME.id,
      kind: 'drill',
      status: 'completed',
      source_exam: null,
      scope_label: `論点「損益分岐点」${n}`,
      time_limit_sec: null,
      question_count: 10,
      correct_count: n % 10,
      started_at: STARTED,
      finished_at: STARTED + 600 + n * 60,
      ...over,
    }
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...(cols.map((c) => toParam(row[c])) as never[]),
    )
    return row
  }

  /** 最近の結果の上限（契約の getHomeSummary の応答の recentSessions.maxItems）。 */
  function limitFromContract(): number {
    const yaml = readFileSync(
      new URL('../../docs/goals/GOAL-01-learn-topics/UC-003-record-understanding/contract.yaml', import.meta.url),
      'utf8',
    )
    const m = /recentSessions:\s*\n\s*type:\s*array\s*\n\s*maxItems:\s*(\d+)/.exec(yaml)
    if (!m) throw new Error('契約に最近の結果の上限（recentSessions.maxItems）が無い')
    return Number(m[1])
  }

  /** 受験履歴の一覧（UC-007 の契約の listExamHistory）の並び。 */
  const historyIds = async (who: Who = ME) =>
    (await getJson<{ sessions: { id: string }[] }>('/api/sessions', who)).sessions.map((s) => s.id)

  // @covers REQ-272#fields-attached
  it('完了した受験があれば、各件にテストの種別・範囲の名前・問題数・正答数・締めた時刻を添えて返す', async () => {
    const row = finishedSession(1, { kind: 'mock', scope_label: '令和6年度 春期', question_count: 100, correct_count: 72 })
    const { recentSessions } = await summary()
    expect(recentSessions).toHaveLength(1)
    expect(recentSessions[0]).toMatchObject({
      id: row.id,
      kind: 'mock',
      scopeLabel: '令和6年度 春期',
      questionCount: 100,
      correctCount: 72,
      finishedAt: row.finished_at,
    })
  })

  // @covers REQ-272#no-sessions
  it('受験履歴が無ければ、最近の結果は空で返る', async () => {
    expect((await summary()).recentSessions).toEqual([])
  })

  // @covers REQ-272#capped-at-limit
  it('決めた件数ちょうどなら全件を、それを超えれば受験履歴の先頭から決めた件数までを返す', async () => {
    const limit = limitFromContract()
    for (let n = 1; n <= limit; n++) finishedSession(n)
    const atLimit = (await summary()).recentSessions.map((s) => s.id)
    expect(atLimit, '決めた件数ちょうどの履歴が全件返っていない').toHaveLength(limit)
    expect(atLimit).toEqual((await historyIds()).slice(0, limit))

    finishedSession(limit + 1)
    const over = (await summary()).recentSessions.map((s) => s.id)
    expect(over, '決めた件数で止まっていない').toHaveLength(limit)
    expect(over, '受験履歴の先頭からの件になっていない').toEqual((await historyIds()).slice(0, limit))
    expect(over, '最も新しく締めた受験が入っていない').toContain(`done-${String(limit + 1).padStart(3, '0')}`)
    expect(over, '最も古い受験が切り取られていない').not.toContain('done-001')
  })

  // @covers REQ-272#own-history-only
  it('他の利用者の受験履歴があっても、本人の分だけを返す', async () => {
    finishedSession(1)
    finishedSession(2, { id: 'other-002', user_id: OTHER.id, scope_label: '別の人のテスト' })
    const { recentSessions } = await summary()
    expect(recentSessions.map((s) => s.id)).toEqual(['done-001'])
    expect((await summary(OTHER)).recentSessions.map((s) => s.id)).toEqual(['other-002'])
  })

  // @covers REQ-272#nameless-session-not-stored
  it('範囲の名前の無い（NULL・空の文字列の）テストは保存されず、最近の結果に範囲の名前の無い件が生まれない', async () => {
    for (const label of [null, '']) {
      expect(
        () => finishedSession(label === null ? 1 : 2, { scope_label: label }),
        `範囲の名前が ${JSON.stringify(label)} のテストが保存された`,
      ).toThrow()
    }
    expect((await summary()).recentSessions).toEqual([])
  })
})
