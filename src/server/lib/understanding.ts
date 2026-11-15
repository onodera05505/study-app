import { sql, type SQL } from 'drizzle-orm'

/** 理解度を求める唯一の置き場。論点の一覧・論点の画面・分野と単元の集計・理解度の絞り込み・
 *  次に学ぶ・おすすめ順・弱点復習は、どれもここが返す表と式だけで理解度を読む。判定の結果は保存しない。
 *
 *  段階の番号: 0=未（資格対策だけ）/ 1=未理解 / 2=やや理解 / 3=理解。 */

/** 日本時間の暦日で区切るための時差（秒）。 */
// @implements BR-049
export const JST_OFFSET_SEC = 9 * 60 * 60

/** 最後の誤答より後に正解した日がこの日数以上あれば理解とする。 */
// @implements BR-049
export const UNDERSTOOD_CORRECT_DAYS = 2

/** 資格対策の理解度の数える回答の表（列: question_id・qkey・ck・at・result・session_id・idx）。
 *  本人の回答だけを数え、演習は回答した時刻、模試は締めた時刻を回答の時刻とし、締めていない模試の回答は数えない。
 *  qkey は同一内容の過去問を 1 問として数えるための鍵（content_key、無ければ過去問の ID）。
 *  弱点復習の「間違えた過去問」もこの表から読む。 */
// @implements BR-049, BR-018, BR-021
export function countedAnswers(userId: string): SQL {
  return sql`
    SELECT sq.question_id AS question_id,
           COALESCE(q.content_key, q.id) AS qkey,
           q.content_key AS ck,
           CASE WHEN se.kind = 'mock' THEN se.finished_at ELSE sq.answered_at END AS at,
           sq.result AS result,
           sq.session_id AS session_id,
           sq.idx AS idx
      FROM session_questions sq
      JOIN sessions se ON se.id = sq.session_id
      JOIN past_questions q ON q.id = sq.question_id
     WHERE se.user_id = ${userId}
       AND sq.result IN (1, 2)
       AND (CASE WHEN se.kind = 'mock' THEN se.finished_at ELSE sq.answered_at END) IS NOT NULL
       AND (se.kind <> 'mock' OR se.status = 'completed')`
}

/** 回答の前後の決まり。列 at・session_id・idx を持つ 2 つの行 a・b について、a が b より後なら真。
 *  回答の時刻で決め、同じ時刻の同じテストの回答どうしは出題の順で後の回答を後とする。
 *  別々のテストの同じ時刻の回答どうしは、どちらも他方より後としない。 */
// @implements BR-049
export function answeredAfter(a: string, b: string): SQL {
  const x = sql.raw(a)
  const y = sql.raw(b)
  return sql`(${x}.at > ${y}.at OR (${x}.at = ${y}.at AND ${x}.session_id = ${y}.session_id AND ${x}.idx > ${y}.idx))`
}

/** 回答を後の物から 1 列に並べる ORDER BY の項（列 at・session_id・idx を持つ行 a）。answeredAfter で後の回答は必ず先に来る。
 *  別々のテストの同じ時刻の回答どうしは、出題の順の番号・テストの ID の大きい方を先にする。 */
// @implements BR-049
export function latestFirst(a: string): SQL {
  const x = sql.raw(a)
  return sql`${x}.at DESC, ${x}.idx DESC, ${x}.session_id DESC`
}

/** 資格対策の、回答の履歴からの判定と本人の上書きを合わせた理解度の表（列: topic_id・status・source）。
 *  回答も理解度の記録も無い論点は行を持たない（未。statusOf が 0 に倒す）。
 *  記録より後の回答が無ければ記録の段階（override）、あれば回答の履歴からの判定（auto）。記録と同じ時刻の回答は後と数えない
 *  最新の回答・最後の誤答・誤答より後の正解は、どれも answeredAfter と latestFirst の前後で決める。最後の誤答（lastw）の
 *  session_id は、その時刻の誤答が別々のテストにまたがるときは NULL にし、同じ時刻の正解をどれも後と数えない。 */
