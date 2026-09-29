import { STATUS_LABEL } from '../lib/api'

/** 理解度のバッジ。文字＋色＋塗りで主張する（利用者の指摘「理解度が分かりづらい。色がいい」2026-09-16）。
 *  色だけに頼らず文字を必ず持つ（未理解の行が満タンに見えた過去の教訓。Topics の bars から置き換え）。 */
// @implements REQ-130
export function StatusBadge({ status }: { status: number | null | undefined }) {
  const s = status ?? 1
  return (
    <span className={`status-badge st-${s}`} aria-label={`理解度: ${STATUS_LABEL[s]}`}>
      {STATUS_LABEL[s]}
    </span>
  )
}

/** 行の左端に色を付けるためのクラス名。 */
// @implements REQ-131
export function statusRowClass(status: number | null | undefined, extra = ''): string {
  return `row st-${status ?? 1}${extra ? ' ' + extra : ''}`
}
