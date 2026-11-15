import { sql, type SQL } from 'drizzle-orm'
import type { Db } from './db'
import { joinStatus, notUnderstood } from './understanding'

export type NextTopic = { id: number; term: string; questionCount: number; field: string }

/* 以下の SQL の断片は、論点を t（topics）、論点のシラバスの小項目を s（syllabus_items の JOIN）、
 * その利用者の理解度を ts（lib/understanding の joinStatus）と名付けた問い合わせの中でだけ使える。
 * 資格対策の断片はロードマップ型の列（sort_order など）を参照しない。 */

/** 次に学ぶの並び（ORDER BY の中身）。資格対策は出題頻度の降順で、同じ出題頻度の論点どうしは
 *  分野の順 → シラバスの小項目の順 → 論点の ID の順。ロードマップ型は学ぶ順（sort_order）。
 *  投入されたシラバスの小項目の id は syllabus.json の項目の番号なので、分野の順はその分野の項目の番号の最小値、
 *  項目の順は番号そのもので表す。単元の構成はこの並びに使わない。 */
// @implements BR-030
export function nextOrder(roadmap: boolean): SQL {
  return roadmap
    ? sql`COALESCE(t.sort_order, 999999) ASC, t.term`
    : sql`t.question_count DESC,
          (SELECT MIN(sf.id) FROM syllabus_items sf WHERE sf.field = s.field) ASC,
          s.id ASC,
          t.id ASC`
}

/** 論点の一覧の並び（ORDER BY の中身）。ロードマップ型は学ぶ順。資格対策は単元の番号の順に、
 *  単元の構成を持つ単元ではまとまりの順 → まとまりの中の学ぶ順、持たない単元では小項目の番号の順 →
 *  出題頻度の降順 → 論点の ID の順。資格対策では単元の構成のまとまりへの所属を ug（unit_group_topics の LEFT JOIN）と
 *  名付けた問い合わせの中でだけ使える（listOrderJoin）。 */
// @implements BR-031, REQ-474, REQ-476
export function listOrder(roadmap: boolean): SQL {
  return roadmap
    ? sql`COALESCE(t.sort_order, 999999) ASC, t.term`
    : sql`s.middle_no ASC,
          (ug.group_no IS NULL) ASC, ug.group_no ASC, ug.position ASC,
          s.id ASC, t.question_count DESC, t.id ASC`
}

/** listOrder が使う ug の JOIN 句。ロードマップ型は単元の構成の表を参照しない。 */
export function listOrderJoin(roadmap: boolean): SQL {
  return roadmap ? sql`` : sql`LEFT JOIN unit_group_topics ug ON ug.topic_id = t.id`
}

/** 一覧のおすすめ順（ORDER BY 句）。まだ理解していない論点を次に学ぶの並びで先に、理解の論点を
 *  同じ並びで最後に置く。論点を除く条件は持たない。 */
// @implements BR-030, REQ-042
export function recommendedOrder(roadmap: boolean): SQL {
  return sql`ORDER BY CASE WHEN ${notUnderstood(roadmap)} THEN 0 ELSE 1 END, ${nextOrder(roadmap)}`
}

/** 「次に学ぶ」の候補を、次に学ぶの並びで limit 件まで返す。ホームの nextTopics と論点の画面の nextTopic が
 *  どちらもこの 1 本の問い合わせを使い、一覧のおすすめ順も同じ条件と並び（notUnderstood・nextOrder）を使う。
 *  候補は、まだ理解していない論点のうち過去問（確認問題）が 1 件以上ある物。exclude を渡すとその論点を候補から外す。 */
// @implements BR-029, BR-030, REQ-043
export function nextTopics(
  db: Db,
  userId: string,
  opts: { roadmap: boolean; limit: number; exclude?: number },
): Promise<NextTopic[]> {
  return db.all<NextTopic>(sql`
    SELECT t.id AS id, t.term AS term, t.question_count AS questionCount, s.field AS field
      FROM topics t
      JOIN syllabus_items s ON s.id = t.syllabus_item_id
      ${joinStatus(userId, opts.roadmap)}
     WHERE ${notUnderstood(opts.roadmap)} AND t.question_count > 0
       ${opts.exclude === undefined ? sql`` : sql`AND t.id <> ${opts.exclude}`}
     ORDER BY ${nextOrder(opts.roadmap)}
     LIMIT ${opts.limit}
  `)
}
