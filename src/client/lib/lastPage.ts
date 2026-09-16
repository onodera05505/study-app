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

export function setLastPage(p: LastPage) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 私用ブラウズなどで使えないことがある。添えられないだけなので無視 */
  }
}

export function getLastPage(): LastPage | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as LastPage) : null
  } catch {
    return null
  }
}

/** 画面が自分の中身（論点名・問題 ID）を知ったときに、名前と ID だけを上書きする。 */
export function annotateLastPage(patch: Partial<LastPage>) {
  const cur = getLastPage()
  if (!cur) return
  setLastPage({ ...cur, ...patch })
}
