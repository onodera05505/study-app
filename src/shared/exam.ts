/**
 * 試験（対象）ごとの設定。正本は `targets.json`（対象を足すときは scripts/new_target.py が書く。手で足さない）。
 *
 * IT パスポート・応用情報（午前）・IT コンサル就活ロードマップで、コードは同じもの・データとデプロイ先だけ別。
 * クライアントは VITE_EXAM、サーバは env.EXAM で選ぶ。未指定なら ip。
 *
 * `roadmap: true` の対象は「出題頻度＝重要度」でなく学ぶ順（topics.sort_order）で並べ、問題は自作の確認問題。
 * 画面の文言（words）と API の並び順がここで切り替わる。
 */
import targets from './targets.json'

export type ExamKey = string

export type ExamConfig = {
  key: ExamKey
  brand: string
  title: string
  mockSize: number
  mockMinutes: number
  fieldThreshold: boolean
  passRule: string
  fieldRatio: Record<string, number>
  fields: string[]
  roadmap: boolean
  words: { question: string; questions: string; mock: string; nextUp: string }
  /** ロードマップ型だけが持つ。ログイン画面の説明文など */
  roadmapSpec?: { loginLead?: string }
}

type Raw = Omit<ExamConfig, 'key'> & { kind: string; examName: string; questionsPerRound: number; exemptRounds: string[] }

export const EXAMS: Record<string, ExamConfig> = Object.fromEntries(
  Object.entries(targets as Record<string, unknown>)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => {
      const r = v as Raw
      return [k, {
        key: k, brand: r.brand, title: r.title, mockSize: r.mockSize, mockMinutes: r.mockMinutes,
        fieldThreshold: r.fieldThreshold, passRule: r.passRule, fieldRatio: r.fieldRatio, fields: r.fields,
        roadmap: r.roadmap, words: r.words, roadmapSpec: (v as { roadmapSpec?: { loginLead?: string } }).roadmapSpec,
      } satisfies ExamConfig]
    }),
)

export function examOf(key: string | undefined): ExamConfig {
  return EXAMS[key ?? 'ip'] ?? EXAMS.ip
}
