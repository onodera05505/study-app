// @vitest-environment jsdom
/** 「直前に開いていた画面」（src/client/lib/lastPage.ts、sessionStorage）と
 *  「最後に開いた論点」（src/client/lib/api.ts の LastTopic、localStorage）。 */

import { beforeEach, describe, expect, it } from 'vitest'
import { annotateLastPage, getLastPage, setLastPage } from '../../src/client/lib/lastPage'
import { clearToken, getLastTopic, setLastTopic, setToken } from '../../src/client/lib/api'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('添え先（UC-010）', () => {
  // @covers REQ-146#remember-page
  it('保存した画面が名前つきでそのまま戻る', () => {
    setLastPage({ path: '/topics/12', label: '学習の単位「LTV」' })
    expect(getLastPage()).toEqual({ path: '/topics/12', label: '学習の単位「LTV」' })
  })

  // @covers REQ-149#annotate-fresh
  it('論点と問題の ID を添えられる', () => {
    setLastPage({ path: '/topics/12', label: '学習の単位' })
    annotateLastPage({ topicId: 12, label: '学習の単位「LTV」' })
    expect(getLastPage()).toEqual({ path: '/topics/12', label: '学習の単位「LTV」', topicId: 12 })

    setLastPage({ path: '/sessions/s1', label: 'テスト中の問題' })
    annotateLastPage({ questionId: 's1#3', label: '弱点復習 の 4 問目' })
    expect(getLastPage()).toEqual({
      path: '/sessions/s1',
      label: '弱点復習 の 4 問目',
      questionId: 's1#3',
    })
  })

  // @covers REQ-148#annotate-without-record
  it('まだ何も開いていなければ null（添えるものが無い）', () => {
    expect(getLastPage()).toBeNull()
    // 記録が無いのに annotate が呼ばれても、行き先の無い記録を作らない
    annotateLastPage({ topicId: 12 })
    expect(getLastPage()).toBeNull()
  })

  // @covers REQ-242#unreadable-value
  it('壊れた値が入っていても null を返す（画面を止めない）', () => {
    sessionStorage.setItem('study-app:last-page', '{壊れた')
    expect(getLastPage()).toBeNull()
  })
})

describe('前回の続き（最後に開いた論点）', () => {
  // @covers REQ-077#saved-value-readable
  it('開いた論点を覚えて、次に開いたときに復元する', () => {
    expect(getLastTopic()).toBeNull()
    setLastTopic({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
    expect(getLastTopic()).toEqual({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
  })

  // @covers REQ-077#replaces-previous
  it('あとから開いた論点で置き換わる', () => {
    setLastTopic({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
    setLastTopic({ id: 88, term: 'CSRF', middle: '情報セキュリティ', middleNo: 11 })
    expect(getLastTopic()?.id).toBe(88)
  })

  // @covers REQ-082#unreadable-value
  it('壊れた値が入っていても null を返す（前回の続きを出さないだけ）', () => {
    localStorage.setItem('study-app.lastTopic', 'not json')
    expect(getLastTopic()).toBeNull()
  })

  // @covers REQ-198#token-and-device-memory-cleared
  it('ログアウトすると前回の続きも消える（同じ端末の別の人に出さない）', () => {
    setToken('dummy.token.value')
    setLastTopic({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
    clearToken()
    expect(getLastTopic()).toBeNull()
  })
})
