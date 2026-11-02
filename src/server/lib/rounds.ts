import { sql } from 'drizzle-orm'
import type { RoadmapSpec } from '../../shared/exam'
import type { Db } from './db'

/** 論点が属する回。round・roundLabel は topics 表に投入された値をそのまま使う
 *  （学ぶ順を持つ単位が回を持つことは投入の門が見る。BR-037）。round が null の単位は順序なしの 1 回。 */
export type TopicRound = {
  id: number
  sortOrder: number | null
  round: string | null
  roundLabel: string | null
}

/** 学ぶ順に並ぶ回（補足の回と順序なしの 1 回を除く）の番号とラベル。番号は回の順で 1 起点。 */
export function orderedRounds(rows: TopicRound[], spec: RoadmapSpec | undefined): Map<string, { day: number; label: string | null }> {
  const first = new Map<string, { at: number; label: string | null }>()
  for (const r of rows) {
    if (!r.round || r.round === spec?.extraRoundId) continue
    const at = r.sortOrder ?? Number.POSITIVE_INFINITY
    const cur = first.get(r.round)
    if (!cur || at < cur.at) first.set(r.round, { at, label: cur?.label ?? r.roundLabel })
  }
  const out = new Map<string, { day: number; label: string | null }>()
  ;[...first.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .forEach(([round, v], i) => out.set(round, { day: i + 1, label: v.label }))
  return out
}

/** ロードマップ型の全ての論点と、その属する回。 */
export async function allTopicRounds(db: Db): Promise<TopicRound[]> {
  return db.all<TopicRound>(sql`
    SELECT t.id AS id, t.sort_order AS sortOrder, t.round AS round, t.round_label AS roundLabel
      FROM topics t
  `)
}
