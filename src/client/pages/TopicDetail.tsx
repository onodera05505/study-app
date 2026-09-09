import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BackLink } from '../components/BackLink'
import { DupBadge } from '../components/DupBadge'
import { Explanation, type ExplanationData } from '../components/Explanation'
import { Figure } from '../components/Figure'
import { Markdown } from '../components/Markdown'
import { STATUS_LABEL, api, setLastTopic } from '../lib/api'
import { formatChoice } from '../lib/choice'

type Detail = {
  topic: {
    id: number
    term: string
    explanation: string | null
    detail: string | null
    questionCount: number
    status: number | null
    field: string
    major: string
    middle: string
    middleNo: number
    itemName: string
  }
  questions: {
    id: string
    number: number
    examLabel: string
    text: string
    choices: Record<string, string>
    answer: string
    hasFigure: number
    figureDescription: string | null
    figureImage: string | null
    citation: string
    modified: number
    timesAsked: number
    otherCitations: string[]
    /** 問題ごとの解説。まだ書かれていない問題は null。 */
    explanation: ExplanationData | null
  }[]
  siblings: { id: number; term: string; questionCount: number }[]
  /** 頻出なのに未理解の論点の先頭（＝ホームの「次の一手」と同じ定義）。
   *  尽きたら null で、画面はグレーアウトの完了表示にする。 */
  nextTopic: { id: number; term: string; questionCount: number } | null
}

