import { sql } from 'drizzle-orm'
import type { Db } from './db'

export type NextTopic = { id: number; term: string; questionCount: number; field: string }

/** 「次に学ぶ」の候補を、次に学ぶ順に limit 件まで返す。ホームの nextTopics と論点の画面の nextTopic が
 *  どちらもこの 1 本の問い合わせを使う。
 *
 *  候補は、理解度の記録が無い論点を未理解として、理解していない論点のうち過去問（確認問題）が 1 件以上ある物。
 *  並びは資格対策が出題頻度の降順、ロードマップ型が学ぶ順（sort_order）で、資格対策の問い合わせは
 *  ロードマップ型の列を参照しない。exclude を渡すとその論点を候補から外す。 */
// @implements BR-029, BR-030, BR-031
export function nextTopics(
  db: Db,
  userId: string,
  opts: { roadmap: boolean; limit: number; exclude?: number },
): Promise<NextTopic[]> {
  return db.all<NextTopic>(sql`
    SELECT t.id AS id, t.term AS term, t.question_count AS questionCount, s.field AS field
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      LEFT JOIN progress p ON p.topic_id = t.id AND p.user_id = ${userId}
     WHERE COALESCE(p.status, 1) < 3 AND t.question_count > 0
       ${opts.exclude === undefined ? sql`` : sql`AND t.id <> ${opts.exclude}`}
     ${opts.roadmap ? sql`ORDER BY COALESCE(t.sort_order, 999999) ASC, t.term` : sql`ORDER BY t.question_count DESC, t.term`}
     LIMIT ${opts.limit}
  `)
}
