/** DB で守る決まり（enforced_at が DB の BR）が、DB の制約として効くこと。
 *
 *  アプリの入口は通さず、規則に反する行を DB に直接入れて、DB が断ることを見る。DB は、学び側の DDL（migrations）と
 *  まなびばの DDL（portal/migrations）をそれぞれ流した本物の SQLite（node:sqlite。共通の土台 tests/portal/repay_UC-014_sqlite_d1.ts）。
 *  表と列の名前はスキーマ正本（src/server/db/schema.ts・portal/migrations/0001_init.sql）から取る。
 *  どのテストも、規則に合う行は同じ文で入ることを先に確かめる（入れ方の誤りで断られて通る空振りを防ぐ）。 */

import type { DatabaseSync } from 'node:sqlite'
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../../src/server/db/schema'
import { learningD1, portalD1, sqliteOf } from '../portal/repay_UC-014_sqlite_d1'

const learningDb = async (): Promise<DatabaseSync> => sqliteOf(await learningD1())

/** 小項目 1 つ（単元 21）と、その小項目の論点 2 つ（101・102）を入れる。 */
function seedTopics(db: DatabaseSync) {
  db.prepare(`INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    54,
    '小項目五十四',
    'テクノロジ系',
    3,
    '大分類三',
    21,
    '単元二十一',
  )
  const topic = db.prepare(`INSERT INTO topics (id, term, syllabus_item_id) VALUES (?, ?, ?)`)
  topic.run(101, '論点百一', 54)
  topic.run(102, '論点百二', 54)
}

/** 過去問を 1 つ入れる。 */
const insertQuestion = (db: DatabaseSync, id: string, exam: string, number: number) =>
  db
    .prepare(`INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, citation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, exam, exam, number, `${id} の本文`, JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }), 'ア', `出典：${exam} 問${number}`)

/** 利用者 1 人と、そのテスト 1 つ（範囲の名前を持つ）と、過去問 2 つを入れる。 */
function seedSession(db: DatabaseSync) {
  db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run('u-1', 'u1@example.com', '学ぶ人', '1:s:h')
  insertSession(db, 's-1', '論点「RAID」')
  insertQuestion(db, '2024r06-q1', '2024r06', 1)
  insertQuestion(db, '2024r06-q2', '2024r06', 2)
}

