/**
 * UC-002 の受け持ち（分野・単元の集計と論点の一覧・論点の教材。資格対策の学び ip）。
 *
 * 前提は例ごとに、例の値が成り立つ学びの写しを置く。
 * - 集計（listFields・listCategories）: listFields.ok はテクノロジ系の 1 分野だけを置く。論点ごとに出題頻度の数だけ別々の内容の過去問を紐づけ、理解度の内訳は本人の
 *   理解度の記録（上書き）で作る。記録も回答も無い論点は未（BR-029）。
 * - 論点の一覧（listTopics）: 単元 12「セキュリティ」は単元の構成（全体像と 2 つのまとまり）を持ち、単元 7 は持たない。
 *   未理解の判定（auto）は、最新の回答が誤答の履歴で作る（BR-049）。
 * - 論点の教材（getTopicDetail）: 論点 418 に、同一内容の 2 問（平成30年度秋期 問38 と平成28年度春期 問40）を紐づけ、
 *   前提の論点 419、同じまとまりの 419・421 を置く。次に学ぶの先頭が 421 になるよう、419 は理解の記録を持つ。
 */

import { LEARNER, learningWorld, putProgress, putQuestion, putSession, putSessionQuestion, putTopic, type Item, type LearningWorld } from '../kit/learning'
import { defineHandler, type Operation } from '../kit/protocol'

const TECH = 'テクノロジ系'
const MGMT = 'マネジメント系'
const CRYPTO: Item = { id: 3, name: '暗号技術', field: TECH, majorNo: 3, major: '技術要素', middleNo: 12, middle: 'セキュリティ' }
const AUTH: Item = { id: 4, name: '認証技術', field: TECH, majorNo: 3, major: '技術要素', middleNo: 12, middle: 'セキュリティ' }
const MEASURES: Item = { id: 5, name: '情報セキュリティ対策', field: TECH, majorNo: 3, major: '技術要素', middleNo: 12, middle: 'セキュリティ' }
const OS: Item = { id: 1, name: 'オペレーティングシステム', field: TECH, majorNo: 2, major: 'コンピュータシステム', middleNo: 7, middle: 'ソフトウェア' }
const PROJECT: Item = { id: 40, name: 'プロジェクトマネジメント', field: MGMT, majorNo: 7, major: 'プロジェクトマネジメント', middleNo: 13, middle: 'プロジェクトマネジメント' }

async function world(): Promise<LearningWorld> {
  const w = await learningWorld()
  w.user(LEARNER.id, LEARNER.name)
  return w
}

/**
 * 論点を count 個置き、出題頻度の合計が questions になるよう配り、理解度の内訳を記録で作る（残りは未）。
 * @implements REQ-570
 */
function fieldOf(w: LearningWorld, item: Item, firstId: number, count: number, questions: number, statuses: { understood: number; partly: number; untouched: number }) {
  const base = Math.floor(questions / count)
  const extra = questions - base * count
  const marks = [...Array(statuses.understood).fill(3), ...Array(statuses.partly).fill(2), ...Array(statuses.untouched).fill(1)]
  for (let i = 0; i < count; i++) {
    const id = firstId + i
    putTopic(w.db, { id, term: `${item.middle}の論点${i + 1}`, item, questions: base + (i < extra ? 1 : 0) })
    if (i < marks.length) putProgress(w.db, LEARNER.id, id, marks[i])
  }
}

const listFields: Operation = async (line) => {
  const w = await world()
  if (line.case === 'ok') {
    fieldOf(w, CRYPTO, 1000, 312, 1680, { understood: 40, partly: 12, untouched: 30 })
  }
  return w.send(line, LEARNER)
}

const listCategories: Operation = async (line) => {
  const w = await world()
  if (line.case === 'ok') {
    fieldOf(w, CRYPTO, 1000, 38, 214, { understood: 6, partly: 0, untouched: 0 })
    fieldOf(w, PROJECT, 2000, 3, 9, { understood: 1, partly: 0, untouched: 0 })
  }
  return w.send(line, LEARNER)
}

/** 単元 12 の単元の構成（全体像と 2 つのまとまり）。 */
function plan12(w: LearningWorld, groups: Record<number, number[]>) {
  w.db.prepare('INSERT INTO unit_plans (middle_no, overview) VALUES (12, ?)').run('情報を守る考え方と、それを支える暗号・認証の仕組みを学ぶ。')
  const put = w.db.prepare('INSERT INTO unit_groups (middle_no, group_no, name, description) VALUES (12, ?, ?, ?)')
  put.run(1, '暗号と証明書', '鍵の持ち方で暗号を分け、署名と証明書で相手を確かめる。')
  put.run(2, '攻撃と対策', 'よくある攻撃の手口と、それぞれを防ぐ仕組み。')
  for (const [group, topics] of Object.entries(groups)) {
    topics.forEach((topic, i) =>
      w.db.prepare('INSERT INTO unit_group_topics (topic_id, middle_no, group_no, position) VALUES (?, 12, ?, ?)').run(topic, Number(group), i + 1),
    )
  }
}

