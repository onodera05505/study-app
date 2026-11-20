/** UC-042（書き手と担当に渡す束・図を付ける論点・教材の手入れ・学びの追加の道具）のテストの土台。
 *
 *  入口は `CLAUDE.md` の「操作 → 入口」の「道具を回す操作」の行: 操作名を snake_case にした `scripts/<名前>.py` を子プロセスで回す。
 *  request の各欄は同じ名前の引数（newTarget の key は第 1 引数。大文字の前に - を入れた小文字）。
 *
 *  囲いは UC-039 の土台（UC-039_fixture.ts の shadow39・runTool）をそのまま使う: 影の根（scripts・src・portal と最上位のファイルは写し、
 *  手元の秘密のファイルは置かない）と、外への接続と作業ツリー・本体への書き込みを断つ OS の囲い。
 *  学びの置き場（data）は影の根の中では元へのリンクなので、道具が書き換える学びは ownLearning で影の根の中の写しに替える
 *  （リンクのまま書けば OS の囲いが断つ）。配備先の一覧と手元の秘密の値は出力に出さない（redact）。 */

import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY, LEARNINGS, ROOT, redact, removeShadows, runTool, shadow39, type Run, type Shadow39 } from './UC-039_fixture'

export { LEARNINGS, REGISTRY, ROOT, redact, removeShadows, type Run, type Shadow39 }

/** 影の根を作る（名前は置き場の目印）。 */
export const shadow42 = (name: string): Shadow39 => shadow39(`uc042-${name}`)

/** 学びの置き場 data/<key> を、元へのリンクから影の根の中の写しに替える（道具が書き換えてよい物にする）。 */
export function ownLearning(s: Shadow39, key: string): void {
  const at = s.path(`data/${key}`)
  if (existsSync(at) && lstatSync(at).isSymbolicLink()) unlinkSync(at)
  cpSync(join(ROOT, 'data', key), at, { recursive: true, filter: (src) => !/\/(pdfs|pages)(\/|$)/.test(src) })
}

/** 道具を回す（影の根を作業の場所にして、OS の囲いの中）。 */
export const run42 = (s: Shadow39, script: string, args: string[] = []): Promise<Run> => runTool(s, script, args)

/** 置き場の下の JSON ファイル（名前の順）。 */
export function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => join(dir, n))
}
export const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

/** 置き場の下の全ファイルの中身（相対パス → 中身）。書き換えていないことを見るのに使う。 */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const r = rel ? `${rel}/${n}` : n
      if (statSync(p).isDirectory()) walk(p, r)
      else out[r] = readFileSync(p, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

/** 失敗の文に載せる出力（配備先の一覧の値を伏せた物）。 */
export const outOf = (r: Run) => `終了 ${r.code}\n${redact(r.out)}`
export const writeText = writeFileSync
