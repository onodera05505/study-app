/** 学びの置き場の中の投入（`data/<学び>/seed.sql`）を、影の根の中で読み・写す土台。
 *  投入は組み立ての道具（buildSeed）が書き出す物で、リポジトリは追跡しない（git が無視する）ので、手元の物の土台（REQ-679）。
 *  契約の受け渡し役の UC-027・UC-032 の受け持ちが、影の根（root）で組み立てた投入を使うときに通す。 */

import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 影の根 root の中の、学び learning の投入のパス。 */
const seedOf = (root: string, learning: string) => join(root, 'data', learning, 'seed.sql')

/** 影の根の中の、学び learning の投入を読む。 */
export const readSeed = (root: string, learning: string): Promise<string> => readFile(seedOf(root, learning), 'utf8')

/** 影の根の中の、学び from の投入を学び to の置き場へ写す。 */
export const copySeed = (root: string, from: string, to: string): Promise<void> => copyFile(seedOf(root, from), seedOf(root, to))
