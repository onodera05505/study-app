import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch())`

/** シラバス Ver.6.5 の項目（1〜63）。分野・大分類・中分類はこの1テーブルに畳んである。
 *  合否は分野単位の AND 条件で決まるので、field は必ず引ける形にしておく。 */
export const syllabusItems = sqliteTable(
  'syllabus_items',
  {
    id: integer('id').primaryKey(), // シラバスの項目番号 1..63 をそのまま使う
    name: text('name').notNull(),
    field: text('field').notNull(), // ストラテジ系 | マネジメント系 | テクノロジ系
    majorNo: integer('major_no').notNull(),
    major: text('major').notNull(),
    middleNo: integer('middle_no').notNull(),
    middle: text('middle').notNull(),
  },
  (t) => [index('idx_syllabus_field').on(t.field, t.id)],
)

/** 論点。学習の単位。過去問とは M:N で結び、紐づく件数が出題頻度＝重要度になる。 */
export const topics = sqliteTable(
  'topics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    term: text('term').notNull(),
    /** ロードマップ型で単位の名前に添える副題。名前（term）とは分けて持ち、副題を持たない単位と資格版は NULL。 */
    subtitle: text('subtitle'),
    syllabusItemId: integer('syllabus_item_id')
      .notNull()
      .references(() => syllabusItems.id),
    /** シラバスの用語例に無く、分類時に新設した論点。レビュー対象を絞るための印。 */
    isNew: integer('is_new', { mode: 'boolean' }).notNull().default(false),
    /** 短い説明。学習画面で最初に見せる。 */
    explanation: text('explanation'),
    /** 詳しい解説・周辺知識。「詳しく」で展開する。 */
    detail: text('detail'),
    /** topic_questions の件数キャッシュ。並べ替えのたびに数えないための非正規化。 */
    questionCount: integer('question_count').notNull().default(0),
    /** ロードマップ型の学ぶ順。資格版は NULL（出題頻度で並べる）。 */
    sortOrder: integer('sort_order'),
    /** ロードマップ型で論点が属する回の ID（past_questions.exam と同じ値。補足の論点は補足の回）。
     *  学ぶ順を持たない非補足の論点と資格版は NULL。 */
    round: text('round'),
    /** 論点が属する回のラベル。章で束ねる学びでは章の名前。round が NULL なら NULL。 */
    roundLabel: text('round_label'),
    /** 印の段（登録簿の roadmapSpec.tiers の level）。印を持たない学びは NULL。 */
    tier: integer('tier'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    // 同じ論点が別レコードに割れると頻度が分散して重要度が壊れるので一意にする
    uniqueIndex('uq_topic_term').on(t.syllabusItemId, t.term),
    index('idx_topic_freq').on(t.questionCount),
  ],
)

/** 資格対策の単元の構成のうち、単元ごとの全体像。構成を持つ単元だけが 1 行を持つ。
 *  単元はシラバスの middle_no で指す（学びごとに D1 が分かれるので学びの中で一意。
 *  syllabus_items では middle_no が一意でないため FK は張らない）。
 *  学びのデータとして投入で入り、利用者の操作では変わらない。ロードマップ型と構成を作っていない単元は行を持たない。
 *  単元の構成の受け持ち（owners）は書き手のための物で、画面に出さないので持たない。 */
export const unitPlans = sqliteTable(
  'unit_plans',
  {
    /** 単元の番号（syllabus_items.middle_no）。 */
    middleNo: integer('middle_no').primaryKey(),
    /** 全体像。 */
    overview: text('overview').notNull(),
  },
  (t) => [check('ck_unit_plans_overview_not_empty', sql`${t.overview} <> ''`)],
)

/** 単元の構成のまとまり。group_no の順がまとまりの学ぶ順。 */
export const unitGroups = sqliteTable(
  'unit_groups',
  {
    middleNo: integer('middle_no')
      .notNull()
      .references(() => unitPlans.middleNo, { onDelete: 'cascade' }),
    /** 単元の中のまとまりの番号（1 始まり）。並びがまとまりの学ぶ順。 */
    groupNo: integer('group_no').notNull(),
    name: text('name').notNull(),
    /** まとまりの 1 行の説明。 */
    description: text('description').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.middleNo, t.groupNo] }),
    check('ck_unit_groups_group_no_positive', sql`${t.groupNo} >= 1`),
    check('ck_unit_groups_name_not_empty', sql`${t.name} <> ''`),
    check('ck_unit_groups_description_not_empty', sql`${t.description} <> ''`),
  ],
)

/** まとまりに入る論点と、まとまりの中の学ぶ順。
 *  論点はどれか 1 つのまとまりにだけ入るので topic_id を主キーにする。
 *  資格対策の学ぶ順はここだけが持ち、topics.sort_order（ロードマップ型の学び全体を通した順）には入れない。 */
export const unitGroupTopics = sqliteTable(
  'unit_group_topics',
  {
    topicId: integer('topic_id')
      .primaryKey()
      .references(() => topics.id, { onDelete: 'cascade' }),
    middleNo: integer('middle_no').notNull(),
    groupNo: integer('group_no').notNull(),
    /** まとまりの中の学ぶ順（1 始まり）。 */
    position: integer('position').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.middleNo, t.groupNo],
      foreignColumns: [unitGroups.middleNo, unitGroups.groupNo],
    }).onDelete('cascade'),
    // まとまりの論点を学ぶ順に引く問い合わせに使う
    // @implements BR-031
    uniqueIndex('uq_unit_group_topics_position').on(t.middleNo, t.groupNo, t.position),
    check('ck_unit_group_topics_position_positive', sql`${t.position} >= 1`),
  ],
)

/** 単元の構成が論点ごとに決める前提の論点。position の順が示す順。
 *  前提の論点は同じ学びの論点で、他の単元の論点でもよい。前提を持たない論点は行を持たない。 */
export const topicPrerequisites = sqliteTable(
  'topic_prerequisites',
  {
    topicId: integer('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    prerequisiteTopicId: integer('prerequisite_topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    /** 前提の論点を示す順（1 始まり）。 */
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.topicId, t.prerequisiteTopicId] }),
    // @implements REQ-479
    uniqueIndex('uq_topic_prerequisites_position').on(t.topicId, t.position),
    check('ck_topic_prerequisites_position_positive', sql`${t.position} >= 1`),
    check('ck_topic_prerequisites_not_self', sql`${t.topicId} <> ${t.prerequisiteTopicId}`),
  ],
)

/** 過去問。IPA の公開問題。表示時は必ず出典を添える（利用条件）。 */
export const pastQuestions = sqliteTable(
  'past_questions',
  {
    /** "2024r06-q8" 形式。再取り込み時に UPSERT できる安定キー。 */
    id: text('id').primaryKey(),
    exam: text('exam').notNull(), // 2024r06
    examLabel: text('exam_label').notNull(), // 令和6年度
    number: integer('number').notNull(), // 1..100
    text: text('text').notNull(),
    /** 選択肢。{"ア": "...", "イ": "..."} の JSON 文字列。 */
    choices: text('choices').notNull(),
    answer: text('answer').notNull(), // ア | イ | ウ | エ
    hasFigure: integer('has_figure', { mode: 'boolean' }).notNull().default(false),
    /** 図表の文章による書き起こし。表や擬似言語はこちらのほうが読みやすい。 */
    figureDescription: text('figure_description'),
    /** 図として描かれている問題だけ、原本から切り出した画像のパス（/figures/…）。
     *  ブロック図やアローダイアグラムは文章で読むより図を見るほうが速く、
     *  本番も図で出るので図で慣れておくほうが実戦的。表や擬似言語には付けない。 */
    figureImage: text('figure_image'),
    /** 出典表示に使う完成形。「出典：令和6年度 ITパスポート試験 問8」 */
    citation: text('citation').notNull(),
    /** 原文を改変した場合に立てる。立っていれば表示側で「一部改変」を併記する。 */
    modified: integer('modified', { mode: 'boolean' }).notNull().default(false),
    /** 本文＋選択肢の正規化ハッシュ。同一内容の問題を学習側で1問にまとめるためのキー。
     *  build_seed.py が計算する。 */
    contentKey: text('content_key'),
  },
  (t) => [
    uniqueIndex('uq_question_exam_number').on(t.exam, t.number),
    index('idx_question_exam').on(t.exam, t.number),
    index('idx_question_content').on(t.contentKey),
  ],
)

/** 論点 ⇔ 過去問。この件数が出題頻度になる。 */
export const topicQuestions = sqliteTable(
  'topic_questions',
  {
    topicId: integer('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => pastQuestions.id, { onDelete: 'cascade' }),
    /** その問題の中心論点なら true。周辺として結ばれた場合は false。 */
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.topicId, t.questionId] }),
    index('idx_tq_question').on(t.questionId),
  ],
)

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** PBKDF2 の "iterations:salt:hash"。Workers の Web Crypto で検証する。 */
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('MEMBER'), // ADMIN | MEMBER
    createdAt: integer('created_at').notNull().default(now),
  },
  // @implements REQ-192
  (t) => [uniqueIndex('uq_user_email').on(t.email)],
)

/** 論点ごとの理解度。1: 未理解 / 2: やや理解 / 3: 理解 */
export const progress = sqliteTable(
  'progress',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: integer('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    status: integer('status').notNull().default(1),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.topicId] })],
)

/** アプリを開いた日の記録。連続記録（ストリーク）の材料になる。
 *
 *  1日1行。日付は端末の時差で前後しないよう、**日本時間の暦日**を文字列（YYYY-MM-DD）
 *  で持つ。unixepoch を UTC で丸めると、日本の深夜0時〜9時が前日に寄ってしまう。
 *
 *  学習した内容ではなく「開いた日」を記録する。続けて開くこと自体を habit にするため。 */
export const dailyVisits = sqliteTable(
  'daily_visits',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 日本時間の暦日。YYYY-MM-DD */
    day: text('day').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
)

/** 演習・模試のセッション。
 *  kind: drill（論点別ドリル）| field（分野別）| review（弱点復習）| mock（過去問実践） */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull(), // in_progress | completed
    /** mock のとき、どの回を再現しているか。ランダム構成なら null。 */
    sourceExam: text('source_exam'),
    /** 範囲の名前。「論点「RAID」」「分野「テクノロジ系」」など画面表示用。NULL も空の文字列も持たない。 */
    // @implements BR-040
    scopeLabel: text('scope_label').notNull(),
    /** 制限時間（秒）。無制限なら null。過去問実践は 7200。 */
    timeLimitSec: integer('time_limit_sec'),
    questionCount: integer('question_count').notNull(),
    correctCount: integer('correct_count'),
    startedAt: integer('started_at').notNull().default(now),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('idx_session_user_status').on(t.userId, t.status, t.startedAt),
    // @implements BR-040
    check('ck_sessions_scope_label_not_empty', sql`${t.scopeLabel} <> ''`),
  ],
)

/** 出題された1問。出題時点の内容をスナップショットとして固定する。
 *  教材を後から直しても、当時の内容で採点・振り返りができるようにするため。 */
export const sessionQuestions = sqliteTable(
  'session_questions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => pastQuestions.id),
    /** 0 始まりの出題順。未回答の最小 index が「現在の問題」。 */
    idx: integer('idx').notNull(),
    /** { text, choices, answer, citation, hasFigure, figureDescription } の JSON。 */
    // @implements BR-020
    snapshot: text('snapshot').notNull(),
    userAnswer: text('user_answer'),
    /** 0: 未回答 / 1: 正解 / 2: 不正解 */
    result: integer('result').notNull().default(0),
    answeredAt: integer('answered_at'),
  },
  (t) => [
    uniqueIndex('uq_sq_session_idx').on(t.sessionId, t.idx),
    // 未回答の最小 index を引く頻出クエリ
    index('idx_sq_progress').on(t.sessionId, t.result, t.idx),
  ],
)

/** アプリ全体設定。1行想定（id='default'）。
 *  出題数や除外条件など、運用で変えたくなる値をコードに埋めずにここに置く。 */
export const appSettings = sqliteTable('app_settings', {
  id: text('id').primaryKey(),
  /** 練習テストの既定出題数 */
  drillSize: integer('drill_size').notNull().default(10),
  /** 過去問実践の出題数と制限時間（本番は100問120分） */
  mockSize: integer('mock_size').notNull().default(100),
  mockTimeLimitSec: integer('mock_time_limit_sec').notNull().default(7200),
  /** 合格ラインの目安（％）。総合と分野別。IRT は再現できないので素点の近似。 */
  passOverallPct: integer('pass_overall_pct').notNull().default(60),
  passFieldPct: integer('pass_field_pct').notNull().default(30),
  /** 直近何回連続で正解したら当面出題しないか */
  masteredStreak: integer('mastered_streak').notNull().default(3),
  updatedAt: integer('updated_at').notNull().default(now),
})

/** 問題ごとの解説。「正解の根拠」と「誤答ア〜エが何の用語の説明か」を持つ。
 *
 *  論点の教材（topics.explanation / detail）は定義・見分け方・図・計算手順に絞り、
 *  **誤答選択肢のケアはこちらに移す**。論点は複数の問題に紐づくので、教材に
 *  誤答の説明を書くと「どの問題の誤答か」が分からなくなる。
 *
 *  キーは past_questions.id ではなく **content_key**。IPA は同じ問題を別の回で
 *  使い回すので（応用情報で119組）、問題 ID を主キーにすると同じ解説を何本も
 *  書くことになる。content_key なら1本で全部の回に効く。
 *
 *  choices_json は [{"label":"ア","term":"用語名 or null","note":"1行"}, …] の4件。
 *  正解の要素も含む（note は「正解。〜」の形）。 */
export const questionExplanations = sqliteTable('question_explanations', {
  /** past_questions.content_key と同じ値。FK は張らない（seed の投入順に依存させない）。 */
  contentKey: text('content_key').primaryKey(),
  /** 正解の根拠。Markdown（`[[用語]]` を含んでよい）。1〜3文。 */
  correctReason: text('correct_reason').notNull(),
  /** 選択肢ごとの1行説明。JSON 配列4件。 */
  choicesJson: text('choices_json').notNull(),
  updatedAt: text('updated_at'),
})

/** 用語集。本文中の `[[用語]]` を押したときに出すポップの中身。
 *
 *  解説の choices[].term から build_seed.py が派生生成する。教材本文の `[[用語]]` で
 *  拾えなかったものは、その論点の explanation の第1文で補う。
 *
 *  topic_id に **FK は張らない**。用語集は派生データで、論点の統合（build_seed.py の
 *  「消えた論点の掃除」）で参照先が消えることがある。制約で seed 投入を止めるより、
 *  リンクを出さないほうがよい。check_seed.py が実在を検査する。 */
export const glossary = sqliteTable(
  'glossary',
  {
    /** 表記そのまま。`[[用語]]` の中身と完全一致させる。 */
    term: text('term').primaryKey(),
    /** 1行の説明。 */
    brief: text('brief').notNull(),
    /** ドンピシャの論点があれば topics.id。あればポップに「この論点を学ぶ →」を出す。 */
    topicId: integer('topic_id'),
  },
  (t) => [index('idx_glossary_topic').on(t.topicId)],
)

/** 利用者からのフィードバック。
 *  自由記述と 1 タップで選ぶ種類（kind）を同じ表に置く。
 *  その場で AI は応答しない。開発側が scripts/feedback.py で取り出して改善フェーズを回し、status を進める。
 *  seed の投入はこの表に触らないので消えない。 */
export const feedback = sqliteTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull().default('text'), // 取りうる値は routes/feedback.ts の kind の列挙
    /** 送ったときに開いていた画面のパス（/topics/57 など）。 */
    page: text('page'),
    topicId: integer('topic_id'),
    questionId: text('question_id'),
    body: text('body').notNull(),
    status: text('status').notNull().default('new'), // new | triaged | done
    /** 開発側のメモ（どう対応したか）。 */
    note: text('note'),
    createdAt: integer('created_at').notNull().default(now),
    handledAt: integer('handled_at'),
  },
  (t) => [index('idx_feedback_status').on(t.status, t.createdAt)],
)

