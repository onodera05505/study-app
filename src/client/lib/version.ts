/** 新しい版の検知。
 *
 *  画面は最初に開いたときの束を持ち続けるので、デプロイしても届かない。ビルドのたびに `version.json`
 *  （scripts/deploy-pages.sh が書く）を出し、画面を移るときと 5 分おきに見比べる。違っていたら App が帯を出す。
 *  自動では読み直さない（テスト中の入力を失わせない）。
 *
 *  比べるのは build と at の組。同じコミットを出し直しても at が変わるので帯が出る。
 *  組は区切りでつながず JSON の配列にして持つので、つなぐと同じ文字列になる違う組も違う印になる。
 *  最初の印は 1 回だけ取り、取れなかったときは次に取れた値を最初の印とする（初回の取得が競っても
 *  片方の失敗で最初の印が消えないようにするため）。 */

type Stamp = string | null

let initialP: Promise<Stamp> | null = null
// 最初の印の現在値。checkForUpdate が重なっても、取得のあとに同期で読み直して覚え直しを 1 回に保つ
let initialStamp: Stamp = null

// @implements REQ-231, REQ-232, BR-041
async function fetchStamp(): Promise<Stamp> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { build?: unknown; at?: unknown } | null
    // build が空でない文字列でない印は、読めない形として印が無いものに畳む
    if (!data || typeof data.build !== 'string' || data.build.length === 0) return null
    // at は省略できるが、有るなら空でない文字列でなければ読めない形として印が無いものに畳む
    if (data.at === undefined) return JSON.stringify([data.build, null])
    if (typeof data.at !== 'string' || data.at.length === 0) return null
    return JSON.stringify([data.build, data.at])
  } catch {
    return null
  }
}

/** 最初の印を覚える（何度呼んでも取りに行くのは 1 回）。 */
// @implements REQ-227
export function rememberBuild(): Promise<Stamp> {
  if (!initialP) {
    initialP = fetchStamp().then((s) => {
      if (initialStamp === null) initialStamp = s
      return initialStamp
    })
  }
  return initialP
}

/** 新しい版が出ていれば true。取れないときは false（帯を誤って出さない）。 */
// @implements REQ-231, REQ-233, REQ-235
export async function checkForUpdate(): Promise<boolean> {
  await rememberBuild()
  const now = await fetchStamp()
  if (now === null) return false
  // 取得を待つ間に別の呼び出しが覚え直していることがあるので、最初の印は取得のあとに読む
  if (initialStamp === null) {
    // 最初が取れていなければ、取れた値を最初の印にする（帯は出さない）
    initialStamp = now
    initialP = Promise.resolve(now)
    return false
  }
  return now !== initialStamp
}

export const CHECK_INTERVAL_MS = 5 * 60 * 1000
