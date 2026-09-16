import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { exam } from '../exam'
import { StatusBadge, statusRowClass } from '../components/StatusBadge'

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

/** ロードマップ型（itc・mkt）の学習画面。日ごとの一覧（要件 §13、利用者の指摘 2026-09-16）。
 *
 *  資格版の「分野 → 単元 → 論点」は出題頻度で歩く形。ロードマップ型は学ぶ順が決まっているので、
 *  1 日目〜N 日目の並びそのままを 1 枚で見せ、いま学ぶ位置（最初のまだ理解していない単位）に印を付ける。
 *  ロードマップ外の「補足」は末尾に別枠で置く。 */
export function Roadmap() {
  // null は「まだ取得していない」、[] は「取得した結果が空」
  const [units, setUnits] = useState<Unit[] | null>(null)
  const [error, setError] = useState('')
  const perDay = exam.roadmapSpec?.perDay ?? 3
  const extraField = exam.roadmapSpec?.extraField ?? '補足（ロードマップ外）'

  const load = useCallback(() => {
    setError('')
    setUnits(null)
    api<{ topics: Unit[] }>('/topics?limit=500')
      .then((d) => setUnits(d.topics))
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
  }, [load])

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
  const days = new Map<number, Unit[]>()
  for (const u of main) {
    const d = u.sortOrder ? Math.ceil(u.sortOrder / perDay) : 0
    days.set(d, [...(days.get(d) ?? []), u])
  }
  const current = main.find((u) => (u.status ?? 1) < 3) // いま学ぶ位置
  const understood = main.filter((u) => u.status === 3).length

  return (
    <>
      <h1>ロードマップ</h1>
      <p className="lead">
        1 日 {perDay} 単位、全 {days.size} 日。順番どおりに読み、読んだら理解度を付けます。
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
