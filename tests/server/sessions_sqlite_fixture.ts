/** テストの経路（UC-004 の契約 startSession・getCurrentQuestion・answerQuestion・finishSession・getSessionResult。
 *  模試も同じ経路）を、migrations を当てた本物の SQLite（node:sqlite を D1 の口で包んだ
 *  tests/portal/repay_UC-014_sqlite_d1.ts）に向けて叩くための土台。
 *
 *  SQL の形を真似る偽物と違い、サーバが発行する SQL をそのまま SQLite が実行するので、
 *  「テストも出題も残らない」「同時に届いた 2 つの回答のうち 1 件だけが残る」のような、
 *  書き込みの成否と読み戻しで決まる振る舞いを、実装の SQL の書き方に依らずに観測できる。
 *  テストの行は契約の操作（startSession）で作り、時刻や失敗の仕込みだけを SQLite に直接当てる。 */

import type { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import app from '../../src/server/index'
import type { Bindings } from '../../src/server/lib/db'
import { issueToken } from '../../src/server/lib/auth'
import { learningD1, sqliteOf } from '../portal/repay_UC-014_sqlite_d1'

export const SECRET = 'test-secret'
export const USER = 'u-1'
export const OTHER = 'u-2'
export const JAPANESE = /[ぁ-んァ-ヶ一-龥]/

/** 選択肢の記号（契約 answerQuestion の answer の enum）。投入する過去問の正解はどれも「ア」。 */
export const CORRECT = 'ア'
export const WRONG = 'イ'

/** 1 つの学びの配備と、その D1 の中身。 */
export type World = {
  d1: D1Database
  db: DatabaseSync
  learning: string
  /** 回ごとに使った問番号（past_questions は回と問番号の組で一意）。 */
  numbers: Record<string, number>
  /** 分野ごとの論点の ID（分野 1 つにシラバスの項目 1 つと論点 1 つを置く）。 */
  topics: Record<string, number>
}

/** 利用者 2 人だけが居る、空の学びの D1。 */
export async function openWorld(learning = 'ip'): Promise<World> {
  const d1 = await learningD1()
  const db = sqliteOf(d1)
  for (const id of [USER, OTHER])
    db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'x')`).run(id, `${id}@example.com`, id)
  return { d1, db, learning, numbers: {}, topics: {} }
}

/** 分野の論点の ID（無ければシラバスの項目と論点を 1 つずつ作る）。 */
export function topicOf(w: World, field: string): number {
  const found = w.topics[field]
  if (found !== undefined) return found
  const no = Object.keys(w.topics).length + 1
  w.db
    .prepare(
      `INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (?, ?, ?, ?, '大分類', ?, ?)`,
    )
    .run(no, `項目${no}`, field, no, no, `中分類${no}`)
  w.db
    .prepare(`INSERT INTO topics (id, term, syllabus_item_id, question_count) VALUES (?, ?, ?, 0)`)
    .run(no, `論点${no}`, no)
  w.topics[field] = no
  return no
}

/** 回 exam に過去問を count 問入れる。field を渡すとその分野の論点に紐づけ、null なら分野の付いていない過去問にする。
 *  入れた過去問の ID を返す（期待値はこの側から作る）。 */
export function seedQuestions(w: World, exam: string, count: number, field: string | null): string[] {
  const topicId = field === null ? null : topicOf(w, field)
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const n = (w.numbers[exam] = (w.numbers[exam] ?? 0) + 1)
    const id = `${exam}-q${n}`
    w.db
      .prepare(
        `INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, citation, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, exam, exam, n, `${id} の本文`, JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }), CORRECT, `出典：${exam} 問${n}`, `ck-${id}`)
    if (topicId !== null)
      w.db.prepare(`INSERT INTO topic_questions (topic_id, question_id, is_primary) VALUES (?, ?, 1)`).run(topicId, id)
    ids.push(id)
  }
  return ids
}

