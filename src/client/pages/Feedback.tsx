import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { getLastPage } from '../lib/lastPage'

/** フィードバック（要件 §5.5-4）。自由記述を送る。送った本人には受付の文だけ返す。
 *  その場で AI は応答しない（溜めて開発側が改善フェーズで読む）。 */
export function Feedback() {
  const last = getLastPage()
  // 途中の入力は遷移しても消さない（利用者の指摘 2026-09-16。警告ではなく下書きの保持で応える。送信で消す）
  const [text, setText] = useState(() => readDraft())
  const [attach, setAttach] = useState(!!last)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    writeDraft(text)
  }, [text])

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
          ...(attach && last
            ? { page: last.path, topicId: last.topicId, questionId: last.questionId }
            : {}),
        },
      })
      setDone(true)
      writeDraft('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

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
        {last && (
          <label className="feedback-attach">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />{' '}
            直前に開いていた画面（{last.label}）についての意見として送る
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || text.trim() === ''}>
            {busy ? '送信中…' : '送信する'}
          </button>
        </div>
      </form>
    </>
  )
}

const DRAFT_KEY = 'study-app:feedback-draft'
function readDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeDraft(v: string) {
  try {
    if (v) sessionStorage.setItem(DRAFT_KEY, v)
    else sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    /* 使えない環境では保持しないだけ */
  }
}

