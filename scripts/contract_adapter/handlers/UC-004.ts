/**
 * UC-004 の受け持ち（テストを作る・現在の問題・回答・締め・結果。演習と模試。資格対策の学び ip）。
 *
 * 学びの写し（例ごとに新しく置く）:
 * - 論点 2「オープンソースソフトウェア」（単元 7）に別々の内容の過去問 10 問。位置 3 に置く問（SEO の問。平成30年度秋期 問3）は
 *   同一内容の令和3年度 問18 を持ち（出題 2 回）、問題解説を持つ。位置 4 に置く問は正解がイで、問題解説を持たない。
 * - 令和6年度（2024r06）の 100 問（getSessionResult は問1 の 1 問だけ）。問1（論点 118「情報セキュリティの三要素」。正解イ・問題解説あり）〜問45 はテクノロジ系（単元 12）、
 *   問46〜80 はストラテジ系、問81〜100 はマネジメント系。
 * テストは作る操作（startSession）で作り、作られる ID を実例の ID にそろえる。出題の順は作ったあとで実例の位置に並べ替え、
 * 回答は回答の操作（answerQuestion）で積む。時刻は実例の時刻に止める（模試の残り時間・締めた時刻）。
 */

import {
  LEARNER,
  learningWorld,
  putItem,
  putQuestion,
  putSession,
  putSessionQuestion,
  putTopic,
  type Item,
  type LearningWorld,
  type QuestionSpec,
} from '../kit/learning'
import { withClock, withUuids } from '../kit/outside'
import { defineHandler, Unanswerable, type Operation } from '../kit/protocol'

const DRILL_ID = '8f14e45f-ea2b-4f1c-9a3e-6b1d2c7f4a90'
const MOCK_ID = '3f2a7c1e-5b84-4d6a-9e10-2c7b8a4f0d55'
const COMPLETED_ID = 'b5d6c1a0-3f48-4e97-9d52-7a1c8e0b6f34'
const UNFINISHED_ID = '9c5d41b2-0e7a-4f38-b6c1-5a0d3e92f7aa'
/** 実例の時刻（getSessionResult.ok の startedAt・finishedAt）。 */
const MOCK_START = 1759276800_000
const MOCK_FINISH = 1759283500_000
const AFTER_LIMIT = MOCK_START + 7300_000

const STRAT: Item = { id: 1, name: '経営・組織論', field: 'ストラテジ系', majorNo: 1, major: '企業と法務', middleNo: 1, middle: '企業活動' }
const MGMT: Item = { id: 20, name: 'プロジェクトマネジメント', field: 'マネジメント系', majorNo: 6, major: 'プロジェクトマネジメント', middleNo: 13, middle: 'プロジェクトマネジメント' }
const SEC: Item = { id: 30, name: '情報セキュリティ', field: 'テクノロジ系', majorNo: 9, major: '技術要素', middleNo: 12, middle: 'セキュリティ' }
const SOFT: Item = { id: 31, name: 'オープンソースソフトウェア', field: 'テクノロジ系', majorNo: 8, major: 'コンピュータシステム', middleNo: 7, middle: 'ソフトウェア' }

const SEO = {
  text: 'インターネットの検索エンジンの検索結果において，自社のホームページの表示順位を，より上位にしようとするための技法や手法の総称はどれか。',
  choices: { ア: 'DNS', イ: 'RSS', ウ: 'SEO', エ: 'SNS' },
  answer: 'ウ',
  contentKey: 'ck-seo',
}
const CIA = {
  text: '情報セキュリティの三要素のうち、可用性に該当するものはどれか。',
  choices: { ア: '許可された者だけが情報を参照できる', イ: '必要なときに情報を利用できる', ウ: '情報が改ざんされていない', エ: '行為者を後から特定できる' },
  answer: 'イ',
  contentKey: 'ck-cia-availability',
}

function explain(w: LearningWorld, contentKey: string, correctReason: string, choices: Array<{ label: string; term: string | null; note: string }>) {
  w.db.prepare('INSERT INTO question_explanations (content_key, correct_reason, choices_json) VALUES (?, ?, ?)').run(contentKey, correctReason, JSON.stringify(choices))
}

