import { touchStorage } from './storage'

/** フィードバックの書きかけの本文の下書き。タブを閉じれば消えてよいので sessionStorage に置く。 */
const DRAFT_KEY = 'study-app:feedback-draft'

/** 端末の記憶にある下書きを読む。無ければ空文字。読めなければ名前つきの失敗を渡す。 */
// @implements REQ-153
// @operation UC-010#readFeedbackDraft
export function getFeedbackDraft(): string {
  return touchStorage(() => sessionStorage.getItem(DRAFT_KEY)) ?? ''
}

/** 下書きを端末の記憶に置く。空文字なら下書きを捨てる。書けない・消せなければ名前つきの失敗を渡す。 */
// @implements REQ-153
// @operation UC-010#saveFeedbackDraft
export function setFeedbackDraft(body: string): string {
  touchStorage(() => {
    if (body) sessionStorage.setItem(DRAFT_KEY, body)
    else sessionStorage.removeItem(DRAFT_KEY)
  })
  return body
}
