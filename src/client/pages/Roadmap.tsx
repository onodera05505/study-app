import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, getLastTopic } from '../lib/api'
import type { LastTopic } from '../lib/api'
import { discardCurrentSession } from '../lib/discardCurrent'
import { exam } from '../exam'
import { roundCountOf, roundHeadingOf, tierLabelOf } from '../../shared/exam'
import { StatusBadge, statusRowClass } from '../components/StatusBadge'
import { TierMark, TierStars } from '../components/TierBadge'

/** 回ごとの確認。exam は回の ID で、論点の round と同じ値 */
type DayExam = { exam: string; examLabel: string; questions: number; attempts: number; bestScore: number | null }

/** 進行中のテスト。範囲と回答の進み具合は GET /api/sessions/current から取る
 *  （テストを作る経路の 409 の本文は理由の文だけで、進行中のテストの中身は入らない）。 */
type InProgress = { id: string; scopeLabel: string; questionCount: number; answered: number }

/** 進行中のテストがあって、回ごとの確認を始められなかったことの案内。exam は押した回。
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
  /** 単位の名前。副題を含まない */
  term: string
  /** 名前に添える副題。副題を持たない単位では null */
  subtitle: string | null
  questionCount: number
  status: number | null
  field: string
  middle: string
  itemName: string
  sortOrder: number | null
  /** 属する回の ID。補足の論点は補足の回、学ぶ順を持たない非補足の論点は null */
  round: string | null
  /** 属する回のラベル（章で束ねる学びでは章の名前） */
  roundLabel: string | null
  /** 印の段。印を持たない学びでは null */
  tier: number | null
}

const spec = exam.roadmapSpec
const TIERS = spec?.tiers ?? []
const ALL_TIERS = TIERS.map((t) => t.level)

/** ロードマップ型の学習画面。回（日または章）ごとの一覧。
 *
 *  資格版の「分野 → 単元 → 論点」は出題頻度で歩く形。ロードマップ型は学ぶ順が決まっているので、
 *  回の並びそのままを 1 枚で見せ、いま学ぶ位置（最初のまだ理解していない単位）に「ここから」を付ける。
 *  補足の回の単位は末尾に別枠で置く。回の見出しと回ごとの確認の語、印の語は登録簿の語で出す。 */
