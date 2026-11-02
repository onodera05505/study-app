import { STATUS_LABEL } from '../lib/api'

/** 理解度のバッジ。文字＋色＋塗りで主張する。
 *  色だけに頼ると理解度が読み取れないので、文字を必ず持つ。 */
// @implements REQ-041, BR-029
export function StatusBadge({ status }: { status: number | null | undefined }) {
  const s = status ?? 1
  return (
    <span className={`status-badge st-${s}`} aria-label={`理解度: ${STATUS_LABEL[s]}`}>
      {STATUS_LABEL[s]}
    </span>
  )
}

/** 行の左端に色を付けるためのクラス名。 */
// @implements REQ-041, BR-029
export function statusRowClass(status: number | null | undefined, extra = ''): string {
  return `row st-${status ?? 1}${extra ? ' ' + extra : ''}`
}