// @implements BR-049, BR-050, REQ-480, REQ-482, REQ-484
function judgedStatusTable(userId: string): SQL {
  return sql`
    WITH ans AS (${countedAnswers(userId)}),
    ta AS (
      SELECT DISTINCT tq.topic_id AS topic_id, a.session_id AS session_id, a.idx AS idx, a.at AS at, a.result AS result
        FROM ans a
        JOIN past_questions q2 ON (a.ck IS NOT NULL AND q2.content_key = a.ck) OR (a.ck IS NULL AND q2.id = a.question_id)
        JOIN topic_questions tq ON tq.question_id = q2.id
    ),
    agg AS (
      SELECT topic_id, MAX(at) AS last_at, MAX(CASE WHEN result = 2 THEN at END) AS last_wrong
        FROM ta GROUP BY topic_id
    ),
    latest AS (
      SELECT topic_id, result FROM (
        SELECT l.topic_id AS topic_id, l.result AS result,
               ROW_NUMBER() OVER (PARTITION BY l.topic_id ORDER BY ${latestFirst('l')}) AS rn
          FROM ta l
      ) WHERE rn = 1
    ),
    lastw AS (
      SELECT w.topic_id AS topic_id, w.at AS at,
             CASE WHEN COUNT(DISTINCT w.session_id) = 1 THEN MAX(w.session_id) END AS session_id,
             MAX(w.idx) AS idx
        FROM ta w JOIN agg ON agg.topic_id = w.topic_id AND w.at = agg.last_wrong
       WHERE w.result = 2
       GROUP BY w.topic_id
    ),
    days AS (
      SELECT c.topic_id AS topic_id, COUNT(DISTINCT date(c.at + ${JST_OFFSET_SEC}, 'unixepoch')) AS n
        FROM ta c LEFT JOIN lastw ON lastw.topic_id = c.topic_id
       WHERE c.result = 1 AND (lastw.topic_id IS NULL OR ${answeredAfter('c', 'lastw')})
       GROUP BY c.topic_id
    ),
    judged AS (
      SELECT agg.topic_id AS topic_id, agg.last_at AS last_at,
             CASE WHEN latest.result = 2 THEN 1
                  WHEN COALESCE(days.n, 0) >= ${UNDERSTOOD_CORRECT_DAYS} THEN 3
                  ELSE 2 END AS status
        FROM agg
        JOIN latest ON latest.topic_id = agg.topic_id
        LEFT JOIN days ON days.topic_id = agg.topic_id
    ),
    rec AS (SELECT topic_id, status, updated_at FROM progress WHERE user_id = ${userId}),
    keyed AS (SELECT topic_id FROM rec UNION SELECT topic_id FROM judged)
    SELECT keyed.topic_id AS topic_id,
           CASE WHEN r.topic_id IS NOT NULL AND (j.last_at IS NULL OR j.last_at <= r.updated_at)
                THEN r.status ELSE j.status END AS status,
           CASE WHEN r.topic_id IS NOT NULL AND (j.last_at IS NULL OR j.last_at <= r.updated_at)
                THEN 'override' ELSE 'auto' END AS source
      FROM keyed
      LEFT JOIN rec r ON r.topic_id = keyed.topic_id
      LEFT JOIN judged j ON j.topic_id = keyed.topic_id`
}

/** 理解度の表を ts と名付けて論点 t に結ぶ JOIN 句。以下の式はこの JOIN を持つ問い合わせの中でだけ使える。
 *  ロードマップ型は理解度の記録がそのまま理解度になる（記録の無い論点は行を持たない）。 */
// @implements BR-029, BR-049, BR-050, REQ-480
export function joinStatus(userId: string, roadmap: boolean): SQL {
  const table = roadmap
    ? sql`SELECT topic_id, status, NULL AS source FROM progress WHERE user_id = ${userId}`
    : judgedStatusTable(userId)
  return sql`LEFT JOIN (${table}) ts ON ts.topic_id = t.id`
}

/** 集計・絞り込み・次に学ぶが使う理解度の段階。行の無い論点は、資格対策では未（0）、ロードマップ型では未理解（1）。 */
// @implements BR-029, REQ-481
export function stageOf(roadmap: boolean): SQL {
  return roadmap ? sql`COALESCE(ts.status, 1)` : sql`COALESCE(ts.status, 0)`
}

/** 応答に載せる理解度。ロードマップ型で記録が無い論点は null（画面が BR-029 の既定を当てる）。 */
// @implements BR-029, REQ-481
export function statusOf(roadmap: boolean): SQL {
  return roadmap ? sql`ts.status` : stageOf(false)
}

/** 理解度が回答の履歴からの判定（auto。未を含む）か本人の上書き（override）か。ロードマップ型では null。 */
// @implements BR-050, REQ-483
export function statusSourceOf(roadmap: boolean): SQL {
  return roadmap ? sql`NULL` : sql`COALESCE(ts.source, 'auto')`
}

/** まだ理解していない論点の条件。資格対策は未・未理解・やや理解、ロードマップ型は未理解・やや理解（記録の無い論点を含む）。 */
// @implements BR-029, BR-030
export function notUnderstood(roadmap: boolean): SQL {
  return sql`${stageOf(roadmap)} < 3`
}
