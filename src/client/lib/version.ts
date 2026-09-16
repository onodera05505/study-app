/** 新しい版の検知（要件 §5.6、2026-09-16）。
 *
 *  画面は最初に開いたときの束を持ち続けるので、デプロイしても届かない。ビルドのたびに `version.json`
 *  （scripts/deploy-pages.sh が書く）を出し、画面を移るときと 5 分おきに見比べる。違っていたら App が帯を出す。
 *  自動では読み直さない（テスト中の入力を失わせない。本人の決定）。 */

let initial: string | null = null

async function fetchBuild(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { build?: string }
    return typeof data.build === 'string' ? data.build : null
  } catch {
    return null
  }
}

/** 最初の版を覚える。以後 `checkForUpdate` が違いを見る。 */
export async function rememberBuild(): Promise<void> {
  if (initial === null) initial = await fetchBuild()
}

/** 新しい版が出ていれば true。取れないときは false（帯を誤って出さない）。 */
export async function checkForUpdate(): Promise<boolean> {
  const now = await fetchBuild()
  if (initial === null) {
    initial = now
    return false
  }
  return now !== null && now !== initial
}

export const CHECK_INTERVAL_MS = 5 * 60 * 1000
