import { exam } from '../exam'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigationType, useSearchParams } from 'react-router-dom'
import { BackLink } from '../components/BackLink'
import { STATUS_LABEL, api, apiCached } from '../lib/api'
import { FrequencyMark, StatusBadge, statusRowClass } from '../components/StatusBadge'
import type { Field, TopicRow, UnitStructure } from '../lib/api'
import { resumeGoneOf } from '../lib/resume'

type Category = {
  middleNo: number
  middle: string
  major: string
  field: string
  topics: number
  questions: number
  understood: number
}

const FIELD_ORDER = exam.fields

/** 理解度の絞り込みの選択肢。資格対策の学びでは未を含む 4 段階。 */
const STATUS_FILTERS = [0, 1, 2, 3]

/** 論点の一覧で見出しの下に束ねる 1 組。 */
type TopicSection = { key: string; name: string; description: string | null; rows: TopicRow[] }

/** 論点の一覧を見出しごとの組に分ける。行の並びはサーバが返した並び（BR-031）のまま変えない。 */
// @implements REQ-475, REQ-476, REQ-477, BR-031
function sectionsOf(topics: TopicRow[], structure: UnitStructure | null): TopicSection[] {
  if (structure) {
    const sections: TopicSection[] = structure.groups.map((g) => ({
      key: `g${g.no}`,
      name: g.name,
      description: g.description,
      rows: topics.filter((t) => t.groupNo === g.no),
    }))
    // まとまりの no に当たらない行は投入の門（BR-048）が止める。届いたときも黙って消さず、見出し無しで末尾に置く
    const known = new Set(structure.groups.map((g) => g.no))
    const rest = topics.filter((t) => t.groupNo === null || !known.has(t.groupNo))
    if (rest.length > 0) sections.push({ key: 'rest', name: '', description: null, rows: rest })
    return sections.filter((x) => x.rows.length > 0)
  }
  const sections: TopicSection[] = []
  for (const t of topics) {
    const key = `i${t.itemNo ?? t.itemName}`
    const last = sections[sections.length - 1]
    if (last && last.key === key) last.rows.push(t)
    else sections.push({ key, name: t.itemName, description: null, rows: [t] })
  }
  return sections
}

/** 論点の一覧の 1 行。出題頻度・出題回数の印・論点の名前・理解度を並べる。 */
// @implements REQ-474
function TopicListRow({ t, showItem }: { t: TopicRow; showItem: boolean }) {
  return (
    <li>
      <Link to={`/topics/${t.id}`} className={statusRowClass(t.status)}>
        <span className="freq">
          <b>{t.questionCount}</b>
          <small>回</small>
          <FrequencyMark tier={t.frequencyTier} />
        </span>
        <span className="grow">
          <span className="term">{t.term}</span>
          {showItem && <span className="meta">{t.itemName}</span>}
        </span>
        {/* 理解度は文字＋記号＋色＋塗りのバッジ。色だけに頼らない。 */}
        <StatusBadge status={t.status} />
      </Link>
    </li>
  )
}

/** 学習。2階層で見せる。
 *
 *  1段目で分野を選ぶと、その下に並ぶのは論点ではなく**単元**（シラバスの中分類）。
 *  単元を選んで初めて論点の一覧に入る。
 *
 *  「中分類」はシラバスの用語で、学習者には通じない。画面では「単元」と呼ぶ。 */