/** 例ごとの学びの写し。failWrites を渡すと、当たる書き込みが失敗する保存先にする。r06 は置く令和6年度の問の数（問1 から）。 */
async function world(failWrites?: RegExp, r06Count = 100): Promise<LearningWorld> {
  const w = await learningWorld({}, 'ip', failWrites)
  w.user(LEARNER.id, LEARNER.name)
  for (const item of [STRAT, MGMT, SEC, SOFT]) putItem(w.db, item)

  // 論点 2 の 10 問（位置 3 に SEO の問、位置 4 に解説の無い問を並べ替えで置く）
  putTopic(w.db, { id: 2, term: 'オープンソースソフトウェア', item: SOFT, questions: 11, manualQuestions: true })
  putQuestion(w.db, { id: '2018h30a-3', exam: '2018h30a', examLabel: '平成30年度秋期', number: 3, citation: '出典：平成30年度 秋期 ITパスポート試験 問3', ...SEO }, 2)
  putQuestion(w.db, { id: '2021r03-18', exam: '2021r03', examLabel: '令和3年度', number: 18, citation: '出典：令和3年度 ITパスポート試験 問18', ...SEO }, 2, 0)
  explain(w, SEO.contentKey, '正解。SEO は検索結果の表示順位を上げるための技法の総称です。', [
    { label: 'ア', term: 'DNS', note: 'ドメイン名と IP アドレスを対応づける仕組みの説明です。' },
    { label: 'イ', term: 'RSS', note: '更新情報を配信する形式の説明です。' },
    { label: 'ウ', term: null, note: '正解。検索順位を上げる技法の総称です。' },
    { label: 'エ', term: 'SNS', note: '人のつながりを扱うサービスの説明です。' },
  ])
  putQuestion(w.db, { id: '2019r01a-4', exam: '2019r01a', examLabel: '令和元年度秋期', number: 4, answer: 'イ' }, 2)
  for (let n = 1; n <= 8; n++) putQuestion(w.db, { id: `2017h29h-${n}`, exam: '2017h29h', examLabel: '平成29年度春期', number: n }, 2)

  // 令和6年度の 100 問
  putTopic(w.db, { id: 118, term: '情報セキュリティの三要素', item: SEC, questions: 1, manualQuestions: true })
  putTopic(w.db, { id: 119, term: '情報セキュリティ管理', item: SEC, questions: 44, manualQuestions: true })
  putTopic(w.db, { id: 300, term: '経営組織', item: STRAT, questions: 35, manualQuestions: true })
  putTopic(w.db, { id: 301, term: 'プロジェクトの計画', item: MGMT, questions: 20, manualQuestions: true })
  const r06 = (n: number, extra: Partial<QuestionSpec> = {}): QuestionSpec => ({ id: `2024r06-${n}`, exam: '2024r06', examLabel: '令和6年度', number: n, citation: `令和6年度 問${n}`, ...extra })
  putQuestion(w.db, r06(1, CIA), 118)
  explain(w, CIA.contentKey, '正解はイ。可用性は必要なときに使える状態を保つ性質を指す。', [
    { label: 'ア', term: '機密性', note: '許可された者だけが参照できる性質。' },
    { label: 'イ', term: null, note: '正解。必要なときに利用できる性質が可用性。' },
    { label: 'ウ', term: '完全性', note: '情報が改ざんされていない性質。' },
    { label: 'エ', term: '責任追跡性', note: '行為者を後から特定できる性質。' },
  ])
  for (let n = 2; n <= r06Count; n++) putQuestion(w.db, r06(n), n <= 45 ? 119 : n <= 80 ? 300 : 301)
  return w
}

type Me = typeof LEARNER

async function call(w: LearningWorld, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await w.raw(method, path, LEARNER as Me, body)
  const text = await res.text()
  if (res.status >= 300) throw new Unanswerable(`前提を作る ${method} ${path} が ${res.status}: ${text.slice(0, 160)}`)
  return JSON.parse(text) as Record<string, unknown>
}

/** 作る操作でテストを作り、ID を id にそろえる。 */
async function start(w: LearningWorld, id: string, body: Record<string, unknown>): Promise<void> {
  const made = await withUuids([id], () => call(w, 'POST', '/api/sessions', body))
  if (made.id !== id) throw new Unanswerable(`前提のテストの ID を ${id} にそろえられない（作られた ID: ${String(made.id)}）`)
}

