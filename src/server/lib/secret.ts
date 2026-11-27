import type { Bindings } from './db'

/** トークンの署名の秘密を取り出す。配備に無ければ null。
 *  署名の秘密が在るかどうかの判定はここ 1 か所で、呼び出し側は null のときに断る。
 *  既定値には倒さない（倒すと、秘密の無い配備が弱い鍵で発行と検証を続けてしまう）。 */
// @implements REQ-274, REQ-275
export function getSecret(env: Bindings): string | null {
  return env.JWT_SECRET ?? null
}
