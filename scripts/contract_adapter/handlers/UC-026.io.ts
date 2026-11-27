/**
 * UC-026 の読み書きの受け持ち（道具の中の読み書き。入口は kit/py.ts の橋で呼ぶ Python の関数。ADR-0013）。
 * 関数は実例ごとの影の根を作業ディレクトリにして呼ぶ。
 * - ok: 書き出す先（相対のパス）の置き場のディレクトリを影の根に置く。書いたファイルは影の根と一緒に消える
 * - exists: 書き出す先（request の path）にファイルを先に置く（契約の errors の CONFLICT「書き出す先のファイルが既にある」）
 * - unwritable: 前提を置かない（書き出す先 `/unwritable/…` はファイルシステムの根の下の、無く作れない置き場）
 */

import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { defineHandler, Unanswerable, type ExampleLine, type Operation } from '../kit/protocol'
import { callOperation, pyAnswer } from '../kit/py'
import { field, inShadow } from '../kit/tb'

const writeOperation: Operation = async (line: ExampleLine) => {
  const path = field(line.request, 'path')
  if (path === undefined) throw new Unanswerable(`${line.uc} ${line.operation}.${line.case} の request に path が無い`)
  if (line.case !== 'ok' && line.case !== 'exists' && line.case !== 'unwritable') throw new Unanswerable(`${line.uc} ${line.operation} の例 ${line.case} の前提を知らない`)
  return inShadow(async (shadow) => {
    if (line.case === 'ok' || line.case === 'exists') await mkdir(shadow.path(dirname(path)), { recursive: true })
    if (line.case === 'exists') await writeFile(shadow.path(path), '{}\n')
    return pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root }))
  })
}

/**
 * @implements REQ-567, REQ-570, REQ-579
 */
export default defineHandler({
  uc: 'UC-026',
  parallel: true,
  operations: {
    writeUnitInput: writeOperation,
    writeRewriteBundle: writeOperation,
  },
})
