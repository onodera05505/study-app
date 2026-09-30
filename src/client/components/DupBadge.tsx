/** 同一内容の過去問がまとめられていることを知らせるバッジ。
 *
 *  IPA は同じ問題を別の回で使い回す（応用情報で119組258問）。学習側では1問に
 *  まとめて出しているので、そのことを本文の前に出す。**これは学習の手がかりでもある**
 *  ─ 使い回されている問題は、それだけ問われ続けている論点だという意味になる。
 *
 *  代表以外の出典は「他の出典：」に続けて、代表の出典と同じ「回の名前 問N」の形で、
 *  回の新しい順に並べる。並び順はサーバが付けた順（新しい回が先）をそのまま使う
 *  ─ 出典は文字列で、回の新旧はここからは比べられない。
 *
 *  過去問の通し受験（原本どおり全問出す）では出さない。呼び出し側で出し分ける。
 */
// @implements REQ-126, REQ-237
export function DupBadge({
  timesAsked,
  otherCitations,
}: {
  timesAsked?: number
  otherCitations?: string[]
}) {
  if (!timesAsked || timesAsked <= 1) return null
  // 出典は「出典：令和6年度 …」の形。バッジの中では「出典：」が重複して読みにくい
  const others = (otherCitations ?? []).map((c) => c.replace(/^出典：/, ''))
  return (
    <div className="dup-badge">
      <b>同一の問題が {timesAsked} 回出題されています</b>
      {others.length > 0 && <small>他の出典：{others.join('・')}</small>}
    </div>
  )
}
