import { exam } from '../exam'
import { tierLabelOf } from '../../shared/exam'
import { useEffect, useState } from 'react'
import { annotateLastPage } from '../lib/lastPage'
import { withoutStorage } from '../lib/storage'
import { Link, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom'
import { BackLink } from '../components/BackLink'
import { DupBadge } from '../components/DupBadge'
import { Explanation, type ExplanationData } from '../components/Explanation'
import { Figure } from '../components/Figure'
import { Markdown } from '../components/Markdown'
import { api, clearLastTopic, getLastTopic, setLastTopic, invalidateCached } from '../lib/api'
import type { FrequencyTier, StatusSource, StatusValue, TopicLink } from '../lib/api'
import { isFromResumeLink, type ResumeGoneState } from '../lib/resume'
import { formatChoice } from '../lib/choice'
import { TierBadge } from '../components/TierBadge'
import { FrequencyMark, StatusChoice, TopicUnderstanding } from '../components/StatusBadge'

type Detail = {
  topic: {
    id: number
    /** 論点の名前。副題を含まない */
    term: string
    /** 名前に添える副題。副題を持たない論点では null */
    subtitle: string | null
    explanation: string | null
    detail: string | null
    questionCount: number
    frequencyTier: FrequencyTier | null
    status: StatusValue | null
    statusSource: StatusSource | null
    field: string
    major: string
    middle: string
    middleNo: number
    itemName: string
    /** 印の段。印を持たない学びでは null */
    tier: number | null
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
  /** 前提の論点。単元の構成に書かれた順 */
  prerequisites: TopicLink[]
  /** 同じまとまり（構成の無い単元では同じ小項目）の他の論点。配列の順が一覧の並び */
  siblings: TopicLink[]
  /** いま開いている論点を除いた次に学ぶの先頭（ホームの次に学ぶと同じ定義）。
   *  尽きたら null で、画面はグレーアウトの完了表示にする。 */
  nextTopic: TopicLink | null
  neighbors: { prev: { id: number; term: string } | null; next: { id: number; term: string } | null } | null
}

/** 論点の画面から他の論点へ移る 1 行。出題頻度と出題回数の印を添える。 */
function TopicLinkRow({ link }: { link: TopicLink }) {
  return (
    <Link to={`/topics/${link.id}`} className="row">
      <span className="freq">
        <b>{link.questionCount}</b>
        <small>回</small>
        <FrequencyMark tier={link.frequencyTier} />
      </span>
      <span className="grow term">{link.term}</span>
    </Link>
  )
}

// @implements REQ-023
export function TopicDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // 履歴で戻った・再読み込みで来た（POP）ときは、履歴に印が残っていても導線を選んだことにはならない
  const navigationType = useNavigationType()
  const fromResumeLink = navigationType !== 'POP' && isFromResumeLink(location.state)
  // 取り直すたびに増やし、教材の取得をやり直す
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<Detail | null>(null)
  const [status, setStatus] = useState<number>(1)
  // 資格対策で、示している理解度が回答の履歴からの判定か本人の上書きか。ロードマップ型では null
  const [source, setSource] = useState<StatusSource | null>(null)
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
        // ロードマップ型で記録が無い論点は未理解（BR-029）。資格対策は未（0）を含めてそのまま示す
        setStatus(d.topic.status ?? 1)
        setSource(d.topic.statusSource ?? null)
        // フィードバックに添える（どの単位を読んでいたか）。端末の記憶が使えなければ添えないだけ
        withoutStorage(() => annotateLastPage({ topicId: d.topic.id, label: `学習の単位「${d.topic.term}」` }), null)
        // ホームに「前回の続き」を出すために控えておく。端末が覚えられなくても論点の画面は止めない
        // @implements REQ-078
        withoutStorage(
          () =>
            setLastTopic({
              id: d.topic.id,
              term: d.topic.term,
              middle: d.topic.middle,
              middleNo: d.topic.middleNo,
            }),
          null,
        )
      })
      .catch((e) => {
        // @implements REQ-342
        if (fromResumeLink && e.status === 404) {
          const gone: ResumeGoneState = { resumeGone: { term: getLastTopic()?.term ?? null } }
          clearLastTopic()
          navigate('/topics', { replace: true, state: gone })
          return
        }
        setError(e.message)
      })
  }, [id, attempt, fromResumeLink, navigate])

  // @implements REQ-038, REQ-039, REQ-040, BR-014
  async function mark(next: number) {
    const prev = status
    const prevSource = source
    setStatus(next)
    // 資格対策では、記録した段階はその後に回答するまで本人の上書きとして効く（BR-050）
    if (prevSource !== null) setSource('override')
    setMarkError('')
    try {
      await api(`/topics/${id}/progress`, { method: 'PUT', body: { status: next } })
      invalidateCached() // 単元一覧の集計は覚えたものを出しているので捨てる
    } catch (e: any) {
      // 保存できていないのに押したままの見た目にすると、記録されたと誤解する。
      // 表示を元の値に戻したうえで、その場で失敗したことを言う。
      setStatus(prev)
      setSource(prevSource)
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

  // @implements REQ-033, BR-014
  if (error)
    return (
      <>
        <p className="error">{error}</p>
        <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
          再読み込み
        </button>
      </>
    )
  if (!data) return <p className="muted">読み込み中…</p>
  const t = data.topic
  // @implements REQ-032
  const FIRST_QUESTIONS = 5
  const shownQuestions = allQuestions ? data.questions : data.questions.slice(0, FIRST_QUESTIONS)
  const hiddenQuestions = data.questions.length - shownQuestions.length

  return (
    <>
      {/* @implements REQ-029, REQ-141, BR-016 */}
      <BackLink to={exam.roadmap ? '/topics' : `/topics?middleNo=${t.middleNo}`} label={exam.roadmap ? 'ロードマップに戻る' : `${t.middle} に戻る`} />
      {/* 階層の道筋は資格対策の学びだけに示し、ロードマップ型の学びでは示さない */}
      {/* 段は 単元の一覧 → 分野 → 単元 → 論点。単元の一覧と単元は押せるようにする。1論点を読んだあと、同じ単元の隣へ進めるため。 */}
      {/* @implements REQ-423, REQ-424 */}
      {!exam.roadmap && (
        <nav className="crumb" aria-label="階層の道筋">
          <Link to="/topics">単元の一覧</Link> / {t.field} /{' '}
          <Link to={`/topics?middleNo=${t.middleNo}`}>{t.middle}</Link> / <span aria-current="page">{t.term}</span>
        </nav>
      )}
      {/* 見出しは名前だけにし、副題は見出しの外に従として添える */}
      {/* @implements REQ-416 */}
      <h1 className={t.subtitle ? 'has-subtitle' : undefined}>{t.term}</h1>
      {t.subtitle && <p className="topic-subtitle">{t.subtitle}</p>}
      {/* @implements REQ-284, REQ-285 */}
      {exam.roadmap && tierLabelOf(exam.roadmapSpec, t.tier) && (
        <p className="rm-tier-topic">
          <TierBadge level={t.tier} label={tierLabelOf(exam.roadmapSpec, t.tier)!} />
        </p>
      )}
      {!exam.roadmap && (
        <p className="lead">
          過去問で <b>{t.questionCount} 回</b> 出題されています。
          {/* @implements REQ-478 */}
          {t.frequencyTier && (
            <>
              {' '}
              <FrequencyMark tier={t.frequencyTier} />
            </>
          )}
        </p>
      )}
      {!exam.roadmap && source && <TopicUnderstanding status={status} source={source} />}

      {/* @implements REQ-479 */}
      {!exam.roadmap && data.prerequisites.length > 0 && (
        <section className="prereq">
          <h2>前提の論点</h2>
          <ul className="list">
            {data.prerequisites.map((p) => (
              <li key={p.id}>
                <TopicLinkRow link={p} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* @implements REQ-026 */}
      {t.explanation ? (
        <div className="card">
          <Markdown source={t.explanation} />
          {/* @implements REQ-030 */}
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
          この論点の解説はまだ作成されていません。下の{exam.words.question}と解答で学習できます。
        </div>
      )}

      {/* ロードマップ型は論点ドリルを出さない。1 単位 2 問で、同じ問題がすぐ下に並んでいるため。
          資格版は 1 論点に過去問が多数あり、時間を測って記録に残る演習として働くので残す */}
      {!exam.roadmap && (
        <>
          <div className="btn-row" style={{ marginTop: '1rem' }}>
            <button className="btn" onClick={drill} disabled={t.questionCount === 0}>
              論点ドリルを始める（{t.questionCount}問）
            </button>
          </div>
          {drillError && <p className="error">{drillError}</p>}
        </>
      )}

      {/* @implements REQ-137 */}
      <h2>{exam.roadmap ? 'この単位の確認問題' : 'この論点が出題された過去問'}</h2>
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
              {/* @implements REQ-031 */}
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
                    {openExpl[q.id] ? '問題解説を閉じる' : '問題解説'}
                  </button>
                )}
              </div>
              {open && openExpl[q.id] && (
                <Explanation data={q.explanation} answer={q.answer} />
              )}
              {/* 自作の確認問題（ロードマップ型）は出典を出さない。データは持っている */}
              {/* @implements BR-027 */}
              {!exam.roadmap && (
                <p className="citation">
                  {q.citation}
                  {!!q.modified && <span className="modified-note">（一部改変）</span>}
                </p>
              )}
            </li>
          )
        })}
        {/* @implements REQ-026 */}
        {data.questions.length === 0 && <li className="muted">{exam.roadmap ? '確認問題がありません。' : '紐づく過去問がありません。'}</li>}
      </ul>
      {hiddenQuestions > 0 && (
        <div className="btn-row" style={{ marginTop: '0.6rem' }}>
          <button className="btn" onClick={() => setAllQuestions(true)}>
            残り {hiddenQuestions} 問を表示
          </button>
        </div>
      )}

      {/* @implements REQ-023, REQ-138 */}
      {!exam.roadmap && data.siblings.length > 0 && (
        <>
          <h2>他の論点</h2>
          <p className="muted" style={{ fontSize: '0.82rem', marginTop: '-0.4rem' }}>
            単元 <Link to={`/topics?middleNo=${t.middleNo}`}>{t.middle}</Link> の全体はこちら。
          </p>
          <ul className="list">
            {data.siblings.map((s) => (
              <li key={s.id}>
                <TopicLinkRow link={s} />
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 次に学ぶ。並びはホームの次に学ぶと同じ定義（BR-030）で、ここで別の並びを作らない。
          尽きたらグレーアウトの完了表示。 */}
      {/* @implements REQ-045, REQ-138, REQ-269 */}
      {!exam.roadmap && (
      <div className="next-move">
        {data.nextTopic ? (
          <Link to={`/topics/${data.nextTopic.id}`} className="next-move-link">
            <span className="next-move-label">次に学ぶ</span>
            <span className="next-move-term">{data.nextTopic.term}</span>
            <span className="freq">
              <b>{data.nextTopic.questionCount}</b>
              <small>回</small>
              <FrequencyMark tier={data.nextTopic.frequencyTier} />
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
      )}

      {/* ロードマップ型: 順番で前後へ。「他の論点」「次に学ぶ」は出さない */}
      {/* @implements REQ-139, REQ-140 */}
      {exam.roadmap && (
        <div className="btn-row rm-nav" style={{ margin: '1.2rem 0 0.4rem' }}>
          {data.neighbors?.prev ? (
            <Link className="btn" to={`/topics/${data.neighbors.prev.id}`}>← 前の単位（{data.neighbors.prev.term}）</Link>
          ) : (
            <button type="button" className="btn" disabled>← 前の単位（最初）</button>
          )}
          {data.neighbors?.next ? (
            <Link className="btn btn-primary" to={`/topics/${data.neighbors.next.id}`}>次の単位（{data.neighbors.next.term}）→</Link>
          ) : (
            <button type="button" className="btn" disabled>次の単位（最後）</button>
          )}
        </div>
      )}

      {/* 読み終えた位置から戻れるようにする。戻るリンクは上にもあるが、教材を読み切った後は画面の下端にいる。 */}
      <div className="btn-row" style={{ margin: '0.8rem 0 1rem' }}>
        <Link className="btn" to={exam.roadmap ? '/topics' : `/topics?middleNo=${t.middleNo}`}>
          {exam.roadmap ? 'ロードマップに戻る' : `${t.middle} の一覧に戻る`}
        </Link>
        <Link className="btn" to="/">
          ホームへ
        </Link>
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
        <StatusChoice status={status} onChoose={mark} />
      </div>
    </>
  )
}
