import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, getLastTopic } from '../lib/api'
import type { LastTopic } from '../lib/api'
import { discardCurrentSession } from '../lib/discardCurrent'
import { exam } from '../exam'
import { StatusBadge, statusRowClass } from '../components/StatusBadge'

/** その日の確認テスト。1 日＝1 回（過去問の「回」を日に割り当ててある） */
type DayExam = { exam: string; examLabel: string; questions: number; attempts: number; bestScore: number | null }

/** 進行中のテスト。範囲と回答の進み具合は GET /api/sessions/current から取る
 *  （テストを作る経路の 409 の本文は理由の文だけで、進行中のテストの中身は入らない）。 */
type InProgress = { id: string; scopeLabel: string; questionCount: number; answered: number }

/** 進行中のテストがあって、この日の確認を始められなかったことの案内。exam は押した日。
 *
 *  - `fetched` 範囲と進み具合が取れた（再開と破棄を選べる）
 *  - `fetchFailed` 取れなかった（理由と取り直す手段だけを出す。再開と破棄は宛先が無いので出さない）
 *  - `gone` 取りに行ったら進行中のテストが無かった（確かめているあいだに締められたか破棄された） */
type InProgressNotice =
  | { exam: string; kind: 'fetched'; session: InProgress }
  | { exam: string; kind: 'fetchFailed'; message: string }
  | { exam: string; kind: 'gone' }

type Unit = {
  id: number
  term: string
  questionCount: number
  status: number | null
  field: string
  middle: string
  itemName: string
  sortOrder: number | null
}

/** ロードマップ型（itc・mkt）の学習画面。日ごとの一覧。
 *
 *  資格版の「分野 → 単元 → 論点」は出題頻度で歩く形。ロードマップ型は学ぶ順が決まっているので、
 *  1 日目〜N 日目の並びそのままを 1 枚で見せ、いま学ぶ位置（最初のまだ理解していない単位）に印を付ける。
 *  ロードマップ外の「補足」は末尾に別枠で置く。 */
