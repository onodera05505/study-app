import { sql } from 'drizzle-orm'
import type { Db } from './db'

export type QuestionRow = {
  id: string
  text: string
  choices: string
  answer: string
  hasFigure: number
  figureDescription: string | null
  figureImage: string | null
  citation: string
  /** 原文を改変しているか。立っていれば表示側で「一部改変」を併記する。 */
  modified: number
  examLabel: string
  number: number
  field: string | null
  exam: string
  /** 本文＋選択肢の正規化ハッシュ。同一内容の問題をまとめるキー（build_seed.py が計算）。 */
  contentKey: string | null
  /** 同一内容が何回出題されたか。dedupe が付ける。まとめていなければ 1。 */
  timesAsked?: number
  /** 代表以外の出典（新しい回から順）。dedupe が付ける。 */
  otherCitations?: string[]
}

/** 本番の分野別出題数は試験ごとに違う。src/shared/exam.ts の fieldRatio を使う。 */

/** 回の新旧。exam ID（2016h28h / 2020r02o / 2025r07a）を古い→新しいの順で比べる。
 *
 *  先頭4桁が西暦、末尾1文字が実施時期（h=春 < o=10月 < a=秋）。IT パスポートは
 *  通年 CBT なので末尾が無い回がある（2024r06）ので、その場合は年内で最後に置く。
 *
 *  **文字列の大小では比べられない。** 2016h28a（秋）と 2016h28h（春）は
 *  辞書順だと a < h で秋のほうが古いことになってしまう。 */
const SEASON_RANK: Record<string, number> = { h: 0, o: 1, a: 2 }

export function compareExam(a: string, b: string): number {
  const year = (x: string) => Number(x.slice(0, 4)) || 0
  // 末尾が h/o/a ならその時期。無ければ通年（年内で最後）。
  const season = (x: string) => SEASON_RANK[x.slice(-1)] ?? 3
  return year(a) - year(b) || season(a) - season(b)
}

type Dedupable = { id: string; exam: string; contentKey: string | null; citation: string }

/** 同一内容の問題を1問にまとめる。学習側（ドリル・分野別・ランダム模試・復習・
 *  論点詳細）で使う。**過去問の通し受験には使わない**（原本どおり全問出す）。
 *
 *  IPA は同じ問題を別の回で使い回す（応用情報で119組258問）。DB には出典と
 *  通し受験のため全問そのまま持つが、学習で同じ問題が二度出るのは時間の無駄なので、
 *  ここで畳む。代表は**最新の回**（直近の本試験の表記に慣れておくほうが実戦的）。
 *
 *  代表行には timesAsked（グループの件数）と otherCitations（代表以外の出典、
 *  新しい順）を付ける。画面はこれを見て「同一の問題が n 回出題されています」を出す。
 *
 *  グループの並びは元の並びのまま（最初に現れた位置に代表を置く）。呼び出し側が
 *  付けた順序（新しい回が先、など）を壊さないため。 */
// @implements REQ-053, BR-028
export function dedupe<T extends Dedupable>(
  rows: T[],
): (T & { timesAsked: number; otherCitations: string[] })[] {
  // JOIN の都合で同じ問題が複数行に増えていることがある（論点をまたぐと分野の数だけ出る）。
  // 先に ID で畳まないと、同じ1問を「2回出題」と数えてしまう。
  const byId = new Map<string, T>()
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r)

  const groups = new Map<string, T[]>()
  for (const r of byId.values()) {
    const key = r.contentKey ?? r.id
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }

  return [...groups.values()].map((g) => {
    const sorted = [...g].sort((a, b) => compareExam(b.exam, a.exam)) // 新しい回が先
    const [head, ...rest] = sorted
    return {
      ...head,
      timesAsked: sorted.length,
      otherCitations: rest.map((r) => r.citation),
    }
  })
}

