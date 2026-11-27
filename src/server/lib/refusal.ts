import type { Context, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import names from '../../shared/error-codes.json'

/** 断りの種類の名前。出所は src/shared/error-codes.json の 1 ファイルで、名前の文字列は呼ぶ側に書かずここから引く。 */
export type ErrorCode = keyof typeof names
export const ErrorCode = names as { readonly [K in ErrorCode]: K }

/** 名前を載せるヘッダ。JSON の本文を持たない断りだけに付ける（名前は 1 つの応答に 1 か所）。 */
const ERROR_CODE_HEADER = 'X-Error-Code'

/** 断りの載せ方。JSON の本文で断る・平文の本文で断る・別の画面へ戻す（302）の 3 通り。 */
export type Refusal =
  | { status: ContentfulStatusCode; error: string }
  | { status: ContentfulStatusCode; text: string }
  | { redirect: string }

/** 学び側とまなびばの断りの応答を組み立てる。JSON の本文は理由の文 error と名前 code の 2 つだけを持ち、
 *  JSON の本文を持たない断りは本文と戻り先を変えずにヘッダ X-Error-Code に名前を持つ。
 *  @implements REQ-573, BR-064
 */
export function refuse<E extends Env>(c: Context<E>, code: ErrorCode, how: Refusal): Response {
  const name = ErrorCode[code]
  if ('error' in how) return c.json({ error: how.error, code: name }, how.status)
  if ('text' in how) return c.text(how.text, how.status, { [ERROR_CODE_HEADER]: name })
  c.header(ERROR_CODE_HEADER, name)
  return c.redirect(how.redirect)
}
