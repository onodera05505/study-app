/**
 * 試験ごとの設定。
 *
 * IT パスポートと応用情報（午前）で、コードは同じもの・データとデプロイ先だけ別、
 * という構成にしている。分野（ストラテジ系／マネジメント系／テクノロジ系）の
 * 3区分もシラバスの階層の形も共通なので、画面とAPIはそのまま使い回せる。
 *
 * 違うのは「名前」「1回あたりの問題数と試験時間」だけなので、ここに集める。
 * クライアントは VITE_EXAM、サーバは env.EXAM で選ぶ。未指定なら ip。
 */

export type ExamKey = 'ip' | 'ap'

export type ExamConfig = {
  key: ExamKey
  /** 画面上部とログイン画面に出す名前 */
  brand: string
  /** ブラウザのタブに出すタイトル */
  title: string
  /** 模試1回あたりの問題数 */
  mockSize: number
  /** 模試の制限時間（分） */
  mockMinutes: number
  /**
   * 分野ごとの基準点があるか。
   *
   * **ここが2試験の一番大きな違い。** IT パスポートは総合600点かつ3分野それぞれ
   * 300点以上という AND 条件なので、分野別のフィードバックが合否に直結する。
   * 応用情報の午前は総合60%だけで、分野別の足切りは無い。
   * 分野の内訳は学習の指針としては有用なので出すが、「落ちる」とは書かない。
   */
  fieldThreshold: boolean
  /** 合否の説明。採点方式が違うのでそのまま画面に出す */
  passRule: string
  /**
   * ランダム構成の模試で寄せる、本番の分野別出題数。
   *
   * 応用情報は解答例 PDF に公式の分野があり、取り込んだ5回すべてで
   * テクノロジ50・ストラテジ20・マネジメント10 で完全に一定だった。目安ではなく実測値。
   */
  fieldRatio: Record<string, number>
}

export const EXAMS: Record<ExamKey, ExamConfig> = {
  ip: {
    key: 'ip',
    brand: 'IT パスポート 最短合格',
    title: 'IT パスポート 最短合格',
    mockSize: 100,
    mockMinutes: 120,
    fieldThreshold: true,
    passRule:
      '本番の合否は総合600点かつ3分野それぞれ300点以上（1,000点満点）で判定されます。' +
      'ただし IPA の採点は項目応答理論（IRT）で行われ換算式が非公開のため、' +
      'このアプリの点数は素点による目安です。',
    fieldRatio: { ストラテジ系: 35, マネジメント系: 20, テクノロジ系: 45 },
  },
  ap: {
    key: 'ap',
    brand: '応用情報 午前 最短合格',
    title: '応用情報 午前 最短合格',
    mockSize: 80,
    mockMinutes: 150,
    fieldThreshold: false,
    passRule:
      '午前試験は80問すべて配点が同じで，60%（48問）以上の正解で突破です。' +
      '分野ごとの足切りはありません。分野別の内訳は，どこから手を付けるかの目安として出しています。',
    fieldRatio: { ストラテジ系: 20, マネジメント系: 10, テクノロジ系: 50 },
  },
}

export function examOf(key: string | undefined): ExamConfig {
  return EXAMS[(key as ExamKey) ?? 'ip'] ?? EXAMS.ip
}