// @implements REQ-129
export function Roadmap() {
  // null は「まだ取得していない」、[] は「取得した結果が空」
  const [units, setUnits] = useState<Unit[] | null>(null)
  // 単位の並びの取得の失敗。これだけが一覧そのものを出せない失敗で、画面を置き換える
  const [error, setError] = useState('')
  // 回ごとの確認は各回の見出しに置く
  const [exams, setExams] = useState<DayExam[] | null>(null)
  const [visits, setVisits] = useState<{ streak: number } | null>(null)
  const [last, setLast] = useState<LastTopic | null>(null)
  // 回ごとの確認を始める操作の失敗。並びの取得の失敗とは別に持つ。これを error に混ぜると
  // 回ごとの並びが画面から消え、どの回で失敗したのかも分からなくなる
  const [startError, setStartError] = useState<{ exam: string; message: string } | null>(null)
  // ロードマップ型では練習テストの画面へ行けないので、進行中のテストはこの画面その場で扱う
  const [inProgress, setInProgress] = useState<InProgressNotice | null>(null)
  // 破棄の操作の失敗。案内は残したまま理由だけ添える
  const [discardError, setDiscardError] = useState('')
  const [busy, setBusy] = useState(false)
  // 印の絞り込みで選んでいる段。表示だけに効き、開くたびに全ての段に戻る
  const [tierSel, setTierSel] = useState<number[]>(ALL_TIERS)
  // 学び方の説明を開いているか。開くたびに畳んだ状態から始める
  const [howOpen, setHowOpen] = useState(false)
  const navigate = useNavigate()

  // @implements REQ-127, REQ-136, REQ-287, BR-014
  const load = useCallback(() => {
    setTierSel(ALL_TIERS)
    setHowOpen(false)
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

  /** 進行中のテストの範囲と回答の進み具合を取り、押した回の近くの案内にする。
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

  /** 回ごとの確認を始める。範囲はその回の単位だけ（サーバが回の ID から決める）。
   *
   *  失敗は押した回の近くに出し、回ごとの並びは残す。409 は進行中のテストが 1 人 1 つという
   *  規則（サーバが守る）に当たったときで、新しいテストは作られず、出題の画面へも移さない。
   *  409 の本文は理由の文だけなので、案内の中身は進行中のテストを取り直して作る。 */
  // @implements REQ-142, REQ-143, REQ-276, REQ-280, BR-017
  async function startDay(e: DayExam, heading: string) {
    if (busy) return
    setStartError(null)
    setInProgress(null)
    setDiscardError('')
    if (!window.confirm(`${spec?.roundCheck ?? ''}（${heading}・${e.questions} 問）を始めます。よろしいですか？`)) return
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
   *  消せたら案内を消し、回ごとの確認を始められる状態に戻す。 */
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

  /** 印の段を選び直す。選んでいる段が 1 つだけのときは、それを外させない。 */
  // @implements REQ-288
  function toggleTier(level: number) {
    setTierSel((cur) => {
      if (!cur.includes(level)) return ALL_TIERS.filter((l) => l === level || cur.includes(l))
      return cur.length <= 1 ? cur : cur.filter((l) => l !== level)
    })
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
  const isExtra = (u: Unit) => u.round != null && u.round === spec?.extraRoundId
  const main = all.filter((u) => !isExtra(u))
  const extras = all.filter(isExtra)
  // 論点は属する回で束ねる。学ぶ順を持たない非補足の論点（round が null）は先頭の順序なしの 1 回
  // @implements REQ-129, REQ-134, REQ-135
  const byRound = new Map<string | null, Unit[]>()
  if (main.some((u) => u.round == null)) byRound.set(null, [])
  for (const u of main) byRound.set(u.round, [...(byRound.get(u.round) ?? []), u])
  const rounds = [...byRound.keys()]
  const ordered = rounds.filter((r): r is string => r != null)
  // 先頭の理解の数と総数は学ぶ順に入る単位だけで数える（補足の論点と順序なしの 1 回の単位は数えない）
  // @implements REQ-131
  const inOrder = main.filter((u) => u.round != null)
  const understood = inOrder.filter((u) => u.status === 3).length
  // 印の絞り込み。全ての段を選んでいるときは全ての単位を出す
  // @implements REQ-282, REQ-283, REQ-285
  const filtering = TIERS.length > 0 && tierSel.length < ALL_TIERS.length
  const visible = (u: Unit) => !filtering || (u.tier != null && tierSel.includes(u.tier))
  // いま学ぶ位置。印で絞り込んでいるあいだは残した中で最初の未理解
  // @implements REQ-130, BR-029
  const here = main.filter(visible).find((u) => (u.status ?? 1) < 3)
  const visibleExtras = extras.filter(visible)
  // 先頭の続きの導線の行き先。前回の続きは取得した並びに今もあるときだけ採り、
  // 無ければ「ここから」、それも無ければ学ぶ順で最初の論点（3 段目は印の絞り込みに依らない）。
  // 並びを取る前は前回の続きを確かめられないので、端末が覚えている論点を仮の行き先にする
  // @implements REQ-144, REQ-283, BR-013
  const first = all[0]
  const lastUnit = last ? all.find((u) => u.id === last.id) : undefined
  const head: { kind: 'last' | 'here' | 'first'; id: number; term: string; subtitle: string | null } | null =
    units === null
      ? last
        ? { kind: 'last', id: last.id, term: last.term, subtitle: null }
        : null
      : lastUnit
        ? { kind: 'last', id: lastUnit.id, term: lastUnit.term, subtitle: lastUnit.subtitle ?? null }
        : here
          ? { kind: 'here', id: here.id, term: here.term, subtitle: here.subtitle ?? null }
          : first
            ? { kind: 'first', id: first.id, term: first.term, subtitle: first.subtitle ?? null }
            : null
  const headLabel = { last: '前回の続きから', here: 'ここから', first: '最初の単位から始める' }

  /** 一覧の単位の 1 行。名前と副題を分けて示し、回の見出しの語と章の名前は繰り返さない。 */
  // @implements REQ-282, REQ-415, REQ-418, REQ-420, BR-029, BR-045
  const unitRow = (u: Unit, order: string, isHere: boolean) => {
    const st = u.status ?? 1
    const tier = tierLabelOf(spec, u.tier)
    return (
      <li key={u.id}>
        <Link to={`/topics/${u.id}`} className={statusRowClass(st, isHere ? 'rm-unit rm-here' : 'rm-unit')}>
          <span className="rm-order">{order}</span>
          <span className="grow">
            <span className="term">{u.term}</span>
            {u.subtitle && <span className="rm-subtitle">{u.subtitle}</span>}
            {(tier || isHere) && (
              <span className="rm-sub">
                {tier && <TierMark level={u.tier} label={tier} />}
                {isHere && <span className="rm-here-label">ここから</span>}
              </span>
            )}
          </span>
          <StatusBadge status={st} />
        </Link>
      </li>
    )
  }

  return (
    <>
      {/* 画面の名前は上部メニューの「ロードマップ」と同じなので、読み上げにだけ出す */}
      <h1 className="sr-only">ロードマップ</h1>
      {/* 先頭に置く論点への導線はこの 1 つだけ。行き先の種類は小さな札で上に置き、
          1 段目に行き先の名前だけを大きく太く、2 段目に副題を小さく示す */}
      {/* @implements REQ-144, REQ-145, REQ-283, REQ-415, BR-013 */}
      {head && (
        <Link to={`/topics/${head.id}`} className="btn btn-primary btn-block go-study rm-go">
          <span className="rm-go-kicker">{headLabel[head.kind]}</span>
          <span className="rm-go-term">{head.term}</span>
          {head.subtitle && <span className="rm-go-sub">{head.subtitle}</span>}
        </Link>
      )}
      {/* 先頭の数は 1 つずつ札にする。取れなかった連続記録の札は出さない */}
      {/* @implements REQ-131, REQ-132, REQ-136 */}
      <p className="lead rm-stats">
        {visits && (
          <span className="rm-chip">
            連続 <b>{visits.streak}</b> 日
          </span>
        )}
        {units && (
          <span className="rm-chip">
            理解 <b>{understood}</b> / {inOrder.length} 単位
          </span>
        )}
        <span className="rm-chip">{roundCountOf(spec, ordered.length)}</span>
      </p>
      {/* 学び方の説明は畳んでおき、開いたときだけ中身を出す */}
      {/* @implements REQ-417 */}
      <div className="rm-howto">
        <button
          type="button"
          className="rm-howto-toggle"
          aria-expanded={howOpen}
          aria-controls="rm-howto-body"
          onClick={() => setHowOpen((v) => !v)}
        >
          学び方の説明
        </button>
        {howOpen && (
          <p id="rm-howto-body" className="rm-howto-body">
            上から順番どおりに読み、読み終えたら理解度を付けます。並びの最後にある「{spec?.roundCheck}」で、その範囲の確認問題をまとめて受けられます。
          </p>
        )}
      </div>

      {/* 印の絞り込み。3 つの札を同じ大きさで 1 行に並べ、見た目は星だけ。登録簿の語は読み上げの名前とツールチップが持つ */}
      {/* @implements REQ-287, REQ-288 */}
      {TIERS.length > 0 && units !== null && (
        <fieldset className="rm-tier-filter">
          <legend className="sr-only">印で絞り込む</legend>
          {TIERS.map((t) => {
            const on = tierSel.includes(t.level)
            return (
              <label key={t.level} className={`rm-tier-toggle t-${t.level}${on ? ' on' : ''}`} title={t.label}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && tierSel.length === 1}
                  onChange={() => toggleTier(t.level)}
                />
                <span className="rm-tier-check" aria-hidden="true" />
                <TierStars label={t.label} />
              </label>
            )
          })}
        </fieldset>
      )}

      {/* @implements REQ-126, BR-015 */}
      {units === null && <p className="muted">読み込み中…</p>}
      {units !== null && main.length === 0 && <p className="muted">単位がありません。</p>}

      {rounds.map((r) => {
        const list = byRound.get(r)!
        const shown = list.filter(visible)
        const done = list.every((u) => u.status === 3)
        const doneCount = list.filter((u) => u.status === 3).length
        // 回の見出しは論点の並びだけで決まる（回ごとの確認の一覧が取れなくても出る）
        // @implements REQ-279
        const heading = r == null ? '順序なし' : roundHeadingOf(spec, ordered.indexOf(r) + 1, list[0].roundLabel)
        const ex = r == null ? undefined : (exams ?? []).find((e) => e.exam === r)
        return (
          <section key={r ?? ''} className="rm-day">
            <div className="rm-day-top">
              <h2 className={done ? 'rm-day-head done' : 'rm-day-head'}>
                {heading}
                {done && <small>完了</small>}
              </h2>
              <span className="rm-prog" title={`理解 ${doneCount} / ${list.length}`}>
                <span className="sr-only">理解 </span>
                <span className="rm-prog-num">
                  {doneCount}/{list.length}
                </span>
                <span className="rm-prog-bar" aria-hidden="true">
                  <i style={{ width: `${list.length ? (doneCount / list.length) * 100 : 0}%` }} />
                </span>
              </span>
            </div>
            {shown.length > 0 && (
              <ul className="list">{shown.map((u) => unitRow(u, String(u.sortOrder ?? '-'), here?.id === u.id))}</ul>
            )}
            {/* 回ごとの確認はその回の単位の並びの後に置く。範囲はこの回の単位だけ */}
            {/* @implements REQ-133, REQ-280, REQ-419 */}
            {ex && (
              <>
                <div className="rm-day-exam">
                  {/* 進行中のテストがあるあいだも押せる。断られたらその回の近くに案内を出す（REQ-143） */}
                  <button type="button" className="btn rm-day-exam-btn" disabled={busy} onClick={() => startDay(ex, heading)}>
                    {spec?.roundCheck}（{ex.questions} 問）
                  </button>
                  {ex.attempts > 0 && (
                    <span className="rm-day-score">
                      受けた {ex.attempts} 回 · 最高 <b>{ex.bestScore ?? 0}</b> / {ex.questions}
                    </span>
                  )}
                </div>
                {/* 進行中のテストがあること以外の理由で始められなかったとき、押した回の近くに
                    理由を出し、回ごとの並びは消さない */}
                {/* @implements REQ-276, BR-014 */}
                {startError?.exam === ex.exam && (
                  <p className="error" role="alert">
                    {startError.message}
                  </p>
                )}
                {/* 進行中のテストの範囲と進み具合、再開と破棄を押した回のその場に置く */}
                {/* @implements REQ-143, BR-014, BR-017 */}
                {inProgress && inProgress.exam === ex.exam && (
                  <div className="notice" role="alert">
                    {inProgress.kind === 'fetched' && (
                      <>
                        <p style={{ margin: 0 }}>
                          進行中のテストがあります（{inProgress.session.scopeLabel} / 回答済み{' '}
                          {inProgress.session.answered} / 全体 {inProgress.session.questionCount} 問）。
                          {spec?.roundCheck}は、再開か破棄のあとに始められます。
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
                          進行中のテストがあるため、{spec?.roundCheck}は始められません。進行中のテストの範囲と回答の進み具合が取れていません。
                        </p>
                        <div className="btn-row" style={{ marginTop: '0.6rem' }}>
                          <button type="button" className="btn" disabled={busy} onClick={() => fetchInProgress(ex.exam)}>
                            再読み込み
                          </button>
                        </div>
                      </>
                    )}
                    {inProgress.kind === 'gone' && (
                      <p style={{ margin: 0 }}>
                        進行中のテストは、確かめているあいだに締められたか破棄されました。もう一度{spec?.roundCheck}を始めてください。
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        )
      })}

      {/* @implements REQ-134, REQ-283 */}
      {visibleExtras.length > 0 && (
        <section className="rm-day">
          <h2 className="rm-day-head">{spec?.extraField}</h2>
          <p className="rm-extra-note">ロードマップには入れなかったが、読んでおくと役に立つ単位。順番は気にしなくてよい。</p>
          <ul className="list">{visibleExtras.map((u) => unitRow(u, '＋', false))}</ul>
        </section>
      )}
    </>
  )
}