export function Topics() {
  const [params, setParams] = useSearchParams()
  // 知らせは論点の画面から移ってきた時だけ出す。履歴で戻った・再読み込みで来た（POP）ときは出し直さない
  const location = useLocation()
  const navigationType = useNavigationType()
  const resumeGone = navigationType === 'POP' ? null : resumeGoneOf(location.state)
  // null は「まだ取得していない」、[] は「取得した結果が空」。区別しないと
  // 読み込み中に「該当する論点がありません」と出てしまう。
  const [fields, setFields] = useState<Field[] | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [topics, setTopics] = useState<TopicRow[] | null>(null)
  // 単元の構成。構成を持たない単元では null
  const [structure, setStructure] = useState<UnitStructure | null>(null)
  // 理解度は複数選べる。「未理解だけ」も「未＋未理解」も作れるように。
  const [statuses, setStatuses] = useState<number[]>(STATUS_FILTERS)
  // 取得に失敗したことも状態のひとつ。null（未取得）のままにすると
  // 「読み込み中…」が永久に出たままになる。
  const [structError, setStructError] = useState('')
  const [topicsError, setTopicsError] = useState('')

  const field = params.get('field') ?? ''
  const middleNo = params.get('middleNo') ?? ''
  const category = categories?.find((c) => String(c.middleNo) === middleNo)

  // 分野と単元の集計は、単元の一覧を開いている間は取り直さない。
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

  // 単元を選び直したら、前の単元の構成を出したままにしない
  useEffect(() => {
    setStructure(null)
  }, [middleNo])

  // 論点の一覧の求めの通し番号。応答は、返った時点でこの番号が自分の求めのものであるときだけ
  // 画面に反映する。単元や理解度の絞り込みを選び直したあとに前の求めの応答が遅れて返っても、
  // 前の単元の構成や論点を今の画面に出さない
  const topicsRequest = useRef(0)

  // 並びは送らない。サーバの既定（学びの種類で決まる一覧の並び）で返る
  // @implements REQ-021, REQ-022
  const loadTopics = useCallback(() => {
    const request = ++topicsRequest.current
    if (!middleNo) return
    setTopicsError('')
    // 理解度をすべて外したら取りに行かない。サーバは status の指定が無いと
    // 全件返すので、取りに行くと「全部オフ＝全件表示」という逆の見え方になる。
    if (statuses.length === 0) {
      setTopics([])
      return
    }
    const p = new URLSearchParams()
    p.set('middleNo', middleNo)
    if (statuses.length < STATUS_FILTERS.length) p.set('status', statuses.join(','))
    setTopics(null)
    api<{ topics: TopicRow[]; structure: UnitStructure | null }>(`/topics?${p}`)
      .then((d) => {
        if (request !== topicsRequest.current) return
        setStructure(d.structure ?? null)
        setTopics(d.topics)
      })
      .catch((e) => {
        if (request !== topicsRequest.current) return
        setTopicsError(e.message)
      })
  }, [middleNo, statuses])

  useEffect(() => {
    loadTopics()
  }, [loadTopics])

  // @implements REQ-019
  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key === 'field') next.delete('middleNo')
    setParams(next, { replace: true })
  }

  function toggleStatus(s: number) {
    setStatuses((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s].sort((a, b) => a - b),
    )
  }

  // ---- 単元の中の論点一覧 ----------------------------------------
  if (category) {
    const sections = topics ? sectionsOf(topics, structure) : []
    return (
      <>
        {/* @implements REQ-029, BR-016 */}
        <BackLink to="/topics" label="単元の一覧に戻る" />
        <p className="crumb">
          {category.field} / {category.major}
        </p>
        <h1>{category.middle}</h1>
        <p className="lead">
          {category.topics} 論点 · {exam.words.questions} {category.questions} 問
        </p>

        {/* @implements REQ-475 */}
        {structure && <p className="unit-overview">{structure.overview}</p>}

        <div className="chips">
          <span className="chips-label">表示</span>
          {STATUS_FILTERS.map((s) => (
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

        {sections.map((sec) => (
          <section key={sec.key} className="topic-group">
            {sec.name && (
              <div className="topic-group-head">
                <h2>{sec.name}</h2>
                {sec.description && <p>{sec.description}</p>}
              </div>
            )}
            <ul className="list">
              {sec.rows.map((t) => (
                <TopicListRow key={t.id} t={t} showItem={!!structure && t.itemName !== category.middle} />
              ))}
            </ul>
          </section>
        ))}

        <ul className="list">
          {/* @implements REQ-027, BR-014 */}
          {topicsError && (
            <li>
              <p className="error">{topicsError}</p>
              <button className="btn" onClick={loadTopics}>
                再読み込み
              </button>
            </li>
          )}
          {/* @implements REQ-028, BR-015 */}
          {topics === null && !topicsError && <li className="muted">読み込み中…</li>}
          {topics !== null && topics.length === 0 && !topicsError && (
            <li className="muted">
              {statuses.length === 0
                ? '表示する理解度を1つ以上選んでください。'
                : '該当する論点がありません。'}
              {/* 絞り込んだ結果が0件だと、絞り込んだこと自体を忘れて
                  「この単元は空だ」と受け取ってしまう。戻る道をその場に置く。 */}
              {statuses.length < STATUS_FILTERS.length && (
                <div className="btn-row" style={{ marginTop: '0.6rem' }}>
                  <button className="btn" onClick={() => setStatuses(STATUS_FILTERS)}>
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
      {/* @implements REQ-342 */}
      {resumeGone && (
        <p className="notice" role="status">
          {resumeGone.term
            ? `前回の続きの論点「${resumeGone.term}」が見つかりませんでした。単元から選び直してください。`
            : '前回の続きの論点が見つかりませんでした。単元から選び直してください。'}
        </p>
      )}
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

      {/* @implements REQ-014, BR-029 */}
      {fields && fields.length > 0 && (
        <div className="field-sums">
          {FIELD_ORDER.filter((f) => fields.some((x) => x.field === f)).map((f) => {
            const d = fields.find((x) => x.field === f)!
            const pct = (n: number) => `${(n / (d.topics || 1)) * 100}%`
            return (
              <div key={f} className="field-sum">
                <div className="fieldrow">
                  <span className="fn">{f.replace('系', '')}</span>
                  <span className="fb">
                    <span className="track">
                      <i className="t3" style={{ width: pct(d.understood) }} />
                      <i className="t2" style={{ width: pct(d.partly) }} />
                      <i className="t1" style={{ width: pct(d.untouched) }} />
                      <i className="t0" style={{ width: pct(d.unanswered ?? 0) }} />
                    </span>
                  </span>
                  <span className="fv">
                    論点 <b>{d.topics}</b> · {exam.words.questions} {d.questions}
                  </span>
                </div>
                <div className="legend">
                  <span>
                    <i style={{ background: 'var(--s3)' }} />
                    {STATUS_LABEL[3]} <b>{d.understood}</b>
                  </span>
                  <span>
                    <i style={{ background: 'var(--s2)' }} />
                    {STATUS_LABEL[2]} <b>{d.partly}</b>
                  </span>
                  <span>
                    <i style={{ background: 'var(--s1)' }} />
                    {STATUS_LABEL[1]} <b>{d.untouched}</b>
                  </span>
                  <span>
                    <i style={{ background: 'var(--s0)' }} />
                    {STATUS_LABEL[0]} <b>{d.unanswered ?? 0}</b>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* @implements REQ-016, BR-014, BR-015 */}
      {structError && (
        <>
          <p className="error">{structError}</p>
          <button className="btn" onClick={loadStructure}>
            再読み込み
          </button>
        </>
      )}
      {!structError && categories === null && <p className="muted">読み込み中…</p>}

      {/* @implements REQ-015 */}
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
                <span className="u">
                  理解 <b>{c.understood}</b>/{c.topics}
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