/** 運用の設定値（app_settings。正本の行は id = 'default'）。 */
export function setSettings(w: World, values: Record<string, number>) {
  const cols = Object.keys(values)
  w.db
    .prepare(`INSERT INTO app_settings (id, ${cols.join(', ')}) VALUES ('default', ${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => values[c]))
}

const env = (w: World) => ({ EXAM: w.learning, JWT_SECRET: SECRET, DB: w.d1 }) as unknown as Bindings

/** 利用者 user として叩く口。トークンを先に作っておくので、同時の要求を同じ瞬間に並べられる。 */
export async function as(w: World, user = USER) {
  const token = await issueToken(SECRET, { id: user, name: '検査', role: 'MEMBER' })
  const send = (method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env(w),
    )
  return {
    start: (body: Record<string, unknown>) => send('POST', '/api/sessions', body),
    current: (id: string) => send('GET', `/api/sessions/${id}/current`),
    answer: (id: string, idx: number, answer: string) => send('POST', `/api/sessions/${id}/answer`, { idx, answer }),
    finish: (id: string) => send('POST', `/api/sessions/${id}/finish`, {}),
    result: (id: string) => send('GET', `/api/sessions/${id}`),
  }
}

export type Created = { id: string; kind: string; scopeLabel: string; questionCount: number; timeLimitSec: number | null }
export type Current = {
  session: Record<string, unknown>
  question: { idx: number; text: string } | null
  answered: number
  remainingSec: number | null
  finished: boolean
  expired?: boolean
}

/** 契約の操作でテストを作り、作れたことを確かめて応答を返す。 */
export async function startOk(w: World, body: Record<string, unknown>, user = USER): Promise<Created> {
  const res = await (await as(w, user)).start(body)
  const text = await res.text()
  if (res.status !== 201) throw new Error(`${JSON.stringify(body)} でテストを作れない（この検査は空振りになる）: ${res.status} ${text}`)
  return JSON.parse(text) as Created
}

/** 現在の問題を取り、取れたことを確かめて応答を返す。 */
export async function currentOk(w: World, id: string, user = USER): Promise<Current> {
  const res = await (await as(w, user)).current(id)
  const text = await res.text()
  if (res.status !== 200) throw new Error(`現在の問題が取れない: ${res.status} ${text}`)
  return JSON.parse(text) as Current
}

/** 現在の問題に回答し、受け付けられたことを確かめる。回答した位置を返す。 */
export async function answerCurrent(w: World, id: string, choice = CORRECT, user = USER): Promise<number> {
  const cur = await currentOk(w, id, user)
  if (!cur.question) throw new Error('現在の問題が無い（この検査の前提が崩れる）')
  const res = await (await as(w, user)).answer(id, cur.question.idx, choice)
  if (res.status !== 200) throw new Error(`回答が受け付けられない: ${res.status} ${await res.text()}`)
  return cur.question.idx
}

/** 契約の ErrorBody（鍵は error と code だけで、日本語の 1 文）か。 */
export async function errorBodyOf(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>
  if (Object.keys(body).sort().join(',') !== 'code,error') throw new Error(`本文が ErrorBody でない: ${JSON.stringify(body)}`)
  if (!JAPANESE.test(String(body.error))) throw new Error(`理由が日本語の文でない: ${JSON.stringify(body)}`)
  return body
}

/** 表の行の数。 */
export const countOf = (w: World, table: string, where = '1 = 1', ...params: (string | number)[]) =>
  Number((w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n)

/** テストの開始時刻（秒）を置き換える。残り時間を「いま」から揺れなく測るための仕込み。 */
export function setStartedAt(w: World, id: string, startedAtSec: number) {
  w.db.prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`).run(startedAtSec, id)
}

/** 時計を ms（ミリ秒）に止めて body を走らせる。サーバの時刻はこの時計で読む。 */
export async function atMs<T>(ms: number, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(ms)
    return await body()
  } finally {
    vi.useRealTimers()
  }
}

type Side = 0 | 1
type Op = <R>(side: Side, op: () => Promise<R>) => Promise<R>

/** 1 つの要求から見た D1 の文。読み書きの 1 回ごとに順番（step）を待つ。batch には包む前の文を渡す。 */
class SteppedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly side: Side,
    private readonly step: Op,
  ) {}
  bind(...values: unknown[]) {
    return new SteppedStatement(this.inner.bind(...values), this.side, this.step)
  }
  first(column?: string) {
    return this.step(this.side, () => (column === undefined ? this.inner.first() : this.inner.first(column)))
  }
  all() {
    return this.step(this.side, () => this.inner.all())
  }
  run() {
    return this.step(this.side, () => this.inner.run())
  }
  raw(options?: { columnNames?: boolean }) {
    return this.step(this.side, () => this.inner.raw(options as { columnNames: true }))
  }
}

/** 2 つの要求を、D1 への読み書きを 1 回ずつ交互に（A の 1 回目・B の 1 回目・A の 2 回目…）通して走らせる。
 *  同じ経路の 2 つの要求は、どちらの書き込みよりも先に両方の読み出しが済む。同期の SQLite に Promise.all で
 *  並べるだけでは 1 つ目の要求が読みと書きを続けて済ませてしまい、「読んでから書くまでの間に別の要求が入る」
 *  順を作れない。片方が応答を返したら、残った側は順番を待たずに進む。 */
export async function interleaved<T>(w: World, runs: [(w: World) => Promise<T>, (w: World) => Promise<T>]): Promise<[T, T]> {
  let turn: Side = 0
  const finished = [false, false]
  const waiting: [(() => void) | null, (() => void) | null] = [null, null]
  const wake = () => {
    const resume = waiting[turn]
    waiting[turn] = null
    resume?.()
  }
  const step: Op = async (side, op) => {
    if (turn !== side && !finished[1 - side]) await new Promise<void>((resolve) => (waiting[side] = resolve))
    try {
      return await op()
    } finally {
      if (!finished[1 - side]) turn = (1 - side) as Side
      wake()
    }
  }
  const viewOf = (side: Side): World => {
    const inner = w.d1
    const d1 = {
      prepare: (sql: string) => new SteppedStatement(inner.prepare(sql), side, step),
      batch: (stmts: SteppedStatement[]) => step(side, () => inner.batch(stmts.map((s) => s.inner))),
      exec: (sql: string) => step(side, () => inner.exec(sql)),
      dump: () => inner.dump(),
    } as unknown as D1Database
    return { ...w, d1 }
  }
  const run = async (side: Side): Promise<T> => {
    try {
      return await runs[side](viewOf(side))
    } finally {
      finished[side] = true
      turn = (1 - side) as Side
      wake()
    }
  }
  return Promise.all([run(0), run(1)]) as Promise<[T, T]>
}
