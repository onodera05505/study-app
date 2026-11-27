/**
 * プロセスの外へ出る口と、実例ごとに揃える時計・ID。
 *
 * - sealOutside: 土台が最初に 1 度呼ぶ。`fetch` を塞ぎ、塞いだ口に来た要求を記録する（REQ-569）。
 * - withFetch: 外の相手が要る実例だけ、偽の相手を立てて回す（終われば塞いだ口に戻す）。
 * - withClock / withUuids: 実例の前提が時刻や作られる ID を決めているとき、その値に揃えて回す。
 * どれもプロセスに 1 つの物を差し替えるので、使う受け持ちは順に回す（parallel にしない）。
 */

type FetchFn = typeof globalThis.fetch

const attempts: string[] = []
let current: FetchFn | null = null

/**
 * 外へ出る口（fetch）を塞ぐ。偽の相手が立っていないときの要求は届かず、記録だけが残る。
 * @implements REQ-569
 */
export function sealOutside(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (current) return current(input, init)
    const url = input instanceof Request ? input.url : String(input)
    attempts.push(url)
    throw new TypeError(`契約の実例の確かめでは外へ出ない（塞いだ口への要求: ${url}）`)
  }) as FetchFn
}

/**
 * 塞いだ口に来た要求（外へ出ようとした先）の一覧。
 * @implements REQ-569
 */
export function blockedAttempts(): string[] {
  return [...attempts]
}

/**
 * 偽の相手を立てて body を回す。偽の相手は要求を受けて Response を返す（投げれば「届かない」）。
 * @implements REQ-569
 */
export async function withFetch<T>(fake: FetchFn, body: () => Promise<T>): Promise<T> {
  current = fake
  try {
    return await body()
  } finally {
    current = null
  }
}

/**
 * 時計を ms（epoch ミリ秒）に止めて body を回す。`Date.now()` と引数の無い `new Date()` がこの時刻を返す。
 * @implements REQ-570
 */
export async function withClock<T>(ms: number, body: () => Promise<T>): Promise<T> {
  const RealDate = Date
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(ms)
      else super(...(args as [number]))
    }
    static now() {
      return ms
    }
  }
  globalThis.Date = FixedDate as DateConstructor
  try {
    return await body()
  } finally {
    globalThis.Date = RealDate
  }
}

/**
 * 実装が作る ID（crypto.randomUUID）を、渡した順に返すようにして body を回す。使い切ったあとは本物に戻る。
 * @implements REQ-570
 */
export async function withUuids<T>(ids: string[], body: () => Promise<T>): Promise<T> {
  const real = crypto.randomUUID.bind(crypto)
  const queue = [...ids]
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => (queue.length > 0 ? queue.shift()! : real()),
  })
  try {
    return await body()
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value: real })
  }
}
