import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BackLink } from '../components/BackLink'
import { DupBadge } from '../components/DupBadge'
import { Explanation, type ExplanationData } from '../components/Explanation'
import { Figure } from '../components/Figure'
import { api } from '../lib/api'
import { formatChoice } from '../lib/choice'
import { exam } from '../exam'

type ResultData = {
  /** sourceExam が入っているのは公開回の通し受験。ランダム構成の模試は null。 */
  session: { kind: string; scopeLabel: string; questionCount: number; sourceExam: string | null }
  overall: { total: number; correct: number; pct: number }
  fields: { field: string; total: number; correct: number; pct: number }[]
  passed: boolean
  /** 制限時間切れで締められたか。押して終えたのか切れたのかを区別する。 */
  expired: boolean
  criteria: { overallPct: number; fieldPct: number }
  approximation: string
  items: {
    idx: number
    text: string
    choices: Record<string, string>
    answer: string
    userAnswer: string | null
    result: number
    citation: string
    modified: boolean
    hasFigure: boolean
    figureDescription: string | null
    figureImage: string | null
    /** 同一内容が何回出題されたか。1 なら出さない。 */
    timesAsked: number
    otherCitations: string[]
    topicId: number | null
    topicTerm: string | null
    /** 問題ごとの解説。まだ書かれていない問題は null。模試の結果にも出す。 */
    explanation: ExplanationData | null
  }[]
}

/** 合否の目安の見せ方。判定そのものは /api/sessions/:id が返す passed
 *  （基準は criteria: 総合の割合と分野の割合）。画面は文言と色だけを決める。 */
// @implements REQ-024
export function verdict(passed: boolean): { label: string; color: string } {
  return passed
    ? { label: '合格ライン', color: 'var(--ok)' }
    : { label: '未達', color: 'var(--ng)' }
}

/** 分野別の正答率に付ける色。分野ごとの基準点がある試験でだけ色を付ける。
 *  基準点の無い試験（応用情報の午前）で色を付けると、落ちると誤解させる。 */
// @implements REQ-024
export function fieldPctColor(
  pct: number,
  fieldPct: number,
  hasFieldThreshold: boolean,
): string | undefined {
  if (!hasFieldThreshold) return undefined
  return pct >= fieldPct ? 'var(--ok)' : 'var(--ng)'
}

