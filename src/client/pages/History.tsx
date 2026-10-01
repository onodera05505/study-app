import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { KIND_LABEL } from '../lib/labels'

type Row = {
  id: string
  kind: string
  scopeLabel: string
  questionCount: number
  correctCount: number | null
  finishedAt: number | null
}

// @implements-old REQ-233, REQ-235
// @implements REQ-095
export function History() {
  // null は「まだ取得していない」、[] は「取得した結果が空」
  const [rows, setRows] = useState<Row[] | null>(null)
  // 取得に失敗したまま null にしておくと「読み込み中…」が消えない
  const [error, setError] = useState('')

  // @implements REQ-101, BR-014
  const load = useCallback(() => {
    setError('')
    setRows(null)
    api<{ sessions: Row[] }>('/sessions')
      .then((d) => setRows(d.sessions))
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <>
      <h1>履歴</h1>
      <p className="lead">これまでに受験したテストの結果です。</p>
      <ul className="list">
        {(rows ?? []).map((r) => {
          const pct = r.correctCount !== null ? Math.round((r.correctCount / r.questionCount) * 100) : 0
          return (
            <li key={r.id}>
              {/* @implements REQ-098 */}
              <Link to={`/sessions/${r.id}/result`} className="row" style={{ color: 'inherit' }}>
                {/* 単位が無いと、ホーム（正答数）や /exams（「点」）の数字と
                    見分けが付かない。ここは正答率なので % を付ける。 */}
                <span className="freq pct">
                  <b>
                    {pct}
                    <i>%</i>
                  </b>
                  <small>
                    {r.correctCount ?? 0}/{r.questionCount}
                  </small>
                </span>
                <span className="grow">
                  <span className="term">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  <span className="meta"> {r.scopeLabel}</span>
                  <span className="meta">
                    {' '}
                    {r.finishedAt ? new Date(r.finishedAt * 1000).toLocaleString('ja-JP') : ''}
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
        {/* @implements REQ-100, BR-014 */}
        {error && (
          <li>
            <p className="error">{error}</p>
            <button className="btn" onClick={load}>
              再読み込み
            </button>
          </li>
        )}
        {rows === null && !error && <li className="muted">読み込み中…</li>}
        {/* @implements REQ-099, BR-015 */}
        {rows !== null && rows.length === 0 && (
          <li className="muted">まだ受験履歴がありません。</li>
        )}
      </ul>
    </>
  )
}