export function Roadmap() {
  // null は「まだ取得していない」、[] は「取得した結果が空」
  const [units, setUnits] = useState<Unit[] | null>(null)
  // 単位の並びの取得の失敗。これだけが一覧そのものを出せない失敗で、画面を置き換える
  const [error, setError] = useState('')
  // この日の確認は各日の見出しに置く
  const [exams, setExams] = useState<DayExam[] | null>(null)
  const [visits, setVisits] = useState<{ streak: number } | null>(null)
  const [last, setLast] = useState<LastTopic | null>(null)
  // この日の確認を始める操作の失敗。並びの取得の失敗とは別に持つ。これを error に混ぜると
  // 日ごとの並びが画面から消え、どの日で失敗したのかも分からなくなる
  const [startError, setStartError] = useState<{ exam: string; message: string } | null>(null)
  // ロードマップ型では練習テストの画面へ行けないので、進行中のテストはこの画面その場で扱う
  const [inProgress, setInProgress] = useState<InProgressNotice | null>(null)
  // 破棄の操作の失敗。案内は残したまま理由だけ添える
  const [discardError, setDiscardError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const perDay = exam.roadmapSpec?.perDay ?? 3
  const extraField = exam.roadmapSpec?.extraField ?? '補足（ロードマップ外）'

  // @implements REQ-127, REQ-136, BR-014
  const load = useCallback(() => {
    setError('')
    setStartError(null)
    setInProgress(null)
    setDiscardError('')
    setUnits(null)
    api<{ topics: Unit[] }>('/topics?limit=500')
      .then((d) => setUnits(d.topics))
      .catch((e) => setError(e.message))
    // 確認テストと連続日数は補助。取れなくても本体（一覧）は出す
    api<{ exams: DayExam[] }>('/exams').then((d) => setExams(d.exams)).catch(() => setExams([]))
    api<{ visits: { streak: number } }>('/me').then((d) => setVisits(d.visits)).catch(() => setVisits(null))
  }, [])

  useEffect(() => {
    load()
    setLast(getLastTopic())
  }, [load])

  /** 進行中のテストの範囲と回答の進み具合を取り、押した日の近くの案内にする。
   *
   *  取れなかったときは理由と取り直す手段（再読み込み）を出す。再開と破棄は宛先の
   *  テストの ID が要るので、取り直せてからでないと選べない。 */
  // @implements REQ-143, BR-014, BR-017
  const fetchInProgress = useCallback(async (examId: string) => {
    setBusy(true)
    setDiscardError('')
    setInProgress(null)
    try {
      const d = await api<{ session: InProgress | null }>('/sessions/current')
      setInProgress(
        d.session
          ? {
              exam: examId,
              kind: 'fetched',
              session: {
                id: d.session.id,
                scopeLabel: d.session.scopeLabel,
                questionCount: d.session.questionCount,
                answered: d.session.answered,
              },
            }
          : { exam: examId, kind: 'gone' },
      )
    } catch (e: any) {
      setInProgress({ exam: examId, kind: 'fetchFailed', message: e.message })
    } finally {
      setBusy(false)
    }
  }, [])

  /** この日の確認を始める。範囲はその日の単位だけ。
   *
   *  失敗は押した日の近くに出し、日ごとの並びは残す。409 は進行中のテストが 1 人 1 つという
   *  規則（サーバが守る）に当たったときで、新しいテストは作られず、出題の画面へも移さない。
   *  409 の本文は理由の文だけなので、案内の中身は進行中のテストを取り直して作る。 */
  // @implements REQ-142, REQ-143, REQ-276, BR-017
  async function startDay(e: DayExam) {
    if (busy) return
    setStartError(null)
    setInProgress(null)
    setDiscardError('')
    if (!window.confirm(`${e.examLabel}の確認（${e.questions} 問）を始めます。よろしいですか？`)) return
    setBusy(true)
    try {
      const s = await api<{ id: string }>('/sessions', { method: 'POST', body: { kind: 'mock', exam: e.exam } })
      navigate(`/sessions/${s.id}`)
    } catch (err: any) {
      if (err.status === 409) await fetchInProgress(e.exam)
      else setStartError({ exam: e.exam, message: err.message })
    } finally {
      setBusy(false)
    }
  }

  /** 進行中のテストを破棄する。確かめと破棄の要求そのものは discardCurrentSession が持つ。
   *  消せたら案内を消し、この日の確認を始められる状態に戻す。 */
  // @implements REQ-143
  async function discardInProgress() {
    if (inProgress?.kind !== 'fetched') return
    setBusy(true)
    setDiscardError('')
    const r = await discardCurrentSession(inProgress.session.answered)
    if (r === 'discarded') setInProgress(null)
    // 消せていないのに案内を消すと、進行中が残っていることに気づけない
    else if (typeof r === 'object') setDiscardError(r.error)
    setBusy(false)
  }

  // 単位の並びが取れないときだけ、一覧の代わりに失敗と読み直す手段を出す
  // @implements REQ-241
  if (error)
    return (
      <>
        <h1>ロードマップ</h1>
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>
          再読み込み
        </button>
      </>
    )

  const all = (units ?? []).slice().sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9) || a.term.localeCompare(b.term, 'ja'))
  const main = all.filter((u) => u.field !== extraField)
  const extras = all.filter((u) => u.field === extraField)
  // @implements REQ-129, REQ-134, REQ-135
  const days = new Map<number, Unit[]>()
  for (const u of main) {
    const d = u.sortOrder ? Math.ceil(u.sortOrder / perDay) : 0
    days.set(d, [...(days.get(d) ?? []), u])
  }
  // @implements REQ-130, BR-029
  const current = main.find((u) => (u.status ?? 1) < 3) // いま学ぶ位置
  const understood = main.filter((u) => u.status === 3).length

  return (
    <>
      <h1>ロードマップ</h1>
      {/* 続きの導線と連続記録はこの画面の先頭が受け皿 */}
      {/* @implements REQ-144, REQ-145, BR-013 */}
      <Link
        to={last ? `/topics/${last.id}` : current ? `/topics/${current.id}` : '/topics'}
        className="btn btn-primary btn-block go-study"
      >
        {last ? `前回の続きから（${last.term}）` : current ? `ここから（${current.term}）` : '最初の単位から始める'}
      </Link>
      {/* @implements REQ-131, REQ-132 */}
      <p className="lead">
        1 日 {perDay} 単位、全 {days.size} 日。順番どおりに読み、読んだら理解度を付けます。
        {visits && <> 連続 <b>{visits.streak}</b> 日。</>}
        {units && (
          <>
            {' '}
            理解 <b>{understood}</b> / {main.length} 単位
            {current && (
              <>
                。次は <Link to={`/topics/${current.id}`}>{current.term}</Link>
              </>
            )}
          </>
        )}
      </p>

      {/* @implements REQ-126, BR-015 */}
      {units === null && <p className="muted">読み込み中…</p>}
      {units !== null && main.length === 0 && <p className="muted">単位がありません。</p>}

      {[...days.keys()].sort((a, b) => a - b).map((d) => {
        const list = days.get(d)!
        const done = list.every((u) => u.status === 3)
        return (
          <section key={d} className="rm-day">
            <h2 className={done ? 'rm-day-head done' : 'rm-day-head'}>
              {d === 0 ? '順序なし' : `${d} 日目`}
              <span className="rm-dots" aria-label={`理解 ${list.filter((u) => u.status === 3).length} / ${list.length}`}>
                {list.map((u) => (
                  <i key={u.id} className={`st-${u.status ?? 1}`} />
                ))}
              </span>
              {done && <small>完了</small>}
            </h2>
            {/* この日の確認。範囲はこの日の単位だけ */}
            {/* @implements REQ-133 */}
            {(() => {
              const ex = (exams ?? []).find((e) => e.examLabel === `${d} 日目`)
              if (!ex) return null
              return (
                <>
                  <p className="rm-day-exam">
                    {/* 進行中のテストがあるあいだも押せる。断られたらその日の近くに案内を出す（REQ-143） */}
                    <button type="button" className="btn small" disabled={busy} onClick={() => startDay(ex)}>
                      この日の確認（{ex.questions} 問）
                    </button>
                    {ex.attempts > 0 && (
                      <span className="rm-day-score">
                        受けた {ex.attempts} 回 · 最高 <b>{ex.bestScore ?? 0}</b> / {ex.questions}
                      </span>
                    )}
                  </p>
                  {/* 進行中のテストがあること以外の理由で始められなかったとき、押した日の近くに
                      理由を出し、日ごとの並びは消さない */}
                  {/* @implements REQ-276, BR-014 */}
                  {startError?.exam === ex.exam && (
                    <p className="error" role="alert">
                      {startError.message}
                    </p>
                  )}
                  {/* 進行中のテストの範囲と進み具合、再開と破棄を押した日のその場に置く */}
                  {/* @implements REQ-143, BR-014, BR-017 */}
                  {inProgress && inProgress.exam === ex.exam && (
                    <div className="notice" role="alert">
                      {inProgress.kind === 'fetched' && (
                        <>
                          <p style={{ margin: 0 }}>
                            進行中のテストがあります（{inProgress.session.scopeLabel} / 回答済み{' '}
                            {inProgress.session.answered} / 全体 {inProgress.session.questionCount} 問）。
                            この日の確認は、再開か破棄のあとに始められます。
                          </p>
                          <div className="btn-row" style={{ marginTop: '0.6rem' }}>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => navigate(`/sessions/${inProgress.session.id}`)}
                            >
                              再開する
                            </button>
                            <button type="button" className="btn" disabled={busy} onClick={discardInProgress}>
                              破棄する
                            </button>
                          </div>
                          {discardError && (
                            <p className="error" style={{ margin: '0.6rem 0 0' }}>
                              {discardError}
                            </p>
                          )}
                        </>
                      )}
                      {/* 範囲と進み具合が取れないあいだは、再開と破棄の宛先が無い。
                          取れなかったことを隠さず、取り直す手段を添える */}
                      {inProgress.kind === 'fetchFailed' && (
                        <>
                          <p className="error" style={{ margin: 0 }}>
                            {inProgress.message}
                          </p>
                          <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.85rem' }}>
                            進行中のテストがあるため、この日の確認は始められません。進行中のテストの範囲と回答の進み具合が取れていません。
                          </p>
                          <div className="btn-row" style={{ marginTop: '0.6rem' }}>
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => fetchInProgress(ex.exam)}
                            >
                              再読み込み
                            </button>
                          </div>
                        </>
                      )}
                      {inProgress.kind === 'gone' && (
                        <p style={{ margin: 0 }}>
                          進行中のテストは、確かめているあいだに締められたか破棄されました。もう一度この日の確認を始めてください。
                        </p>
                      )}
                    </div>
                  )}
                </>
              )
            })()}
            <ul className="list">
              {list.map((u) => {
                const st = u.status ?? 1
                const here = current?.id === u.id
                return (
                  <li key={u.id}>
                    <Link to={`/topics/${u.id}`} className={statusRowClass(st, here ? 'rm-here' : '')}>
                      <span className="rm-order">{u.sortOrder ?? '-'}</span>
                      <span className="grow">
                        <span className="term">{u.term}</span>
                        <span className="meta">{u.middle}</span>
                      </span>
                      {here && <span className="rm-here-label">ここから</span>}
                      <StatusBadge status={st} />
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}

      {/* @implements REQ-134 */}
      {extras.length > 0 && (
        <section className="rm-day">
          <h2 className="rm-day-head">{extraField}</h2>
          <p className="muted" style={{ fontSize: '0.82rem', margin: '-0.3rem 0 0.5rem' }}>
            ロードマップには入れなかったが、読んでおくと役に立つ単位。順番は気にしなくてよい。
          </p>
          <ul className="list">
            {extras.map((u) => {
              const st = u.status ?? 1
              return (
                <li key={u.id}>
                  <Link to={`/topics/${u.id}`} className={statusRowClass(st)}>
                    <span className="rm-order">＋</span>
                    <span className="grow">
                      <span className="term">{u.term}</span>
                      <span className="meta">{u.middle}</span>
                    </span>
                    <StatusBadge status={st} />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </>
  )
}
