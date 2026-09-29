import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { exam } from '../exam'

type Exam = {
  exam: string
  examLabel: string
  questions: number
  attempts: number
  bestScore: number | null
}

// @implements REQ-210, REQ-211, REQ-161
export function Exams() {
  // null は「まだ取得していない」、[] は「取得した結果が空」
  const [exams, setExams] = useState<Exam[] | null>(null)
  const [error, setError] = useState('')
  // 取得の失敗は操作の失敗と別に持つ。null のままにすると「読み込み中…」が消えない。
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(() => {
    setLoadError('')
    setExams(null)
    api<{ exams: Exam[] }>('/exams')
      .then((d) => setExams(d.exams))
      .catch((e) => setLoadError(e.message))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function start(body: Record<string, unknown>) {
    // 開始するとタイマーが走り出し、終わるまで練習系のテストが作れなくなる。
    // 1クリックで始まるのは重いので、一度受け止める。
    if (!window.confirm(`${exam.mockMinutes}分のタイマーが始まります。受験を開始しますか？`)) return
    setBusy(true)
    setError('')
    try {
      const s = await api<{ id: string }>('/sessions', { method: 'POST', body })
      navigate(`/sessions/${s.id}`)
    } catch (e: any) {
      setError(
        e.status === 409
          ? '進行中のテストがあります。練習テスト画面から再開または破棄してください。'
          : e.message,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>{exam.words.mock}</h1>
      <p className="lead">
        {exam.roadmap
          ? `${exam.mockSize}問・${exam.mockMinutes}分 で通しで解きます。途中で中断しても、時間内なら再開できます。`
          : `本番と同じ ${exam.mockSize}問・${exam.mockMinutes}分 で通しで解きます。途中で中断しても、時間内なら再開できます。`}
      </p>

      <div className="notice">
        {exam.passRule}
      </div>
      {error && <p className="error">{error}</p>}

      <h2>{exam.roadmap ? '1 日分（3 単位・6 問）を解く' : '公開回をそのまま解く'}</h2>
      <ul className="list">
        {(exams ?? []).map((e) => (
          <li key={e.exam} className="row">
            <span className="grow">
              <span className="term">{e.examLabel}</span>
              <span className="meta">
                {' '}
                {e.questions}問
                {/* bestScore は正答数（点数ではない）。IPA の本試験は1000点満点なので、
                    「点」と書くと別の数字に見える。 */}
                {e.attempts > 0 &&
                  ` ・ ${e.attempts}回受験 ・ 最高 ${e.bestScore ?? 0}/${e.questions}問`}
              </span>
            </span>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => start({ kind: 'mock', exam: e.exam })}
            >
              受験する
            </button>
          </li>
        ))}
        {loadError && (
          <li>
            <p className="error">{loadError}</p>
            <button className="btn" onClick={load}>
              再読み込み
            </button>
          </li>
        )}
        {exams === null && !loadError && <li className="muted">読み込み中…</li>}
        {exams !== null && exams.length === 0 && (
          <li className="muted">{exam.roadmap ? '取り込み済みの日がありません。' : '取り込み済みの回がありません。'}</li>
        )}
      </ul>

      <h2>全範囲からランダム</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          {exam.roadmap ? '全 42 単位から 1 問ずつ、分野の単位数（' : '取り込み済みの全回から、本番の分野比率（'}
          {Object.entries(exam.fieldRatio)
            .map(([f, n]) => `${exam.roadmap ? f : f.replace('系', '')}${n}`)
            .join('・')}
          ）に寄せて{exam.mockSize}問を構成します。繰り返し受験できます。
        </p>
        <button className="btn btn-primary" disabled={busy} onClick={() => start({ kind: 'mock' })}>
          ランダム{exam.mockSize}問で受験する
        </button>
      </div>
    </>
  )
}
