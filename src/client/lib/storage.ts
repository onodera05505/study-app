import names from '../../shared/error-codes.json'

/** 端末の記憶が使えないときに、記憶の操作が呼んだ側に渡す失敗。断りの種類の名前を code に持つ。 */
export type StorageUnavailable = Error & { readonly code: string }

/** 端末の記憶（localStorage・sessionStorage）に触れる。書けない・読めないときは失敗を握らず、
 *  名前 STORAGE_UNAVAILABLE を持つ失敗にして呼んだ側に渡す。名前は出所のファイルから引く。
 *  @implements REQ-572, BR-064
 */
export function touchStorage<T>(access: () => T): T {
  try {
    return access()
  } catch (cause) {
    const failure = new Error('端末の記憶が使えません', { cause }) as Error & { code: string }
    failure.code = names.STORAGE_UNAVAILABLE
    throw failure as StorageUnavailable
  }
}

/** 画面の側で、端末の記憶の操作が渡した名前つきの失敗を受け止め、その記憶に頼る機能を出さないだけにする。
 *  受け止めるのは STORAGE_UNAVAILABLE の失敗だけで、ほかの失敗はそのまま上へ渡す。
 *  @implements BR-011
 */
export function withoutStorage<T>(operate: () => T, fallback: T): T {
  try {
    return operate()
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === names.STORAGE_UNAVAILABLE) return fallback
    throw e
  }
}
