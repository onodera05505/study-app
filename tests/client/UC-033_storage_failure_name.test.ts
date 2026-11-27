// @vitest-environment jsdom
/** UC-033 の REQ-572: 端末の記憶の操作のうち、契約が `errors` に STORAGE_UNAVAILABLE を挙げる操作は、
 *  端末の記憶に書けない・読めないとき、呼んだ側に断りの種類の名前を持つ失敗を渡す。
 *
 *  対象の操作は UC-005・UC-010・UC-013 の契約から数え上げた 7 つ（入口は src/client/lib/ の export。
 *  read… は get…、save… は set… に読み替える）:
 *    書く側: saveLastTopic → setLastTopic、setLastPage、annotateLastPage（読んでから書く）、
 *            saveFeedbackDraft → setFeedbackDraft（空の本文で消すことを含む）、saveToken → setToken
 *    読む側: readLastPage → getLastPage、annotateLastPage、readFeedbackDraft → getFeedbackDraft
 *  名前は投げられた値の `code` で読む。端末の記憶が使えないことは Storage の読み書きが例外を投げることで作り、
 *  鍵の名前には頼らない（鍵の名前は仕様ではない）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { annotateLastPage, getLastPage, setLastPage } from '../../src/client/lib/lastPage'
import { setLastTopic, setToken } from '../../src/client/lib/api'

const NAME = 'STORAGE_UNAVAILABLE'

/** 契約 UC-005 saveLastTopic・UC-010 setLastPage / annotateLastPage・saveFeedbackDraft・UC-013 saveToken の examples の値。 */
const LAST_TOPIC = { id: 412, term: '公開鍵暗号方式', middle: '情報セキュリティ', middleNo: 11 }
const LAST_PAGE = { path: '/topics/412', label: '学習の単位の詳細' }
const ANNOTATION = { label: '学習の単位「LTV」', topicId: 412 }
const DRAFT = '単位「LTV」の 1÷解約率のところが分かりにく'
const TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0ZDJiOGExMCIsIm5hbWUiOiJ0YXJvIiwicm9sZSI6Ik1FTUJFUiIsImV4cCI6MTc5OTk5OTk5OX0.c2lnbmF0dXJlLXNhbXBsZQ'

/** 下書きの読み書きの入口（src/client/lib/feedbackDraft.ts）。ほかの操作の検査を巻き込まないよう、使う所で読む。 */
const draftModule = () => import('../../src/client/lib/feedbackDraft')

/** 操作を呼び、渡された失敗を返す（渡さなければ undefined）。同期でも Promise でも受ける。 */
async function failureOf(op: () => unknown): Promise<unknown> {
  try {
    const result = op()
    if (result && typeof (result as Promise<unknown>).then === 'function') await result
  } catch (error) {
    return error
  }
  return undefined
}

const expectNamedFailure = async (op: () => unknown, label: string) => {
  const failure = await failureOf(op)
  expect(failure, `${label}: 失敗を渡していない`).toBeDefined()
  expect((failure as { code?: unknown } | null)?.code, `${label}: 失敗が断りの種類の名前を持たない`).toBe(NAME)
}

/** 端末の記憶に書けない（書く・消す・空にするが例外）。 */
const blockWrites = () => {
  const blocked = () => {
    throw new DOMException('端末の記憶が使えない', 'QuotaExceededError')
  }
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)
  vi.spyOn(Storage.prototype, 'clear').mockImplementation(blocked)
}

/** 端末の記憶が読めない（読むが例外）。 */
const blockReads = () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('端末の記憶が使えない', 'SecurityError')
  })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UC-033 REQ-572 端末の記憶の操作が渡す失敗の名前', () => {
  // @covers REQ-572#write-blocked
  it('端末の記憶に書けないとき、書く操作（saveLastTopic・setLastPage・annotateLastPage・saveFeedbackDraft とその消すこと・saveToken）は STORAGE_UNAVAILABLE を持つ失敗を渡す', async () => {
    const draft = await draftModule()
    // annotateLastPage が書く側に当たるよう、足す先の添え先は書ける間に覚えておく
    setLastPage(LAST_PAGE)
    blockWrites()
    await expectNamedFailure(() => setLastTopic(LAST_TOPIC), 'saveLastTopic')
    await expectNamedFailure(() => setLastPage(LAST_PAGE), 'setLastPage')
    await expectNamedFailure(() => annotateLastPage(ANNOTATION), 'annotateLastPage（書く側）')
    await expectNamedFailure(() => draft.setFeedbackDraft(DRAFT), 'saveFeedbackDraft')
    await expectNamedFailure(() => draft.setFeedbackDraft(''), 'saveFeedbackDraft（空の本文で消す）')
    await expectNamedFailure(() => setToken(TOKEN), 'saveToken')
  })

  // @covers REQ-572#read-blocked
  it('端末の記憶が読めないとき、読む操作（readLastPage・annotateLastPage・readFeedbackDraft）は STORAGE_UNAVAILABLE を持つ失敗を渡す', async () => {
    const draft = await draftModule()
    setLastPage(LAST_PAGE)
    await draft.setFeedbackDraft(DRAFT)
    blockReads()
    await expectNamedFailure(() => getLastPage(), 'readLastPage')
    await expectNamedFailure(() => annotateLastPage(ANNOTATION), 'annotateLastPage（読む側）')
    await expectNamedFailure(() => draft.getFeedbackDraft(), 'readFeedbackDraft')
  })

  // @covers REQ-572#broken-value-not-refusal
  it('端末の記憶は読めるが覚えた添え先が契約 LastPage の形に合わないとき、読む操作と足す操作は失敗を渡さず、覚えていないときと同じ null を返す', async () => {
    for (const broken of ['{壊れた', '"文字列だけ"', '[]', '{"label":"場所の無い記録"}']) {
      setLastPage(LAST_PAGE)
      // 覚えた添え先の値だけを壊す（鍵の名前に頼らず、覚えた値を持つ鍵を探す）
      let key: string | null = null
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)!
        if ((sessionStorage.getItem(k) ?? '').includes(LAST_PAGE.path)) key = k
      }
      for (let i = 0; key === null && i < localStorage.length; i++) {
        const k = localStorage.key(i)!
        if ((localStorage.getItem(k) ?? '').includes(LAST_PAGE.path)) key = k
      }
      expect(key, '仕込み: 覚えた添え先が端末の記憶に無い').not.toBeNull()
      const store = sessionStorage.getItem(key!) !== null ? sessionStorage : localStorage
      store.setItem(key!, broken)

      expect(await failureOf(() => getLastPage()), `${broken}: readLastPage が失敗を渡した`).toBeUndefined()
      expect(getLastPage(), `${broken}: 覚えていないときと同じでない`).toBeNull()
      expect(await failureOf(() => annotateLastPage(ANNOTATION)), `${broken}: annotateLastPage が失敗を渡した`).toBeUndefined()
      expect(getLastPage(), `${broken}: 足したあとも覚えていないときと同じでない`).toBeNull()
      localStorage.clear()
      sessionStorage.clear()
    }
  })
})
