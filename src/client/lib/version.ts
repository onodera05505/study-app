/** 新しい版の検知（要件 §5.6、2026-09-16）。
 *
 *  画面は最初に開いたときの束を持ち続けるので、デプロイしても届かない。ビルドのたびに `version.json`
 *  （scripts/deploy-pages.sh が書く）を出し、画面を移るときと 5 分おきに見比べる。違っていたら App が帯を出す。
 *  自動では読み直さない（テスト中の入力を失わせない。本人の決定）。
 *
 *  比べるのは build と at を合わせた印。同じコミットを出し直しても at が変わるので帯が出る（受入の所見）。
 *  最初の印は 1 回だけ取り、取れなかったときは次に取れた値を最初の印とする（受入の所見: 初回の 2 本が競って
 *  片方の失敗で最初の印が消え、帯が二度と出ない経路があった）。 */

type Stamp = string | null

let initialP: Promise<Stamp> | null = null

async function fetchStamp(): Promise<Stamp> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { build?: string; at?: string }
    return typeof data.build === 'string' ? `${data.build}@${data.at ?? ''}` : null
  } catch {
    return null
  }
}

/** 最初の印を覚える（何度呼んでも取りに行くのは 1 回）。 */
// @implements REQ-279
export function rememberBuild(): Promise<Stamp> {
  if (!initialP) initialP = fetchStamp()
  return initialP
}

/** 新しい版が出ていれば true。取れないときは false（帯を誤って出さない）。 */
// @implements REQ-032, REQ-283, REQ-284
export async function checkForUpdate(): Promise<boolean> {
  const initial = await rememberBuild()
  const now = await fetchStamp()
  if (initial === null) {
    // 最初が取れていなければ、取れた値を最初の印にする（帯は出さない）
    if (now !== null) initialP = Promise.resolve(now)
    return false
  }
  return now !== null && now !== initial
}

export const CHECK_INTERVAL_MS = 5 * 60 * 1000
