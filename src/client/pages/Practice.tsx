import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, apiCached } from '../lib/api'
import type { Field } from '../lib/api'

type Current = {
  session: {
    id: string
    kind: string
    scopeLabel: string
    questionCount: number
    answered: number
  } | null
}

// @implements REQ-015, REQ-019, REQ-025
export function Practice() {
  // null は「まだ取得していない」、[] は「取得した結果が空」。[] で初期化すると
  // 読み込み中に分野が1つも無いように見える。
  const [fields, setFields] = useState<Field[] | null>(null)
  const [current, setCurrent] = useState<Current['session']>(null)
  // 進行中の有無を取れていないことは、取れて「無い」ことと違う。黙って隠すと
  // 進行中を見落としたまま開始を押して 409 で弾かれる。
  const [fieldsError, setFieldsError] = useState('')
  const [currentError, setCurrentError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const reload = useCallback(() => {
    setCurrentError('')
    api<Current>('/sessions/current')
      .then((d) => setCurrent(d.session))
      .catch((e) => setCurrentError(e.message))
  }, [])

  const loadFields = useCallback(() => {
    setFieldsError('')
    apiCached<{ fields: Field[] }>('/fields')
      .then((d) => setFields(d.fields))
      .catch((e) => setFieldsError(e.message))
  }, [])

  useEffect(() => {
    loadFields()
    reload()
  }, [loadFields, reload])

  async function start(body: Record<string, unknown>) {
    setBusy(true)
    setError('')
    try {
      const s = await api<{ id: string }>('/sessions', { method: 'POST', body })
      navigate(`/sessions/${s.id}`)
    } catch (e: any) {
      setError(e.message)
      reload()
    } finally {
      setBusy(false)
    }
  }

  async function discard() {
    // 破棄は取り消せず、回答済みの分もまとめて消える。1クリックで消えるのは重い。
    if (!current) return
    if (!window.confirm(`回答済み ${current.answered} 問ごと破棄します。よろしいですか？`)) return
    setBusy(true)
    setError('')
    try {
      await api('/sessions/current', { method: 'DELETE' })
      setCurrent(null)
    } catch (e: any) {
      // 消せていないのに画面から消すと、進行中が残っていることに気づけない
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>練習テスト</h1>
      <p className="lead">
        範囲を絞って過去問を解きます。連続して正解した問題は、しばらく出題されません。
        同じ内容の問題は1問にまとめて出題します。
      </p>

      {current && (
        <div className="notice">
          進行中のテストがあります（{current.scopeLabel} / {current.answered}·{current.questionCount}問）。
          <div className="btn-row" style={{ marginTop: '0.6rem' }}>
            <button className="btn btn-primary" onClick={() => navigate(`/sessions/${current.id}`)}>
              再開する
            </button>
            <button className="btn" disabled={busy} onClick={discard}>
              破棄する
            </button>
          </div>
        </div>
      )}
      {currentError && (
        <div className="notice">
          {/* 文言は続けずに2行に分ける。API の返す文自体が「…できませんでした」なので、
              前置きを足すと謝罪が二重になる。 */}
          <p className="error" style={{ margin: 0 }}>
            {currentError}
          </p>
          <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.85rem' }}>
            進行中のテストがあるかどうかは確認できていません。
          </p>
          <div className="btn-row" style={{ marginTop: '0.6rem' }}>
            <button className="btn" onClick={reload}>
              再読み込み
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <h2>分野別演習</h2>
      {fieldsError && (
        <>
          <p className="error">{fieldsError}</p>
          <button className="btn" onClick={loadFields}>
            再読み込み
          </button>
        </>
      )}
      {fields === null && !fieldsError && <p className="muted">読み込み中…</p>}
      <div className="grid grid-3">
        {(fields ?? []).map((f) => (
          <button
            key={f.field}
            className="card"
            style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
            disabled={busy || !!current}
            onClick={() => start({ kind: 'field', field: f.field, size: 20 })}
          >
            <div className="term">{f.field}</div>
            <div className="muted" style={{ fontSize: '0.85rem' }}>
              {f.questions} 問から20問
            </div>
          </button>
        ))}
      </div>

      <h2>弱点復習</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          これまでに間違えた問題を、直近のものから20問出題します。
        </p>
        <button
          className="btn btn-primary"
          disabled={busy || !!current}
          onClick={() => start({ kind: 'review', size: 20 })}
        >
          間違えた問題を復習する
        </button>
      </div>

      {/* 同じ機能に3つの名前が付いていたので「論点ドリル」に寄せた（履歴の種別も同じ名前）。 */}
      <h2>論点ドリル</h2>
      <div className="card">
        <p style={{ margin: 0 }}>
          個別の論点で練習するときは、学習画面で論点を開き「この論点でドリル」から始めてください。
        </p>
      </div>
    </>
  )
}
