import { STATUS_LABEL, STATUS_SOURCE_LABEL, type FrequencyTier, type StatusSource } from '../lib/api'

/** 段階ごとの記号。形だけで互いに見分けられる字にする（色によらない）。 */
const STATUS_MARK: Record<number, string> = { 0: '・', 1: '－', 2: '△', 3: '◎' }

/** 理解度のバッジ。段階ごとの記号＋段階の名前＋色＋塗りで主張する。
 *  色だけに頼ると理解度が読み取れないので、段階の名前と記号を必ず持つ。
 *  読み上げは aria-label の名前で足りるので、記号は読み上げから外す。
 *  段階が null（記録の無いロードマップ型の論点）は未理解として示す。資格対策の未は 0 で届く。 */
// @implements REQ-041, REQ-420, REQ-481, BR-029, BR-045
export function StatusBadge({ status }: { status: number | null | undefined }) {
  const s = status ?? 1
  return (
    <span className={`status-badge st-${s}`} aria-label={`理解度: ${STATUS_LABEL[s]}`}>
      <span className="status-mark" aria-hidden="true">{STATUS_MARK[s]}</span> {STATUS_LABEL[s]}
    </span>
  )
}

/** 行の左端に色を付けるためのクラス名。 */
// @implements REQ-041, BR-029
export function statusRowClass(status: number | null | undefined, extra = ''): string {
  return `row st-${status ?? 1}${extra ? ' ' + extra : ''}`
}

/** 論点の画面に示す理解度。段階のバッジに、回答の履歴からの判定か本人の上書きかを添える。 */
// @implements REQ-483, BR-050
export function TopicUnderstanding({ status, source }: { status: number; source: StatusSource }) {
  return (
    <p className="topic-understanding">
      <span className="lab">理解度</span>
      <StatusBadge status={status} />
      <span className="topic-understanding-source">{STATUS_SOURCE_LABEL[source]}</span>
    </p>
  )
}

/** 出題回数の印。段の数だけ ★ を並べる。印を持たない論点（段が null）には何も出さない。 */
// @implements REQ-478, BR-051
export function FrequencyMark({ tier }: { tier: FrequencyTier | null | undefined }) {
  if (!tier) return null
  return (
    <span className={`freq-mark f-${tier}`} title="出題回数の印">
      {'★'.repeat(tier)}
    </span>
  )
}

/** 理解度の操作。各選択肢は選ぶと記録される段階の名前を持ち、今の段階は
 *  aria-pressed と、色によらないチェックの印（styles.css の .status-choice）で示す。
 *  今の段階が未（0）のときは、どの選択肢も選ばれていない。 */
// @implements REQ-421, BR-045
export function StatusChoice({ status, onChoose }: { status: number; onChoose: (next: number) => void }) {
  return (
    <span className="seg status-choice" role="group" aria-label="理解度">
      {[1, 2, 3].map((s) => (
        <button key={s} type="button" aria-pressed={status === s} onClick={() => onChoose(s)}>
          {STATUS_LABEL[s]}
        </button>
      ))}
    </span>
  )
}
