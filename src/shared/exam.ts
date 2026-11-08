/**
 * 試験（対象）ごとの設定。正本は `targets.json`（対象を足すときは scripts/new_target.py が書く。手で足さない）。
 *
 * どの学びもコードは同じもの・データとデプロイ先だけ別。
 * クライアントは VITE_EXAM、サーバは env.EXAM で選ぶ。key が無いか登録簿に無いときは既定の学びに倒さない
 * （クライアントは読み込みで止まり、サーバはどの /api の要求も設定が無いことに当たる形で断る）。
 *
 * `roadmap: true` の対象は「出題頻度＝重要度」でなく学ぶ順（topics.sort_order）で並べ、問題は自作の確認問題。
 * 画面の文言（words）と API の並び順がここで切り替わる。
 */
import targets from './targets.json'

/** 入口「まなびば」（認証と権限の正本。要件 §15）。URL は公開情報。 */
export const portal: { url: string; name: string } = (targets as unknown as { _portal: { url: string; name: string } })._portal

export type ExamKey = string

export type ExamConfig = {
  key: ExamKey
  brand: string
  title: string
  /** 学びの種類（登録簿の kind） */
  kind: string
  mockSize: number
  mockMinutes: number
  /** 分野別演習・単元演習・弱点復習で問題数を指定しないときの問題数 */
  practiceSize: number
  fieldThreshold: boolean
  passRule: string
  fieldRatio: Record<string, number>
  fields: string[]
  roadmap: boolean
  words: { question: string; questions: string; mock: string; nextUp: string }
  /** ロードマップ型だけが持つ。ログイン画面の説明文など */
  roadmapSpec?: RoadmapSpec
}

/** 印の段の 1 つ。level は投入データの topics.tier と同じ値、label は画面に出す語 */
export type RoadmapTier = { level: number; label: string }

/** ロードマップ型だけが持つ公開値。ログイン画面の説明文・1 日の単位数・補足の分野名・回の語・印の語など。
 *
 *  回の語は欠けたまま配備しない（BR-037 の配備前の検査が見る）ので、画面は代わりの語を持たない。
 *  - `roundHeading` 回の見出しの語。`{day}` は回の番号、`{label}` は投入された回のラベル（章の名前）
 *  - `roundCheck` 回ごとの確認を指す語
 *  - `roundCount` 回の数の語。`{n}` は回の数
 *  - `perRoundCount` 1 回の論点数の語。`{perDay}` は 1 日の論点数。1 回の論点数を決めている学びだけが持つ
 *  - `tiers` 印の段と語。印を持つ学びだけが持つ */
export type RoadmapSpec = {
  loginLead?: string
  perDay?: number
  extraField?: string
  extraRoundId?: string
  extraRoundLabel?: string
  roundLabel?: string
  targetName?: string
  roundHeading?: string
  roundCheck?: string
  roundCount?: string
  perRoundCount?: string
  tiers?: RoadmapTier[]
}

const fill = (template: string | undefined, values: Record<string, string | number>): string =>
  (template ?? '').replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m))

/** 回の見出し。回の番号と、投入された回のラベルを登録簿の語に入れる。 */
// @implements REQ-279, BR-037
export function roundHeadingOf(spec: RoadmapSpec | undefined, day: number, label: string | null): string {
  return fill(spec?.roundHeading, { day, label: label ?? '' }).trim()
}

/** テストの範囲の名前。回の見出し（補足の回では補足の回のラベル）と回ごとの確認の語で作る。 */
// @implements REQ-286, BR-037
export function roundScopeNameOf(spec: RoadmapSpec | undefined, round: { extra: boolean; day: number; label: string | null }): string {
  const head = round.extra ? (spec?.extraRoundLabel ?? '') : roundHeadingOf(spec, round.day, round.label)
  return `${head} ${spec?.roundCheck ?? ''}`.trim()
}

/** 回の数（と、決めている学びでは 1 回の論点数）を登録簿の語で。 */
// @implements REQ-131, BR-037
export function roundCountOf(spec: RoadmapSpec | undefined, n: number): string {
  const count = fill(spec?.roundCount, { n })
  return spec?.perRoundCount ? `${fill(spec.perRoundCount, { perDay: spec.perDay ?? '' })}、${count}` : count
}

/** 印の段に当たる登録簿の語。印を持たない学びと、登録簿に無い段は null。 */
// @implements REQ-282, REQ-284, REQ-285
export function tierLabelOf(spec: RoadmapSpec | undefined, tier: number | null | undefined): string | null {
  if (tier == null) return null
  return spec?.tiers?.find((t) => t.level === tier)?.label ?? null
}

type Raw = Omit<ExamConfig, 'key'> & { examName: string; questionsPerRound: number; exemptRounds: string[] }

export const EXAMS: Record<string, ExamConfig> = Object.fromEntries(
  Object.entries(targets as Record<string, unknown>)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => {
      const r = v as Raw
      return [k, {
        key: k, brand: r.brand, title: r.title, kind: r.kind, mockSize: r.mockSize, mockMinutes: r.mockMinutes, practiceSize: r.practiceSize,
        fieldThreshold: r.fieldThreshold, passRule: r.passRule, fieldRatio: r.fieldRatio, fields: r.fields,
        roadmap: r.roadmap, words: r.words, roadmapSpec: (v as { roadmapSpec?: RoadmapSpec }).roadmapSpec,
      } satisfies ExamConfig]
    }),
)

/** 与えられた key に当たる登録簿の学び。key が無いか登録簿に無いときは null（既定の学びに倒さない）。 */
// @implements REQ-353, BR-005
export function resolveExam(key: string | undefined): ExamConfig | null {
  return key !== undefined && Object.hasOwn(EXAMS, key) ? EXAMS[key] : null
}

/** 与えられた key に当たる登録簿の学び。解決できない key では例外で止まる。 */
// @implements REQ-353, REQ-354, BR-005
export function examOf(key: string | undefined): ExamConfig {
  const exam = resolveExam(key)
  if (!exam) throw new Error(`学びの key「${key ?? ''}」は登録簿にありません`)
  return exam
}
