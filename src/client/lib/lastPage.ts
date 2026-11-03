/** 「直前に開いていた画面」を覚えておく。フィードバックに自動で添えるため。
 *
 *  App が画面の移動ごとに記録する。/feedback 自身は記録しない（戻り先が自分になる）。
 *  論点の詳細（/topics/:id）と問題（/sessions/:id）はその ID も添える。ページを閉じれば消えてよいので sessionStorage。 */

export type LastPage = {
  path: string
  /** 人が読む名前（論点名など）。画面側が分かるときだけ入れる。 */
  label: string
  topicId?: number
  questionId?: string
}

const KEY = 'study-app:last-page'

// @implements REQ-146, REQ-242, BR-011, BR-012
export function setLastPage(p: LastPage) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 私用ブラウズなどで使えないことがある。添えられないだけなので無視 */
  }
}

/** 契約 LastPage の形（path は空でない文字列、label は文字列、topicId・questionId は在れば型どおり）か。 */
function isLastPage(v: unknown): v is LastPage {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (typeof o.path !== 'string' || o.path.length === 0) return false
  if (typeof o.label !== 'string') return false
  if (o.topicId !== undefined && !(Number.isInteger(o.topicId) && (o.topicId as number) >= 1)) return false
  if (o.questionId !== undefined && !(typeof o.questionId === 'string' && o.questionId.length <= 64)) return false
  return true
}

/** 覚えていない・読めない・形が壊れている記憶はどれも null。 */
// @implements REQ-242
export function getLastPage(): LastPage | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return isLastPage(v) ? v : null
  } catch {
    return null
  }
}

/** 画面が自分の中身（論点名・問題 ID）を知ったときに、名前と ID だけを上書きする。 */
// @implements REQ-148, REQ-149, BR-011
export function annotateLastPage(patch: Partial<LastPage>) {
  const cur = getLastPage()
  if (!cur) return
  setLastPage({ ...cur, ...patch })
}
