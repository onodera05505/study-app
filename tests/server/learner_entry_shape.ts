/** 学習者役で測る道具の入口（UC-019・UC-028 の契約の `transport: local-store`・`direction: inbound` の操作）の
 *  標準出力を、契約の response と ToolError の形に照らすための読み方。
 *
 *  契約（contract.yaml）と共有の語彙（docs/_shared/components.yaml）は YAML なので、python の yaml で読んで JSON にする。
 *  形の照らし方は JSON Schema のうち契約が使う語（$ref・type・const・enum・pattern・minLength・minItems・minimum・maximum・
 *  required・properties・additionalProperties・items）だけを見る。properties に無い欄は、additionalProperties に形があるときだけ見る
 *  （契約は response に欄が足されることを禁じていない）。 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Json = any

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SHARED = path.join(ROOT, 'docs/_shared/components.yaml')

/** YAML を 1.2 の読み方（真偽は true・false だけ）で読み、日付は文字列のまま JSON にする。
 *  python の yaml の既定は 1.1 の読み方で、欄の名前 no を false に読んでしまう。 */
const LOAD_YAML = [
  'import json, re, sys, yaml',
  'class L(yaml.SafeLoader): pass',
  'L.yaml_implicit_resolvers = {k: [(t, r) for t, r in v if t != "tag:yaml.org,2002:bool"] for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()}',
  'L.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF"))',
  'print(json.dumps([yaml.load(open(p, encoding="utf-8"), Loader=L) for p in sys.argv[1:]], default=str))',
].join('\n')

export type Contract = { file: string; schemas: Record<string, Json>; operations: Record<string, Json>; shared: Record<string, Json> }

/** リポジトリからの相対パスで契約を読む。 */
export function loadContract(rel: string): Contract {
  const file = path.join(ROOT, rel)
  const r = spawnSync(
    'python3',
    ['-c', LOAD_YAML, file, SHARED],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  if (r.status !== 0) throw new Error(`契約を読めない: ${rel}\n${r.stderr}`)
  const [contract, shared] = JSON.parse(r.stdout)
  return { file: rel, schemas: contract.schemas ?? {}, operations: contract.operations ?? {}, shared: shared.schemas ?? {} }
}

function resolveRef(ref: string, c: Contract): Json {
  const local = /^#\/schemas\/(.+)$/.exec(ref)
  if (local) return c.schemas[local[1]]
  const shared = /_shared\/components\.yaml#\/schemas\/(.+)$/.exec(ref)
  if (shared) return c.shared[shared[1]]
  throw new Error(`読めない $ref: ${ref}`)
}

/** 値が契約の形に合わない所を挙げる（合えば空）。 */
export function shapeErrors(v: Json, s: Json, c: Contract, at = '$'): string[] {
  if (s === undefined) return [`${at}: 形が無い`]
  if (s.$ref) {
    const target = resolveRef(s.$ref, c)
    if (target === undefined) return [`${at}: $ref ${s.$ref} の先が無い`]
    return shapeErrors(v, target, c, at)
  }
  const out: string[] = []
  const types: string[] = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]
  const is = (t: string) =>
    t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' : t === 'array' ? Array.isArray(v)
      : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'null' ? v === null : typeof v === t
  if (types.length > 0 && !types.some(is)) return [`${at}: 型が ${types.join('|')} でない（${JSON.stringify(v)}）`]
  if ('const' in s && v !== s.const) out.push(`${at}: ${JSON.stringify(v)} が ${JSON.stringify(s.const)} でない`)
  if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${JSON.stringify(v)} が ${JSON.stringify(s.enum)} の外`)
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && v.length < s.minLength) out.push(`${at}: 長さが ${s.minLength} より短い`)
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) out.push(`${at}: ${JSON.stringify(v)} が ${s.pattern} に合わない`)
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${at}: ${v} が ${s.minimum} より小さい`)
    if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${at}: ${v} が ${s.maximum} より大きい`)
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) out.push(`${at}: 要素が ${s.minItems} より少ない`)
    if (s.items) v.forEach((x, i) => out.push(...shapeErrors(x, s.items, c, `${at}[${i}]`)))
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of s.required ?? []) if (!(k in v)) out.push(`${at}: 欄 ${k} が無い`)
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) out.push(...shapeErrors(x, s.properties[k], c, `${at}.${k}`))
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...shapeErrors(x, s.additionalProperties, c, `${at}.${k}`))
    }
  }
  return out
}

/** 標準出力の全体が JSON 1 つとして読めればその値を、読めなければ undefined を返す（前後の空白だけを許す）。 */
export function singleJson(stdout: string): { ok: boolean; value: Json } {
  try {
    return { ok: true, value: JSON.parse(stdout.trim()) }
  } catch {
    return { ok: false, value: undefined }
  }
}
