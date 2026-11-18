import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { getLastPage } from '../lib/lastPage'
import { getFeedbackDraft, setFeedbackDraft } from '../lib/feedbackDraft'
import { withoutStorage } from '../lib/storage'

/** フィードバック（要件 §5.5-4）。自由記述を送る。送った本人には受付の文だけ返す。
 *  その場で AI は応答しない（溜めて開発側が改善フェーズで読む）。 */
// @implements REQ-151, REQ-153
export function Feedback() {
  // 添え先が読めなければ覚えていない扱いにし、送ることは止めない
  // @implements REQ-242
  const last = withoutStorage(getLastPage, null)
  // 途中の入力は遷移しても消さない（警告ではなく下書きの保持で応える。受け付けられたら消す）
  const [text, setText] = useState(() => readDraft())
  // 種類（良かった／改善の提案／その他）。どれか 1 つを選んでから送る
  const [kind, setKind] = useState<'good' | 'improve' | 'other' | ''>('')
  const [attach, setAttach] = useState(!!last)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    writeDraft(text)
  }, [text])

  // 送信中に画面を離れても送信は取り消さない。受け付けられれば下書きを消し、拒まれるか届かなければ下書きを残す
  // @implements REQ-155, REQ-156, REQ-157, REQ-349, BR-014
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      await api('/feedback', {
        method: 'POST',
        body: {
          body: text,
          kind,
          ...(attach && last
            ? { page: last.path, topicId: last.topicId, questionId: last.questionId }
            : {}),
        },
      })
      setDone(true)
      setKind('')
      writeDraft('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // @implements REQ-158
  if (done) {
    return (
      <>
        <h1>フィードバック</h1>
        <div className="notice">
          <p style={{ margin: 0 }}>
            <b>フィードバックありがとうございます。</b>改善に活かします。
          </p>
        </div>
        <div className="btn-row" style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setText('')
              setDone(false)
            }}
          >
            もう 1 件送る
          </button>
          <Link className="btn" to={last?.path ?? '/'}>
            {last ? '元の画面に戻る' : 'ホームへ'}
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <h1>フィードバック</h1>
      <p className="lead">
        分かりにくかった所、間違いだと思う所、欲しい機能など、何でもどうぞ。
        いただいた内容は開発側で読んで、教材や画面の改善に使います（その場での返信はありません）。
      </p>
      <form onSubmit={submit} className="card flat" style={{ padding: '1rem' }}>
        <span className="fb-kinds-label">どれについてですか</span>
        <div className="fb-kinds" role="radiogroup" aria-label="フィードバックの種類">
          {KINDS.map((k) => (
            <label key={k.value} className={kind === k.value ? 'fb-kind on' : 'fb-kind'}>
              <input
                type="radio"
                name="kind"
                value={k.value}
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
              />
              {k.label}
            </label>
          ))}
        </div>
        <label>
          <span>内容</span>
          <textarea
            className="feedback-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            maxLength={2000}
            placeholder="例: 単位「LTV」の 1÷解約率のところが分かりにくかった"
            required
          />
          <small className="muted">{text.length} / 2,000</small>
        </label>
        {/* @implements REQ-151, REQ-152, BR-012 */}
        {last && (
          <label className="feedback-attach">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />{' '}
            直前に開いていた画面（{last.label}）についての意見として送る
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="btn-row">
          {/* @implements REQ-154 */}
          <button type="submit" className="btn btn-primary" disabled={busy || text.trim() === '' || kind === ''}>
            {busy ? '送信中…' : '送信する'}
          </button>
        </div>
      </form>
    </>
  )
}

const KINDS = [
  { value: 'good' as const, label: '良かった' },
  { value: 'improve' as const, label: '改善の提案' },
  { value: 'other' as const, label: 'その他' },
]

/** 下書きを読む。端末の記憶が使えなければ下書きが無い扱いにする。 */
function readDraft(): string {
  return withoutStorage(getFeedbackDraft, '')
}
/** 下書きを置く・捨てる。端末の記憶が使えなければ保持しないだけにする。 */
function writeDraft(v: string) {
  withoutStorage(() => setFeedbackDraft(v), '')
}