export function TopicDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<Detail | null>(null)
  const [status, setStatus] = useState<number>(1)
  const [openDetail, setOpenDetail] = useState(false)
  const [openQuestions, setOpenQuestions] = useState<Record<string, boolean>>({})
  // 解説は問題ごとに畳んでおく。一覧に全問の解説が開いていると、
  // 解いて確かめるという読み方ができない。
  const [openExpl, setOpenExpl] = useState<Record<string, boolean>>({})
  // 過去問は最初の5問だけ出す。20問並ぶ論点はスマホで1万px を超えていて、
  // 教材を読み終えたあとの「他に何があるか」が見渡せない。
  const [allQuestions, setAllQuestions] = useState(false)
  // 取得の失敗（読むものが無い）と操作の失敗（読むものはある）を分ける。
  // 一緒にすると、ドリル開始に失敗しただけで読んでいた教材が消える。
  const [error, setError] = useState('')
  const [drillError, setDrillError] = useState('')
  const [markError, setMarkError] = useState('')

  useEffect(() => {
    setData(null)
    setOpenDetail(false)
    setAllQuestions(false)
    setError('')
    setDrillError('')
    setMarkError('')
    api<Detail>(`/topics/${id}`)
      .then((d) => {
        setData(d)
        setStatus(d.topic.status ?? 1)
        // ホームに「前回の続き」を出すために控えておく
        setLastTopic({
          id: d.topic.id,
          term: d.topic.term,
          middle: d.topic.middle,
          middleNo: d.topic.middleNo,
        })
      })
      .catch((e) => setError(e.message))
  }, [id])

  async function mark(next: number) {
    const prev = status
    setStatus(next)
    setMarkError('')
    try {
      await api(`/topics/${id}/progress`, { method: 'PUT', body: { status: next } })
    } catch (e: any) {
      // 保存できていないのに押したままの見た目にすると、記録されたと誤解する。
      // 表示を元の値に戻したうえで、その場で失敗したことを言う。
      setStatus(prev)
      setMarkError(e.message)
    }
  }

  async function drill() {
    setDrillError('')
    try {
      const s = await api<{ id: string }>('/sessions', {
        method: 'POST',
        body: { kind: 'drill', topicId: Number(id) },
      })
      navigate(`/sessions/${s.id}`)
    } catch (e: any) {
      setDrillError(
        e.status === 409
          ? '進行中のテストがあります。練習テスト画面から再開または破棄してください。'
          : e.message,
      )
    }
  }

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">読み込み中…</p>
  const t = data.topic
  const FIRST_QUESTIONS = 5
  const shownQuestions = allQuestions ? data.questions : data.questions.slice(0, FIRST_QUESTIONS)
  const hiddenQuestions = data.questions.length - shownQuestions.length

  return (
    <>
      <BackLink to={`/topics?middleNo=${t.middleNo}`} label={`${t.middle} に戻る`} />
      {/* パンくずは押せるようにする。1論点を読んだあと、同じ単元の隣へ進めるため。 */}
      <p className="crumb">
        <Link to="/topics">学習</Link> / {t.field} / {t.major} /{' '}
        <Link to={`/topics?middleNo=${t.middleNo}`}>{t.middle}</Link>
      </p>
      <h1>{t.term}</h1>
      <p className="lead">
        過去問で <b>{t.questionCount} 回</b> 出題されています。
      </p>

      {t.explanation ? (
        <div className="card">
          <Markdown source={t.explanation} />
          {t.detail && (
            <>
              <button
                className="btn"
                style={{ marginTop: '0.9rem' }}
                onClick={() => setOpenDetail((v) => !v)}
              >
                {openDetail ? '詳しい解説を閉じる' : '詳しく解説'}
              </button>
              {openDetail && <Markdown source={t.detail} className="md-detail" />}
            </>
          )}
        </div>
      ) : (
        <div className="notice">
          この論点の解説はまだ作成されていません。下の過去問と解答で学習できます。
        </div>
      )}

      <div className="btn-row" style={{ marginTop: '1rem' }}>
        <button className="btn" onClick={drill} disabled={t.questionCount === 0}>
          この論点でドリル（{t.questionCount}問）
        </button>
      </div>
      {drillError && <p className="error">{drillError}</p>}

      <h2>この論点が出題された過去問</h2>
      <ul className="list">
        {shownQuestions.map((q) => {
          const open = openQuestions[q.id]
          return (
            <li key={q.id} className="card">
              <DupBadge timesAsked={q.timesAsked} otherCitations={q.otherCitations} />
              <p className="question" style={{ marginTop: 0 }}>{q.text}</p>
              <Figure hasFigure={q.hasFigure} description={q.figureDescription} image={q.figureImage} />
              <div className="choices">
                {/* ここの選択肢は読むだけで押せない。出題画面のボタンと同じ見た目だと
                    押せると思って触ってしまうので、choice-static で一段淡くする。 */}
                {Object.entries(q.choices).map(([k, v]) => (
                  <div
                    key={k}
                    className={`choice choice-static ${open && k === q.answer ? 'correct' : ''}`}
                  >
                    <b>{k}</b>
                    <span>
                      {formatChoice(v).map((line, i) => (
                        <span key={i} className="choice-line">
                          {line}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
              <div className="btn-row">
                <button
                  className="btn"
                  onClick={() => setOpenQuestions((s) => ({ ...s, [q.id]: !s[q.id] }))}
                >
                  {open ? '答えを隠す' : '答えを見る'}
                </button>
                {/* 解説は正解が分かってから。答えを見る前に出すと、
                    「解いてから確かめる」という読み方ができなくなる。 */}
                {open && q.explanation && (
                  <button
                    className="btn"
                    onClick={() => setOpenExpl((s) => ({ ...s, [q.id]: !s[q.id] }))}
                  >
                    {openExpl[q.id] ? '解説を閉じる' : '解説'}
                  </button>
                )}
              </div>
              {open && openExpl[q.id] && (
                <Explanation data={q.explanation} answer={q.answer} />
              )}
              <p className="citation">
                {q.citation}
                {!!q.modified && <span className="modified-note">（一部改変）</span>}
              </p>
            </li>
          )
        })}
        {data.questions.length === 0 && <li className="muted">紐づく過去問がありません。</li>}
      </ul>
      {hiddenQuestions > 0 && (
        <div className="btn-row" style={{ marginTop: '0.6rem' }}>
          <button className="btn" onClick={() => setAllQuestions(true)}>
            残り {hiddenQuestions} 問を表示
          </button>
        </div>
      )}

      {data.siblings.length > 0 && (
        <>
          <h2>{t.itemName} の他の論点</h2>
          <p className="muted" style={{ fontSize: '0.82rem', marginTop: '-0.4rem' }}>
            残り {data.siblings.length} 論点。単元{' '}
            <Link to={`/topics?middleNo=${t.middleNo}`}>{t.middle}</Link> の全体はこちら。
          </p>
          <ul className="list">
            {data.siblings.map((s) => (
              <li key={s.id}>
                <Link to={`/topics/${s.id}`} className="row">
                  <span className="freq">
                    <b>{s.questionCount}</b>
                    <small>回</small>
                  </span>
                  <span className="grow term">{s.term}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 次の一手。順序はホームの nextTopics と同じ（頻出×未理解）。ここで別の並びを
          作らない——"次" の意味をアプリ全体で1つに保つため。この論点を「理解」にすると
          候補から外れて次が繰り上がる。尽きたらグレーアウトの完了表示。 */}
      <div className="next-move">
        {data.nextTopic ? (
          <Link to={`/topics/${data.nextTopic.id}`} className="next-move-link">
            <span className="next-move-label">次の一手</span>
            <span className="next-move-term">{data.nextTopic.term}</span>
            <span className="freq">
              <b>{data.nextTopic.questionCount}</b>
              <small>回</small>
            </span>
            <span className="next-move-arrow">→</span>
          </Link>
        ) : (
          <div className="next-move-done">
            頻出の論点はひととおり学べました。
            <Link to="/topics">単元の一覧へ</Link>
          </div>
        )}
      </div>

      {/* 理解度は解説を読み終えた直後に押すもの。下部に固定して、
          読んだ位置のまま押せるようにする。 */}
      {/* 保存の失敗はここで言う。ページ全体を差し替えると、読んでいた教材が消える。 */}
      {markError && (
        <>
          <p className="error" style={{ marginBottom: 0 }}>
            {markError}
          </p>
          <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.85rem' }}>
            理解度は保存できていません。もう一度押してください。
          </p>
        </>
      )}
      <div className="dock">
        <span className="lab">理解度</span>
        <span className="seg">
          {[1, 2, 3].map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => mark(s)}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </span>
      </div>
    </>
  )
}