/** 定着した問題を除く。直近 streak 回の解答がすべて正解なら、当面は出題しない。
 *
 *  前身アプリ では「直近3セッション」を基準にしていたが、セッション単位だと
 *  1セッションに同じ問題が出ない前提に依存する。ここでは**その問題に対する
 *  直近 streak 回の解答**を見る形にした。ドリルと模試が混在しても筋が通る。
 *
 *  数える単位は問題 ID ではなく content_key（無ければ ID）。同一内容の問題は
 *  学習側では1問として出しているので、別の回で解いて定着していれば代表も
 *  定着扱いにしないと、まとめた側だけがいつまでも出続ける。 */
async function masteredKeys(db: Db, userId: string, streak: number): Promise<Set<string>> {
  if (streak <= 0) return new Set()
  const rows = await db.all<{ qkey: string }>(sql`
    WITH ranked AS (
      SELECT COALESCE(q.content_key, q.id) AS qkey,
             sq.result      AS result,
             ROW_NUMBER() OVER (PARTITION BY COALESCE(q.content_key, q.id)
                                ORDER BY sq.answered_at DESC) AS rn
        FROM session_questions sq
        JOIN sessions s ON s.id = sq.session_id
        JOIN past_questions q ON q.id = sq.question_id
       WHERE s.user_id = ${userId} AND sq.result <> 0
    )
    SELECT qkey AS qkey
      FROM ranked
     WHERE rn <= ${streak}
     GROUP BY qkey
    HAVING COUNT(*) = ${streak} AND MIN(result) = 1 AND MAX(result) = 1
  `)
  return new Set(rows.map((r) => r.qkey))
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function fetchQuestions(db: Db, where: ReturnType<typeof sql>): Promise<QuestionRow[]> {
  return db.all<QuestionRow>(sql`
    SELECT DISTINCT q.id AS id, q.text AS text, q.choices AS choices, q.answer AS answer,
           q.has_figure AS hasFigure, q.figure_description AS figureDescription,
           q.figure_image AS figureImage,
           q.citation AS citation, q.modified AS modified,
           q.exam_label AS examLabel, q.number AS number,
           q.content_key AS contentKey, q.exam AS exam,
           s.field AS field
      FROM past_questions q
      LEFT JOIN topic_questions tq ON tq.question_id = q.id
      LEFT JOIN topics t ON t.id = tq.topic_id
      LEFT JOIN syllabus_items s ON s.id = t.syllabus_item_id
     ${where}
  `)
}

export type BuildInput = {
  kind: 'drill' | 'field' | 'middle' | 'review' | 'mock'
  topicId?: number
  field?: string
  middleNo?: number
  exam?: string
  size: number
  masteredStreak: number
  /** ランダム構成の模試で寄せる分野別出題数。試験ごとに違う（src/shared/exam.ts） */
  fieldRatio: Record<string, number>
}

export type BuildResult = {
  questions: QuestionRow[]
  scopeLabel: string
  sourceExam: string | null
}

/** セッションの出題内容を組み立てる。 */
// @implements REQ-051, REQ-052, REQ-054, BR-019
export async function buildQuestions(
  db: Db,
  userId: string,
  input: BuildInput,
): Promise<BuildResult> {
  const mastered = await masteredKeys(db, userId, input.masteredStreak)
  const drop = (rows: QuestionRow[]) => {
    const kept = rows.filter((r) => !mastered.has(r.contentKey ?? r.id))
    // 全部が定着済みなら、除外せず復習として出す（何も出ないほうが困る）
    return kept.length > 0 ? kept : rows
  }

  // @implements REQ-106, REQ-107, REQ-108
  if (input.kind === 'mock') {
    if (input.exam) {
      // 公開回をそのまま1セットとして解く。本番の追体験。順序も原文どおり。
      // **ここでは同一内容をまとめない。** 原本に2度出ているものは2度出す。
      const rows = await fetchQuestions(db, sql`WHERE q.exam = ${input.exam}`)
      const byNumber = new Map<string, QuestionRow>()
      for (const r of rows) byNumber.set(r.id, r)
      const ordered = [...byNumber.values()].sort((a, b) => a.number - b.number)
      return {
        questions: ordered,
        scopeLabel: `${ordered[0]?.examLabel ?? input.exam} を通しで受験`,
        sourceExam: input.exam,
      }
    }
    // ランダム構成。分野比率を本番の目安に寄せる。
    // 定着済みは**範囲（全範囲）から先に**外す。分野ごとに外すと、埋める側の経路や
    // 分野の一つが全部定着済みのときに定着済みが混ざる。
    const pool = dedupe(await fetchQuestions(db, sql``))
    const avail = drop(pool)
    const picked: QuestionRow[] = []
    for (const [field, count] of Object.entries(input.fieldRatio)) {
      const inField = shuffle(avail.filter((q) => q.field === field))
      picked.push(...inField.slice(0, count))
    }
    // 分野が付いていない問題（論点未紐付け）で不足分を埋める
    if (picked.length < input.size) {
      const chosen = new Set(picked.map((q) => q.id))
      picked.push(
        ...shuffle(avail.filter((q) => !chosen.has(q.id))).slice(0, input.size - picked.length),
      )
    }
    return {
      questions: shuffle(picked).slice(0, input.size),
      scopeLabel: `全範囲からランダム${input.size}問`,
      sourceExam: null,
    }
  }

  if (input.kind === 'drill' && input.topicId) {
    const rows = await fetchQuestions(db, sql`WHERE tq.topic_id = ${input.topicId}`)
    const term = await db.get<{ term: string }>(
      sql`SELECT term FROM topics WHERE id = ${input.topicId}`,
    )
    return {
      questions: shuffle(drop(dedupe(rows))).slice(0, input.size),
      scopeLabel: `論点「${term?.term ?? ''}」`,
      sourceExam: null,
    }
  }

  // 中分類は「体系」画面の箱と対応する。読む（論点）と解く（演習）を
  // 同じまとまりの中で完結させるための範囲。
  if (input.kind === 'middle' && input.middleNo !== undefined) {
    const rows = await fetchQuestions(db, sql`WHERE s.middle_no = ${input.middleNo}`)
    const middle = await db.get<{ middle: string }>(
      sql`SELECT middle FROM syllabus_items WHERE middle_no = ${input.middleNo} LIMIT 1`,
    )
    return {
      questions: shuffle(drop(dedupe(rows))).slice(0, input.size),
      scopeLabel: `中分類「${middle?.middle ?? ''}」`,
      sourceExam: null,
    }
  }

  if (input.kind === 'field' && input.field) {
    const rows = await fetchQuestions(db, sql`WHERE s.field = ${input.field}`)
    return {
      questions: shuffle(drop(dedupe(rows))).slice(0, input.size),
      scopeLabel: `分野「${input.field}」`,
      sourceExam: null,
    }
  }

  // review: 間違えた問題を先に、直近に間違えた順で。そのあと理解度の低い論点の問題で詰める。
  // 同一内容は content_key でまとめる。代表は**直近に間違えた回**（最新の回ではない）。
  // 復習で見たいのは「自分がつまずいた現物」なので、そのときの回のまま出す。
  // GROUP BY と MAX() を組むと、SQLite は MAX に一致する行の値を返す。
  const wrong = await db.all<QuestionRow>(sql`
    SELECT q.id AS id, q.text AS text, q.choices AS choices, q.answer AS answer,
           q.has_figure AS hasFigure, q.figure_description AS figureDescription,
           q.figure_image AS figureImage,
           q.citation AS citation, q.modified AS modified,
           q.exam_label AS examLabel, q.number AS number,
           q.content_key AS contentKey, q.exam AS exam,
           NULL AS field,
           MAX(sq.answered_at) AS lastAnsweredAt
      FROM session_questions sq
      JOIN sessions s ON s.id = sq.session_id
      JOIN past_questions q ON q.id = sq.question_id
     WHERE s.user_id = ${userId} AND sq.result = 2
     GROUP BY COALESCE(q.content_key, q.id)
     ORDER BY MAX(sq.answered_at) DESC
     LIMIT ${input.size}
  `)

  // 誤答だけでは弱点を覆えない（まだ解いていない論点は誤答に現れない）ので、
  // 理解度の自己申告が未理解（1）・やや理解（2）の論点に紐づく過去問も足す。
  // 出題頻度の高い論点から並べる（頻出論点から潰すのが最短経路）。
  const weakRows = await db.all<QuestionRow>(sql`
    SELECT q.id AS id, q.text AS text, q.choices AS choices, q.answer AS answer,
           q.has_figure AS hasFigure, q.figure_description AS figureDescription,
           q.figure_image AS figureImage,
           q.citation AS citation, q.modified AS modified,
           q.exam_label AS examLabel, q.number AS number,
           q.content_key AS contentKey, q.exam AS exam,
           si.field AS field
      FROM progress p
      JOIN topics t ON t.id = p.topic_id
      JOIN topic_questions tq ON tq.topic_id = t.id
      JOIN past_questions q ON q.id = tq.question_id
      LEFT JOIN syllabus_items si ON si.id = t.syllabus_item_id
     WHERE p.user_id = ${userId} AND p.status <= 2
     ORDER BY t.question_count DESC, t.id
     LIMIT ${input.size * 5}
  `)
  // 誤答で既に入っている問題は同一内容ごと省く。誤答が先、理解度の低い論点が後。
  const already = new Set(wrong.map((r) => r.contentKey ?? r.id))
  const weak = dedupe(weakRows).filter((r) => !already.has(r.contentKey ?? r.id))
  const picked = drop([...wrong, ...weak]).slice(0, input.size)
  return {
    questions: await annotateTimesAsked(db, picked),
    scopeLabel: '間違えた問題の復習',
    sourceExam: null,
  }
}

/** 復習の代表行に timesAsked / otherCitations を付ける。
 *
 *  復習は「間違えた問題」しか集めないので、その中で数えると回数が過少になる
 *  （2回出題されていても、間違えたのが1回なら1と出てしまう）。過去問全体から数え直す。 */
// @implements REQ-053
async function annotateTimesAsked(db: Db, rows: QuestionRow[]): Promise<QuestionRow[]> {
  const keys = rows.map((r) => r.contentKey).filter((k): k is string => !!k)
  if (keys.length === 0) return rows.map((r) => ({ ...r, timesAsked: 1, otherCitations: [] }))
  const all = await db.all<{ id: string; contentKey: string; citation: string; exam: string }>(sql`
    SELECT id, content_key AS contentKey, citation, exam
      FROM past_questions
     WHERE content_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
  `)
  const byKey = new Map<string, typeof all>()
  for (const r of all) {
    const g = byKey.get(r.contentKey)
    if (g) g.push(r)
    else byKey.set(r.contentKey, [r])
  }
  return rows.map((r) => {
    const g = r.contentKey ? byKey.get(r.contentKey) : undefined
    if (!g || g.length <= 1) return { ...r, timesAsked: 1, otherCitations: [] }
    const others = g
      .filter((x) => x.id !== r.id)
      .sort((a, b) => compareExam(b.exam, a.exam))
      .map((x) => x.citation)
    return { ...r, timesAsked: g.length, otherCitations: others }
  })
}

/** 出題時スナップショット。教材を後から直しても当時の内容で採点・表示するため。 */
// @implements REQ-058
export function snapshotOf(q: QuestionRow) {
  return {
    text: q.text,
    choices: JSON.parse(q.choices) as Record<string, string>,
    answer: q.answer,
    citation: q.citation,
    modified: !!q.modified,
    hasFigure: !!q.hasFigure,
    figureDescription: q.figureDescription,
    figureImage: q.figureImage,
    examLabel: q.examLabel,
    number: q.number,
    /** 同一内容が何回出題されたか。1 なら画面には出さない。 */
    timesAsked: q.timesAsked ?? 1,
    /** 代表以外の出典（新しい回から順）。 */
    otherCitations: q.otherCitations ?? [],
  }
}
