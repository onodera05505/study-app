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

  // BR-011 の守り。覚えた値が読めないときは添え先を覚えていない扱いに畳む（UC-010 にこれを持つ要件は無い）
  it('壊れた値が入っていても null を返す（画面を止めない）', () => {
    sessionStorage.setItem('study-app:last-page', '{壊れた')
    expect(getLastPage()).toBeNull()
  })

  // BR-011 の守り。端末が覚えられないときは添え先を覚えないだけにする（UC-010 にこれを持つ要件は無い）
  it('端末の記憶が使えないときも保存で例外を投げない（添えるものが無いだけ）', () => {
    const real = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('この端末では保存できない')
    }
    try {
      expect(() => setLastPage({ path: '/topics/12', label: '学習の単位' })).not.toThrow()
      expect(() => annotateLastPage({ topicId: 12 })).not.toThrow()
    } finally {
      Storage.prototype.setItem = real
    }
    expect(getLastPage()).toBeNull()
  })
})

describe('前回の続き（最後に開いた論点）', () => {
  // @verifies REQ-040, REQ-155
  it('開いた論点を覚えて、次に開いたときに復元する', () => {
    expect(getLastTopic()).toBeNull()
    setLastTopic({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
    expect(getLastTopic()).toEqual({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
  })

  // @verifies REQ-040
  it('あとから開いた論点で置き換わる', () => {
    setLastTopic({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
    setLastTopic({ id: 88, term: 'CSRF', middle: '情報セキュリティ', middleNo: 11 })
    expect(getLastTopic()?.id).toBe(88)
  })

  // @verifies REQ-158
  it('壊れた値が入っていても null を返す（前回の続きを出さないだけ）', () => {
    localStorage.setItem('study-app.lastTopic', 'not json')
    expect(getLastTopic()).toBeNull()
  })

  // @verifies REQ-069
  it('ログアウトすると前回の続きも消える（同じ端末の別の人に出さない）', () => {
    setToken('dummy.token.value')
    setLastTopic({ id: 231, term: 'LTV', middle: '事業の指標', middleNo: 4 })
    clearToken()
    expect(getLastTopic()).toBeNull()
  })
})
