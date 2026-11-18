/**
 * UC-003 の受け持ち（理解度の記録とホームの集計。資格対策の学び ip）。
 *
 * - recordUnderstanding: 論点 418 がある学び。999999 の論点は無い。
 * - getHomeSummary: 本人は山田（8a0f…）。時刻は日本時間の 2026-10-01 の昼に止める（visits.today）。
 *   ok: 論点 532 のうち理解 48・やや理解 16（どちらも本人の記録）。過去問が紐づき理解でない論点は 418（9 問）と 419（7 問）だけ
 *   （次に学ぶの候補）。締めた演習が 1 つ。開いた日は今日を含む 4 日連続・11 日連続の時期・飛び飛びの日で合計 37 日。
 *   okNoNextTopics: 532 の論点がすべて理解の記録を持つ。締めたテストは無い。開いた日は今日だけの連続・11 日連続の時期・
 *   飛び飛びの日で合計 38 日。
 */

import { LEARNER, learningWorld, putItem, putProgress, putSession, putTopic, type Item, type LearningWorld } from '../kit/learning'
import { withClock } from '../kit/outside'
import { defineHandler, type Operation } from '../kit/protocol'

const CRYPTO: Item = { id: 3, name: '暗号技術', field: 'テクノロジ系', majorNo: 3, major: '技術要素', middleNo: 12, middle: 'セキュリティ' }
const TODAY_NOON_JST = Date.UTC(2026, 9, 1, 3, 0, 0)
const DAY = 86_400_000

const recordUnderstanding: Operation = async (line) => {
  const w = await learningWorld()
  w.user(LEARNER.id, LEARNER.name)
  putTopic(w.db, { id: 418, term: '公開鍵暗号方式', item: CRYPTO, questions: 9 })
  return w.send(line, LEARNER)
}

/** 日本時間の暦日（today から daysBefore 日前）。 */
const dayOf = (daysBefore: number) => new Date(TODAY_NOON_JST - daysBefore * DAY + 9 * 3_600_000).toISOString().slice(0, 10)

/** 開いた日を置く: 今日まで streak 日連続、そのあと 1 日空けて飛び飛びに scattered 日、さらに空けて longest 日連続。 */
function visits(w: LearningWorld, streak: number, scattered: number, longest: number) {
  const days: number[] = []
  for (let i = 0; i < streak; i++) days.push(i)
  let next = streak + 1
  for (let i = 0; i < scattered; i++, next += 2) days.push(next)
  next += 1
  for (let i = 0; i < longest; i++) days.push(next + i)
  const put = w.db.prepare('INSERT INTO daily_visits (user_id, day) VALUES (?, ?)')
  for (const d of days) put.run(LEARNER.id, dayOf(d))
}

/** 論点を count 個置く（過去問は紐づけない）。status があれば本人の記録を置く。 */
function quietTopics(w: LearningWorld, firstId: number, count: number, status: number | null) {
  for (let i = 0; i < count; i++) {
    putTopic(w.db, { id: firstId + i, term: `論点${firstId + i}`, item: CRYPTO, questions: 0 })
    if (status !== null) putProgress(w.db, LEARNER.id, firstId + i, status)
  }
}

const getHomeSummary: Operation = async (line) => {
  const w = await learningWorld()
  w.user(LEARNER.id, LEARNER.name)
  putItem(w.db, CRYPTO)
  if (line.case === 'ok') {
    putTopic(w.db, { id: 418, term: '公開鍵暗号方式', item: CRYPTO, questions: 9 })
    putTopic(w.db, { id: 419, term: '共通鍵暗号方式', item: CRYPTO, questions: 7 })
    quietTopics(w, 1000, 48, 3)
    quietTopics(w, 2000, 16, 2)
    quietTopics(w, 3000, 532 - 48 - 16 - 2, null)
    putSession(w.db, {
      id: '6b2c91f4-10ad-4e7b-8d53-0c7f9a4e2b18',
      userId: LEARNER.id,
      kind: 'drill',
      status: 'completed',
      scopeLabel: '論点: 公開鍵暗号方式',
      questionCount: 9,
      correctCount: 7,
      startedAt: 1759276000,
      finishedAt: 1759276800,
    })
    visits(w, 4, 22, 11)
  }
  if (line.case === 'okNoNextTopics') {
    quietTopics(w, 1000, 532, 3)
    visits(w, 1, 26, 11)
  }
  return withClock(TODAY_NOON_JST, () => w.send(line, LEARNER))
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-003',
  operations: { recordUnderstanding, getHomeSummary },
})