const insertSession = (db: DatabaseSync, id: string, scopeLabel: string | null) =>
  db
    .prepare(`INSERT INTO sessions (id, user_id, kind, status, scope_label, question_count) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, 'u-1', 'drill', 'in_progress', scopeLabel, 2)

const insertSessionQuestion = (db: DatabaseSync, id: string, questionId: string, idx: number, snapshot: string | null) =>
  db
    .prepare(`INSERT INTO session_questions (id, session_id, question_id, idx, snapshot) VALUES (?, ?, ?, ?, ?)`)
    .run(id, 's-1', questionId, idx, snapshot)

const SNAPSHOT = JSON.stringify({ text: '本文', choices: { ア: 'a' }, answer: 'ア', citation: '出典' })

/** 単元 21 の構成（全体像とまとまり 1 つ）を入れる。 */
function seedPlan(db: DatabaseSync) {
  db.prepare(`INSERT INTO unit_plans (middle_no, overview) VALUES (?, ?)`).run(21, '単元二十一の全体像です。')
  insertGroup(db, 1, '土台', '土台のまとまりの説明です。')
}

const insertGroup = (db: DatabaseSync, groupNo: number, name: string, description: string) =>
  db.prepare(`INSERT INTO unit_groups (middle_no, group_no, name, description) VALUES (?, ?, ?, ?)`).run(21, groupNo, name, description)

const insertGroupTopic = (db: DatabaseSync, topicId: number, groupNo: number, position: number) =>
  db.prepare(`INSERT INTO unit_group_topics (topic_id, middle_no, group_no, position) VALUES (?, ?, ?, ?)`).run(topicId, 21, groupNo, position)

describe('DB で守る決まりは、規則に反する行を DB に直接入れると断られる', () => {
  // @covers BR-008
  it('まなびばのアカウントの表に、同じメールアドレスのアカウントを 2 つ目として入れると断られる', async () => {
    const db = sqliteOf(await portalD1())
    const insert = (id: string, email: string) =>
      db.prepare(`INSERT INTO accounts (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run(id, email, `名前${id}`, '1:s:h')
    insert('a-1', 'same@example.com')
    expect(() => insert('a-2', 'other@example.com'), '別のメールアドレスのアカウントが入らない（空振り）').not.toThrow()
    expect(() => insert('a-3', 'same@example.com'), '同じメールアドレスのアカウントが 2 つ目として入った').toThrow()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE email = ?`).get('same@example.com')).toEqual({ n: 1 })
  })

  // @covers BR-020
  it('出題の表に、出題した時点の内容の控え（snapshot）を持たない行を入れると断られる', async () => {
    const db = await learningDb()
    seedSession(db)
    expect(() => insertSessionQuestion(db, 'sq-1', '2024r06-q1', 0, SNAPSHOT), '控えを持つ行が入らない（空振り）').not.toThrow()
    expect(() => insertSessionQuestion(db, 'sq-2', '2024r06-q2', 1, null), '控えを持たない出題の行が入った').toThrow()
  })

  // @covers BR-022
  it('出題の表に、同じテストの同じ位置の行を 2 つ目として入れると断られる', async () => {
    const db = await learningDb()
    seedSession(db)
    insertSessionQuestion(db, 'sq-1', '2024r06-q1', 0, SNAPSHOT)
    expect(() => insertSessionQuestion(db, 'sq-2', '2024r06-q2', 1, SNAPSHOT), '同じテストの別の位置の行が入らない（空振り）').not.toThrow()
    expect(() => insertSessionQuestion(db, 'sq-3', '2024r06-q2', 0, SNAPSHOT), '同じテストの同じ位置の行が 2 つ目として入った').toThrow()
  })

  // @covers BR-040
  it('テストの表に、範囲の名前が無いか空の文字列の行を入れると断られる（場合ごと）', async () => {
    const db = await learningDb()
    seedSession(db)
    expect(() => insertSession(db, 's-ok', '分野「テクノロジ系」'), '範囲の名前を持つテストが入らない（空振り）').not.toThrow()
    expect(() => insertSession(db, 's-null', null), '範囲の名前の無いテストが入った').toThrow()
    expect(() => insertSession(db, 's-empty', ''), '範囲の名前が空の文字列のテストが入った').toThrow()
  })

  // @covers BR-057
  it('単元の構成の表に、1 から数えないまとまりの順・まとまりの中の順か、まとまりの中の 1 つの順に 2 つ目の論点を入れると断られる（場合ごと）', async () => {
    const db = await learningDb()
    seedTopics(db)
    seedPlan(db)
    expect(() => insertGroup(db, 2, '応用', '応用のまとまりの説明です。'), '順 2 のまとまりが入らない（空振り）').not.toThrow()
    expect(() => insertGroup(db, 0, '零', '順 0 のまとまりの説明です。'), 'まとまりの順 0 のまとまりが入った').toThrow()
    expect(() => insertGroupTopic(db, 101, 1, 1), 'まとまりの中の順 1 の論点が入らない（空振り）').not.toThrow()
    expect(() => insertGroupTopic(db, 102, 1, 0), 'まとまりの中の順 0 の論点が入った').toThrow()
    expect(() => insertGroupTopic(db, 102, 1, 1), 'まとまりの中の同じ順に 2 つ目の論点が入った').toThrow()
  })

  // @covers BR-058
  it('単元の構成の表に、空の全体像・まとまりの名前・まとまりの説明か、自分自身を前提にする論点を入れると断られる（場合ごと）', async () => {
    const db = await learningDb()
    seedTopics(db)
    expect(() => db.prepare(`INSERT INTO unit_plans (middle_no, overview) VALUES (?, ?)`).run(22, ''), '空の全体像が入った').toThrow()
    seedPlan(db)
    expect(() => insertGroup(db, 2, '', '名前の無いまとまりの説明です。'), '空のまとまりの名前が入った').toThrow()
    expect(() => insertGroup(db, 3, '説明の無いまとまり', ''), '空のまとまりの説明が入った').toThrow()
    const prerequisite = (topicId: number, prerequisiteId: number) =>
      db.prepare(`INSERT INTO topic_prerequisites (topic_id, prerequisite_topic_id, position) VALUES (?, ?, ?)`).run(topicId, prerequisiteId, 1)
    expect(() => prerequisite(102, 101), '別の論点を前提にする行が入らない（空振り）').not.toThrow()
    expect(() => prerequisite(101, 101), '自分自身を前提にする論点が入った').toThrow()
  })

  // @covers BR-059
  it('論点の表に、同じ小項目に同じ名前の論点を 2 つ目として入れると断られる', async () => {
    const db = await learningDb()
    seedTopics(db)
    db.prepare(`INSERT INTO syllabus_items (id, name, field, major_no, major, middle_no, middle) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      55,
      '小項目五十五',
      'テクノロジ系',
      3,
      '大分類三',
      21,
      '単元二十一',
    )
    const topic = (id: number, term: string, item: number) => db.prepare(`INSERT INTO topics (id, term, syllabus_item_id) VALUES (?, ?, ?)`).run(id, term, item)
    expect(() => topic(103, '論点百一', 55), '別の小項目の同じ名前の論点が入らない（空振り）').not.toThrow()
    expect(() => topic(104, '論点百一', 54), '同じ小項目に同じ名前の論点が 2 つ目として入った').toThrow()
  })

  // @covers BR-060
  it('過去問の表に、同じ回に同じ問番号の過去問を 2 つ目として入れると断られる', async () => {
    const db = await learningDb()
    insertQuestion(db, '2024r06-q2', '2024r06', 2)
    expect(() => insertQuestion(db, '2023r05-q2', '2023r05', 2), '別の回の同じ問番号の過去問が入らない（空振り）').not.toThrow()
    expect(() => insertQuestion(db, '2024r06-dup2', '2024r06', 2), '同じ回に同じ問番号の過去問が 2 つ目として入った').toThrow()
  })
  /** 外部キー 1 つを「表(列…) → 参照先の表(列…) 消したとき」の 1 行にする。 */
  const fkLine = (table: string, from: string[], to: string, toCols: string[], onDelete: string) =>
    `${table}(${from.join(',')}) -> ${to}(${toCols.join(',')}) on delete ${onDelete.toLowerCase()}`

  // @covers BR-065
  it('学び側の DB の外部キーは、構造の宣言から読んだ一覧と、構造の変更をすべて流した DB が持つ一覧とで同じ', async () => {
    const declared = (Object.values(schema) as unknown[])
      .filter((v): v is SQLiteTable => v instanceof SQLiteTable)
      .flatMap((t) => {
        const c = getTableConfig(t)
        return c.foreignKeys.map((fk) => {
          const r = fk.reference()
          return fkLine(c.name, r.columns.map((x) => x.name), getTableConfig(r.foreignTable).name, r.foreignColumns.map((x) => x.name), fk.onDelete ?? 'no action')
        })
      })
      .sort()
    expect(declared.length, '仕込み: 構造の宣言に外部キーが無い').toBeGreaterThan(0)
    const db = await learningDb()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '__drizzle_migrations')").all() as Array<{ name: string }>).map((r) => r.name)
    const migrated = tables
      .flatMap((t) => {
        const rows = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as Array<{ id: number; seq: number; table: string; from: string; to: string; on_delete: string }>
        const byId = new Map<number, typeof rows>()
        for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r])
        return [...byId.values()].map((g) => {
          const sorted = [...g].sort((a, b) => a.seq - b.seq)
          return fkLine(t, sorted.map((r) => r.from), sorted[0].table, sorted.map((r) => r.to), sorted[0].on_delete)
        })
      })
      .sort()
    expect(migrated).toEqual(declared)
  })

  // @covers BR-065
  it('構造の変更をすべて流した DB は、外部キーに反する行（無い利用者を指す進捗）を、外部キーを効かせたときに断る', async () => {
    const db = await learningDb()
    db.exec('PRAGMA foreign_keys = ON')
    seedTopics(db)
    db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run('u-1', 'u1@example.com', '学ぶ人', '1:s:h')
    const insert = (user: string) => db.prepare(`INSERT INTO progress (user_id, topic_id, status) VALUES (?, ?, ?)`).run(user, 101, 1)
    expect(() => insert('u-1'), 'ある利用者を指す進捗が入らない（空振り）').not.toThrow()
    expect(() => insert('no-such-user'), '無い利用者を指す進捗が入った').toThrow()
  })
})
