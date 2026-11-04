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

export function TierBadge({ level, label }: { level: number | null | undefined; label: string }) {
  return (
    <span className={`rm-tier t-${level ?? 0}`}>
      <TierText label={label} />
    </span>
  )
}
