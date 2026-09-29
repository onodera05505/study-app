import { Inline, Markdown } from './Markdown'
import { TermPop } from './TermPop'

export type ExplanationChoice = { label: string; term: string | null; note: string }
export type ExplanationData = { correctReason: string; choices: ExplanationChoice[] }

/** 問題ごとの解説。「正解の根拠」と、選択肢ごとの1行。
 *
 *  論点の教材（定義・見分け方・図・計算手順）と役割を分けてある。誤答の選択肢が
 *  何の用語の説明だったのかは**その問題の話**なので、論点の教材ではなくここに置く。
 *  1問で4語まとめて覚えられるのが過去問学習の効くところなので、誤答も捨てない。
 *
 *  誤答の用語名は押せる文字（ポップ）にする。その用語の1行説明がその場で出るので、
 *  読んでいる問題から離れずに周辺の用語まで拾える。
 *
 *  解説がまだ無い問題は null が来る。そのときは何も描かない（途中状態でも画面は
 *  今までどおり）。 */
// @implements REQ-012, REQ-022
export function Explanation({
  data,
  answer,
}: {
  data: ExplanationData | null | undefined
  /** 正解の記号。その行を目立たせるために使う。 */
  answer?: string | null
}) {
  if (!data) return null
  return (
    <div className="expl">
      <div className="expl-head">解説</div>
      <Markdown source={data.correctReason} className="expl-reason" />
      <div className="expl-choices">
        {data.choices.map((c) => (
          <div key={c.label} className={`expl-choice ${c.label === answer ? 'correct' : ''}`}>
            <b>{c.label}</b>
            <span>
              {c.term && (
                <>
                  <TermPop term={c.term} />
                  <span className="expl-dash"> — </span>
                </>
              )}
              <Inline text={c.note} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
