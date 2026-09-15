import { exam } from '../exam'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BackLink } from '../components/BackLink'
import { STATUS_LABEL, api, apiCached } from '../lib/api'
import type { Field, TopicRow } from '../lib/api'

type Category = {
  middleNo: number
  middle: string
  major: string
  field: string
  topics: number
  questions: number
  understood: number
}

const SORTS = [
  { key: 'frequency', label: '出題が多い順' },
  { key: 'name', label: '名前順' },
] as const

const FIELD_ORDER = exam.fields

/** 学習。2階層で見せる。
 *
 *  1段目で分野を選ぶと、その下に並ぶのは論点ではなく**単元**（シラバスの中分類）。
 *  532論点をフラットに並べても、どこを歩いているのか分からない。
 *  単元を選んで初めて論点の一覧に入る。
 *
 *  「中分類」はシラバスの用語で、学習者には通じない。画面では「単元」と呼ぶ。 */
export function Topics() {
  const [params, setParams] = useSearchParams()
  // null は「まだ取得していない」、[] は「取得した結果が空」。区別しないと
  // 読み込み中に「該当する論点がありません」と出てしまう。
  const [fields, setFields] = useState<Field[] | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [topics, setTopics] = useState<TopicRow[] | null>(null)
  const [sort, setSort] = useState<'frequency' | 'name'>('frequency')
  // 理解度は複数選べる。「未理解だけ」も「未理解＋やや理解」も作れるように。
  const [statuses, setStatuses] = useState<number[]>([1, 2, 3])
  // 取得に失敗したことも状態のひとつ。null（未取得）のままにすると
  // 「読み込み中…」が永久に出たままになる。
  const [structError, setStructError] = useState('')
  const [topicsError, setTopicsError] = useState('')

  const field = params.get('field') ?? ''
  const middleNo = params.get('middleNo') ?? ''
  const category = categories?.find((c) => String(c.middleNo) === middleNo)

  // 分野と単元はシラバスの構造で、画面を移っても変わらない。取り直さない。
  // apiCached は失敗をメモに残さないので、再読み込みを押せば取りに行く。
  const loadStructure = useCallback(() => {
    setStructError('')
    apiCached<{ fields: Field[] }>('/fields')
      .then((d) => setFields(d.fields))
      .catch((e) => setStructError(e.message))
    apiCached<{ categories: Category[] }>('/categories')
      .then((d) => setCategories(d.categories))
      .catch((e) => setStructError(e.message))
  }, [])

  useEffect(() => {
    loadStructure()
  }, [loadStructure])

  const loadTopics = useCallback(() => {
    if (!middleNo) return
    setTopicsError('')
    // 理解度をすべて外したら取りに行かない。サーバは status の指定が無いと
    // 全件返すので、「全部オフ＝全件表示」という逆の見え方になっていた。
    if (statuses.length === 0) {
      setTopics([])
      return
    }
    const p = new URLSearchParams({ sort })
    p.set('middleNo', middleNo)
    if (statuses.length < 3) p.set('status', statuses.join(','))
    setTopics(null)
    api<{ topics: TopicRow[] }>(`/topics?${p}`)
      .then((d) => setTopics(d.topics))
      .catch((e) => setTopicsError(e.message))
  }, [middleNo, sort, statuses])

  useEffect(() => {
    loadTopics()
  }, [loadTopics])

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key === 'field') next.delete('middleNo')
    setParams(next, { replace: true })
  }

  function toggleStatus(s: number) {
    setStatuses((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s].sort(),
    )
  }

  // ---- 単元の中の論点一覧 ----------------------------------------
  if (category) {
    return (
      <>
        <BackLink to="/topics" label="単元の一覧に戻る" />
        <p className="crumb">
          {category.field} / {category.major}
        </p>
        <h1>{category.middle}</h1>
        <p className="lead">
          {category.topics} 論点 · {exam.words.questions} {category.questions} 問
        </p>

        <div className="chips">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              className="chip-f"
              aria-pressed={sort === s.key}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="chips">
          <span className="chips-label">表示</span>
          {[1, 2, 3].map((s) => (
            <button
              key={s}
              type="button"
              className={`chip-f check ${statuses.includes(s) ? 'on' : ''}`}
              aria-pressed={statuses.includes(s)}
              onClick={() => toggleStatus(s)}
            >
              <i className={`box s${s}`} />
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        <ul className="list">
          {(topics ?? []).map((t) => {
            const status = t.status ?? 1
            return (
            <li key={t.id}>
              <Link to={`/topics/${t.id}`} className="row">
                <span className="freq">
                  <b>{t.questionCount}</b>
                  <small>回</small>
                </span>
                <span className="grow">
                  <span className="term">{t.term}</span>
                  {/* 小項目名が単元名と同じときは出さない。全行に同じ文字が並んで
                      一覧の高さが倍になるだけで、行を見分ける手がかりにならない。 */}
                  {t.itemName !== category.middle && <span className="meta">{t.itemName}</span>}
                </span>
                {/* 段数は色だけでなく**本数**でも示す。色だけだと、未理解の行も
                    3本塗られていて満タン（理解済み）に見えていた。 */}
                <span className={`steps s${status}`} aria-label={STATUS_LABEL[status]}>
                  {Array.from({ length: status }, (_, i) => (
                    <i key={i} />
                  ))}
                </span>
              </Link>
            </li>
            )
          })}
          {topicsError && (
            <li>
              <p className="error">{topicsError}</p>
              <button className="btn" onClick={loadTopics}>
                再読み込み
              </button>
            </li>
          )}
          {topics === null && !topicsError && <li className="muted">読み込み中…</li>}
          {topics !== null && topics.length === 0 && !topicsError && (
            <li className="muted">
              {statuses.length === 0
                ? '表示する理解度を1つ以上選んでください。'
                : '該当する論点がありません。'}
              {/* 絞り込んだ結果が0件だと、絞り込んだこと自体を忘れて
                  「この単元は空だ」と受け取ってしまう。戻る道をその場に置く。 */}
              {statuses.length < 3 && (
                <div className="btn-row" style={{ marginTop: '0.6rem' }}>
                  <button className="btn" onClick={() => setStatuses([1, 2, 3])}>
                    すべて表示に戻す
                  </button>
                </div>
              )}
            </li>
          )}
        </ul>
      </>
    )
  }

  // ---- 単元の一覧 -------------------------------------------------
  const shown = (categories ?? []).filter((c) => !field || c.field === field)
  const majors: { major: string; field: string; items: Category[] }[] = []
  for (const c of shown) {
    const last = majors[majors.length - 1]
    if (last && last.major === c.major && last.field === c.field) last.items.push(c)
    else majors.push({ major: c.major, field: c.field, items: [c] })
  }

  return (
    <>
      <h1>学習</h1>
      <p className="lead">単元を選んで、その中の論点を順に読んでいきます。</p>

      <div className="chips">
        <button
          type="button"
          className="chip-f"
          aria-pressed={field === ''}
          onClick={() => setFilter('field', '')}
        >
          すべて
        </button>
        {FIELD_ORDER.filter((f) => (fields ?? []).some((x) => x.field === f)).map((f) => {
          const d = (fields ?? []).find((x) => x.field === f)!
          return (
            <button
              key={f}
              type="button"
              className="chip-f"
              aria-pressed={field === f}
              onClick={() => setFilter('field', f)}
            >
              {f.replace('系', '')}
              <small>
                {d.understood}/{d.topics}
              </small>
            </button>
          )
        })}
      </div>

      {structError && (
        <>
          <p className="error">{structError}</p>
          <button className="btn" onClick={loadStructure}>
            再読み込み
          </button>
        </>
      )}
      {!structError && categories === null && <p className="muted">読み込み中…</p>}

      {majors.map((m) => (
        <section key={`${m.field}-${m.major}`}>
          <div className="major-head">
            <b>{m.major}</b>
            <span>
              {m.items.reduce((n, c) => n + c.topics, 0)} 論点 ·{' '}
              {m.items.reduce((n, c) => n + c.questions, 0)} 問
            </span>
          </div>
          <div className="cats">
            {m.items.map((c) => (
              <Link key={c.middleNo} to={`/topics?middleNo=${c.middleNo}`} className="cat">
                <span className="n">{c.middle}</span>
                <span className="q">
                  <b>{c.topics}</b> 論点 · {c.questions} 問
                </span>
                <span className="track">
                  <i className="t3" style={{ width: `${(c.understood / (c.topics || 1)) * 100}%` }} />
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
