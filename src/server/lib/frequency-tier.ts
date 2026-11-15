/** 出題回数の印の段の境目。配列の i 番目が段 i+1 の出題頻度の下限で、最も高い段は下限以上をすべて含む。 */
// @implements BR-051
export const FREQUENCY_TIER_FLOORS = [1, 2, 3] as const

export type FrequencyTier = 1 | 2 | 3

/** 論点の出題頻度から出題回数の印の段を求める。出題頻度が 0 の論点とロードマップ型の学びは印を持たない（null）。 */
// @implements BR-051, REQ-478
export function frequencyTierOf(questionCount: number, roadmap: boolean): FrequencyTier | null {
  if (roadmap) return null
  let tier: FrequencyTier | null = null
  FREQUENCY_TIER_FLOORS.forEach((floor, i) => {
    if (questionCount >= floor) tier = (i + 1) as FrequencyTier
  })
  return tier
}
