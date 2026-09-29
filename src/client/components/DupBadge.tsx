/** 同一内容の過去問がまとめられていることを知らせるバッジ。
 *
 *  IPA は同じ問題を別の回で使い回す（応用情報で119組258問）。学習側では1問に
 *  まとめて出しているので、そのことを本文の前に出す。**これは学習の手がかりでもある**
 *  ─ 使い回されている問題は、それだけ問われ続けている論点だという意味になる。
 *
 *  過去問の通し受験（原本どおり全問出す）では出さない。呼び出し側で出し分ける。
 */
// @implements REQ-021
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
      {others.length > 0 && <small>他の出典: {others.join('・')}</small>}
    </div>
  )
}
