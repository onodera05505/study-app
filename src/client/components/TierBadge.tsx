/** 印の札。登録簿の印の語をそのまま出し、先頭の星だけを目立たせる。
 *  段ごとの色は styles.css の .rm-tier.t-<段> が持つ。語は消さない（色だけに頼らない）。 */
// @implements REQ-282, REQ-284
export function TierText({ label }: { label: string }) {
  const m = label.match(/^(★+)(\s*)(.*)$/)
  if (!m) return <>{label}</>
  return (
    <>
      <span className="rm-tier-star">{m[1]}</span>
      {m[2]}
      {m[3]}
    </>
  )
}

// @implements REQ-284
export function TierBadge({ level, label }: { level: number | null | undefined; label: string }) {
  return (
    <span className={`rm-tier t-${level ?? 0}`}>
      <TierText label={label} />
    </span>
  )
}

/** ロードマップの単位の行に付ける印。見た目は星だけにし、登録簿の印の語は
 *  読み上げの名前とツールチップに持たせる。星を持たない語はそのまま見せる。 */
// @implements REQ-282
export function TierMark({ level, label }: { level: number | null | undefined; label: string }) {
  const stars = label.match(/^★+/)?.[0]
  if (!stars)
    return (
      <span className={`rm-tier t-${level ?? 0}`} title={label}>
        {label}
      </span>
    )
  return (
    <span className={`rm-tier-mark t-${level ?? 0}`} title={label}>
      <span aria-hidden="true">{stars}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** 印の絞り込みの札の中身。見た目は星だけにし、登録簿の印の語は読み上げの名前に持たせる
 *  （ツールチップは札の title が持つ）。星を持たない語はそのまま見せる。 */
// @implements REQ-282
export function TierStars({ label }: { label: string }) {
  const stars = label.match(/^★+/)?.[0]
  if (!stars) return <>{label}</>
  return (
    <>
      <span className="rm-tier-star" aria-hidden="true">
        {stars}
      </span>
      <span className="sr-only">{label}</span>
    </>
  )
}