// @implements REQ-024, REQ-027, REQ-028
export function Result() {
  const { id } = useParams()
  const [data, setData] = useState<ResultData | null>(null)
  const [onlyWrong, setOnlyWrong] = useState(true)
  // 解説は問題ごとに畳んでおく。全件展開だと 100 問の「すべて」が数万px になり、
  // 誤答を一覧して見比べるという読み方ができない（論点詳細と同じ流儀）。
  const [openExpl, setOpenExpl] = useState<Record<number, boolean>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    api<ResultData>(`/sessions/${id}`).then(setData).catch((e) => setError(e.message))
  }, [id])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">読み込み中…</p>

  const isMock = data.session.kind === 'mock'
  const items = onlyWrong ? data.items.filter((i) => i.result !== 1) : data.items

  return (
    <>
      <BackLink to="/history" label="履歴に戻る" />
      <h1>結果</h1>
      <p className="lead">{data.session.scopeLabel}</p>

      <div className="grid grid-3">
        <div className="card">
          <div className="stat">
            {data.overall.correct}
            <small> / {data.overall.total}</small>
          </div>
          <div className="muted" style={{ fontSize: '0.85rem' }}>
            正答率 {data.overall.pct}%
          </div>
        </div>
        {isMock && (
          <div className="card">
            <div className="stat" style={{ color: verdict(data.passed).color }}>
              {verdict(data.passed).label}
            </div>
            <div className="muted" style={{ fontSize: '0.85rem' }}>
              目安: 総合{data.criteria.overallPct}%
              {exam.fieldThreshold && ` かつ 各分野${data.criteria.fieldPct}%`}
            </div>
          </div>
        )}
      </div>

      {data.expired && (
        <div className="notice">制限時間切れのため、そこまでの回答で採点しています。</div>
      )}

      {data.fields.length > 0 && (
        <>
          <h2>分野別</h2>
          {/* 狭い画面で表がページごと横に伸びないよう、表だけをスクロールさせる */}
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>分野</th>
                <th className="right">正答</th>
                <th className="right">正答率</th>
              </tr>
            </thead>
            <tbody>
              {data.fields.map((f) => (
                <tr key={f.field}>
                  <td>{f.field}</td>
                  <td className="right">
                    {f.correct} / {f.total}
                  </td>
                  <td
                    className="right"
                    style={{
                      color: fieldPctColor(f.pct, data.criteria.fieldPct, exam.fieldThreshold),
                    }}
                  >
                    {f.pct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {isMock && <div className="notice">{data.approximation}</div>}

      <h2>問題ごとの振り返り</h2>
      <div className="btn-row" style={{ marginBottom: '1rem' }}>
        <button className={`btn ${onlyWrong ? 'btn-primary' : ''}`} onClick={() => setOnlyWrong(true)}>
          間違えた問題だけ
        </button>
        <button className={`btn ${!onlyWrong ? 'btn-primary' : ''}`} onClick={() => setOnlyWrong(false)}>
          すべて
        </button>
      </div>

      <ul className="list">
        {items.map((i) => (
          <li key={i.idx} className="card">
            {/* 出さないのは**公開回の通し受験だけ**（原本どおり全問出しているため）。
                ランダム構成の模試は同一内容を1問にまとめているので、練習テストと
                同じくバッジを出す。判別は sourceExam の有無で行う（Session.tsx と同じ）。 */}
            {!data.session.sourceExam && (
              <DupBadge timesAsked={i.timesAsked} otherCitations={i.otherCitations} />
            )}
            <p className="question" style={{ marginTop: 0 }}>{i.text}</p>
            <Figure hasFigure={i.hasFigure} description={i.figureDescription} image={i.figureImage} />
            <div className="choices">
              {Object.entries(i.choices).map(([k, v]) => (
                <div
                  key={k}
                  className={`choice choice-static ${k === i.answer ? 'correct' : k === i.userAnswer ? 'wrong' : ''}`}
                >
                  <b>{k}</b>
                  <span>
                    {formatChoice(v).map((line, n) => (
                      <span key={n} className="choice-line">
                        {line}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: '0.88rem', margin: '0.3rem 0' }}>
              {i.result === 1 ? (
                <span style={{ color: 'var(--ok)' }}>正解</span>
              ) : i.result === 2 ? (
                <span style={{ color: 'var(--ng)' }}>
                  不正解（あなたの解答: {i.userAnswer} / 正解: {i.answer}）
                </span>
              ) : (
                <span className="muted">未回答（正解: {i.answer}）</span>
              )}
              {i.topicId && (
                <>
                  {' ・ 論点: '}
                  <Link to={`/topics/${i.topicId}`}>{i.topicTerm}</Link>
                </>
              )}
            </p>
            {i.explanation && (
              <div className="btn-row">
                <button
                  className="btn"
                  onClick={() => setOpenExpl((s) => ({ ...s, [i.idx]: !s[i.idx] }))}
                >
                  {openExpl[i.idx] ? '解説を閉じる' : '解説を見る'}
                </button>
              </div>
            )}
            {openExpl[i.idx] && <Explanation data={i.explanation} answer={i.answer} />}
            {!exam.roadmap && (
              <p className="citation">
                {i.citation}
                {i.modified && <span className="modified-note">（一部改変）</span>}
              </p>
            )}
          </li>
        ))}
        {items.length === 0 && <li className="muted">間違えた問題はありません。</li>}
      </ul>
    </>
  )
}
