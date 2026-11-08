import type { ZodError } from 'zod'

/** 本文の検査に落ちたときの、利用者に返す断りの理由。
 *  zod の既定の文言は英語なので出さず、満たされていない項目を経路ごとの日本語の名前で指す。
 *  項目に当たらない崩れ（JSON として読めない・本文がオブジェクトでない）は本文そのものを指す。 */
// @implements REQ-257
export function bodyErrorMessage(error: ZodError, raw: unknown, labels: Record<string, string>): string {
  const issue = error.issues[0]
  const key = issue?.path?.[0]
  const label = typeof key === 'string' ? labels[key] : undefined
  if (!label) return '本文の形が正しくありません'
  const given = raw !== null && typeof raw === 'object' && (raw as Record<string, unknown>)[key as string] !== undefined
  if (!given) return `${label}がありません`
  return `${label}の値が正しくありません`
}
