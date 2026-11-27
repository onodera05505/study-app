/**
 * `http` の操作の実例を、契約の wire と request から Request に組み、実装の app（Hono）に渡して答えに読む部品。
 *
 * 使い方: `answerOf(await app.request(...pieces(line, opts)), line)`。
 * - request の鍵のうち、経路の `{name}` に当たる物は経路へ、`authorization` は前提（トークンの有無）として外し、
 *   残りは GET・DELETE ではクエリ、それ以外では JSON の本文にする。
 * - 応答の読み方（ADR-0012）: ヘッダ `X-Error-Code` があればその名前の断り。状態が wire.success なら応答
 *   （302 は `{ location }`、ほかは JSON の本文）。それ以外は JSON の本文の `code` の断り。名前が読めない断りと、
 *   成功の状態で本文が JSON でない応答は、実装が返した物を、状態の番号を最上位に持たない入れ物
 *   `{ unnamedRefusal: { status } }`・`{ unreadableBody: { status, body } }` に入れて応答として返す
 *   （どの成功例の応答にも含まれないので、確かめがその実例を合わない物として挙げる）。
 */

import { Unanswerable, type Answer, type ExampleLine } from './protocol'

export type Pieces = { path: string; init: RequestInit }

export type PieceOptions = {
  /** 付けるヘッダ（トークン・Cookie など）。 */
  headers?: Record<string, string>
  /** request から外す鍵（前提として読んだ物）。`authorization` はいつも外す。 */
  omit?: string[]
  /** 本文を JSON にせず、この文字列をそのまま送る。 */
  rawBody?: string
}

/**
 * 実例の行から、経路と RequestInit を組む。
 * @implements REQ-567
 */
export function pieces(line: ExampleLine, options: PieceOptions = {}): Pieces {
  if (!line.wire) throw new Unanswerable(`${line.uc} ${line.operation}: 契約に wire が無い`)
  const rest: Record<string, unknown> = { ...(line.request ?? {}) }
  for (const key of ['authorization', ...(options.omit ?? [])]) delete rest[key]
  let path = line.wire.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = rest[name]
    delete rest[name]
    return encodeURIComponent(String(value))
  })
  const method = line.wire.method.toUpperCase()
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  const init: RequestInit = { method, headers }
  if (method === 'GET' || method === 'DELETE') {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(rest)) query.set(key, String(value))
    if ([...query.keys()].length > 0) path += `?${query}`
  } else {
    headers['Content-Type'] = 'application/json'
    init.body = options.rawBody ?? JSON.stringify(rest)
  }
  return { path, init }
}

/**
 * 実例が本人を持たない前提か（request の authorization が空、または例の名前が本人の無いことを名指す）。
 * 名前の見分けは契約の errors の when（トークン・セッションが無い）に当たる例の名前の頭で行う。
 * @implements REQ-570
 */
export function withoutIdentity(line: ExampleLine): boolean {
  if (line.request && 'authorization' in line.request) return line.request.authorization === ''
  return /^(unauthenticated|noToken|noSession)/.test(line.case)
}

/**
 * 実装の応答を、応答か断りの名前に読む。
 * @implements REQ-567, REQ-568, BR-064
 */
export async function answerOf(res: Response, line: ExampleLine): Promise<Answer> {
  const header = res.headers.get('X-Error-Code')
  if (header) return { error: header }
  const text = await res.text()
  if (line.wire && res.status === line.wire.success) {
    if (res.status >= 300 && res.status < 400) return { response: { location: res.headers.get('Location') } }
    try {
      return { response: JSON.parse(text) as Record<string, unknown> }
    } catch {
      process.stderr.write(`  成功の状態 ${res.status} の本文が JSON でない: ${text.slice(0, 120)}\n`)
      return { response: { unreadableBody: { status: res.status, body: text.slice(0, 200) } } }
    }
  }
  let code: unknown
  try {
    code = (JSON.parse(text) as { code?: unknown }).code
  } catch {
    code = undefined
  }
  if (typeof code === 'string' && code.length > 0) return { error: code }
  process.stderr.write(`  名前を出さずに断った（状態 ${res.status}）: ${text.slice(0, 120)}\n`)
  return { response: { unnamedRefusal: { status: res.status } } }
}