/** 本人が論点の過去問に誤答した履歴（演習を締めたテスト 1 つ）を置く。 */
function wrongAnswer(w: LearningWorld, topicId: number) {
  const questionId = (w.db.prepare('SELECT question_id FROM topic_questions WHERE topic_id = ? LIMIT 1').get(topicId) as { question_id: string }).question_id
  const sessionId = `answered-${topicId}`
  putSession(w.db, { id: sessionId, userId: LEARNER.id, kind: 'drill', status: 'completed', scopeLabel: '論点の演習', questionCount: 1, correctCount: 0, startedAt: 1_750_000_000, finishedAt: 1_750_000_100 })
  putSessionQuestion(w.db, { sessionId, questionId, idx: 0, snapshot: { idx: 0 }, userAnswer: 'イ', result: 2, answeredAt: 1_750_000_050 })
}

const listTopics: Operation = async (line) => {
  const w = await world()
  if (line.case === 'ok') {
    putTopic(w.db, { id: 419, term: '共通鍵暗号方式', item: CRYPTO, questions: 7 })
    putTopic(w.db, { id: 418, term: '公開鍵暗号方式', item: CRYPTO, questions: 9 })
    putTopic(w.db, { id: 433, term: 'SQL インジェクション', item: MEASURES, questions: 1 })
    putTopic(w.db, { id: 421, term: 'ディジタル署名', item: AUTH, questions: 6 })
    plan12(w, { 1: [419, 418, 421], 2: [433] })
    wrongAnswer(w, 419)
    putProgress(w.db, LEARNER.id, 418, 2)
    putProgress(w.db, LEARNER.id, 421, 3)
  }
  if (line.case === 'okWithoutStructure') {
    putTopic(w.db, { id: 201, term: 'コンパイラ', item: OS, questions: 2 })
  }
  return w.send(line, LEARNER)
}

const getTopicDetail: Operation = async (line) => {
  const w = await world()
  if (line.case === 'ok') {
    putTopic(w.db, {
      id: 418,
      term: '公開鍵暗号方式',
      item: CRYPTO,
      questions: 9,
      manualQuestions: true,
      explanation: '暗号化する鍵と復号する鍵を分け、暗号化する側の鍵を公開してよい方式。',
      detail: null,
    })
    putTopic(w.db, { id: 419, term: '共通鍵暗号方式', item: CRYPTO, questions: 7 })
    putTopic(w.db, { id: 421, term: 'ディジタル署名', item: AUTH, questions: 6 })
    plan12(w, { 1: [419, 418, 421] })
    w.db.prepare('INSERT INTO topic_prerequisites (topic_id, prerequisite_topic_id, position) VALUES (418, 419, 1)').run()
    const same = {
      text: '公開鍵暗号方式を用いて送信者が受信者宛てのメッセージを暗号化するとき、暗号化に使う鍵はどれか。',
      choices: { ア: '受信者の公開鍵', イ: '受信者の秘密鍵', ウ: '送信者の公開鍵', エ: '送信者の秘密鍵' },
      answer: 'ア',
      contentKey: 'ck-public-key-encrypt',
    }
    putQuestion(w.db, { id: '2018h30a-38', exam: '2018h30a', examLabel: '平成30年度秋期', number: 38, citation: '平成30年度秋期 問38', ...same }, 418)
    putQuestion(w.db, { id: '2016h28h-40', exam: '2016h28h', examLabel: '平成28年度春期', number: 40, citation: '平成28年度春期 問40', ...same }, 418, 0)
    w.db
      .prepare('INSERT INTO question_explanations (content_key, correct_reason, choices_json) VALUES (?, ?, ?)')
      .run(
        same.contentKey,
        '正解。公開鍵暗号方式では、受信者だけが持つ秘密鍵でしか復号できないようにするため、受信者の公開鍵で暗号化する。',
        JSON.stringify([
          { label: 'ア', term: null, note: '正解。受信者の公開鍵で暗号化する。' },
          { label: 'イ', term: '秘密鍵', note: '本人だけが持ち、復号や署名に使う鍵。' },
        ]),
      )
    putProgress(w.db, LEARNER.id, 418, 2)
    putProgress(w.db, LEARNER.id, 419, 3)
  }
  return w.send(line, LEARNER)
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-002',
  operations: { listFields, listCategories, listTopics, getTopicDetail },
})
