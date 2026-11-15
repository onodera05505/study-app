import { exam } from '../exam'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DupBadge } from '../components/DupBadge'
import { Explanation, type ExplanationData } from '../components/Explanation'
import { Figure } from '../components/Figure'
import { api, invalidateCached } from '../lib/api'
import { formatChoice } from '../lib/choice'
import { annotateLastPage } from '../lib/lastPage'

type Current = {
  session: {
    id: string
    kind: string
    scopeLabel: string
    questionCount: number
    sourceExam: string | null
  }
  question: {
    idx: number
    text: string
    choices: Record<string, string>
    citation: string
    modified: boolean
    hasFigure: boolean
    figureDescription: string | null
    figureImage: string | null
    /** 同一内容が何回出題されたか。1 なら出さない。 */
    timesAsked: number
    otherCitations: string[]
  } | null
  answered: number
  remainingSec: number | null
  finished: boolean
  expired?: boolean
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(
    Math.floor(sec % 60),
  ).padStart(2, '0')}`
}

export function Session() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<Current | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  // 解説は**答え合わせの応答**に入って来る。出題（/current）には入れていない
  // ので、答える前に正解が読めることはない。
  const [judged, setJudged] = useState<{
    correct: boolean
    correctAnswer: string
    explanation: ExplanationData | null
  } | null>(null)
  const [error, setError] = useState('')
  // 現在の問題を取れなかった理由。最初の取得も、断られた回答のあとの取り直しもここに入る。
  // 取れていない問題は出せないので、問題が出るはずだった場所にこの理由を出す
  const [loadError, setLoadError] = useState('')
  // 現在の問題の取得が「見つからない」（404）で断られたこと。このテストでは続けられない
  const [notFound, setNotFound] = useState(false)
  // 送信中は選択肢を押せなくする。模試は判定を出さない（＝ judged が入らない）ので、
  // judged だけを見ていると答えが二重に送られる。
  const [sending, setSending] = useState(false)
  const [remaining, setRemaining] = useState<number | null>(null)
  // 採点（finish）の失敗。ここを握り潰すと未処理拒否になり、画面は
  // 「集計中…」のまま止まる。押し直せるようにその場に出す。
  const [finishError, setFinishError] = useState('')
  // 再試行のとき、失敗した呼び出しと同じ履歴の残し方をする
  const finishReplace = useRef(true)

  // @implements REQ-069, REQ-074, REQ-251, REQ-484, BR-014
  const finish = useCallback(
    async (replace: boolean) => {
      finishReplace.current = replace
      setFinishError('')
      try {
        await api(`/sessions/${id}/finish`, { method: 'POST' })
        // 締めた模試の回答はここから数える回答に加わるので、覚えていた分野・単元の集計を捨てる
        invalidateCached()
        navigate(`/sessions/${id}/result`, { replace })
      } catch (e: any) {
        setFinishError(e.message)
      }
    },
    [id, navigate],
  )

  /** 現在の問題を取り直す。取れたものを返すので、呼び出し側は位置や締め済みを見て次を決められる。 */
  // @implements REQ-071
  const load = useCallback(async (): Promise<Current | null> => {
    try {
      const d = await api<Current>(`/sessions/${id}/current`)
      setData(d)
      // フィードバックに添える（どのテストの何問目か。問題 ID は見せない設計なのでセッション ID と番号で引く）
      if (d.question) annotateLastPage({ questionId: `${d.session.id}#${d.question.idx}`, label: `${d.session.scopeLabel} の ${d.question.idx + 1} 問目` })
      setRemaining(d.remainingSec)
      setPicked(null)
      setJudged(null)
      setSending(false)
      setLoadError('')
      setNotFound(false)
      // 終わっているテストは出題を返さない（時間切れもこちらに入る）。そのまま締めの流れへ送る
      if (d.finished) await finish(true)
      return d
    } catch (e: any) {
      setLoadError(e.message)
      setNotFound(e.status === 404)
      return null
    }
  }, [id, finish])

  useEffect(() => {
    load()
  }, [load])

  // 制限時間のカウントダウン。0 になったら締めて結果へ。
  // @implements REQ-112, REQ-118
  useEffect(() => {
    if (remaining === null) return
    if (remaining <= 0) {
      finish(true)
      return
    }
    const t = setTimeout(() => setRemaining((r) => (r === null ? null : r - 1)), 1000)
    return () => clearTimeout(t)
  }, [remaining, finish])

  // 過去問実践（通し受験）かどうか。判定と解説を出すかの分かれ目になる。
  const isMock = data?.session.kind === 'mock'

  // @implements REQ-061, REQ-068, REQ-113, REQ-277, REQ-484
  async function answer(choice: string) {
    if (!data?.question || judged || sending) return
    const idx = data.question.idx
    setPicked(choice)
    setSending(true)
    try {
      // 演習の応答は正誤・正解・解説を持ち、模試の応答は残りと終わったかだけを持つ
      const res = await api<
        | { correct: boolean; correctAnswer: string; explanation: ExplanationData | null; remaining: number; finished: boolean }
        | { remaining: number; finished: boolean }
      >(`/sessions/${id}/answer`, {
        method: 'POST',
        body: { idx, answer: choice },
      })
      // 演習の回答は送った時点で数える回答に加わるので、覚えていた分野・単元の集計を捨てる。
      // 模試の回答は締めるまで数えないので、ここでは捨てない
      if (!isMock && 'correct' in res) invalidateCached()
      // 過去問実践（模試）は本番と同じ通し受験なので、1問ごとの正誤も解説も出さずに次へ送る。
      // 振り返りは結果画面でまとめて行う（解説はそちらに出る）。
      if (isMock || !('correct' in res)) {
        await load()
        return
      }
      setJudged({
        correct: res.correct,
        correctAnswer: res.correctAnswer,
        explanation: res.explanation ?? null,
      })
    } catch (e: any) {
      // 回答が受け付けられない理由（締め済み・時間切れ・未回答なし・位置の食い違い）は
      // どれも 409 で、本文は理由の文だけ。どれであるかは現在の問題を取り直して決める。
      if (e.status === 409) {
        const d = await load()
        // 終わっていれば load が締めの流れへ送り、取れなければ load が理由と取り直す手段を出す。
        // 終わっていなければ取り直した問題で示し、位置が送った位置と違うときだけずれを伝える
        if (d && !d.finished && d.question && d.question.idx !== idx)
          setError('問題の表示がずれていたため読み込み直しました。')
      } else {
        setError(e.message)
        setPicked(null)
      }
    } finally {
      setSending(false)
    }
  }

  // h1 はどの状態でも1つ出す（axe の page-has-heading-one）。出題中は問題文に
  // 集中させたいので見出しを見せない。読み上げにだけ出す。
  const heading = <h1 className="sr-only">出題中</h1>

  // 取れていない問題は出せないので、問題が出るはずだった場所に理由と取り直す手段を置く。
  // 再読み込みは問題の取得だけをやり直す（回答は送り直さない）
  // 見つからないものとして断られたときは、このテストでは続けられないことと練習テストへ戻る導線も添える
  // @implements REQ-278, REQ-348, BR-014
  if (loadError)
    return (
      <div className="card">
        {heading}
        <p className="error" role="alert" style={{ marginTop: 0 }}>
          {loadError}
        </p>
        <p className="muted" style={{ margin: '0.2rem 0 0.6rem', fontSize: '0.85rem' }}>
          {notFound ? 'このテストでは続けられません。' : '現在の問題を取れていません。'}
        </p>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => load()}>
            再読み込み
          </button>
          {notFound && (
            <button type="button" className="btn btn-primary" onClick={() => navigate('/practice')}>
              練習テストへ戻る
            </button>
          )}
        </div>
      </div>
    )
  if (!data)
    return (
      <>
        {heading}
        <p className="muted">読み込み中…</p>
      </>
    )
  if (!data.question)
    return (
      <div className="card">
        {heading}
        <p className="muted" style={{ marginTop: 0 }}>
          集計中…
        </p>
        {finishError && (
          <>
            <p className="error" style={{ marginBottom: 0 }}>
              {finishError}
            </p>
            <p className="muted" style={{ margin: '0.2rem 0 0.6rem', fontSize: '0.85rem' }}>
              まだ採点できていません。
            </p>
            <button className="btn btn-primary" onClick={() => finish(finishReplace.current)}>
              もう一度採点する
            </button>
          </>
        )}
      </div>
    )

  const q = data.question
  // @implements REQ-064
  const done = data.answered + (judged ? 1 : 0)
  const total = data.session.questionCount

  return (
    <>
      {heading}
      {/* 進捗と残り時間は上部に固定する。スクロールしても現在地と持ち時間が見える。 */}
      {/* @implements REQ-059, REQ-112 */}
      <div className="exam-top">
        <span className="idx">
          {done} / {total}
        </span>
        <span className="prog">
          <i style={{ width: `${(done / total) * 100}%` }} />
        </span>
        {/* @implements REQ-248 */}
        {remaining !== null && (
          <span className={`timer ${remaining < 300 ? 'low' : ''}`}>{formatTime(remaining)}</span>
        )}
      </div>
      <p className="muted" style={{ margin: '0 0 0.6rem', fontSize: '0.8rem' }}>
        {data.session.scopeLabel}
      </p>

      <div className="card">
        {/* 出さないのは**公開回の通し受験だけ**（原本どおり全問出しているため）。
            それ以外（練習テスト・ランダム構成の模試）は同一内容を1問にまとめて
            出しているのでバッジが要る。判別は sourceExam の有無で行う。 */}
        {/* @implements REQ-249 */}
        {!data.session.sourceExam && (
          <DupBadge timesAsked={q.timesAsked} otherCitations={q.otherCitations} />
        )}
        <p className="question" style={{ marginTop: 0 }}>{q.text}</p>
        <Figure hasFigure={q.hasFigure} description={q.figureDescription} image={q.figureImage} />

        {/* @implements REQ-063 */}
        <div className="choices">
          {Object.entries(q.choices).map(([k, v]) => {
            let cls = ''
            if (judged) {
              if (k === judged.correctAnswer) cls = 'correct'
              else if (k === picked) cls = 'wrong'
            }
            return (
              <button
                key={k}
                className={`choice ${cls}`}
                disabled={!!judged || sending}
                onClick={() => answer(k)}
              >
                <b>{k}</b>
                <span>
                  {formatChoice(v).map((line, i) => (
                    <span key={i} className="choice-line">
                      {line}
                    </span>
                  ))}
                </span>
              </button>
            )
          })}
        </div>

        {/* @implements REQ-062, REQ-063 */}
        {judged && (
          <>
            <p className={`verdict ${judged.correct ? 'ok' : 'ng'}`}>
              {judged.correct ? '正解' : `不正解 — 正解は ${judged.correctAnswer}`}
            </p>
            <Explanation data={judged.explanation} answer={judged.correctAnswer} />
            <button className="btn btn-primary" onClick={load}>
              次の問題へ
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
        {/* 採点の失敗はカードの中で言う。押し直せないと、時間切れのときに
            回答済みの結果へ行く手段が無くなる。 */}
        {finishError && (
          <>
            <p className="error" style={{ marginBottom: 0 }}>
              {finishError}
            </p>
            <p className="muted" style={{ margin: '0.2rem 0 0.6rem', fontSize: '0.85rem' }}>
              まだ採点できていません。
            </p>
            <button className="btn" onClick={() => finish(finishReplace.current)}>
              もう一度採点する
            </button>
          </>
        )}
        {/* @implements REQ-245, BR-027 */}
        {!exam.roadmap && (
          <p className="citation">
            {q.citation}
            {q.modified && <span className="modified-note">（一部改変）</span>}
          </p>
        )}
      </div>

      {/* @implements REQ-070, REQ-114 */}
      <div className="btn-row" style={{ marginTop: '1rem' }}>
        <button className="btn" onClick={() => navigate('/')}>
          中断してホームへ
        </button>
        {/* 採点すると未回答分が確定して再開できなくなる。隣の「中断してホームへ」と
            見た目が同じなので、押し間違いを一度受け止める。 */}
        <button
          className="btn"
          onClick={() => {
            const rest = total - done
            if (!window.confirm(`残り ${rest} 問は未回答のまま採点します。よろしいですか？`)) return
            finish(false)
          }}
        >
          ここまでで採点する
        </button>
      </div>
    </>
  )
}
