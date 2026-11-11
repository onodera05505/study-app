import { sql, type SQL } from 'drizzle-orm'
import type { Db } from './db'

export type NextTopic = { id: number; term: string; questionCount: number; field: string }

/* 以下の SQL の断片は、論点を t（topics）、論点のシラバスの項目を s（syllabus_items の JOIN）、
 * その利用者の理解度の記録を p（progress の LEFT JOIN）と名付けた問い合わせの中でだけ使える。 */

/** まだ理解していない論点の条件。記録の無い論点は未理解として扱い、未理解とやや理解を分けない。 */
// @implements BR-029, BR-030
export function notUnderstood(): SQL {
  return sql`COALESCE(p.status, 1) < 3`
}

/** その学びの種類の並び（ORDER BY の中身）。資格対策は出題頻度の降順、ロードマップ型は学ぶ順（sort_order）。
 *  資格対策で出題頻度が同じ論点どうしは、分野の順 → シラバスの項目の順 → 論点の ID の順に並べる。
 *  投入されたシラバスの項目の id は syllabus.json の項目の番号なので、分野の順はその分野の項目の番号の最小値、
 *  項目の順は番号そのもので表す。論点の項目を s（syllabus_items の JOIN）と名付けた問い合わせの中でだけ使える。
 *  資格対策の並びはロードマップ型の列を参照しない。 */
// @implements BR-031
export function learningOrder(roadmap: boolean): SQL {
  return roadmap
    ? sql`COALESCE(t.sort_order, 999999) ASC, t.term`
    : sql`t.question_count DESC,
          (SELECT MIN(sf.id) FROM syllabus_items sf WHERE sf.field = s.field) ASC,
          s.id ASC,
          t.id ASC`
}

/** 一覧のおすすめ順（ORDER BY 句）。まだ理解していない論点を学びの種類の並びで先に、理解にした論点を
 *  同じ並びで最後に置く。論点を除く条件は持たない。 */
// @implements BR-030
export function recommendedOrder(roadmap: boolean): SQL {
  return sql`ORDER BY CASE WHEN ${notUnderstood()} THEN 0 ELSE 1 END, ${learningOrder(roadmap)}`
}

/** 「次に学ぶ」の候補を、次に学ぶ順に limit 件まで返す。ホームの nextTopics と論点の画面の nextTopic が
 *  どちらもこの 1 本の問い合わせを使い、一覧のおすすめ順も同じ条件と並び（notUnderstood・learningOrder）を使う。
 *
 *  候補は、まだ理解していない論点のうち過去問（確認問題）が 1 件以上ある物。exclude を渡すとその論点を候補から外す。 */
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
     WHERE ${notUnderstood()} AND t.question_count > 0
       ${opts.exclude === undefined ? sql`` : sql`AND t.id <> ${opts.exclude}`}
     ORDER BY ${learningOrder(opts.roadmap)}
     LIMIT ${opts.limit}
  `)
}