/** 出題の順を並べ替え、questionId の問（と同一内容の問）を位置 idx に置く。 */
function placeAt(w: LearningWorld, sessionId: string, questionId: string, idx: number) {
  const row = w.db
    .prepare(
      'SELECT s.idx AS idx, s.question_id AS qid FROM session_questions s JOIN past_questions q ON q.id = s.question_id WHERE s.session_id = ? AND q.content_key = (SELECT content_key FROM past_questions WHERE id = ?)',
    )
    .get(sessionId, questionId) as { idx: number; qid: string } | undefined
  if (!row) throw new Unanswerable(`前提: テスト ${sessionId} に ${questionId} が出題されていない`)
  if (row.qid !== questionId) process.stderr.write(`  （前提の注記: ${questionId} と同一内容の ${row.qid} が出題された）\n`)
  if (row.idx === idx) return
  const move = w.db.prepare('UPDATE session_questions SET idx = ? WHERE session_id = ? AND idx = ?')
  move.run(-1, sessionId, idx)
  move.run(idx, sessionId, row.idx)
  move.run(row.idx, sessionId, -1)
}

/** 位置の順に count 問を回答する。correct(idx) が真の問は正解、そうでなければ誤答を選ぶ。 */
async function answerFirst(w: LearningWorld, sessionId: string, count: number, correct: (idx: number) => boolean = () => true) {
  for (let idx = 0; idx < count; idx++) {
    const row = w.db
      .prepare('SELECT q.answer AS answer FROM session_questions s JOIN past_questions q ON q.id = s.question_id WHERE s.session_id = ? AND s.idx = ?')
      .get(sessionId, idx) as { answer: string }
    const wrong = row.answer === 'ア' ? 'イ' : 'ア'
    await call(w, 'POST', `/api/sessions/${sessionId}/answer`, { idx, answer: correct(idx) ? row.answer : wrong })
  }
}

/** 演習 8f14…（論点 2 の 10 問。位置 3 に SEO の問、位置 4 に解説の無い問）を作る。 */
async function drill(w: LearningWorld) {
  await start(w, DRILL_ID, { kind: 'drill', topicId: 2 })
  placeAt(w, DRILL_ID, '2018h30a-3', 3)
  placeAt(w, DRILL_ID, '2019r01a-4', 4)
}

/** 模試 3f2a…（令和6年度を通しで）を作り、開始の時刻を実例の時刻（MOCK_START）にする。 */
async function mock(w: LearningWorld) {
  await start(w, MOCK_ID, { kind: 'mock', exam: '2024r06' })
  w.db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(MOCK_START / 1000, MOCK_ID)
}

/** 令和6年度の模試で、テクノロジ系 33/45（問1 は誤答）・ストラテジ系 20/35・マネジメント系 11/20 になる正誤。 */
const mockCorrect = (idx: number) => {
  const n = idx + 1
  if (n <= 45) return n > 12
  if (n <= 80) return n > 60
  return n > 89
}

/** 進行中のテスト（演習）が既にある前提。 */
function inProgress(w: LearningWorld) {
  putSession(w.db, { id: '0d1e2f30-0000-4000-8000-00000000c0f1', userId: LEARNER.id, kind: 'drill', status: 'in_progress', scopeLabel: '論点「経営組織」', questionCount: 1 })
}

/** 間違えた問題が 25 問ある前提（締めた演習の誤答）。 */
function wrongHistory(w: LearningWorld) {
  putSession(w.db, { id: 'past-review-source', userId: LEARNER.id, kind: 'field', status: 'completed', scopeLabel: '分野「テクノロジ系」', questionCount: 25, correctCount: 0, finishedAt: 1_750_000_500 })
  for (let n = 2; n <= 26; n++)
    putSessionQuestion(w.db, { sessionId: 'past-review-source', questionId: `2024r06-${n}`, idx: n - 2, snapshot: {}, userAnswer: 'イ', result: 2, answeredAt: 1_750_000_000 + n })
}

const SUCCESS_IDS: Record<string, string> = {
  okDrill: DRILL_ID,
  okField: '1c0b9f2d-7e55-4b3a-8c21-0d9f6a4e7b13',
  okMiddle: '4e7a2b90-c13d-4f56-8a07-2d9b6e1f3c85',
  okReview: COMPLETED_ID,
  okMockExam: MOCK_ID,
  okMockRandom: UNFINISHED_ID,
}

