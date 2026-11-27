/**
 * 道具の中の読み書きの受け持ち（UC-019・UC-028 の outbound。`handlers/UC-nnn.io.ts`）が共有する部品。
 * kit/ta.ts の作業場所と kit/py.ts の橋の上に、次の 2 つを足す。
 *
 * - ioEntry: 例の名前 → 前提の表から、操作 1 つの受け持ちを作る。実例ごとに作業場所（影の根の下の w/）を作り、
 *   前提をそろえ、作業場所を作業ディレクトリにして操作の関数を呼び、影の根を片付ける。表に無い例の名前は Unanswerable。
 *   契約のパスは相対なら作業ディレクトリが起点なので、`../learner_packs/…` のような出力先も影の根の中に収まる。
 * - copyFixtureDirs: request の文字列の欄が名指すリポジトリの作り物（`tests/fixtures/<種類>/<名前>/`）を、
 *   同じ相対パスのまま作業場所へ写す（リポジトリに無い作り物は写さない）。
 *
 * 応答は関数が返した物をそのまま返し（kit/py.ts の pyAnswer）、失敗は投げられた値の code をそのまま名前として返す。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { callOperation, pyAnswer } from './py'
import { Unanswerable, type ExampleLine, type Operation } from './protocol'
import { makePlace, type Place } from './ta'
import { REPO_ROOT } from './tool'

/** 例の名前 → 前提。前提が要らない例も空の関数で並べる（表に無い名前は前提を決められない例）。 */
export type Preconditions = Record<string, (place: Place, line: ExampleLine) => Promise<void>>

/**
 * request の文字列の欄が名指すリポジトリの作り物を、同じ相対パスのまま作業場所へ写す。
 * @implements REQ-570
 */
export async function copyFixtureDirs(place: Place, line: ExampleLine, kind: string): Promise<void> {
  const pattern = new RegExp(`^(tests/fixtures/${kind}/[a-z0-9-]+)(?:/|$)`)
  const seen = new Set<string>()
  for (const value of Object.values(line.request ?? {})) {
    if (typeof value !== 'string') continue
    const m = pattern.exec(value)
    if (!m || seen.has(m[1]) || !existsSync(join(REPO_ROOT, m[1]))) continue
    seen.add(m[1])
    await place.copyFromRepo(m[1])
  }
}

/**
 * 操作 1 つの受け持ちを作る（作業場所を作り、前提をそろえ、関数を呼び、片付ける）。
 * @implements REQ-567, REQ-570, REQ-579
 */
export function ioEntry(table: Preconditions, common: (place: Place, line: ExampleLine) => Promise<void> = async () => {}): Operation {
  return async (line) => {
    const prepare = table[line.case]
    if (!prepare) throw new Unanswerable(`${line.uc} ${line.operation}.${line.case}: 前提を決められない例の名前`)
    const place = await makePlace()
    try {
      await common(place, line)
      await prepare(place, line)
      return pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: place.dir }))
    } finally {
      await place.shadow.cleanup()
    }
  }
}

/** JSON として読めないファイルの中身（読めない前提に置く）。 */
export const BROKEN_JSON = '{ "broken": \n'
