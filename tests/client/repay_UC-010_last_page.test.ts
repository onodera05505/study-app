// @vitest-environment jsdom
/** 「直前に開いていた画面」（添え先）の端末の記憶。置き換わること・読めない記憶に足さないこと・
 *  足し直すと最後に読み終えた物に置き換わることを見る。 */

import { beforeEach, describe, expect, it } from 'vitest'
import { annotateLastPage, getLastPage, setLastPage } from '../../src/client/lib/lastPage'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('添え先の置き換えと足し直し（UC-010）', () => {
  // @covers REQ-146#replace-previous
  it('続けて別の画面へ移ると、残るのは最後に移った画面だけ', () => {
    setLastPage({ path: '/topics/12', label: '学習の単位「LTV」' })
    annotateLastPage({ topicId: 12, label: '学習の単位「LTV」' })
    setLastPage({ path: '/sessions/s1', label: 'テスト中の問題' })
    // 前の画面の論点も持ち越さない
    expect(getLastPage()).toEqual({ path: '/sessions/s1', label: 'テスト中の問題' })
  })

  // @covers REQ-148#annotate-with-unreadable-record
  it('覚えた値が読めないとき、論点・問題を読み終えても添え先を作らない', () => {
    // 読めない値: JSON でない物と、JSON ではあるが契約 LastPage の形（path と label が要る）でない物
    const made: string[] = []
    for (const broken of ['{壊れた', '"文字列だけ"', '[]', '{"label":"場所の無い記録"}', '{"path":""}', 'null']) {
      sessionStorage.setItem('study-app:last-page', broken)
      annotateLastPage({ topicId: 12, label: '学習の単位「LTV」' })
      annotateLastPage({ questionId: 's1#3', label: '弱点復習 の 4 問目' })
      if (getLastPage() !== null) made.push(broken)
      sessionStorage.clear()
    }
    expect(made, '読めない値の上に添え先ができている').toEqual([])
  })

  // @covers REQ-149#annotate-again
  it('すでに論点を足してある添え先に足し直すと、最後に読み終えた物に置き換わり場所は変わらない', () => {
    setLastPage({ path: '/topics', label: '学習の単位の一覧' })
    annotateLastPage({ topicId: 12, label: '学習の単位「LTV」' })
    annotateLastPage({ topicId: 13, label: '学習の単位「CAC」' })
    expect(getLastPage()).toEqual({ path: '/topics', label: '学習の単位「CAC」', topicId: 13 })

    setLastPage({ path: '/sessions/s1', label: 'テスト中の問題' })
    annotateLastPage({ questionId: 's1#3', label: '弱点復習 の 4 問目' })
    annotateLastPage({ questionId: 's1#4', label: '弱点復習 の 5 問目' })
    expect(getLastPage()).toEqual({ path: '/sessions/s1', label: '弱点復習 の 5 問目', questionId: 's1#4' })
  })
})