const startSession: Operation = async (line) => {
  const w = await world(line.case === 'saveFailed' ? /^\s*insert\s+into\s+[`"]?session_questions/i : undefined)
  if (line.case.startsWith('inProgress')) inProgress(w)
  if (line.case === 'okReview') wrongHistory(w)
  const id = SUCCESS_IDS[line.case]
  return id ? withUuids([id], () => w.send(line, LEARNER)) : w.send(line, LEARNER)
}

const getCurrentQuestion: Operation = async (line) => {
  const w = await world()
  if (line.case === 'okInProgress') {
    await drill(w)
    await answerFirst(w, DRILL_ID, 3)
  } else if (line.case === 'okNoUnanswered') {
    await drill(w)
    await answerFirst(w, DRILL_ID, 10)
  } else if (line.case === 'okMockQuestion') {
    return withClock(MOCK_START, async () => {
      await mock(w)
      return w.send(line, LEARNER)
    })
  } else if (line.case === 'okMockExpired') {
    await withClock(MOCK_START, async () => {
      await mock(w)
      await answerFirst(w, MOCK_ID, 42)
    })
    return withClock(AFTER_LIMIT, () => w.send(line, LEARNER))
  } else {
    await drill(w)
  }
  return w.send(line, LEARNER)
}

const answerQuestion: Operation = async (line) => {
  const w = await world()
  switch (line.case) {
    case 'okCorrect':
    case 'invalidAnswer':
    case 'staleIdx':
    case 'unauthenticated':
      await drill(w)
      await answerFirst(w, DRILL_ID, 3)
      break
    case 'okNoExplanation':
      await drill(w)
      await answerFirst(w, DRILL_ID, 4)
      break
    case 'okMock':
      return withClock(MOCK_START, async () => {
        await mock(w)
        return w.send(line, LEARNER)
      })
    case 'alreadyCompleted':
      await start(w, COMPLETED_ID, { kind: 'drill', topicId: 2 })
      await answerFirst(w, COMPLETED_ID, 10)
      await call(w, 'POST', `/api/sessions/${COMPLETED_ID}/finish`, {})
      break
    case 'mockExpired':
      await withClock(MOCK_START, async () => {
        await mock(w)
        await answerFirst(w, MOCK_ID, 7)
      })
      return withClock(AFTER_LIMIT, () => w.send(line, LEARNER))
    default:
      await drill(w)
  }
  return w.send(line, LEARNER)
}

const finishSession: Operation = async (line) => {
  const w = await world()
  if (line.case === 'okMock') {
    return withClock(MOCK_START, async () => {
      await mock(w)
      await answerFirst(w, MOCK_ID, 100, mockCorrect)
      return w.send(line, LEARNER)
    })
  }
  await drill(w)
  await answerFirst(w, DRILL_ID, 10, (idx) => idx < 7)
  if (line.case === 'okAgain') await call(w, 'POST', `/api/sessions/${DRILL_ID}/finish`, {})
  return w.send(line, LEARNER)
}

/**
 * 結果の前提: 令和6年度が問1 の 1 問だけの学びで、模試 3f2a… を通しで受け、問1 を誤答して締めた。
 */
const getSessionResult: Operation = async (line) => {
  const w = await world(undefined, 1)
  if (line.case === 'notFinished') {
    await start(w, UNFINISHED_ID, { kind: 'mock' })
    return w.send(line, LEARNER)
  }
  await withClock(MOCK_START, async () => {
    await mock(w)
    await answerFirst(w, MOCK_ID, 1, () => false)
  })
  await withClock(MOCK_FINISH, () => call(w, 'POST', `/api/sessions/${MOCK_ID}/finish`, {}))
  // 締めた時刻は保存先の時計で記録されるので、実例の締めた時刻に置き直す
  w.db.prepare('UPDATE sessions SET finished_at = ? WHERE id = ?').run(MOCK_FINISH / 1000, MOCK_ID)
  return w.send(line, LEARNER)
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-004',
  operations: { startSession, getCurrentQuestion, answerQuestion, finishSession, getSessionResult },
})

