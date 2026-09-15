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

export type ExamKey = 'ip' | 'ap' | 'itc'

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
  /** 分野の並び順（画面と API で揃える）。資格版は IPA の 3 分野、ロードマップ型は自前の分野 */
  fields: string[]
  /**
   * ロードマップ型か。資格版は「出題頻度＝重要度」で並べるが、ロードマップ型は
   * 一次資料の交差数と前提関係で決めた順（topics.sort_order）で並べ、問題は自作の確認問題。
   * 画面の文言（過去問／確認問題、出題頻度／学ぶ順）と API の並び順がここで切り替わる。
   */
  roadmap: boolean
  /** 画面の文言。試験の種類で変わる語だけ */
  words: { question: string; questions: string; mock: string; nextUp: string }
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
    fields: ['ストラテジ系', 'マネジメント系', 'テクノロジ系'],
    roadmap: false,
    words: { question: '過去問', questions: '過去問', mock: '過去問実践', nextUp: '頻出なのにまだ理解できていない論点' },
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
    fields: ['ストラテジ系', 'マネジメント系', 'テクノロジ系'],
    roadmap: false,
    words: { question: '過去問', questions: '過去問', mock: '過去問実践', nextUp: '頻出なのにまだ理解できていない論点' },
  },
  itc: {
    key: 'itc',
    brand: 'IT コンサル就活 ロードマップ',
    title: 'IT コンサル就活 ロードマップ',
    // 通しの確認テスト。1 単位 1 問 = 42 問。時間は 1 問 1 分弱の目安
    mockSize: 42,
    mockMinutes: 40,
    fieldThreshold: false,
    passRule:
      '確認テストです。合否はありません。到達基準（面接で何を示せるか）ごとの正答率を見て、弱い分野の単位に戻ります。' +
      '問題は教材から作った自作の確認問題で、過去問ではありません。',
    fieldRatio: { 業界と仕事: 14, ITと業務の基礎知識: 9, 論理思考とケース: 9, 選考と自己理解: 10 },
    // 5 つ目「補足」はロードマップから外した単位の別枠（本人の決定 2026-09-15）。確認テストの分野比率には入れない
    fields: ['業界と仕事', 'ITと業務の基礎知識', '論理思考とケース', '選考と自己理解', '補足（ロードマップ外）'],
    roadmap: true,
    words: { question: '確認問題', questions: '確認問題', mock: '確認テスト', nextUp: 'ロードマップの順で、まだ理解できていない単位' },
  },
}

export function examOf(key: string | undefined): ExamConfig {
  return EXAMS[(key as ExamKey) ?? 'ip'] ?? EXAMS.ip
}
