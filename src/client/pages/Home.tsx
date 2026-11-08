import { exam } from '../exam'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, getLastTopic } from '../lib/api'
import type { LastTopic } from '../lib/api'
import { RESUME_LINK_STATE } from '../lib/resume'
import { KIND_LABEL } from '../lib/labels'

type Me = {
  user: { name: string }
  /** 全論点数と、理解済み・やや理解の件数。サーバが数えているものをそのまま出す。 */
  topics: { total: number; understood: number; partly: number }
  recentSessions: {
    id: string
    kind: string
    scopeLabel: string
    questionCount: number
    correctCount: number | null
    finishedAt: number | null
  }[]
  /** 「頻出なのに、まだ理解できていない」論点。最短合格の次の一手（server/index.ts）。 */
  nextTopics: {
    id: number
    term: string
    questionCount: number
    field: string
  }[]
  visits: { today: string; streak: number; longest: number; total: number }
}

type CurrentSession = {
  session: {
    id: string
    kind: string
    scopeLabel: string
    questionCount: number
    answered: number
  } | null
}

/** 受験した日を「今日」「昨日」「9/1」で出す。
 *
 *  年月日時分まで書くと行が2倍の長さになるうえ、知りたいのは
 *  「最近やったか」だけ。直近2日は言葉で、それより前は月日で出す。 */
function formatDay(sec: number): string {
  const d = new Date(sec * 1000)
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((midnight(new Date()) - midnight(d)) / 86400000)
  if (diff === 0) return '今日'
  if (diff === 1) return '昨日'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 数字を 0 から目標値まで数え上げる。
 *
 *  連続記録は毎日ほとんど変わらない数字なので、静止していると見慣れて意識に入らなくなる。
 *  開くたびに数え上げると、そのたびに「積み上がっている」ことが目に入る。
 *  動きを減らす設定の人には、いきなり結果だけ出す。 */
function useCountUp(target: number, ms = 700): number {
  const [n, setN] = useState(target)
  const raf = useRef(0)

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce || target <= 0) {
      setN(target)
      return
    }
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms)
      // 終わりに向かって減速させる。最後の1つが置かれる感じを出すため。
      const eased = 1 - Math.pow(1 - p, 3)
      setN(Math.round(target * eased))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    setN(0)
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, ms])

  return n
}

/** ホーム。連続記録・次の一手・前回の続きへの導線。 */
export function Home() {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState('')
  const [last, setLast] = useState<LastTopic | null>(null)
  // 進行中のテスト。ここでは補助情報なので、取れなくても黙って出さない
  // （進行中の有無を正面から扱うのは /practice の役目）。
  // @implements REQ-093
  const [current, setCurrent] = useState<CurrentSession['session']>(null)

  const load = useCallback(() => {
    setError('')
    api<Me>('/me')
      .then(setMe)
      .catch((e) => setError(e.message))
    api<CurrentSession>('/sessions/current')
      .then((d) => setCurrent(d.session))
      .catch(() => setCurrent(null))
  }, [])

  useEffect(() => {
    load()
    setLast(getLastTopic())
  }, [load])

  const shown = useCountUp(me?.visits.streak ?? 0)

  // h1 はどの状態でも1つ出す（axe の page-has-heading-one）。ホームには
  // 見出しとして出したい文字が無いので、読み上げ専用で置く。
  const heading = <h1 className="sr-only">ホーム</h1>

  // @implements REQ-047, BR-014
  if (error)
    return (
      <>
        {heading}
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>
          再読み込み
        </button>
      </>
    )
  if (!me)
    return (
      <>
        {heading}
        <p className="muted">読み込み中…</p>
      </>
    )

  const v = me.visits
  const next = me.nextTopics ?? []

  return (
    <>
      {heading}

      {/* 中断したテストへ戻る道を、開いた最初の画面のいちばん上で示す。 */}
      {/* @implements REQ-083, REQ-086 */}
      {current && (
        <div className="notice">
          進行中のテストがあります（{current.scopeLabel}・回答 {current.answered}/
          {current.questionCount}）。
          <div className="btn-row" style={{ marginTop: '0.6rem' }}>
            <Link className="btn btn-primary" to={`/sessions/${current.id}`}>
              再開する
            </Link>
          </div>
        </div>
      )}

      <div className="streak">
        <p className="streak-label">連続学習記録</p>
        <p className="streak-figure">
          <span className="streak-num">{shown}</span>
          <span className="streak-unit">日</span>
        </p>
        <p className="streak-sub">
          最長 <b>{v.longest}</b> 日 · 通算 <b>{v.total}</b> 日
        </p>
        <p className="streak-sub">
          理解 <b>{me.topics.understood}</b> / 全 <b>{me.topics.total}</b> 論点
        </p>
      </div>

      {/* このアプリの設計の中核は「出題頻度＝重要度」。頻出なのに理解できて
          いない論点こそが最短合格の次の一手なので、ホームの正面に出す。 */}
      {/* @implements REQ-044, REQ-046, BR-015 */}
      {next.length > 0 && (
        <section className="next-up">
          <h2>次に学ぶ</h2>
          <p className="muted" style={{ fontSize: '0.82rem', margin: '-0.4rem 0 0.6rem' }}>
            {exam.words.nextUp}
          </p>
          <ul className="list">
            {next.slice(0, 5).map((t) => (
              <li key={t.id}>
                <Link to={`/topics/${t.id}`} className="row">
                  <span className="freq">
                    <b>{t.questionCount}</b>
                    <small>回</small>
                  </span>
                  <span className="grow">
                    <span className="term">{t.term}</span>
                    <span className="meta">{t.field}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* @implements REQ-079, REQ-080, REQ-081, REQ-082 */}
      {last ? (
        <Link to={`/topics/${last.id}`} state={RESUME_LINK_STATE} className="resume">
          <span className="resume-label">前回の続き</span>
          <span className="resume-term">{last.term}</span>
          <span className="resume-meta">{last.middle}</span>
        </Link>
      ) : (
        <Link to="/topics" className="btn btn-primary btn-block go-study">
          学習に進む
        </Link>
      )}

      {last && (
        <Link to="/topics" className="btn btn-block go-study">
          単元の一覧から選ぶ
        </Link>
      )}

      {me.recentSessions.length > 0 && (
        <>
          <h2>最近の結果</h2>
          <ul className="list">
            {me.recentSessions.map((s) => (
              <li key={s.id}>
                <Link to={`/sessions/${s.id}/result`} className="row">
                  <span className="freq">
                    <b>{s.correctCount ?? 0}</b>
                    <small>/ {s.questionCount}</small>
                  </span>
                  <span className="grow">
                    <span className="term">{KIND_LABEL[s.kind] ?? s.kind}</span>
                    <span className="meta">{s.scopeLabel}</span>
                  </span>
                  {/* いつ受けたかが無いと、履歴のどれが直近か分からない */}
                  {s.finishedAt && <span className="when">{formatDay(s.finishedAt)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
