/**
 * UC-010 の端末の記憶の受け持ち（setLastPage・annotateLastPage・readLastPage・saveFeedbackDraft・readFeedbackDraft）。
 * `http` の操作（submitFeedback）は handlers/UC-010.ts が持つ。
 * 入口は `src/client/lib/` の export（save… は set…、read… は get…）。実例ごとに端末の記憶の代わりを新しく置く（kit/tc.ts）。
 * 応答は契約どおり「書いた・足したあとに読む」値（getLastPage・getFeedbackDraft）。
 * 前提:
 * - setLastPage.unavailable・saveFeedbackDraft.unavailable: 端末の記憶に書けない。
 * - annotateLastPage.okTopic: 論点の画面（setLastPage の実例の添え先）を覚えた端末。okQuestion: 問題の画面
 *   （submitFeedback の okWithQuestion の添え先の場所）を覚えた端末。noRecord: 添え先を覚えていない端末。
 *   unavailable: 添え先を覚えたあと、端末の記憶が読めず書けない。
 * - readLastPage.ok: 論点の画面を覚え、その論点を足した端末。okTopicThenQuestion: さらにその画面で問題を読み終えて足した端末。
 *   none: 覚えていない端末。broken: 覚えた値が壊れている端末。unavailable: 端末の記憶が読めない。
 * - saveFeedbackDraft.cleared: 下書きがある端末で空の本文を渡す。
 * - readFeedbackDraft.ok: 下書きがある端末。none: 下書きの無い端末。unavailable: 端末の記憶が読めない。
 */

import { answerFrom, deviceWorld } from '../kit/tc'
import { defineHandler, type ExampleLine } from '../kit/protocol'

type LastPage = { path: string; label: string; topicId?: number; questionId?: string }

const TOPIC_PAGE: LastPage = { path: '/topics/412', label: '学習の単位の詳細' }
const QUESTION_PAGE: LastPage = { path: '/sessions/51d0', label: '分野別の演習' }
const TOPIC_READ = { label: '学習の単位「LTV」', topicId: 412 }
const QUESTION_READ = { label: '学習の単位「LTV」 の 3 問目', questionId: '51d0e9b7-6a24-4c83-9f15-7b2e0d8a43c6#2' }
const DRAFT = '単位「LTV」の 1÷解約率のところが分かりにく'

const requested = <T>(line: ExampleLine) => line.request as T

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-010',
  operations: {
    setLastPage: async (line) => {
      const w = await deviceWorld()
      if (line.case === 'unavailable') w.blockWrites()
      return answerFrom(() => {
        w.lastPage.setLastPage(requested<LastPage>(line))
        return { lastPage: w.lastPage.getLastPage() }
      })
    },
    annotateLastPage: async (line) => {
      const w = await deviceWorld()
      if (line.case === 'okQuestion') w.lastPage.setLastPage(QUESTION_PAGE)
      else if (line.case !== 'noRecord') w.lastPage.setLastPage(TOPIC_PAGE)
      if (line.case === 'unavailable') {
        w.blockReads()
        w.blockWrites()
      }
      return answerFrom(() => {
        w.lastPage.annotateLastPage(requested<Partial<LastPage>>(line))
        return { lastPage: w.lastPage.getLastPage() }
      })
    },
    readLastPage: async (line) => {
      const w = await deviceWorld()
      if (line.case !== 'none') {
        w.lastPage.setLastPage(TOPIC_PAGE)
        w.lastPage.annotateLastPage(TOPIC_READ)
      }
      if (line.case === 'okTopicThenQuestion') w.lastPage.annotateLastPage(QUESTION_READ)
      if (line.case === 'broken') w.corrupt(TOPIC_PAGE.path)
      if (line.case === 'unavailable') w.blockReads()
      return answerFrom(() => ({ lastPage: w.lastPage.getLastPage() }))
    },
    saveFeedbackDraft: async (line) => {
      const w = await deviceWorld()
      if (line.case === 'cleared') await w.feedbackDraft.setFeedbackDraft(DRAFT)
      if (line.case === 'unavailable') w.blockWrites()
      return answerFrom(async () => {
        await w.feedbackDraft.setFeedbackDraft(requested<{ body: string }>(line).body)
        return { body: await w.feedbackDraft.getFeedbackDraft() }
      })
    },
    readFeedbackDraft: async (line) => {
      const w = await deviceWorld()
      if (line.case === 'ok') await w.feedbackDraft.setFeedbackDraft(DRAFT)
      if (line.case === 'unavailable') {
        await w.feedbackDraft.setFeedbackDraft(DRAFT)
        w.blockReads()
      }
      return answerFrom(async () => ({ body: await w.feedbackDraft.getFeedbackDraft() }))
    },
  },
})
